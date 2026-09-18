//! Rust port of the `local-custody` filesystem-custody contract.
//!
//! This crate reproduces the behaviors described in `spec/custody.md` and
//! `spec/vectors.json`. It is product-neutral and owns only transport/custody
//! mechanics, not product semantics.

use std::fmt;
use std::fs::{self, File, OpenOptions, Permissions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// An outcome from an owned-path or stable-read check that callers can use to
/// detect time-of-check/time-of-use replacement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectIdentity {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ObjectKind {
    File,
    Directory,
    Socket,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct OwnedPathOptions {
    pub kind: Option<ObjectKind>,
    pub exact_mode: Option<u32>,
    pub owner_only: bool,
    pub maximum_bytes: Option<u64>,
    pub minimum_bytes: Option<u64>,
    pub links: Option<u64>,
    pub canonical: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StableReadOptions {
    pub exact_mode: Option<u32>,
    pub owner_only: bool,
    pub maximum_bytes: u64,
    pub minimum_bytes: Option<u64>,
    pub links: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct StableReadResult {
    pub bytes: Vec<u8>,
    pub identity: ObjectIdentity,
}

#[derive(Debug, Clone)]
pub struct PrivateDirectory {
    pub path: PathBuf,
    pub identity: ObjectIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustodyError {
    pub code: String,
    pub message: String,
}

impl CustodyError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

impl fmt::Display for CustodyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CustodyError {}

fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        Some(unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

fn is_symbolic_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

fn is_root(path: &Path) -> bool {
    path.parent().is_none()
}

fn realpath_eq(path: &Path) -> Result<PathBuf, CustodyError> {
    let canonical = fs::canonicalize(path).map_err(|e| {
        CustodyError::new("not-found", format!("cannot canonicalize {}: {e}", path.display()))
    })?;
    if canonical.as_path() != path {
        return Err(CustodyError::new(
            "noncanonical",
            format!("{} resolves to {}", path.display(), canonical.display()),
        ));
    }
    Ok(canonical)
}

fn identity_of(meta: &fs::Metadata) -> ObjectIdentity {
    ObjectIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
        size: meta.size(),
    }
}

fn validate_mode(meta: &fs::Metadata, options: &OwnedPathOptions) -> Result<(), CustodyError> {
    let mode = meta.mode() & 0o777;
    if let Some(exact) = options.exact_mode {
        if mode != exact {
            return Err(CustodyError::new(
                "mode-mismatch",
                format!("mode {mode:04o} != expected {exact:04o}"),
            ));
        }
    } else if options.owner_only && mode & 0o077 != 0 {
        return Err(CustodyError::new(
            "owner-only",
            format!("mode {mode:04o} is group/other-accessible"),
        ));
    }
    Ok(())
}

fn validate_kind(meta: &fs::Metadata, kind: ObjectKind) -> Result<(), CustodyError> {
    let actual = if meta.is_dir() {
        ObjectKind::Directory
    } else if meta.is_file() {
        ObjectKind::File
    } else if is_socket(meta) {
        ObjectKind::Socket
    } else {
        return Err(CustodyError::new("kind", "not a file, directory, or socket"));
    };
    if actual != kind {
        return Err(CustodyError::new(
            "kind-mismatch",
            format!("expected {kind:?}, found {actual:?}"),
        ));
    }
    Ok(())
}

fn is_socket(meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        meta.file_type().is_socket()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn validate_owner(meta: &fs::Metadata) -> Result<(), CustodyError> {
    if let Some(uid) = current_uid() {
        let file_uid = meta.uid();
        if file_uid != uid {
            return Err(CustodyError::new(
                "owner",
                format!("owner {file_uid} != current {uid}"),
            ));
        }
    }
    Ok(())
}

fn validate_link_count(meta: &fs::Metadata, expected: u64) -> Result<(), CustodyError> {
    let nlink = meta.nlink();
    if nlink != expected {
        return Err(CustodyError::new(
            "links",
            format!("link count {nlink} != expected {expected}"),
        ));
    }
    Ok(())
}

/// Validate a publication name.
///
/// Names must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$`, be at most 128 UTF-8
/// bytes, and contain no path separators or whitespace.
pub fn validate_publish_name(name: &str) -> Result<(), CustodyError> {
    if name.is_empty() {
        return Err(CustodyError::new("empty", "publish name is empty"));
    }
    if name.len() > 128 {
        return Err(CustodyError::new("too-long", "publish name exceeds 128 bytes"));
    }
    if name.as_bytes().iter().any(|&b| b.is_ascii_whitespace()) {
        return Err(CustodyError::new("whitespace", "publish name contains whitespace"));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(CustodyError::new("separator", "publish name contains a path separator"));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphanumeric()) {
        return Err(CustodyError::new("initial", "publish name must start with alphanumeric"));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err(CustodyError::new("character", "publish name has invalid character"));
    }
    Ok(())
}

fn ensure_canonical_parent(path: &Path) -> Result<(), CustodyError> {
    let parent = path.parent().ok_or_else(|| CustodyError::new("root", "path has no parent"))?;
    if parent.as_os_str().is_empty() {
        return Err(CustodyError::new("relative", "path is relative without a parent"));
    }
    let resolved = parent.canonicalize().map_err(|e| {
        CustodyError::new("not-found", format!("parent {}: {e}", parent.display()))
    })?;
    if resolved != parent {
        return Err(CustodyError::new(
            "noncanonical-parent",
            format!("parent {} resolves to {}", parent.display(), resolved.display()),
        ));
    }
    Ok(())
}

/// Ensure a private directory exists and satisfies the custody contract.
pub fn ensure_private_directory<P: AsRef<Path>>(path: P) -> Result<PrivateDirectory, CustodyError> {
    let path = path.as_ref();
    if is_root(path) {
        return Err(CustodyError::new("root", "refusing a filesystem root"));
    }
    ensure_canonical_parent(path)?;

    if !path.exists() {
        fs::create_dir_all(path).map_err(|e| {
            CustodyError::new("create", format!("cannot create {}: {e}", path.display()))
        })?;
        let perms = Permissions::from_mode(0o700);
        fs::set_permissions(path, perms).map_err(|e| {
            CustodyError::new("chmod", format!("cannot chmod {}: {e}", path.display()))
        })?;
    }

    realpath_eq(path)?;

    let meta = fs::symlink_metadata(path).map_err(|e| {
        CustodyError::new("stat", format!("cannot lstat {}: {e}", path.display()))
    })?;
    if meta.file_type().is_symlink() {
        return Err(CustodyError::new("symlink", format!("{} is a symlink", path.display())));
    }
    if !meta.is_dir() {
        return Err(CustodyError::new("not-directory", format!("{} is not a directory", path.display())));
    }
    validate_owner(&meta)?;
    let mode = meta.mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(CustodyError::new(
            "owner-only",
            format!("directory mode {mode:04o} is group/other-accessible"),
        ));
    }

    Ok(PrivateDirectory {
        path: path.to_path_buf(),
        identity: identity_of(&meta),
    })
}

/// Validate an owned path according to `OwnedPathOptions`.
pub fn assert_owned_path<P: AsRef<Path>>(
    path: P,
    options: &OwnedPathOptions,
) -> Result<ObjectIdentity, CustodyError> {
    let path = path.as_ref();
    if options.canonical {
        realpath_eq(path)?;
    }
    if is_symbolic_link(path) {
        return Err(CustodyError::new("symlink", format!("{} is a symlink", path.display())));
    }
    let meta = fs::symlink_metadata(path).map_err(|e| {
        CustodyError::new("stat", format!("cannot lstat {}: {e}", path.display()))
    })?;
    if meta.file_type().is_symlink() {
        return Err(CustodyError::new("symlink", format!("{} is a symlink", path.display())));
    }
    validate_owner(&meta)?;

    let size = meta.size();
    if let Some(max) = options.maximum_bytes {
        if size > max {
            return Err(CustodyError::new(
                "capacity",
                format!("size {size} exceeds maximum {max}"),
            ));
        }
    }
    if let Some(min) = options.minimum_bytes {
        if size < min {
            return Err(CustodyError::new(
                "minimum",
                format!("size {size} below minimum {min}"),
            ));
        }
    }

    if let Some(kind) = options.kind {
        validate_kind(&meta, kind)?;
    }

    validate_mode(&meta, options)?;

    let expected_links = options.links.unwrap_or(1);
    validate_link_count(&meta, expected_links)?;

    Ok(identity_of(&meta))
}

/// Read a regular file with time-of-check/time-of-use guards.
pub fn stable_read<P: AsRef<Path>>(
    path: P,
    options: &StableReadOptions,
) -> Result<StableReadResult, CustodyError> {
    let path = path.as_ref();
    if is_symbolic_link(path) {
        return Err(CustodyError::new("symlink", format!("{} is a symlink", path.display())));
    }

    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| CustodyError::new("open", format!("cannot open {}: {e}", path.display())))?;

    let before = file.metadata().map_err(|e| {
        CustodyError::new("stat", format!("cannot fstat {}: {e}", path.display()))
    })?;

    // Verify the path still resolves to the same object we opened. This catches
    // a replacement that happened immediately after open, before we read.
    let path_before = fs::symlink_metadata(path).map_err(|e| {
        CustodyError::new("stat", format!("cannot lstat {} after open: {e}", path.display()))
    })?;
    if path_before.file_type().is_symlink()
        || before.dev() != path_before.dev()
        || before.ino() != path_before.ino()
        || before.size() != path_before.size()
        || before.mode() != path_before.mode()
        || before.uid() != path_before.uid()
        || before.nlink() != path_before.nlink()
        || before.mtime_nsec() != path_before.mtime_nsec()
        || before.ctime_nsec() != path_before.ctime_nsec()
    {
        return Err(CustodyError::new(
            "changed",
            format!("{} changed immediately after it was opened", path.display()),
        ));
    }

    if !before.is_file() {
        return Err(CustodyError::new("not-file", format!("{} is not a regular file", path.display())));
    }
    validate_owner(&before)?;
    let size = before.size();
    if size > options.maximum_bytes {
        return Err(CustodyError::new(
            "capacity",
            format!("size {size} exceeds maximum {}", options.maximum_bytes),
        ));
    }
    if let Some(min) = options.minimum_bytes {
        if size < min {
            return Err(CustodyError::new(
                "minimum",
                format!("size {size} below minimum {min}"),
            ));
        }
    }
    let expected_links = options.links.unwrap_or(1);
    validate_link_count(&before, expected_links)?;

    let opts = OwnedPathOptions {
        kind: Some(ObjectKind::File),
        exact_mode: options.exact_mode,
        owner_only: options.owner_only,
        maximum_bytes: Some(options.maximum_bytes),
        minimum_bytes: options.minimum_bytes,
        links: options.links,
        canonical: false,
    };
    validate_mode(&before, &opts)?;

    let mut bytes = Vec::with_capacity(size as usize);
    let mut file = file;
    let mut buf = [0u8; 64 * 1024];
    while bytes.len() < size as usize {
        let want = std::cmp::min(buf.len(), size as usize - bytes.len());
        let n = file.read(&mut buf[..want]).map_err(|e| {
            CustodyError::new("read", format!("cannot read {}: {e}", path.display()))
        })?;
        if n == 0 {
            return Err(CustodyError::new(
                "shrunk",
                format!("file shrank during read: expected {size}, read {}", bytes.len()),
            ));
        }
        bytes.extend_from_slice(&buf[..n]);
    }

    let after = fs::symlink_metadata(path).map_err(|e| {
        CustodyError::new("stat", format!("cannot lstat after read {}: {e}", path.display()))
    })?;
    if after.file_type().is_symlink() {
        return Err(CustodyError::new("symlink", format!("{} became a symlink", path.display())));
    }
    if before.dev() != after.dev()
        || before.ino() != after.ino()
        || before.size() != after.size()
        || before.mode() != after.mode()
        || before.uid() != after.uid()
        || before.nlink() != after.nlink()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(CustodyError::new(
            "changed",
            format!("{} changed while it was read", path.display()),
        ));
    }

    Ok(StableReadResult {
        bytes,
        identity: identity_of(&after),
    })
}

/// Atomically publish `content` as `name` inside `dir`.
///
/// If `create_once` is true and the target already exists, the existing file is
/// preserved and its path is returned.
pub fn atomic_publish<P: AsRef<Path>>(
    dir: P,
    name: &str,
    content: &[u8],
    create_once: bool,
) -> Result<PathBuf, CustodyError> {
    let dir = dir.as_ref();
    validate_publish_name(name)?;
    ensure_private_directory(dir)?;

    let target = dir.join(name);
    if create_once && target.exists() {
        assert_owned_path(
            &target,
            &OwnedPathOptions {
                kind: Some(ObjectKind::File),
                exact_mode: Some(0o600),
                links: Some(1),
                ..Default::default()
            },
        )?;
        return Ok(target);
    }

    let tmp_name = format!(".publish-{name}-{}", process_id());
    let tmp_path = dir.join(&tmp_name);

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp_path)
        .map_err(|e| CustodyError::new("stage", format!("cannot stage {tmp_name}: {e}")))?;

    file.write_all(content).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        CustodyError::new("write", format!("cannot write staged file: {e}"))
    })?;
    file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        CustodyError::new("fsync", format!("cannot fsync staged file: {e}"))
    })?;
    drop(file);

    fs::rename(&tmp_path, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        CustodyError::new("rename", format!("cannot publish {name}: {e}"))
    })?;

    let dir_file = File::open(dir).map_err(|e| {
        CustodyError::new("dir-open", format!("cannot open directory for fsync: {e}"))
    })?;
    dir_file.sync_all().map_err(|e| {
        CustodyError::new("dir-fsync", format!("cannot fsync directory: {e}"))
    })?;

    assert_owned_path(
        &target,
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            exact_mode: Some(0o600),
            links: Some(1),
            ..Default::default()
        },
    )?;

    Ok(target)
}

fn process_id() -> u32 {
    #[cfg(unix)]
    {
        unsafe { libc::getpid() as u32 }
    }
    #[cfg(not(unix))]
    {
        0
    }
}

impl fmt::Debug for ObjectKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ObjectKind::File => write!(f, "file"),
            ObjectKind::Directory => write!(f, "directory"),
            ObjectKind::Socket => write!(f, "socket"),
        }
    }
}

impl fmt::Display for ObjectKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

// -----------------------------------------------------------------------------
// Protected input
// -----------------------------------------------------------------------------

const DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES: usize = 65_536;

/// Read a secret from a descriptor that is known to the caller.
///
/// - Rejects negative descriptors.
/// - Rejects TTYs.
/// - On Unix, the descriptor must refer to a regular file owned by the
///   current user with no group/other access bits.
/// - Reads at most `maximum_bytes` and fails if more data is available.
/// - Returns valid UTF-8 or fails closed.
pub fn read_protected_descriptor(fd: i32, maximum_bytes: Option<usize>) -> Result<String, CustodyError> {
    if fd < 0 {
        return Err(CustodyError::new("invalid", "negative descriptor"));
    }
    let maximum_bytes = maximum_bytes.unwrap_or(DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES);
    if maximum_bytes == 0 {
        return Err(CustodyError::new("limit", "maximum bytes must be positive"));
    }

    #[cfg(unix)]
    {
        use std::os::unix::io::RawFd;
        let raw: RawFd = fd;
        let is_tty = unsafe { libc::isatty(raw) != 0 };
        if is_tty {
            return Err(CustodyError::new("tty", "descriptor is a terminal"));
        }
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstat(raw, &mut stat) } != 0 {
            return Err(CustodyError::new("stat", format!("cannot fstat descriptor {fd}")));
        }
        if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
            return Err(CustodyError::new("kind", "descriptor is not a regular file"));
        }
        if let Some(uid) = current_uid() {
            if stat.st_uid != uid {
                return Err(CustodyError::new("owner", "descriptor is not owned by current user"));
            }
        }
        if stat.st_mode & 0o077 != 0 {
            return Err(CustodyError::new("mode", "descriptor allows group/other access"));
        }
    }
    #[cfg(not(unix))]
    {
        // Without Unix metadata we can only enforce the TTY and byte bounds.
    }

    // Read directly through libc so we never take ownership of the caller's
    // descriptor and therefore never close it.
    let mut buf = Vec::with_capacity(maximum_bytes);
    while buf.len() < maximum_bytes {
        let remaining = maximum_bytes - buf.len();
        let mut chunk = vec![0u8; remaining.min(4096)];
        let n = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
        if n < 0 {
            return Err(CustodyError::new("read", format!("cannot read descriptor {fd}")));
        }
        if n == 0 {
            break;
        }
        let n = n as usize;
        buf.extend_from_slice(&chunk[..n]);
    }
    // Detect whether any additional bytes remain beyond the bound.
    let mut extra = [0u8; 1];
    let n = unsafe { libc::read(fd, extra.as_mut_ptr().cast(), 1) };
    if n > 0 {
        return Err(CustodyError::new("limit", format!("input exceeds {maximum_bytes} bytes")));
    }
    String::from_utf8(buf).map_err(|e| {
        CustodyError::new("utf8", format!("descriptor content is not valid UTF-8: {e}"))
    })
}

pub fn read_protected_stdin(maximum_bytes: Option<usize>) -> Result<String, CustodyError> {
    read_protected_descriptor(0, maximum_bytes)
}

// -----------------------------------------------------------------------------
// Control socket
// -----------------------------------------------------------------------------

pub const MAXIMUM_SOCKET_PATH_BYTES: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlSocketFailureReason {
    Capacity,
    Limit,
    InvalidRequest,
    ResponseLimit,
}

impl fmt::Display for ControlSocketFailureReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ControlSocketFailureReason::Capacity => write!(f, "capacity"),
            ControlSocketFailureReason::Limit => write!(f, "limit"),
            ControlSocketFailureReason::InvalidRequest => write!(f, "invalid-request"),
            ControlSocketFailureReason::ResponseLimit => write!(f, "response-limit"),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ControlSocketBounds {
    pub maximum_frame_bytes: usize,
    pub maximum_response_bytes: usize,
    pub maximum_requests_per_connection: usize,
    pub header_timeout_ms: u64,
    pub idle_timeout_ms: u64,
}

fn control_socket_failure_response(reason: ControlSocketFailureReason) -> serde_json::Value {
    serde_json::json!({"ok": false, "code": reason.to_string()})
}

fn validate_socket_path(socket_path: &Path) -> Result<(), CustodyError> {
    let bytes = socket_path.as_os_str().as_encoded_bytes();
    if bytes.len() > MAXIMUM_SOCKET_PATH_BYTES {
        return Err(CustodyError::new(
            "path-too-long",
            format!("socket path exceeds {MAXIMUM_SOCKET_PATH_BYTES} bytes"),
        ));
    }
    let parent = socket_path.parent().ok_or_else(|| CustodyError::new("root", "socket path has no parent"))?;
    ensure_private_directory(parent)?;
    Ok(())
}

/// Listen on a Unix domain socket and handle newline-delimited JSON requests.
///
/// The socket path must have a private parent directory. An existing stale
/// socket at the path is unlinked if it is owned by the current process user.
/// Each connection may handle up to `maximum_requests_per_connection` frames.
/// Oversize or invalid frames receive a failure response and the connection is
/// closed. The loop stops when `running` becomes false.
#[cfg(unix)]
pub fn listen_control_socket<P, H>(
    socket_path: P,
    bounds: &ControlSocketBounds,
    handler: H,
    running: &AtomicBool,
) -> Result<(), CustodyError>
where
    P: AsRef<Path>,
    H: Fn(serde_json::Value) -> Result<serde_json::Value, ControlSocketFailureReason>,
{
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    let socket_path = socket_path.as_ref();
    validate_socket_path(socket_path)?;
    if socket_path.exists() {
        assert_owned_path(
            socket_path,
            &OwnedPathOptions {
                kind: Some(ObjectKind::Socket),
                exact_mode: Some(0o600),
                owner_only: true,
                canonical: true,
                ..Default::default()
            },
        )
        .ok();
        let _ = fs::remove_file(socket_path);
    }
    let listener = UnixListener::bind(socket_path).map_err(|e| {
        CustodyError::new("bind", format!("cannot bind control socket {}: {e}", socket_path.display()))
    })?;
    let _ = fs::set_permissions(socket_path, Permissions::from_mode(0o600));
    listener
        .set_nonblocking(true)
        .map_err(|e| CustodyError::new("nonblocking", format!("{e}")))?;

    let header_timeout = Duration::from_millis(bounds.header_timeout_ms.max(1));
    let idle_timeout = Duration::from_millis(bounds.idle_timeout_ms.max(1));

    while running.load(Ordering::Relaxed) {
        let (mut stream, _) = match listener.accept() {
            Ok(conn) => conn,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            Err(e) => return Err(CustodyError::new("accept", format!("{e}"))),
        };
        let _ = stream.set_read_timeout(Some(header_timeout));
        let _ = stream.set_write_timeout(Some(idle_timeout));

        let mut requests_handled = 0usize;
        loop {
            if !running.load(Ordering::Relaxed) {
                break;
            }
            if requests_handled >= bounds.maximum_requests_per_connection.max(1) {
                break;
            }
            let mut frame = Vec::with_capacity(bounds.maximum_frame_bytes + 1);
            let mut byte = [0u8; 1];
            loop {
                match stream.read_exact(&mut byte) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                }
                if byte[0] == b'\n' {
                    break;
                }
                frame.push(byte[0]);
                if frame.len() > bounds.maximum_frame_bytes {
                    let resp = control_socket_failure_response(ControlSocketFailureReason::Capacity);
                    let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap_or_default());
                    break;
                }
            }
            if frame.len() > bounds.maximum_frame_bytes {
                break;
            }
            if frame.is_empty() {
                let resp = control_socket_failure_response(ControlSocketFailureReason::InvalidRequest);
                let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap_or_default());
                break;
            }
            let request: serde_json::Value = match serde_json::from_slice(&frame) {
                Ok(v) => v,
                Err(_) => {
                    let resp = control_socket_failure_response(ControlSocketFailureReason::InvalidRequest);
                    let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap_or_default());
                    break;
                }
            };
            let response = match handler(request) {
                Ok(v) => v,
                Err(reason) => control_socket_failure_response(reason),
            };
            let response_line = serde_json::to_string(&response).unwrap_or_default();
            if response_line.len() > bounds.maximum_response_bytes {
                let resp = control_socket_failure_response(ControlSocketFailureReason::ResponseLimit);
                let _ = writeln!(stream, "{}", serde_json::to_string(&resp).unwrap_or_default());
            } else {
                let _ = writeln!(stream, "{response_line}");
            }
            requests_handled += 1;
        }
    }
    Ok(())
}

/// Send a single newline-delimited JSON request to a Unix control socket and
/// return the parsed response.
#[cfg(unix)]
pub fn request_control_socket<P: AsRef<Path>>(
    socket_path: P,
    request: &serde_json::Value,
    maximum_response_bytes: usize,
    timeout_ms: u64,
) -> Result<serde_json::Value, CustodyError> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    let socket_path = socket_path.as_ref();
    validate_socket_path(socket_path)?;
    assert_owned_path(
        socket_path,
        &OwnedPathOptions {
            kind: Some(ObjectKind::Socket),
            exact_mode: Some(0o600),
            owner_only: true,
            canonical: true,
            ..Default::default()
        },
    )?;
    const MAXIMUM_REQUEST_LINE_BYTES: usize = 1_000_000;
    let request_line = serde_json::to_string(request).map_err(|e| CustodyError::new("encode", format!("{e}")))?;
    if request_line.len() > MAXIMUM_REQUEST_LINE_BYTES {
        return Err(CustodyError::new("request-too-long", "request exceeds sanity bound"));
    }
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let mut stream = UnixStream::connect(socket_path).map_err(|e| {
        CustodyError::new("connect", format!("cannot connect to {}: {e}", socket_path.display()))
    })?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| CustodyError::new("timeout", format!("{e}")))?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| CustodyError::new("timeout", format!("{e}")))?;
    stream.write_all(request_line.as_bytes()).map_err(|e| CustodyError::new("write", format!("{e}")))?;
    stream.write_all(b"\n").map_err(|e| CustodyError::new("write", format!("{e}")))?;
    let mut response_line = Vec::with_capacity(maximum_response_bytes + 1);
    let mut byte = [0u8; 1];
    loop {
        match stream.read_exact(&mut byte) {
            Ok(()) => {}
            Err(e) => return Err(CustodyError::new("read", format!("{e}"))),
        }
        if byte[0] == b'\n' {
            break;
        }
        response_line.push(byte[0]);
        if response_line.len() > maximum_response_bytes {
            return Err(CustodyError::new("response-limit", "response exceeds bound"));
        }
    }
    serde_json::from_slice(&response_line).map_err(|e| CustodyError::new("json", format!("{e}")))
}

#[cfg(not(unix))]
pub fn listen_control_socket<P, H>(
    _socket_path: P,
    _bounds: &ControlSocketBounds,
    _handler: H,
    _running: &std::sync::AtomicBool,
) -> Result<(), CustodyError> {
    Err(CustodyError::new("unsupported", "Unix control sockets are not supported on this platform"))
}

#[cfg(not(unix))]
pub fn request_control_socket<P: AsRef<Path>>(
    _socket_path: P,
    _request: &serde_json::Value,
    _maximum_response_bytes: usize,
    _timeout_ms: u64,
) -> Result<serde_json::Value, CustodyError> {
    Err(CustodyError::new("unsupported", "Unix control sockets are not supported on this platform"))
}

// Ensure unused File drops do not close borrowed descriptors. Re-export via the
// read functions is sufficient; this trait is not public.
