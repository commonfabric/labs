import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  importModuleGraphNow,
  type VirtualModuleRecord,
} from "../src/sandbox/esm-module-loader.ts";

function record(
  imports: string[],
  exports: string[],
  execute: VirtualModuleRecord["execute"],
): VirtualModuleRecord {
  return { imports, exports, execute };
}

describe("importModuleGraphNow", () => {
  it("loads a multi-module graph synchronously and resolves cross-module calls", () => {
    const records = new Map<string, VirtualModuleRecord>([
      [
        "cf:module/main",
        record(
          ["cf:module/util"],
          ["run"],
          (exports, compartment, resolved) => {
            const util = compartment.importNow(resolved["cf:module/util"]) as {
              double(n: number): number;
            };
            exports.run = () => util.double(21);
          },
        ),
      ],
      [
        "cf:module/util",
        record([], ["double"], (exports) => {
          exports.double = (n: number) => n * 2;
        }),
      ],
    ]);

    const ns = importModuleGraphNow("cf:module/main", { records }) as {
      run(): number;
    };
    expect(ns.run()).toBe(42);
  });

  it("exposes host endowments through runtime-module records", () => {
    const records = new Map<string, VirtualModuleRecord>([
      [
        "cf:runtime/host",
        record([], ["greet"], (exports) => {
          exports.greet = (name: string) => `hi ${name}`;
        }),
      ],
      [
        "cf:module/main",
        record(
          ["cf:runtime/host"],
          ["value"],
          (exports, compartment, resolved) => {
            const host = compartment.importNow(resolved["cf:runtime/host"]) as {
              greet(n: string): string;
            };
            exports.value = host.greet("world");
          },
        ),
      ],
    ]);

    const ns = importModuleGraphNow("cf:module/main", { records }) as {
      value: string;
    };
    expect(ns.value).toBe("hi world");
  });

  it("loads import cycles deterministically", () => {
    // a <-> b: a.first() calls b.second() lazily, so the cycle resolves.
    const records = new Map<string, VirtualModuleRecord>([
      [
        "cf:module/a",
        record(["cf:module/b"], ["first"], (exports, compartment, resolved) => {
          exports.first = () => {
            const b = compartment.importNow(resolved["cf:module/b"]) as {
              second(): string;
            };
            return "a" + b.second();
          };
        }),
      ],
      [
        "cf:module/b",
        record(["cf:module/a"], ["second"], (exports) => {
          exports.second = () => "b";
        }),
      ],
    ]);

    const ns = importModuleGraphNow("cf:module/a", { records }) as {
      first(): string;
    };
    expect(ns.first()).toBe("ab");
  });

  describe("evaluation order", () => {
    /**
     * Records that evaluate as compiled bodies do: each `require`s its imports
     * in order, nested inside its own body, and logs when it starts and ends.
     */
    const logging = (
      log: string[],
      graph: Record<string, string[]>,
    ): Map<string, VirtualModuleRecord> =>
      new Map(
        Object.entries(graph).map(([name, imports]) => [
          name,
          record(imports, [], (_exports, compartment, resolved) => {
            log.push(`start ${name}`);
            for (const imported of imports) {
              compartment.importNow(resolved[imported]);
            }
            log.push(`end ${name}`);
          }),
        ]),
      );
    const ends = (log: string[]) =>
      log.filter((line) => line.startsWith("end "));

    it("finishes shared dependencies first, in import order", () => {
      const log: string[] = [];
      importModuleGraphNow("cf:module/main", {
        records: logging(log, {
          "cf:module/main": ["cf:module/left", "cf:module/right"],
          "cf:module/left": ["cf:module/shared"],
          "cf:module/right": ["cf:module/shared", "cf:module/leaf"],
          "cf:module/shared": [],
          "cf:module/leaf": [],
        }),
      });

      expect(ends(log)).toEqual([
        "end cf:module/shared",
        "end cf:module/left",
        "end cf:module/leaf",
        "end cf:module/right",
        "end cf:module/main",
      ]);
    });

    it("runs a cycle exactly as importing its first module would", () => {
      // A cycle decides which module sees the other's exports half-populated,
      // and what a member imports evaluates when its `require` is reached, so
      // `beyond` must finish before `other`, and `leaf` after it.
      const log: string[] = [];
      importModuleGraphNow("cf:module/main", {
        records: logging(log, {
          "cf:module/main": ["cf:module/before", "cf:module/entered"],
          "cf:module/before": [],
          "cf:module/entered": ["cf:module/other", "cf:module/leaf"],
          "cf:module/other": ["cf:module/entered", "cf:module/beyond"],
          "cf:module/leaf": [],
          "cf:module/beyond": [],
        }),
      });

      // `main` is outside the cycle, and its own body may start before or after
      // its imports finish.
      expect(log.filter((line) => !line.endsWith("/main"))).toEqual([
        "start cf:module/before",
        "end cf:module/before",
        "start cf:module/entered",
        "start cf:module/other",
        "start cf:module/beyond",
        "end cf:module/beyond",
        "end cf:module/other",
        "start cf:module/leaf",
        "end cf:module/leaf",
        "end cf:module/entered",
      ]);
    });
  });

  it("throws for an unknown specifier", () => {
    const records = new Map<string, VirtualModuleRecord>();
    expect(() => importModuleGraphNow("cf:module/missing", { records }))
      .toThrow();
  });
});
