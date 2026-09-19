//! Commit-path tests: `atomic_publish` create-once is a true no-clobber
//! `link(2)` commit, and `atomic_publish_guarded` exposes the pre-commit
//! guard seam a digest compare-and-swap builds on.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

use local_custody::{
    atomic_publish, atomic_publish_guarded, ensure_private_directory, CustodyError,
};
use tempfile::TempDir;

fn canonical_temp() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    (dir, base)
}

fn private_dir() -> (TempDir, PathBuf) {
    let (temp, base) = canonical_temp();
    let private = base.join("private");
    ensure_private_directory(&private).unwrap();
    (temp, private)
}

fn dir_entries(private: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(private)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn create_once_publishes_then_preserves() {
    let (_temp, private) = private_dir();
    let first = atomic_publish(&private, "once.bin", b"alpha", true).unwrap();
    assert!(first.created);
    assert_eq!(first.path, private.join("once.bin"));

    let second = atomic_publish(&private, "once.bin", b"beta", true).unwrap();
    assert!(!second.created, "existing target must report created:false");
    assert_eq!(fs::read(&second.path).unwrap(), b"alpha", "existing content preserved");
    assert_eq!(fs::symlink_metadata(&second.path).unwrap().nlink(), 1);
    // The staging file is always removed — no litter on either path.
    assert_eq!(dir_entries(&private), vec!["once.bin".to_string()]);
}

#[test]
fn create_once_rejects_a_permissive_existing_target() {
    let (_temp, private) = private_dir();
    let target = private.join("once.txt");
    fs::write(&target, b"planted").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
    let err = atomic_publish(&private, "once.txt", b"new", true).unwrap_err();
    assert_eq!(err.code, "mode-mismatch");
    // A planted permissive file is reported, never silently accepted or replaced.
    assert_eq!(fs::read(&target).unwrap(), b"planted");
}

#[test]
fn create_once_concurrent_publishers_pick_exactly_one_winner() {
    // Repeated rounds shake out timing luck: two racing publishers must
    // produce exactly one `created:true`, one `created:false`, and a target
    // holding one complete staged payload — the `link(2)` commit is atomic.
    for round in 0..8 {
        let (_temp, private) = private_dir();
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for (index, tag) in [b"alpha".as_slice(), b"beta".as_slice()].iter().enumerate() {
            let dir = private.clone();
            let barrier = barrier.clone();
            let content = tag.to_vec();
            handles.push(std::thread::spawn(move || {
                let _ = index;
                barrier.wait();
                atomic_publish(&dir, "once.bin", &content, true).unwrap()
            }));
        }
        let outcomes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        let created = outcomes.iter().filter(|o| o.created).count();
        assert_eq!(created, 1, "round {round}: exactly one winner");
        let preserved = outcomes.iter().filter(|o| !o.created).count();
        assert_eq!(preserved, 1, "round {round}: exactly one preserved");

        let bytes = fs::read(private.join("once.bin")).unwrap();
        assert!(
            bytes.as_slice() == b"alpha" || bytes.as_slice() == b"beta",
            "round {round}: torn content {bytes:?}",
        );
        assert_eq!(fs::symlink_metadata(private.join("once.bin")).unwrap().nlink(), 1);
        assert_eq!(
            dir_entries(&private),
            vec!["once.bin".to_string()],
            "round {round}: staging litter left behind",
        );
    }
}

#[test]
fn guarded_publish_guard_observes_staged_path_and_content() {
    let (_temp, private) = private_dir();
    let seen = std::sync::Mutex::new(Vec::<(PathBuf, Vec<u8>)>::new());
    let guard = |staged: &Path| -> Result<(), CustodyError> {
        // The guard receives the fully-written staging file before commit.
        seen.lock().unwrap().push((staged.to_path_buf(), fs::read(staged).unwrap()));
        Ok(())
    };
    let outcome = atomic_publish_guarded(&private, "g.bin", b"payload", &guard).unwrap();
    assert!(outcome.created);

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].1, b"payload", "guard sees the final staged content");
    assert!(seen[0].0.starts_with(&private), "staged file lives in the target dir");
    assert_ne!(seen[0].0, private.join("g.bin"), "guard gets the staging name");
    drop(seen);
    assert_eq!(fs::read(private.join("g.bin")).unwrap(), b"payload");
    assert_eq!(dir_entries(&private), vec!["g.bin".to_string()]);
}

#[test]
fn guarded_publish_failure_aborts_and_cleans_up() {
    let (_temp, private) = private_dir();
    let guard = |_staged: &Path| -> Result<(), CustodyError> {
        Err(CustodyError {
            code: "conflict".to_string(),
            message: "file revision changed".to_string(),
        })
    };
    let err = atomic_publish_guarded(&private, "g.bin", b"payload", &guard).unwrap_err();
    assert_eq!(err.code, "conflict", "the guard's failure is the publish's failure");
    assert!(!private.join("g.bin").exists(), "aborted publish leaves no target");
    assert!(dir_entries(&private).is_empty(), "aborted publish leaves no staging file");
}

#[test]
fn guarded_publish_supports_digest_compare_and_swap() {
    // The replace-CAS pattern: re-read the current target inside the guard
    // and commit only while it still matches the expected revision.
    let (_temp, private) = private_dir();
    atomic_publish(&private, "state", b"v1", false).unwrap();
    let target = private.join("state");

    let expected = b"v1".to_vec();
    let cas_target = target.clone();
    let accept = move |_staged: &Path| -> Result<(), CustodyError> {
        if fs::read(&cas_target).unwrap() == expected {
            Ok(())
        } else {
            Err(CustodyError {
                code: "conflict".to_string(),
                message: "file revision changed".to_string(),
            })
        }
    };
    let outcome = atomic_publish_guarded(&private, "state", b"v2", &accept).unwrap();
    assert!(outcome.created);
    assert_eq!(fs::read(&target).unwrap(), b"v2");

    // A stale expected revision fails the guard and preserves the target.
    let stale_target = target.clone();
    let reject = move |_staged: &Path| -> Result<(), CustodyError> {
        if fs::read(&stale_target).unwrap() == b"v1".to_vec() {
            Ok(())
        } else {
            Err(CustodyError {
                code: "conflict".to_string(),
                message: "file revision changed".to_string(),
            })
        }
    };
    let err = atomic_publish_guarded(&private, "state", b"v3", &reject).unwrap_err();
    assert_eq!(err.code, "conflict");
    assert_eq!(fs::read(&target).unwrap(), b"v2", "rejected CAS never touches the target");
}
