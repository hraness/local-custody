#![cfg(windows)]

use local_custody::{
    assert_owned_fd, assert_owned_path, atomic_publish, ensure_private_directory,
    read_protected_descriptor, request_control_socket, stable_read, ObjectKind, OwnedPathOptions,
    StableReadOptions,
};
use serde_json::json;

fn unsupported(error: local_custody::CustodyError) {
    assert_eq!(error.code, "unsupported");
}

#[test]
fn unix_specific_custody_requests_fail_explicitly() {
    unsupported(ensure_private_directory(r"C:\custody").unwrap_err());
    unsupported(
        assert_owned_path(
            r"C:\custody\state",
            &OwnedPathOptions {
                kind: Some(ObjectKind::File),
                owner_only: true,
                ..Default::default()
            },
        )
        .unwrap_err(),
    );
    unsupported(
        assert_owned_path(
            r"C:\custody\state",
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
            r"C:\custody\state",
            &StableReadOptions {
                owner_only: true,
                maximum_bytes: 1024,
                ..Default::default()
            },
        )
        .unwrap_err(),
    );
    unsupported(atomic_publish(r"C:\custody", "state", b"value", true).unwrap_err());
    unsupported(assert_owned_fd(0, &OwnedPathOptions::default()).unwrap_err());
    unsupported(read_protected_descriptor(0, Some(1024)).unwrap_err());
    unsupported(request_control_socket(r"C:\custody\control", &json!({}), 1024, 1000).unwrap_err());
}
