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
