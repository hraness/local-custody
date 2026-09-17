//! Minimal JSON sidecar for `local-custody`.
//!
//! Reads one JSON request per line from stdin, dispatches to the Rust custody
//! engine, and prints one JSON response per line.
//!
//! Request forms:
//! - `{"op":"ensure_private_directory","path":"..."}`
//! - `{"op":"assert_owned_path","path":"...","kind":"file|directory|socket",
//!    "exactMode":"0600","ownerOnly":true,"maximumBytes":N,"minimumBytes":N,
//!    "links":N,"canonical":true}`
//! - `{"op":"stable_read","path":"...","exactMode":"0600","maximumBytes":N,
//!    "minimumBytes":N}`
//! - `{"op":"atomic_publish","dir":"...","name":"...","contentBase64":"...",
//!    "createOnce":false}`

use std::io::{self, BufRead, Write};

use local_custody::{ObjectKind, OwnedPathOptions, StableReadOptions};
use serde::Deserialize;
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(tag = "op")]
enum Request {
    #[serde(rename = "ensure_private_directory")]
    EnsurePrivateDirectory { path: String },
    #[serde(rename = "assert_owned_path")]
    AssertOwnedPath {
        path: String,
        kind: Option<String>,
        #[serde(rename = "exactMode")]
        exact_mode: Option<String>,
        #[serde(rename = "ownerOnly")]
        owner_only: Option<bool>,
        #[serde(rename = "maximumBytes")]
        maximum_bytes: Option<u64>,
        #[serde(rename = "minimumBytes")]
        minimum_bytes: Option<u64>,
        links: Option<u64>,
        canonical: Option<bool>,
    },
    #[serde(rename = "stable_read")]
    StableRead {
        path: String,
        #[serde(rename = "exactMode")]
        exact_mode: Option<String>,
        #[serde(rename = "ownerOnly")]
        owner_only: Option<bool>,
        #[serde(rename = "maximumBytes")]
        maximum_bytes: u64,
        #[serde(rename = "minimumBytes")]
        minimum_bytes: Option<u64>,
        links: Option<u64>,
    },
    #[serde(rename = "atomic_publish")]
    AtomicPublish {
        dir: String,
        name: String,
        #[serde(rename = "contentBase64")]
        content_base64: String,
        #[serde(rename = "createOnce")]
        create_once: Option<bool>,
    },
}

fn parse_mode(s: &str) -> Result<u32, String> {
    u32::from_str_radix(s, 8).map_err(|e| format!("invalid mode {s}: {e}"))
}

fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    use base64_decode::BASE64;
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut bits: u32 = 0;
    let mut bit_count: u32 = 0;
    for ch in s.chars() {
        if ch == '=' {
            break;
        }
        let value: u32 = BASE64.iter().position(|&c| c == ch as u8).ok_or_else(|| format!("invalid base64 char: {ch}"))? as u32;
        bits = (bits << 6) | value;
        bit_count += 6;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push(((bits >> bit_count) & 0xff) as u8);
        }
    }
    Ok(out)
}

mod base64_decode {
    pub const BASE64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
}

fn failure(code: &str, message: impl Into<String>) {
    println!("{}", json!({"ok": false, "code": code, "message": message.into()}));
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => {
                failure("io", "cannot read stdin");
                break;
            }
        };
        if line.is_empty() {
            failure("invalid-request", "empty request");
            let _ = stdout.flush();
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                failure("invalid-request", format!("cannot parse request: {e}"));
                let _ = stdout.flush();
                continue;
            }
        };
        match dispatch(req) {
            Ok(resp) => println!("{}", resp),
            Err((code, msg)) => failure(&code, msg),
        }
        let _ = stdout.flush();
    }
}

fn dispatch(req: Request) -> Result<serde_json::Value, (String, String)> {
    match req {
        Request::EnsurePrivateDirectory { path } => {
            let dir = local_custody::ensure_private_directory(&path)
                .map_err(|e| (e.code, e.message))?;
            Ok(json!({
                "path": dir.path,
                "dev": dir.identity.dev,
                "ino": dir.identity.ino,
            }))
        }
        Request::AssertOwnedPath {
            path,
            kind,
            exact_mode,
            owner_only,
            maximum_bytes,
            minimum_bytes,
            links,
            canonical,
        } => {
            let kind = kind
                .map(|s| match s.as_str() {
                    "file" => Ok(ObjectKind::File),
                    "directory" => Ok(ObjectKind::Directory),
                    "socket" => Ok(ObjectKind::Socket),
                    _ => Err(("invalid-request".to_string(), format!("unknown kind {s}"))),
                })
                .transpose()?;
            let exact_mode = exact_mode
                .map(|s| parse_mode(&s).map_err(|e| ("invalid-request".to_string(), e)))
                .transpose()?;
            let options = OwnedPathOptions {
                kind,
                exact_mode,
                owner_only: owner_only.unwrap_or(false),
                maximum_bytes,
                minimum_bytes,
                links,
                canonical: canonical.unwrap_or(false),
            };
            let id = local_custody::assert_owned_path(&path, &options)
                .map_err(|e| (e.code, e.message))?;
            Ok(json!({ "dev": id.dev, "ino": id.ino, "size": id.size }))
        }
        Request::StableRead {
            path,
            exact_mode,
            owner_only,
            maximum_bytes,
            minimum_bytes,
            links,
        } => {
            let exact_mode = exact_mode
                .map(|s| parse_mode(&s).map_err(|e| ("invalid-request".to_string(), e)))
                .transpose()?;
            let options = StableReadOptions {
                exact_mode,
                owner_only: owner_only.unwrap_or(true),
                maximum_bytes,
                minimum_bytes,
                links: links.or(Some(1)),
            };
            let result = local_custody::stable_read(&path, &options)
                .map_err(|e| (e.code, e.message))?;
            Ok(json!({
                "dev": result.identity.dev,
                "ino": result.identity.ino,
                "size": result.identity.size,
                "contentBase64": base64_encode(&result.bytes),
            }))
        }
        Request::AtomicPublish {
            dir,
            name,
            content_base64,
            create_once,
        } => {
            let content = decode_base64(&content_base64)
                .map_err(|e| ("invalid-request".to_string(), e))?;
            let published = local_custody::atomic_publish(&dir, &name, &content, create_once.unwrap_or(false))
                .map_err(|e| (e.code, e.message))?;
            Ok(json!({ "path": published }))
        }
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() * 4).div_ceil(3));
    let mut bits: u32 = 0;
    let mut bit_count: u32 = 0;
    for &b in bytes {
        bits = (bits << 8) | b as u32;
        bit_count += 8;
        while bit_count >= 6 {
            bit_count -= 6;
            out.push(ALPHABET[((bits >> bit_count) & 0x3f) as usize] as char);
        }
    }
    if bit_count > 0 {
        out.push(ALPHABET[((bits << (6 - bit_count)) & 0x3f) as usize] as char);
    }
    while out.len() % 4 != 0 {
        out.push('=');
    }
    out
}
