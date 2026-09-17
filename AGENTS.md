# Contents

- `src/private-paths.ts` owns owner-only path validation: `ensurePrivateDirectory`, `assertOwnedPath`, `readPrivateFile`.
- `src/atomic-publish.ts` owns atomic private file publication.
- `src/control-socket.ts` owns the bounded newline-delimited JSON control socket: server and single-request client.
- `src/protected-input.ts` owns descriptor-based secret input; never argv or environment.
- `src/*.test.ts` and `src/*.property.test.ts` own deterministic regressions and arbitrary-input laws.
- `spec/custody.md` and `spec/vectors.json` own the portable contract every implementation (including a future Rust port) must reproduce.
- `scripts/` owns the ESM build, absolute-root determinism check, canonical portfolio inventory, and clean packed-consumer smoke.
- `.github/workflows/` owns read-only branch validation and checks-gated immutable GitHub Release automation.
- `package.json`, `portfolio-inventory.json`, `tsconfig.json`, `eslint.config.mjs`, and `bun.lock` own standalone package, portfolio, and verification configuration.

# Guidelines

- Use Bun 1.3.14. Keep the package source-first, ESM-only, dependency-free at runtime, and independently buildable without workspace protocols or private packages.
- Keep every API product-neutral: no product names, commands, daemons, or domain semantics. Products own request schemas, response envelopes, and failure payloads; this package owns transport and custody mechanics only.
- Fail closed on every boundary: unknown JSON stays `unknown`, symbolic links always reject, owner/mode/link checks are exact, and transport errors never expose internals.
- Keep secrets out of argv, environment, logs, and response bodies. Protected input comes only from open descriptors.
- Bound every input: frame bytes, request counts, connections, timeouts, file sizes, and socket path length.
- Add a readable deterministic test for every behavior change and a property test for every parser, round trip, ordering law, or arbitrary-input invariant. Extend `spec/vectors.json` whenever the contract changes.
- Deliver changes to `main` through a current-head pull request with `Required` green. Never force-push.
- Pin Hraness dependencies to reviewed immutable releases or full commits. Never connect repositories through sibling paths, Git submodules, or coordinated `main` assumptions.
- Keep released behavior stable; the checked `dist/` output is the consumed artifact. Run `bun run check` before handoff and keep generated output in sync.
- Bump `package.json` version and tag `v*` for releases; tags are immutable and the release workflow re-verifies the full gate.
- Treat this repository as the complete public project. Public files may refer only to its public package, paths, commands, and contract values.
