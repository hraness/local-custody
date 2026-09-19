//! Descriptor-custody tests: `assert_owned_fd` validates an already-open
//! descriptor through `fstat`, and `stable_read`'s `nonblocking` option keeps
//! blocking opens from stalling on special files.

use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::time::Duration;

use local_custody::{
    assert_owned_fd, ensure_private_directory, stable_read, ObjectKind, OwnedPathOptions,
    StableReadOptions,
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

fn write_private(private: &std::path::Path, name: &str, content: &[u8], mode: u32) -> PathBuf {
    let path = private.join(name);
    fs::write(&path, content).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
    path
}

#[test]
fn regular_file_descriptor_validates() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "wal-shm", b"journal", 0o600);
    let file = fs::File::open(&path).unwrap();
    let identity = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            exact_mode: Some(0o600),
            maximum_bytes: Some(64),
            links: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(identity.size, 7);
}

#[test]
fn directory_descriptor_is_kind_mismatch() {
    let (_temp, private) = private_dir();
    let sub = private.join("subdir");
    fs::create_dir(&sub).unwrap();
    fs::set_permissions(&sub, fs::Permissions::from_mode(0o700)).unwrap();
    let file = fs::File::open(&sub).unwrap();
    let err = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "kind-mismatch");
}

#[test]
fn permissive_descriptor_rejected_by_exact_mode_and_owner_only() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "open.txt", b"x", 0o644);
    let file = fs::File::open(&path).unwrap();
    let err = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            exact_mode: Some(0o600),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "mode-mismatch");

    let err = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            owner_only: true,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "owner-only");
}

#[test]
fn hard_linked_descriptor_rejected() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "linked", b"x", 0o600);
    fs::hard_link(&path, private.join("linked-alias")).unwrap();
    let file = fs::File::open(&path).unwrap();
    let err = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "links");
}

#[test]
fn descriptor_size_bounds_enforced() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "sized", &[0u8; 200], 0o600);
    let file = fs::File::open(&path).unwrap();
    let err = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            maximum_bytes: Some(64),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "capacity");
    let err = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            minimum_bytes: Some(1024),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "minimum");
}

#[test]
fn canonical_request_fails_closed_on_a_descriptor() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "c.txt", b"x", 0o600);
    let file = fs::File::open(&path).unwrap();
    let err = assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            canonical: true,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "unsupported");
}

#[test]
fn negative_descriptor_rejected() {
    let err = assert_owned_fd(-1, &OwnedPathOptions::default()).unwrap_err();
    assert_eq!(err.code, "invalid");
}

#[test]
fn closed_descriptor_rejected() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "gone", b"x", 0o600);
    let fd = fs::File::open(&path).unwrap().as_raw_fd();
    // The `File` is dropped — the descriptor is closed.
    let err = assert_owned_fd(fd, &OwnedPathOptions::default()).unwrap_err();
    assert_eq!(err.code, "dup");
}

#[test]
fn descriptor_is_never_closed_by_validation() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "live", b"token", 0o600);
    let mut file = fs::File::open(&path).unwrap();
    assert_owned_fd(
        file.as_raw_fd(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            exact_mode: Some(0o600),
            ..Default::default()
        },
    )
    .unwrap();
    // The caller's descriptor still reads the object after validation.
    use std::io::Read;
    let mut content = String::new();
    file.read_to_string(&mut content).unwrap();
    assert_eq!(content, "token");
}

#[test]
fn non_owned_descriptor_rejected_where_testable() {
    // Skipped under root: every uid matches. Otherwise /etc/hosts is a
    // root-owned regular file present on every unix CI image.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    for candidate in ["/etc/hosts", "/etc/passwd"] {
        if let Ok(file) = fs::File::open(candidate) {
            let err = assert_owned_fd(
                file.as_raw_fd(),
                &OwnedPathOptions {
                    kind: Some(ObjectKind::File),
                    ..Default::default()
                },
            )
            .unwrap_err();
            assert_eq!(err.code, "owner");
            return;
        }
    }
}

#[test]
fn nonblocking_stable_read_returns_regular_content() {
    let (_temp, private) = private_dir();
    let path = write_private(&private, "state.json", b"payload", 0o600);
    let result = stable_read(
        &path,
        &StableReadOptions {
            owner_only: true,
            maximum_bytes: 64,
            links: Some(1),
            nonblocking: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result.bytes, b"payload");
}

#[test]
fn nonblocking_stable_read_rejects_fifo_without_hanging() {
    let (_temp, private) = private_dir();
    let fifo = private.join("fifo");
    let c_path = CString::new(fifo.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = stable_read(
            &fifo,
            &StableReadOptions {
                owner_only: true,
                maximum_bytes: 64,
                links: Some(1),
                nonblocking: true,
                ..Default::default()
            },
        );
        let _ = tx.send(result);
    });
    // A blocking O_RDONLY open on a FIFO never returns; the deadline proves
    // O_NONBLOCK took effect. The FIFO then fails the regular-file check.
    let result = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("stable_read hung on a FIFO — O_NONBLOCK was not applied");
    let err = result.unwrap_err();
    assert_eq!(err.code, "not-file");
}
