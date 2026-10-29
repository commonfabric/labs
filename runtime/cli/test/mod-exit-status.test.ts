import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { main } from "../mod.ts";

/**
 * How the entry point ends the process. A command that reports a failure
 * without throwing leaves its code in `Deno.exitCode` (`piece setsrc` does
 * this when the source committed but the running refresh failed); the entry
 * must end with that code rather than an unconditional 0. This is pinned at
 * the entry because the command-level tests inject their exit seam and so
 * could not see an entry that discarded it — which is exactly what
 * `Deno.exit(0)` did.
 */
describe("cli entry exit status", () => {
  it("ends with the code a command left in Deno.exitCode", async () => {
    const exits: number[] = [];
    await main([], {
      parse: () => {
        exits.push(-1);
        return Promise.resolve();
      },
      exitCode: () => 1,
      exit: (code) => {
        exits.push(code);
      },
    });
    expect(exits).toEqual([-1, 1]);
  });

  it("ends 0 when the command left the default", async () => {
    const exits: number[] = [];
    await main([], {
      parse: () => Promise.resolve(),
      exitCode: () => 0,
      exit: (code) => {
        exits.push(code);
      },
    });
    expect(exits).toEqual([0]);
  });

  it("reads the real Deno.exitCode by default", async () => {
    const exits: number[] = [];
    const original = Deno.exitCode;
    try {
      await main([], {
        parse: () => {
          Deno.exitCode = 1;
          return Promise.resolve();
        },
        exit: (code) => {
          exits.push(code);
        },
      });
    } finally {
      Deno.exitCode = original;
    }
    expect(exits).toEqual([1]);
  });

  it("ends 1 on a thrown command error", async () => {
    const exits: number[] = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      await main([], {
        parse: () => Promise.reject(new Error("boom")),
        exitCode: () => 0,
        exit: (code) => {
          exits.push(code);
        },
      });
    } finally {
      console.error = originalError;
    }
    expect(exits).toEqual([1]);
  });
});
