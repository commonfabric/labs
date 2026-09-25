/**
 * Security invariants for the `__cfReg` content-addressed registration
 * mechanism. The compiled module body is treated as UNTRUSTED, and
 * the defenses live in four layers: the verifier, the registrar capability,
 * the per-value trust gate, and content addressing.
 *
 * The runtime layers are pinned here — the approval signal, the rejecting
 * registrar and the sink it leaves untouched, the trust gate, the
 * transformer↔verifier round trip, and re-registration under one identity.
 * The adversarial verifier corpus lives in esm-verifier-adversarial.test.ts,
 * and defense-in-depth on the real registrar (run-once, closed-window,
 * transactional) in cfreg-builder-identity.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  createHoistRegistrar,
  createRejectingRegistrar,
  type HoistRegistrationSink,
} from "../src/sandbox/module-record-compiler.ts";
import { verifyCompiledModuleBody } from "../src/sandbox/module-record-verifier.ts";
import {
  brandTrustedBuilderArtifact,
  isTrustedBuilderArtifact,
  noteDerivedCopy,
} from "../src/builder/pattern-metadata.ts";

const IMPORT = `const cf = require("commonfabric");`;

describe("verifyCompiledModuleBody reports hoist-registration approval", () => {
  // The verifier reports whether a module has a VALID approved `__cfReg` call.
  // The loader uses this to grant the real registrar only to approved modules
  // (and a throwing one to the rest) — so this signal is load-bearing.

  it("is true for a module with an approved __cfReg call", () => {
    const body =
      `${IMPORT}\nconst __cfPattern_1 = (0, cf.pattern)((s) => s);\n__cfReg({ __cfPattern_1 });`;
    expect(verifyCompiledModuleBody(body, "/main.tsx").hasHoistRegistration)
      .toBe(true);
  });

  it("is false for a module with no __cfReg call", () => {
    const body = `${IMPORT}\nexports.default = (0, cf.pattern)((s) => s);`;
    expect(verifyCompiledModuleBody(body, "/main.tsx").hasHoistRegistration)
      .toBe(false);
  });
});

describe("createRejectingRegistrar", () => {
  // A module the verifier did NOT approve gets the rejecting registrar, so a
  // `__cfReg` call the static check missed (e.g. smuggled inside an accepted
  // expression) fails closed at runtime instead of registering attacker values.

  it("throws on any registration attempt", () => {
    const { register } = createRejectingRegistrar();
    expect(() => register({ __cfPattern_1: {} })).toThrow(
      /no verifier-approved registration/,
    );
  });

  it("has a no-op commit (nothing was staged)", () => {
    const { commit } = createRejectingRegistrar();
    expect(() => commit()).not.toThrow();
  });
});

describe("isTrustedBuilderArtifact rejects forged values", () => {
  // The load-bearing trust gate: only a genuine branded builder artifact may
  // acquire a content-addressed ref. The verifier intentionally does NOT check
  // the registered value's kind, so `indexArtifact`'s
  // `isTrustedBuilderArtifact` is the single boundary that stops forgery — pin
  // it hard.

  it("rejects plain objects, functions, and frozen data", () => {
    expect(isTrustedBuilderArtifact({})).toBe(false);
    expect(isTrustedBuilderArtifact(() => {})).toBe(false);
    expect(isTrustedBuilderArtifact(Object.freeze({ a: 1 }))).toBe(false);
    expect(isTrustedBuilderArtifact(null)).toBe(false);
    expect(isTrustedBuilderArtifact(undefined)).toBe(false);
    expect(isTrustedBuilderArtifact(42)).toBe(false);
  });

  it("rejects a pattern-shaped object with no brand (forged __cf_data)", () => {
    const forged = Object.freeze({
      argumentSchema: true,
      resultSchema: true,
      nodes: [],
    });
    expect(isTrustedBuilderArtifact(forged)).toBe(false);
  });

  it("is not fooled by ANY own property pointing at a branded value", () => {
    // Trust lives exclusively in runner-private WeakSets/WeakMaps
    // (pattern-metadata.ts); no property an attacker can set on an object —
    // string-keyed, symbol-keyed, or otherwise — can launder trust onto it.
    const branded = brandTrustedBuilderArtifact({});
    const forged = {
      ["unsafe_originalPattern"]: branded,
      [Symbol("unsafe_originalPattern")]: branded,
      original: branded,
    };
    expect(isTrustedBuilderArtifact(forged)).toBe(false);
  });

  it("accepts a genuinely branded artifact (and registered derived copies)", () => {
    const artifact = brandTrustedBuilderArtifact({});
    expect(isTrustedBuilderArtifact(artifact)).toBe(true);
    // A derivation copy registered by a runner-owned copy site inherits trust
    // (the legitimate path noteDerivedCopy exists for).
    const copy = {};
    noteDerivedCopy(copy, artifact);
    expect(isTrustedBuilderArtifact(copy)).toBe(true);
  });
});

describe("HoistRegistrationSink stays untouched on a rejected registration", () => {
  it("an approved registrar still stages+commits normally", () => {
    const sink: HoistRegistrationSink = new Map();
    const { register, commit } = createHoistRegistrar("id", sink);
    register({ __cfPattern_1: brandTrustedBuilderArtifact({}) });
    commit();
    expect(sink.get("id")?.has("__cfPattern_1")).toBe(true);
  });
});

describe("transformer __cfReg emit round-trips through the verifier", () => {
  // The CONTRACT between the transformer's emitted `__cfReg({ … })` shape
  // and the verifier's static approval check. The transformer and the
  // verifier hold two independent definitions of "a valid registration
  // call"; if they drift, a real registration silently routes to the
  // rejecting registrar (fail-closed, but a confusing breakage). These pin
  // the exact shapes the transformer emits (builder-call-hoisting.ts: a
  // trailing call whose argument is a multiline shorthand object of
  // previously-declared top-level bindings) as APPROVED, and assert the
  // tamper shapes the verifier is meant to refuse are not.

  it("approves the exact multiline shorthand shape the transformer emits", () => {
    // Mirrors builder-call-hoisting.ts: `factory.createObjectLiteralExpression(
    // …, /* multiline */ true)` over shorthand assignments — one entry per line.
    const body = `${IMPORT}
const __cfPattern_1 = (0, cf.pattern)((s) => s);
const __cfLift_1 = (0, cf.lift)((x) => x);
__cfReg({
    __cfPattern_1,
    __cfLift_1
});`;
    expect(verifyCompiledModuleBody(body, "/main.tsx").hasHoistRegistration)
      .toBe(true);
  });

  it("approves the single-entry trailing-comma form", () => {
    const body = `${IMPORT}
const __cfLift_1 = (0, cf.lift)((x) => x);
__cfReg({
    __cfLift_1,
});`;
    expect(verifyCompiledModuleBody(body, "/main.tsx").hasHoistRegistration)
      .toBe(true);
  });

  it("does NOT approve a __cfReg over a binding that was never declared", () => {
    // Every key must be a previously-seen top-level binding. A registration that
    // names an undeclared symbol is not a valid call (the whole statement then
    // falls through to unknown-identifier rejection — the body is refused).
    const body = `${IMPORT}\n__cfReg({ __cfPattern_99 });`;
    expect(() => verifyCompiledModuleBody(body, "/main.tsx")).toThrow();
  });

  it("does NOT approve a key:value registration outside the alias form", () => {
    // A `key: value` entry is valid ONLY as a positional alias
    // (`__cf<Kind>_<n>: __cf<Kind>_h<digest>` over a declared binding); any
    // other value expression is refused — the value could otherwise be an
    // arbitrary expression.
    const body =
      `${IMPORT}\nconst __cfLift_1 = (0, cf.lift)((x) => x);\n__cfReg({ __cfLift_1: globalThis });`;
    expect(() => verifyCompiledModuleBody(body, "/main.tsx")).toThrow();
  });

  it("approves a positional alias naming a declared canonical hoist", () => {
    const body = `${IMPORT}
const __cfLift_h0123456789ab = (0, cf.lift)((x) => x);
__cfReg({ __cfLift_h0123456789ab, __cfLift_1: __cfLift_h0123456789ab });`;
    expect(verifyCompiledModuleBody(body, "/main.tsx").hasHoistRegistration)
      .toBe(true);
  });

  it("does NOT approve an alias whose canonical was never declared", () => {
    const body = `${IMPORT}\n__cfReg({ __cfLift_1: __cfLift_h0123456789ab });`;
    expect(() => verifyCompiledModuleBody(body, "/main.tsx")).toThrow();
  });

  it("does NOT approve an alias over a non-hoist-shaped value name", () => {
    // The alias VALUE must be a content-addressed hoist name, so an authored
    // binding cannot be smuggled behind the compiler's numeric namespace.
    const body = `${IMPORT}
const helper = (0, cf.lift)((x) => x);
__cfReg({ helper, __cfLift_1: helper });`;
    expect(() => verifyCompiledModuleBody(body, "/main.tsx")).toThrow();
  });

  it("refuses a second top-level __cfReg call (tampering signal)", () => {
    const body = `${IMPORT}
const __cfLift_1 = (0, cf.lift)((x) => x);
__cfReg({ __cfLift_1 });
__cfReg({ __cfLift_1 });`;
    expect(() => verifyCompiledModuleBody(body, "/main.tsx")).toThrow();
  });
});

describe("re-registration under the same identity commits the fresh staged set", () => {
  it("a later commit replaces the sink entry for that identity", () => {
    // The outdated-overwrite contract at the public sink layer.
    // `indexArtifact` overwrites the reverse mapping on re-eval so by-identity
    // LOOKUP is always fresh; the same freshness must hold one layer down,
    // where a module that re-evaluates (same identity, fresh artifact
    // instance) re-stages and commits. A second commit under the same
    // identity must REPLACE the prior staged map, not merge a stale instance
    // into it.

    const sink: HoistRegistrationSink = new Map();

    const first = brandTrustedBuilderArtifact({});
    const r1 = createHoistRegistrar("idX", sink);
    r1.register({ __cfLift_1: first });
    r1.commit();
    expect(sink.get("idX")?.get("__cfLift_1")).toBe(first);

    // Re-eval of the same module identity yields a fresh registrar + instance.
    const second = brandTrustedBuilderArtifact({});
    const r2 = createHoistRegistrar("idX", sink);
    r2.register({ __cfLift_1: second });
    r2.commit();
    // The sink reflects the freshest instance, never the stale one.
    expect(sink.get("idX")?.get("__cfLift_1")).toBe(second);
    expect(sink.get("idX")?.get("__cfLift_1")).not.toBe(first);
  });
});
