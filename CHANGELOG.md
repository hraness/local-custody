# Changelog

## Unreleased

- Make the temporary signing certificate chain discoverable and pass literal
  code requirements to macOS when signing and verifying native helpers.

- Sign and notarize both Mac helpers with a stable Apple Developer ID. Verify
  the default helper before native execution and preserve the existing safe
  TypeScript fallback and explicit development paths.
- Publish the same validated npm package bytes to GitHub and npm.
