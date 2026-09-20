import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";

// Adversarial corpus against the ESM module verifier (`verifyCompiledModuleBody`).
// Each fixture is a compiled-CommonJS body an attacker might hand-craft to defeat
// the verifier — the same bytes the SES compartment would evaluate. Brainstormed
// red-team style (no execution); most must be REJECTED. A few legitimate forms
// are negative controls (accept). The reject cases double as bypass detectors:
// if the verifier accepts one, that's a real gap.

const IMPORT = `const cf = require("commonfabric");`;

interface Attack {
  name: string;
  body: string;
  accept?: boolean; // default: must be rejected (verifier throws)
}

const ATTACKS: Attack[] = [
  //
  // ASI / statement-merge desync (splitter only `}`-terminates block keywords)
  //

  {
    name: "ASI: const builder call then side-effect require, no semicolons",
    body:
      `${IMPORT}\nconst v = (0, cf.pattern)((s) => ({ d: s }))\nglobalThis.pwned = require("commonfabric")`,
  },
  {
    name:
      "ASI: exports assignment with comma-sequence side effect, no semicolons",
    body:
      `${IMPORT}\nconst a = (0, cf.computed)(() => 1)\nexports.x = (globalThis.fetch("//evil"), a)`,
  },
  {
    name: "U+2028 line separator used to merge a side effect onto a const",
    body: `${IMPORT}\nconst a = (0, cf.pattern)(() => 1) globalThis.pwned = 1`,
  },
  {
    name: "U+2029 paragraph separator statement merge",
    body: `${IMPORT}\nconst a = (0, cf.pattern)(() => 1) globalThis.pwned = 1`,
  },

  //
  // tokenizer confusion
  //

  {
    name: "regex-vs-divide: division parsed as regex to swallow a semicolon",
    body:
      `${IMPORT}\nconst x = cf;\nconst y = 4 /1/g, evil = require("commonfabric"); exports.e = evil`,
  },
  {
    name: "nested template literal in a __cf_data arg",
    body: `${IMPORT}\nexports.x = cf.__cf_data(\`\${\`\${ {a:1} }\`}\`);`,
    accept: true, // opaque __cf_data data; the concern is split divergence, not acceptance
  },
  {
    name: "template with embedded close-brace string confusing depth tracking",
    body: `${IMPORT}\nexports.v = (0, cf.pattern)((s) => \`\${"}"}\`);`,
    accept: true, // legitimate: a direct callback whose body is a template
  },

  //
  // shadowing trusted names
  //

  {
    name: "shadow `require` then call it as an arbitrary function",
    body:
      `const require = (x) => globalThis;\nconst evil = require("anything");`,
  },
  {
    name: "shadow `require` with var + hoisting",
    body: `const leaked = require("./secret.ts");\nvar require = 0;`,
  },
  {
    name: "local function __cf_data passthrough wrapping mutable state",
    body:
      `function __cf_data(x) { return globalThis.mutate(x); }\nconst state = __cf_data({ count: 0 });`,
  },
  {
    name: "shadow __exportStar with a malicious local then re-export",
    body:
      `function __exportStar(m, e) { globalThis.steal = m; }\n__exportStar(require("./m.ts"), exports);`,
  },
  {
    name: "multi-declarator shadow of __exportStar (non-first declarator)",
    body:
      `const a = 1, __exportStar = (m, e) => { globalThis.steal = m; };\n__exportStar(require("./m.ts"), exports);`,
  },
  {
    name: "multi-declarator shadow of require (non-first declarator)",
    body:
      `const a = 1, require = (x) => globalThis;\nconst evil = require("commonfabric");`,
  },
  {
    name: "multi-declarator shadow of __importStar (non-first declarator)",
    body:
      `const a = 1, __importStar = (m) => globalThis;\nconst ns = __importStar(require("commonfabric"));`,
  },

  //
  // __cf_data / schema opaque-argument boundary
  //

  {
    name: "legit __cf_data-wrapped plain object (negative control)",
    body: `${IMPORT}\nexports.config = cf.__cf_data({ a: 1, b: 2 });`,
    accept: true,
  },
  {
    // KNOWN BOUNDARY: __cf_data/schema arguments
    // are treated as opaque verified data — `verifyTrustedDataCall` checks only
    // the argument *count*, never recurses into the argument expression. So a
    // side-effecting computed value inside the wrapped literal is accepted by
    // the (deliberately AST-free) verifier; the runtime data-freeze is the
    // backstop for the value itself. This is NOT reachable from authored TS via
    // the trusted transformer (it only wraps statically-classified data), and
    // tightening it to a purity check is tracked as separate hardening work.
    // The test pins the current behavior so a future change is a conscious one.
    name: "__cf_data argument is opaque (side-effecting value accepted)",
    body:
      `${IMPORT}\nexports.x = cf.__cf_data({ y: (globalThis.fetch("//evil"), 1) });`,
    accept: true,
  },
  {
    name: "schema() argument is opaque (side-effecting value accepted)",
    body:
      `${IMPORT}\nexports.x = cf.schema({ default: (globalThis.fetch("//x"), {}) });`,
    accept: true,
  },

  //
  // reexport getter abuse
  //

  {
    name: "reexport getter returning a call expression",
    body:
      `Object.defineProperty(exports, "x", { enumerable: true, get: function () { return globalThis.fetch("//x"); } });`,
  },

  //
  // default export laundering
  //

  {
    name: "default export of comma-sequence with a side effect",
    body:
      `${IMPORT}\nexports.default = (globalThis.fetch("//x"), (0, cf.pattern)((s) => s));`,
  },
  {
    name: "default export re-exporting the runtime namespace",
    body: `${IMPORT}\nexports.default = exports.v = cf.require;`,
  },

  //
  // trusted-builder callback indirection
  //

  {
    name: "builder callback is a member of an import (indirect)",
    body:
      `${IMPORT}\nconst other = require("./other.ts");\nexports.v = cf.pattern(other.makeBody);`,
  },
  {
    name: "builder callback is non-function data via binding-identity helper",
    body:
      `${IMPORT}\nconst sneaky = cf.someData;\nexports.v = cf.pattern(__cfBindVerifiedBinding(sneaky, {}));`,
  },
  {
    name: "fake (non-canonical) __cfHardenFn laundering a callback",
    body:
      `${IMPORT}\nfunction __cfHardenFn(fn) { globalThis.steal = fn; return fn; }\nconst cb = () => 1;\nexports.v = cf.pattern(__cfHardenFn(cb));`,
  },
  {
    name: "legit named direct-function callback (negative control)",
    body:
      `${IMPORT}\nconst cb = (s) => ({ n: s.n });\nexports.v = cf.pattern(cb);`,
    accept: true,
  },
  {
    name: "optional-chaining builder call",
    body:
      `${IMPORT}\nexports.x = cf?.pattern?.(() => globalThis.fetch("//x"));`,
  },
  {
    name: "lift with a callback smuggled into a value slot (arity abuse)",
    body:
      `${IMPORT}\nexports.v = cf.lift((x) => globalThis.fetch("//x"), (y) => y, (z) => z);`,
  },
  {
    name: "handler with a function in the non-callback value slot",
    body:
      `${IMPORT}\nconst cb = () => 1;\nexports.h = cf.handler(cb, () => globalThis.fetch("//x"), 0);`,
  },

  //
  // top-level executable / mutable forms
  //

  {
    name: "IIFE disguised as a parenthesized arrow",
    body: `exports.x = (() => { globalThis.fetch("//x"); return 1; })();`,
  },
  {
    name: "new-expression top-level side effect",
    body: `${IMPORT}\nexports.x = new (cf.Evil)();`,
  },
  {
    name: "tagged template literal at module scope",
    body: `${IMPORT}\nexports.x = cf.pattern\`\${globalThis.fetch("//x")}\`;`,
  },
  {
    name: "let mutable top-level binding",
    body: `let counter = 0;\nexports.counter = counter;`,
  },
  {
    name: "class expression assigned to a const with side-effecting static",
    body:
      `const x = class { static y = globalThis.fetch("//x"); };\nexports.x = x;`,
  },
  {
    name: "top-level class declaration with static initializer",
    body: `class C { static x = globalThis.fetch("//x"); }\nexports.C = C;`,
  },
  {
    name: "generator function declaration",
    body: `function* gen() { globalThis.fetch("//x"); }\nexports.gen = gen;`,
  },
  {
    name: "do/while top-level loop",
    body: `do { globalThis.fetch("//x"); } while (0);`,
  },
  {
    name: "for-loop header side effect",
    body: `for (globalThis.fetch("//x"); false; ) { }`,
  },
  {
    // Top-level function declarations are allowed by design: the body is not
    // executed at module init, and SES lockdown governs which globals exist, so
    // a body that references `globalThis.fetch` is harmless until invoked. This
    // mirrors the accepted plain-function case (generators, by contrast, are
    // rejected). Negative control to pin that async declarations are accepted.
    name: "async function declaration is allowed (not executed at init)",
    body: `async function go() { globalThis.fetch("//x"); }\nexports.go = go;`,
    accept: true,
  },

  //
  // export form abuse
  //

  { name: "module.exports = runtime", body: `${IMPORT}\nmodule.exports = cf;` },
  {
    name: "computed-key export assignment",
    body: `${IMPORT}\nexports[globalThis.k] = (0, cf.pattern)((s) => s);`,
  },
  {
    name: "legit bracket-literal-key export (negative control)",
    body: `${IMPORT}\nexports["x"] = (0, cf.pattern)((s) => s);`,
    accept: true,
  },
  {
    name: "unicode-escaped trusted builder name",
    body: `${IMPORT}\nexports.x = cf.\\u0070attern(() => 1);`,
  },

  //
  // import fast-path / require boundary abuse
  //

  {
    name: "side-effect require with quote-escape break-out attempt",
    body: `require("./a.ts\\");globalThis.pwned=(\\"");`,
  },
  {
    name: "require of a disallowed specifier",
    body: `const fs_1 = require("node:fs");\nexports.fs = fs_1;`,
  },
  {
    name: "bare side-effect require of a disallowed specifier",
    body: `require("node:child_process");`,
  },
  {
    name: "export-star require of a disallowed specifier",
    body: `__exportStar(require("node:fs"), exports);`,
  },
  {
    name: "multi-declarator const smuggling a call in the second declarator",
    body:
      `${IMPORT}\nconst cf2 = require("commonfabric"), evil = cf2.pattern(globalThis.fetch);`,
  },
  {
    name: "require fast-path defeated by trailing declarator",
    body: `const x = require("commonfabric"), y = globalThis;`,
  },

  //
  // `__cfReg` hoist-registration call
  //
  // `__cfReg` is supplied to the module wrapper as a parameter (the registrar);
  // it is deliberately NOT a referenceable binding, and only a single top-level
  // `__cfReg({ <shorthand top-level bindings> })` statement is approved. Every
  // other shape must be rejected so an attacker can neither register an arbitrary
  // symbol nor smuggle a second/aliased registrar call.
  //

  {
    name: "__cfReg: legitimate single shorthand registration (control)",
    accept: true,
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ __cfPattern_1 });`,
  },
  {
    // The case the spec calls out: a name not declared at module level.
    name: "__cfReg: registers an undeclared (non-module-level) symbol",
    body: `${IMPORT}\n__cfReg({ smuggled });`,
  },
  {
    name: "__cfReg: a second registration call",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ __cfPattern_1 });\n__cfReg({ __cfPattern_1 });`,
  },
  {
    name: "__cfReg: aliased/member-call callee (cf.__cfReg)",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\ncf.__cfReg({ __cfPattern_1 });`,
  },
  {
    name: "__cfReg: reassigned to a local then invoked",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\nconst r = __cfReg;\nr({ __cfPattern_1 });`,
  },
  {
    name: "__cfReg: captured as a variable initializer",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\nconst z = __cfReg({ __cfPattern_1 });\nexports.z = z;`,
  },
  {
    name: "__cfReg: string-keyed property (not shorthand)",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ "__cfPattern_1": __cfPattern_1 });`,
  },
  {
    name: "__cfReg: key:value property naming a different binding",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ alias: __cfPattern_1 });`,
  },
  {
    name: "__cfReg: computed key",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ ["__cfPattern_1"]: __cfPattern_1 });`,
  },
  {
    name: "__cfReg: object spread of an attacker value",
    body:
      `${IMPORT}\nconst evil = (0, cf.__cf_data)({ x: 1 });\n__cfReg({ ...evil });`,
  },
  {
    name: "__cfReg: extra trailing argument",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ __cfPattern_1 }, globalThis);`,
  },
  {
    name: "__cfReg: unicode-escaped callee",
    body:
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n\\u005f\\u005fcfReg({ __cfPattern_1 });`,
  },
];

describe("ESM verifier adversarial corpus", () => {
  for (const attack of ATTACKS) {
    const verb = attack.accept ? "allows (control)" : "rejects";
    it(`${verb}: ${attack.name}`, () => {
      const run = () => verifyCompiledModuleBody(attack.body, "/m.ts");
      if (attack.accept) {
        expect(run).not.toThrow();
      } else {
        expect(run).toThrow();
      }
    });
  }
});
