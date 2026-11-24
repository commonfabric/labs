/// <reference lib="deno.unstable" />

/**
 * Runs the `cf-bench/no-lost-diagnostics` rule over short benchmark files and
 * checks which of the two messages, if either, it reports. `Deno.lint.runPlugin`
 * takes the file name, so a case names one ending in `.bench.ts` to put the rule
 * in scope.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import plugin from "./lint-bench-console.ts";

function diagnose(source: string, fileName = "sample.bench.ts"): string[] {
  return Deno.lint.runPlugin(plugin, fileName, source).map((d) => d.message);
}

/** Distinguishing phrase of the message for a write that never lands. */
const LOST = "never reaches stderr";

/** Distinguishing phrase of the message for a disallowed `console` method. */
const STDOUT = "may use only the `console` methods that write to stderr";

describe("lint-bench-console", () => {
  it("reports a console call written in a benchmark body", () => {
    const messages = diagnose(`
      Deno.bench("a", () => {
        console.error("how big");
      });
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(LOST);
  });

  it("reports a console call in the object form of Deno.bench", () => {
    const messages = diagnose(`
      Deno.bench({
        name: "a",
        fn(b) {
          b.start();
          b.end();
          console.error("how big");
        },
      });
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(LOST);
  });

  it("reports a console call in a helper a body calls", () => {
    const messages = diagnose(`
      function report(detail) {
        console.error(detail);
      }
      Deno.bench("a", () => {
        report("how big");
      });
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(LOST);
  });

  it("follows helper calls through more than one hop", () => {
    const messages = diagnose(`
      const emit = (line) => {
        console.error(line);
      };
      function report(detail) {
        emit(detail);
      }
      Deno.bench("a", async (b) => {
        await Promise.resolve();
        report("how big");
      });
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(LOST);
  });

  it("follows a recursive helper, past a call to a function the file does not define", () => {
    const messages = diagnose(`
      function report(depth) {
        if (depth > 0) report(depth - 1);
        console.error(depth);
      }
      Deno.bench("a", () => {
        measure();
        report(2);
      });
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(LOST);
  });

  it("reports a stdout method in a helper bound by destructuring, which no body reaches by name", () => {
    const messages = diagnose(`
      const { report } = (detail) => {
        console.log(detail);
      };
      Deno.bench("a", () => {
        report("how big");
      });
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(STDOUT);
  });

  it("reports a stdout method in a body as a lost diagnostic", () => {
    const messages = diagnose(`
      Deno.bench("a", () => {
        console.log("how big");
      });
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(LOST);
  });

  it("reports a module-scope console method that writes to stdout", () => {
    const messages = diagnose(`
      console.log("program size: 4");
      Deno.bench("a", () => {});
    `);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(STDOUT);
  });

  it("reports every console method outside the four stderr ones", () => {
    // `dirxml` and `table` write to stdout; `time` writes nothing but is not
    // one of the four, and the rule turns on the permitted list rather than on
    // an enumeration of the ways a method can reach stdout.
    for (const method of ["dirxml", "table", "count", "group", "time"]) {
      const messages = diagnose(`
        console.${method}("x");
        Deno.bench("a", () => {});
      `);
      expect(messages.length).toBe(1);
      expect(messages[0]).toContain(STDOUT);
    }
  });

  it("returns nothing for the four console methods that reach stderr", () => {
    for (const method of ["assert", "error", "trace", "warn"]) {
      expect(diagnose(`
        console.${method}("x");
        Deno.bench("a", () => {});
      `)).toEqual([]);
    }
  });

  it("returns nothing for a module-scope console.error", () => {
    expect(diagnose(`
      console.error("program size: 4");
      Deno.bench("a", () => {});
    `)).toEqual([]);
  });

  it("returns nothing for a console.error in an unload handler", () => {
    expect(diagnose(`
      addEventListener("unload", () => {
        console.error("summary");
      });
      Deno.bench("a", () => {});
    `)).toEqual([]);
  });

  it("returns nothing for a helper only module scope calls", () => {
    expect(diagnose(`
      function report(detail) {
        console.error(detail);
      }
      report("program size: 4");
      Deno.bench("a", () => {});
    `)).toEqual([]);
  });

  it("returns nothing for a Deno.stderr write in a body", () => {
    expect(diagnose(`
      const encoder = new TextEncoder();
      Deno.bench("a", () => {
        Deno.stderr.writeSync(encoder.encode("how big\\n"));
      });
    `)).toEqual([]);
  });

  it("returns nothing for a private member read off console", () => {
    expect(diagnose(`
      class Probe {
        #log() {}
        run() {
          console.#log("how big");
        }
      }
    `)).toEqual([]);
  });

  it("returns nothing for a member call that is not on console", () => {
    expect(diagnose(`
      const logger = { log: (line) => line };
      Deno.bench("a", () => {
        logger.log("how big");
      });
    `)).toEqual([]);
  });

  it("returns nothing for a file that is not a benchmark", () => {
    expect(diagnose(
      `
      console.log("hello");
      Deno.bench("a", () => {
        console.error("how big");
      });
    `,
      "sample.ts",
    )).toEqual([]);
  });
});
