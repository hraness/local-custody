import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ControlSocketError, requestControlSocket } from "./control-socket.ts";
import { CUSTODY_ERROR_CODES, CUSTODY_ERROR_COPY, describeCustodyError } from "./describe.ts";
import { PROTECTED_INPUT_TERMINAL_MESSAGE, ProtectedInputError } from "./protected-input.ts";

const names = { product: "Textbutler", command: "textbutler" } as const;

describe("describeCustodyError", () => {
  test("a missing background service names the start command", () => {
    const error = new ControlSocketError("control-unavailable", "The control socket is unavailable.");
    expect(describeCustodyError(error, { ...names, startCommand: "textbutler daemon start" })).toEqual({
      problem: "service-not-running",
      message: "Textbutler's background service isn't running.",
      next: "textbutler daemon start",
    });
    expect(describeCustodyError(error, names).next).toBe("textbutler doctor");
    expect(describeCustodyError(new ControlSocketError("control-closed", "x"), names).problem).toBe("service-not-running");
    expect(describeCustodyError(new ControlSocketError("control-timeout", "x"), names)).toEqual({
      problem: "service-timeout",
      message: "Textbutler's background service didn't answer in time.",
      next: "textbutler doctor",
    });
  });

  test("terminal input points at a pipe or a file", () => {
    const error = new ProtectedInputError("protected-terminal", PROTECTED_INPUT_TERMINAL_MESSAGE);
    expect(describeCustodyError(error, { product: "Ghostget", command: "ghostget", inputCommand: "ghostget login --stdin" })).toEqual({
      problem: "terminal-input",
      message: "Ghostget doesn't read this value from typing, so it stays out of your terminal history.",
      next: "Pipe or redirect the value into ghostget login --stdin.",
    });
    expect(describeCustodyError("tty", { ...names, inputExample: "pbpaste | textbutler pair --stdin" }).next).toBe("pbpaste | textbutler pair --stdin");
    expect(describeCustodyError("tty", names).next).toBe("Pipe or redirect the value into textbutler.");
  });

  test("generic Rust codes follow what the product was doing", () => {
    expect(describeCustodyError("connect", names).problem).toBe("service-not-running");
    expect(describeCustodyError({ code: "not-found" }, { ...names, during: "control" }).problem).toBe("service-not-running");
    expect(describeCustodyError("read", { ...names, during: "control" }).problem).toBe("service-timeout");
    expect(describeCustodyError("json", { ...names, during: "control" }).problem).toBe("service-unexpected");
    expect(describeCustodyError("not-found", names).problem).toBe("files-unavailable");
    expect(describeCustodyError("limit", { ...names, during: "input" }).problem).toBe("input-too-large");
  });

  test("unsafe files never suggest deleting anything", () => {
    for (const error of [new Error("Unsafe local directory."), new Error("Directory must be physical, owned, and private."), "owner", "mode-mismatch",
      new ProtectedInputError("protected-unsafe-file", "Protected input file must be owned and private.")]) {
      const description = describeCustodyError(error, names);
      expect(description.problem).toBe("unsafe-permissions");
      expect(`${description.message} ${description.next}`).not.toMatch(/delete|remove|rm /iu);
    }
  });

  test("sidecar, size, change and unknown failures", () => {
    const sidecar = Object.assign(new Error("missing"), { name: "CustodySidecarNotFoundError" });
    expect(describeCustodyError(sidecar, names).problem).toBe("helper-unavailable");
    expect(describeCustodyError({ name: "CustodyError", code: "capacity", message: "x" }, names).problem).toBe("input-too-large");
    expect(describeCustodyError(new Error("Private file changed during the read."), names).problem).toBe("files-changed");
    expect(describeCustodyError(new Error("boom /Users/me/secret"), names)).toEqual({
      problem: "unexpected",
      message: "Textbutler hit an unexpected problem with its private files.",
      next: "textbutler doctor",
    });
    expect(describeCustodyError(undefined, names).problem).toBe("unexpected");
  });

  test("names are stripped of control characters and cannot inject placeholders", () => {
    const text = describeCustodyError("owner", { product: "Evil\u001b[31m{command}", command: "evil" });
    expect(text.message).toBe("Evil [31m{command} stopped because its private files can be read by other users or aren't owned by you.");
  });

  test("every mapped code has copy, and copy never shows internals", () => {
    for (const problem of Object.values(CUSTODY_ERROR_CODES)) expect(CUSTODY_ERROR_COPY[problem]).toBeDefined();
    for (const { message, next } of Object.values(CUSTODY_ERROR_COPY)) {
      expect(`${message} ${next}`).not.toMatch(/socket|descriptor|custody|sidecar|fsync|errno/iu);
      expect(message.endsWith(".")).toBe(true);
    }
  });
});

describe("control socket error codes", () => {
  test("no socket file reads as a stopped service, not a raw ENOENT", async () => {
    const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "lc-describe-"));
    try {
      const error = await requestControlSocket({
        socketPath: join(directory, "missing.sock"), request: {}, maximumResponseBytes: 64, timeoutMs: 1_000, parseResponse: value => value,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ControlSocketError);
      expect((error as ControlSocketError).code).toBe("control-unavailable");
      expect((error as Error).message).toBe("The control socket is unavailable.");
      expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect(describeCustodyError(error, names).problem).toBe("service-not-running");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("protected input terminal message", () => {
  test("says what to do instead", () => {
    expect(PROTECTED_INPUT_TERMINAL_MESSAGE).toBe(
      "Pipe or redirect the value in instead of typing it, so it stays out of your terminal history.",
    );
  });
});
