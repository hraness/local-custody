#![cfg(unix)]

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

fn pipe_with(content: &[u8]) -> i32 {
    let mut fds = [0i32; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let written = unsafe { libc::write(fds[1], content.as_ptr().cast(), content.len()) };
    assert_eq!(written, content.len() as isize);
    unsafe { libc::close(fds[1]) };
    fds[0]
}

#[test]
fn piped_input_returns_content() {
    let read_end = pipe_with(b"piped-token");
    let result = read_protected_descriptor(read_end, Some(1_024));
    unsafe { libc::close(read_end) };
    assert_eq!(result.unwrap(), "piped-token");
}

#[test]
fn piped_input_beyond_bound_rejected() {
    let read_end = pipe_with(&[b'x'; 128]);
    let err = read_protected_descriptor(read_end, Some(64)).unwrap_err();
    unsafe { libc::close(read_end) };
    assert_eq!(err.code, "limit");
}

#[test]
fn empty_pipe_returns_empty_content() {
    let read_end = pipe_with(b"");
    let result = read_protected_descriptor(read_end, Some(64));
    unsafe { libc::close(read_end) };
    assert_eq!(result.unwrap(), "");
}

#[test]
fn directory_descriptor_rejected() {
    let dir = TempDir::new().unwrap();
    let handle = fs::File::open(dir.path()).unwrap();
    let err = read_protected_descriptor(handle.as_raw_fd(), Some(64)).unwrap_err();
    assert_eq!(err.code, "kind");
}
