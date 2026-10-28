import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createWriteOnceExports,
  populateModuleExports,
} from "../src/sandbox/module-record-compiler.ts";

const noRequire = (s: string): Record<string, unknown> => {
  throw new Error(`unexpected require(${s})`);
};

//
// The ESM loader hands the module body a write-once exports object so a write
// smuggled into the evaluation of an otherwise-accepted expression (e.g. a
// comma side effect inside a `__cf_data(...)` argument) cannot overwrite an
// already-assigned export with attacker-controlled state before the loader
// snapshots it into the (SES-immutable) namespace. These tests pin that
// behavior, plus the legitimate compiler shapes that must still work.
//

describe("createWriteOnceExports", () => {
  it("locks a property after a real assignment (blocks the overwrite smuggle)", () => {
    const { exports } = createWriteOnceExports();
    exports.token = "verified-data";
    // The smuggled `exports.token = evilClosure` inside a later accepted
    // expression must throw rather than silently corrupt the export.
    expect(() => {
      exports.token = () => "pwned";
    }).toThrow(/write-once/);
    expect(exports.token).toBe("verified-data");
  });

  it("allows the `exports.x = void 0; … exports.x = real;` forward-decl shape", () => {
    const { exports } = createWriteOnceExports();
    // TS CommonJS output forward-declares exports as `void 0` in the preamble.
    exports.value = undefined;
    exports.value = undefined; // chained `exports.a = exports.b = void 0`
    // The real assignment is permitted and then locks the binding.
    exports.value = 42;
    expect(exports.value).toBe(42);
    expect(() => {
      exports.value = 99;
    }).toThrow(/write-once/);
  });

  it("allows a re-export getter to be defined once, blocks redefinition", () => {
    const { exports } = createWriteOnceExports();
    Object.defineProperty(exports, "reexported", {
      enumerable: true,
      configurable: true,
      get: () => "from-dep",
    });
    expect(exports.reexported).toBe("from-dep");
    // A second define (e.g. smuggled `Object.defineProperty(exports, …)`) throws.
    expect(() => {
      Object.defineProperty(exports, "reexported", { value: () => "pwned" });
    }).toThrow(/write-once/);
  });

  it("allows the __esModule marker and locks it", () => {
    const { exports } = createWriteOnceExports();
    Object.defineProperty(exports, "__esModule", { value: true });
    expect(exports.__esModule).toBe(true);
    expect(() => {
      exports.__esModule = false;
    }).toThrow(/write-once/);
  });

  it("blocks deletion of an export (e.g. `delete exports.__esModule`)", () => {
    const { exports } = createWriteOnceExports();
    exports.keep = 1;
    expect(() => {
      delete exports.keep;
    }).toThrow(/cannot be deleted/);
    expect(exports.keep).toBe(1);
  });

  it("fails closed when a smuggle assigns before the real assignment", () => {
    const { exports } = createWriteOnceExports();
    // Smuggle runs first (e.g. an import-preamble data arg evaluated early),
    // setting a real value and locking the binding…
    exports.api = () => "pwned";
    // …so the module's own legitimate assignment then throws — the module fails
    // to load rather than exporting a corrupted-but-accepted value.
    expect(() => {
      exports.api = "verified-data";
    }).toThrow(/write-once/);
  });

  it("throws on a write to an `undefined` placeholder once sealed", () => {
    const { exports, seal } = createWriteOnceExports();
    exports.first = undefined;
    seal();

    expect(() => {
      exports.first = "late";
    }).toThrow(/after the module finished evaluating/);
    expect(exports.first).toBeUndefined();
  });

  it("throws on defining a new export once sealed", () => {
    const { exports, seal } = createWriteOnceExports();
    seal();

    expect(() => {
      exports.added = 1;
    }).toThrow(/after the module finished evaluating/);
    expect(() => {
      Object.defineProperty(exports, "defined", { value: 1 });
    }).toThrow(/after the module finished evaluating/);
    expect("added" in exports).toBe(false);
  });

  it("treats distinct exports independently", () => {
    const { exports } = createWriteOnceExports();
    exports.a = 1;
    exports.b = 2;
    expect(exports.a).toBe(1);
    expect(exports.b).toBe(2);
    expect(() => {
      exports.a = 3;
    }).toThrow();
  });
});

describe("populateModuleExports", () => {
  it("snapshots only the declared exports onto the namespace", () => {
    const ns: Record<string, unknown> = {};
    populateModuleExports(ns, ["a"], (exports) => {
      exports.a = "data";
      // A non-declared stash is written to the throwaway write-once object…
      exports.secret = () => "pwned";
    }, noRequire);
    expect(ns.a).toBe("data");
    // …but is never lifted onto the namespace.
    expect("secret" in ns).toBe(false);
    expect(ns.__esModule).toBe(true);
  });

  it("fails closed on `module.exports = evil` under strict mode (frozen wrapper)", () => {
    const ns: Record<string, unknown> = {};
    // The `__cf_data((module.exports = evil, 1))` twin. Compiled module bodies
    // are strict (TS emits "use strict"), so assigning to the frozen module
    // wrapper throws — the module fails closed. Strict directive must be the
    // first statement to take effect.
    const strictFactory = function (
      exports: Record<string, unknown>,
      _require: unknown,
      module: { exports: Record<string, unknown> },
    ) {
      "use strict";
      exports.x = "verified";
      module.exports = { x: () => "pwned" };
    };
    expect(() => {
      populateModuleExports(
        ns,
        ["x"],
        strictFactory as Parameters<typeof populateModuleExports>[2],
        noRequire,
      );
    }).toThrow();
  });

  it("snapshots from write-once even if `module.exports` is swapped (sloppy mode)", () => {
    const ns: Record<string, unknown> = {};
    // Even where the reassignment does not throw (sloppy mode: the frozen-object
    // write silently no-ops), the namespace snapshots from the write-once object
    // directly, never `module.exports`, so the swap cannot corrupt it.
    populateModuleExports(ns, ["x"], (exports, _require, module) => {
      exports.x = "verified";
      try {
        module.exports = { x: () => "pwned" };
      } catch { /* frozen wrapper in strict mode */ }
    }, noRequire);
    expect(ns.x).toBe("verified");
  });

  it("snapshots from the write-once object, not module.exports", () => {
    const ns: Record<string, unknown> = {};
    populateModuleExports(ns, ["x"], (exports, _require, module) => {
      exports.x = "verified";
      // Reading module.exports is fine and returns the write-once object.
      expect(module.exports).toBe(exports);
    }, noRequire);
    expect(ns.x).toBe("verified");
  });

  it("seals the exports when the module body returns", () => {
    // An export still `undefined` when the body returns would otherwise take
    // one later write from a function the module exported, and every caller
    // after the first would read the first caller's value.

    const ns: Record<string, unknown> = {};
    populateModuleExports(ns, ["first", "remember"], (exports) => {
      exports.first = undefined;
      exports.remember = (value: string) => {
        if (exports.first === undefined) exports.first = value;
        return exports.first;
      };
    }, noRequire);
    const remember = ns.remember as (value: string) => unknown;

    expect(() => remember("alice")).toThrow(
      /after the module finished evaluating/,
    );
    expect(() => remember("bob")).toThrow(
      /after the module finished evaluating/,
    );
  });

  it("propagates a write-once violation as a module load failure", () => {
    const ns: Record<string, unknown> = {};
    expect(() => {
      populateModuleExports(ns, ["x"], (exports) => {
        exports.x = "verified";
        exports.x = () => "pwned"; // smuggled overwrite
      }, noRequire);
    }).toThrow(/write-once/);
  });
});
