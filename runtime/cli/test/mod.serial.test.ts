import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { main } from "../mod.ts";

describe("main()", () => {
  // `main` reports a thrown failure through `console.error`, which each case
  // reads, and otherwise ends the process with the code a command left in
  // `Deno.exitCode`, which is where a command reports a failure it does not
  // throw.

  let error: typeof console.error;
  let printed: string[];

  beforeEach(() => {
    error = console.error;
    printed = [];
    console.error = (...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.error = error;
  });

  it("prints a command's failure on stderr, then exits 1", async () => {
    const exits: number[] = [];

    await main(["piece", "inspect"], {
      parse: () => Promise.reject(new Error("boom")),
      exitCode: () => 0,
      exit: (code) => {
        exits.push(code);
      },
    });

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("boom");
    expect(exits).toEqual([1]);
  });

  it("exits with a usage error's own status", async () => {
    const exits: number[] = [];

    await main(["piece", "inspect"], {
      parse: () =>
        Promise.reject(new ValidationError("bad usage", { exitCode: 3 })),
      exit: (code) => {
        exits.push(code);
      },
    });

    expect(printed.join("\n")).toContain("bad usage");
    expect(exits).toEqual([3]);
  });

  it("ends with the code a command left in `Deno.exitCode`", async () => {
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
    expect(printed).toEqual([]);
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

  it("reads the real `Deno.exitCode` by default", async () => {
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
});
