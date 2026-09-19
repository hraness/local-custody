//! Rust port of the `local-custody` filesystem-custody contract.
//!
//! This crate reproduces the behaviors described in `spec/custody.md` and
//! `spec/vectors.json`. It is product-neutral and owns only transport/custody
//! mechanics, not product semantics.

use std::fmt;
#[cfg(unix)]
use std::fs::Permissions;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
#[cfg(unix)]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};

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
    /// Open with `O_NONBLOCK` alongside `O_NOFOLLOW`: a FIFO (or other object
    /// whose open blocks) fails fast instead of stalling the caller. Regular
    /// files are unaffected — `O_NONBLOCK` is ignored for them.
    pub nonblocking: bool,
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

#[cfg(unix)]
fn current_uid() -> Option<u32> {
    Some(unsafe { libc::getuid() })
}

#[cfg(unix)]
fn is_symbolic_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(unix)]
fn is_root(path: &Path) -> bool {
    path.parent().is_none()
}

#[cfg(unix)]
fn realpath_eq(path: &Path) -> Result<PathBuf, CustodyError> {
    let canonical = fs::canonicalize(path).map_err(|e| {
        CustodyError::new(
            "not-found",
            format!("cannot canonicalize {}: {e}", path.display()),
        )
    })?;
    if canonical.as_path() != path {
        return Err(CustodyError::new(
            "noncanonical",
            format!("{} resolves to {}", path.display(), canonical.display()),
        ));
    }
    Ok(canonical)
}

#[cfg(unix)]
fn identity_of(meta: &fs::Metadata) -> ObjectIdentity {
    ObjectIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
        size: meta.size(),
    }
}

#[cfg(unix)]
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
        return Err(CustodyError::new(
            "kind",
            "not a file, directory, or socket",
        ));
    };
    if actual != kind {
        return Err(CustodyError::new(
            "kind-mismatch",
            format!("expected {kind:?}, found {actual:?}"),
        ));
    }
    Ok(())
}

fn is_socket(_meta: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        _meta.file_type().is_socket()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(unix)]
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

/// Files and sockets default to exactly one hard link; directories carry at
/// least two (`.`, `..`) so they skip the check unless `links` is explicit —
/// the same default the TypeScript twin applies.
fn expected_link_count(links: Option<u64>, kind: Option<ObjectKind>) -> Option<u64> {
    links.or(if matches!(kind, Some(ObjectKind::Directory)) {
        None
    } else {
        Some(1)
    })
}

#[cfg(unix)]
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
        return Err(CustodyError::new(
            "too-long",
            "publish name exceeds 128 bytes",
        ));
    }
    if name.as_bytes().iter().any(|&b| b.is_ascii_whitespace()) {
        return Err(CustodyError::new(
            "whitespace",
            "publish name contains whitespace",
        ));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(CustodyError::new(
            "separator",
            "publish name contains a path separator",
        ));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphanumeric()) {
        return Err(CustodyError::new(
            "initial",
            "publish name must start with alphanumeric",
        ));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') {
        return Err(CustodyError::new(
            "character",
            "publish name has invalid character",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn ensure_canonical_parent(path: &Path) -> Result<(), CustodyError> {
    let parent = path
        .parent()
        .ok_or_else(|| CustodyError::new("root", "path has no parent"))?;
    if parent.as_os_str().is_empty() {
        return Err(CustodyError::new(
            "relative",
            "path is relative without a parent",
        ));
    }
    let resolved = parent
        .canonicalize()
        .map_err(|e| CustodyError::new("not-found", format!("parent {}: {e}", parent.display())))?;
    if resolved != parent {
        return Err(CustodyError::new(
            "noncanonical-parent",
            format!(
                "parent {} resolves to {}",
                parent.display(),
                resolved.display()
            ),
        ));
    }
    Ok(())
}

/// Ensure a private directory exists and satisfies the custody contract.
#[cfg(unix)]
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

    let meta = fs::symlink_metadata(path)
        .map_err(|e| CustodyError::new("stat", format!("cannot lstat {}: {e}", path.display())))?;
    if meta.file_type().is_symlink() {
        return Err(CustodyError::new(
            "symlink",
            format!("{} is a symlink", path.display()),
        ));
    }
    if !meta.is_dir() {
        return Err(CustodyError::new(
            "not-directory",
            format!("{} is not a directory", path.display()),
        ));
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

#[cfg(windows)]
pub fn ensure_private_directory<P: AsRef<Path>>(path: P) -> Result<PrivateDirectory, CustodyError> {
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::CreateDirectoryW;
    let path = path.as_ref();
    if !path.is_absolute() || path.parent().is_none() {
        return Err(CustodyError::new(
            "root",
            "refusing a relative path or filesystem root",
        ));
    }
    reject_windows_stream_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| CustodyError::new("root", "path has no parent"))?;
    validate_windows_ancestor_chain(parent)?;
    if !path.exists() {
        let descriptor = private_windows_security_descriptor(true)?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        let wide = windows_wide_path(path)?;
        if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_ALREADY_EXISTS {
                return Err(CustodyError::new(
                    "create",
                    format!("cannot create {}: Windows error {error}", path.display()),
                ));
            }
        }
    }
    let (file, metadata, snapshot) = windows_path_snapshot(path)?;
    if !metadata.is_dir() {
        return Err(CustodyError::new(
            "not-directory",
            format!("{} is not a directory", path.display()),
        ));
    }
    validate_windows_private_security(&file, true, "owner-only")?;
    Ok(PrivateDirectory {
        path: path.to_path_buf(),
        identity: snapshot.identity,
    })
}

#[cfg(not(any(unix, windows)))]
pub fn ensure_private_directory<P: AsRef<Path>>(
    _path: P,
) -> Result<PrivateDirectory, CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "private-directory custody is not supported on this platform",
    ))
}

/// Validate an owned path according to `OwnedPathOptions`.
#[cfg(unix)]
pub fn assert_owned_path<P: AsRef<Path>>(
    path: P,
    options: &OwnedPathOptions,
) -> Result<ObjectIdentity, CustodyError> {
    let path = path.as_ref();
    if options.canonical {
        realpath_eq(path)?;
    }
    if is_symbolic_link(path) {
        return Err(CustodyError::new(
            "symlink",
            format!("{} is a symlink", path.display()),
        ));
    }
    let meta = fs::symlink_metadata(path)
        .map_err(|e| CustodyError::new("stat", format!("cannot lstat {}: {e}", path.display())))?;
    if meta.file_type().is_symlink() {
        return Err(CustodyError::new(
            "symlink",
            format!("{} is a symlink", path.display()),
        ));
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

    if let Some(expected_links) = expected_link_count(options.links, options.kind) {
        validate_link_count(&meta, expected_links)?;
    }

    Ok(identity_of(&meta))
}

#[cfg(windows)]
#[derive(Clone, Copy, PartialEq, Eq)]
struct WindowsFileSnapshot {
    identity: ObjectIdentity,
    links: u64,
    attributes: u32,
    last_write_time: i64,
    change_time: i64,
}

#[cfg(windows)]
fn validate_windows_mode_options(
    file: &File,
    directory: bool,
    exact_mode: Option<u32>,
    owner_only: bool,
) -> Result<(), CustodyError> {
    if let Some(exact) = exact_mode {
        let supported = if directory { 0o700 } else { 0o600 };
        if exact != supported {
            return Err(CustodyError::new(
                "unsupported",
                format!("Windows custody cannot represent exact mode {exact:04o}"),
            ));
        }
        return validate_windows_private_security(file, directory, "mode-mismatch");
    }
    if owner_only {
        validate_windows_private_security(file, directory, "owner-only")?;
    }
    Ok(())
}

#[cfg(windows)]
fn reject_windows_stream_path(path: &Path) -> Result<(), CustodyError> {
    use std::os::windows::ffi::OsStrExt;
    if path.components().any(|component| {
        matches!(component, std::path::Component::Normal(value) if value.encode_wide().any(|unit| unit == u16::from(b':')))
    }) {
        return Err(CustodyError::new(
            "path",
            "Windows alternate data streams are unsupported",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn windows_wide_path(path: &Path) -> Result<Vec<u16>, CustodyError> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.iter().any(|unit| *unit == 0) {
        return Err(CustodyError::new("path", "Windows path contains NUL"));
    }
    wide.push(0);
    Ok(wide)
}

#[cfg(windows)]
fn validate_windows_ancestor_chain(path: &Path) -> Result<(), CustodyError> {
    let mut ancestors: Vec<&Path> = path.ancestors().collect();
    ancestors.reverse();
    for ancestor in ancestors {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let (_file, metadata, _snapshot) = windows_path_snapshot(ancestor)?;
        if !metadata.is_dir() {
            return Err(CustodyError::new(
                "not-directory",
                format!("{} is not a directory", ancestor.display()),
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
struct WindowsHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for WindowsHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
struct WindowsSecurityDescriptor(windows_sys::Win32::Security::PSECURITY_DESCRIPTOR);

#[cfg(windows)]
impl Drop for WindowsSecurityDescriptor {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::LocalFree(self.0 as _);
        }
    }
}

#[cfg(windows)]
struct WindowsSid {
    storage: Vec<usize>,
}

#[cfg(windows)]
impl WindowsSid {
    fn as_ptr(&self) -> windows_sys::Win32::Security::PSID {
        self.storage.as_ptr() as _
    }
}

#[cfg(windows)]
fn current_windows_user_sid() -> Result<WindowsSid, CustodyError> {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::{
        GetLengthSid, GetTokenInformation, IsValidSid, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(CustodyError::new(
            "owner",
            format!("cannot open current process token: {}", unsafe {
                GetLastError()
            }),
        ));
    }
    let token = WindowsHandle(token);
    let mut bytes = 0u32;
    unsafe {
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut bytes);
    }
    if bytes == 0 || bytes > 64 * 1024 {
        return Err(CustodyError::new(
            "owner",
            "current user token has invalid size",
        ));
    }
    let words = usize::try_from(bytes)
        .ok()
        .and_then(|value| value.checked_add(std::mem::size_of::<usize>() - 1))
        .map(|value| value / std::mem::size_of::<usize>())
        .ok_or_else(|| CustodyError::new("owner", "current user token size overflow"))?;
    let mut buffer = vec![0usize; words];
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        )
    } == 0
    {
        return Err(CustodyError::new(
            "owner",
            format!("cannot inspect current process token: {}", unsafe {
                GetLastError()
            }),
        ));
    }
    let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    if token_user.User.Sid.is_null() || unsafe { IsValidSid(token_user.User.Sid) } == 0 {
        return Err(CustodyError::new("owner", "current user SID is invalid"));
    }
    let sid_bytes = unsafe { GetLengthSid(token_user.User.Sid) };
    if sid_bytes == 0 || sid_bytes > 1024 {
        return Err(CustodyError::new(
            "owner",
            "current user SID has invalid size",
        ));
    }
    let sid_words = usize::try_from(sid_bytes)
        .ok()
        .and_then(|value| value.checked_add(std::mem::size_of::<usize>() - 1))
        .map(|value| value / std::mem::size_of::<usize>())
        .ok_or_else(|| CustodyError::new("owner", "current user SID size overflow"))?;
    let mut storage = vec![0usize; sid_words];
    unsafe {
        std::ptr::copy_nonoverlapping(
            token_user.User.Sid.cast::<u8>(),
            storage.as_mut_ptr().cast::<u8>(),
            sid_bytes as usize,
        );
    }
    Ok(WindowsSid { storage })
}

#[cfg(windows)]
fn windows_sid_string(sid: &WindowsSid) -> Result<String, CustodyError> {
    use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
    let mut text = std::ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid.as_ptr(), &mut text) } == 0 || text.is_null() {
        return Err(CustodyError::new("owner", "cannot encode current user SID"));
    }
    let allocation = WindowsSecurityDescriptor(text.cast());
    let mut length = 0usize;
    while length < 256 && unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err(CustodyError::new(
            "owner",
            "current user SID text is unbounded",
        ));
    }
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) })
        .map_err(|_| CustodyError::new("owner", "current user SID text is invalid"));
    drop(allocation);
    result
}

#[cfg(windows)]
fn private_windows_security_descriptor(
    directory: bool,
) -> Result<WindowsSecurityDescriptor, CustodyError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    let sid = current_windows_user_sid()?;
    let sid_text = windows_sid_string(&sid)?;
    let inheritance = if directory { "OICI" } else { "" };
    let sddl = format!("O:{sid_text}G:{sid_text}D:P(A;{inheritance};FA;;;{sid_text})");
    let wide: Vec<u16> = std::ffi::OsStr::new(&sddl)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        )
    } == 0
        || descriptor.is_null()
    {
        return Err(CustodyError::new(
            "owner-only",
            "cannot build private Windows security descriptor",
        ));
    }
    Ok(WindowsSecurityDescriptor(descriptor))
}

#[cfg(windows)]
fn validate_windows_private_security(
    file: &File,
    directory: bool,
    code: &str,
) -> Result<(), CustodyError> {
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        AclSizeInformation, EqualSid, GetAce, GetAclInformation, GetSecurityDescriptorControl,
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, CONTAINER_INHERIT_ACE,
        DACL_SECURITY_INFORMATION, INHERITED_ACE, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
        PSID, SE_DACL_PRESENT, SE_DACL_PROTECTED,
    };
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;
    use windows_sys::Win32::System::SystemServices::ACCESS_ALLOWED_ACE_TYPE;
    let current = current_windows_user_sid()?;
    let mut owner: PSID = std::ptr::null_mut();
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = std::ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle() as HANDLE,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            &mut dacl,
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS || descriptor.is_null() {
        return Err(CustodyError::new(
            code,
            format!("cannot inspect Windows security descriptor: {status}"),
        ));
    }
    let descriptor = WindowsSecurityDescriptor(descriptor);
    if owner.is_null() || unsafe { EqualSid(owner, current.as_ptr()) } == 0 {
        return Err(CustodyError::new(
            "owner",
            "object is not owned by the current user",
        ));
    }
    if dacl.is_null() {
        return Err(CustodyError::new(code, "object has a null DACL"));
    }
    let mut control = 0u16;
    let mut revision = 0u32;
    if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0
        || control & (SE_DACL_PRESENT | SE_DACL_PROTECTED) != SE_DACL_PRESENT | SE_DACL_PROTECTED
    {
        return Err(CustodyError::new(
            code,
            "object DACL is not present and protected",
        ));
    }
    let mut information = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || information.AceCount != 1
    {
        return Err(CustodyError::new(
            code,
            "object DACL is not an exact single-user ACL",
        ));
    }
    let mut ace_pointer = std::ptr::null_mut();
    if unsafe { GetAce(dacl, 0, &mut ace_pointer) } == 0 || ace_pointer.is_null() {
        return Err(CustodyError::new(
            code,
            "object DACL has no readable owner ACE",
        ));
    }
    let ace = unsafe { &*(ace_pointer as *const ACCESS_ALLOWED_ACE) };
    let expected_flags = if directory {
        (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
    } else {
        0
    };
    let ace_sid = (&ace.SidStart as *const u32).cast_mut().cast();
    if u32::from(ace.Header.AceType) != ACCESS_ALLOWED_ACE_TYPE
        || ace.Header.AceFlags & INHERITED_ACE as u8 != 0
        || ace.Header.AceFlags != expected_flags
        || ace.Mask != FILE_ALL_ACCESS
        || unsafe { EqualSid(ace_sid, current.as_ptr()) } == 0
    {
        return Err(CustodyError::new(
            code,
            "object DACL grants access beyond its owner",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn open_windows_path(path: &Path, read: bool) -> Result<File, CustodyError> {
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, READ_CONTROL,
    };
    reject_windows_stream_path(path)?;
    let mut options = OpenOptions::new();
    if read {
        options.read(true);
    } else {
        options.access_mode(READ_CONTROL);
    }
    options
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|e| CustodyError::new("open", format!("cannot open {}: {e}", path.display())))
}

#[cfg(windows)]
fn windows_file_snapshot(file: &File, path: &Path) -> Result<WindowsFileSnapshot, CustodyError> {
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandle, GetFileInformationByHandleEx,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO,
    };
    let handle = file.as_raw_handle() as HANDLE;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(CustodyError::new(
            "stat",
            format!(
                "cannot inspect {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ),
        ));
    }
    let mut basic = FILE_BASIC_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(CustodyError::new(
            "stat",
            format!(
                "cannot inspect {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ),
        ));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    {
        return Err(CustodyError::new(
            "symlink",
            format!("{} is a reparse point", path.display()),
        ));
    }
    let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
    Ok(WindowsFileSnapshot {
        identity: ObjectIdentity {
            dev: u64::from(information.dwVolumeSerialNumber),
            ino: (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow),
            size,
        },
        links: u64::from(information.nNumberOfLinks),
        attributes: information.dwFileAttributes,
        last_write_time: basic.LastWriteTime,
        change_time: basic.ChangeTime,
    })
}

#[cfg(windows)]
fn windows_path_snapshot(
    path: &Path,
) -> Result<(File, fs::Metadata, WindowsFileSnapshot), CustodyError> {
    let file = open_windows_path(path, false)?;
    let metadata = file.metadata().map_err(|e| {
        CustodyError::new("stat", format!("cannot inspect {}: {e}", path.display()))
    })?;
    let snapshot = windows_file_snapshot(&file, path)?;
    Ok((file, metadata, snapshot))
}

#[cfg(windows)]
pub fn assert_owned_path<P: AsRef<Path>>(
    path: P,
    options: &OwnedPathOptions,
) -> Result<ObjectIdentity, CustodyError> {
    let path = path.as_ref();
    if matches!(options.kind, Some(ObjectKind::Socket)) {
        return Err(CustodyError::new(
            "unsupported",
            "socket custody requires a Unix platform",
        ));
    }
    if options.canonical {
        return Err(CustodyError::new(
            "unsupported",
            "canonical path equality requires Unix path semantics",
        ));
    }
    let (file, metadata, snapshot) = windows_path_snapshot(path)?;
    if let Some(kind) = options.kind {
        validate_kind(&metadata, kind)?;
    }
    validate_windows_mode_options(
        &file,
        metadata.is_dir(),
        options.exact_mode,
        options.owner_only,
    )?;
    let size = snapshot.identity.size;
    if let Some(maximum) = options.maximum_bytes {
        if size > maximum {
            return Err(CustodyError::new(
                "capacity",
                format!("size {size} exceeds maximum {maximum}"),
            ));
        }
    }
    if let Some(minimum) = options.minimum_bytes {
        if size < minimum {
            return Err(CustodyError::new(
                "minimum",
                format!("size {size} below minimum {minimum}"),
            ));
        }
    }
    if let Some(expected) = expected_link_count(options.links, options.kind) {
        if snapshot.links != expected {
            return Err(CustodyError::new(
                "links",
                format!("link count {} != expected {expected}", snapshot.links),
            ));
        }
    }
    Ok(snapshot.identity)
}

#[cfg(not(any(unix, windows)))]
pub fn assert_owned_path<P: AsRef<Path>>(
    _path: P,
    _options: &OwnedPathOptions,
) -> Result<ObjectIdentity, CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "owned-path custody is not supported on this platform",
    ))
}

/// Validate an already-open descriptor against `OwnedPathOptions`.
///
/// `assert_owned_path` resolves and `lstat`s a path; callers holding an open
/// descriptor — for example a constantly-changing WAL sibling whose metadata
/// would never survive a path re-check — instead validate the descriptor
/// itself with `fstat`. Path-bound checks do not apply: an open descriptor
/// cannot be a symbolic link, and `canonical` cannot be proven without a
/// path, so requesting `canonical` fails closed as `unsupported`. Ownership,
/// kind, mode, link-count, and size checks match `assert_owned_path` exactly.
///
/// The descriptor is borrowed, never owned: it is not closed and its flags
/// are not modified. Callers must pass a descriptor that stays open for the
/// duration of the call.
#[cfg(unix)]
pub fn assert_owned_fd(
    fd: std::os::unix::io::RawFd,
    options: &OwnedPathOptions,
) -> Result<ObjectIdentity, CustodyError> {
    use std::os::unix::io::FromRawFd;
    if fd < 0 {
        return Err(CustodyError::new("invalid", "negative descriptor"));
    }
    if options.canonical {
        return Err(CustodyError::new(
            "unsupported",
            "canonical checks require a path; an open descriptor has none",
        ));
    }
    // Duplicate the descriptor (F_DUPFD_CLOEXEC): the `File` owns only the
    // duplicate, so dropping it never closes the caller's descriptor.
    let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if dup < 0 {
        return Err(CustodyError::new(
            "dup",
            format!(
                "cannot duplicate descriptor {fd}: {}",
                std::io::Error::last_os_error()
            ),
        ));
    }
    let file = unsafe { File::from_raw_fd(dup) };
    let meta = file
        .metadata()
        .map_err(|e| CustodyError::new("stat", format!("cannot fstat descriptor {fd}: {e}")))?;
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

    if let Some(expected_links) = expected_link_count(options.links, options.kind) {
        validate_link_count(&meta, expected_links)?;
    }

    Ok(identity_of(&meta))
}

/// Validate an already-open descriptor against `OwnedPathOptions`.
#[cfg(not(unix))]
pub fn assert_owned_fd(
    _fd: i32,
    _options: &OwnedPathOptions,
) -> Result<ObjectIdentity, CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "descriptor custody checks require a Unix platform",
    ))
}

/// Read a regular file with time-of-check/time-of-use guards.
#[cfg(unix)]
pub fn stable_read<P: AsRef<Path>>(
    path: P,
    options: &StableReadOptions,
) -> Result<StableReadResult, CustodyError> {
    let path = path.as_ref();
    if is_symbolic_link(path) {
        return Err(CustodyError::new(
            "symlink",
            format!("{} is a symlink", path.display()),
        ));
    }

    let mut open_flags = libc::O_NOFOLLOW;
    if options.nonblocking {
        open_flags |= libc::O_NONBLOCK;
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(open_flags)
        .open(path)
        .map_err(|e| CustodyError::new("open", format!("cannot open {}: {e}", path.display())))?;

    let before = file
        .metadata()
        .map_err(|e| CustodyError::new("stat", format!("cannot fstat {}: {e}", path.display())))?;

    // Verify the path still resolves to the same object we opened. This catches
    // a replacement that happened immediately after open, before we read.
    let path_before = fs::symlink_metadata(path).map_err(|e| {
        CustodyError::new(
            "stat",
            format!("cannot lstat {} after open: {e}", path.display()),
        )
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
        return Err(CustodyError::new(
            "not-file",
            format!("{} is not a regular file", path.display()),
        ));
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
                format!(
                    "file shrank during read: expected {size}, read {}",
                    bytes.len()
                ),
            ));
        }
        bytes.extend_from_slice(&buf[..n]);
    }

    let after = fs::symlink_metadata(path).map_err(|e| {
        CustodyError::new(
            "stat",
            format!("cannot lstat after read {}: {e}", path.display()),
        )
    })?;
    if after.file_type().is_symlink() {
        return Err(CustodyError::new(
            "symlink",
            format!("{} became a symlink", path.display()),
        ));
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

#[cfg(windows)]
pub fn stable_read<P: AsRef<Path>>(
    path: P,
    options: &StableReadOptions,
) -> Result<StableReadResult, CustodyError> {
    let path = path.as_ref();
    if options.nonblocking {
        return Err(CustodyError::new(
            "unsupported",
            "nonblocking stable reads require Unix open flags",
        ));
    }
    let mut file = open_windows_path(path, true)?;
    let metadata = file.metadata().map_err(|e| {
        CustodyError::new("stat", format!("cannot inspect {}: {e}", path.display()))
    })?;
    let before = windows_file_snapshot(&file, path)?;
    let (_path_file, path_metadata, path_before) = windows_path_snapshot(path)?;
    if before != path_before {
        return Err(CustodyError::new(
            "changed",
            format!("{} changed immediately after it was opened", path.display()),
        ));
    }
    if !metadata.is_file() || !path_metadata.is_file() {
        return Err(CustodyError::new(
            "not-file",
            format!("{} is not a regular file", path.display()),
        ));
    }
    validate_windows_mode_options(&file, false, options.exact_mode, options.owner_only)?;
    let size = before.identity.size;
    if size > options.maximum_bytes {
        return Err(CustodyError::new(
            "capacity",
            format!("size {size} exceeds maximum {}", options.maximum_bytes),
        ));
    }
    if let Some(minimum) = options.minimum_bytes {
        if size < minimum {
            return Err(CustodyError::new(
                "minimum",
                format!("size {size} below minimum {minimum}"),
            ));
        }
    }
    let expected_links = options.links.unwrap_or(1);
    if before.links != expected_links {
        return Err(CustodyError::new(
            "links",
            format!("link count {} != expected {expected_links}", before.links),
        ));
    }
    let size_usize = usize::try_from(size)
        .map_err(|_| CustodyError::new("capacity", "file size exceeds addressable memory"))?;
    let mut bytes = Vec::with_capacity(size_usize);
    let mut buffer = [0u8; 64 * 1024];
    while bytes.len() < size_usize {
        let want = std::cmp::min(buffer.len(), size_usize - bytes.len());
        let read = file.read(&mut buffer[..want]).map_err(|e| {
            CustodyError::new("read", format!("cannot read {}: {e}", path.display()))
        })?;
        if read == 0 {
            return Err(CustodyError::new(
                "shrunk",
                format!(
                    "file shrank during read: expected {size}, read {}",
                    bytes.len()
                ),
            ));
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
    let handle_after = windows_file_snapshot(&file, path)?;
    let (_path_file, path_metadata_after, path_after) = windows_path_snapshot(path)?;
    if !path_metadata_after.is_file() || before != handle_after || before != path_after {
        return Err(CustodyError::new(
            "changed",
            format!("{} changed while it was read", path.display()),
        ));
    }
    Ok(StableReadResult {
        bytes,
        identity: path_after.identity,
    })
}

#[cfg(not(any(unix, windows)))]
pub fn stable_read<P: AsRef<Path>>(
    _path: P,
    _options: &StableReadOptions,
) -> Result<StableReadResult, CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "stable reads are not supported on this platform",
    ))
}

/// The result of a successful [`atomic_publish`]: the published path plus
/// whether this call wrote new content.
#[derive(Debug, Clone)]
pub struct AtomicPublishOutcome {
    pub path: PathBuf,
    /// `false` only when `create_once` found and preserved a pre-existing
    /// target; `true` whenever this call staged and published new content.
    pub created: bool,
}

/// Atomically publish `content` as `name` inside `dir`.
///
/// When `create_once` is false the staged file is `rename(2)`d over the
/// target atomically. When `create_once` is true the commit is a true
/// no-clobber create: the staged file is `link(2)`ed to the target so an
/// existing name fails the commit with `EEXIST` — existence check and commit
/// are one atomic step, closing the check-then-act window a plain
/// `exists()` + `rename()` sequence leaves open. The preserved object is
/// validated and reported with `created: false`.
///
/// Filesystems without hard-link support fall back to an atomic no-clobber
/// rename (`renameat2`/`renameatx_np`) where the platform offers one, then —
/// only where neither primitive exists — to a documented check-then-rename.
pub fn atomic_publish<P: AsRef<Path>>(
    dir: P,
    name: &str,
    content: &[u8],
    create_once: bool,
) -> Result<AtomicPublishOutcome, CustodyError> {
    atomic_publish_inner(dir.as_ref(), name, content, create_once, None)
}

/// [`atomic_publish`] with a commit guard — the seam a digest
/// compare-and-swap needs.
///
/// `guard` runs after the staged file is fully written and fsynced but
/// before it is committed over the target, and it receives the staged
/// temporary path so it can re-verify exactly what is about to be published
/// (the caller knows `dir` and `name`, so the current target stays
/// reachable through the closure). A failed guard aborts the publish and
/// removes the staging file; the target is never touched. This mirrors the
/// TypeScript `beforeCommit` option's timing and abort semantics.
pub fn atomic_publish_guarded<P: AsRef<Path>>(
    dir: P,
    name: &str,
    content: &[u8],
    guard: &dyn Fn(&Path) -> Result<(), CustodyError>,
) -> Result<AtomicPublishOutcome, CustodyError> {
    atomic_publish_inner(dir.as_ref(), name, content, false, Some(guard))
}

/// The commit-guard shape [`atomic_publish_guarded`] accepts.
type PublishGuard<'a> = &'a dyn Fn(&Path) -> Result<(), CustodyError>;

/// Unique staging name: the counter keeps racing publishers inside one
/// process from colliding, the pid keeps concurrent processes apart.
#[cfg(unix)]
static STAGED_NAME_COUNTER: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
fn staged_name(name: &str) -> String {
    let seq = STAGED_NAME_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(".publish-{name}-{}-{seq}", process_id())
}

/// Validate the published object: an owned regular file, mode `0600`, exactly
/// one hard link.
#[cfg(unix)]
fn assert_published_file(target: &Path) -> Result<(), CustodyError> {
    assert_owned_path(
        target,
        &OwnedPathOptions {
            kind: Some(ObjectKind::File),
            exact_mode: Some(0o600),
            links: Some(1),
            ..Default::default()
        },
    )?;
    Ok(())
}

/// Validate a target that already existed under create-once: it must be an
/// owned, owner-only regular file. The link count is deliberately unchecked —
/// a racing publisher's still-linked staging file can transiently raise it.
#[cfg(unix)]
fn assert_existing_publish_target(target: &Path) -> Result<(), CustodyError> {
    if is_symbolic_link(target) {
        return Err(CustodyError::new(
            "symlink",
            format!("{} is a symlink", target.display()),
        ));
    }
    let meta = fs::symlink_metadata(target).map_err(|e| {
        CustodyError::new("stat", format!("cannot lstat {}: {e}", target.display()))
    })?;
    if meta.file_type().is_symlink() {
        return Err(CustodyError::new(
            "symlink",
            format!("{} is a symlink", target.display()),
        ));
    }
    validate_kind(&meta, ObjectKind::File)?;
    validate_owner(&meta)?;
    let mode = meta.mode() & 0o777;
    if mode != 0o600 {
        return Err(CustodyError::new(
            "mode-mismatch",
            format!("mode {mode:04o} != expected 0600"),
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn fsync_directory(dir: &Path) -> Result<(), CustodyError> {
    let dir_file = File::open(dir).map_err(|e| {
        CustodyError::new("dir-open", format!("cannot open directory for fsync: {e}"))
    })?;
    dir_file
        .sync_all()
        .map_err(|e| CustodyError::new("dir-fsync", format!("cannot fsync directory: {e}")))
}

#[cfg(unix)]
fn is_errno(error: &std::io::Error, errno: i32) -> bool {
    error.raw_os_error() == Some(errno)
}

/// Errors a filesystem returns when `link(2)` is unavailable: `EPERM`,
/// `EOPNOTSUPP`, and `ENOTSUP` (distinct on BSDs) cover filesystems that do
/// not implement hard links at all (vfat, some network filesystems),
/// `EXDEV` cross-device links, `ENOSYS` a stubbed syscall.
#[cfg(unix)]
fn hardlink_unsupported(error: &std::io::Error) -> bool {
    is_errno(error, libc::EPERM)
        || is_errno(error, libc::EOPNOTSUPP)
        || is_errno(error, libc::ENOTSUP)
        || is_errno(error, libc::EXDEV)
        || is_errno(error, libc::ENOSYS)
}

/// Commit `tmp_path` to `target` without ever replacing an existing object.
/// Returns `true` when this call created the target, `false` when the target
/// already existed (and was preserved untouched).
#[cfg(unix)]
fn commit_create_once(tmp_path: &Path, target: &Path) -> Result<bool, CustodyError> {
    match fs::hard_link(tmp_path, target) {
        Ok(()) => {
            // The staged name is best-effort cleanup; the target now carries
            // the staged inode and drops to one link once it is removed.
            let _ = fs::remove_file(tmp_path);
            Ok(true)
        }
        Err(e) if is_errno(&e, libc::EEXIST) => {
            let _ = fs::remove_file(tmp_path);
            Ok(false)
        }
        Err(e) if hardlink_unsupported(&e) => rename_noreplace(tmp_path, target),
        Err(e) => {
            let _ = fs::remove_file(tmp_path);
            Err(CustodyError::new(
                "link",
                format!("cannot link staged file to {}: {e}", target.display()),
            ))
        }
    }
}

/// Atomic no-clobber rename for filesystems without hard links: Linux and
/// Android expose `renameat2(RENAME_NOREPLACE)`, Apple platforms expose
/// `renameatx_np(RENAME_EXCL)`. Both keep the staged file absent from the
/// target when a name already exists.
#[cfg(any(target_os = "linux", target_os = "android"))]
fn rename_noreplace(tmp_path: &Path, target: &Path) -> Result<bool, CustodyError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let old = CString::new(tmp_path.as_os_str().as_bytes())
        .map_err(|_| CustodyError::new("path", "staged path contains NUL"))?;
    let new = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| CustodyError::new("path", "target path contains NUL"))?;
    let rc = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            old.as_ptr(),
            libc::AT_FDCWD,
            new.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        return Ok(true);
    }
    rename_noreplace_errno(tmp_path, target, std::io::Error::last_os_error())
}

#[cfg(target_vendor = "apple")]
fn rename_noreplace(tmp_path: &Path, target: &Path) -> Result<bool, CustodyError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let old = CString::new(tmp_path.as_os_str().as_bytes())
        .map_err(|_| CustodyError::new("path", "staged path contains NUL"))?;
    let new = CString::new(target.as_os_str().as_bytes())
        .map_err(|_| CustodyError::new("path", "target path contains NUL"))?;
    let rc = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            old.as_ptr(),
            libc::AT_FDCWD,
            new.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if rc == 0 {
        return Ok(true);
    }
    rename_noreplace_errno(tmp_path, target, std::io::Error::last_os_error())
}

/// Platforms without an atomic no-clobber rename primitive go straight to
/// the documented check-then-rename fallback.
#[cfg(all(
    unix,
    not(any(target_os = "linux", target_os = "android", target_vendor = "apple"))
))]
fn rename_noreplace(tmp_path: &Path, target: &Path) -> Result<bool, CustodyError> {
    fallback_check_then_rename(tmp_path, target)
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_noreplace_errno(
    tmp_path: &Path,
    target: &Path,
    error: std::io::Error,
) -> Result<bool, CustodyError> {
    match error.raw_os_error() {
        Some(libc::EEXIST) => {
            // The staged file was not moved; remove it like a failed link.
            let _ = fs::remove_file(tmp_path);
            Ok(false)
        }
        // Kernel without the syscall/flag support: last resort below.
        Some(libc::ENOSYS) | Some(libc::EINVAL) => fallback_check_then_rename(tmp_path, target),
        _ => {
            let _ = fs::remove_file(tmp_path);
            Err(CustodyError::new(
                "rename",
                format!("cannot no-clobber rename staged file: {error}"),
            ))
        }
    }
}

/// Last resort for filesystems offering neither hard links nor an atomic
/// no-clobber rename: an existence check followed by `rename(2)`. The window
/// between the check and the rename is a documented race — two creators can
/// both observe a missing target and the later rename replaces the earlier
/// one — which is why every supported platform tries `link(2)` first.
#[cfg(unix)]
fn fallback_check_then_rename(tmp_path: &Path, target: &Path) -> Result<bool, CustodyError> {
    if target.exists() {
        let _ = fs::remove_file(tmp_path);
        return Ok(false);
    }
    match fs::rename(tmp_path, target) {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = fs::remove_file(tmp_path);
            Err(CustodyError::new(
                "rename",
                format!("cannot publish staged file: {e}"),
            ))
        }
    }
}

#[cfg(unix)]
fn atomic_publish_inner(
    dir: &Path,
    name: &str,
    content: &[u8],
    create_once: bool,
    guard: Option<PublishGuard<'_>>,
) -> Result<AtomicPublishOutcome, CustodyError> {
    validate_publish_name(name)?;
    ensure_private_directory(dir)?;

    let target = dir.join(name);
    // Fast path: no-clobber cannot succeed against an existing name; skip the
    // staging work entirely. `link(2)` remains the authoritative check.
    if create_once && target.exists() {
        assert_existing_publish_target(&target)?;
        return Ok(AtomicPublishOutcome {
            path: target,
            created: false,
        });
    }

    let tmp_path = dir.join(staged_name(name));

    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp_path)
        .map_err(|e| {
            CustodyError::new("stage", format!("cannot stage {}: {e}", tmp_path.display()))
        })?;

    file.write_all(content).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        CustodyError::new("write", format!("cannot write staged file: {e}"))
    })?;
    file.sync_all().map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        CustodyError::new("fsync", format!("cannot fsync staged file: {e}"))
    })?;
    drop(file);

    // Commit guard seam: runs with the staged file fully durable and before
    // the commit step (link or rename). A failed guard aborts and cleans up.
    if let Some(guard) = guard {
        if let Err(error) = guard(&tmp_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(error);
        }
    }

    if create_once {
        let created = commit_create_once(&tmp_path, &target)?;
        fsync_directory(dir)?;
        if !created {
            assert_existing_publish_target(&target)?;
            return Ok(AtomicPublishOutcome {
                path: target,
                created: false,
            });
        }
        assert_published_file(&target)?;
        return Ok(AtomicPublishOutcome {
            path: target,
            created: true,
        });
    }

    fs::rename(&tmp_path, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        CustodyError::new("rename", format!("cannot publish {name}: {e}"))
    })?;

    fsync_directory(dir)?;
    assert_published_file(&target)?;

    Ok(AtomicPublishOutcome {
        path: target,
        created: true,
    })
}

#[cfg(not(unix))]
fn atomic_publish_inner(
    _dir: &Path,
    _name: &str,
    _content: &[u8],
    _create_once: bool,
    _guard: Option<PublishGuard<'_>>,
) -> Result<AtomicPublishOutcome, CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "atomic publication requires Unix owner and mode semantics",
    ))
}

#[cfg(unix)]
fn process_id() -> u32 {
    unsafe { libc::getpid() as u32 }
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

#[cfg(unix)]
const DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES: usize = 65_536;

/// Read a secret from a descriptor that is known to the caller.
///
/// - Rejects negative descriptors.
/// - Rejects TTYs.
/// - On Unix, the descriptor must refer to a regular file owned by the
///   current user with no group/other access bits.
/// - Reads at most `maximum_bytes` and fails if more data is available.
/// - Returns valid UTF-8 or fails closed.
#[cfg(unix)]
pub fn read_protected_descriptor(
    fd: i32,
    maximum_bytes: Option<usize>,
) -> Result<String, CustodyError> {
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
            return Err(CustodyError::new(
                "stat",
                format!("cannot fstat descriptor {fd}"),
            ));
        }
        if (stat.st_mode & libc::S_IFMT) != libc::S_IFREG {
            return Err(CustodyError::new(
                "kind",
                "descriptor is not a regular file",
            ));
        }
        if let Some(uid) = current_uid() {
            if stat.st_uid != uid {
                return Err(CustodyError::new(
                    "owner",
                    "descriptor is not owned by current user",
                ));
            }
        }
        if stat.st_mode & 0o077 != 0 {
            return Err(CustodyError::new(
                "mode",
                "descriptor allows group/other access",
            ));
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
            return Err(CustodyError::new(
                "read",
                format!("cannot read descriptor {fd}"),
            ));
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
        return Err(CustodyError::new(
            "limit",
            format!("input exceeds {maximum_bytes} bytes"),
        ));
    }
    String::from_utf8(buf).map_err(|e| {
        CustodyError::new(
            "utf8",
            format!("descriptor content is not valid UTF-8: {e}"),
        )
    })
}

#[cfg(not(unix))]
pub fn read_protected_descriptor(
    _fd: i32,
    _maximum_bytes: Option<usize>,
) -> Result<String, CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "protected descriptor input requires Unix descriptor custody semantics",
    ))
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

#[cfg(unix)]
fn control_socket_failure_response(reason: ControlSocketFailureReason) -> serde_json::Value {
    serde_json::json!({"ok": false, "code": reason.to_string()})
}

#[cfg(unix)]
fn validate_socket_path(socket_path: &Path) -> Result<(), CustodyError> {
    let bytes = socket_path.as_os_str().as_encoded_bytes();
    if bytes.len() > MAXIMUM_SOCKET_PATH_BYTES {
        return Err(CustodyError::new(
            "path-too-long",
            format!("socket path exceeds {MAXIMUM_SOCKET_PATH_BYTES} bytes"),
        ));
    }
    let parent = socket_path
        .parent()
        .ok_or_else(|| CustodyError::new("root", "socket path has no parent"))?;
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
        CustodyError::new(
            "bind",
            format!("cannot bind control socket {}: {e}", socket_path.display()),
        )
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
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            || e.kind() == std::io::ErrorKind::TimedOut =>
                    {
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
                    let resp =
                        control_socket_failure_response(ControlSocketFailureReason::Capacity);
                    let _ = writeln!(
                        stream,
                        "{}",
                        serde_json::to_string(&resp).unwrap_or_default()
                    );
                    break;
                }
            }
            if frame.len() > bounds.maximum_frame_bytes {
                break;
            }
            if frame.is_empty() {
                let resp =
                    control_socket_failure_response(ControlSocketFailureReason::InvalidRequest);
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
                break;
            }
            let request: serde_json::Value = match serde_json::from_slice(&frame) {
                Ok(v) => v,
                Err(_) => {
                    let resp =
                        control_socket_failure_response(ControlSocketFailureReason::InvalidRequest);
                    let _ = writeln!(
                        stream,
                        "{}",
                        serde_json::to_string(&resp).unwrap_or_default()
                    );
                    break;
                }
            };
            let response = match handler(request) {
                Ok(v) => v,
                Err(reason) => control_socket_failure_response(reason),
            };
            let response_line = serde_json::to_string(&response).unwrap_or_default();
            if response_line.len() > bounds.maximum_response_bytes {
                let resp =
                    control_socket_failure_response(ControlSocketFailureReason::ResponseLimit);
                let _ = writeln!(
                    stream,
                    "{}",
                    serde_json::to_string(&resp).unwrap_or_default()
                );
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
    let request_line =
        serde_json::to_string(request).map_err(|e| CustodyError::new("encode", format!("{e}")))?;
    if request_line.len() > MAXIMUM_REQUEST_LINE_BYTES {
        return Err(CustodyError::new(
            "request-too-long",
            "request exceeds sanity bound",
        ));
    }
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let mut stream = UnixStream::connect(socket_path).map_err(|e| {
        CustodyError::new(
            "connect",
            format!("cannot connect to {}: {e}", socket_path.display()),
        )
    })?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| CustodyError::new("timeout", format!("{e}")))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| CustodyError::new("timeout", format!("{e}")))?;
    stream
        .write_all(request_line.as_bytes())
        .map_err(|e| CustodyError::new("write", format!("{e}")))?;
    stream
        .write_all(b"\n")
        .map_err(|e| CustodyError::new("write", format!("{e}")))?;
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
            return Err(CustodyError::new(
                "response-limit",
                "response exceeds bound",
            ));
        }
    }
    serde_json::from_slice(&response_line).map_err(|e| CustodyError::new("json", format!("{e}")))
}

#[cfg(not(unix))]
pub fn listen_control_socket<P, H>(
    _socket_path: P,
    _bounds: &ControlSocketBounds,
    _handler: H,
    _running: &AtomicBool,
) -> Result<(), CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "Unix control sockets are not supported on this platform",
    ))
}

#[cfg(not(unix))]
pub fn request_control_socket<P: AsRef<Path>>(
    _socket_path: P,
    _request: &serde_json::Value,
    _maximum_response_bytes: usize,
    _timeout_ms: u64,
) -> Result<serde_json::Value, CustodyError> {
    Err(CustodyError::new(
        "unsupported",
        "Unix control sockets are not supported on this platform",
    ))
}

// Ensure unused File drops do not close borrowed descriptors. Re-export via the
// read functions is sufficient; this trait is not public.
