/**
 * Regression guard for $ref resolution inside policy value matching.
 *
 * The schema generator emits named types as `#/$defs/<name>` refs with the
 * `$defs` on the root schema (e.g. profile-home's owner-protected `elements`
 * list: `{type: "array", items: {$ref: "#/$defs/ProfileElement"}, ifc,
 * $defs}`). The pre-fix matcher recursed into `properties`/`items`/compound
 * branches without threading the root document, so a nested `$ref` was
 * resolved against the bare ref node itself, warned "Unresolved $ref", and
 * failed closed — the policy entry was treated as not applying even though the
 * schema was valid. Only a ref that is genuinely unresolvable against its
 * document may fail closed.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { wildcardPolicyMatchesValue } from "../src/cfc/prepare.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

describe("CFC policy value matching resolves $refs against the schema root", () => {
  const space = "did:key:policy-schema-refs" as const;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };
  const tx = {
    getWriteDetails: () => [],
    readValueOrThrow: () => undefined,
  } as unknown as IExtendedStorageTransaction;

  it("matches an array value whose items schema is a #/$defs ref", () => {
    const schema = {
      type: "array",
      items: { $ref: "#/$defs/ProfileElement" },
      ifc: { writeAuthorizedBy: ["trusted-handler"] },
      $defs: {
        ProfileElement: {
          type: "object",
          properties: { cell: true, tag: { type: "string" } },
          required: ["cell"],
        },
      },
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, [
      { cell: { some: "link" }, tag: "profile-card" },
    ])).toBe(true);
  });

  it("value-conditions through a nested property $ref", () => {
    const schema = {
      type: "object",
      properties: { element: { $ref: "#/$defs/Element" } },
      $defs: {
        Element: { type: "string" },
      },
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, {
      element: "ok",
    })).toBe(true);
    expect(wildcardPolicyMatchesValue(tx, target, schema, {
      element: 42,
    })).toBe(false);
  });

  it("fails closed (entry applies) on a genuinely unresolvable nested $ref", () => {
    // A value-condition ref that cannot be resolved against its own document
    // leaves the policy unevaluable. The policy schema is the authority we are
    // enforcing, so an unevaluable condition must NOT silently exclude the ifc
    // entry — that would skip its writeAuthorizedBy/maxConfidentiality checks
    // (fail open). `wildcardPolicyMatchesValue` returning true here means the
    // entry applies, mirroring the unresolvable-LINK branch (audit S17).
    const schema = {
      type: "array",
      items: { $ref: "#/$defs/Missing" },
      $defs: {
        Present: { type: "string" },
      },
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, [{ x: 1 }]))
      .toBe(true);
  });
});

describe("CFC writeAuthorizedBy policy applies when its value-condition $ref is unresolvable", () => {
  // A write-authority policy whose value condition is carried by a `$ref` (the
  // generated array-items shape) must still apply when that ref is
  // unresolvable. Otherwise `ifcEntryAppliesToAttemptedWrite` treats the
  // `writeAuthorizedBy` entry as not applying and the protected write is
  // accepted unverified — a fail-open direction the nearby comment ("must fail
  // closed on unresolved refs") and the S17 link branch both forbid.

  const space = "did:key:policy-schema-refs" as const;
  const target = { space, id: "of:guarded" as const, scope: "space" as const };
  const tx = {
    getWriteDetails: () => [],
    readValueOrThrow: () => undefined,
  } as unknown as IExtendedStorageTransaction;

  it("applies (fail closed) when the items $ref names a dropped $def", () => {
    // The shape a poisoned merge produces: the writeAuthorizedBy-bearing array
    // envelope still references `#/$defs/Element`, but `$defs` no longer carries
    // it (a candidate envelope replaced `$defs` wholesale via the
    // `{...left, ...right}` spread in mergeSchemaNode).
    const schema = {
      type: "array",
      items: { $ref: "#/$defs/Element" },
      ifc: { writeAuthorizedBy: ["trusted-handler"] },
      $defs: {
        SomethingElse: { type: "object" },
      },
    } as const satisfies JSONSchema;

    expect(
      wildcardPolicyMatchesValue(tx, target, schema, [
        { cell: { some: "link" } },
      ]),
    ).toBe(true);
  });

  it("resolves a value-condition $ref against the threaded document root", () => {
    // The real walkIfcSchema shape: the captured ifc node is the bare array
    // envelope WITHOUT `$defs` (those live on the outer document the walk
    // descended from). The policy matcher only resolves `#/$defs/Element` when
    // that document root is threaded in (the `root` argument), so a legitimate
    // generated policy must NOT be treated as unevaluable. Without the threaded
    // root the same ref is spuriously unresolvable and the entry would fail
    // closed on a perfectly valid write (the default-app notebook reload
    // regression).
    const ifcNode = {
      type: "array",
      items: { $ref: "#/$defs/Element" },
      ifc: { writeAuthorizedBy: ["trusted-handler"] },
    } as const satisfies JSONSchema;
    const documentRoot = {
      type: "object",
      properties: { elements: ifcNode },
      $defs: {
        Element: {
          type: "object",
          properties: { cell: true, tag: { type: "string" } },
        },
      },
    } as const satisfies JSONSchema;

    // Threaded root => ref resolves => the matcher evaluates the real items and
    // the entry applies for a matching value.
    expect(
      wildcardPolicyMatchesValue(tx, target, ifcNode, [
        { cell: { some: "link" }, tag: "note" },
      ], documentRoot),
    ).toBe(true);
    // A value that violates the resolved items schema does NOT match — proving
    // the ref actually resolved (rather than short-circuiting to "applies").
    expect(
      wildcardPolicyMatchesValue(tx, target, ifcNode, [
        { cell: { some: "link" }, tag: 42 },
      ], documentRoot),
    ).toBe(false);
    // Same node WITHOUT the threaded root: the bare node has no `$defs`, so the
    // ref is genuinely unevaluable and the entry fails closed (applies).
    expect(
      wildcardPolicyMatchesValue(tx, target, ifcNode, [
        { cell: { some: "link" }, tag: 42 },
      ]),
    ).toBe(true);
  });

  it("does not let an unresolvable branch suppress a matched oneOf entry", () => {
    // Regression guard for the matcher's oneOf arm specifically: returning a
    // plain `true` for the unresolvable branch would make two branches "match"
    // and flip `filter(...).length === 1` to false (fail open). The
    // unevaluable-ref signal must short-circuit the whole match to "applies".
    const schema = {
      oneOf: [
        { type: "object", properties: { kind: { const: "a" } } },
        { $ref: "#/$defs/Missing" },
      ],
    } as const satisfies JSONSchema;

    expect(wildcardPolicyMatchesValue(tx, target, schema, { kind: "a" }))
      .toBe(true);
  });
});
