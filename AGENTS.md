# Contents

- `src/private-paths.ts` owns owner-only path validation: `ensurePrivateDirectory`, `assertOwnedPath`, `readPrivateFile`.
- `src/atomic-publish.ts` owns atomic private file publication.
- `src/control-socket.ts` owns the bounded newline-delimited JSON control socket: server and single-request client.
- `src/protected-input.ts` owns descriptor-based secret input; never argv or environment.
- `src/custody-rust.ts` owns the Rust-sidecar-preferred engine loader: bounded JSON-lines protocol, typed errors, and per-operation TypeScript fallback.
- `src/rust-fallback.ts` owns the bounded, sanitized fallback notices emitted when an engine path falls back to TypeScript.
- `src/artifact-manifest.ts` owns the typed reader for `dist/rust-artifacts/manifest.json`.
- `src/*.test.ts` and `src/*.property.test.ts` own deterministic regressions and arbitrary-input laws.
- `rust/` owns the Rust port: the `local-custody` library (owned-path and owned-descriptor validation, stable reads, link-based create-once and guarded atomic publish), the JSON-lines sidecar binary, and its contract tests.
- The root `Cargo.toml` virtual workspace makes the crate consumable as a cargo git dependency; `Cargo.lock` and all `target/` output resolve at the repository root.
- `spec/custody.md` and `spec/vectors.json` own the portable contract every implementation — TypeScript and Rust — must reproduce.
- `scripts/` owns the ESM build, absolute-root determinism check, canonical portfolio inventory, clean packed-consumer smoke, and Rust sidecar staging plus artifact-manifest generation.
- `.github/workflows/` owns read-only branch validation, checks-gated immutable GitHub Release automation, and the tag-only `npm-release` environment's OIDC trusted-publishing mirror.
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

<!-- hraness-public-copy:start -->
- Public copy (websites, READMEs, docs, package and GitHub descriptions, CLI help, `llms.txt`, generated pages) follows `STYLE.md`, synced from hraness/.github. Text a model writes for publication also follows `GENERATION_STYLE.md`.
- The delivery vocabulary in this file (admission, qualification, custody, receipt, bounded, lane, gate, surface, projection) is internal. Translate it into what the reader gets.
- Take one-line product and sibling descriptions from the portfolio registry and versions from the release record. Tests pin facts, not prose.
- Run `bun run check:copy` before handoff when the repository has it.
<!-- hraness-public-copy:end -->

<!-- oompa-local-efficiency:start -->
- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the gates applicable to that action pass. Do not ask for duplicate confirmation. Build confidence through relevant automated checks, bounded diagnostics, and independent review, not another human approval. Passing checks does not expand task scope or authority.
- Prefer agentic service provisioning for new infrastructure. Check Vercel Marketplace for a native product that can provision the required resource first; use Stripe Projects as a supported alternative when it better covers the service or the Marketplace route only connects an existing account. Verify the current catalog, account, region, plan, recurring cost and resource capabilities before selecting a route. Prefer supported provider CLIs or APIs over browser-only setup when neither catalog fits, and explain the concrete exception. Reuse existing owner-controlled resources where appropriate; this preference alone does not authorize migrations, duplicate accounts, paid upgrades or wider access. Continue setup already authorized by the task and budget without duplicate confirmation. Keep provider credentials and generated environment files private, complete required interactive authentication, and verify deployment, persistence and recovery separately from successful provisioning.
- Separate artifact admission from live qualification and operational activation. Use applicable automated source, security, package/install, and provenance evidence for artifact admission; live provider qualification is not a universal publication prerequisite. Preserve explicit live acceptance criteria and require relevant live evidence for claims that depend on it. If publication or an artifact's install, upgrade, or default-use path activates risky unqualified behavior, keep that behavior guarded or disabled, or obtain bounded relevant evidence before shipping or activation.
- Use the repository's documented delivery workflow and preserve the identity, target, capacity, migration, and recovery guards applicable to operational activation. Replace an obsolete gate through a reviewed source and policy change with corresponding tests, never an ad hoc skip. Preserve every runtime-enforced approval, access control, branch protection, environment rule, safety policy, and required final gate. Ask for user input only when delivery needs a material product decision, missing credentials or authority, unavoidable interactive authentication, an irreversibly destructive action outside task scope, or resolution of a failure that cannot be handled safely and autonomously.
- Preserve production and user data throughout delivery. Inspect the exact account, environment, deployment, and data target before writes. For data changes, inspect a dry run or equivalent migration plan and validate the recovery path before any effect that could lose or corrupt data. Prefer additive, backward-compatible migrations and bounded batches. Record mutation intent, use idempotency or conditional writes, and reconcile uncertain results before retrying. Verify deployed identity, health, and relevant data invariants after delivery. Routine delivery never authorizes resetting, truncating, dropping, or overwriting user data; stop the unsafe operation if preservation or recovery cannot be established.
- Prefer short-lived repository workload identities such as OIDC trusted publishing, GitHub Apps, and narrowly scoped machine identities. Use unattended stable publication and production promotion when supported by the provider and repository. Establish supported machine authority once and verify it with a non-publishing preflight where available; routine releases should not require recurring interactive authentication or conversational approval. Retain account two-factor authentication and provider controls, including required authentication for approval of an exact staged artifact; do not add long-lived personal tokens to eliminate an interactive prompt.
- Keep delivery gates proportional to the failure they prevent. Prefer required checks on the current integration candidate, independent agent review, and atomic or conditional integration. Add a merge queue or another approval stage only for a demonstrated coordination or safety need. Replace redundant queues, serial waits, and duplicate checks through reviewed policy changes while retaining evidence for the integrated result.
- Preserve useful reasoning fan-out, but avoid unnecessary checkout fan-out. Prefer subagents in the current task for bounded research, review, diagnosis, and focused checks when they can safely share one working tree; create a separate task or worktree only for independently deliverable divergent edits, an isolated verification tree, or a different execution environment.
- Give each expensive focused validation command and external wait one owner. The integration owner reviews that evidence and runs the repository-required aggregate or final gate once after convergence. Reuse evidence only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and validity period, and never to skip a required final integration, merge, release, deployment, or production-verification gate.
- On Hraness development machines, use `$oompa-local-efficiency` and the installed host scheduler for heavyweight top-level commands when available. Keep ordinary work in the compute lane; give authenticated browser/dev-server/Chromium work one `browser-auth` owner and Mac-only validation one `mac-native` owner.
- When a CI or policy gate scans complete Git history, check out the exact governed SHA and fetch only the fully qualified governed refs before scanning. Preserve the complete-history gate and reject unexpected refs instead of importing unrelated concurrent heads.
- At closeout, record applicable branch, PR, check, merge, release, deployment, and production evidence. Archive only conclusively finished tasks, never from silence alone, and reclaim only freshly revalidated clean merged worktrees through the guarded exact-path flow.
<!-- oompa-local-efficiency:end -->

<!-- algal-skills:start -->
## ALGAL skills

- Prefer the globally installed `algal-*` skills for bounded git state, diffs, repository survey/search, test and release gates, CI polling, and web fetches instead of repeated raw tool output.
- At session start, if the `algal` skill is unavailable, install the current skill pack for Claude Code, Codex, and Devin for Terminal with `bunx skills add 0thernet/algal-skills --global --agent claude-code codex devin --skill '*' --copy --yes`.
- Confirm installation with `bunx skills list --global`. If Bun or network access is unavailable, continue with repository-native tools instead of blocking delivery.
- Treat ALGAL receipts as execution evidence, not provider attestation, and preserve the repository's normal verification and release gates.
<!-- algal-skills:end -->
