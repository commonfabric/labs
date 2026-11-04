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

  it("throws for an unknown specifier", () => {
    const records = new Map<string, VirtualModuleRecord>();
    expect(() => importModuleGraphNow("cf:module/missing", { records }))
      .toThrow();
  });
});
