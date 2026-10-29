import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createFactoryShadowGuardSource } from "@commonfabric/utils/sandbox-contract";

import {
  type BindingInfo,
  classifyModuleItems,
  RESERVED_FACTORY_BINDING_SET,
} from "../src/sandbox/compiled-bundle-verifier.ts";
import { parseFunctionText } from "../src/sandbox/compiled-js-parser.ts";

// The security classifier is format-agnostic: it classifies a module's top-level
// items (compiled-CJS form) against a pre-seeded binding env, independent of how
// the body is wrapped. `verifyCompiledModuleBody` — the production caller —
// passes empty guard/reserved sets, since no loader binding is in scope around a
// module body. These tests exercise both the empty and non-empty configurations,
// so the shadow-guard and reserved-binding paths stay covered.
//
// The empty set is load-bearing, not a stub: the canonical reserved set IS the
// set of names the transformer emits as shadow guards, so reserving them would
// reject transformer output. The last case below pins that relationship, which is
// why no parameter may default to the canonical set.

function bodyStatements(body: string) {
  const fn = parseFunctionText(body, 0, body.length);
  return { source: body, statements: fn.body.statements };
}

const EMPTY_GUARD_OPTIONS = {
  requiredGuards: new Set<string>(),
  reservedBindings: new Set<string>(),
  missingGuardsErrorAt: 0,
};

describe("classifyModuleItems (format-agnostic security core)", () => {
  it("accepts a guard-free module body when no shadow guards are required", () => {
    const body =
      `function () { const greet = (n) => n + 1; exports.greet = greet; }`;
    const { source, statements } = bodyStatements(body);
    const env = new Map<string, BindingInfo>();
    expect(() =>
      classifyModuleItems(source, "<m>", statements, env, EMPTY_GUARD_OPTIONS)
    ).not.toThrow();
  });

  it("still rejects unwrapped mutable top-level data (security rule is format-agnostic)", () => {
    const body =
      `function () { const config = { a: 1 }; exports.config = config; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        EMPTY_GUARD_OPTIONS,
      )
    ).toThrow(/__cf_data/);
  });

  it("honors empty reservedBindings for const declarations", () => {
    // With no reserved names (the production configuration), a const named
    // `define` is allowed. Verifies reservedBindings reaches the
    // variable-declaration path, not only the function-declaration path.
    const body =
      `function () { const define = (n) => n; exports.define = define; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        EMPTY_GUARD_OPTIONS,
      )
    ).not.toThrow();
    // With `define` reserved, the same const name is rejected.
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        {
          ...EMPTY_GUARD_OPTIONS,
          reservedBindings: new Set(["define"]),
        },
      )
    ).toThrow(/Reserved wrapper binding/);
  });

  it("still rejects top-level mutable bindings (let/var)", () => {
    const body = `function () { let counter = 0; exports.counter = counter; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        EMPTY_GUARD_OPTIONS,
      )
    ).toThrow(/mutable/i);
  });

  it("classifies a bracket-notation member reference against a known root", () => {
    // Pins the quoted-bracket branch of the member-reference parser
    // (`greet["helper"]`), which compiled bundles only reach when a pattern
    // happens to emit bracket access — CI coverage of it was flapping
    // run-to-run. The root binding is known, so classification succeeds.
    const body =
      `function () { const greet = (n) => n + 1; exports.greet = greet; exports.alias = greet["helper"]; }`;
    const { source, statements } = bodyStatements(body);
    const env = new Map<string, BindingInfo>();
    expect(() =>
      classifyModuleItems(source, "<m>", statements, env, EMPTY_GUARD_OPTIONS)
    ).not.toThrow();
  });

  it("rejects bracket notation with a non-string or unterminated key", () => {
    // The parser only admits quoted keys; a computed index falls out of the
    // member grammar and the reference is rejected as a top-level value.
    const body =
      `function () { const greet = (n) => n + 1; exports.greet = greet; exports.alias = greet[0]; }`;
    const { source, statements } = bodyStatements(body);
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        EMPTY_GUARD_OPTIONS,
      )
    ).toThrow(/SES mode/);
  });

  it("the canonical reserved set would reject the transformer's own shadow guards", () => {
    // Why the production path MUST pass an empty reservedBindings set, and why no
    // parameter may default to RESERVED_FACTORY_BINDING_SET: that set is exactly
    // the names `createFactoryShadowGuardSource()` emits, so turning the check on
    // rejects every transformed module on its own guards.
    const guards = createFactoryShadowGuardSource();
    expect(guards.length).toBeGreaterThan(0);
    const body = `function () {\n${guards.join("\n")}\n}`;
    const { source, statements } = bodyStatements(body);

    // Empty (production): the guards verify as ordinary primitive consts.
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        EMPTY_GUARD_OPTIONS,
      )
    ).not.toThrow();

    // Canonical reserved set: the very same body is rejected.
    expect(() =>
      classifyModuleItems(
        source,
        "<m>",
        statements,
        new Map<string, BindingInfo>(),
        {
          ...EMPTY_GUARD_OPTIONS,
          reservedBindings: RESERVED_FACTORY_BINDING_SET,
        },
      )
    ).toThrow(/Reserved wrapper binding/);
  });

  describe("the `new` keyword at module scope", () => {
    // A top-level construction is mutable data, so the classifier refuses it
    // unless it is wrapped. Trivia stripping runs `new Map()` together into
    // `newMap()`, which is why these cases put the keyword next to each kind
    // of character that can follow it, and an identifier that merely begins
    // with `new` next to them.

    function classify(body: string) {
      const { source, statements } = bodyStatements(body);
      return () =>
        classifyModuleItems(
          source,
          "<m>",
          statements,
          new Map<string, BindingInfo>(),
          EMPTY_GUARD_OPTIONS,
        );
    }

    it("accepts an exported function whose name begins with `new`", () => {
      expect(
        classify(
          `function () { function newThing(n) { return n + 1; } exports.newThing = newThing; }`,
        ),
      ).not.toThrow();
    });

    it("accepts a reference to a const function whose name is `new` plus a constructor name", () => {
      expect(
        classify(
          `function () { const newMap = (n) => n; exports.newMap = newMap; }`,
        ),
      ).not.toThrow();
    });

    it("throws for a call to a local function whose name begins with `new`", () => {
      expect(
        classify(
          `function () { function newThing() { return {}; } exports.thing = newThing(); }`,
        ),
      ).toThrow(/Top-level call results must be wrapped/);
    });

    it("throws for an unknown identifier whose name begins with `new`", () => {
      expect(
        classify(`function () { exports.thing = newThing; }`),
      ).toThrow(/Unknown top-level identifier 'newThing'/);
    });

    it("throws for `new Map()` bound at module scope", () => {
      expect(
        classify(`function () { const map = new Map(); exports.map = map; }`),
      ).toThrow(/Mutable top-level data must be wrapped/);
    });

    it("throws for `new` preceded by a comment", () => {
      expect(
        classify(`function () { exports.map = /* c */ new Map(); }`),
      ).toThrow(/Mutable top-level data must be wrapped/);
    });

    it("throws for `new` followed by a comment", () => {
      expect(
        classify(`function () { exports.map = new/* c */Map(); }`),
      ).toThrow(/Mutable top-level data must be wrapped/);
    });

    it("throws for `new` followed by a parenthesized constructor", () => {
      expect(
        classify(`function () { exports.map = new(Map)(); }`),
      ).toThrow(/Mutable top-level data must be wrapped/);
    });

    it("throws for `new` inside wrapping parentheses", () => {
      expect(
        classify(`function () { exports.map = (new Map); }`),
      ).toThrow(/Mutable top-level data must be wrapped/);
    });

    it("throws for `new.target`", () => {
      expect(
        classify(`function () { exports.target = new.target; }`),
      ).toThrow(/Mutable top-level data must be wrapped/);
    });
  });
});
