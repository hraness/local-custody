#![cfg(unix)]

//! Wire-level contract tests for the `local-custody` JSON-lines sidecar.
//!
//! Each request is one JSON line on stdin; the sidecar must answer with
//! exactly one JSON line per request. Success responses are the raw result
//! objects; domain failures are `{"ok":false,"code","message"}`. The
//! `sidecarEnvelope` vectors in `spec/vectors.json` drive the shared corpus.

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde::Deserialize;
use serde_json::Value;
use tempfile::TempDir;

#[derive(Debug, Deserialize)]
struct SidecarVectors {
    #[serde(rename = "sidecarEnvelope")]
    sidecar_envelope: Vec<SidecarCase>,
}

#[derive(Debug, Deserialize)]
struct SidecarCase {
    name: String,
    request: Value,
    expect: Expect,
}

#[derive(Debug, Deserialize)]
struct Expect {
    ok: bool,
    code: Option<String>,
    fields: Option<serde_json::Map<String, Value>>,
}

fn canonical_temp() -> (TempDir, PathBuf) {
    let dir = TempDir::new().unwrap();
    let base = fs::canonicalize(dir.path()).unwrap();
    (dir, base)
}

/// Spawn the sidecar, feed every request line, close stdin, and return one
/// parsed response per request — asserting the one-line-per-request protocol.
fn run_sidecar(requests: &[String]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_local-custody"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        for request in requests {
            writeln!(stdin, "{request}").unwrap();
        }
        // Drop closes stdin so the sidecar observes EOF and exits.
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "sidecar exited with {:?}",
        output.status
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), requests.len(), "one response line per request");
    lines
        .iter()
        .map(|line| {
            serde_json::from_str(line).unwrap_or_else(|_| panic!("response is not JSON: {line}"))
        })
        .collect()
}

fn is_failure_envelope(response: &Value) -> bool {
    response["ok"] == Value::Bool(false) && response["message"].is_string()
}

#[test]
fn envelope_vectors() {
    let data: SidecarVectors =
        serde_json::from_str(include_str!("../../spec/vectors.json")).unwrap();
    let (_dir, base) = canonical_temp();
    // Vectors share one sidecar process and one canonical temporary root;
    // `$TEMP` inside a request string expands to that root.
    let requests: Vec<String> = data
        .sidecar_envelope
        .iter()
        .map(|case| {
            serde_json::to_string(&case.request)
                .unwrap()
                .replace("$TEMP", &base.display().to_string())
        })
        .collect();
    let responses = run_sidecar(&requests);
    for (case, response) in data.sidecar_envelope.iter().zip(responses.iter()) {
        let failure = is_failure_envelope(response);
        assert_eq!(
            failure, !case.expect.ok,
            "{}: unexpected envelope {response}",
            case.name,
        );
        if let Some(code) = &case.expect.code {
            assert_eq!(&response["code"], code, "{}: wrong failure code", case.name);
        }
        if !case.expect.ok {
            assert!(
                response["code"].is_string(),
                "{}: failure must carry a code",
                case.name
            );
        }
        if let Some(fields) = &case.expect.fields {
            for (key, expected) in fields {
                let expected = match expected {
                    Value::String(s) => {
                        Value::String(s.replace("$TEMP", &base.display().to_string()))
                    }
                    other => other.clone(),
                };
                assert_eq!(&response[key], &expected, "{}: field {key}", case.name);
            }
        }
    }
}

#[test]
fn invalid_requests_are_rejected_per_line() {
    let requests = vec![
        String::new(),                         // empty request line
        "not-json".to_string(),                // malformed JSON
        "{\"op\":\"no-such-op\"}".to_string(), // unknown op
        "{\"op\":123}".to_string(),            // non-string op
    ];
    let responses = run_sidecar(&requests);
    for (index, response) in responses.iter().enumerate() {
        assert!(
            is_failure_envelope(response),
            "request {index} must fail: {response}"
        );
        assert_eq!(
            response["code"], "invalid-request",
            "request {index}: {response}"
        );
    }
}

#[test]
fn atomic_publish_reports_created() {
    let (_dir, base) = canonical_temp();
    let dir = base.join("private");
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    let dir = dir.display().to_string();
    let requests = vec![
        format!("{{\"op\":\"atomic_publish\",\"dir\":\"{dir}\",\"name\":\"once.txt\",\"contentBase64\":\"eA==\",\"createOnce\":true}}"),
        format!("{{\"op\":\"atomic_publish\",\"dir\":\"{dir}\",\"name\":\"once.txt\",\"contentBase64\":\"eQ==\",\"createOnce\":true}}"),
        format!("{{\"op\":\"atomic_publish\",\"dir\":\"{dir}\",\"name\":\"once.txt\",\"contentBase64\":\"eg==\",\"createOnce\":false}}"),
    ];
    let responses = run_sidecar(&requests);
    assert_eq!(responses[0]["created"], true, "first create-once publishes");
    assert_eq!(
        responses[1]["created"], false,
        "second create-once preserves"
    );
    assert_eq!(
        responses[2]["created"], true,
        "re-publish writes new content"
    );
    assert_eq!(
        fs::read_to_string(base.join("private").join("once.txt")).unwrap(),
        "z",
        "the re-published content wins",
    );
}

#[test]
fn stable_read_round_trips_content() {
    let (_dir, base) = canonical_temp();
    let dir = base.join("private");
    local_custody::ensure_private_directory(&dir).unwrap();
    let target = dir.join("state.json");
    fs::write(&target, b"payload").unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    let request = format!(
        "{{\"op\":\"stable_read\",\"path\":\"{}\",\"maximumBytes\":64}}",
        target.display(),
    );
    let responses = run_sidecar(&[request]);
    let response = &responses[0];
    assert!(
        !is_failure_envelope(response),
        "read must succeed: {response}"
    );
    assert_eq!(response["size"], 7);
    // "payload" in base64.
    assert_eq!(response["contentBase64"], "cGF5bG9hZA==");
}
