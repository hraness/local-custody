/**
 * Plain-language explanations for custody, protected-input and control-socket
 * failures, so every product says the same thing and gives one next step
 * instead of printing an internal error. The table below is the source of
 * truth; `bun run generate:error-copy` writes `rust/src/error-copy.json`,
 * which the Rust crate's `describe_error` reads, and a test keeps them equal.
 */

/** What went wrong, in terms a person can act on. */
export type CustodyProblem =
  | "service-not-running"
  | "service-timeout"
  | "service-unexpected"
  | "terminal-input"
  | "unsafe-permissions"
  | "input-too-large"
  | "files-changed"
  | "files-unavailable"
  | "helper-unavailable"
  | "unexpected";

export type CustodyDescription = Readonly<{
  problem: CustodyProblem;
  /** One sentence: what happened. */
  message: string;
  /** One thing to do next: a command or a short instruction. */
  next: string;
}>;

export type DescribeCustodyOptions = Readonly<{
  /** The product's display name, such as `Textbutler`. */
  product: string;
  /** The product's command, such as `textbutler`. `{command} doctor` is the default next step. */
  command: string;
  /** How to start the product's background service, when it has one, such as `textbutler daemon start`. */
  startCommand?: string;
  /** The full command that reads protected input, such as `ghostget login --stdin`. */
  inputCommand?: string;
}>;

/**
 * Copy per problem. Placeholders: `{product}`, `{command}`, `{startCommand}`
 * (defaults to `{command} doctor`), `{inputCommand}` (defaults to
 * `{command} …`).
 */
export const CUSTODY_ERROR_COPY: Readonly<Record<CustodyProblem, Readonly<{ message: string; next: string }>>> = Object.freeze({
  "service-not-running": Object.freeze({
    message: "{product}'s background service isn't running.",
    next: "{startCommand}",
  }),
  "service-timeout": Object.freeze({
    message: "{product}'s background service didn't answer in time.",
    next: "{command} doctor",
  }),
  "service-unexpected": Object.freeze({
    message: "{product}'s background service sent an answer {product} didn't expect.",
    next: "{command} doctor",
  }),
  "terminal-input": Object.freeze({
    message: "{product} reads this value from a pipe, not from typing, so it stays out of your terminal history.",
    next: "pbpaste | {inputCommand}",
  }),
  "unsafe-permissions": Object.freeze({
    message: "{product} stopped because its private files can be read by other users or aren't owned by you.",
    next: "{command} doctor",
  }),
  "input-too-large": Object.freeze({
    message: "The value is larger than {product} accepts.",
    next: "Check that you copied only the value, then try again.",
  }),
  "files-changed": Object.freeze({
    message: "{product}'s private files changed while it was reading them.",
    next: "Try again in a moment.",
  }),
  "files-unavailable": Object.freeze({
    message: "{product} couldn't read or save its private files.",
    next: "{command} doctor",
  }),
  "helper-unavailable": Object.freeze({
    message: "{product}'s file helper is missing or didn't respond.",
    next: "{command} doctor",
  }),
  unexpected: Object.freeze({
    message: "{product} hit an unexpected problem with its private files.",
    next: "{command} doctor",
  }),
});

/** Custody error codes (Rust `CustodyError.code`, sidecar `code`, typed JS errors) → problem. */
export const CUSTODY_ERROR_CODES: Readonly<Record<string, CustodyProblem>> = Object.freeze({
  // control socket
  "control-unavailable": "service-not-running",
  "control-closed": "service-not-running",
  "control-timeout": "service-timeout",
  "control-invalid-response": "service-unexpected",
  "control-response-too-large": "service-unexpected",
  "control-extra-output": "service-unexpected",
  "control-identity-changed": "service-unexpected",
  // protected input
  tty: "terminal-input",
  "protected-terminal": "terminal-input",
  "protected-unsafe-file": "unsafe-permissions",
  "protected-too-large": "input-too-large",
  // path custody
  owner: "unsafe-permissions",
  mode: "unsafe-permissions",
  "mode-mismatch": "unsafe-permissions",
  kind: "unsafe-permissions",
  path: "unsafe-permissions",
  root: "unsafe-permissions",
  separator: "unsafe-permissions",
  capacity: "input-too-large",
  changed: "files-changed",
  "not-found": "files-unavailable",
  stat: "files-unavailable",
  open: "files-unavailable",
  read: "files-unavailable",
  write: "files-unavailable",
  create: "files-unavailable",
  chmod: "files-unavailable",
  stage: "files-unavailable",
  rename: "files-unavailable",
  fsync: "files-unavailable",
  "dir-open": "files-unavailable",
  "dir-fsync": "files-unavailable",
  // sidecar transport
  "sidecar-not-found": "helper-unavailable",
  "sidecar-timeout": "helper-unavailable",
  "sidecar-protocol": "helper-unavailable",
});

/** Fixed messages from this package's plain `Error`s → problem. */
const MESSAGES: Readonly<Record<string, CustodyProblem>> = Object.freeze({
  "Directory must be physical, owned, and private.": "unsafe-permissions",
  "Directory parent must be physical.": "unsafe-permissions",
  "Unsafe private file.": "unsafe-permissions",
  "Unsafe local directory.": "unsafe-permissions",
  "Unsafe local file.": "unsafe-permissions",
  "Unsafe local socket.": "unsafe-permissions",
  "Private file changed during the read.": "files-changed",
  "Private file exceeds its size bound.": "input-too-large",
});

const SIDECAR_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  CustodySidecarNotFoundError: "sidecar-not-found",
  CustodySidecarTimeoutError: "sidecar-timeout",
  CustodySidecarProtocolError: "sidecar-protocol",
});

function problemOf(error: unknown): CustodyProblem {
  if (typeof error === "string") return CUSTODY_ERROR_CODES[error] ?? "unexpected";
  if (error === null || typeof error !== "object") return "unexpected";
  const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof name === "string" && Object.hasOwn(SIDECAR_ERRORS, name)) return CUSTODY_ERROR_CODES[SIDECAR_ERRORS[name]!]!;
  if (typeof code === "string" && Object.hasOwn(CUSTODY_ERROR_CODES, code)) return CUSTODY_ERROR_CODES[code]!;
  if (typeof message === "string" && Object.hasOwn(MESSAGES, message)) return MESSAGES[message]!;
  return "unexpected";
}

function plain(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200);
}

/**
 * Explain a custody failure in one sentence plus one next step. Accepts an
 * error thrown by this package (plain, typed or sidecar), a custody error
 * code string, or anything else (described as unexpected). Internal details,
 * paths and codes never appear in the text; keep them for `--json` and
 * `--debug` output.
 */
export function describeCustodyError(error: unknown, options: DescribeCustodyOptions): CustodyDescription {
  const problem = problemOf(error);
  const product = plain(options.product);
  const command = plain(options.command);
  const values: Readonly<Record<string, string>> = {
    product,
    command,
    startCommand: options.startCommand === undefined ? `${command} doctor` : plain(options.startCommand),
    inputCommand: options.inputCommand === undefined ? `${command} …` : plain(options.inputCommand),
  };
  const fill = (template: string) => template.replace(/\{(product|command|startCommand|inputCommand)\}/gu, (_, key: string) => values[key]!);
  const copy = CUSTODY_ERROR_COPY[problem];
  return Object.freeze({ problem, message: fill(copy.message), next: fill(copy.next) });
}
