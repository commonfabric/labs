import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type JSONSchema, type Pattern } from "@commonfabric/runner";
import { validateSchemaValue } from "@commonfabric/runner/cfc";
import type { FabricPrimitiveSchemaType } from "@commonfabric/api";
import type { FabricPrimitive } from "@commonfabric/data-model";
import {
  FABRIC_PRIMITIVE_SCHEMA_TYPES,
  FabricBytes,
} from "@commonfabric/data-model/fabric-primitives";
import { FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY } from "@commonfabric/data-model/for-testing-only";
import { FABRIC_SPECIAL_OBJECT_BRAND } from "@commonfabric/runner/fabric-special-object-brand";
import {
  assertPatternSchemasBackwardCompatible,
  assertSchemaSubset,
  DEFAULT_INERT_SUBSCHEMA_KEYS,
  schemasHaveSameContract,
} from "../src/schema-compatibility.ts";

function pattern(
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
): Pattern {
  return {
    argumentSchema,
    resultSchema,
    derivedInternalCells: [],
    result: {},
    nodes: [],
  };
}

const oldPattern = pattern(
  {
    type: "object",
    properties: {
      value: { type: "number" },
      format: { type: "string" },
    },
    required: ["value"],
  },
  {
    type: "object",
    properties: {
      doubled: { type: "number" },
      status: { type: "string" },
    },
    required: ["doubled"],
  },
);

/**
 * A value of each `FabricPrimitive` class, from the examples the data model
 * keeps complete over its classes.
 */
const FABRIC_PRIMITIVE_VALUES: readonly FabricPrimitive[] = Object.values(
  FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY,
).map(([example]) => example);

/**
 * Returns the value in {@link FABRIC_PRIMITIVE_VALUES} that the schema type
 * `type` matches, which is the one reporting it as `.schemaType`.
 */
function fabricPrimitiveValueOf(
  type: FabricPrimitiveSchemaType,
): FabricPrimitive {
  const found = FABRIC_PRIMITIVE_VALUES.find((value) =>
    value.schemaType === type
  );
  if (found === undefined) {
    throw new Error(`No example reports the schema type \`${type}\`.`);
  }
  return found;
}

/**
 * Returns every string-keyed member on the prototype chain of a value in
 * {@link FABRIC_PRIMITIVE_VALUES} below `Object.prototype`, together with a
 * name none of those values has and the brand key.
 */
function fabricPrimitiveMemberNames(): Set<string> {
  const names = new Set(["absentFromEveryClass", FABRIC_SPECIAL_OBJECT_BRAND]);
  for (const value of FABRIC_PRIMITIVE_VALUES) {
    for (
      let prototype = Object.getPrototypeOf(value);
      prototype !== Object.prototype;
      prototype = Object.getPrototypeOf(prototype)
    ) {
      for (const name of Object.getOwnPropertyNames(prototype)) {
        names.add(name);
      }
    }
  }
  return names;
}

/** An object whose `maxProperties` a second merged member would break. */
const boundedObject: JSONSchema = {
  type: "object",
  maxProperties: 1,
  properties: {
    a: { type: "number", default: 0 },
    b: { type: "number" },
  },
};

describe("piece schema compatibility", () => {
  describe("schemasHaveSameContract()", () => {
    it("returns `true` when defaulted unions differ only in descriptions", () => {
      const schema = (description: string): JSONSchema => ({
        type: "object",
        description,
        properties: {
          name: { type: ["string", "undefined"], default: "", description },
        },
      });
      expect(schemasHaveSameContract(schema("Producer"), schema("Consumer")))
        .toBe(true);
    });

    it("returns `false` when a defaulted union's default changes", () => {
      const source: JSONSchema = {
        type: ["string", "undefined"],
        default: "Donut",
      };
      expect(schemasHaveSameContract(source, { ...source, default: "Glaze" }))
        .toBe(false);
    });

    it("recognizes unchanged defaults without allowing new-link default insertion", () => {
      const schema: JSONSchema = {
        anyOf: [
          { type: "string" },
          { type: "string", default: "" },
          { type: "undefined" },
        ],
      };
      expect(schemasHaveSameContract(schema, schema)).toBe(true);
      expect(() => assertSchemaSubset(schema, schema)).toThrow(
        "not stable under default insertion",
      );
    });

    it("compares nested defaults through each reference's owning root", () => {
      const root = (fallback: string): JSONSchema => ({
        $defs: {
          row: {
            type: "object",
            properties: { title: { $ref: "#/$defs/text" } },
          },
          text: { type: "string", default: fallback },
        },
      });
      const reference = {
        type: "array",
        items: { $ref: "#/$defs/row" },
      } as const;
      expect(schemasHaveSameContract(reference, reference, {
        sourceRoot: root("Donut"),
        targetRoot: root("Donut"),
      })).toBe(true);
      expect(schemasHaveSameContract(reference, reference, {
        sourceRoot: root("Donut"),
        targetRoot: root("Glaze"),
      })).toBe(false);
    });

    it("returns false for unresolved references", () => {
      const reference = { $ref: "#/$defs/missing" } as const;
      expect(schemasHaveSameContract(reference, reference)).toBe(false);
    });

    it("returns false when the consumer value contract changes", () => {
      expect(schemasHaveSameContract({ type: "string" }, { type: "number" }))
        .toBe(false);
    });
  });

  it("accepts a recompile that only changes writeAuthorizedBy moduleIdentity", () => {
    // A CFC write authorization (`TrustedActionWrite`) lowers to an
    // `ifc.writeAuthorizedBy.__ctWriterIdentityOf` whose `moduleIdentity` is
    // the content-addressed hash of the authoring module. Editing that module
    // at all — a type annotation, a comment, whitespace — rehashes it, so
    // `moduleIdentity` changes while `file`, `path`, and the `uiContract` stay
    // identical. That is a recompile of the same authorization, not a narrowed
    // contract, so the backward-compatibility check accepts it: the
    // content-addressed identity is normalized out of the `ifc` comparison. The
    // ten baselined patterns that carry a CFC write (system/home,
    // system/profile-*, lobby, and the cfc-* demos) depend on this to stay
    // editable.

    const resultSchema = (moduleIdentity: string): JSONSchema => ({
      type: "object",
      properties: {
        flag: {
          type: "boolean",
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                file: "/packages/patterns/demo/main.tsx",
                path: ["setFlag"],
                moduleIdentity,
              },
            },
            uiContract: {
              helper: "UiAction",
              action: "SetFlag",
              trustedPattern: "DemoSurface",
              requiredEventIntegrity: ["DemoSurface"],
            },
          },
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, resultSchema("UVJh2ChHuLkknYrVet0Iu")),
        pattern({ type: "object" }, resultSchema("DCTZZ89BogydamlP301Qx")),
      )
    ).not.toThrow();
  });

  // The identity fields excluded from the comparison are the content hashes
  // (moduleIdentity/bundleId) and the resolver-dependent file spelling. The
  // binding path and the whole uiContract still name the real consumer-facing
  // contract, so a change to either of them must still be rejected. These build
  // two result schemas that differ in exactly one such field and assert the
  // update is refused.
  const trustedWriteResult = (
    identity: Record<string, unknown>,
    uiContract: Record<string, unknown>,
  ): JSONSchema => ({
    type: "object",
    properties: {
      flag: {
        type: "boolean",
        ifc: {
          writeAuthorizedBy: { __ctWriterIdentityOf: identity },
          uiContract,
        },
      },
    },
  });

  const baselineIdentity = {
    file: "/packages/patterns/demo/main.tsx",
    path: ["setFlag"],
    moduleIdentity: "UVJh2ChHuLkknYrVet0Iu",
  };
  const baselineUiContract: Record<string, unknown> = {
    helper: "UiAction",
    action: "SetFlag",
    trustedPattern: "DemoSurface",
    requiredEventIntegrity: ["DemoSurface"],
  };

  it("also treats the legacy bundleId as recompile-volatile", () => {
    const withBundleId = (bundleId: string): JSONSchema =>
      trustedWriteResult(
        { file: baselineIdentity.file, path: baselineIdentity.path, bundleId },
        baselineUiContract,
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, withBundleId("bundle-old")),
        pattern({ type: "object" }, withBundleId("bundle-new")),
      )
    ).not.toThrow();
  });

  it("accepts a cross-resolver recompile that only re-spells the writeAuthorizedBy file", () => {
    // A writer claim's `file` is the module's source-file spelling, and that
    // spelling is resolver-dependent: the same module compiles to a different
    // `file` under piece-deploy staging, a piece manifest, and HTTP resolution,
    // while its content-addressed `moduleIdentity` agrees everywhere
    // (labs#4772). The runtime authorizes a write on `moduleIdentity` plus the
    // binding `path` and never on `file`, so a cross-resolver recompile that
    // re-spells only the `file` — same `moduleIdentity`, same `path`, same
    // `uiContract` — is the same authorization, and the update is accepted.

    const respelled = (file: string): JSONSchema =>
      trustedWriteResult({ ...baselineIdentity, file }, baselineUiContract);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, respelled("/api/patterns/demo/main.tsx")),
        pattern({ type: "object" }, respelled("/patterns/demo/main.tsx")),
      )
    ).not.toThrow();
  });

  it("accepts a writeAuthorizedBy binding file change", () => {
    // `file` carries no authorization signal beyond the content-addressed
    // `moduleIdentity` (which the runtime re-verifies live) and the binding
    // `path`, so it is normalized out of the comparison entirely rather than
    // made spelling-tolerant. Any `file` change is accepted while the `path`
    // and `uiContract` are unchanged.

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(
          { type: "object" },
          trustedWriteResult(baselineIdentity, baselineUiContract),
        ),
        pattern(
          { type: "object" },
          trustedWriteResult(
            { ...baselineIdentity, file: "/packages/patterns/other/main.tsx" },
            baselineUiContract,
          ),
        ),
      )
    ).not.toThrow();
  });

  // A floored path is authored to mint the atom it floors, because the write
  // floor tests the integrity of the value being written and a mint on the
  // entries below the path does not reach a floor declared on the path itself.
  // A pattern that declares a floor and mints nothing has to gain the mint
  // before any write to it can conform. The mint names the derived per-value
  // component (CFC §8.12.8), which the monotone constraint behind this
  // comparison does not govern, so gaining one is not a contract change.
  const flooredList = (ifc: Record<string, unknown>): JSONSchema => ({
    type: "object",
    properties: {
      admins: { type: "array", items: { type: "string" }, ifc },
    },
  });
  const floorOnly = { requiredIntegrity: ["group-chat-admin"] };
  const floorAndMint = {
    requiredIntegrity: ["group-chat-admin"],
    addIntegrity: ["group-chat-admin"],
  };

  it("accepts a floored path that gains the mint its own floor names", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(flooredList(floorOnly), { type: "object" }),
        pattern(flooredList(floorAndMint), { type: "object" }),
      )
    ).not.toThrow();
  });

  it("accepts a floored path that loses its mint", () => {
    // The derived component is replace-on-overwrite, not a ratchet, so this
    // comparison has no opinion either way. A pattern whose writes stop
    // satisfying its own floor fails at the write, where its tests are.

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(flooredList(floorAndMint), { type: "object" }),
        pattern(flooredList(floorOnly), { type: "object" }),
      )
    ).not.toThrow();
  });

  it("compares a writeAuthorizedBy claim carrying no writer identity whole", () => {
    // Normalization reaches inside `__ctWriterIdentityOf`. A claim without one
    // has nothing volatile to remove, so two such claims compare equal.
    // The two sides differ by a mint, which is dropped, so what is left to
    // compare is the claim itself. Comparing two schemas that are equal all
    // the way down would settle before reaching it.

    const claimWith = (mint: boolean): JSONSchema => ({
      type: "object",
      properties: {
        flag: {
          type: "boolean",
          ifc: {
            writeAuthorizedBy: {},
            ...(mint ? { addIntegrity: ["reviewed"] } : {}),
          },
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, claimWith(true)),
        pattern({ type: "object" }, claimWith(false)),
      )
    ).not.toThrow();
  });

  it("accepts a claim that gains only the volatile identity fields", () => {
    // Same binding path, same uiContract, and a content hash and file spelling
    // the runtime re-derives rather than holds fixed. That is a recompile of
    // one authorization, so it is accepted.

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(
          { type: "object" },
          trustedWriteResult({ path: ["setFlag"] }, baselineUiContract),
        ),
        pattern(
          { type: "object" },
          trustedWriteResult(baselineIdentity, baselineUiContract),
        ),
      )
    ).not.toThrow();
  });

  it("finds owner evidence nested inside a mint, as the runtime does", () => {
    // `literalDidSubjectsForPrincipalClaim` walks arrays and object values, so
    // an atom nested inside another structure still authorizes the write.
    // Losing it has to read as a change here rather than slip through.

    const ownerNode = (withEvidence: boolean): JSONSchema => ({
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            ownerPrincipal: { __ctCurrentPrincipal: true },
            addIntegrity: [
              {
                kind: "delegated",
                via: withEvidence
                  ? {
                    kind: "represents-principal",
                    subject: { __ctCurrentPrincipal: true },
                  }
                  : { kind: "unrelated" },
              },
            ],
          },
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(ownerNode(true), { type: "object" }),
        pattern(ownerNode(false), { type: "object" }),
      )
    ).toThrow(/ifc changed/);
  });

  it("reads no owner evidence out of a mint that is not a list of atoms", () => {
    // A malformed mint carries no represents-principal atom, so there is
    // nothing for the owner check to match and nothing for this comparison to
    // hold. It reduces the same as a node that mints nothing at all.

    const ownerNode = (withMint: boolean): JSONSchema =>
      JSON.parse(
        `{"type":"object","properties":{"bio":{"type":"string","ifc":{` +
          `"ownerPrincipal":{"__ctCurrentPrincipal":true}` +
          (withMint ? `,"addIntegrity":"not-a-list"` : "") +
          `}}}}`,
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(ownerNode(true), { type: "object" }),
        pattern(ownerNode(false), { type: "object" }),
      )
    ).not.toThrow();
  });

  it("accepts dropping an atom the owner check does not read", () => {
    // Only `represents-principal` evidence feeds the owner check. An atom
    // beside it is a label nothing consults, so losing it leaves the write
    // authorized exactly as before and is not a contract change.

    const ownerNode = (extra: boolean): JSONSchema => ({
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            ownerPrincipal: { __ctCurrentPrincipal: true },
            addIntegrity: [
              {
                kind: "represents-principal",
                subject: { __ctCurrentPrincipal: true },
              },
              ...(extra ? ["profile-reviewed"] : []),
            ],
          },
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(ownerNode(true), { type: "object" }),
        pattern(ownerNode(false), { type: "object" }),
      )
    ).not.toThrow();
  });

  it("accepts losing the last mint into an empty ifc", () => {
    // The reduction leaves nothing behind on one side and finds an already
    // empty extension on the other. Both say the same thing, so they compare
    // equal rather than reading as a change.

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(flooredList({ addIntegrity: ["group-chat-admin"] }), {
          type: "object",
        }),
        pattern(flooredList({}), { type: "object" }),
      )
    ).not.toThrow();
  });

  it("still compares the mint on a node that authorizes by owner principal", () => {
    // Beside an `ownerPrincipal`, the mint supplies the represents-principal
    // atom the runtime matches against the owner before authorizing a write.
    // Losing it there refuses writes that used to be accepted, so the mint is
    // part of the contract on such a node rather than a derived label.

    const ownerNode = (mint: boolean): JSONSchema => ({
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            ownerPrincipal: { __ctCurrentPrincipal: true },
            ...(mint
              ? {
                addIntegrity: [{
                  kind: "represents-principal",
                  subject: { __ctCurrentPrincipal: true },
                }],
              }
              : {}),
          },
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(ownerNode(true), { type: "object" }),
        pattern(ownerNode(false), { type: "object" }),
      )
    ).toThrow(/ifc changed/);
  });

  it("still rejects a change to the floor the path requires", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(flooredList(floorAndMint), { type: "object" }),
        pattern(
          flooredList({
            requiredIntegrity: ["group-chat-owner"],
            addIntegrity: ["group-chat-admin"],
          }),
          { type: "object" },
        ),
      )
    ).toThrow(/ifc changed/);
  });

  it("still rejects a change to the integrity a path declares it holds", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(flooredList({ integrity: ["group-chat-admin"] }), {
          type: "object",
        }),
        pattern(flooredList({ integrity: ["group-chat-owner"] }), {
          type: "object",
        }),
      )
    ).toThrow(/ifc changed/);
  });

  it("still rejects a writeAuthorizedBy binding path change", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(
          { type: "object" },
          trustedWriteResult(baselineIdentity, baselineUiContract),
        ),
        pattern(
          { type: "object" },
          trustedWriteResult(
            { ...baselineIdentity, path: ["setOtherFlag"] },
            baselineUiContract,
          ),
        ),
      )
    ).toThrow(/flag: ifc changed/);
  });

  it("still rejects a uiContract change", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(
          { type: "object" },
          trustedWriteResult(baselineIdentity, baselineUiContract),
        ),
        pattern(
          { type: "object" },
          trustedWriteResult(baselineIdentity, {
            ...baselineUiContract,
            action: "ClearFlag",
          }),
        ),
      )
    ).toThrow(/flag: ifc changed/);
  });

  it("still rejects a change to the builtin writeAuthorizedBy list", () => {
    const withBuiltins = (builtins: readonly string[]): JSONSchema => ({
      type: "object",
      properties: {
        flag: {
          type: "boolean",
          ifc: { writeAuthorizedBy: builtins },
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, withBuiltins(["trustedBuiltin"])),
        pattern({ type: "object" }, withBuiltins(["trustedBuiltin"])),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, withBuiltins(["otherBuiltin"])),
        pattern({ type: "object" }, withBuiltins(["trustedBuiltin"])),
      )
    ).toThrow(/flag: ifc changed/);
  });

  // `allOf` and `oneOf` are not taken apart by the subset proof, so what
  // decides them is whether the two sides say the same thing. A write
  // authorization under one of them is read with the same reduction the
  // comparison applies to one written on a property, so a recompile of the
  // authoring module is accepted wherever the authorization sits. Without
  // that, a pattern carrying a claim there would freeze on the first edit to
  // the module that authorizes it.
  //
  // The schema generator emits neither keyword — an intersection merges into
  // one object schema and a union emits `anyOf` — so nothing reaches these
  // through that route today. The gate does not only see generated schemas:
  // one can be written into a space by anything, and `validateSchemaDefinition`
  // admits both keywords, which is what these pin.
  const compositeWrite = (
    keyword: "allOf" | "oneOf",
    identity: Record<string, unknown>,
    uiContract: Record<string, unknown> = baselineUiContract,
  ): JSONSchema => ({
    type: "object",
    properties: {
      flag: {
        [keyword]: [{
          type: "boolean",
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: identity },
            uiContract,
          },
        }],
      },
    },
  });

  for (const keyword of ["allOf", "oneOf"] as const) {
    it(`accepts a recompile under ${keyword}`, () => {
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(
            { type: "object" },
            compositeWrite(keyword, baselineIdentity),
          ),
          pattern(
            { type: "object" },
            compositeWrite(keyword, {
              ...baselineIdentity,
              moduleIdentity: "DCTZZ89BogydamlP301Qx",
            }),
          ),
        )
      ).not.toThrow();
    });

    it(`accepts a cross-resolver re-spelling under ${keyword}`, () => {
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(
            { type: "object" },
            compositeWrite(keyword, baselineIdentity),
          ),
          pattern(
            { type: "object" },
            compositeWrite(keyword, {
              ...baselineIdentity,
              file: "/api/patterns/demo/main.tsx",
            }),
          ),
        )
      ).not.toThrow();
    });

    it(`still rejects a binding path change under ${keyword}`, () => {
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(
            { type: "object" },
            compositeWrite(keyword, baselineIdentity),
          ),
          pattern(
            { type: "object" },
            compositeWrite(keyword, {
              ...baselineIdentity,
              path: ["setOtherFlag"],
            }),
          ),
        )
      ).toThrow(new RegExp(`flag: ${keyword} changed`));
    });

    it(`still rejects a uiContract change under ${keyword}`, () => {
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(
            { type: "object" },
            compositeWrite(keyword, baselineIdentity),
          ),
          pattern(
            { type: "object" },
            compositeWrite(keyword, baselineIdentity, {
              ...baselineUiContract,
              action: "ClearFlag",
            }),
          ),
        )
      ).toThrow(new RegExp(`flag: ${keyword} changed`));
    });
  }

  it("reads a nested ifc the same way under every keyword that holds schemas", () => {
    // The keywords the subset proof cannot take apart are not only `allOf` and
    // `oneOf`. `if`/`then` and `not` are compared whole as well, and each is
    // read with the same reduction, so a recompile is accepted there too.
    const conditional = (
      identity: Record<string, unknown>,
      uiContract: Record<string, unknown> = baselineUiContract,
    ): JSONSchema => ({
      type: "object",
      properties: {
        flag: {
          if: { type: "boolean" },
          then: {
            ifc: {
              writeAuthorizedBy: { __ctWriterIdentityOf: identity },
              uiContract,
            },
          },
          not: {
            const: null,
            ifc: { writeAuthorizedBy: { __ctWriterIdentityOf: identity } },
          },
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, conditional(baselineIdentity)),
        pattern(
          { type: "object" },
          conditional({
            ...baselineIdentity,
            moduleIdentity: "DCTZZ89BogydamlP301Qx",
          }),
        ),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, conditional(baselineIdentity)),
        pattern(
          { type: "object" },
          conditional(baselineIdentity, {
            ...baselineUiContract,
            action: "ClearFlag",
          }),
        ),
      )
    ).toThrow(/flag: (if|then|not) changed/);
  });

  it("reads a claim reached through a recursive definition", () => {
    // A definition that names itself is what the walk has to terminate on, and
    // the claim sits under `allOf` inside it, so reaching it means descending
    // both the reference and the composite keyword. The recompile is accepted
    // and the binding path change is not.
    const recursive = (identity: Record<string, unknown>): JSONSchema => ({
      type: "object",
      $defs: {
        Node: {
          type: "object",
          properties: {
            child: { $ref: "#/$defs/Node" },
            flag: {
              allOf: [{
                type: "boolean",
                ifc: {
                  writeAuthorizedBy: { __ctWriterIdentityOf: identity },
                  uiContract: baselineUiContract,
                },
              }],
            },
          },
        },
      },
      properties: { root: { $ref: "#/$defs/Node" } },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, recursive(baselineIdentity)),
        pattern(
          { type: "object" },
          recursive({
            ...baselineIdentity,
            moduleIdentity: "DCTZZ89BogydamlP301Qx",
          }),
        ),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, recursive(baselineIdentity)),
        pattern(
          { type: "object" },
          recursive({ ...baselineIdentity, path: ["setOtherFlag"] }),
        ),
      )
    ).toThrow(/allOf changed/);
  });

  it("reads a claim under a composite keyword when proving a link", () => {
    // `assertSchemaSubset` proves a durable link between two separate pieces
    // rather than two versions of one contract, and it reaches the same
    // comparison. A differing writer identity is read the same way there as it
    // is on a property, while the binding path is still compared.
    const linked = (identity: Record<string, unknown>): JSONSchema => ({
      allOf: [{
        type: "boolean",
        ifc: {
          writeAuthorizedBy: { __ctWriterIdentityOf: identity },
          uiContract: baselineUiContract,
        },
      }],
    });
    expect(() =>
      assertSchemaSubset(
        linked(baselineIdentity),
        linked({
          ...baselineIdentity,
          moduleIdentity: "DCTZZ89BogydamlP301Qx",
        }),
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        linked(baselineIdentity),
        linked({ ...baselineIdentity, path: ["setOtherFlag"] }),
      )
    ).toThrow(/allOf changed/);
  });

  it("reads a claim under a keyword the checker has no other rule for", () => {
    // `unevaluatedProperties` holds a schema, but no rule in this comparison
    // names it, so a difference in it is reported by the unknown-keyword check
    // at the end. That check reads it with the same rule as everything else, so
    // a recompile under it is accepted and a binding path change under it is
    // not.
    const unevaluated = (identity: Record<string, unknown>): JSONSchema => ({
      type: "object",
      properties: {
        bag: {
          type: "object",
          unevaluatedProperties: {
            type: "string",
            ifc: {
              writeAuthorizedBy: { __ctWriterIdentityOf: identity },
            },
          },
        },
      },
    } as unknown as JSONSchema);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, unevaluated(baselineIdentity)),
        pattern(
          { type: "object" },
          unevaluated({
            ...baselineIdentity,
            moduleIdentity: "DCTZZ89BogydamlP301Qx",
          }),
        ),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, unevaluated(baselineIdentity)),
        pattern(
          { type: "object" },
          unevaluated({ ...baselineIdentity, path: ["setOtherFlag"] }),
        ),
      )
    ).toThrow(/bag: unevaluatedProperties changed/);
  });

  it("resolves a reference under a keyword it has no other rule for", () => {
    // `unevaluatedProperties` holds a schema that this comparison has no
    // subset rule for, so the unknown-keyword check decides it. Two identical
    // `$ref`s say the same thing only while the definitions they name do; the
    // check resolves them against each contract's own root rather than reading
    // the reference string as the constraint.
    const referenced = (definition: string): JSONSchema => ({
      type: "object",
      $defs: { Entry: { type: definition } },
      properties: {
        bag: {
          type: "object",
          unevaluatedProperties: { $ref: "#/$defs/Entry" },
        },
      },
    } as unknown as JSONSchema);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, referenced("string")),
        pattern({ type: "object" }, referenced("string")),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, referenced("string")),
        pattern({ type: "object" }, referenced("number")),
      )
    ).toThrow(/bag: unevaluatedProperties changed/);
  });

  it("compares a sparse subschema list by index", () => {
    // `validateSchemaDefinition` requires a dense array for the four list
    // keywords it names, so a hole reaches this comparison only under a
    // keyword it has no rule for. `unevaluatedProperties` is such a keyword,
    // and the walk descends it. A hole and a stored `undefined` are different
    // values, so a list whose missing entry the candidate fills carries a
    // constraint the baseline did not, and the array iteration methods would
    // step over exactly that difference.
    const list = (holed: boolean): unknown[] => {
      const entries: unknown[] = [];
      if (!holed) entries[0] = { type: "string" };
      entries[1] = { type: "string" };
      return entries;
    };
    const bag = (holed: boolean): JSONSchema => ({
      type: "object",
      properties: {
        a: {
          type: "object",
          unevaluatedProperties: { allOf: list(holed) },
        },
      },
    } as unknown as JSONSchema);
    // Refused whichever side carries the hole, so the answer does not depend
    // on which contract is named first.
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(bag(true), { type: "object" }),
        pattern(bag(false), { type: "object" }),
      )
    ).toThrow(/a: unevaluatedProperties changed/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(bag(false), { type: "object" }),
        pattern(bag(true), { type: "object" }),
      )
    ).toThrow(/a: unevaluatedProperties changed/);
  });

  it("still rejects a conjunct added or removed beside a nested writer claim", () => {
    // Reading the `ifc` inside an `allOf` means comparing the two lists, and
    // a list of a different length is a different list. Both directions are
    // refused, because this comparison proves nothing about `allOf` either
    // way: it decides the keyword by whether the two sides say the same thing,
    // so a candidate that widens by dropping a conjunct is refused alongside
    // one that narrows by adding one.
    const conjuncts = (extra: boolean): JSONSchema => ({
      type: "object",
      properties: {
        label: {
          allOf: [
            {
              type: "string",
              ifc: {
                writeAuthorizedBy: { __ctWriterIdentityOf: baselineIdentity },
              },
            },
            ...(extra ? [{ maxLength: 32 }] : []),
          ],
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(conjuncts(false), { type: "object" }),
        pattern(conjuncts(true), { type: "object" }),
      )
    ).toThrow(/label: allOf changed/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(conjuncts(true), { type: "object" }),
        pattern(conjuncts(false), { type: "object" }),
      )
    ).toThrow(/label: allOf changed/);
  });

  it("still rejects a constraint change beside a nested writer claim", () => {
    // The reduction reaches the `ifc` and nothing else. A branch that narrows
    // what it accepts is still a narrowed contract, whether or not the same
    // branch carries a write authorization.
    const narrowing = (maxLength: number): JSONSchema => ({
      type: "object",
      properties: {
        label: {
          allOf: [{
            type: "string",
            maxLength,
            ifc: {
              writeAuthorizedBy: { __ctWriterIdentityOf: baselineIdentity },
            },
          }],
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(narrowing(64), { type: "object" }),
        pattern(narrowing(32), { type: "object" }),
      )
    ).toThrow(/label: allOf changed/);
  });

  it("compares a Fabric default beside a nested writer claim by content", () => {
    // The reduction is applied in place: the comparison walks both schemas and
    // reads the `ifc` it meets, and never rebuilds a node. A `default` holding
    // a Fabric value is compared as it stands, by content hash, so two such
    // values that differ are still a change and two that agree are still not
    // one — beside a writer claim whose module was recompiled or not.
    const seeded = (
      seed: FabricBytes,
      moduleIdentity: string,
    ): JSONSchema => ({
      type: "object",
      properties: {
        token: {
          allOf: [{
            type: "FabricBytes",
            default: seed,
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: { ...baselineIdentity, moduleIdentity },
              },
            },
          }],
        },
      },
    } as unknown as JSONSchema);
    const seed = () => new FabricBytes(new Uint8Array([1, 2, 3]));
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, seeded(seed(), "UVJh2ChHuLkknYrVet0Iu")),
        pattern({ type: "object" }, seeded(seed(), "DCTZZ89BogydamlP301Qx")),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object" }, seeded(seed(), "UVJh2ChHuLkknYrVet0Iu")),
        pattern(
          { type: "object" },
          seeded(new FabricBytes(new Uint8Array([9])), "UVJh2ChHuLkknYrVet0Iu"),
        ),
      )
    ).toThrow(/token: allOf changed/);
  });

  it("accepts a mint gained under a keyword the subset proof compares whole", () => {
    // The `ifc` reduction drops the derived per-value keys as well, and it
    // drops them wherever the extension sits. A floored path that gains the
    // mint its own floor names is not a contract change under `allOf` any more
    // than it is on the property itself.
    const floored = (ifc: Record<string, unknown>): JSONSchema => ({
      type: "object",
      properties: {
        admins: {
          allOf: [{ type: "array", items: { type: "string" }, ifc }],
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(floored(floorOnly), { type: "object" }),
        pattern(floored(floorAndMint), { type: "object" }),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(floored(floorOnly), { type: "object" }),
        pattern(
          floored({ requiredIntegrity: ["group-chat-owner"] }),
          { type: "object" },
        ),
      )
    ).toThrow(/admins: allOf changed/);
  });

  it("accepts named Fabric projection fields through an open link target", () => {
    const source: JSONSchema = {
      type: "object",
      properties: {
        mentioned: { type: "array", items: true },
        backlinks: { type: "array", items: true },
        $FS: { type: "object" },
        explicitUndefined: { type: "undefined" },
      },
      required: ["mentioned", "backlinks", "$FS", "explicitUndefined"],
      additionalProperties: false,
    };
    const openTarget: JSONSchema = {
      type: "object",
      properties: {
        mentioned: { type: "array", items: true },
        backlinks: { type: "array", items: true },
      },
      required: ["mentioned", "backlinks"],
    };

    expect(() => assertSchemaSubset(source, openTarget)).not.toThrow();
    expect(() =>
      assertSchemaSubset(source, {
        ...openTarget,
        additionalProperties: false,
      })
    ).toThrow(/\$FS: source field is rejected/);
    expect(() =>
      assertSchemaSubset(source, {
        ...openTarget,
        patternProperties: { "^\\$FS$": { type: "string" } },
      })
    ).toThrow(/patternProperties|\$FS/);

    const finiteProjection: JSONSchema = {
      type: "object",
      properties: { $FS: { type: "object" } },
      required: ["$FS"],
      additionalProperties: false,
    };
    expect(() =>
      assertSchemaSubset(finiteProjection, {
        type: "object",
        patternProperties: { "^\\$FS$": { type: "object" } },
        required: ["$FS"],
        additionalProperties: false,
      })
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        {
          type: "object",
          patternProperties: { "^x": { type: "number" } },
          additionalProperties: false,
        },
        {
          type: "object",
          patternProperties: { "^y": { type: "number" } },
          additionalProperties: false,
        },
      )
    ).toThrow(/patternProperties changed/);

    const intersectedProperty: JSONSchema = {
      type: "object",
      properties: { x: { type: ["number", "string"] } },
      patternProperties: { "^x$": { type: "number" } },
      required: ["x"],
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(intersectedProperty, intersectedProperty))
      .not.toThrow();
  });

  it("reports invalid and unprovable durable-link contracts", () => {
    const invalid = { type: "not-a-fabric-type" } as unknown as JSONSchema;
    expect(() => assertSchemaSubset(invalid, true, "link")).toThrow(
      /source schema is invalid/,
    );
    expect(() => assertSchemaSubset(true, invalid, "link")).toThrow(
      /target schema is invalid/,
    );

    const namedString: JSONSchema = {
      type: "object",
      properties: { x: { type: "string" } },
      required: ["x"],
      additionalProperties: false,
    };
    expect(() =>
      assertSchemaSubset(namedString, {
        type: "object",
        properties: { x: { type: "number" } },
        required: ["x"],
        additionalProperties: false,
      })
    ).toThrow(/x.*type/);
    expect(() =>
      assertSchemaSubset(namedString, {
        type: "object",
        patternProperties: { "^x$": { type: "number" } },
        required: ["x"],
        additionalProperties: false,
      })
    ).toThrow(/x.*type/);
    expect(() =>
      assertSchemaSubset(namedString, {
        type: "object",
        additionalProperties: { type: "number" },
      })
    ).toThrow(/x.*type/);

    const intersectedSource: JSONSchema = {
      type: "object",
      properties: { x: { type: ["number", "string"] } },
      patternProperties: { "^x$": { type: "number" } },
      required: ["x"],
      additionalProperties: false,
    };
    expect(() =>
      assertSchemaSubset(intersectedSource, {
        type: "object",
        properties: { x: { type: "number" } },
        patternProperties: { "^x$": { type: "number" } },
        required: ["x"],
        additionalProperties: false,
      })
    ).not.toThrow();
  });

  it("uses target defaults as link proofs only under default-stable ancestors", () => {
    const properties = {
      x: { type: "number" as const },
      y: { type: "number" as const },
    };
    const stableSource: JSONSchema = {
      type: "object",
      properties,
      required: ["y"],
      additionalProperties: false,
    };
    const stableTarget: JSONSchema = {
      type: "object",
      properties: {
        ...properties,
        x: { type: "number", default: 0 },
      },
      required: ["x", "y"],
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(stableSource, stableTarget)).not.toThrow();

    const constrainedSameNodeDefault: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: {
            refsOut: { type: "array", items: { type: "string" } },
          },
          required: ["refsOut"],
        },
        { type: "undefined" },
      ],
      default: { refsOut: [] },
    };
    expect(() =>
      assertSchemaSubset(
        constrainedSameNodeDefault,
        constrainedSameNodeDefault,
      )
    ).not.toThrow();

    const disjointCompositionWithDescendantDefault: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "number", default: 0 } },
        },
        { type: "undefined" },
      ],
    };
    expect(() =>
      assertSchemaSubset(
        disjointCompositionWithDescendantDefault,
        disjointCompositionWithDescendantDefault,
      )
    ).not.toThrow();

    const disjointOneOfWithDescendantDefault: JSONSchema = {
      oneOf: [
        {
          type: "array",
          items: { type: "number", default: 0 },
        },
        { type: "string" },
      ],
    };
    expect(() =>
      assertSchemaSubset(
        disjointOneOfWithDescendantDefault,
        disjointOneOfWithDescendantDefault,
      )
    ).not.toThrow();

    const impossibleAlternativeWithDescendantDefault: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "number", default: 0 } },
        },
        false,
      ],
    };
    expect(() =>
      assertSchemaSubset(
        impossibleAlternativeWithDescendantDefault,
        impossibleAlternativeWithDescendantDefault,
      )
    ).not.toThrow();

    const overlappingCompositionWithDescendantDefault: JSONSchema = {
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "number", default: 0 } },
        },
        { type: "object" },
      ],
    };
    expect(() =>
      assertSchemaSubset(
        overlappingCompositionWithDescendantDefault,
        overlappingCompositionWithDescendantDefault,
      )
    ).toThrow(/not stable under default insertion/);

    for (
      const alternatives of [
        [
          {
            type: "object",
            properties: { x: { type: "number", default: 0 } },
          },
          true,
        ],
        [
          {
            type: "object",
            properties: { x: { type: "number", default: 0 } },
          },
          { properties: {} },
        ],
        [
          {
            type: "object",
            properties: { x: { type: "number", default: 0 } },
          },
          { type: "unknown" },
        ],
        [
          {
            type: "number",
            default: 0,
          },
          { type: "integer" },
        ],
        [
          {
            type: "integer",
            default: 0,
          },
          { type: "number" },
        ],
        [
          {
            type: "object",
            properties: { x: { type: "number", default: 0 } },
          },
          { type: "FabricBytes" },
        ],
      ] as JSONSchema[][]
    ) {
      const unprovableComposition: JSONSchema = { anyOf: alternatives };
      expect(() =>
        assertSchemaSubset(unprovableComposition, unprovableComposition)
      ).toThrow(/not stable under default insertion/);
    }

    const invalidSameNodeDefault: JSONSchema = {
      oneOf: [{ type: "number" }, { minimum: 0 }],
      default: 1,
    };
    expect(() =>
      assertSchemaSubset(invalidSameNodeDefault, invalidSameNodeDefault)
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertSchemaSubset(
        { ...stableSource, minProperties: 1 },
        { ...stableTarget, minProperties: 1 },
      )
    ).not.toThrow();

    expect(() =>
      assertSchemaSubset(
        { ...stableSource, maxProperties: 1 },
        { ...stableTarget, maxProperties: 1 },
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertSchemaSubset(
        {
          ...stableSource,
          dependentRequired: { x: ["y"] },
        },
        {
          ...stableTarget,
          dependentRequired: { x: ["y"] },
        },
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertSchemaSubset(
        { type: "array", items: stableSource, uniqueItems: true },
        { type: "array", items: stableTarget, uniqueItems: true },
      )
    ).toThrow(/not stable under default insertion/);

    const unstableChild: JSONSchema = {
      type: "object",
      properties: {
        a: { type: "number", default: 0 },
        b: { type: "number" },
      },
      maxProperties: 1,
      additionalProperties: false,
    };
    const dynamicTarget: JSONSchema = {
      type: "object",
      patternProperties: {
        "^x": unstableChild,
      },
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(dynamicTarget, dynamicTarget)).toThrow(
      /not stable under default insertion/,
    );

    const arrayTarget: JSONSchema = {
      type: "array",
      items: stableTarget,
      uniqueItems: true,
    };
    expect(() => assertSchemaSubset(arrayTarget, arrayTarget)).toThrow(
      /not stable under default insertion/,
    );

    const nestedTarget: JSONSchema = {
      type: "object",
      properties: { item: unstableChild },
      required: ["item"],
      additionalProperties: false,
    };
    expect(() => assertSchemaSubset(nestedTarget, nestedTarget)).toThrow(
      /not stable under default insertion/,
    );

    const plainArrayTarget: JSONSchema = {
      type: "array",
      items: unstableChild,
    };
    expect(() => assertSchemaSubset(plainArrayTarget, plainArrayTarget))
      .toThrow(/not stable under default insertion/);
  });

  it("accepts record defaults with unchanged cell and scope metadata", () => {
    const resultSchema: JSONSchema = { type: "object" };
    for (
      const metadata of [
        { asCell: ["cell"] },
        { asCell: [{ kind: "cell", scope: "space" }] },
        { scope: "user" },
      ] as const
    ) {
      const record: JSONSchema = {
        type: "object",
        additionalProperties: { type: "string" },
      };
      const source: JSONSchema = {
        type: "object",
        properties: { settings: { ...record, ...metadata } },
      };
      const target: JSONSchema = {
        ...source,
        properties: { settings: { ...record, ...metadata, default: {} } },
      };

      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(source, resultSchema),
          pattern(target, resultSchema),
        )
      ).not.toThrow();
      expect(() => assertSchemaSubset(source, target)).not.toThrow();

      const withRef: JSONSchema = {
        type: "object",
        properties: { settings: { $ref: "#/$defs/Settings", ...metadata } },
        $defs: { Settings: record },
      };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(withRef, resultSchema),
          pattern({
            ...withRef,
            $defs: { Settings: { ...record, default: {} } },
          }, resultSchema),
        )
      ).not.toThrow();
    }
  });

  it("treats a default beneath unchanged cell metadata as beneath a plain node", () => {
    // Stable means the plain-node rule applies, not only insertion: a
    // changed default value is accepted, and a durable-link proof accepts a
    // target default declared below a cell.
    const cell = (value: Record<string, number>): JSONSchema => ({
      type: "object",
      properties: {
        settings: {
          type: "object",
          additionalProperties: { type: "number" },
          asCell: ["cell"],
          default: value,
        },
      },
    });
    const resultSchema: JSONSchema = { type: "object" };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(cell({ a: 1 }), resultSchema),
        pattern(cell({ a: 2 }), resultSchema),
      )
    ).not.toThrow();

    const linked = (x: JSONSchema): JSONSchema => ({
      type: "object",
      properties: {
        s: { type: "object", asCell: ["cell"], properties: { x } },
      },
    });
    expect(() =>
      assertSchemaSubset(
        linked({ type: "number" }),
        linked({ type: "number", default: 5 }),
      )
    ).not.toThrow();
  });

  it("treats a default beneath unchanged readOnly or writeOnly as beneath a plain node", () => {
    // The same principle as cells and scopes: the marker says how the value
    // is written, not what shape it has. The marker itself must still match.
    for (const marker of [{ readOnly: true }, { writeOnly: true }] as const) {
      const field = (value: string): JSONSchema => ({
        type: "object",
        properties: { note: { type: "string", ...marker, default: value } },
      });
      const resultSchema: JSONSchema = { type: "object" };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(field("none"), resultSchema),
          pattern(field("blue"), resultSchema),
        )
      ).not.toThrow();
    }
    const flipped = (marker: { readOnly: boolean }): JSONSchema => ({
      type: "object",
      properties: { note: { type: "string", ...marker, default: "none" } },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(flipped({ readOnly: true }), { type: "object" }),
        pattern(flipped({ readOnly: false }), { type: "object" }),
      )
    ).toThrow("readOnly changed");
  });

  it("still refuses a changed default beneath an ifc label", () => {
    // `ifc` is the one semantic extension left out of the default-stable set
    // on purpose: whether a materialized default satisfies a labeled node's
    // floor is the write-authority comparison's question.
    const labeled = (value: boolean): JSONSchema => ({
      type: "object",
      properties: {
        flag: {
          type: "boolean",
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                file: "/packages/patterns/demo/main.tsx",
                path: ["setFlag"],
                moduleIdentity: "UVJh2ChHuLkknYrVet0Iu",
              },
            },
          },
          default: value,
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(labeled(false), { type: "object" }),
        pattern(labeled(true), { type: "object" }),
      )
    ).toThrow(/not stable under default insertion/);
  });

  it("rejects cell and scope changes when a record gains a default", () => {
    for (
      const [before, after, message] of [
        [{ asCell: ["cell"] }, { asCell: ["readonly"] }, "asCell changed"],
        [{ scope: "user" }, { scope: "space" }, "scope changed"],
      ] as const
    ) {
      const record: JSONSchema = {
        type: "object",
        additionalProperties: { type: "string" },
      };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern({ ...record, ...before }, true),
          pattern({ ...record, ...after, default: {} }, true),
        )
      ).toThrow(message);
    }
  });

  it("rejects descendant defaults under a cell with a property-count constraint", () => {
    const source: JSONSchema = {
      type: "object",
      asCell: ["cell"],
      properties: { settings: { type: "object" } },
      maxProperties: 0,
    };
    const target: JSONSchema = {
      ...source,
      properties: { settings: { type: "object", default: {} } },
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(source, true),
        pattern(target, true),
      )
    ).toThrow(/not stable under default insertion/);
    expect(() => assertSchemaSubset(source, target)).toThrow(
      /not stable under default insertion/,
    );
  });

  it("refuses a target default written under `allOf`", () => {
    // Reading a value through an `allOf` reads it through each branch merged
    // with the rest of the schema. A default inside a branch is therefore
    // merged into the value the read returns. The reads themselves are in
    // `schema-compatibility-default-reach.test.ts`.

    const branchHoldsBoth: JSONSchema = { allOf: [boundedObject] };
    expect(() => assertSchemaSubset(branchHoldsBoth, branchHoldsBoth))
      .toThrow(/not stable under default insertion/);

    const branchBelowAProperty: JSONSchema = {
      type: "object",
      properties: { item: { allOf: [boundedObject] } },
    };
    expect(() => assertSchemaSubset(branchBelowAProperty, branchBelowAProperty))
      .toThrow(/not stable under default insertion/);

    const constraintAboveTheBranch: JSONSchema = {
      type: "object",
      maxProperties: 1,
      allOf: [{
        type: "object",
        properties: {
          a: { type: "number", default: 0 },
          b: { type: "number" },
        },
      }],
    };
    expect(() =>
      assertSchemaSubset(constraintAboveTheBranch, constraintAboveTheBranch)
    ).toThrow(/not stable under default insertion/);
  });

  it("refuses a default under `allOf` that no constraint above it can break", () => {
    // What the case above costs. `allOf` is not one of the keywords the walk
    // treats as stable under default insertion, so reaching an `allOf` marks
    // everything below it unstable and refuses every default there. Nothing in
    // this target is unsafe. Its only constraint is an element count, and
    // merging a member into an element leaves that count as it was. The same
    // schema written without the `allOf` wrapper is accepted.

    const elements: JSONSchema = {
      type: "array",
      items: {
        type: "object",
        properties: { a: { type: "number", default: 0 } },
      },
    };
    const wrapped: JSONSchema = {
      type: "array",
      maxItems: 1,
      allOf: [elements],
    };
    expect(() => assertSchemaSubset(wrapped, wrapped))
      .toThrow(/not stable under default insertion/);

    const unwrapped: JSONSchema = { ...elements, maxItems: 1 };
    expect(() => assertSchemaSubset(unwrapped, unwrapped)).not.toThrow();
  });

  it("accepts a target default under a default-inert keyword", () => {
    // Where the walk above stops. Each case writes a default under one of the
    // keywords the walk does not follow, below the same constraint on the whole
    // value. No default under any of them is ever merged into a value, so the
    // link proof stands. Two cases carry a default the others do not: `not`
    // describes the values the schema rejects, and `propertyNames` constrains
    // names rather than values.

    const inertKeywordTargets: Record<string, JSONSchema> = {
      not: { not: { type: "number", default: 5 } },
      propertyNames: {
        type: "object",
        propertyNames: { type: "string", default: "a" },
      },
      contentSchema: { type: "string", contentSchema: boundedObject },
      $defs: { $defs: { Unreferenced: boundedObject }, type: "object" },
      definitions: {
        definitions: { Unreferenced: boundedObject },
        type: "object",
      },
      if: { if: boundedObject, type: "object" },
      then: { if: { type: "object" }, then: boundedObject },
      else: { if: { type: "string" }, else: boundedObject },
      dependentSchemas: {
        type: "object",
        dependentSchemas: { b: boundedObject },
      },
      contains: { type: "array", contains: boundedObject },
      unevaluatedProperties: {
        type: "object",
        unevaluatedProperties: boundedObject,
      },
      unevaluatedItems: { type: "array", unevaluatedItems: boundedObject },
    };
    expect(Object.keys(inertKeywordTargets).sort())
      .toEqual([...DEFAULT_INERT_SUBSCHEMA_KEYS].sort());

    for (const [keyword, inert] of Object.entries(inertKeywordTargets)) {
      const target: JSONSchema = {
        type: "object",
        properties: { item: inert },
      };
      expect(() => assertSchemaSubset(target, target), keyword).not.toThrow();
    }

    // A `$defs` body a `$ref` names is one a value can take. The walk resolves
    // every `$ref` it passes, so the same definition is refused once something
    // references it.
    const namedDefinition: JSONSchema = {
      type: "object",
      $defs: { Referenced: boundedObject },
      properties: { item: { $ref: "#/$defs/Referenced" } },
    };
    expect(() => assertSchemaSubset(namedDefinition, namedDefinition))
      .toThrow(/not stable under default insertion/);
  });

  it("rejects changed migration defaults below default-unstable constraints", () => {
    const resultSchema: JSONSchema = {
      type: "object",
      properties: {},
    };
    const boundedArgument: JSONSchema = {
      type: "object",
      properties: { y: { type: "number" } },
      maxProperties: 1,
    };
    const withOptionalDefault: JSONSchema = {
      ...boundedArgument,
      properties: {
        y: { type: "number" },
        x: { type: "number", default: 0 },
      },
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(boundedArgument, resultSchema),
        pattern(withOptionalDefault, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);

    const existingOptional: JSONSchema = {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      maxProperties: 1,
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(existingOptional, resultSchema),
        pattern({
          ...existingOptional,
          properties: {
            x: { type: "number", default: 0 },
            y: { type: "number" },
          },
        }, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(boundedArgument, resultSchema),
        pattern({
          ...withOptionalDefault,
          required: ["x"],
        }, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({
          type: "array",
          items: boundedArgument,
          uniqueItems: true,
        }, resultSchema),
        pattern({
          type: "array",
          items: withOptionalDefault,
          uniqueItems: true,
        }, resultSchema),
      )
    ).toThrow(/not stable under default insertion/);
  });

  it("accepts optional and defaulted fields plus wider argument unions", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "number" }, { type: "string" }] },
          format: { type: "string" },
          label: { type: ["string", "undefined"] },
          retries: { type: "number", default: 0 },
          options: {
            type: "object",
            properties: { attempts: { type: "number", default: 1 } },
            required: ["attempts"],
          },
        },
        required: ["value", "retries", "options"],
      },
      {
        type: "object",
        properties: {
          doubled: { type: "number" },
          status: { type: "string" },
          summary: { type: ["string", "undefined"] },
        },
        required: ["doubled"],
      },
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .not.toThrow();
  });

  it("accepts compatible changes through local schema references", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: { Value: { type: "number" } },
      },
      oldPattern.resultSchema,
    );
    const candidate = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: {
          Value: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();
  });

  const argumentWithNestedValue = (
    value: JSONSchema,
    rootDefinitions?: Record<string, JSONSchema>,
  ) =>
    pattern(
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { value: { $ref: "#/$defs/Value" } },
            $defs: { Value: value },
          },
        },
        ...(rootDefinitions !== undefined && { $defs: rootDefinitions }),
      },
      oldPattern.resultSchema,
    );
  const argumentWithRootValue = (value: JSONSchema) =>
    pattern(
      {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { value: { $ref: "#/$defs/Value" } },
          },
        },
        $defs: { Value: value },
      },
      oldPattern.resultSchema,
    );

  it("rejects a candidate argument schema whose ref only a nested `$defs` could satisfy", () => {
    // The candidate's root declares no `$defs`, so `#/$defs/Value` names
    // nothing and the schema is invalid, whatever the nested map defines.
    const previous = argumentWithRootValue({ type: ["number", "string"] });
    const widened = argumentWithNestedValue({
      type: ["number", "string", "undefined"],
    });

    expect(() => assertPatternSchemasBackwardCompatible(previous, widened))
      .toThrow(/candidate argument has an invalid schema/);
  });

  it("refuses every replacement of a stored schema whose ref only a nested `$defs` could satisfy", () => {
    // The stored root declares no `$defs`, so its `#/$defs/Value` names
    // nothing whatever the nested map defines. The previous side is invalid
    // as stored, and a replacement laid out properly is refused the same as
    // any other; the override is the path past a stored schema known to be
    // broken.
    const previous = argumentWithNestedValue({
      type: ["number", "string"],
    });
    const same = argumentWithRootValue({ type: ["number", "string"] });
    const widened = argumentWithRootValue({
      type: ["number", "string", "undefined"],
    });

    expect(() => assertPatternSchemasBackwardCompatible(previous, same))
      .toThrow(/previous argument has an invalid schema/);
    expect(() => assertPatternSchemasBackwardCompatible(previous, widened))
      .toThrow(/previous argument has an invalid schema/);
  });

  it("reads a stored nested `$defs` as inert beside the root's definition", () => {
    // The stored root declares `Value` as a number, so the nested ref names
    // that number and the nested map beside it says nothing. A candidate
    // widening the root's definition is accepted; one replacing it with a
    // type the number does not fit is refused.
    const rootDefinitions: Record<string, JSONSchema> = {
      Value: { type: "number" },
    };
    const previous = argumentWithNestedValue(
      { type: ["number", "string"] },
      rootDefinitions,
    );
    const widened = argumentWithRootValue({ type: ["number", "string"] });
    const replaced = argumentWithRootValue({ type: "string" });
    // The candidate's nested map is inert too: its root widens the number,
    // and the string the nested map declares beside it does not narrow.
    const widenedBesideInert = argumentWithNestedValue(
      { type: "string" },
      { Value: { type: ["number", "string"] } },
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, widened))
      .not.toThrow();
    expect(() => assertPatternSchemasBackwardCompatible(previous, replaced))
      .toThrow(/argument\.nested\.value/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, widenedBesideInert)
    ).not.toThrow();
  });

  it("reads a referenced definition body's refs against the document's map, default included", () => {
    const previous = pattern(
      { type: "object", properties: {} },
      oldPattern.resultSchema,
    );
    const candidateWithRootValue = (value: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: { item: { $ref: "#/$defs/Entry" } },
          required: ["item"],
          $defs: {
            Entry: {
              type: "object",
              properties: { value: { $ref: "#/$defs/Value" } },
              required: ["value"],
              $defs: { Value: { type: "string" } },
            },
            Value: value,
          },
        },
        oldPattern.resultSchema,
      );

    // The root's `Value` is the one named, so its default satisfies the new
    // required property; the `$defs` on `Entry` is inert.
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        previous,
        candidateWithRootValue({ type: "number", default: 1 }),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        previous,
        candidateWithRootValue({ type: "number" }),
      )
    ).toThrow(/argument\.item.*no default/);
  });

  it("keeps embedded ref roots while comparing unchanged native schemas", () => {
    const vnode = {
      $ref: "https://commonfabric.org/schemas/vnode.json",
    } as const;
    const previous = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          $UI: vnode,
          value: { type: "number" },
        },
        required: ["$UI", "value"],
      },
    );
    const candidate = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          $UI: vnode,
          value: { type: "number" },
          extra: { type: "string" },
        },
        required: ["$UI", "value"],
      },
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();
  });

  it("checks changed definitions behind unchanged local references", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: { Value: { type: "number" } },
      },
      oldPattern.resultSchema,
    );
    const candidate = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: { Value: { type: "string" } },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/argument\.value/);
  });

  it("checks changed definitions below unchanged inline containers", () => {
    const withNestedRef = (type: "number" | "string") =>
      pattern(
        {
          type: "object",
          properties: {
            container: {
              type: "object",
              properties: { value: { $ref: "#/$defs/Value" } },
            },
          },
          $defs: { Value: { type } },
        },
        oldPattern.resultSchema,
      );

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        withNestedRef("number"),
        withNestedRef("string"),
      )
    ).toThrow(/argument\.container\.value/);
  });

  it("resolves chained references and preserves reference siblings", () => {
    const previous = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Value", minimum: 0 },
        },
        $defs: {
          Value: { $ref: "#/$defs/Scalar" },
          Scalar: { type: "number" },
        },
      },
      oldPattern.resultSchema,
    );
    const compatible = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Value", minimum: -10 },
        },
        $defs: {
          Value: { $ref: "#/$defs/Scalar" },
          Scalar: { anyOf: [{ type: "number" }, { type: "string" }] },
        },
      },
      oldPattern.resultSchema,
    );
    const incompatible = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Value", minimum: 10 },
        },
        $defs: {
          Value: { $ref: "#/$defs/Scalar" },
          Scalar: { type: "number" },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, compatible))
      .not.toThrow();
    expect(() => assertPatternSchemasBackwardCompatible(previous, incompatible))
      .toThrow(/argument\.value/);
  });

  it("checks constraints alongside anyOf branches", () => {
    const previous = pattern(
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "number" }], minimum: 0 },
        },
      },
      {
        type: "object",
        properties: {
          doubled: { anyOf: [{ type: "number" }], maximum: 10 },
        },
      },
    );
    const argumentNarrowed = pattern(
      {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "number" }], minimum: 10 },
        },
      },
      previous.resultSchema,
    );
    const resultWidened = pattern(
      previous.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { anyOf: [{ type: "number" }], maximum: 20 },
        },
      },
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, argumentNarrowed)
    ).toThrow(/argument\.value/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, resultWidened)
    ).toThrow(/result\.doubled/);
  });

  it("rejects an incompatible argument type change", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "string" },
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(/argument\.value/);
  });

  it("rejects a new required argument without a default", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
          retries: { type: "number" },
        },
        required: ["value", "retries"],
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(
        /argument\.retries: newly required argument field has no default/,
      );
  });

  it("rejects a required object whose defaults are incomplete", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
          options: {
            type: "object",
            properties: {
              attempts: { type: "number", default: 1 },
              name: { type: "string" },
            },
            required: ["attempts", "name"],
          },
        },
        required: ["value", "options"],
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(
        /argument\.options: newly required argument field has no default/,
      );
  });

  it("rejects required defaults that violate scalar constraints", () => {
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
          retries: { type: "number", minimum: 10, default: 0 },
        },
        required: ["value", "retries"],
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(
        /argument\.retries: newly required argument field has no default/,
      );
  });

  it("rejects widening an existing result field", () => {
    const candidate = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { anyOf: [{ type: "number" }, { type: "string" }] },
          status: { type: "string" },
        },
        required: ["doubled"],
      },
    );

    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, candidate))
      .toThrow(/result\.doubled/);
  });

  it("accepts dropping an argument field the pattern no longer reads", () => {
    const droppedArgument = pattern(
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, droppedArgument)
    ).not.toThrow();
  });

  it("rejects dropping an argument field a closed candidate cannot hold", () => {
    const droppedArgument = pattern(
      {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
        additionalProperties: false,
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, droppedArgument)
    ).toThrow(
      /argument\.format: source field is rejected by the target object/,
    );
  });

  it("rejects removing an existing result field", () => {
    const missingResult = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { doubled: { type: "number" } },
        required: ["doubled"],
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, missingResult)
    )
      .toThrow(/result\.status: existing result field was removed/);
  });

  it("does not treat prototype properties as prior result fields", () => {
    const previous = pattern(oldPattern.argumentSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    const candidate = pattern(oldPattern.argumentSchema, {
      type: "object",
      properties: { toString: { type: "number" as const } },
      required: ["toString"],
      additionalProperties: false,
    });

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .toThrow(/result\.toString/);
  });

  it("handles boolean schemas conservatively", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(false, oldPattern.resultSchema),
        pattern({ type: "string" }, oldPattern.resultSchema),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(oldPattern.argumentSchema, oldPattern.resultSchema),
        pattern(true, oldPattern.resultSchema),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(true, oldPattern.resultSchema),
        pattern(false, oldPattern.resultSchema),
      )
    ).toThrow(/candidate schema rejects values accepted previously/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(true, oldPattern.resultSchema),
        pattern({ type: "string" }, oldPattern.resultSchema),
      )
    ).toThrow(/argument: the candidate no longer accepts every previous type/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "string" }, oldPattern.resultSchema),
        pattern(false, oldPattern.resultSchema),
      )
    ).toThrow(/candidate schema rejects values accepted previously/);
  });

  it("accepts equivalent unconstrained link contracts", () => {
    const targets: Exclude<JSONSchema, boolean>[] = [
      {},
      { description: "Any retained value" },
      { type: "unknown" },
      { default: "fallback" },
      {
        $ref: "#/$defs/Anything",
        $defs: { Anything: { title: "Any value" } },
      },
    ];
    for (const target of targets) {
      expect(() => assertSchemaSubset(true, target)).not.toThrow();
      expect(() => assertSchemaSubset(target, true)).not.toThrow();
      // A target carrying `$defs` is a document of its own; placed under a
      // wrapper, its definitions move to the wrapper's root, where its
      // `#/$defs/<name>` refs point.
      const { $defs, ...body } = target;
      const targetRoot: JSONSchema = {
        type: "object",
        additionalProperties: body,
        ...($defs !== undefined && { $defs }),
      };
      expect(() =>
        assertSchemaSubset(
          { type: "object" },
          targetRoot,
          "linked object",
          { targetRoot },
        )
      ).not.toThrow();
    }
  });

  it("reports the constraint that rejects unconstrained additional properties", () => {
    for (const additionalProperties of [undefined, true]) {
      const source: JSONSchema = { type: "object", additionalProperties };
      expect(() =>
        assertSchemaSubset(source, {
          type: "object",
          additionalProperties: { type: "string" },
        }, "linked object")
      ).toThrow(
        "linked object.*: the candidate no longer accepts every previous type",
      );
      expect(() =>
        assertSchemaSubset(source, {
          type: "object",
          additionalProperties: { maxLength: 3 },
        }, "linked object")
      ).toThrow("linked object.*: maxLength became more restrictive");
    }
  });

  it("fills an unconstrained required member's default for links but refuses its introduction from `true` during evolution", () => {
    // The link source requires a key no `FabricPrimitive` has, which keeps
    // every value it admits a record that can receive the default.

    const target: JSONSchema = {
      required: ["count"],
      properties: { count: { default: 1 } },
    };
    expect(() => assertSchemaSubset({ required: ["title"] }, target)).not
      .toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(true, true),
        pattern(target, true),
      )
    ).toThrow("argument.count: newly required argument field has no default");
  });

  it("accepts annotation changes on a defaulted union", () => {
    const source: JSONSchema = {
      type: ["string", "undefined"],
      default: "",
      description: "The producer's display name",
    };
    const target: JSONSchema = {
      ...source,
      description: "The consumer's display name",
      title: "Name",
      examples: ["A topic"],
      deprecated: true,
      tags: ["display"],
    };
    expect(() => assertSchemaSubset(source, target)).not.toThrow();
    expect(() => assertSchemaSubset(target, source)).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(source, source),
        pattern(target, target),
      )
    ).not.toThrow();
  });

  it("preserves restrictions beside changed annotations", () => {
    const source: JSONSchema = {
      type: ["string", "undefined"],
      default: "",
      description: "Producer",
    };
    const targets: Exclude<JSONSchema, boolean>[] = [
      { ...source, type: ["number", "undefined"], default: 0 },
      { ...source, asCell: ["readonly"] },
      { ...source, scope: "user" },
      { ...source, customConstraint: true } as Exclude<JSONSchema, boolean>,
    ];
    for (const target of targets) {
      expect(() =>
        assertSchemaSubset(source, { ...target, description: "Consumer" })
      ).toThrow();
    }
    for (
      const target of [
        { type: "string" },
        { type: "unknown", maxLength: 3 },
        { type: "unknown", asCell: ["readonly"] },
      ] satisfies JSONSchema[]
    ) {
      expect(() => assertSchemaSubset(true, target)).toThrow();
    }
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(true, true),
        pattern({ properties: { field: { type: "string" } } }, true),
      )
    ).toThrow(
      /argument\.field: the candidate no longer accepts every previous type/,
    );
    expect(() =>
      assertSchemaSubset(
        { const: { description: "Authored content" } },
        { const: { description: "Different content" } },
      )
    ).toThrow();
  });

  it("preserves default and reference semantics beside changed descriptions", () => {
    const withDefault = (description: string, value: string): JSONSchema => ({
      type: "array",
      uniqueItems: true,
      items: {
        type: "object",
        properties: { name: { type: "string", default: value, description } },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(withDefault("Producer", "old"), true),
        pattern(withDefault("Consumer", "new"), true),
      )
    ).toThrow(/defaults changed/);

    const withRef = (description: string): JSONSchema => ({
      $ref: "#/$defs/Value",
      description,
    });
    expect(() =>
      assertSchemaSubset(withRef("Producer"), withRef("Consumer"), "value", {
        sourceRoot: { $defs: { Value: { type: "number" } } },
        targetRoot: { $defs: { Value: { type: "string" } } },
      })
    ).toThrow();
  });

  it("judges a defaulted union's default once, on the union", () => {
    const narrow: JSONSchema = { type: ["string", "undefined"], default: "" };
    const wide: JSONSchema = {
      type: ["string", "number", "undefined"],
      default: "",
    };
    expect(() => assertSchemaSubset(narrow, wide)).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(narrow, true),
        pattern(wide, true),
      )
    ).not.toThrow();
    expect(() => assertSchemaSubset(wide, narrow)).toThrow(
      /schema alternative accepted previously/,
    );
    expect(() => assertSchemaSubset(narrow, { ...wide, default: true }))
      .toThrow(/not stable under default insertion/);
  });

  for (const boundary of ["asCell", "ifc", "uniqueItems"] as const) {
    const wrap = (schema: Exclude<JSONSchema, boolean>): JSONSchema =>
      boundary === "asCell"
        ? { ...schema, asCell: ["cell"] }
        : boundary === "ifc"
        ? {
          ...schema,
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: baselineIdentity },
          },
        }
        : { type: "array", uniqueItems: true, items: schema };

    it(`accepts safe single-type and union updates with unchanged defaults under \`${boundary}\``, () => {
      const single = wrap({ type: "string", default: "" });
      for (const type of [["string"], ["string", "undefined"]] as const) {
        const union = wrap({ type, default: "" });
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(single, true),
            pattern(union, true),
          )
        ).not.toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(true, union),
            pattern(true, single),
          )
        ).not.toThrow();
      }
    });

    it(`refuses narrowed arguments and widened results across single-type and union schemas under \`${boundary}\``, () => {
      const single = wrap({ type: "string", default: "" });
      const union = wrap({ type: ["string", "undefined"], default: "" });
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(union, true),
          pattern(single, true),
        )
      ).toThrow(/schema alternative accepted previously/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(true, single),
          pattern(true, union),
        )
      ).toThrow(/schema alternative accepted previously/);
    });

    const defaultChanges = boundary === "asCell" ? "accepts" : "refuses";
    it(`${defaultChanges} changed, added, or removed defaults during union expansion under \`${boundary}\``, () => {
      const single = wrap({ type: "string", default: "" });
      for (
        const schema of [
          { type: ["string", "undefined"], default: "changed" },
          { type: ["string", "undefined"] },
        ] satisfies JSONSchema[]
      ) {
        const union = wrap(schema);
        const updateArgument = () =>
          assertPatternSchemasBackwardCompatible(
            pattern(single, true),
            pattern(union, true),
          );
        const updateResult = () =>
          assertPatternSchemasBackwardCompatible(
            pattern(true, union),
            pattern(true, single),
          );
        if (boundary === "asCell") {
          expect(updateArgument).not.toThrow();
          expect(updateResult).not.toThrow();
        } else {
          expect(updateArgument).toThrow(/defaults changed/);
          expect(updateResult).toThrow(/defaults changed/);
        }
      }
    });
  }

  describe("semantic extensions on union nodes", () => {
    const a: JSONSchema = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    const b: JSONSchema = {
      type: "object",
      properties: { b: { type: "number" } },
    };
    const extensions = [
      { asCell: ["cell"] },
      { ifc: { confidentiality: ["secret"] } },
      { readOnly: true },
      { scope: "session" },
      { writeOnly: true },
    ] satisfies Exclude<JSONSchema, boolean>[];

    for (const extension of extensions) {
      const key = Object.keys(extension)[0];
      const single: JSONSchema = { ...a, ...extension };
      const union: JSONSchema = { anyOf: [a, b], ...extension };

      describe(key, () => {
        it("accepts argument widening from a single type to `anyOf`", () => {
          expect(() =>
            assertPatternSchemasBackwardCompatible(
              pattern(single, true),
              pattern(union, true),
            )
          ).not.toThrow();
        });

        it("accepts result narrowing from `anyOf` to a single type", () => {
          expect(() =>
            assertPatternSchemasBackwardCompatible(
              pattern(true, union),
              pattern(true, single),
            )
          ).not.toThrow();
        });

        it("accepts a single-type producer for a union demand", () => {
          expect(() => assertSchemaSubset(single, union)).not.toThrow();
        });

        it("refuses a union producer for a single-type demand", () => {
          expect(() => assertSchemaSubset(union, single)).toThrow(
            /schema alternative accepted previously/,
          );
        });

        it("refuses argument narrowing from `anyOf` to a single type", () => {
          expect(() =>
            assertPatternSchemasBackwardCompatible(
              pattern(union, true),
              pattern(single, true),
            )
          ).toThrow(/schema alternative accepted previously/);
        });

        it("refuses result widening from a single type to `anyOf`", () => {
          expect(() =>
            assertPatternSchemasBackwardCompatible(
              pattern(true, single),
              pattern(true, union),
            )
          ).toThrow(/schema alternative accepted previously/);
        });

        for (const role of ["argument", "result"] as const) {
          for (const change of ["adding", "removing"] as const) {
            it(`refuses ${change} the extension between two \`anyOf\` ${role} nodes`, () => {
              const bare: JSONSchema = { anyOf: [a, b] };
              const previous = change === "adding" ? bare : union;
              const candidate = change === "adding" ? union : bare;
              expect(() =>
                assertPatternSchemasBackwardCompatible(
                  role === "argument"
                    ? pattern(previous, true)
                    : pattern(true, previous),
                  role === "argument"
                    ? pattern(candidate, true)
                    : pattern(true, candidate),
                )
              ).toThrow(`${role}: ${key} changed`);
            });
          }
        }
      });
    }

    it("refuses changes to extensions on descendant properties", () => {
      const withHandle: JSONSchema = {
        anyOf: [
          {
            type: "object",
            properties: { value: { type: "string", asCell: ["cell"] } },
            required: ["value"],
          },
          { type: "null" },
        ],
        asCell: ["opaque"],
      };
      const withoutHandle: JSONSchema = {
        anyOf: [
          {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          { type: "null" },
        ],
        asCell: ["opaque"],
      };
      expect(() => assertSchemaSubset(withHandle, withoutHandle)).toThrow();
      expect(() => assertSchemaSubset(withoutHandle, withHandle)).toThrow();
    });

    it("accepts a `type` list and `anyOf` as equivalent union contracts", () => {
      const list: JSONSchema = {
        type: ["string", "undefined"],
        asCell: ["cell"],
      };
      const branches: JSONSchema = {
        anyOf: [{ type: "string" }, { type: "undefined" }],
        asCell: ["cell"],
      };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(list, branches),
          pattern(branches, list),
        )
      ).not.toThrow();
    });

    it("accepts optional opaque cells with a referenced payload", () => {
      // The generator represents `Cell<Doc | undefined>` as an `anyOf` of
      // `undefined` and a reference, beside `asCell: ["opaque"]`.

      const defs = {
        $defs: {
          Doc: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      } satisfies Exclude<JSONSchema, boolean>;
      const doc: JSONSchema = {
        $ref: "#/$defs/Doc",
        asCell: ["opaque"],
        ...defs,
      };
      const optionalDoc: JSONSchema = {
        anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Doc" }],
        asCell: ["opaque"],
        ...defs,
      };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(doc, optionalDoc),
          pattern(optionalDoc, doc),
        )
      ).not.toThrow();
      expect(() =>
        assertSchemaSubset(doc, optionalDoc, "value", {
          sourceRoot: doc,
          targetRoot: optionalDoc,
        })
      ).not.toThrow();
    });

    it("refuses a changed or missing capability across single and union nodes", () => {
      const cell: JSONSchema = { ...a, asCell: ["cell"] };
      for (
        const changed of [
          { anyOf: [a, b] },
          { anyOf: [a, b], asCell: ["readonly"] },
        ] satisfies JSONSchema[]
      ) {
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(cell, true),
            pattern(changed, true),
          )
        ).toThrow(/asCell changed/);
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(changed, true),
            pattern(cell, true),
          )
        ).toThrow(/asCell changed/);
      }
    });
  });

  it("rejects unresolved references and terminates on recursive references", () => {
    const unresolved = pattern(
      {
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Missing" },
          format: { type: "string" },
        },
      },
      oldPattern.resultSchema,
    );
    expect(() => assertPatternSchemasBackwardCompatible(oldPattern, unresolved))
      .toThrow(/cannot resolve schema reference/);

    const previousRecursive = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            description: "previous",
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
      },
      oldPattern.resultSchema,
    );
    const candidateRecursive = pattern(
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            description: "candidate",
            properties: { next: { $ref: "#/$defs/Node" } },
          },
        },
      },
      oldPattern.resultSchema,
    );
    assertPatternSchemasBackwardCompatible(
      previousRecursive,
      candidateRecursive,
    );
  });

  it("checks enum and const restrictions", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { enum: ["a", "b"] } },
      },
      oldPattern.resultSchema,
    );
    const introducedEnum = pattern(
      {
        type: "object",
        properties: { value: { enum: ["a"] } },
      },
      oldPattern.resultSchema,
    );
    const widenedEnum = pattern(
      {
        type: "object",
        properties: { value: { enum: ["a", "b", "c"] } },
      },
      oldPattern.resultSchema,
    );
    const introducedConst = pattern(
      {
        type: "object",
        properties: { value: { const: "a" } },
      },
      oldPattern.resultSchema,
    );
    const unconstrained = pattern(
      {
        type: "object",
        properties: { value: { type: "string" } },
      },
      oldPattern.resultSchema,
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(previous, introducedEnum)
    ).toThrow(/enum\/const no longer accepts every previous value/);
    expect(() => assertPatternSchemasBackwardCompatible(previous, widenedEnum))
      .not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(unconstrained, introducedConst)
    ).toThrow(/enum\/const became more restrictive/);
  });

  it("reads a bare enum's or const's type set from its values", () => {
    // `{enum: [...]}` with no `type`, the spelling a literal union compiles
    // to, admits exactly the types its values carry. So a `type: "string"`
    // schema accepts a string enum whichever proof reaches it, and an enum
    // candidate is judged by the enum rule rather than refused on type.

    const states = ["open", "draft", "merged", "closed"];
    expect(() => assertSchemaSubset({ enum: states }, { type: "string" }))
      .not.toThrow();
    expect(() => assertSchemaSubset({ const: "open" }, { type: "string" }))
      .not.toThrow();

    const argumentWith = (state: JSONSchema): Pattern =>
      pattern(
        { type: "object", properties: { state } },
        oldPattern.resultSchema,
      );
    const resultWith = (state: JSONSchema): Pattern =>
      pattern(
        oldPattern.argumentSchema,
        { type: "object", properties: { state } },
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentWith({ enum: states }),
        argumentWith({ type: "string" }),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentWith({ type: "string" }),
        argumentWith({ enum: states }),
      )
    ).toThrow(/argument\.state: enum\/const became more restrictive/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        resultWith({ type: "string" }),
        resultWith({ enum: states }),
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        resultWith({ enum: states }),
        resultWith({ type: "string" }),
      )
    ).toThrow(/result\.state: enum\/const became more restrictive/);
  });

  it("throws for a bare enum listing a value type the candidate does not accept", () => {
    // Each listed value contributes the type the runtime validates it as,
    // with an integral number an `integer`.

    expect(() => assertSchemaSubset({ enum: ["a", 1] }, { type: "string" }))
      .toThrow(/type integer is not accepted by the candidate schema/);
    expect(() => assertSchemaSubset({ enum: [1, 2.5] }, { type: "number" }))
      .not.toThrow();
    expect(() => assertSchemaSubset({ enum: [1, 2.5] }, { type: "integer" }))
      .toThrow(/type number is not accepted by the candidate schema/);
    expect(() => assertSchemaSubset({ enum: [null] }, { type: "null" }))
      .not.toThrow();
    expect(() =>
      assertSchemaSubset({ enum: [true, false] }, { type: "boolean" })
    ).not.toThrow();
    expect(() => assertSchemaSubset({ enum: [["a"]] }, { type: "array" }))
      .not.toThrow();
    expect(() => assertSchemaSubset({ enum: [{ a: 1 }] }, { type: "object" }))
      .not.toThrow();
  });

  it("narrows a declared type to the literal values listed beside it", () => {
    // `{type: "number", enum: [1, 2]}` and `{enum: [1, 2]}` accept the same
    // two values and read as the same `integer` schema: the declared type
    // bounds which listed values count, and those values bound the type.

    expect(() =>
      assertSchemaSubset({ type: "number", enum: [1, 2] }, { enum: [1, 2] })
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset({ enum: [1, 2] }, { type: "number", enum: [1, 2] })
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "integer", enum: [1, 2.5] },
        { type: "integer" },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", enum: [1, 2.5] },
        { type: "integer" },
      )
    ).toThrow(/type number is not accepted by the candidate schema/);
  });

  it("leaves a schema listing a `FabricPrimitive` value unbounded on type", () => {
    // The runtime checks an object schema's `required` keys on a
    // `FabricPrimitive` whenever the schema declares no `type` or admits
    // `object`, so the value's class name does not say which object
    // keywords reach it. Unbounded, the schema keeps the object proof
    // running against a target that also declares no type, so that link is
    // refused where the value validator rejects the value, and it is
    // refused on type against any typed target.

    const value = new FabricBytes(new Uint8Array([1]));
    const listed = { enum: [value] } as unknown as JSONSchema;
    const requiring = {
      enum: [value],
      required: ["source"],
    } as unknown as JSONSchema;
    expect(validateSchemaValue(requiring, value, requiring)).toBe(
      "missing required property source",
    );
    expect(() => assertSchemaSubset(listed, requiring))
      .toThrow(/value\.source: newly required argument field has no default/);
    for (
      const typed of [
        { type: "object", required: ["source"] },
        { type: "FabricBytes" },
      ] satisfies JSONSchema[]
    ) {
      expect(() => assertSchemaSubset(listed, typed))
        .toThrow(/the candidate no longer accepts every previous type/);
    }
  });

  describe("nested anyOf subsets", () => {
    const flat: JSONSchema = {
      anyOf: [{ enum: [false, true, "auto"] }, { type: "null" }],
    };

    for (const depth of [1, 2, 3]) {
      it(`accepts a source union at nesting depth ${depth}`, () => {
        let nested: JSONSchema = {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        };
        for (let level = 0; level < depth; level++) {
          nested = { anyOf: [nested], description: "A boolean or null" };
        }
        expect(() => assertSchemaSubset(nested, flat)).not.toThrow();
        expect(() => assertSchemaSubset(flat, nested)).toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(nested, flat),
            pattern(flat, nested),
          )
        ).not.toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(flat, true),
            pattern(nested, true),
          )
        ).toThrow(/argument:/);
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(true, nested),
            pattern(true, flat),
          )
        ).toThrow(/result:/);
      });
    }

    it("bounds repeated split retries while retaining whole-branch proofs", () => {
      let nested: JSONSchema = {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      };
      for (let depth = 0; depth < 128; depth++) {
        nested = { anyOf: [nested, { type: "null" }] };
      }
      expect(() => assertSchemaSubset(nested, flat))
        .toThrow(/a schema alternative/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(nested, flat),
          pattern(flat, nested),
        )
      ).toThrow(/argument:[\s\S]*result:/);

      // The same deep schema fits a single target alternative without the
      // supplementary split search, so the bound does not restrict that proof.
      const whole: JSONSchema = { enum: [false, true, null, "auto"] };
      expect(() => assertSchemaSubset(nested, whole)).not.toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(nested, whole),
          pattern(whole, nested),
        )
      ).not.toThrow();
    });

    it("spends the split bound on a nested shape one level at a time", () => {
      // The bound is spent along a proof path, so a nested shape whose every
      // level carries its own splitting union spends it one level at a time:
      // each level's descent happens inside that level's split. Seven levels
      // (eight unions, counting the leaf) is what the bound affords.
      const source = (levels: number): JSONSchema => ({
        anyOf: [{
          anyOf: [
            { type: "null" },
            levels === 0 ? { type: "boolean" } : {
              type: "object",
              properties: { f: source(levels - 1) },
              required: ["f"],
            },
          ],
        }],
      });
      const target = (levels: number): JSONSchema => ({
        anyOf: [
          { type: "null" },
          levels === 0 ? { enum: [false, true, "auto"] } : {
            type: "object",
            properties: { f: target(levels - 1) },
            required: ["f"],
          },
        ],
      });

      expect(() => assertSchemaSubset(source(7), target(7))).not.toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(source(7), target(7)),
          pattern(target(7), source(7)),
        )
      ).not.toThrow();

      // Past the bound the proof stops and refuses rather than widening.
      expect(() => assertSchemaSubset(source(64), target(64)))
        .toThrow(/a schema alternative/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(source(64), target(64)),
          pattern(target(64), source(64)),
        )
      ).toThrow(/argument:[\s\S]*result:/);
    });

    it("keeps comment-marked wrappers at their comparison boundary", () => {
      for (
        const $comment of [
          "emptyProperties",
          "missingProperty",
          "rejectedProperty",
          "A boolean or null",
        ]
      ) {
        const nested: JSONSchema = {
          anyOf: [{
            $comment,
            anyOf: [{ type: "boolean" }, { type: "null" }],
          }],
        };
        expect(() => assertSchemaSubset(nested, flat)).toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(nested, flat),
            pattern(flat, nested),
          )
        ).toThrow(/argument:[\s\S]*result:/);
      }
    });

    it("retains outer constraints when matching nested alternatives separately", () => {
      const nested: JSONSchema = {
        maxLength: 3,
        anyOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }],
      };
      const flat: JSONSchema = {
        maxLength: 3,
        anyOf: [{ type: "string" }, { type: "null" }],
      };
      expect(() => assertSchemaSubset(nested, flat)).not.toThrow();
      expect(() => assertSchemaSubset(nested, { ...flat, maxLength: 2 }))
        .toThrow();
    });

    it("resolves nested source references in their original root", () => {
      const nested: JSONSchema = {
        $defs: { value: { type: "boolean" } },
        anyOf: [{ anyOf: [{ $ref: "#/$defs/value" }, { type: "null" }] }],
      };
      const flat: JSONSchema = {
        $defs: { value: { enum: [false, true, "auto"] } },
        anyOf: [{ $ref: "#/$defs/value" }, { type: "null" }],
      };
      expect(() => assertSchemaSubset(nested, flat)).not.toThrow();
      expect(() =>
        assertSchemaSubset(nested, {
          ...flat,
          $defs: { value: { type: "string" } },
        })
      ).toThrow();
    });

    it("refuses a nested source alternative that the flat target excludes", () => {
      for (const branch of [{ type: "number" }, true] as const) {
        const nested: JSONSchema = {
          anyOf: [{ anyOf: [{ type: "boolean" }, branch] }],
        };
        expect(() => assertSchemaSubset(nested, flat)).toThrow();
      }
    });

    it("preserves a whole-union default while widening nested alternatives", () => {
      const nested: JSONSchema = {
        default: false,
        anyOf: [{ anyOf: [{ type: "boolean" }, { type: "null" }] }],
      };
      const defaulted: JSONSchema = { ...flat, default: false };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(nested, defaulted),
          pattern(defaulted, nested),
        )
      ).not.toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(nested, true),
          pattern({ ...defaulted, default: true }, true),
        )
      ).toThrow(/argument: defaults changed/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(true, defaulted),
          pattern(true, { ...nested, default: true }),
        )
      ).toThrow(/result: defaults changed/);
    });

    for (const referenced of [false, true]) {
      it(`keeps ${referenced ? "referenced" : "inline"} child defaults at the nested union boundary`, () => {
        for (
          const nullBranch of [{ type: "null" }, {
            type: "null",
            default: null,
          }] as const
        ) {
          const nested: JSONSchema = {
            $defs: { value: { type: "boolean", default: false } },
            anyOf: [{
              anyOf: [
                referenced
                  ? { $ref: "#/$defs/value" }
                  : { type: "boolean", default: false },
                nullBranch,
              ],
            }],
          };
          const defaulted: JSONSchema = {
            anyOf: [
              { enum: [false, true, "auto"], default: false },
              nullBranch,
            ],
          };
          expect(() => assertSchemaSubset(nested, defaulted)).not.toThrow();
          expect(() =>
            assertPatternSchemasBackwardCompatible(
              pattern(nested, true),
              pattern(defaulted, true),
            )
          ).toThrow(/argument:/);
          expect(() =>
            assertPatternSchemasBackwardCompatible(
              pattern(true, defaulted),
              pattern(true, nested),
            )
          ).toThrow(/result:/);
        }
      });
    }

    it("keeps constraints and semantic metadata on a nested union", () => {
      for (
        const metadata of [
          { asCell: ["cell"] },
          { readOnly: true },
          { not: { const: false } },
          { default: false },
        ] satisfies Exclude<JSONSchema, boolean>[]
      ) {
        const nested: JSONSchema = {
          anyOf: [{
            ...metadata,
            anyOf: [{ type: "boolean" }, { type: "null" }],
          }],
        };
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(nested, true),
            pattern(flat, true),
          )
        ).toThrow(/argument:/);
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(true, flat),
            pattern(true, nested),
          )
        ).toThrow(/result:/);
      }
    });

    it("keeps a nested union reached through a reference at its boundary", () => {
      const inline: JSONSchema = {
        $defs: { value: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
        anyOf: [{ anyOf: [{ type: "boolean" }, { type: "null" }] }],
      };
      const referenced: JSONSchema = {
        $defs: { value: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
        anyOf: [{ $ref: "#/$defs/value" }],
      };
      // Written inline the wrapper is transparent, so its children may take
      // different target alternatives.
      expect(() => assertSchemaSubset(inline, flat)).not.toThrow();
      // Named through a `$ref` it is not: the reference decides which schema
      // and which root the proof compares, so the wrapper keeps its own
      // boundary and the whole union has to fit one target alternative.
      expect(() => assertSchemaSubset(referenced, flat)).toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(referenced, true),
          pattern(flat, true),
        )
      ).toThrow(/argument:/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(true, flat),
          pattern(true, referenced),
        )
      ).toThrow(/result:/);
    });

    it("splits the generated cell union only when it carries no marker", () => {
      // The shape the generator emits for `Cell<Profile | undefined> |
      // undefined`, the only nested `anyOf` in the pattern baselines
      // (`cfc-group-chat-demo/main.tsx`, `authorProfile`). The result schema
      // spells the wrapper bare; the argument schema marks it a cell.
      const defs = {
        profile: { type: "object", properties: { name: { type: "string" } } },
      } satisfies Record<string, JSONSchema>;
      const nestedUnion = (
        marker: Exclude<JSONSchema, boolean>,
      ): JSONSchema => ({
        $defs: defs,
        anyOf: [
          { type: "undefined" },
          {
            ...marker,
            anyOf: [{ type: "undefined" }, { $ref: "#/$defs/profile" }],
          },
        ],
      });
      const flattened = (branch: JSONSchema): JSONSchema => ({
        $defs: defs,
        anyOf: [{ type: "undefined" }, branch],
      });

      const bare = nestedUnion({});
      const bareFlattened = flattened({ $ref: "#/$defs/profile" });
      expect(() => assertSchemaSubset(bare, bareFlattened)).not.toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(bare, bareFlattened),
          pattern(bareFlattened, bare),
        )
      ).not.toThrow();

      // Splitting the marked wrapper would drop the marker. The flattened
      // target admits a cell of the profile and a plain `undefined`, but not
      // a cell holding `undefined`, so that transition narrows and stays
      // refused in both roles.
      const marked = nestedUnion({ asCell: ["cell"] });
      const markedFlattened = flattened({
        asCell: ["cell"],
        $ref: "#/$defs/profile",
      });
      expect(() => assertSchemaSubset(marked, markedFlattened)).toThrow();
      // Dropping the marker outright is the transition a split that looked
      // past it would wrongly admit: a cell is not a profile.
      expect(() => assertSchemaSubset(marked, bareFlattened)).toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(marked, true),
          pattern(markedFlattened, true),
        )
      ).toThrow(/argument:/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(true, markedFlattened),
          pattern(true, marked),
        )
      ).toThrow(/result:/);
    });
  });

  describe("type lists inside alternatives", () => {
    // A `type` list and the `anyOf` spelling of the same union describe the
    // same values, and a list wrapped in a one-branch `anyOf` describes what
    // the bare list does. The proof splits a list into one branch per named
    // type wherever it is written, so none of those spellings decides a
    // verdict on its own.
    const spellings = (list: JSONSchema): [string, JSONSchema][] => [
      ["bare", list],
      ["inside `anyOf`", { anyOf: [list] }],
      ["nested in `anyOf`", { anyOf: [{ anyOf: [list] }] }],
    ];

    for (
      const [name, list, target, compatible] of [
        [
          "widening a list to the union spelling",
          { type: ["boolean", "string"] },
          { anyOf: [{ type: "boolean" }, { type: "string" }] },
          true,
        ],
        [
          "dropping a listed type",
          { type: ["boolean", "string"] },
          { anyOf: [{ type: "boolean" }] },
          false,
        ],
        [
          "a sibling constraint the target keeps",
          { type: ["string", "number"], maxLength: 3 },
          { anyOf: [{ type: "string", maxLength: 3 }, { type: "number" }] },
          true,
        ],
        [
          "a sibling constraint the target tightens",
          { type: ["string", "number"], maxLength: 3 },
          { anyOf: [{ type: "string", maxLength: 2 }, { type: "number" }] },
          false,
        ],
        [
          "a list naming `object`",
          { type: ["object", "string"] },
          { anyOf: [{ type: "object" }, { type: "string" }] },
          true,
        ],
        [
          // `unknown` admits every value, so no branch of the target covers it.
          "a list naming `unknown`",
          { type: ["unknown", "string"] },
          { anyOf: [{ type: "boolean" }, { type: "string" }] },
          false,
        ],
        [
          // `object` admits every `FabricPrimitive`, so the primitive name adds
          // no branch of its own and the runtime's `required` check is kept.
          "a list naming `object` beside a `FabricPrimitive` and `required`",
          {
            type: ["object", "FabricBytes"],
            properties: { k: { type: "string" } },
            required: ["k"],
          },
          {
            anyOf: [
              {
                type: "object",
                properties: { k: { type: "string" } },
                required: ["k"],
              },
              { type: "FabricBytes" },
            ],
          },
          true,
        ],
      ] satisfies [string, JSONSchema, JSONSchema, boolean][]
    ) {
      it(`proves ${name} the same way wherever the list is spelled`, () => {
        for (const [, source] of spellings(list)) {
          if (compatible) {
            expect(() => assertSchemaSubset(source, target)).not.toThrow();
            expect(() =>
              assertPatternSchemasBackwardCompatible(
                pattern(source, target),
                pattern(target, source),
              )
            ).not.toThrow();
          } else {
            expect(() => assertSchemaSubset(source, target)).toThrow();
            expect(() =>
              assertPatternSchemasBackwardCompatible(
                pattern(source, true),
                pattern(target, true),
              )
            ).toThrow(/argument:/);
            expect(() =>
              assertPatternSchemasBackwardCompatible(
                pattern(true, target),
                pattern(true, source),
              )
            ).toThrow(/result:/);
          }
        }
      });
    }

    it("re-spells a generated scalar branch without breaking the contract", () => {
      // `JsonValue` as the generator emits it: a scalar `type` list as one
      // branch of the union (`agent-sessions-debug/main.tsx`).
      const union = (scalars: JSONSchema[]): JSONSchema => ({
        anyOf: [
          ...scalars,
          { type: "boolean" },
          { type: "array", items: { type: "unknown" } },
        ],
      });
      const listed = union([{
        type: ["null", "number", "string", "undefined"],
      }]);
      for (
        const respelled of [
          union([
            { type: "null" },
            { type: "number" },
            { type: "string" },
            { type: "undefined" },
          ]),
          union([{ type: ["null", "number"] }, {
            type: ["string", "undefined"],
          }]),
        ]
      ) {
        expect(() => assertSchemaSubset(listed, respelled)).not.toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(listed, respelled),
            pattern(respelled, listed),
          )
        ).not.toThrow();
      }

      // Dropping a member of the list is still a break, however it is spelled.
      const narrowed = union([{ type: ["null", "number", "string"] }]);
      expect(() => assertSchemaSubset(listed, narrowed)).toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(listed, true),
          pattern(narrowed, true),
        )
      ).toThrow(/argument:/);
    });
  });

  describe("finite literal subsets", () => {
    it("does not throw for listed values excluded by the source's declared type", () => {
      for (
        const [source, target] of [
          [
            { type: "string", enum: ["open", null] },
            { enum: ["open", "closed"] },
          ],
          [{ type: "integer", enum: [1, 2.5] }, { const: 1 }],
          [{ type: "number", enum: [1, "open"] }, { enum: [1, 2] }],
          [{ type: "null", enum: [null, "open"] }, { const: null }],
          [
            { type: "string", const: "open", enum: ["open", null] },
            { enum: ["open", "closed"] },
          ],
        ] satisfies [JSONSchema, JSONSchema][]
      ) {
        expect(() => assertSchemaSubset(source, target)).not.toThrow();
      }
    });

    it("throws when the target excludes a value admitted by the source's type", () => {
      expect(() =>
        assertSchemaSubset(
          { type: "number", enum: [1, 2.5] },
          { type: "integer", enum: [1, 2.5] },
        )
      ).toThrow();
      expect(() =>
        assertSchemaSubset(
          { type: "unknown", enum: ["open", null] },
          { enum: ["open", "closed"] },
        )
      ).toThrow(/enum\/const/);
    });

    it("does not throw for a `null` type against an enum or const admitting `null`", () => {
      for (const source of [{ type: "null" }, { type: ["null"] }] as const) {
        expect(() => assertSchemaSubset(source, { enum: [null] })).not
          .toThrow();
        expect(() => assertSchemaSubset(source, { const: null })).not
          .toThrow();
        expect(() => assertSchemaSubset(source, { enum: ["open"] })).toThrow();
      }
    });

    it("accepts a boolean type against an enum admitting both boolean values", () => {
      for (
        const source of [{ type: "boolean" }, { type: ["boolean"] }] as const
      ) {
        for (
          const target of [
            { enum: [false, true] },
            { enum: [false, true, "auto"] },
            { type: "boolean", enum: [false, true, "auto"] },
          ] satisfies JSONSchema[]
        ) {
          expect(() => assertSchemaSubset(source, target)).not.toThrow();
        }
      }
    });

    it("refuses a boolean target enum or const that omits either boolean value", () => {
      for (const value of [false, true]) {
        for (const target of [{ enum: [value, "auto"] }, { const: value }]) {
          expect(() => assertSchemaSubset({ type: "boolean" }, target))
            .toThrow(/enum\/const/);
        }
      }
      expect(() =>
        assertSchemaSubset(
          { type: "boolean" },
          { type: "string", enum: [false, true, "auto"] },
        )
      ).toThrow(/enum\/const/);
    });

    it("checks sibling constraints after proving boolean enum membership", () => {
      expect(() =>
        assertSchemaSubset(
          { type: "boolean" },
          { enum: [false, true], not: { const: false } },
        )
      ).toThrow(/not changed/);
    });

    it("retains a boolean source's explicit enum and const restrictions", () => {
      for (const value of [false, true]) {
        for (
          const source of [
            { type: "boolean", enum: [value] },
            { type: "boolean", const: value },
            { type: "boolean", const: value, enum: [false, true] },
          ] satisfies JSONSchema[]
        ) {
          expect(() => assertSchemaSubset(source, { const: value })).not
            .toThrow();
          expect(() => assertSchemaSubset(source, { const: !value })).toThrow(
            /enum\/const/,
          );
        }
      }
    });

    it("permits boolean argument widening and result narrowing through unions", () => {
      const literalUnion: JSONSchema = { enum: [false, true, null, "auto"] };
      for (
        const [narrower, wider] of [
          [{ type: "boolean" }, literalUnion],
          [{ type: ["boolean", "null"] }, literalUnion],
          [{ anyOf: [{ type: "boolean" }, { type: "null" }] }, literalUnion],
          [
            { anyOf: [{ anyOf: [{ type: "boolean" }, { type: "null" }] }] },
            literalUnion,
          ],
          [
            { anyOf: [{ type: "boolean" }, { type: "null" }] },
            { anyOf: [{ enum: [false, true, "auto"] }, { type: "null" }] },
          ],
        ] satisfies [JSONSchema, JSONSchema][]
      ) {
        expect(() => assertSchemaSubset(narrower, wider)).not.toThrow();
        expect(() => assertSchemaSubset(wider, narrower)).toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(narrower, wider),
            pattern(wider, narrower),
          )
        ).not.toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(wider, true),
            pattern(narrower, true),
          )
        ).toThrow(/argument:/);
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(true, narrower),
            pattern(true, wider),
          )
        ).toThrow(/result:/);
      }
    });

    it("permits boolean widening that preserves its effective default", () => {
      for (const value of [false, true]) {
        const narrower: JSONSchema = { type: "boolean", default: value };
        const wider: JSONSchema = {
          enum: [false, true, "auto"],
          default: value,
        };
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(narrower, wider),
            pattern(wider, narrower),
          )
        ).not.toThrow();
        for (
          const changed of [
            {
              enum: [false, true, "auto"],
              default: value === false ? true : "auto",
            },
            { enum: [false, true, "auto"] },
          ] satisfies JSONSchema[]
        ) {
          expect(() =>
            assertPatternSchemasBackwardCompatible(
              pattern(narrower, true),
              pattern(changed, true),
            )
          ).toThrow(/defaults changed/);
        }
      }
    });

    it("permits nullable literal argument widening and result narrowing", () => {
      const wider: JSONSchema = { enum: ["open", "closed", null] };
      for (
        const narrower of [
          { type: "null" },
          { anyOf: [{ type: "string", enum: ["open"] }, { type: "null" }] },
        ] satisfies JSONSchema[]
      ) {
        expect(() => assertSchemaSubset(narrower, wider)).not.toThrow();
        expect(() => assertSchemaSubset(wider, narrower)).toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(narrower, wider),
            pattern(wider, narrower),
          )
        ).not.toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(wider, true),
            pattern(narrower, true),
          )
        ).toThrow(/argument:/);
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(true, narrower),
            pattern(true, wider),
          )
        ).toThrow(/result:/);
      }
    });

    for (
      const [name, source] of [
        ["a type list", { type: ["string", "null"], enum: ["open", null] }],
        ["an `anyOf` sibling", { enum: ["open", null], anyOf: [{}] }],
        ["an `anyOf` branch", { anyOf: [{ enum: ["open", null] }] }],
        [
          "a nested `anyOf` branch",
          { anyOf: [{ anyOf: [{ enum: ["open", null] }] }] },
        ],
        [
          "a type list inside `anyOf`",
          { anyOf: [{ type: ["string", "null"], enum: ["open", null] }] },
        ],
      ] satisfies [string, JSONSchema][]
    ) {
      it(`compares mixed enums in ${name} against each target branch`, () => {
        const target: JSONSchema = {
          anyOf: [{ enum: ["open", "closed"] }, { type: "null" }],
        };
        for (const value of ["open", null]) {
          expect(validateSchemaValue(source, value, source)).toBeUndefined();
          expect(validateSchemaValue(target, value, target)).toBeUndefined();
        }
        expect(() => assertSchemaSubset(source, target)).not.toThrow();
        expect(() => assertSchemaSubset(source, { type: ["string", "null"] }))
          .not.toThrow();
        expect(() =>
          assertSchemaSubset(source, {
            anyOf: [{ enum: ["closed"] }, { type: "null" }],
          })
        ).toThrow();
        expect(() =>
          assertSchemaSubset(source, { type: ["string", "integer"] })
        ).toThrow();
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(source, target),
            pattern(target, source),
          )
        ).not.toThrow();
      });
    }

    for (
      const [name, metadata] of [
        ["asCell", { asCell: ["cell"] }],
        ["readOnly", { readOnly: true }],
        ["default", { default: "open" }],
      ] satisfies [string, Exclude<JSONSchema, boolean>][]
    ) {
      it(`accepts mixed-enum widening in a branch retaining its \`${name}\``, () => {
        const withValues = (values: string[]): JSONSchema => ({
          anyOf: [
            { type: "number" },
            { enum: [...values, null], ...metadata },
          ],
        });
        const narrower = withValues(["open", "closed"]);
        const wider = withValues(["open", "closed", "archived"]);
        expect(() => assertSchemaSubset(narrower, wider)).not.toThrow();
        expect(() => assertSchemaSubset(wider, narrower)).toThrow(
          /schema alternative accepted previously/,
        );
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(narrower, wider),
            pattern(wider, narrower),
          )
        ).not.toThrow();
      });
    }

    for (
      const [name, nested, definitions] of [
        ["on the union", {
          anyOf: [
            { type: "number" },
            { enum: ["open", "closed", null] },
          ],
          default: "open",
        }, {}],
        ["on a child branch", {
          anyOf: [
            { type: "number" },
            { enum: ["open", "closed", null], default: "open" },
          ],
        }, {}],
        ["in a referenced child branch", {
          anyOf: [
            { $ref: "#/$defs/state" },
            { enum: [1, true] },
          ],
        }, {
          state: { enum: ["open", "closed", null], default: "open" },
        }],
        ["when child defaults conflict", {
          anyOf: [
            { type: "number", default: 1 },
            { enum: ["open", "closed", null], default: "open" },
          ],
        }, {}],
      ] satisfies [
        string,
        Exclude<JSONSchema, boolean>,
        Record<string, JSONSchema>,
      ][]
    ) {
      it(`preserves defaults in an unchanged nested union ${name}`, () => {
        const branch = { ...nested, asCell: ["cell"] } as const;
        const narrower: JSONSchema = {
          anyOf: [{ type: "string" }, branch],
          $defs: definitions,
        };
        const wider: JSONSchema = {
          anyOf: [{ type: "string" }, { type: "boolean" }, branch],
          $defs: definitions,
        };
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(narrower, wider),
            pattern(wider, narrower),
          )
        ).not.toThrow();
      });
    }

    it("refuses changed effective defaults in a nested union", () => {
      const withDefault = (fallback: string): JSONSchema => ({
        anyOf: [{
          anyOf: [
            { type: "number" },
            { enum: ["open", "closed", null] },
          ],
          default: fallback,
          asCell: ["cell"],
        }],
      });
      const previous = withDefault("open");
      const candidate = withDefault("closed");
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(previous, true),
          pattern(candidate, true),
        )
      ).toThrow(/argument: defaults changed/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(true, previous),
          pattern(true, candidate),
        )
      ).toThrow(/result: defaults changed/);
    });

    it("partitions a defaulted source union for a link without migrating its default", () => {
      const source: JSONSchema = {
        anyOf: [{
          anyOf: [{ type: "number" }, { enum: ["open", "closed", null] }],
          default: "open",
        }],
      };
      const target: JSONSchema = {
        anyOf: [
          { type: ["null", "number"] },
          { type: "string", enum: ["closed", "open"] },
        ],
      };
      expect(() => assertSchemaSubset(source, target)).not.toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(source, true),
          pattern(target, true),
        )
      ).toThrow(/argument: defaults changed/);
    });

    it("accepts an unchanged type-list sibling while widening a mixed enum", () => {
      const withValues = (values: string[]): JSONSchema => ({
        anyOf: [
          { type: ["null", "number"] },
          { enum: [...values, 1] },
        ],
      });
      const narrower = withValues(["open"]);
      const wider = withValues(["open", "closed"]);
      expect(() => assertSchemaSubset(narrower, wider)).not.toThrow();
      expect(() => assertSchemaSubset(wider, narrower)).toThrow(
        /schema alternative accepted previously/,
      );
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(narrower, wider),
          pattern(wider, narrower),
        )
      ).not.toThrow();
    });

    it("compares a referenced mixed enum against the whole target enum", () => {
      const source: JSONSchema = {
        anyOf: [{ $ref: "#/$defs/state" }],
        $defs: { state: { enum: ["open", null] } },
      };
      expect(() =>
        assertSchemaSubset(source, { enum: ["open", "closed", null] })
      ).not.toThrow();
      expect(() => assertSchemaSubset(source, { enum: ["open", "closed"] }))
        .toThrow(/schema alternative accepted previously/);
    });

    it("retains sibling constraints and branch extensions when splitting enums", () => {
      const source: JSONSchema = {
        enum: ["open", null],
        anyOf: [{ type: "string", minLength: 4 }, { type: "null" }],
      };
      const target: JSONSchema = {
        anyOf: [{ type: "string", minLength: 5 }, { type: "null" }],
      };
      expect(validateSchemaValue(source, "open", source)).toBeUndefined();
      expect(validateSchemaValue(target, "open", target)).toBeDefined();
      expect(() => assertSchemaSubset(source, target)).toThrow(
        /schema alternative accepted previously/,
      );
      expect(() =>
        assertSchemaSubset(
          { anyOf: [{ enum: ["open", null], readOnly: true }] },
          { type: ["string", "null"] },
        )
      ).toThrow(/schema alternative accepted previously/);
    });

    it("leaves mixed enums containing an unclassified value whole", () => {
      const value = FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY.FabricBytes[0];
      const source = { enum: ["open", value] } as unknown as JSONSchema;
      const target = {
        anyOf: [{ type: "string" }, { enum: [value] }],
      } as unknown as JSONSchema;
      for (const admitted of ["open", value]) {
        expect(validateSchemaValue(source, admitted, source)).toBeUndefined();
        expect(validateSchemaValue(target, admitted, target)).toBeUndefined();
      }
      expect(() => assertSchemaSubset(source, target)).toThrow(
        /schema alternative accepted previously/,
      );
    });

    it("retains `FabricPrimitive` values while splitting a declared type list", () => {
      const source = {
        type: ["string", "null", "object"],
        enum: [
          "open",
          null,
          FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY.FabricBytes[0],
        ],
      } as unknown as JSONSchema;
      const target: JSONSchema = { type: ["string", "null"] };
      expect(
        validateSchemaValue(
          source,
          FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY.FabricBytes[0],
          source,
        ),
      )
        .toBeUndefined();
      expect(() => assertSchemaSubset(source, target)).toThrow();
    });

    it("refuses changed descendant defaults beneath a split object enum", () => {
      const source: JSONSchema = { anyOf: [{ enum: ["open", {}] }] };
      const target: JSONSchema = {
        anyOf: [
          { type: "string" },
          { type: "object", properties: { count: { default: 1 } } },
        ],
      };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(source, true),
          pattern(target, true),
        )
      ).toThrow(/not stable under default insertion/);
    });
  });

  describe("bare enums spanning several types", () => {
    // A literal union with `null` among its members compiles to one bare enum,
    // `{enum: ["open", "closed", null]}`, and a `string | null` consumer to a
    // type list or an `anyOf`.

    const nullableUnion: JSONSchema = { enum: ["open", "closed", null] };
    const stringOrNull: JSONSchema = {
      anyOf: [{ type: "string" }, { type: "null" }],
    };

    it("does not throw when a type list or `anyOf` candidate has a branch accepting each listed value's type", () => {
      expect(() =>
        assertSchemaSubset(nullableUnion, { type: ["string", "null"] })
      ).not.toThrow();
      expect(() => assertSchemaSubset(nullableUnion, stringOrNull))
        .not.toThrow();
      expect(() =>
        assertSchemaSubset(nullableUnion, {
          anyOf: [{ enum: ["open", "closed"] }, { type: "null" }],
        })
      ).not.toThrow();
      expect(() =>
        assertSchemaSubset({ enum: ["a", 1] }, { type: ["string", "integer"] })
      ).not.toThrow();
    });

    it("throws when a listed value has no candidate branch accepting it", () => {
      // No branch of the first candidate admits `null`. The `string` branch
      // of the second lists `open` alone, and the enum rule refuses `closed`.

      expect(() =>
        assertSchemaSubset({ enum: ["open", null] }, {
          type: ["string", "integer"],
        })
      ).toThrow(/schema alternative accepted previously/);
      expect(() =>
        assertSchemaSubset(nullableUnion, {
          anyOf: [{ enum: ["open"] }, { type: "null" }],
        })
      ).toThrow(/schema alternative accepted previously/);
    });

    it("throws for an enum listing a `FabricPrimitive` value beside values the candidate's branches accept", () => {
      // A listed `FabricPrimitive` leaves the enum unbounded on type, so its
      // values are not taken apart by type, and no typed branch accepts the
      // enum whole. Here `open` and `null` each have a branch, and the
      // `FabricBytes` value has none.

      const listed = {
        enum: ["open", null, new FabricBytes(new Uint8Array([1]))],
      } as unknown as JSONSchema;
      expect(() => assertSchemaSubset(listed, stringOrNull))
        .toThrow(/schema alternative accepted previously/);
    });

    it("does not throw for a typed enum with a type list against branches accepting its values", () => {
      // Each `type` in the list narrows the listed values to its own: the
      // `string` branch reads as `open` alone and the `null` branch as `null`
      // alone, which a `string` candidate refuses.

      const typed: JSONSchema = {
        type: ["string", "null"],
        enum: ["open", null],
      };
      expect(() => assertSchemaSubset(typed, { type: ["string", "null"] }))
        .not.toThrow();
      expect(() => assertSchemaSubset(typed, stringOrNull)).not.toThrow();
      expect(() => assertSchemaSubset(typed, { type: "string" }))
        .toThrow(/schema alternative accepted previously/);
    });

    it("does not throw for a source branch listing values of several types against a bare enum candidate listing them all", () => {
      // A candidate enum stays whole. A source branch has to fit inside a
      // single candidate branch, and one listing values of several types fits
      // only the whole enum.

      expect(() =>
        assertSchemaSubset(
          { type: ["string", "null"], enum: ["open", null] },
          nullableUnion,
        )
      ).not.toThrow();
      expect(() =>
        assertSchemaSubset(
          { anyOf: [{ enum: ["open", null] }, { enum: [1] }] },
          { enum: ["open", null, 1] },
        )
      ).not.toThrow();
    });

    it("throws for a type list or `anyOf` source against a bare enum candidate", () => {
      // The `string` branch of either source meets the candidate enum whole,
      // and a `string` schema admits values the enum does not list. The last
      // case is that branch alone, refused by the enum rule.

      const candidate: JSONSchema = { enum: ["open", null] };
      expect(() => assertSchemaSubset({ type: ["string", "null"] }, candidate))
        .toThrow(/schema alternative accepted previously/);
      expect(() => assertSchemaSubset(stringOrNull, candidate))
        .toThrow(/schema alternative accepted previously/);
      expect(() => assertSchemaSubset({ type: "string" }, candidate))
        .toThrow(/enum\/const became more restrictive/);
    });

    it("throws for a pattern update across the union only where it narrows an argument or widens a result", () => {
      const argumentWith = (state: JSONSchema): Pattern =>
        pattern(
          { type: "object", properties: { state } },
          oldPattern.resultSchema,
        );
      const resultWith = (state: JSONSchema): Pattern =>
        pattern(
          oldPattern.argumentSchema,
          { type: "object", properties: { state } },
        );
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          argumentWith(nullableUnion),
          argumentWith(stringOrNull),
        )
      ).not.toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          argumentWith(stringOrNull),
          argumentWith(nullableUnion),
        )
      ).toThrow(/argument\.state: a schema alternative accepted previously/);
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          resultWith(stringOrNull),
          resultWith(nullableUnion),
        )
      ).not.toThrow();
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          resultWith(nullableUnion),
          resultWith(stringOrNull),
        )
      ).toThrow(/result\.state: a schema alternative accepted previously/);
    });
  });

  it("keeps a composition unstable under defaults while a branch a default reaches lists the whole value", () => {
    // Disjoint branch types keep a value from moving between branches, but a
    // default inserted from a sibling `properties` still lands inside an
    // object the value occupies. A branch listing that object whole, bare or
    // typed, no longer matches it afterwards, so the default is refused. A
    // branch admitting only scalars receives no default, and leaves the
    // composition stable beside an open object branch.

    const withBranch = (
      combinator: "anyOf" | "oneOf",
      branch: JSONSchema,
    ): JSONSchema => ({
      type: "object",
      [combinator]: [branch, { type: "string" }],
      properties: { a: { type: "number", default: 1 } },
    });
    for (const combinator of ["anyOf", "oneOf"] as const) {
      for (
        const branch of [
          { enum: [{}] },
          { type: "object", enum: [{}] },
        ] satisfies JSONSchema[]
      ) {
        const schema = withBranch(combinator, branch);
        expect(() => assertSchemaSubset(schema, schema))
          .toThrow(/not stable under default insertion/);
      }
    }
    const scalarBranch: JSONSchema = {
      type: "object",
      anyOf: [
        { type: "object", properties: { b: { type: "number" } } },
        { enum: ["none"] },
      ],
      properties: { a: { type: "number", default: 1 } },
    };
    expect(() => assertSchemaSubset(scalarBranch, scalarBranch)).not.toThrow();
  });

  it("treats `FabricPrimitive` types as subtypes of object (one-way)", () => {
    // A "FabricBytes" source widens safely into an "object" target; the
    // reverse narrows and must be flagged. Same-type stays compatible.

    expect(() =>
      assertSchemaSubset({ type: "FabricBytes" }, { type: "object" })
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset({ type: "FabricBytes" }, { type: "FabricBytes" })
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset({ type: "object" }, { type: "FabricBytes" })
    ).toThrow(/type object is not accepted/);
    expect(() =>
      assertSchemaSubset({ type: "FabricBytes" }, { type: "FabricHash" })
    ).toThrow(/type FabricBytes is not accepted/);
  });

  describe("`required` against a `FabricPrimitive`-typed source", () => {
    // The runtime checks a target's `required` keys on a `FabricPrimitive`
    // with `in` when the target declares no `type` or its type list includes
    // `object`, excusing the brand key, and leaves them unchecked under a
    // target typed some other way. Each case reads the validator's verdict on
    // a value of the source's class beside the proof's, so the two agree on
    // the spelling in front of them.

    const bytesSource: JSONSchema = { type: "FabricBytes" };
    const bytes = new FabricBytes(new Uint8Array([1]));

    it("refuses an `object` target requiring a key `FabricBytes` does not carry", () => {
      const target: JSONSchema = { type: "object", required: ["source"] };
      expect(validateSchemaValue(target, bytes, target)).toBe(
        "missing required property source",
      );
      expect(() => assertSchemaSubset(bytesSource, target)).toThrow(
        /value\.source: required field is not a member of `FabricBytes`/,
      );
    });

    it("accepts an `object` target requiring a member every `FabricBytes` carries", () => {
      const target: JSONSchema = { type: "object", required: ["length"] };
      expect(validateSchemaValue(target, bytes, target)).toBeUndefined();
      expect(() => assertSchemaSubset(bytesSource, target)).not.toThrow();
    });

    it("accepts a `FabricBytes` target requiring a key `FabricBytes` does not carry", () => {
      const target: JSONSchema = { type: "FabricBytes", required: ["source"] };
      expect(validateSchemaValue(target, bytes, target)).toBeUndefined();
      expect(() => assertSchemaSubset(bytesSource, target)).not.toThrow();
    });

    it("refuses the missing key under an untyped target, a type list including `object`, and a required `anyOf` base", () => {
      // A type list is proved branch by branch, and an `anyOf` as its base
      // beside each branch, so these reach the proof by other routes than a
      // node typed `object` does.

      const cases: [JSONSchema, RegExp][] = [
        [
          { required: ["source"] },
          /value\.source: required field is not a member of `FabricBytes`/,
        ],
        [
          { type: ["FabricBytes", "object"], required: ["source"] },
          /a schema alternative accepted previously is not accepted/,
        ],
        [
          { type: ["unknown", "object"], required: ["source"] },
          /a schema alternative accepted previously is not accepted/,
        ],
        [
          { anyOf: [{ type: "FabricBytes" }], required: ["source"] },
          /a schema alternative accepted previously is not accepted/,
        ],
      ];
      for (const [target, issue] of cases) {
        expect(validateSchemaValue(target, bytes, target)).toBe(
          "missing required property source",
        );
        expect(() => assertSchemaSubset(bytesSource, target)).toThrow(issue);
      }
    });

    it("accepts the missing key under a target typed `unknown` or by a type list without `object`", () => {
      for (
        const target of [
          { type: "unknown", required: ["source"] },
          { type: ["FabricBytes", "string"], required: ["source"] },
        ] satisfies JSONSchema[]
      ) {
        expect(validateSchemaValue(target, bytes, target)).toBeUndefined();
        expect(() => assertSchemaSubset(bytesSource, target)).not.toThrow();
      }
    });

    it("refuses exactly the member names the validator finds missing, for every class in the vocabulary", () => {
      const verdicts: { type: string; name: string; accepted: boolean }[] = [];
      const disagreements: typeof verdicts = [];
      for (const type of FABRIC_PRIMITIVE_SCHEMA_TYPES) {
        for (const name of fabricPrimitiveMemberNames()) {
          const target: JSONSchema = { type: "object", required: [name] };
          const accepted = validateSchemaValue(
            target,
            fabricPrimitiveValueOf(type),
            target,
          ) === undefined;
          let proved = true;
          try {
            assertSchemaSubset({ type }, target);
          } catch {
            proved = false;
          }
          verdicts.push({ type, name, accepted });
          if (proved !== accepted) disagreements.push({ type, name, accepted });
        }
      }
      expect(disagreements).toEqual([]);
      expect(verdicts).toContainEqual({
        type: "FabricHash",
        name: "tag",
        accepted: true,
      });
      expect(verdicts).toContainEqual({
        type: "FabricBytes",
        name: "tag",
        accepted: false,
      });
    });
  });

  describe("a newly required field's default against a source admitting a `FabricPrimitive`", () => {
    // Default insertion cannot add a key to a `FabricPrimitive`, since every
    // instance is frozen, and the runtime checks `required` keys on one with
    // `in`. Each link case reads the validator's verdict on a value beside the
    // proof's, so the two agree on the spelling in front of them.

    const bytes = FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY.FabricBytes[0];
    const hash = FABRIC_PRIMITIVE_EXAMPLES_FOR_TESTING_ONLY.FabricHash[0];
    const defaulted = (key: string, required: string[] = []): JSONSchema => ({
      type: "object",
      properties: { [key]: { default: 1 } },
      required: [...required, key],
    });

    it("throws for a link whose `object`, `true`, or `unknown` source admits a `FabricBytes` lacking the field", () => {
      // The runtime does not check `required` under `type: "unknown"`, so the
      // `unknown` source admits every `FabricPrimitive` whatever it requires.

      const untypedTarget: JSONSchema = {
        properties: { x: { default: 1 } },
        required: ["x"],
      };
      const cases: [JSONSchema, JSONSchema][] = [
        [{ type: "object" }, defaulted("x")],
        [true, untypedTarget],
        [{ type: "unknown", required: ["title"] }, untypedTarget],
      ];
      for (const [source, target] of cases) {
        expect(validateSchemaValue(source, bytes, source)).toBeUndefined();
        expect(validateSchemaValue(target, bytes, target)).toBe(
          "missing required property x",
        );
        expect(() => assertSchemaSubset(source, target)).toThrow(
          /value\.x: newly required field is not a member of `FabricBytes`, which takes no default/,
        );
      }
    });

    it("does not throw for a link whose source requires a key no `FabricPrimitive` has", () => {
      const source: JSONSchema = {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      };
      const target: JSONSchema = {
        type: "object",
        properties: { title: { type: "string" }, x: { default: 1 } },
        required: ["title", "x"],
      };
      expect(validateSchemaValue(source, bytes, source)).toBe(
        "missing required property title",
      );
      expect(() => assertSchemaSubset(source, target)).not.toThrow();
    });

    it("throws for a field a `FabricHash` the source's `required` admits lacks, and not for one it has", () => {
      // `required: ["length"]` admits a `FabricBytes` and a `FabricHash`. Both
      // have `copyInto`, and only the `FabricBytes` has `slice`.

      const source: JSONSchema = { type: "object", required: ["length"] };
      expect(validateSchemaValue(source, hash, source)).toBeUndefined();

      const copyInto = defaulted("copyInto", ["length"]);
      expect(validateSchemaValue(copyInto, hash, copyInto)).toBeUndefined();
      expect(() => assertSchemaSubset(source, copyInto)).not.toThrow();

      const slice = defaulted("slice", ["length"]);
      expect(validateSchemaValue(slice, hash, slice)).toBe(
        "missing required property slice",
      );
      expect(() => assertSchemaSubset(source, slice)).toThrow(
        /value\.slice: newly required field is not a member of `FabricHash`/,
      );
    });

    it("throws for exactly the fields some value of the vocabulary fails the validator on, under an `object` source", () => {
      const verdicts: { name: string; accepted: boolean }[] = [];
      const disagreements: typeof verdicts = [];
      for (const name of fabricPrimitiveMemberNames()) {
        const target = defaulted(name);
        const accepted = FABRIC_PRIMITIVE_VALUES.every((value) =>
          validateSchemaValue(target, value, target) === undefined
        );
        let proved = true;
        try {
          assertSchemaSubset({ type: "object" }, target);
        } catch {
          proved = false;
        }
        verdicts.push({ name, accepted });
        if (proved !== accepted) disagreements.push({ name, accepted });
      }
      expect(disagreements).toEqual([]);
      expect(verdicts).toContainEqual({ name: "constructor", accepted: true });
      expect(verdicts).toContainEqual({ name: "length", accepted: false });
    });

    it("does not throw for a pattern update adding the field under an `object` argument slot", () => {
      // An update keeps the default. Setup validates the stored argument
      // against the candidate and refuses a `FabricPrimitive` lacking the
      // field (`packages/runner/test/pattern-update-argument-validation.test.ts`).

      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(
            { type: "object", properties: { stamp: { type: "object" } } },
            { type: "object" },
          ),
          pattern(
            { type: "object", properties: { stamp: defaulted("zone") } },
            { type: "object" },
          ),
        )
      ).not.toThrow();
    });
  });

  it("compares Fabric enum and const values canonically", () => {
    const first = new FabricBytes(new Uint8Array([1]));
    const second = new FabricBytes(new Uint8Array([2]));
    const common = new FabricBytes(new Uint8Array([3]));
    const argumentWith = (value: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: { value },
          required: ["value"],
        },
        oldPattern.resultSchema,
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentWith({ enum: [first, common] } as unknown as JSONSchema),
        argumentWith({ enum: [second, common] } as unknown as JSONSchema),
      )
    ).toThrow(/enum\/const/);

    const resultWith = (value: JSONSchema) =>
      pattern(
        oldPattern.argumentSchema,
        {
          type: "object",
          properties: { value },
          required: ["value"],
        },
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        resultWith({ const: first } as unknown as JSONSchema),
        resultWith({ const: second } as unknown as JSONSchema),
      )
    ).toThrow(/enum\/const/);
  });

  it("intersects sibling const and enum constraints", () => {
    const argumentPrevious = pattern(
      {
        type: "object",
        properties: { value: { const: 1 } },
      },
      oldPattern.resultSchema,
    );
    const argumentImpossible = pattern(
      {
        type: "object",
        properties: { value: { const: 1, enum: [2] } },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentPrevious,
        argumentImpossible,
      )
    ).toThrow(/argument\.value/);

    const resultPrevious = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { const: 1, enum: [2] } },
      },
    );
    const resultCandidate = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { const: 1 } },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultPrevious, resultCandidate)
    ).toThrow(/result\.value/);
  });

  it("checks semantic extensions and unsupported complex constraints", () => {
    const semanticChange = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number", readOnly: true },
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    const complexChange = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number", allOf: [{ minimum: 0 }] },
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, semanticChange)
    ).toThrow(/readOnly changed/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, complexChange)
    ).toThrow(
      /allOf changed in a way compatibility checking cannot prove safe/,
    );
  });

  it("checks referenced definitions inside unchanged complex constraints", () => {
    const withComplexRef = (
      valueType: "number" | "string",
      description: string,
    ) =>
      pattern(
        {
          type: "object",
          properties: {
            value: {
              allOf: [{ $ref: "#/$defs/Value" }],
            },
          },
          $defs: { Value: { type: valueType } },
          description,
        },
        oldPattern.resultSchema,
      );

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        withComplexRef("number", "previous"),
        withComplexRef("string", "candidate"),
      )
    ).toThrow(/argument\.value: allOf changed/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        withComplexRef("number", "previous"),
        withComplexRef("number", "candidate"),
      )
    ).not.toThrow();
  });

  it("does not interpret literal data named $ref as a schema reference", () => {
    const literalRef = { $ref: "#not-a-schema-reference" };
    const previous = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: "object",
            default: literalRef,
            enum: [literalRef],
          },
        },
      },
      oldPattern.resultSchema,
    );
    const candidate = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: "object",
            default: literalRef,
            enum: [literalRef],
          },
          added: { type: "string" },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
      .not.toThrow();
  });

  it("checks arrays and widened type arrays", () => {
    const previous = pattern(
      {
        type: "object",
        properties: { value: { type: "array", items: { type: "number" } } },
      },
      oldPattern.resultSchema,
    );
    const incompatible = pattern(
      {
        type: "object",
        properties: { value: { type: "array", items: { type: "string" } } },
      },
      oldPattern.resultSchema,
    );
    const widened = pattern(
      {
        type: "object",
        properties: {
          value: { type: ["array", "string"], items: { type: "number" } },
        },
      },
      oldPattern.resultSchema,
    );

    expect(() => assertPatternSchemasBackwardCompatible(previous, incompatible))
      .toThrow(/argument\.value\[\]/);
    expect(() => assertPatternSchemasBackwardCompatible(previous, widened))
      .not.toThrow();

    const tuple = (first: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: {
            value: {
              type: "array",
              prefixItems: [first],
              items: { type: "number" },
            },
          },
        },
        oldPattern.resultSchema,
      );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        tuple({ type: "string" }),
        tuple({ type: "number" }),
      )
    ).toThrow(/prefixItems changed/);
  });

  it("treats undefined as a supported schema type", () => {
    const argumentPrevious = pattern(
      {
        type: "object",
        properties: { value: { type: "undefined" } },
      },
      oldPattern.resultSchema,
    );
    const argumentWidened = pattern(
      {
        type: "object",
        properties: { value: { type: ["string", "undefined"] } },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentPrevious,
        argumentWidened,
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentWidened,
        argumentPrevious,
      )
    ).toThrow(/argument\.value/);

    const argumentAnyOf = pattern(
      {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "undefined" }, { type: "string" }],
          },
        },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(argumentPrevious, argumentAnyOf)
    ).not.toThrow();

    const argumentWidenedWithNumericConstraint = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: ["undefined", "number"],
            minimum: 0,
          },
        },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        argumentPrevious,
        argumentWidenedWithNumericConstraint,
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number" },
        { type: ["undefined", "number"], minimum: 0 },
      )
    ).toThrow();
    for (
      const target of [
        {
          type: ["undefined", "string"],
          pattern: "^ok$",
        },
        {
          type: ["undefined", "array"],
          items: { type: "string" },
          contains: { const: "ok" },
        },
        {
          type: ["undefined", "object"],
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
          propertyNames: { pattern: "^value$" },
        },
      ] satisfies JSONSchema[]
    ) {
      expect(() => assertSchemaSubset({ type: "undefined" }, target)).not
        .toThrow();
    }
    for (
      const target of [
        {
          type: ["undefined", "string"],
          contentEncoding: "base64",
        },
        {
          type: ["undefined", "string"],
          contentMediaType: "application/json",
        },
        {
          type: ["undefined", "string"],
          contentSchema: { type: "string" },
        },
      ] satisfies JSONSchema[]
    ) {
      expect(validateSchemaValue(target, undefined, target)).toMatch(
        /content validation is not supported/,
      );
      expect(() => assertSchemaSubset({ type: "undefined" }, target)).toThrow();
    }
    expect(() =>
      assertSchemaSubset(
        { type: "array", items: { type: "number" } },
        {
          type: ["undefined", "array"],
          items: { type: "string" },
        },
      )
    ).toThrow();
    expect(() =>
      assertSchemaSubset(
        {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        {
          type: ["undefined", "object"],
          properties: { value: { type: "number" } },
          required: ["value"],
          additionalProperties: false,
        },
      )
    ).toThrow();

    const requiredUndefinedDefault = pattern(
      {
        type: "object",
        properties: {
          value: { type: "undefined", default: undefined },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern({ type: "object", properties: {} }, oldPattern.resultSchema),
        requiredUndefinedDefault,
      )
    ).not.toThrow();

    const resultPrevious = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { type: ["string", "undefined"] } },
      },
    );
    const resultNarrowed = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { value: { type: "undefined" } },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultPrevious, resultNarrowed)
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultNarrowed, resultPrevious)
    ).toThrow(/result\.value/);

    const resultAnyOf = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          value: {
            anyOf: [{ type: "string" }, { type: "undefined" }],
          },
        },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(resultAnyOf, resultNarrowed)
    ).not.toThrow();
  });

  it("does not use field-evolution allowances as conjunct proofs", () => {
    const candidateProperty = {
      type: "undefined",
      default: undefined,
    } as const;
    const priorContracts: JSONSchema[] = [
      { type: "object", required: ["x"] },
      { type: "object", allOf: [{ required: ["x"] }] },
      {
        type: "object",
        oneOf: [{ required: ["x"] }, { required: ["other"] }],
      },
      {
        type: "object",
        if: { required: ["flag"] },
        then: { required: ["x"] },
      },
      {
        type: "object",
        dependentSchemas: { flag: { required: ["x"] } },
      },
      {
        $ref: "#/$defs/Contract",
        $defs: {
          Contract: { type: "object", allOf: [{ required: ["x"] }] },
        },
      },
    ];

    for (const previousArgument of priorContracts) {
      const candidateArgument = {
        ...(previousArgument as Exclude<JSONSchema, boolean>),
        properties: { x: candidateProperty },
        required: ["x"],
      } as JSONSchema;
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(previousArgument, oldPattern.resultSchema),
          pattern(candidateArgument, oldPattern.resultSchema),
        )
      ).toThrow(/argument/);
    }

    const previousAnyOf: JSONSchema = {
      type: "object",
      anyOf: [
        {
          properties: {
            kind: { const: "a" },
            x: {
              type: ["number", "undefined"],
              asCell: ["cell"],
              scope: "user",
            },
          },
          required: ["kind", "x"],
        },
        {
          properties: { kind: { const: "b" } },
          required: ["kind"],
        },
      ],
    };
    const incompatibleAnyOf: JSONSchema = {
      ...previousAnyOf,
      properties: {
        x: {
          ...candidateProperty,
          asCell: ["stream"],
          scope: "session",
        },
      },
      required: ["x"],
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(previousAnyOf, oldPattern.resultSchema),
        pattern(incompatibleAnyOf, oldPattern.resultSchema),
      )
    ).toThrow(/argument/);
  });

  it("preserves required result guarantees and allows new required results", () => {
    const optionalized = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: oldPattern.resultSchema &&
            typeof oldPattern.resultSchema === "object"
          ? oldPattern.resultSchema.properties
          : {},
      },
    );
    const newRequiredWithoutDefault = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { type: "number" },
          status: { type: "string" },
          summary: { type: "string" },
        },
        required: ["doubled", "summary"],
      },
    );
    const newRequiredWithDefault = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: {
          doubled: { type: "number" },
          status: { type: "string" },
          summary: { type: "string", default: "ready" },
        },
        required: ["doubled", "summary"],
      },
    );

    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, optionalized)
    ).toThrow(/result\.doubled: result field is no longer required/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        oldPattern,
        newRequiredWithoutDefault,
      )
    ).not.toThrow();
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, newRequiredWithDefault)
    ).not.toThrow();
  });

  it("checks every additionalProperties compatibility direction", () => {
    const schema = (additionalProperties: JSONSchema | undefined) => ({
      type: "object" as const,
      properties: { value: { type: "number" as const } },
      ...(additionalProperties === undefined ? {} : { additionalProperties }),
    });

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema(undefined), oldPattern.resultSchema),
        pattern(schema(false), oldPattern.resultSchema),
      )
    ).toThrow(/additional properties accepted previously/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
        pattern(schema(false), oldPattern.resultSchema),
      )
    ).toThrow(/additional properties accepted previously/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema(undefined), oldPattern.resultSchema),
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
      )
    ).toThrow(
      /argument\.\*: the candidate no longer accepts every previous type/,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
        pattern(schema({ type: "string" }), oldPattern.resultSchema),
      )
    ).toThrow(/argument\.\*/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        pattern(schema(false), oldPattern.resultSchema),
        pattern(schema({ type: "number" }), oldPattern.resultSchema),
      )
    ).not.toThrow();
  });

  it("checks new argument fields against prior additionalProperties", () => {
    const argumentSchema = (
      additionalProperties: JSONSchema,
      addedProperty?: JSONSchema,
    ): JSONSchema => ({
      type: "object",
      properties: {
        value: { type: "number" },
        ...(addedProperty === undefined ? {} : { label: addedProperty }),
      },
      additionalProperties,
    });
    const previousOpen = pattern(
      argumentSchema(true),
      oldPattern.resultSchema,
    );
    const candidateOpen = pattern(
      argumentSchema(true, { type: "string" }),
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousOpen, candidateOpen)
    ).not.toThrow();

    const previousTyped = pattern(
      argumentSchema({ type: "number" }),
      oldPattern.resultSchema,
    );
    const incompatibleTyped = pattern(
      argumentSchema({ type: "number" }, { type: "string" }),
      oldPattern.resultSchema,
    );
    const compatibleTyped = pattern(
      argumentSchema({ type: "number" }, { type: "number" }),
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, incompatibleTyped)
    ).toThrow(/argument\.label/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, compatibleTyped)
    ).not.toThrow();

    const previousClosed = pattern(
      argumentSchema(false),
      oldPattern.resultSchema,
    );
    const candidateClosed = pattern(
      argumentSchema(false, { type: "string" }),
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousClosed, candidateClosed)
    ).not.toThrow();
  });

  it("checks new result fields against prior additionalProperties", () => {
    const resultSchema = (
      additionalProperties: JSONSchema,
      addedProperty?: JSONSchema,
    ): JSONSchema => ({
      type: "object",
      properties: {
        value: { type: "number" },
        ...(addedProperty === undefined ? {} : { label: addedProperty }),
      },
      additionalProperties,
    });
    const previousClosed = pattern(
      oldPattern.argumentSchema,
      resultSchema(false),
    );
    const candidateClosed = pattern(
      oldPattern.argumentSchema,
      resultSchema(false, { type: "string" }),
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousClosed, candidateClosed)
    ).toThrow(/result\.label: new result field is rejected/);

    const previousTyped = pattern(
      oldPattern.argumentSchema,
      resultSchema({ type: "number" }),
    );
    const incompatibleTyped = pattern(
      oldPattern.argumentSchema,
      resultSchema({ type: "number" }, { type: "string" }),
    );
    const compatibleTyped = pattern(
      oldPattern.argumentSchema,
      resultSchema({ type: "number" }, { type: "number" }),
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, incompatibleTyped)
    ).toThrow(/result\.label/);
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousTyped, compatibleTyped)
    ).not.toThrow();
  });

  it("checks new named fields against prior patternProperties", () => {
    const previousArgument = pattern(
      {
        type: "object",
        patternProperties: { "^x": { type: "string" } },
      },
      oldPattern.resultSchema,
    );
    const candidateArgument = pattern(
      {
        type: "object",
        properties: { xMode: { type: "number" } },
        patternProperties: { "^x": { type: "string" } },
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        previousArgument,
        candidateArgument,
      )
    ).toThrow(/argument\.xMode/);

    const previousResult = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        patternProperties: { "^x": { type: "string" } },
      },
    );
    const candidateResult = pattern(
      oldPattern.argumentSchema,
      {
        type: "object",
        properties: { xMode: { type: "number" } },
        patternProperties: { "^x": { type: "string" } },
      },
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(previousResult, candidateResult)
    ).toThrow(/result\.xMode/);
  });

  it("checks scalar constraints that cannot be safely changed", () => {
    const previous = (value: JSONSchema) =>
      pattern(
        { type: "object", properties: { value } },
        oldPattern.resultSchema,
      );
    const expectRejected = (source: JSONSchema, target: JSONSchema) =>
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          previous(source),
          previous(target),
        )
      ).toThrow(/argument\.value/);

    expectRejected({ type: "array" }, { type: "array", uniqueItems: true });
    expectRejected({ type: "string" }, { type: "string", pattern: "^x" });
    expectRejected({ type: "string" }, { type: "string", format: "email" });
    expectRejected({ type: "number" }, { type: "number", multipleOf: 2 });

    for (
      const [source, target] of [
        [{ type: "string" }, { type: "string", minLength: 1 }],
        [{ type: "array" }, { type: "array", minItems: 1 }],
        [{ type: "object" }, { type: "object", minProperties: 1 }],
        [{ type: "string" }, { type: "string", maxLength: 1 }],
        [{ type: "array" }, { type: "array", maxItems: 1 }],
        [{ type: "object" }, { type: "object", maxProperties: 1 }],
      ] as const
    ) {
      expectRejected(source, target);
    }

    expect(() =>
      assertSchemaSubset(
        { type: "string", minLength: 2, maxLength: 4 },
        { type: "string", minLength: 1, maxLength: 5 },
      )
    ).not.toThrow();
  });

  it("compares effective inclusive and exclusive numeric bounds", () => {
    expect(() =>
      assertSchemaSubset(
        { type: "number", exclusiveMinimum: 0 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", exclusiveMaximum: 10 },
        { type: "number", maximum: 10 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: 0, exclusiveMinimum: -1 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", maximum: 10, exclusiveMaximum: 11 },
        { type: "number", maximum: 10 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: -1, exclusiveMinimum: 0 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", maximum: 11, exclusiveMaximum: 10 },
        { type: "number", maximum: 10 },
      )
    ).not.toThrow();
    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: 0, exclusiveMinimum: 0 },
        { type: "number", minimum: 0 },
      )
    ).not.toThrow();

    expect(() =>
      assertSchemaSubset(
        { type: "number", minimum: 0 },
        { type: "number", exclusiveMinimum: 0 },
      )
    ).toThrow(/more restrictive/);
    expect(() =>
      assertSchemaSubset(
        { type: "number", maximum: 10 },
        { type: "number", exclusiveMaximum: 10 },
      )
    ).toThrow(/more restrictive/);
  });

  it("rejects malformed required fields and unknown keyword changes", () => {
    const missingRequiredSchema = pattern(
      {
        type: "object",
        properties: {
          value: { type: "number" },
          format: { type: "string" },
        },
        required: ["value", "missing"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, missingRequiredSchema)
    ).toThrow(
      /argument\.missing: newly required argument field has no default/,
    );

    const unknownKeyword = pattern(
      {
        type: "object",
        properties: {
          value: {
            type: "number",
            customConstraint: true,
          } as JSONSchema,
          format: { type: "string" },
        },
        required: ["value"],
      },
      oldPattern.resultSchema,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(oldPattern, unknownKeyword)
    ).toThrow(/customConstraint changed/);
  });

  it("rejects malformed schemas before comparing variance", () => {
    const argumentWith = (value: JSONSchema) =>
      pattern(
        {
          type: "object",
          properties: { value, format: { type: "string" } },
          required: ["value"],
        },
        oldPattern.resultSchema,
      );
    const resultWith = (value: JSONSchema) =>
      pattern(
        oldPattern.argumentSchema,
        {
          type: "object",
          properties: { value },
          required: ["value"],
        },
      );

    const malformedCases: Array<[Pattern, Pattern]> = [
      [
        argumentWith({ type: [] } as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        resultWith({ type: ["number", "bogus"] } as JSONSchema),
        resultWith({ type: "number" }),
      ],
      [
        resultWith({ type: "number", minimum: 0 }),
        resultWith({ type: "number", minimum: Number.NaN }),
      ],
      [
        argumentWith({ type: "number" }),
        argumentWith({ type: "number", multipleOf: 0 }),
      ],
      [
        argumentWith({ type: "string" }),
        argumentWith({ $ref: "" } as JSONSchema),
      ],
      [
        argumentWith({ type: [, "number"] } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        argumentWith({
          type: "object",
          required: [, "value"],
        } as unknown as JSONSchema),
        argumentWith({ type: "object" }),
      ],
      [
        argumentWith({
          dependentRequired: { value: [, "other"] },
        } as unknown as JSONSchema),
        argumentWith({ type: "object" }),
      ],
      [
        argumentWith({ enum: [,] } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        argumentWith({
          type: "number",
          asCell: ["bogus"],
        } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        argumentWith({
          type: "number",
          asCell: [{ kind: "cell", scope: "bogus" }],
        } as unknown as JSONSchema),
        argumentWith({ type: "number" }),
      ],
      [
        resultWith(
          { type: "undefined", scope: "bogus" } as unknown as JSONSchema,
        ),
        resultWith({ type: "undefined" }),
      ],
    ];
    for (const [previous, candidate] of malformedCases) {
      expect(() => assertPatternSchemasBackwardCompatible(previous, candidate))
        .toThrow(/invalid schema/i);
    }
  });

  describe("`FabricPrimitive` schema vocabulary transitions", () => {
    // The schema generator used to describe a `FabricSpecialObject`
    // structurally: an object schema whose `required` carries the
    // `FabricSpecialObject` nominal brand key. It now emits the
    // `FabricPrimitive` type name instead. That transition is refused, for
    // pattern evolution too: the structural schema admits values by shape
    // (a plain record carrying the brand key as an own property, or a
    // primitive of another class whose members cover `required`), the
    // `FabricPrimitive`-typed schema matches by prototype, and a pattern
    // update rewrites stored data verbatim -- so any such value would
    // survive the update only to be rejected by every subsequent read.
    // See the note in `schemaSubsetIssue`.

    const brand = "@commonfabric/FabricSpecialObject";
    const oldBytes: JSONSchema = {
      type: "object",
      properties: { length: { type: "number" } },
      required: ["length", brand],
    };
    const newBytes: JSONSchema = { type: "FabricBytes" };
    const withField = (schema: JSONSchema): JSONSchema => ({
      type: "object",
      properties: { blob: schema },
      required: ["blob"],
    });

    it("refuses an argument field moving from the brand-marked structural emission to its `FabricPrimitive` type", () => {
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(withField(oldBytes), true),
          pattern(withField(newBytes), true),
        )
      ).toThrow(/type object is not accepted/);
    });

    it("accepts a result field moving from the brand-marked structural emission to its `FabricPrimitive` type", () => {
      // The result direction proves candidate-within-previous: the new
      // schema's population is prototype-matched primitives, and every one
      // satisfies the old structural contract (`FabricPrimitive` types are
      // subtypes of "object", members are present via `in`, and the brand
      // is exempt for instances). Nothing is stranded, so no allowance is
      // involved -- this holds through the ordinary subset machinery.

      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(true, withField(oldBytes)),
          pattern(true, withField(newBytes)),
        )
      ).not.toThrow();
    });

    it("refuses the epoch-shaped structural emission against either epoch class", () => {
      const oldEpoch: JSONSchema = {
        type: "object",
        properties: { value: { type: "integer" } },
        required: ["value", brand],
      };
      for (const epochType of ["FabricEpochNsec", "FabricEpochDay"]) {
        expect(() =>
          assertPatternSchemasBackwardCompatible(
            pattern(withField(oldEpoch), true),
            pattern(withField({ type: epochType } as JSONSchema), true),
          )
        ).toThrow(/type object is not accepted/);
      }
    });

    it("refuses a plain object schema without the brand against a `FabricPrimitive` type", () => {
      const plainObject: JSONSchema = {
        type: "object",
        properties: { length: { type: "number" } },
        required: ["length"],
      };
      expect(() =>
        assertPatternSchemasBackwardCompatible(
          pattern(withField(plainObject), true),
          pattern(withField(newBytes), true),
        )
      ).toThrow(/type object is not accepted/);
    });

    it("keeps durable-link subset proofs strict about the transition", () => {
      expect(() => assertSchemaSubset(oldBytes, newBytes))
        .toThrow(/type object is not accepted/);
    });
  });
});

describe("verb event closed-world transitions", () => {
  // A verb node is `{$ref → event, asCell: ["stream"]}` in recorded
  // contracts (or the event inline beside the marker). Below one, a boolean
  // additionalProperties is an enforcement dial, not a data contract: the
  // runtime schema-strips undeclared event fields before any handler runs,
  // so open→closed surfaces silent loss as rule 1's typed rejection
  // (accepted-and-STRIPPED was never contract, decided 2026-08-03), and
  // closed→open must stay free for `never`-derived closure cleanup.

  const verbPattern = (event: JSONSchema, viaRef = true): Pattern => {
    const argument: JSONSchema = viaRef
      ? {
        type: "object",
        properties: {
          addComment: { $ref: "#/$defs/Ev", asCell: ["stream"] },
        },
        $defs: { Ev: event },
      }
      : {
        type: "object",
        properties: {
          addComment: { ...(event as object), asCell: ["stream"] },
        },
      };
    return pattern(argument, { type: "object", properties: {} });
  };

  const openEvent: JSONSchema = {
    type: "object",
    properties: { body: { type: "string" } },
  };
  const closedEvent: JSONSchema = {
    ...openEvent,
    additionalProperties: false,
  };

  it("lets a verb event close (ref-marked stream)", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbPattern(openEvent),
        verbPattern(closedEvent),
      )
    ).not.toThrow();
  });

  it("lets a verb event close (inline-marked stream)", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbPattern(openEvent, false),
        verbPattern(closedEvent, false),
      )
    ).not.toThrow();
  });

  it("lets a verb event reopen (never-derived closure cleanup)", () => {
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbPattern(closedEvent),
        verbPattern(openEvent),
      )
    ).not.toThrow();
  });

  it("carries the exemption through the event's nested objects", () => {
    const nested = (extra: Record<string, unknown>): JSONSchema => ({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { note: { type: "string" } },
          ...extra,
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbPattern(nested({})),
        verbPattern(nested({ additionalProperties: false })),
      )
    ).not.toThrow();
  });

  it("still refuses closing a plain argument object", () => {
    const settings = (extra: Record<string, unknown>): Pattern =>
      pattern({
        type: "object",
        properties: {
          settings: {
            type: "object",
            properties: { theme: { type: "string" } },
            ...extra,
          },
        },
      }, { type: "object", properties: {} });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        settings({}),
        settings({ additionalProperties: false }),
      )
    ).toThrow(
      /additional properties accepted previously would now be rejected/,
    );
  });

  it("does not exempt a node only one contract marks as a stream", () => {
    const demoted = pattern({
      type: "object",
      properties: { addComment: { ...(closedEvent as object) } },
    }, { type: "object", properties: {} });
    expect(() =>
      assertPatternSchemasBackwardCompatible(verbPattern(openEvent), demoted)
    ).toThrow(/asCell changed/);
  });

  it("still compares schema-valued additionalProperties on a verb event", () => {
    const shaped: JSONSchema = {
      ...openEvent,
      additionalProperties: { type: "string" },
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbPattern(shaped),
        verbPattern(closedEvent),
      )
    ).toThrow(
      /additional properties accepted previously would now be rejected/,
    );
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbPattern(openEvent),
        verbPattern(shaped),
      )
    ).toThrow(
      /argument\.addComment\.\*: the candidate no longer accepts every previous type/,
    );
  });

  it("closed verb events still gain optional fields (evolution policy)", () => {
    const widened: JSONSchema = {
      type: "object",
      properties: { body: { type: "string" }, tag: { type: "string" } },
      additionalProperties: false,
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbPattern(closedEvent),
        verbPattern(widened),
      )
    ).not.toThrow();
  });
});

describe("verb event required-field transitions", () => {
  // A verb node sits in the RESULT, which the checker compares covariantly
  // because a pattern produces its result. The event below it inverts that:
  // the caller supplies the value, so requiring a field the previous event
  // did not is a demand on every call already written, each refused at
  // dispatch once the update lands. Distinct from the closed-world rule
  // above — that one is free in both directions, this one is not.

  const verbInResult = (event: JSONSchema): Pattern =>
    pattern({ type: "object", properties: {} }, {
      type: "object",
      properties: { setLabel: { $ref: "#/$defs/Ev", asCell: ["stream"] } },
      $defs: { Ev: event },
    });

  const oneRequired: JSONSchema = {
    type: "object",
    properties: { label: { type: "string" } },
    required: ["label"],
  };

  it("refuses an event field the candidate newly requires", () => {
    const twoRequired: JSONSchema = {
      type: "object",
      properties: { label: { type: "string" }, color: { type: "string" } },
      required: ["label", "color"],
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInResult(oneRequired),
        verbInResult(twoRequired),
      )
    ).toThrow(/newly required verb event field has no default/);
  });

  it("accepts an event field that becomes required while keeping its default", () => {
    const withDefault = (required: string[]): JSONSchema => ({
      type: "object",
      properties: {
        label: { type: "string" },
        color: { type: "string", default: "none" },
      },
      required,
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInResult(withDefault(["label"])),
        verbInResult(withDefault(["label", "color"])),
      )
    ).not.toThrow();
  });

  it("accepts an event field that becomes required with a newly added default", () => {
    // A stream marker permits default insertion. Dispatch fills a present
    // event object's missing fields from valid defaults, so a new requirement
    // with a default remains compatible with callers that omit the field.
    const before: JSONSchema = {
      type: "object",
      properties: { label: { type: "string" }, color: { type: "string" } },
      required: ["label"],
    };
    const after: JSONSchema = {
      type: "object",
      properties: {
        label: { type: "string" },
        color: { type: "string", default: "none" },
      },
      required: ["label", "color"],
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInResult(before),
        verbInResult(after),
      )
    ).not.toThrow();
  });

  it("accepts a changed default on an event field, as on an argument", () => {
    const withDefault = (color: string): JSONSchema => ({
      type: "object",
      properties: {
        label: { type: "string" },
        color: { type: "string", default: color },
      },
      required: ["label"],
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInResult(withDefault("none")),
        verbInResult(withDefault("blue")),
      )
    ).not.toThrow();
    // The same verb declared in the argument, where the event was already
    // compared in the argument's direction.
    const verbInArgument = (event: JSONSchema): Pattern =>
      pattern({
        type: "object",
        properties: { setLabel: { $ref: "#/$defs/Ev", asCell: ["stream"] } },
        $defs: { Ev: event },
      }, { type: "object", properties: {} });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInArgument(withDefault("none")),
        verbInArgument(withDefault("blue")),
      )
    ).not.toThrow();
  });

  it("accepts an event field added as optional", () => {
    const widened: JSONSchema = {
      type: "object",
      properties: { label: { type: "string" }, color: { type: "string" } },
      required: ["label"],
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInResult(oneRequired),
        verbInResult(widened),
      )
    ).not.toThrow();
  });

  it("reaches a required field nested inside the event", () => {
    const nested = (required: string[]): JSONSchema => ({
      type: "object",
      properties: {
        payload: {
          type: "object",
          properties: { note: { type: "string" }, kind: { type: "string" } },
          required,
        },
      },
    });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInResult(nested(["note"])),
        verbInResult(nested(["note", "kind"])),
      )
    ).toThrow(/newly required verb event field has no default/);
  });

  it("accepts an event field that stops being required", () => {
    const twoRequired: JSONSchema = {
      type: "object",
      properties: { label: { type: "string" }, color: { type: "string" } },
      required: ["label", "color"],
    };
    const oneOfTwo: JSONSchema = {
      type: "object",
      properties: { label: { type: "string" }, color: { type: "string" } },
      required: ["label"],
    };
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        verbInResult(twoRequired),
        verbInResult(oneOfTwo),
      )
    ).not.toThrow();
  });

  it("still refuses an ordinary result field that stops being required", () => {
    const result = (required: string[]): Pattern =>
      pattern({ type: "object", properties: {} }, {
        type: "object",
        properties: { total: { type: "number" }, label: { type: "string" } },
        required,
      });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        result(["total", "label"]),
        result(["total"]),
      )
    ).toThrow(/result field is no longer required/);
  });

  it("still lets an ordinary result field become newly required", () => {
    const result = (required: string[]): Pattern =>
      pattern({ type: "object", properties: {} }, {
        type: "object",
        properties: { total: { type: "number" }, label: { type: "string" } },
        required,
      });
    expect(() =>
      assertPatternSchemasBackwardCompatible(
        result(["total"]),
        result(["total", "label"]),
      )
    ).not.toThrow();
  });
});

describe("listing marks are annotation-class", () => {
  // `tier: "wrapper"` and standard `deprecated: true` shape only what
  // `cf piece verbs` shows by default (verb contract WS-F); neither
  // constrains a value, so both must ADD and REMOVE freely across pattern
  // updates. Classified before the generator emits them — the checker
  // equality-compares unknown keywords, so an unclassified mark would be
  // refused in both directions: the C3 append-only lesson.

  const verbArgument = (marks: Record<string, unknown>): Pattern =>
    pattern(
      {
        type: "object",
        properties: {
          submitTopic: {
            type: "object",
            properties: { body: { type: "string" } },
            asCell: ["stream"],
            ...marks,
          },
        },
      },
      { type: "object", properties: {} },
    );

  const unmarked = verbArgument({});
  const marked = verbArgument({ tier: "wrapper", deprecated: true });

  it("lets both marks arrive on a recorded verb", () => {
    expect(() => assertPatternSchemasBackwardCompatible(unmarked, marked)).not
      .toThrow();
  });

  it("lets both marks leave again", () => {
    expect(() => assertPatternSchemasBackwardCompatible(marked, unmarked)).not
      .toThrow();
  });

  it("still refuses a genuinely unknown keyword (control)", () => {
    // The pin proves classification, not a checker that stopped looking:
    // an unclassified key on the same node is refused exactly as before.

    expect(() =>
      assertPatternSchemasBackwardCompatible(
        unmarked,
        verbArgument({ mysteryDial: 7 }),
      )
    ).toThrow(/mysteryDial|unknown/i);
  });
});
