import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";

import {
  conflictAdmissionMode,
  setConflictAdmissionMode,
} from "../../src/storage/v2.ts";

describe("conflictAdmissionMode()", () => {
  afterEach(() => setConflictAdmissionMode(undefined));

  it("returns `preempt` for each spelling of it the environment may hold", () => {
    for (const value of ["preempt", "1", "true"]) {
      expect(conflictAdmissionMode(() => value)).toBe("preempt");
    }
  });

  it("returns `off` for an environment naming no mode or another one", () => {
    for (const value of [undefined, "", "0", "false", "hold"]) {
      expect(conflictAdmissionMode(() => value)).toBe("off");
    }
  });

  it("reads the mode from `CF_CONFLICT_ADMISSION`", () => {
    const read: string[] = [];
    conflictAdmissionMode((name) => {
      read.push(name);
      return undefined;
    });
    expect(read).toEqual(["CF_CONFLICT_ADMISSION"]);
  });

  it("returns `off` where the environment cannot be read", () => {
    expect(
      conflictAdmissionMode(() => {
        throw new Deno.errors.NotCapable("env access denied");
      }),
    ).toBe("off");
  });

  it("returns the override in place of the environment's mode", () => {
    setConflictAdmissionMode("off");
    expect(conflictAdmissionMode(() => "preempt")).toBe("off");
    setConflictAdmissionMode("preempt");
    expect(conflictAdmissionMode(() => undefined)).toBe("preempt");
  });
});
