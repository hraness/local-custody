import {
  createPrivateFileOnce,
  createPrivateFileOnceSync,
  publishPrivateFile
} from "./chunk-605s349d.js";
import {
  ControlSocketError,
  MAXIMUM_SOCKET_PATH_BYTES,
  attachControlSocket,
  listenControlSocket,
  requestControlSocket
} from "./chunk-k2mgjyx4.js";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  assertOwnedPath,
  assertOwnedPathSync,
  ensurePrivateDirectory,
  readOwnedFileStable,
  readOwnedFileStableSync,
  readPrivateFile
} from "./chunk-xrgz1k0h.js";
import {
  DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES,
  PROTECTED_INPUT_TERMINAL_MESSAGE,
  ProtectedInputError,
  readProtectedDescriptor,
  readProtectedStdin
} from "./chunk-8gyk2127.js";
// src/describe.ts
var CUSTODY_ERROR_COPY = Object.freeze({
  "service-not-running": Object.freeze({
    message: "{product}'s background service isn't running.",
    next: "{startCommand}"
  }),
  "service-timeout": Object.freeze({
    message: "{product}'s background service didn't answer in time.",
    next: "{command} doctor"
  }),
  "service-unexpected": Object.freeze({
    message: "{product}'s background service sent an answer {product} didn't expect.",
    next: "{command} doctor"
  }),
  "terminal-input": Object.freeze({
    message: "{product} doesn't read this value from typing, so it stays out of your terminal history.",
    next: "{inputExample}"
  }),
  "unsafe-permissions": Object.freeze({
    message: "{product} stopped because its private files can be read by other users or aren't owned by you.",
    next: "{command} doctor"
  }),
  "input-too-large": Object.freeze({
    message: "The value is larger than {product} accepts.",
    next: "Check that you copied only the value, then try again."
  }),
  "files-changed": Object.freeze({
    message: "{product}'s private files changed while it was reading them.",
    next: "Try again in a moment."
  }),
  "files-unavailable": Object.freeze({
    message: "{product} couldn't read or save its private files.",
    next: "{command} doctor"
  }),
  "helper-unavailable": Object.freeze({
    message: "{product}'s file helper is missing or didn't respond.",
    next: "{command} doctor"
  }),
  unexpected: Object.freeze({
    message: "{product} hit an unexpected problem with its private files.",
    next: "{command} doctor"
  })
});
var CUSTODY_ERROR_CODES = Object.freeze({
  "control-unavailable": "service-not-running",
  "control-closed": "service-not-running",
  "control-timeout": "service-timeout",
  "control-invalid-response": "service-unexpected",
  "control-response-too-large": "service-unexpected",
  "control-extra-output": "service-unexpected",
  "control-identity-changed": "service-unexpected",
  connect: "service-not-running",
  "response-limit": "service-unexpected",
  tty: "terminal-input",
  "protected-terminal": "terminal-input",
  "protected-unsafe-file": "unsafe-permissions",
  "protected-too-large": "input-too-large",
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
  "sidecar-not-found": "helper-unavailable",
  "sidecar-timeout": "helper-unavailable",
  "sidecar-protocol": "helper-unavailable"
});
var CUSTODY_ACTIVITY_CODES = Object.freeze({
  control: Object.freeze({
    "not-found": "service-not-running",
    stat: "service-not-running",
    write: "service-not-running",
    read: "service-timeout",
    timeout: "service-timeout",
    json: "service-unexpected"
  }),
  input: Object.freeze({
    limit: "input-too-large",
    capacity: "input-too-large"
  }),
  files: Object.freeze({})
});
var MESSAGES = Object.freeze({
  "Directory must be physical, owned, and private.": "unsafe-permissions",
  "Directory parent must be physical.": "unsafe-permissions",
  "Unsafe private file.": "unsafe-permissions",
  "Unsafe local directory.": "unsafe-permissions",
  "Unsafe local file.": "unsafe-permissions",
  "Unsafe local socket.": "unsafe-permissions",
  "Private file changed during the read.": "files-changed",
  "Private file exceeds its size bound.": "input-too-large"
});
var SIDECAR_ERRORS = Object.freeze({
  CustodySidecarNotFoundError: "sidecar-not-found",
  CustodySidecarTimeoutError: "sidecar-timeout",
  CustodySidecarProtocolError: "sidecar-protocol"
});
function problemOfCode(code, during) {
  const contextual = during === undefined ? undefined : CUSTODY_ACTIVITY_CODES[during];
  if (contextual !== undefined && Object.hasOwn(contextual, code))
    return contextual[code];
  return Object.hasOwn(CUSTODY_ERROR_CODES, code) ? CUSTODY_ERROR_CODES[code] : undefined;
}
function problemOf(error, during) {
  if (typeof error === "string")
    return problemOfCode(error, during) ?? "unexpected";
  if (error === null || typeof error !== "object")
    return "unexpected";
  const { code, name, message } = error;
  if (typeof name === "string" && Object.hasOwn(SIDECAR_ERRORS, name))
    return CUSTODY_ERROR_CODES[SIDECAR_ERRORS[name]];
  if (typeof code === "string") {
    const problem = problemOfCode(code, during);
    if (problem !== undefined)
      return problem;
  }
  if (typeof message === "string" && Object.hasOwn(MESSAGES, message))
    return MESSAGES[message];
  return "unexpected";
}
function plain(value) {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 200);
}
function describeCustodyError(error, options) {
  const problem = problemOf(error, options.during);
  const product = plain(options.product);
  const command = plain(options.command);
  const inputCommand = options.inputCommand === undefined ? command : plain(options.inputCommand);
  const values = {
    product,
    command,
    startCommand: options.startCommand === undefined ? `${command} doctor` : plain(options.startCommand),
    inputExample: options.inputExample === undefined ? `Pipe or redirect the value into ${inputCommand}.` : plain(options.inputExample)
  };
  const fill = (template) => template.replace(/\{(product|command|startCommand|inputExample)\}/gu, (_, key) => values[key]);
  const copy = CUSTODY_ERROR_COPY[problem];
  return Object.freeze({ problem, message: fill(copy.message), next: fill(copy.next) });
}
export {
  requestControlSocket,
  readProtectedStdin,
  readProtectedDescriptor,
  readPrivateFile,
  readOwnedFileStableSync,
  readOwnedFileStable,
  publishPrivateFile,
  listenControlSocket,
  ensurePrivateDirectory,
  describeCustodyError,
  createPrivateFileOnceSync,
  createPrivateFileOnce,
  attachControlSocket,
  assertOwnedPathSync,
  assertOwnedPath,
  ProtectedInputError,
  PROTECTED_INPUT_TERMINAL_MESSAGE,
  PRIVATE_FILE_MODE,
  PRIVATE_DIRECTORY_MODE,
  MAXIMUM_SOCKET_PATH_BYTES,
  DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES,
  ControlSocketError,
  CUSTODY_ERROR_COPY,
  CUSTODY_ERROR_CODES,
  CUSTODY_ACTIVITY_CODES
};
