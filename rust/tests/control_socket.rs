#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use local_custody::{
    listen_control_socket, request_control_socket, ControlSocketBounds, ControlSocketFailureReason,
};
use serde_json::json;
use tempfile::TempDir;

struct PrivateDir {
    #[allow(dead_code)]
    _temp: TempDir,
    path: PathBuf,
}

fn private_dir() -> PrivateDir {
    let temp = TempDir::new().unwrap();
    let base = temp.path().join("private");
    fs::create_dir(&base).unwrap();
    fs::set_permissions(&base, fs::Permissions::from_mode(0o700)).unwrap();
    PrivateDir {
        _temp: temp,
        path: base.canonicalize().unwrap(),
    }
}

fn socket_bounds() -> ControlSocketBounds {
    ControlSocketBounds {
        maximum_frame_bytes: 4_096,
        maximum_response_bytes: 4_096,
        maximum_requests_per_connection: 4,
        header_timeout_ms: 1_000,
        idle_timeout_ms: 1_000,
    }
}

fn serve(path: PathBuf, stop: Arc<AtomicBool>) {
    let bounds = socket_bounds();
    let handler =
        |req: serde_json::Value| -> Result<serde_json::Value, ControlSocketFailureReason> {
            if req == json!({"ping": 1}) {
                Ok(json!({"ok": true, "pong": 1}))
            } else {
                Err(ControlSocketFailureReason::InvalidRequest)
            }
        };
    listen_control_socket(&path, &bounds, handler, &stop).unwrap();
}

#[test]
fn single_complete_request() {
    let dir = private_dir();
    let path = dir.path.join("ctrl.sock");
    let path_for_server = path.clone();
    let stop = Arc::new(AtomicBool::new(true));
    let stop2 = stop.clone();
    let server = thread::spawn(move || serve(path_for_server, stop2));
    // Wait for the socket to appear.
    for _ in 0..100 {
        if path.exists() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let resp = request_control_socket(&path, &json!({"ping": 1}), 4_096, 1_000).unwrap();
    assert_eq!(resp, json!({"ok": true, "pong": 1}));
    stop.store(false, Ordering::Relaxed);
    server.join().unwrap();
}

#[test]
fn unparsable_frame_returns_failure() {
    let dir = private_dir();
    let path = dir.path.join("ctrl.sock");
    let stop = Arc::new(AtomicBool::new(true));
    let stop2 = stop.clone();
    let server_path = path.clone();
    let server = thread::spawn(move || {
        let bounds = socket_bounds();
        listen_control_socket(
            &server_path,
            &bounds,
            |_req| Err(ControlSocketFailureReason::InvalidRequest),
            &stop2,
        )
        .unwrap();
    });
    for _ in 0..100 {
        if path.exists() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let resp = request_control_socket(&path, &json!("not json"), 4_096, 1_000).unwrap();
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["code"], "invalid-request");
    stop.store(false, Ordering::Relaxed);
    server.join().unwrap();
}

#[test]
fn oversize_response_exceeds_bound() {
    let dir = private_dir();
    let path = dir.path.join("ctrl.sock");
    let stop = Arc::new(AtomicBool::new(true));
    let stop2 = stop.clone();
    let server_path = path.clone();
    let server = thread::spawn(move || {
        let bounds = socket_bounds();
        listen_control_socket(
            &server_path,
            &bounds,
            |_req| Ok(json!({"ok": true, "data": "x".repeat(5_000)})),
            &stop2,
        )
        .unwrap();
    });
    for _ in 0..100 {
        if path.exists() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let resp = request_control_socket(&path, &json!({"ping": 1}), 4_096, 1_000).unwrap();
    assert_eq!(resp["ok"], false);
    assert_eq!(resp["code"], "response-limit");
    stop.store(false, Ordering::Relaxed);
    server.join().unwrap();
}
