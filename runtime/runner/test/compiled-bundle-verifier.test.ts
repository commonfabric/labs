import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createBindingIdentityHelperSource,
  createFunctionHardeningHelperSource,
} from "@commonfabric/pattern-contract/sandbox-contract";

import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";
import { ModuleVerificationError } from "../src/sandbox/module-verification-error.ts";
import { TOP_LEVEL_CALL_RESULT_ERROR } from "../src/sandbox/policy.ts";

const IMPORT = `const commonfabric_1 = require("commonfabric");`;
const LOCAL_IMPORT = `const util_ts_1 = require("./util.ts");`;
const HARDEN = createFunctionHardeningHelperSource();
const BIND = createBindingIdentityHelperSource();
const ONLY_TRUSTED_CALLS =
  "Only trusted builder calls, schema(), canonical function hardening, and canonical binding annotation are allowed at module scope in SES mode";
const UNSUPPORTED =
  "Compiled module contains unsupported top-level executable code";

function verify(body: string) {
  return () => verifyCompiledModuleBody(body, "/main.tsx");
}

describe("compiled-bundle-verifier", () => {
  // Each case hands the module-body verifier a compiled body it must refuse
  // for one stated reason, and asserts that reason, beside a near-identical
  // body it must accept, so a case cannot pass because the body was refused
  // for some other reason.

  describe("top-level code that calls authored functions", () => {
    it("throws for an `__exportStar` call whose module is a binding", () => {
      const body = `
${LOCAL_IMPORT}
function __exportStar(m, e) { globalThis.leak = m; }
__exportStar(util_ts_1, exports);
`;
      expect(verify(body)).toThrow(UNSUPPORTED);
      expect(verify(`__exportStar(require("./util.ts"), exports);`)).not
        .toThrow();
    });

    it("throws for re-assigning an import through `__importDefault`", () => {
      const body = `
var dep_1 = require("./dep.ts");
function __importDefault(m) { globalThis.leak = m; return m; }
dep_1 = __importDefault(dep_1);
`;
      expect(verify(body)).toThrow(UNSUPPORTED);
      expect(verify(`const dep_1 = __importDefault(require("./dep.ts"));`))
        .not.toThrow();
    });

    it("throws for an `__esModule` getter that returns an authored value", () => {
      const getter = (target: string) =>
        `Object.defineProperty(exports, "__esModule", { enumerable: true, get: function () { return ${target}; } });`;
      const body = `
function local() { globalThis.leak = 1; }
${getter("local.x")}
`;
      expect(verify(body)).toThrow(
        "Compiled reexport getters must return imported bindings",
      );
      expect(verify(`${LOCAL_IMPORT}\n${getter("util_ts_1.x")}`)).not
        .toThrow();
      expect(
        verify(
          `Object.defineProperty(exports, "__esModule", { value: true });`,
        ),
      ).not.toThrow();
    });

    it("classifies a call by the binding it names, not a same-named export", () => {
      // `exports.h` holds the hardening helper, but `h` is the module's own
      // function, so `h(f)` calls authored code at module scope.
      const body = (call: string) => `
${HARDEN}
function h(x) { globalThis.leak = x; return x; }
exports.h = __cfHardenFn;
const f = () => {};
const y = ${call};
exports.default = exports.h;
`;
      expect(verify(body("h(f)"))).toThrow(TOP_LEVEL_CALL_RESULT_ERROR);
      expect(verify(body("__cfHardenFn(f)"))).not.toThrow();
    });

    it("throws for a parenthesized callee that only a bracket-named export spells", () => {
      const body = (call: string) => `
${HARDEN}
function h(x) { globalThis.leak = x; return x; }
exports["(h)"] = __cfHardenFn;
const f = () => {};
const y = ${call};
`;
      expect(verify(body("(h)(f)"))).toThrow(ONLY_TRUSTED_CALLS);
      expect(verify(body("__cfHardenFn(f)"))).not.toThrow();
    });

    it("reads a slash after a line comment as the operator JavaScript sees", () => {
      // The comment ends in `=`, but the `/` on the next line is still a
      // division, so the next statement is separate code to classify.
      const body = (tail: string) =>
        `const a = 1 // =\n/ 1; ${tail} const z = 2 /1;`;
      expect(verify(body("globalThis.leak = 1;"))).toThrow(UNSUPPORTED);
      expect(verify(body(""))).not.toThrow();
    });

    it("throws for a call through a comma-wrapped local import", () => {
      const body = (callee: string) => `
${LOCAL_IMPORT}
${IMPORT}
const r = ${callee}(() => 2);
`;
      expect(verify(body("(0, util_ts_1.dbl)"))).toThrow(
        TOP_LEVEL_CALL_RESULT_ERROR,
      );
      expect(verify(body("(0, commonfabric_1.computed)"))).not.toThrow();
    });

    it("throws for a call through a comma-wrapped bare binding", () => {
      const body = `
function f(x) { return x; }
const r = (0, f)(1);
`;
      expect(verify(body)).toThrow(ONLY_TRUSTED_CALLS);
    });

    it("throws for a call to a bare runtime namespace", () => {
      const body = (call: string) => `
${IMPORT}
const r = ${call};
`;
      expect(verify(body("commonfabric_1(() => 1)"))).toThrow(
        ONLY_TRUSTED_CALLS,
      );
      expect(verify(body("commonfabric_1.computed(() => 1)"))).not.toThrow();
    });
  });

  describe("helper calls", () => {
    it("throws unless function hardening receives one direct function", () => {
      const body = (call: string) => `
${HARDEN}
function f() {}
const g = ${call};
exports.default = g;
`;
      expect(verify(body("__cfHardenFn(f, f)"))).toThrow(
        "Function hardening helpers accept exactly one argument",
      );
      expect(verify(body("__cfHardenFn(1)"))).toThrow(
        "Function hardening must target direct function values",
      );
      expect(verify(body("__cfHardenFn(f)"))).not.toThrow();
    });

    it("throws unless binding annotation receives a known binding and metadata", () => {
      const body = (call: string) => `
${BIND}
function f() {}
const g = ${call};
exports.default = g;
`;
      expect(verify(body("__cfBindVerifiedBinding(f)"))).toThrow(
        "Verified binding annotation helpers accept exactly two arguments",
      );
      expect(verify(body("__cfBindVerifiedBinding(missing, {})"))).toThrow(
        "Unknown top-level identifier 'missing' in SES mode",
      );
      expect(verify(body("__cfBindVerifiedBinding(f, {})"))).not.toThrow();
    });

    it("throws for trusted data helpers given the wrong number of arguments", () => {
      const body = (call: string) => `
${IMPORT}
const d = ${call};
`;
      expect(verify(body("(0, commonfabric_1.__cf_data)({}, {})"))).toThrow(
        "Trusted helper '__cf_data' received an unsupported argument shape",
      );
      expect(verify(body("(0, commonfabric_1.schema)()"))).toThrow(
        "Trusted helper 'schema' received an unsupported argument shape",
      );
      expect(verify(body("(0, commonfabric_1.__cf_data)({})"))).not.toThrow();
    });
  });

  describe("trusted builder arguments", () => {
    const builder = (call: string) => `
${IMPORT}
${LOCAL_IMPORT}
exports.default = (0, commonfabric_1.${call};
`;

    it("throws for a builder call with no callback position", () => {
      expect(verify(builder("pattern)()"))).toThrow(
        "Trusted builder 'pattern' must receive a direct callback in SES mode",
      );
      expect(verify(builder("handler)(false, false)"))).toThrow(
        "Trusted builder 'handler' must receive a direct callback in SES mode",
      );
      expect(verify(builder("pattern)(() => ({}))"))).not.toThrow();
    });

    it("locates the derive callback by the number of arguments", () => {
      expect(verify(builder("derive)({}, (v) => v)"))).not.toThrow();
      expect(verify(builder("derive)(false, false, {}, (v) => v)"))).not
        .toThrow();
      expect(verify(builder("derive)({}, util_ts_1.f)"))).toThrow(
        "Trusted builder 'derive' must receive a direct callback, not an indirect reference",
      );
      expect(verify(builder("derive)({})"))).toThrow(
        "Trusted builder 'derive' must receive a direct callback in SES mode",
      );
    });

    it("throws for non-callback arguments that are not trusted values", () => {
      expect(verify(builder("pattern)(() => ({}), missing)"))).toThrow(
        "Unknown identifier 'missing' in SES-verified module scope",
      );
      expect(verify(builder("pattern)(() => ({}), missing.schema)"))).toThrow(
        "Unknown top-level identifier 'missing' in SES mode",
      );
      expect(verify(builder("pattern)(() => ({}), util_ts_1.schema)"))).not
        .toThrow();
      expect(
        verify(
          builder(
            "pattern)(() => ({}), (0, commonfabric_1.schema)({ type: 'object' }))",
          ),
        ),
      ).not.toThrow();
      expect(
        verify(builder("pattern)(() => ({}), (0, commonfabric_1.schema)())")),
      ).toThrow(
        "Trusted helper 'schema' received an unsupported argument shape",
      );
    });
  });

  describe("references", () => {
    it("throws for reading an export that holds no value", () => {
      const body = (value: string) => `
exports.known = 1;
exports.default = ${value};
`;
      expect(verify(body("exports.missing"))).toThrow(
        "Unknown exported binding 'missing' in SES mode",
      );
      expect(verify(body("exports.known"))).not.toThrow();
      expect(verify(body(`exports["known"]`))).not.toThrow();
    });

    it("throws for a member of an unknown binding", () => {
      const body = (value: string) => `
${LOCAL_IMPORT}
const v = ${value};
`;
      expect(verify(body("missing.member"))).toThrow(
        "Unknown top-level identifier 'missing' in SES mode",
      );
      expect(verify(body("util_ts_1.member"))).not.toThrow();
    });

    it("accepts escaped bracket keys and throws for computed ones", () => {
      const body = (value: string) => `
${LOCAL_IMPORT}
const v = ${value};
`;
      expect(verify(body(`util_ts_1["a\\"b"]`))).not.toThrow();
      expect(verify(body(`util_ts_1["a" + "b"]`))).toThrow(
        "Top-level value is not allowed in SES mode",
      );
    });

    it("accepts only template literals without substitutions as data", () => {
      const body = (value: string) => `const v = ${value};`;
      expect(verify(body("`a\\`b`"))).not.toThrow();
      expect(verify(body("`a${1}b`"))).toThrow(
        "Top-level value is not allowed in SES mode",
      );
      expect(verify(body("`a``b`"))).toThrow(
        "Top-level value is not allowed in SES mode",
      );
    });

    it("throws for a declaration with an empty initializer", () => {
      expect(verify(`const v = ;`)).toThrow(
        "Top-level value is not allowed in SES mode",
      );
      expect(verify(`const v = ();`)).toThrow(
        "Top-level value is not allowed in SES mode",
      );
    });
  });

  describe("statement shapes", () => {
    it("throws unless a declaration initializes a simple identifier", () => {
      expect(verify(`const v;`)).toThrow(
        "Top-level declarations must initialize their bindings",
      );
      expect(verify(`const { v } = { v: 1 };`)).toThrow(
        "Top-level declarations must bind simple identifiers",
      );
      expect(verify(`const v = 1;`)).not.toThrow();
    });

    it("throws for an export that is not a direct assignment", () => {
      expect(verify(`exports.v;`)).toThrow(
        "Compiled exports must use direct assignment",
      );
      expect(verify(`exports.v = 1;`)).not.toThrow();
    });

    it("throws for an anonymous top-level function statement", () => {
      expect(verify(`function () {}`)).toThrow(UNSUPPORTED);
      expect(verify(`function named() {}`)).not.toThrow();
    });

    it("throws for an empty `__cfReg` registration", () => {
      expect(verify(`__cfReg({});`)).toThrow(UNSUPPORTED);
      expect(verify(`const f = () => {};\n__cfReg({ f });`)).not.toThrow();
    });

    it("reports a rejection at the statement's position", () => {
      let error: unknown;
      try {
        verifyCompiledModuleBody(`const a = 1;\nclass B {}`, "/main.tsx");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ModuleVerificationError);
      expect((error as Error).message).toContain("/main.tsx:3:1");
    });
  });
});
