use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;

use local_custody::read_protected_descriptor;
use tempfile::TempDir;

#[test]
fn private_regular_file_returns_content() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("secret");
    fs::write(&path, "token").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let file = fs::File::open(&path).unwrap();
    let result = read_protected_descriptor(file.as_raw_fd(), Some(1_024));
    assert_eq!(result.unwrap(), "token");
}

#[test]
fn permissive_regular_file_rejected() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("secret");
    fs::write(&path, "token").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let file = fs::File::open(&path).unwrap();
    let err = read_protected_descriptor(file.as_raw_fd(), Some(1_024)).unwrap_err();
    assert_eq!(err.code, "mode");
}

#[test]
fn input_beyond_bound_rejected() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("secret");
    fs::write(&path, "x".repeat(128)).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let file = fs::File::open(&path).unwrap();
    let err = read_protected_descriptor(file.as_raw_fd(), Some(64)).unwrap_err();
    assert_eq!(err.code, "limit");
}

#[test]
fn negative_descriptor_rejected() {
    let err = read_protected_descriptor(-1, Some(64)).unwrap_err();
    assert_eq!(err.code, "invalid");
}


