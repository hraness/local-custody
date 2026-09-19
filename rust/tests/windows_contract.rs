#![cfg(windows)]

use std::fs;
use std::os::windows::fs::symlink_file;

use local_custody::{
    assert_owned_fd, assert_owned_path, atomic_publish, ensure_private_directory,
    read_protected_descriptor, request_control_socket, stable_read, ObjectKind, OwnedPathOptions,
    StableReadOptions,
};
use serde_json::json;
use tempfile::TempDir;

fn unsupported(error: local_custody::CustodyError) {
    assert_eq!(error.code, "unsupported");
}

#[test]
fn remaining_platform_specific_requests_fail_explicitly() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state");
    fs::write(&path, b"payload").unwrap();
    unsupported(
        assert_owned_path(
            &path,
            &OwnedPathOptions {
                kind: Some(ObjectKind::File),
                exact_mode: Some(0o640),
                ..Default::default()
            },
        )
        .unwrap_err(),
    );
    unsupported(
        assert_owned_path(
            &path,
            &OwnedPathOptions {
                kind: Some(ObjectKind::File),
                canonical: true,
                ..Default::default()
            },
        )
        .unwrap_err(),
    );
    let stream = assert_owned_path(
        r"C:\custody\state:stream",
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(stream.code, "path");
    unsupported(
        stable_read(
            &path,
            &StableReadOptions {
                maximum_bytes: 1024,
                nonblocking: true,
                ..Default::default()
            },
        )
        .unwrap_err(),
    );
    unsupported(atomic_publish(temporary.path(), "state", b"value", true).unwrap_err());
    unsupported(assert_owned_fd(0, &OwnedPathOptions::default()).unwrap_err());
    unsupported(read_protected_descriptor(0, Some(1024)).unwrap_err());
    unsupported(request_control_socket(r"C:\custody\control", &json!({}), 1024, 1000).unwrap_err());
}

#[test]
fn private_directories_use_an_exact_current_user_acl() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("private");
    let created = ensure_private_directory(&path).unwrap();
    let reopened = ensure_private_directory(&path).unwrap();
    assert_eq!(created.identity, reopened.identity);
    assert_owned_path(
        &path,
        &OwnedPathOptions {
            kind: Some(ObjectKind::Directory),
            exact_mode: Some(0o700),
            owner_only: true,
            ..Default::default()
        },
    )
    .unwrap();

    let inherited = path.join("inherited");
    fs::write(&inherited, b"payload").unwrap();
    assert_eq!(
        assert_owned_path(
            &inherited,
            &OwnedPathOptions {
                kind: Some(ObjectKind::File),
                owner_only: true,
                ..Default::default()
            },
        )
        .unwrap_err()
        .code,
        "owner-only"
    );
}

#[test]
fn handle_identity_links_and_stable_reads_are_enforced() {
    let temporary = TempDir::new().unwrap();
    let path = temporary.path().join("state");
    fs::write(&path, b"payload").unwrap();
    let identity = assert_owned_path(
        &path,
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            maximum_bytes: Some(7),
            minimum_bytes: Some(7),
            links: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(identity.size, 7);
    let read = stable_read(
        &path,
        &StableReadOptions {
            maximum_bytes: 7,
            minimum_bytes: Some(7),
            links: Some(1),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(read.bytes, b"payload");
    assert_eq!(read.identity, identity);

    let alias = temporary.path().join("alias");
    fs::hard_link(&path, &alias).unwrap();
    assert_eq!(
        assert_owned_path(
            &path,
            &OwnedPathOptions {
                kind: Some(ObjectKind::File),
                ..Default::default()
            },
        )
        .unwrap_err()
        .code,
        "links"
    );
    assert_owned_path(
        &path,
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            links: Some(2),
            ..Default::default()
        },
    )
    .unwrap();
    assert_owned_path(
        temporary.path(),
        &OwnedPathOptions {
            kind: Some(ObjectKind::Directory),
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn final_component_reparse_points_are_rejected() {
    let temporary = TempDir::new().unwrap();
    let target = temporary.path().join("target");
    let link = temporary.path().join("link");
    fs::write(&target, b"payload").unwrap();
    symlink_file(&target, &link).unwrap();
    assert_eq!(
        assert_owned_path(
            &link,
            &OwnedPathOptions {
                kind: Some(ObjectKind::File),
                ..Default::default()
            },
        )
        .unwrap_err()
        .code,
        "symlink"
    );
    assert_eq!(
        stable_read(
            &link,
            &StableReadOptions {
                maximum_bytes: 64,
                ..Default::default()
            },
        )
        .unwrap_err()
        .code,
        "symlink"
    );
}
