import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBindingIdentityHelperSource } from "@commonfabric/utils/sandbox-contract";
import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";

// These tests guard the format-agnostic SES module-item classification rules
// (the `classifyModuleItems` core) through the live enforcement entry point,
// `verifyCompiledModuleBody` — the module-body verifier. Each case is one
// compiled module body in compiled-CommonJS form, with a `require()` import
// preamble ahead of the top-level items under test.
//
// Broad accept/reject parity cases (mutable bindings, classes, generators,
// IIFEs, raw mutable exports, import policy) live in
// esm-verifier-parity.test.ts and esm-module-body-verifier.test.ts; the
// `__cfReg` registration rules live in cfreg-security.test.ts. This file keeps
// the finer-grained classifier shapes those suites do not cover.

const IMPORT = `const commonfabric_1 = require("commonfabric");`;

function verify(body: string) {
  return verifyCompiledModuleBody(body, "/main.tsx");
}

describe("verifyCompiledModuleBody() classifier shapes", () => {
  it("accepts the no-input lift(fn, false) form at module scope", () => {
    // The transformer hoists a `lift(fn, false)()` computation to a module-
    // scope const, surfacing the no-input form (argumentSchema:false) to the
    // module-scope verifier. lift is function-first, so the callback is the
    // FIRST argument and `false` (the argument schema) trails at index 1.
    const body = `
${IMPORT}
const __cfLift_1 = (0, commonfabric_1.lift)(() => 42, false);
exports.default = (0, commonfabric_1.handler)(false, false, () => [__cfLift_1()][0]);
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts the 2-arg lift(fn, options) form (callback at index 0)", () => {
    // `lift` overloads on argument TYPE, not arity: `lift(fn, options)` is a
    // valid 2-arg form whose callback is the FIRST argument (options second).
    // The verifier must disambiguate by which position is the function — not
    // assume a 2-arg lift always has its callback at index 1.
    const body = `
${IMPORT}
const __cfLift_1 = (0, commonfabric_1.lift)(() => 42, { materializerWriteInputPaths: [["x"]] });
exports.default = (0, commonfabric_1.handler)(false, false, () => [__cfLift_1()][0]);
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts a hoisted handler(...) call at module scope", () => {
    // Whole-call hoisting reaches `handler` too. A reactive handler (or an
    // `action` lowered to one) is hoisted to a module-scope
    // const `__cfHandler_N = handler(eventSchema, stateSchema, cb)`, with the
    // captures applied at the original site. The 3-arg form puts the callback
    // at index 2; the verifier must accept this trusted-builder call at module
    // scope and verify the callback there.
    const body = `
${IMPORT}
const __cfHandler_1 = (0, commonfabric_1.handler)(false, false, (_event, { count }) => count.set(count.get() + 1));
exports.default = (0, commonfabric_1.pattern)((__cf_pattern_input) => ({
  inc: __cfHandler_1({ count: __cf_pattern_input.key("count") }),
}));
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts a hoisted pattern(...) call at module scope", () => {
    // Whole-call hoisting reaches `pattern` too. A reactive map lowers
    // to `receiver.mapWithPattern(pattern(cb, inSchema, outSchema), { params })`;
    // the bare `pattern(...)` (the first mapWithPattern argument) is hoisted to
    // a module-scope const `__cfPattern_N = pattern(...)` with the callback
    // inline, and the call site reads `mapWithPattern(__cfPattern_N, { params })`.
    // The verifier must accept this trusted-builder call at module scope and
    // verify its callback (index 0) there.
    const body = `
${IMPORT}
const __cfPattern_1 = (0, commonfabric_1.pattern)((__cf_pattern_input) => {
  const item = __cf_pattern_input.key("element");
  return item.key("name");
}, false, false);
exports.default = (0, commonfabric_1.pattern)((__cf_pattern_input) => ({
  names: __cf_pattern_input.key("items").mapWithPattern(__cfPattern_1, {}),
}));
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled dependencies from the shared runtime-module policy", () => {
    const body = `
const _schema = require("commonfabric/schema");
const turndown_1 = __importDefault(require("turndown"));
exports.default = turndown_1.default;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("rejects imports outside the shared runtime-module policy", () => {
    const body = `
const evil_1 = require("evil");
exports.default = evil_1.default;
`;

    expect(() => verify(body)).toThrow();
  });

  it("rejects default exports of trusted runtime helper references", () => {
    const body = `
${IMPORT}
exports.default = commonfabric_1.pattern;
`;

    expect(() => verify(body)).toThrow(
      "Default exports must be trusted builders, direct functions, verified data, or import re-exports",
    );
  });

  it("rejects default exports of trusted runtime helper aliases", () => {
    const body = `
${IMPORT}
const rawPattern = commonfabric_1.pattern;
exports.default = rawPattern;
`;

    expect(() => verify(body)).toThrow(
      "Default exports must be trusted builders, direct functions, verified data, or import re-exports",
    );
  });

  it("accepts verified top-level function declarations for compiled trusted builders", () => {
    const body = `
${IMPORT}
function sanitize(value) {
  return (value == null ? "" : value).trim();
}
exports.default = (0, commonfabric_1.lift)(sanitize);
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts canonical verified binding annotation statements at module scope", () => {
    const body = `
${IMPORT}
${createBindingIdentityHelperSource()}
function localFunction(value) { return value.toUpperCase(); }
__cfBindVerifiedBinding(localFunction, {
  sourceFile: "/main.tsx",
  bindingPath: ["localFunction"]
});
exports.default = (0, commonfabric_1.lift)(localFunction);
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts canonical verified binding annotation for trusted builder results", () => {
    const body = `
${IMPORT}
${createBindingIdentityHelperSource()}
const saveTitle = (0, commonfabric_1.handler)(true, true, (_event, { title }) => title);
__cfBindVerifiedBinding(saveTitle, {
  sourceFile: "/main.tsx",
  bindingPath: ["saveTitle"]
});
exports.default = saveTitle;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled JSX intrinsic tags inside trusted builder callbacks", () => {
    const body = `
${IMPORT}
exports.default = (0, commonfabric_1.pattern)(() => {
  return {
    ui: h("div", null, h("cf-screen", null, "Hello")),
  };
});
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts destructured compiled builder callbacks with injected schema args", () => {
    const body = `
${IMPORT}
const count = (0, commonfabric_1.schema)({ type: "number" });
exports.default = (0, commonfabric_1.pattern)(({ count: value }) => ({
  data: { value },
}), false, {
  type: "object",
  properties: {
    data: { type: "object" },
  },
});
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts canonical compiled function hardening", () => {
    const body = `
function __cfHardenFn(fn) {
  Object.freeze(fn);
  const prototype = fn.prototype;
  if (prototype && typeof prototype === "object") {
    Object.freeze(prototype);
  }
  return fn;
}
const step = __cfHardenFn(() => 42);
exports.default = step;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts regex literals inside compiled helper functions", () => {
    const body = `
${IMPORT}
function clean(content) {
  return content.replace(/\\n+/g, " ").trim();
}
exports.default = (0, commonfabric_1.lift)(clean);
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts pure ambient global helper captures in compiled callbacks", () => {
    const body = `
${IMPORT}
exports.default = (0, commonfabric_1.lift)(() => ({
  parsed: parseInt("42", 10),
  float: parseFloat("3.14"),
  nan: isNaN(Number("x")),
  finite: isFinite(12),
}));
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts ambient base64 helpers in compiled callbacks", () => {
    const body = `
${IMPORT}
exports.default = (0, commonfabric_1.lift)(() => atob("YQ=="));
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled __cf_data() with intrinsic collection helpers and local helpers", () => {
    const body = `
${IMPORT}
function buildYears() {
  const currentYear = new Date().getFullYear();
  const years = [];
  for (let year = currentYear; year >= currentYear - 2; year--) {
    years.push(String(year));
  }
  return years;
}
const scopeMap = (0, commonfabric_1.__cf_data)({ gmail: "gmail.readonly" });
const years = (0, commonfabric_1.__cf_data)(buildYears());
const scopes = (0, commonfabric_1.__cf_data)(Object.fromEntries(Object.entries(scopeMap).map(([key, value]) => [key, { value }])));
const payload = (0, commonfabric_1.__cf_data)({ years, scopes });
exports.default = payload;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled nested __cfHelpers.__cf_data() runtime helper calls", () => {
    const body = `
${IMPORT}
const startedAt = commonfabric_1.__cfHelpers.__cf_data(Date.now());
const seed = commonfabric_1.__cfHelpers.__cf_data(Math.random());
exports.default = (0, commonfabric_1.__cf_data)({ startedAt, seed });
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled __cf_data() references rewritten through exports", () => {
    const body = `
${IMPORT}
exports.MODULE_METADATA = exports.STANDARD_LABELS = void 0;
exports.STANDARD_LABELS = (0, commonfabric_1.__cf_data)(["Personal", "Work"]);
exports.MODULE_METADATA = (0, commonfabric_1.__cf_data)({
  type: "email",
  label: "Email",
  schema: {
    label: {
      enum: exports.STANDARD_LABELS,
    },
  },
});
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled __cf_data() helpers that use for...of iteration", () => {
    const body = `
${IMPORT}
function buildIndex() {
  const index = new Map();
  for (const [group, members] of Object.entries({ dairy: ["milk"] })) {
    for (const member of members) {
      index.set(member, [group]);
    }
  }
  return index;
}
const parentIndex = (0, commonfabric_1.__cf_data)(buildIndex());
exports.default = parentIndex;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled callbacks that declare nested callback parameters", () => {
    const body = `
${IMPORT}
exports.default = (0, commonfabric_1.lift)((items) => items.map((_item) => _item + 1));
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled trusted callbacks that contain nested handler parameters", () => {
    const body = `
${IMPORT}
exports.default = (0, commonfabric_1.pattern)(() => ({
  addChild: (0, commonfabric_1.handler)(false, {
    type: "object",
    properties: {
      children: { type: "array", items: { type: "number" }, asCell: ["cell"] }
    },
    required: ["children"]
  }, (_, { children }) => children.push(1))({ children: [] }),
}));
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled helper functions that only close over __cf_data()", () => {
    const body = `
${IMPORT}
const STANDARD_LABELS = (0, commonfabric_1.__cf_data)({ email: ["Personal", "Work"] });
function getNextUnusedLabel(type) {
  const standards = STANDARD_LABELS[type];
  return standards || undefined;
}
exports.default = (0, commonfabric_1.lift)(() => getNextUnusedLabel("email"));
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled __cf_data() accessors with inert bodies", () => {
    const body = `
${IMPORT}
const data = (0, commonfabric_1.__cf_data)({
  get value() {
    return 1;
  },
  set value(_next) {
    "use strict";
  },
});
exports.default = data;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled __cf_data() accessors without inspecting captured bindings", () => {
    const body = `
${IMPORT}
const helper_1 = require("./helper.ts");
const data = (0, commonfabric_1.__cf_data)({
  get value() {
    return helper_1.state;
  },
});
exports.default = data;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled builder callbacks that capture top-level schema snapshots", () => {
    const body = `
${IMPORT}
const state = (0, commonfabric_1.schema)({ type: "object", properties: { count: { type: "number" } } });
exports.default = (0, commonfabric_1.lift)(() => state.type);
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled builder callbacks that reference their own top-level binding", () => {
    const body = `
${IMPORT}
const Note = (0, commonfabric_1.pattern)(() => ({
  json: JSON.stringify(Note),
}));
exports.default = Note;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts compiled callbacks that capture later const helper bindings", () => {
    const body = `
${IMPORT}
const readValue = (0, commonfabric_1.lift)((value) => formatValue(value));
const formatValue = (value) => {
  return value;
};
exports.default = readValue;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("rejects raw top-level helper calls without __cf_data()", () => {
    const body = `
function build() {
  return { count: 1 };
}
exports.default = build();
`;

    expect(() => verify(body)).toThrow();
  });

  it("accepts generated pattern coverage hits at module scope", () => {
    const body = `
(globalThis.__cfPatternCoverage?.hit)("/main.tsx", 1);
exports.default = 42;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts generated pattern coverage hits with unparenthesized callees", () => {
    const body = `
globalThis.__cfPatternCoverage?.hit("/main.tsx", 1);
exports.default = 42;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("accepts generated pattern coverage hits with commas in filenames", () => {
    const body = `
globalThis.__cfPatternCoverage?.hit("/a,b.tsx", 1);
exports.default = 42;
`;

    expect(() => verify(body)).not.toThrow();
  });

  it("rejects coverage-looking hits with executable filename arguments", () => {
    const body = `
(globalThis.__cfPatternCoverage?.hit)("/main.tsx" + (() => {
  throw new Error("ran");
})() + "", 1);
exports.default = 42;
`;

    expect(() => verify(body)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects coverage-looking hits with non-integer span ids", () => {
    const body = `
(globalThis.__cfPatternCoverage?.hit)("/main.tsx", 1 + 1);
exports.default = 42;
`;

    expect(() => verify(body)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects coverage-looking hits with the wrong callee", () => {
    const body = `
(globalThis.__cfPatternCoverage?.miss)("/main.tsx", 1);
exports.default = 42;
`;

    expect(() => verify(body)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects coverage-looking hits with the wrong argument count", () => {
    const oneArg = `
(globalThis.__cfPatternCoverage?.hit)("/main.tsx");
exports.default = 42;
`;
    const threeArgs = `
(globalThis.__cfPatternCoverage?.hit)("/main.tsx", 1, true);
exports.default = 42;
`;

    expect(() => verify(oneArg)).toThrow(
      "unsupported top-level executable code",
    );
    expect(() => verify(threeArgs)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects coverage hits with trailing executable comma expressions", () => {
    const body = `
(globalThis.__cfPatternCoverage?.hit)("/main.tsx", 1), eval("x");
exports.default = 42;
`;

    expect(() => verify(body)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects executable statements after generated coverage hits", () => {
    const body = `
(globalThis.__cfPatternCoverage?.hit)("/main.tsx", 1);eval("x");
exports.default = 42;
`;

    expect(() => verify(body)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects a coverage callee split by Unicode whitespace", () => {
    const nbsp = "\u00A0";
    const body = `
(globalThis.__cfPattern${nbsp}Coverage?.hit)("/main.tsx", 1);
exports.default = 42;
`;

    expect(() => verify(body)).toThrow();
    let v8Rejected = false;
    try {
      new Function(body);
    } catch {
      v8Rejected = true;
    }
    expect(v8Rejected).toBe(true);
  });

  it("rejects compiled fragment mutation escape hatches at module scope", () => {
    const body = `
function counter() {
  const self = counter;
  self.fragment.count += 1;
  return self.fragment.count;
}
counter.fragment = { count: 0 };
exports.default = counter;
`;

    expect(() => verify(body)).toThrow(
      "unsupported top-level executable code",
    );
  });

  it("rejects direct require() calls outside the import preamble", () => {
    // A bare `require("./dep.ts")` in export position is not the canonical
    // `const x = require(...)` preamble; it must fall through to
    // classification and be rejected, never executed.
    const body = `
exports.default = require("./dep.ts");
`;

    expect(() => verify(body)).toThrow();
  });

  it("rejects top-level patternTool() calls in compiled modules", () => {
    const body = `
${IMPORT}
exports.default = (0, commonfabric_1.patternTool)(() => ({ ok: true }));
`;

    expect(() => verify(body)).toThrow(
      "Only trusted builder calls, schema(), canonical function hardening, and canonical binding annotation are allowed at module scope in SES mode",
    );
  });
});

it("accepts multiUserTest's descriptor of trusted-builder results", () => {
  // The one builder WITHOUT a callback: it tags a descriptor object whose
  // leaves are other trusted-builder results, so each argument verifies as
  // a trusted value expression rather than through the callback path. The
  // real shape `cf test` compiles: patterns hoisted to module consts, then
  // `multiUserTest({ setup, participants: { ... } })` as the default
  // export. Pinned here deterministically — this branch was otherwise
  // covered only when integration sharding happened to compile a
  // multi-user fixture, which made the coverage gate's runner count
  // flutter by scheduling rather than by anyone's diff.
  const body = `
${IMPORT}
const __cfPattern_1 = (0, commonfabric_1.pattern)(() => ({}));
const __cfPattern_2 = (0, commonfabric_1.pattern)(() => ({}));
const __cfPattern_3 = (0, commonfabric_1.pattern)(() => ({}));
exports.default = (0, commonfabric_1.multiUserTest)({ setup: __cfPattern_1, participants: { gideon: __cfPattern_2, fable: __cfPattern_3 } });
`;

  expect(() => verify(body)).not.toThrow();
});
