#![cfg(unix)]

//! Contract tests against `spec/vectors.json`.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

use local_custody::{
    assert_owned_fd, atomic_publish, ensure_private_directory, read_protected_descriptor,
    stable_read, validate_publish_name, ObjectKind, OwnedPathOptions, StableReadOptions,
};
use serde::Deserialize;
use tempfile::TempDir;

#[derive(Debug, Deserialize)]
struct Vectors {
    #[serde(rename = "ownedPath")]
    owned_path: Vec<Case>,
    #[serde(rename = "ownedFd")]
    owned_fd: Vec<Case>,
    #[serde(rename = "privateDirectory")]
    private_directory: Vec<Case>,
    #[serde(rename = "stableRead")]
    stable_read: Vec<Case>,
    #[serde(rename = "publishName")]
    publish_name: Vec<NameCase>,
    #[serde(rename = "protectedInput")]
    protected_input: Vec<Case>,
    #[serde(rename = "platformSupport")]
    platform_support: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    arrange: Option<serde_json::Value>,
    expect: Option<serde_json::Value>,
    #[serde(default)]
    outcome: String,
}

#[derive(Debug, Deserialize)]
struct NameCase {
    name: String,
    outcome: String,
}

fn parse_mode(s: &str) -> u32 {
    u32::from_str_radix(s, 8).unwrap()
}

fn canonical_temp() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    (dir, base)
}

fn setup_owned_path(dir: &Path, arrange: &serde_json::Value) -> PathBuf {
    let obj = arrange.as_object().unwrap();
    let kind = obj["kind"].as_str().unwrap();
    let mode = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .map(parse_mode)
        .unwrap_or(0o600);
    let target_mode = obj
        .get("targetMode")
        .and_then(|v| v.as_str())
        .map(parse_mode)
        .unwrap_or(0o600);
    let links = obj.get("links").and_then(|v| v.as_u64()).unwrap_or(1);
    let bytes = obj.get("bytes").and_then(|v| v.as_u64());
    let content = obj.get("content").and_then(|v| v.as_str());

    let path = match kind {
        "file" => {
            let p = dir.join("target");
            let data = content
                .map(|s| s.as_bytes().to_vec())
                .unwrap_or_else(|| vec![b'x'; bytes.unwrap_or(5) as usize]);
            fs::write(&p, &data).unwrap();
            fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            for i in 1..links {
                fs::hard_link(&p, dir.join(format!("target-link-{i}"))).unwrap();
            }
            p
        }
        "symlink" => {
            let p = dir.join("link");
            let target = dir.join("target");
            fs::write(&target, b"target").unwrap();
            fs::set_permissions(&target, std::fs::Permissions::from_mode(target_mode)).unwrap();
            std::os::unix::fs::symlink(&target, &p).unwrap();
            p
        }
        "socket" => {
            let p = dir.join("sock");
            let _ = fs::remove_file(&p);
            let listener = std::os::unix::net::UnixListener::bind(&p).unwrap();
            drop(listener);
            fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            p
        }
        "directory" => {
            let p = dir.join("subdir");
            fs::create_dir(&p).unwrap();
            fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            p
        }
        _ => panic!("unknown arrange kind: {kind}"),
    };
    path
}

fn options_from_expect(expect: &serde_json::Value) -> OwnedPathOptions {
    let obj = expect.as_object().unwrap();
    let kind = obj.get("kind").and_then(|v| v.as_str()).map(|s| match s {
        "file" => ObjectKind::File,
        "directory" => ObjectKind::Directory,
        "socket" => ObjectKind::Socket,
        _ => panic!("unknown kind {s}"),
    });
    let exact_mode = obj
        .get("exactMode")
        .and_then(|v| v.as_str())
        .map(parse_mode);
    let owner_only = obj
        .get("ownerOnly")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let maximum_bytes = obj.get("maximumBytes").and_then(|v| v.as_u64());
    let minimum_bytes = obj.get("minimumBytes").and_then(|v| v.as_u64());
    let links = obj.get("links").and_then(|v| v.as_u64());
    OwnedPathOptions {
        kind,
        exact_mode,
        owner_only,
        maximum_bytes,
        minimum_bytes,
        links,
        canonical: true,
    }
}

#[test]
fn owned_path_vectors() {
    let data: Vectors = serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    for case in data.owned_path {
        let (_dir, base) = canonical_temp();
        let private = base.join("private");
        ensure_private_directory(&private).unwrap();
        let arrange = case.arrange.as_ref().unwrap();
        let path = setup_owned_path(&private, arrange);
        let opts = case.expect.as_ref().map(options_from_expect);
        let opts = opts.unwrap_or(OwnedPathOptions {
            kind: Some(ObjectKind::File),
            canonical: true,
            ..Default::default()
        });
        let result = local_custody::assert_owned_path(&path, &opts);
        if case.outcome == "accept" {
            assert!(result.is_ok(), "{} failed: {:?}", case.name, result.err());
        } else {
            assert!(result.is_err(), "{} unexpectedly accepted", case.name);
        }
    }
}

#[test]
fn owned_fd_vectors() {
    let data: Vectors = serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    for case in data.owned_fd {
        let (_dir, base) = canonical_temp();
        let private = base.join("private");
        ensure_private_directory(&private).unwrap();
        let arrange = case.arrange.as_ref().unwrap();
        let path = setup_owned_path(&private, arrange);
        // `canonical` is path-bound and unsupported on a descriptor — the fd
        // vectors always carry it unset.
        let opts = case.expect.as_ref().map(|e| OwnedPathOptions {
            canonical: false,
            ..options_from_expect(e)
        });
        let opts = opts.unwrap_or(OwnedPathOptions {
            kind: Some(ObjectKind::File),
            ..Default::default()
        });
        let file = fs::File::open(&path).unwrap();
        let result = assert_owned_fd(file.as_raw_fd(), &opts);
        if case.outcome == "accept" {
            assert!(result.is_ok(), "{} failed: {:?}", case.name, result.err());
        } else {
            assert!(result.is_err(), "{} unexpectedly accepted", case.name);
        }
    }
}

#[test]
fn private_directory_vectors() {
    let data: Vectors = serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    for case in data.private_directory {
        let (_dir, base) = canonical_temp();
        let child = base.join("private");
        let arrange = case.arrange.as_ref().unwrap();
        let is_symlink = arrange.get("kind").and_then(|v| v.as_str()) == Some("symlink");
        match arrange["exists"].as_bool() {
            Some(false) => {}
            _ if !is_symlink => {
                let mode = arrange["mode"].as_str().map(parse_mode).unwrap_or(0o700);
                fs::create_dir(&child).unwrap();
                fs::set_permissions(&child, std::fs::Permissions::from_mode(mode)).unwrap();
            }
            _ => {}
        }
        if is_symlink {
            let real = base.join("real-private");
            fs::create_dir(&real).unwrap();
            fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
            std::os::unix::fs::symlink(&real, &child).unwrap();
        }
        if arrange.get("parent").and_then(|v| v.as_str()) == Some("symlink") {
            let (_real_parent_dir, real_parent) = canonical_temp();
            fs::remove_dir_all(&base).unwrap();
            std::os::unix::fs::symlink(&real_parent, &base).unwrap();
        }
        let result = ensure_private_directory(&child);
        if case.outcome == "created mode 0700" {
            assert!(result.is_ok(), "{} failed: {:?}", case.name, result.err());
            let meta = fs::symlink_metadata(&child).unwrap();
            assert!(meta.is_dir());
            assert_eq!(meta.mode() & 0o777, 0o700);
        } else {
            assert!(result.is_err(), "{} unexpectedly succeeded", case.name);
        }
    }
}

#[test]
fn stable_read_vectors() {
    let data: Vectors = serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    for case in data.stable_read {
        if case
            .arrange
            .as_ref()
            .and_then(|v| v.get("mutate"))
            .is_some()
        {
            continue;
        }
        let (_dir, base) = canonical_temp();
        let private = base.join("private");
        ensure_private_directory(&private).unwrap();
        let arrange = case.arrange.as_ref().unwrap();
        let path = setup_owned_path(&private, arrange);
        let expect = case.expect.as_ref().unwrap().as_object().unwrap();
        let opts = StableReadOptions {
            exact_mode: expect
                .get("exactMode")
                .and_then(|v| v.as_str())
                .map(parse_mode),
            owner_only: true,
            maximum_bytes: expect["maximumBytes"].as_u64().unwrap(),
            minimum_bytes: expect.get("minimumBytes").and_then(|v| v.as_u64()),
            links: Some(1),
            nonblocking: expect
                .get("nonblock")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        };
        let result = stable_read(&path, &opts);
        if case.outcome == "returns content plus dev/ino identity" {
            let got = result.expect(&case.name);
            let expected = arrange["content"].as_str().unwrap().as_bytes();
            assert_eq!(got.bytes, expected, "{}", case.name);
        } else {
            assert!(
                result.is_err(),
                "{} unexpectedly succeeded: {:?}",
                case.name,
                result
            );
        }
    }
}

#[test]
fn publish_name_vectors() {
    let data: Vectors = serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    for case in data.publish_name {
        let result = validate_publish_name(&case.name);
        if case.outcome == "accept" {
            assert!(result.is_ok(), "{}: {:?}", case.name, result.err());
        } else {
            assert!(result.is_err(), "{} unexpectedly accepted", case.name);
        }
    }
}

#[test]
fn atomic_publish_creates_owner_only_file() {
    let (_dir, base) = canonical_temp();
    let private = base.join("private");
    ensure_private_directory(&private).unwrap();
    let published = atomic_publish(&private, "state.v2.json", b"payload", false).unwrap();
    assert!(published.created);
    assert_eq!(published.path, private.join("state.v2.json"));
    let result = stable_read(
        &published.path,
        &StableReadOptions {
            owner_only: true,
            maximum_bytes: 1024,
            links: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result.bytes, b"payload");
}

#[test]
fn protected_input_vectors() {
    let data: Vectors = serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    for case in data.protected_input {
        if let Some(arrange) = &case.arrange {
            let obj = arrange.as_object().unwrap();
            let kind = obj["kind"].as_str().unwrap();
            if kind == "tty" {
                // Requires a controlling terminal; skip in automated vectors.
                continue;
            }
            let (_dir, base) = canonical_temp();
            let path = setup_owned_path(&base, arrange);
            let bound = obj
                .get("bound")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            let file = fs::File::open(&path).unwrap();
            let result = read_protected_descriptor(file.as_raw_fd(), bound);
            let expect = case.expect.as_ref().unwrap();
            if let Some(content) = expect.get("content").and_then(|v| v.as_str()) {
                assert_eq!(result.unwrap(), content, "{}", case.name);
            } else if let Some(code) = expect.get("code").and_then(|v| v.as_str()) {
                assert_eq!(result.unwrap_err().code, code, "{}", case.name);
            } else {
                panic!("unexpected expect shape for {}", case.name);
            }
        } else {
            // Negative descriptor case.
            let expect = case.expect.as_ref().unwrap();
            let code = expect.get("code").and_then(|v| v.as_str()).unwrap();
            let result = read_protected_descriptor(-1, Some(64));
            assert_eq!(result.unwrap_err().code, code, "{}", case.name);
        }
    }
}

#[test]
fn platform_support_vectors_have_exact_failure_codes() {
    let data: Vectors = serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    assert_eq!(data.platform_support.len(), 8);
    let mut unsupported = 0;
    let mut path = 0;
    for case in data.platform_support {
        assert_eq!(
            case.arrange
                .as_ref()
                .and_then(|value| value.get("platform"))
                .and_then(|value| value.as_str()),
            Some("windows")
        );
        match case
            .expect
            .as_ref()
            .and_then(|value| value.get("code"))
            .and_then(|value| value.as_str())
        {
            Some("unsupported") => unsupported += 1,
            Some("path") => path += 1,
            code => panic!("unexpected platform code {code:?}"),
        }
    }
    assert_eq!((unsupported, path), (7, 1));
}
