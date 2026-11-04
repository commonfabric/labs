import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";

// Accept/reject corpus for the module-body verifier. These are crafted
// compiled-CommonJS module bodies that mimic CF-transformed output, pinning the
// verdict `verifyCompiledModuleBody` gives each shape of the format-agnostic SES
// module-item rules. Crafted bodies, not compiler output: they cover shapes the
// transformer does not currently emit, so a future emit change cannot silently
// widen what the verifier admits. End-to-end coverage over genuinely compiled
// programs lives in esm-module-body-verifier.test.ts and esm-pattern-run.test.ts.

const IMPORT = `const cf_1 = require("commonfabric");`;

interface Case {
  name: string;
  body: string;
  reject?: RegExp; // present => expected to throw (matching), else expected to pass
}

const ACCEPT: Case[] = [
  {
    name: "direct builder callback",
    body: `${IMPORT}\nexports.v = (0, cf_1.pattern)((s) => ({ n: s.n }));`,
  },
  {
    name: "top-level direct function used as a builder callback",
    body:
      `${IMPORT}\nconst cb = (s) => ({ n: s.n });\nexports.v = (0, cf_1.pattern)(cb);`,
  },
  {
    name: "plain top-level function + export",
    body: `const helper = (x) => x + 1;\nexports.helper = helper;`,
  },
  {
    name: "__cf_data-wrapped mutable object",
    body: `${IMPORT}\nexports.config = (0, cf_1.__cf_data)({ a: 1, b: 2 });`,
  },
  {
    name: "schema()-wrapped value",
    body: `${IMPORT}\nexports.s = (0, cf_1.schema)({ type: "object" });`,
  },
  {
    name: "named reexport getter from an internal import",
    body:
      `const inner_1 = require("./inner.ts");\nObject.defineProperty(exports, "x", { enumerable: true, get: function () { return inner_1.x; } });`,
  },
  {
    // `export { x } from "./m"` emits the module reference as `var`
    // (hoisted ahead of the getter), not `const`. The import-preamble fast-path
    // must accept the `var` form, or a legitimate barrel re-export is rejected.
    name: "named reexport getter from a var require preamble",
    body:
      `var inner_1 = require("./inner.ts");\nObject.defineProperty(exports, "x", { enumerable: true, get: function () { return inner_1.x; } });`,
  },
  {
    name: "ambient safe global inside a builder callback",
    body: `${IMPORT}\nexports.v = (0, cf_1.pattern)((s) => fetch(s.url));`,
  },
  {
    name: "es-module marker + void-0 export forward decl preamble",
    body:
      `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.v = void 0;\n${IMPORT}\nexports.v = (0, cf_1.pattern)(() => ({}));`,
  },
  {
    name: "__importDefault / __importStar require preamble forms",
    body:
      `const cf_1 = __importStar(require("commonfabric"));\nconst d_1 = __importDefault(require("./dep.ts"));\nexports.v = (0, cf_1.pattern)(() => ({}));`,
  },
  {
    name: "bare side-effect import of an allowed specifier",
    body:
      `require("./styles.ts");\nconst helper = (x) => x;\nexports.helper = helper;`,
  },
];

const REJECT: Case[] = [
  {
    name: "raw mutable object export without __cf_data",
    body: `const config = { a: 1, b: 2 };\nexports.config = config;`,
    reject: /__cf_data/,
  },
  {
    name: "top-level mutable binding (let)",
    body: `let counter = 0;\nexports.counter = counter;`,
    reject: /mutable/i,
  },
  {
    name: "state-hiding IIFE",
    body: `const x = (() => ({ a: 1 }))();\nexports.x = x;`,
    reject: /.*/,
  },
  {
    name: "top-level class declaration",
    body: `class Foo {}\nexports.Foo = Foo;`,
    reject: /class declarations/i,
  },
  {
    name: "top-level generator declaration",
    body: `function* gen() {}\nexports.gen = gen;`,
    reject: /.*/,
  },
  {
    name: "unwrapped top-level call result",
    body: `const leaked = JSON.parse("{}");\nexports.leaked = leaked;`,
    reject: /module scope|call results|__cf_data/i,
  },
  {
    name: "indirect (non-function) builder callback",
    body:
      `${IMPORT}\nconst data = (0, cf_1.__cf_data)({});\nexports.v = (0, cf_1.pattern)(data);`,
    reject: /direct callback/i,
  },
  {
    name: "default export of a runtime namespace",
    body: `${IMPORT}\nexports.default = cf_1;`,
    reject: /Default exports/i,
  },
  {
    name: "shadowed require defeating the import fast-path",
    body:
      `const require = (x) => globalThis;\nconst g = require("commonfabric");\nexports.g = g;`,
    reject: /.*/,
  },
  {
    name: "shadowed require via async function declaration",
    body:
      `async function require(x) { return globalThis; }\nconst g = require("commonfabric");\nexports.g = g;`,
    reject: /.*/,
  },
  {
    name: "require of a disallowed specifier (node:fs)",
    body: `const fs_1 = require("node:fs");\nexports.fs = fs_1;`,
    reject: /.*/,
  },
  {
    // The `var` re-export relaxation must not extend to trusted runtime
    // bindings — `var` is mutable at runtime, so a runtime require must be
    // `const`. Mirrors `const` accept "named reexport getter from a var require".
    name: "var require of a trusted runtime module",
    body: `var cf = require("commonfabric");\nexports.cf = cf;`,
    reject: /mutable/i,
  },
  {
    name: "bare side-effect import of a disallowed specifier",
    body: `require("node:child_process");\nexports.x = 1;`,
    reject: /.*/,
  },
];

describe("ESM verifier parity oracle (crafted CF-shaped bodies)", () => {
  for (const c of ACCEPT) {
    it(`accepts: ${c.name}`, () => {
      expect(() => verifyCompiledModuleBody(c.body, "/m.ts")).not.toThrow();
    });
  }
  for (const c of REJECT) {
    it(`rejects: ${c.name}`, () => {
      expect(() => verifyCompiledModuleBody(c.body, "/m.ts")).toThrow(c.reject);
    });
  }
});
