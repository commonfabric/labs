import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fabricAwareEqual } from "@commonfabric/data-model";
import { FabricEpochDay } from "@commonfabric/data-model/fabric-primitives";
import type { JSONSchema, JSONSchemaObj } from "../../src/builder/types.ts";
import { mergeCfcSchemaEnvelopes } from "../../src/cfc/schema-merge.ts";
import { droppedStoredClaim } from "../../src/cfc/claim-preservation.ts";
import { cfcSchemaEntries } from "../../src/cfc/schema-label-view.ts";
import { resolveCfcSchemaRefs } from "../../src/cfc/schema-refs.ts";

const writer = (moduleIdentity: string, binding = "admitPanel") => ({
  __ctWriterIdentityOf: {
    file: "/loom/admission.tsx",
    path: [binding],
    moduleIdentity,
  },
});

const panels = (
  moduleIdentity: string,
  kinds = ["url", "piece"],
  binding = "admitPanel",
  keyword: "anyOf" | "oneOf" = "anyOf",
): JSONSchema => ({
  type: "object",
  properties: {
    panels: {
      type: "array",
      items: {
        [keyword]: kinds.map((kind) => ({
          type: "object",
          properties: {
            kind: { type: "string", enum: [kind] },
            addedBy: { $ref: "#/$defs/Adder" },
          },
          required: ["kind"],
        })),
      },
    },
  },
  $defs: {
    Adder: {
      type: "string",
      ifc: { writeAuthorizedBy: writer(moduleIdentity, binding) },
    },
  },
});

const constrainedMember = (
  moduleIdentity: string,
  constraint: JSONSchema,
): JSONSchema => ({
  anyOf: [{
    type: "object",
    properties: { value: constraint, addedBy: { $ref: "#/$defs/Adder" } },
  }, { type: "undefined" }],
  $defs: {
    Adder: {
      type: "string",
      ifc: { writeAuthorizedBy: writer(moduleIdentity) },
    },
  },
});

const annotatedMember = (
  moduleIdentity: string,
  annotations: JSONSchemaObj,
): JSONSchema => ({
  anyOf: [{
    type: "object",
    ...annotations,
    properties: { addedBy: { $ref: "#/$defs/Adder" } },
  }, { type: "undefined" }],
  $defs: {
    Adder: {
      type: "string",
      ifc: { writeAuthorizedBy: writer(moduleIdentity) },
    },
  },
});

describe("schema-merge-unions", () => {
  const unorderedConstraints: [string, JSONSchema, JSONSchema][] = [
    ["required", { required: ["a", "b"] }, { required: ["b", "a"] }],
    ["type", { type: ["string", "number"] }, { type: ["number", "string"] }],
    ["enum", { enum: [[1, 2], [2, 1]] }, { enum: [[2, 1], [1, 2]] }],
    ["dependentRequired", { dependentRequired: { a: ["b", "c"] } }, {
      dependentRequired: { a: ["c", "b"] },
    }],
    ...(["allOf", "anyOf", "oneOf"] as const).map((
      keyword,
    ): [string, JSONSchema, JSONSchema] => [
      keyword,
      {
        [keyword]: [{ type: "number", minimum: 0 }, {
          type: "number",
          maximum: 10,
        }],
      },
      {
        [keyword]: [{ type: "number", maximum: 10 }, {
          type: "number",
          minimum: 0,
        }],
      },
    ]),
  ];
  for (const [keyword, before, after] of unorderedConstraints) {
    it(`pairs branches whose ${keyword} members are reordered`, () => {
      const stored = constrainedMember("stored", before);
      const candidate = constrainedMember("next", after);
      const merged = mergeCfcSchemaEnvelopes(stored, candidate);
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
      expect(
        cfcSchemaEntries(merged).map((entry) =>
          (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
        ),
      )
        .toEqual([writer("stored")]);
    });
  }

  for (
    const [keyword, before, after] of [
      ["default", { default: [1, 2] }, { default: [2, 1] }],
      ["enum literal", { enum: [[1, 2]] }, { enum: [[2, 1]] }],
      [
        "prefixItems",
        { prefixItems: [{ type: "string" }, { type: "number" }] },
        {
          prefixItems: [{ type: "number" }, { type: "string" }],
        },
      ],
      ["asCell", { asCell: ["cell", "stream"] }, {
        asCell: ["stream", "cell"],
      }],
    ] as const
  ) {
    it(`refuses reordered ${keyword} sequences`, () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(
          constrainedMember("stored", before),
          constrainedMember("next", after),
        )
      )
        .toThrow(/union branches/);
    });
  }

  it("refuses changing oneOf branch multiplicity", () => {
    const branch = { type: "string" } as const;
    expect(() =>
      mergeCfcSchemaEnvelopes(
        constrainedMember("stored", { oneOf: [branch] }),
        constrainedMember("next", { oneOf: [branch, branch] }),
      )
    ).toThrow(/union branches/);
  });

  describe("a branch only the candidate declares", () => {
    const grown = (
      moduleIdentity: string,
      added: readonly JSONSchema[],
      titleWriter = "title-v1",
    ): JSONSchema => ({
      type: "object",
      properties: {
        panel: {
          anyOf: [{
            type: "object",
            properties: { addedBy: { $ref: "#/$defs/Adder" } },
          }, ...added],
        },
        title: {
          type: "string",
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                file: "/loom/main.tsx",
                path: ["retitle"],
                moduleIdentity: titleWriter,
              },
            },
          },
        },
      },
      $defs: {
        Adder: {
          type: "string",
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        },
      },
    });

    it("is kept beside the stored branches when no stored branch admits its type", () => {
      // Only another position's writer is restamped, so the union's own
      // claims are unchanged.
      const stored = grown("stored", []);
      const candidate = grown("stored", [{ type: "null" }], "title-v2");
      const merged = mergeCfcSchemaEnvelopes(stored, candidate);
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
      expect(
        ((merged as JSONSchemaObj).properties!.panel as JSONSchemaObj).anyOf,
      ).toContainEqual({ type: "null" });
      expect(() => mergeCfcSchemaEnvelopes(merged, candidate)).not.toThrow();
    });

    it("is kept while the stored branch keeps its restamped writer", () => {
      const stored = grown("stored", []);
      const merged = mergeCfcSchemaEnvelopes(
        stored,
        grown("successor", [{ type: "null" }]),
      );
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
      expect(
        cfcSchemaEntries(merged).flatMap((entry) => {
          const claim = (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy;
          return claim === undefined ? [] : [claim];
        }),
      ).toContainEqual(writer("stored"));
    });

    it("is kept beside a stored branch that names its type through a reference", () => {
      const holder = (moduleIdentity: string, added: readonly JSONSchema[]) =>
        ({
          anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Profile" }, ...added],
          $defs: {
            Profile: {
              type: "object",
              properties: {
                avatar: {
                  type: "string",
                  ifc: { writeAuthorizedBy: writer(moduleIdentity) },
                },
              },
            },
          },
        }) as JSONSchema;
      const stored = holder("stored", []);
      const merged = mergeCfcSchemaEnvelopes(
        stored,
        holder("successor", [{ type: "null" }]),
      );
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
    });

    const held = (
      moduleIdentity: string,
      storedType: string,
      more: readonly JSONSchema[],
    ): JSONSchema => ({
      anyOf: [{ $ref: "#/$defs/Held" }, ...more],
      $defs: {
        Held: {
          type: storedType,
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        } as JSONSchemaObj,
      },
    });

    it("is kept when every type it declares is one no stored branch admits", () => {
      const stored = held("stored", "object", []);
      const merged = mergeCfcSchemaEnvelopes(
        stored,
        held("successor", "object", [{ type: ["null", "string"] }]),
      );
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
    });

    for (
      const [storedType, added] of [
        ["number", { type: "integer" }],
        ["integer", { type: "number" }],
        ["object", { type: "unknown" }],
        ["unknown", { type: "null" }],
        ["FabricEpochDay", { type: "object" }],
        ["object", { type: "FabricEpochDay" }],
        ["object", { type: ["null", "object"] }],
        ["string", { type: ["null", "unknown"] }],
        ["string", { enum: [null] }],
      ] as const
    ) {
      const declared = "type" in added ? JSON.stringify(added.type) : "no type";
      it(`is refused when it declares ${declared} beside a stored ${storedType} branch`, () => {
        expect(() =>
          mergeCfcSchemaEnvelopes(
            held("stored", storedType, []),
            held("successor", storedType, [added as JSONSchema]),
          )
        ).toThrow(/union branches/);
      });
    }

    it("is refused when it declares no type beside a stored union of no branches", () => {
      expect(() =>
        mergeCfcSchemaEnvelopes({ anyOf: [] }, {
          anyOf: [{
            enum: [null],
            ifc: { writeAuthorizedBy: writer("successor") },
          }],
        })
      ).toThrow(/union branches/);
    });

    it("is refused beside a stored branch that declares no type", () => {
      const untyped = (moduleIdentity: string, more: JSONSchema[]) =>
        ({
          anyOf: [{
            properties: { addedBy: { $ref: "#/$defs/Adder" } },
          }, ...more],
          $defs: {
            Adder: {
              type: "string",
              ifc: { writeAuthorizedBy: writer(moduleIdentity) },
            },
          },
        }) as JSONSchema;
      expect(() =>
        mergeCfcSchemaEnvelopes(
          untyped("stored", []),
          untyped("successor", [{ type: "null" }]),
        )
      ).toThrow(/union branches/);
    });
  });

  it("refuses an added policy-free branch that overlaps stored values", () => {
    const schema = (moduleIdentity: string) =>
      ({
        anyOf: [{
          type: "object",
          properties: { addedBy: { $ref: "#/$defs/Adder" } },
        }],
        $defs: {
          Adder: {
            type: "string",
            ifc: { writeAuthorizedBy: writer(moduleIdentity) },
          },
        },
      }) as const;
    const stored = schema("stored");
    const candidate = schema("next");
    const extra = { type: "object" } as const;
    // The stored-claim guard sees the preserved arm; it does not prove the
    // additional arm disjoint from values that arm already accepts.
    expect(
      droppedStoredClaim(stored, {
        ...stored,
        anyOf: [...stored.anyOf, extra],
      }),
    ).toBeUndefined();
    expect(() =>
      mergeCfcSchemaEnvelopes(stored, {
        ...candidate,
        anyOf: [...candidate.anyOf, extra],
      })
    )
      .toThrow(/union branches/);
  });

  for (const keyword of ["anyOf", "oneOf"] as const) {
    it(`retains the stored writer through a reordered ${keyword} and repeated setup`, () => {
      const stored = panels("stored", ["url", "piece"], "admitPanel", keyword);
      const candidate = panels(
        "successor",
        ["piece", "url"],
        "admitPanel",
        keyword,
      );
      const merged = mergeCfcSchemaEnvelopes(stored, candidate);
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
      expect(
        cfcSchemaEntries(merged).map((entry) =>
          (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
        ),
      ).toEqual([writer("stored"), writer("stored")]);
      const repeated = mergeCfcSchemaEnvelopes(merged, candidate);
      expect(droppedStoredClaim(stored, repeated)).toBeUndefined();
    });
  }

  it("keeps candidate policy references beneath stored links through repeated setup", () => {
    const stored = panels("stored");
    const candidate = panels("successor");
    const options = {
      beneathStoredLink: (path: readonly string[]) => path.length > 2,
    };
    const merged = mergeCfcSchemaEnvelopes(stored, candidate, options);
    expect(
      cfcSchemaEntries(merged).map((entry) =>
        (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
      ),
    ).toEqual([writer("successor"), writer("successor")]);
    expect(() => mergeCfcSchemaEnvelopes(merged, candidate, options)).not
      .toThrow();
  });

  it("refuses changing a referenced writer binding inside a union", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        panels("stored"),
        panels("next", undefined, "removePanel"),
      )
    )
      .toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("refuses unmatched policy-bearing branches", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        panels("stored"),
        panels("next", ["url", "document"]),
      )
    )
      .toThrow(/union branches/);
  });

  it("refuses ambiguous reference-only branch correspondence", () => {
    const schema = (moduleIdentity: string): JSONSchema => ({
      anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
      $defs: {
        A: {
          type: "string",
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        },
        B: {
          type: "number",
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        },
      },
    });
    expect(() => mergeCfcSchemaEnvelopes(schema("stored"), schema("next")))
      .toThrow(/union branches/);
  });

  it("keeps literal defaults in branch correspondence, including keys named ifc and $ref", () => {
    const schema = (moduleIdentity: string, literal: string): JSONSchema => ({
      anyOf: [{
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        default: { ifc: literal, $ref: literal },
      }, { type: "undefined" }],
      $defs: {
        Value: {
          type: "string",
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
        },
      },
    });
    expect(() =>
      mergeCfcSchemaEnvelopes(
        schema("stored", "before"),
        schema("next", "after"),
      )
    )
      .toThrow(/union branches/);
  });

  it("leaves unions without policy on the existing candidate-wins path", () => {
    const merged = mergeCfcSchemaEnvelopes(
      { anyOf: [{ type: "string" }, { type: "number" }] },
      { anyOf: [{ type: "boolean" }] },
    ) as JSONSchemaObj;
    expect(merged.anyOf).toEqual([{ type: "boolean" }]);
  });

  it("keeps the stored stamp and the candidate's constraint in a branch whose referenced definitions differ", () => {
    // The stored stamp and the candidate's `minLength` meet in a definition
    // the merge names for the pair, which neither side spells, so the branch
    // keeps its reference, pairs with a later writer's, and holds both.
    const candidate = panels("successor") as JSONSchemaObj;
    const strengthened = {
      ...candidate,
      $defs: {
        Adder: { ...candidate.$defs!.Adder as JSONSchemaObj, minLength: 1 },
      },
    };
    const stored = panels("stored");
    const merged = mergeCfcSchemaEnvelopes(stored, strengthened);
    expect(droppedStoredClaim(stored, merged)).toBeUndefined();
    const branch = (
      ((merged as JSONSchemaObj).properties!.panels as JSONSchemaObj)
        .items as JSONSchemaObj
    ).anyOf![0] as JSONSchemaObj;
    const addedBy = (branch.properties as Record<string, JSONSchemaObj>)
      .addedBy;
    expect(typeof addedBy.$ref).toBe("string");
    const resolved = resolveCfcSchemaRefs(addedBy, merged) as JSONSchemaObj;
    expect(resolved.minLength).toBe(1);
    expect(resolved.ifc?.writeAuthorizedBy).toEqual(writer("stored"));
    expect(mergeCfcSchemaEnvelopes(merged, strengthened)).toEqual(merged);
    expect(
      droppedStoredClaim(
        stored,
        mergeCfcSchemaEnvelopes(merged, panels("third")),
      ),
    )
      .toBeUndefined();
  });

  it("keeps a stored union pairable with a later writer, and its stamp, after a merge of referenced branches that differ", () => {
    // A branch merged from a stored claim and a candidate field equals
    // neither referenced body. It refers to the definition the merge names
    // for the two, so a later writer's `$ref` branch still pairs with it.
    const holder = (moduleIdentity: string, withBio: boolean): JSONSchema => ({
      type: "object",
      properties: {
        profile: {
          anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Profile" }],
        },
      },
      $defs: {
        Profile: {
          type: "object",
          properties: {
            avatar: {
              type: "string",
              ifc: { writeAuthorizedBy: writer(moduleIdentity, "setAvatar") },
            },
            ...(withBio && { bio: { type: "string" } }),
          },
        },
      },
    });
    const stored = holder("release-1", false);
    const merged = mergeCfcSchemaEnvelopes(stored, holder("release-2", true));
    expect(droppedStoredClaim(stored, merged)).toBeUndefined();
    const branch = (
      (merged as JSONSchemaObj).properties!.profile as JSONSchemaObj
    ).anyOf![1] as JSONSchemaObj;
    expect(typeof branch.$ref).toBe("string");
    const profile = resolveCfcSchemaRefs(branch, merged) as JSONSchemaObj;
    const fields = profile.properties as Record<string, JSONSchemaObj>;
    expect(fields.avatar.ifc?.writeAuthorizedBy).toEqual(
      writer("release-1", "setAvatar"),
    );
    expect(fields.bio).toEqual({ type: "string" });
    expect(mergeCfcSchemaEnvelopes(merged, holder("release-1", false)))
      .toEqual(merged);
    expect(mergeCfcSchemaEnvelopes(merged, holder("release-2", true)))
      .toEqual(merged);
  });

  for (
    const [keyword, before, after] of [
      ["title", "Before", "After"],
      ["description", "before", "after"],
      ["examples", [{ kind: "url" }], [{ kind: "piece" }]],
      ["deprecated", false, true],
      ["readOnly", false, true],
      ["writeOnly", false, true],
    ] as const
  ) {
    it(`pairs a branch whose ${keyword} annotation changes and keeps the stored writer`, () => {
      const stored = annotatedMember("stored", { [keyword]: before });
      const candidate = annotatedMember("next", { [keyword]: after });
      const merged = mergeCfcSchemaEnvelopes(stored, candidate);
      expect(droppedStoredClaim(stored, merged)).toBeUndefined();
      expect(
        cfcSchemaEntries(merged).map((entry) =>
          (entry.schema as JSONSchemaObj).ifc?.writeAuthorizedBy
        ),
      ).toEqual([writer("stored")]);
      expect(((merged as JSONSchemaObj).anyOf![0] as JSONSchemaObj)[keyword])
        .toEqual(after);
      expect(() => mergeCfcSchemaEnvelopes(merged, candidate)).not.toThrow();
    });
  }

  it("refuses a branch whose $comment changes", () => {
    // The runtime reads some `$comment` values as property markers, so a
    // comment is part of a branch's shape.
    expect(() =>
      mergeCfcSchemaEnvelopes(
        annotatedMember("stored", { $comment: "before" }),
        annotatedMember("next", { $comment: "after" }),
      )
    ).toThrow(/union branches/);
  });

  it("keeps a candidate's changed FabricPrimitive default in a referenced branch, and the stored stamp", () => {
    // Two distinct `FabricEpochDay` values have no enumerable state, so a
    // comparison blind to them would hand back the stored reference and its
    // stored default.
    const schema = (moduleIdentity: string, day: bigint): JSONSchema => ({
      anyOf: [{ type: "undefined" }, { $ref: "#/$defs/Value" }],
      $defs: {
        Value: {
          ifc: { writeAuthorizedBy: writer(moduleIdentity) },
          default: new FabricEpochDay(day) as never,
        },
      },
    });
    const stored = schema("stored", 1n);
    const merged = mergeCfcSchemaEnvelopes(stored, schema("next", 2n));
    const branch = (merged as JSONSchemaObj).anyOf![1] as JSONSchemaObj;
    const resolved = resolveCfcSchemaRefs(branch, merged) as JSONSchemaObj;
    expect(fabricAwareEqual(resolved.default, new FabricEpochDay(2n))).toBe(
      true,
    );
    expect(resolved.ifc?.writeAuthorizedBy).toEqual(writer("stored"));
    expect(droppedStoredClaim(stored, merged)).toBeUndefined();
  });

  it("keeps body claims when an IFC sibling overlays a reference", () => {
    const stored = {
      properties: {
        pin: { $ref: "#/$defs/Pin", ifc: { addIntegrity: ["copied"] } },
      },
      $defs: {
        Pin: { type: "string", ifc: { writeAuthorizedBy: writer("stored") } },
      },
    } as const;
    const merged = mergeCfcSchemaEnvelopes(stored, {
      properties: { pin: { type: "string" } },
    });
    expect(
      cfcSchemaEntries(merged).map((entry) =>
        (entry.schema as JSONSchemaObj).ifc
      ),
    )
      .toEqual([{
        addIntegrity: ["copied"],
        writeAuthorizedBy: writer("stored"),
      }]);
  });
});
