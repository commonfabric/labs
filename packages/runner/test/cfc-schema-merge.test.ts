import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { JSONSchemaObj } from "../src/builder/types.ts";
import {
  cfcSchemaMergeIssue,
  cfcSchemaPoliciesEqual,
  mergeCfcSchemaEnvelopes,
} from "../src/cfc/schema-merge.ts";
import {
  storedCfcEnvelopeMergeIssue,
  storedSchemaCoversCandidateEnvelope,
} from "../src/cfc/prepare.ts";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

describe("mergeCfcSchemaEnvelopes", () => {
  describe("observes through a merge", () => {
    // C5: `observes` is a scalar consumption class, not a set-like claim.
    // Agreement keeps the class through a merge; any disagreement (including
    // one covering side) merges to covering — the widest consumption, the
    // over-taint direction (fail-safe). Dropping it on every merge would
    // silently defeat the C5 narrowing on the common re-write path.

    it("keeps observes when both sides agree", () => {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          rows: {
            type: "string",
            ifc: { confidentiality: ["a"], observes: "value" },
          },
        },
      }, {
        type: "object",
        properties: {
          rows: {
            type: "string",
            ifc: { confidentiality: ["a"], observes: "value" },
          },
        },
      }) as JSONSchemaObj;
      const rows = (merged.properties as Record<string, JSONSchemaObj>).rows;
      expect((rows.ifc as { observes?: string }).observes).toBe("value");
    });

    it("merges disagreeing observes to covering", () => {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          rows: {
            type: "string",
            ifc: { confidentiality: ["a"], observes: "value" },
          },
        },
      }, {
        type: "object",
        properties: {
          rows: { type: "string", ifc: { confidentiality: ["a"] } },
        },
      }) as JSONSchemaObj;
      const rows = (merged.properties as Record<string, JSONSchemaObj>).rows;
      expect((rows.ifc as { observes?: string }).observes).toBeUndefined();
    });
  });

  describe("definitions through a merge", () => {
    // The merged envelope is one document: both sides' `$defs` land on its
    // root, and a name the two define differently is renamed apart on the
    // candidate's side so each side's refs keep naming their own definition.

    it("carries both sides' definitions onto the merged root", () => {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: { rows: { $ref: "#/$defs/Row" } },
        $defs: { Row: { type: "string" } },
      }, {
        type: "object",
        properties: { count: { $ref: "#/$defs/Count" } },
        $defs: { Count: { type: "number" } },
      }) as JSONSchemaObj;
      expect(merged.$defs).toEqual({
        Row: { type: "string" },
        Count: { type: "number" },
      });
      expect(merged.properties).toEqual({
        rows: { $ref: "#/$defs/Row" },
        count: { $ref: "#/$defs/Count" },
      });
    });

    it("renames a name the two sides define differently", () => {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: { rows: { $ref: "#/$defs/Entry" } },
        $defs: { Entry: { type: "string" } },
      }, {
        type: "object",
        properties: { count: { $ref: "#/$defs/Entry" } },
        $defs: { Entry: { type: "number" } },
      }) as JSONSchemaObj;
      expect(merged.$defs).toEqual({
        Entry: { type: "string" },
        __cfc_hoisted_0_Entry: { type: "number" },
      });
      expect(merged.properties).toEqual({
        rows: { $ref: "#/$defs/Entry" },
        count: { $ref: "#/$defs/__cfc_hoisted_0_Entry" },
      });
    });
  });

  it("allows additive required fields when a default preserves old documents", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
      },
      required: ["secret"],
    }, {
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
        title: {
          type: "string",
          default: "",
        },
      },
      required: ["secret", "title"],
    });

    const mergedObject = merged as JSONSchemaObj;
    expect(mergedObject.properties?.title).toMatchObject({
      type: "string",
      default: "",
    });
    expect(mergedObject.required).toEqual(["secret", "title"]);
  });

  it("rejects additive required fields without a default", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
        required: ["secret"],
      }, {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
          title: {
            type: "string",
          },
        },
        required: ["secret", "title"],
      })
    ).toThrow(/required field.*default/i);
  });

  it("allows additive required fields anywhere in a generated result document", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        secret: { type: "string" },
        meta: {
          type: "object",
          properties: { existing: { type: "string" } },
          required: ["existing"],
        },
      },
      required: ["secret"],
    }, {
      type: "object",
      properties: {
        secret: { type: "string" },
        meta: {
          type: "object",
          properties: {
            existing: { type: "string" },
            generated: { type: "string" },
          },
          required: ["existing", "generated"],
        },
      },
      required: ["secret", "meta"],
    }, { generatedOutputPaths: [[]] }) as JSONSchemaObj;
    expect(merged.required).toEqual(["secret", "meta"]);
    expect((merged.properties?.meta as JSONSchemaObj).required).toEqual([
      "existing",
      "generated",
    ]);
  });

  it("does not infer output role from the value's stream capability", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: { secret: { type: "string" } },
        required: ["secret"],
      }, {
        type: "object",
        properties: {
          secret: { type: "string" },
          evt: {
            type: "object",
            asCell: [{ kind: "stream", scope: "user" }],
          },
        },
        required: ["secret", "evt"],
      })
    ).toThrow(/required field.*default/i);
  });

  it("scopes the generated-output exemption to the declared path", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          generated: { type: "object", properties: {} },
          retained: { type: "object", properties: {} },
        },
      }, {
        type: "object",
        properties: {
          generated: {
            type: "object",
            properties: { output: { type: "string" } },
            required: ["output"],
          },
          retained: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
        },
      }, { generatedOutputPaths: [["generated"]] })
    ).toThrow(/required field input needs a default/i);

    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        generated: { type: "object", properties: {} },
      },
    }, {
      type: "object",
      properties: {
        generated: {
          type: "object",
          properties: { output: { type: "string" } },
          required: ["output"],
        },
      },
    }, { generatedOutputPaths: [["generated"]] }) as JSONSchemaObj;
    expect(
      (merged.properties?.generated as JSONSchemaObj).required,
    ).toEqual(["output"]);
  });

  it("rejects weakened ifc constraints", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { maxConfidentiality: ["secret"] },
          },
        },
      }, {
        type: "object",
        properties: {
          secret: {
            type: "string",
            ifc: { maxConfidentiality: ["secret", "internal"] },
          },
        },
      })
    ).toThrow(/maxConfidentiality/i);
  });

  it("merges compatible set-like ifc labels", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: {
            confidentiality: ["secret"],
            addIntegrity: ["reviewed"],
            requiredIntegrity: ["trusted"],
            integrity: ["trusted", "narrow"],
            maxConfidentiality: ["internal", "public"],
          },
        },
      },
    }, {
      type: "object",
      properties: {
        secret: {
          type: "string",
          ifc: {
            confidentiality: ["secret", "internal"],
            addIntegrity: ["reviewed", "audited"],
            requiredIntegrity: ["trusted", "operator"],
            integrity: ["trusted"],
            maxConfidentiality: ["internal"],
          },
        },
      },
    });

    const ifc = (
      (merged as JSONSchemaObj).properties?.secret as JSONSchemaObj
    ).ifc;
    expect(ifc?.confidentiality).toEqual(["secret", "internal"]);
    expect(ifc?.addIntegrity).toEqual(["reviewed", "audited"]);
    expect(ifc?.requiredIntegrity).toEqual(["trusted", "operator"]);
    expect(ifc?.integrity).toEqual(["trusted"]);
    expect(ifc?.maxConfidentiality).toEqual(["internal"]);
  });

  it("rejects unstable scalar ifc labels", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: { ownerPrincipal: "did:key:one" },
      }, {
        ifc: { ownerPrincipal: "did:key:two" },
      })
    ).toThrow(/ownerPrincipal must remain stable/);

    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: { confidentiality: "secret" } as any,
      }, {
        ifc: { confidentiality: "internal" } as any,
      })
    ).toThrow(/confidentiality must remain stable/);

    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: { writeAuthorizedBy: { notAClaim: true } } as any,
      }, {
        ifc: { writeAuthorizedBy: { notAClaim: false } } as any,
      })
    ).toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("preserves stable copy and projection ifc metadata", () => {
    const stableIfc = {
      exactCopyOf: { source: "of:source" },
      projection: { path: ["value"] },
      collection: { id: "collection" },
      ownerPrincipal: "did:key:owner",
      flowPrecisionClaim: { path: ["legacy"] },
    };

    const merged = mergeCfcSchemaEnvelopes({
      ifc: stableIfc as any,
    }, {
      ifc: stableIfc as any,
    });

    expect((merged as JSONSchemaObj).ifc).toMatchObject(stableIfc);
  });

  it("preserves equal scalar ifc labels", () => {
    const claim = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["save"],
      },
    };

    const merged = mergeCfcSchemaEnvelopes({
      ifc: {
        confidentiality: "secret",
        writeAuthorizedBy: claim,
      } as any,
    }, {
      ifc: {
        confidentiality: "secret",
        writeAuthorizedBy: claim,
      } as any,
    });

    expect((merged as JSONSchemaObj).ifc?.confidentiality).toBe("secret");
    expect((merged as JSONSchemaObj).ifc?.writeAuthorizedBy).toEqual(claim);
  });

  it("preserves existing ifc when the candidate has none", () => {
    const merged = mergeCfcSchemaEnvelopes({
      ifc: { confidentiality: ["secret"] },
    }, {
      type: "object",
    });

    expect((merged as JSONSchemaObj).ifc?.confidentiality).toEqual(["secret"]);
  });

  it("rejects incompatible schema forms and types", () => {
    expect(() => mergeCfcSchemaEnvelopes(false, {})).toThrow(
      /unsupported schema form/,
    );

    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "string",
      }, {
        type: "number",
      })
    ).toThrow(/type changed incompatibly/);

    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: ["string", "number"],
      }, {
        type: ["string", "boolean"],
      })
    ).toThrow(/type changed incompatibly/);
  });

  it("merges item schemas and object defaults", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        default: { title: "Untitled" },
      },
    }, {
      type: "array",
      items: {
        type: "object",
        properties: {
          done: { type: "boolean" },
        },
        default: { done: false },
      },
    });

    const items = (merged as JSONSchemaObj).items as JSONSchemaObj;
    expect(items.properties).toMatchObject({
      title: { type: "string" },
      done: { type: "boolean" },
    });
    expect(items.default).toEqual({
      title: "Untitled",
      done: false,
    });
  });

  it("keeps an array default an array", () => {
    // Spreading two arrays into an object turns `[]` into `{}`, and
    // `["a"]` into `{ 0: "a" }`: a default the value's own type refuses.
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      items: { type: "string" },
      default: ["kept"],
    }, {
      type: "array",
      items: { type: "string" },
      default: [],
    }) as JSONSchemaObj;
    expect(merged.default).toEqual([]);
  });

  it("merges tuple (prefixItems) slots slot-wise", () => {
    // A `{...left, ...right}` spread would let one side's prefixItems win
    // wholesale, dropping the other side's slot ifc/defaults.
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      prefixItems: [
        {
          type: "string",
          ifc: { confidentiality: ["secret"] },
        },
        { type: "number" },
      ],
    }, {
      type: "array",
      prefixItems: [
        { type: "string", default: "cmd" },
        { type: "number" },
      ],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    // Slot 0 carries BOTH sides' contributions: the existing ifc and the
    // candidate default.
    expect((slots[0].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["secret"]);
    expect(slots[0].default).toBe("cmd");
  });

  it("keeps slots only one side declares", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      prefixItems: [{ type: "string", ifc: { confidentiality: ["secret"] } }],
    }, {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number", default: 3 }],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    expect(slots.length).toBe(2);
    expect((slots[0].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["secret"]);
    expect(slots[1]).toEqual({ type: "number", default: 3 });
  });

  it("merges a rest items claim into the other side's extra tuple slots", () => {
    // 2020-12: a side's `items` speaks for every index past its slots — so
    // its claim about index 1 must land in the longer side's slot 1, not be
    // silently reinterpreted as "indices >= 2" by the merged arity.
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number", ifc: { confidentiality: ["x"] } },
    }, {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number", default: 3 }],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    expect((slots[1].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(slots[1].default).toBe(3);
    // The rest claim itself survives for indices past all slots.
    const items = (merged as JSONSchemaObj).items as JSONSchemaObj;
    expect((items.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
  });

  it("merges an items-only side into a side introducing prefixItems", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
      items: { type: "number", ifc: { confidentiality: ["x"] } },
    }, {
      type: "array",
      prefixItems: [{ type: "number", default: 1 }],
    });

    const slots = (merged as JSONSchemaObj).prefixItems as JSONSchemaObj[];
    expect((slots[0].ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(slots[0].default).toBe(1);
  });

  it("merges a rest additionalProperties claim into the other side's named keys", () => {
    // The record twin of the items/prefixItems rule: an object-valued
    // additionalProperties speaks for every undeclared key, so its claim
    // merges into keys only the other side names.
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    }, {
      type: "object",
      properties: { name: { type: "string", default: "d" } },
    });

    const props = (merged as JSONSchemaObj).properties as Record<
      string,
      JSONSchemaObj
    >;
    expect((props.name.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(props.name.default).toBe("d");
    // The rest claim itself survives for undeclared keys.
    const additional = (merged as JSONSchemaObj)
      .additionalProperties as JSONSchemaObj;
    expect((additional.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
  });

  it('keeps a property legitimately named "__proto__" through the merge', () => {
    // In V8/Deno a computed store with a "__proto__" key creates an own data
    // property, so the merge preserves this valid JSON key end-to-end. Pinned
    // so an engine or refactor change that breaks the assumption is caught.
    const left = {
      type: "object",
      properties: JSON.parse(
        '{"__proto__": {"type": "string", "ifc": {"confidentiality": ["x"]}}}',
      ),
    } as JSONSchemaObj;
    const right = {
      type: "object",
      properties: JSON.parse(
        '{"__proto__": {"type": "string", "default": "d"}}',
      ),
    } as JSONSchemaObj;

    const merged = mergeCfcSchemaEnvelopes(left, right) as JSONSchemaObj;
    const props = merged.properties as Record<string, JSONSchemaObj>;
    expect(Object.hasOwn(props, "__proto__")).toBe(true);
    const proto = Object.getOwnPropertyDescriptor(props, "__proto__")!
      .value as JSONSchemaObj;
    expect((proto.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(proto.default).toBe("d");
  });

  it("keeps the candidate's boolean additionalProperties via the spread", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    });
    expect((merged as JSONSchemaObj).additionalProperties).toBe(true);
  });

  it("merges object-valued additionalProperties from both sides", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    }, {
      type: "object",
      additionalProperties: { type: "string", default: "d" },
    });

    const additional = (merged as JSONSchemaObj)
      .additionalProperties as JSONSchemaObj;
    expect((additional.ifc as { confidentiality?: string[] }).confidentiality)
      .toEqual(["x"]);
    expect(additional.default).toBe("d");
  });

  it("keeps candidate items when only the candidate declares them", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "array",
    }, {
      type: "array",
      items: { type: "string" },
    });

    expect((merged as JSONSchemaObj).items).toEqual({ type: "string" });
  });

  it("preserves uiContract metadata when merging schema envelopes", () => {
    const uiContract = {
      helper: "UiAction",
      action: "SubmitDirectCommand",
      trustedPattern: "TrustedDirectCommandSurface",
      requiredEventIntegrity: ["TrustedDirectCommandSurface"],
    } as const;

    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        savedTitle: {
          type: "string",
          ifc: { uiContract },
        },
      },
    }, {
      type: "object",
      properties: {
        savedTitle: {
          type: "string",
          ifc: { uiContract },
        },
      },
    });

    const mergedObject = merged as JSONSchemaObj;
    expect(
      (mergedObject.properties?.savedTitle as JSONSchemaObj).ifc?.uiContract,
    ).toEqual(uiContract);
  });

  it("rejects branch-local ifc labels in divergent schemas", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          secret: {
            type: "string",
          },
        },
      }, {
        anyOf: [
          {
            type: "object",
            properties: {
              secret: {
                type: "string",
                ifc: { confidentiality: ["secret"] },
              },
            },
          },
          {
            type: "object",
            properties: {
              secret: {
                type: "string",
              },
            },
          },
        ],
      })
    ).toThrow(/divergent.*ifc|ifc.*divergent/i);
  });

  it("allows branch-external ifc labels beside divergent schemas", () => {
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
      ifc: { confidentiality: ["secret"] },
    }, {
      anyOf: [
        { type: "string" },
        { type: "number" },
      ],
      ifc: { confidentiality: ["secret"] },
    });

    expect((merged as JSONSchemaObj).ifc?.confidentiality).toEqual(["secret"]);
  });

  it("rejects nested divergent branches with local ifc labels (two carriers)", () => {
    // RULING 5 (2026-08-21) narrowed the guard, so genuine ambiguity — MORE
    // than one ifc-carrying branch — is what this pin holds refused now.
    const twoCarriers = {
      type: "array",
      items: {
        oneOf: [
          { type: "string", ifc: { confidentiality: ["secret"] } },
          { type: "number", ifc: { confidentiality: ["other"] } },
        ],
      },
    } as const;
    expect(() => mergeCfcSchemaEnvelopes(twoCarriers, twoCarriers))
      .toThrow(/divergent oneOf branches/);
  });

  describe("RULING 5: a single ifc-carrying branch with type-disjoint siblings", () => {
    // RULING 5 (CFC owner, 2026-08-21; verification-coverage.md OW49): a SINGLE
    // ifc-carrying branch whose every sibling is syntactically type-disjoint is
    // the union's policy carrier and MERGES — the wish builtin's
    // optional-result shape. Everything the ruling's constraints name stays
    // refused, pinned one by one below.

    it("admits a single ifc-carrying branch with type-disjoint siblings (RULING 5)", () => {
      const optionalIfcView = {
        type: "object",
        properties: {
          result: {
            anyOf: [
              { type: "undefined" },
              {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    ifc: { confidentiality: ["secret"] },
                  },
                },
              },
            ],
          },
        },
      } as const;
      const merged = mergeCfcSchemaEnvelopes(
        optionalIfcView,
        optionalIfcView,
      ) as JSONSchemaObj;
      const result = (merged.properties?.result ?? {}) as JSONSchemaObj;
      expect(Array.isArray(result.anyOf)).toBe(true);
      const carrier = (result.anyOf?.[1] ?? {}) as JSONSchemaObj;
      expect(
        ((carrier.properties?.name ?? {}) as JSONSchemaObj).ifc
          ?.confidentiality,
      ).toEqual(["secret"]);
    });

    it("admits the single carrier under oneOf and nested positions too (RULING 5)", () => {
      const nested = {
        type: "array",
        items: {
          oneOf: [
            { type: "string", ifc: { confidentiality: ["secret"] } },
            { type: "number" },
          ],
        },
      } as const;
      const merged = mergeCfcSchemaEnvelopes(nested, nested) as JSONSchemaObj;
      const items = (merged.items ?? {}) as JSONSchemaObj;
      expect(Array.isArray(items.oneOf)).toBe(true);
    });

    it("still rejects a single carrier whose sibling is NOT syntactically disjoint (RULING 5 constraints)", () => {
      const carrier = {
        type: "object",
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      } as const;
      // Same-type sibling: a labeled value could also match it (the dodge).
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [carrier, { type: "object" }] },
          { anyOf: [carrier, { type: "object" }] },
        )
      ).toThrow(/divergent anyOf branches/);
      // No `type` on the sibling: overlap unprovable.
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [carrier, { properties: {} }] },
          { anyOf: [carrier, { properties: {} }] },
        )
      ).toThrow(/divergent anyOf branches/);
      // Type ARRAY on the sibling: not scalar, unprovable.
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [carrier, { type: ["string", "number"] } as never] },
          { anyOf: [carrier, { type: ["string", "number"] } as never] },
        )
      ).toThrow(/divergent anyOf branches/);
      // Combinator sibling: unprovable.
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [carrier, { anyOf: [{ type: "string" }] }] },
          { anyOf: [carrier, { anyOf: [{ type: "string" }] }] },
        )
      ).toThrow(/divergent anyOf branches/);
      // Boolean sibling (`true` matches anything): unprovable.
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [carrier, true] },
          { anyOf: [carrier, true] },
        )
      ).toThrow(/divergent anyOf branches/);
    });

    it("still rejects an integer/number carrier-sibling pair — value-set overlap, not string equality (RULING 5 constraints; review F1)", () => {
      // Every JSON-Schema integer IS a number, so a concrete value (e.g. `5`)
      // matches BOTH branches — the ONE scalar pair whose value-sets overlap
      // while the type STRINGS differ. Disjointness is decided over value-sets,
      // so this pair is NOT disjoint and the union must refuse, both branch
      // orders and either carrier position.
      const integerCarrier = {
        type: "integer",
        ifc: { confidentiality: ["secret"] },
      } as const;
      const numberCarrier = {
        type: "number",
        ifc: { confidentiality: ["secret"] },
      } as const;
      // ifc on the `integer` branch, `number` sibling — both orders.
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [integerCarrier, { type: "number" }] },
          { anyOf: [integerCarrier, { type: "number" }] },
        )
      ).toThrow(/divergent anyOf branches/);
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [{ type: "number" }, integerCarrier] },
          { anyOf: [{ type: "number" }, integerCarrier] },
        )
      ).toThrow(/divergent anyOf branches/);
      // ifc on the `number` branch, `integer` sibling — both orders.
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [numberCarrier, { type: "integer" }] },
          { anyOf: [numberCarrier, { type: "integer" }] },
        )
      ).toThrow(/divergent anyOf branches/);
      expect(() =>
        mergeCfcSchemaEnvelopes(
          { anyOf: [{ type: "integer" }, numberCarrier] },
          { anyOf: [{ type: "integer" }, numberCarrier] },
        )
      ).toThrow(/divergent anyOf branches/);
    });

    it("still admits a genuinely value-disjoint scalar pair beside the numeric fix (RULING 5)", () => {
      // Only the integer/number pair is excluded; every other cross-type
      // pair stays genuinely disjoint and admits. `string` vs `number` is such
      // a pair (a value is never both), so a single `number` carrier with a
      // `string` sibling still MERGES.
      const merged = mergeCfcSchemaEnvelopes(
        {
          anyOf: [
            { type: "number", ifc: { confidentiality: ["secret"] } },
            { type: "string" },
          ],
        },
        {
          anyOf: [
            { type: "number", ifc: { confidentiality: ["secret"] } },
            { type: "string" },
          ],
        },
      ) as JSONSchemaObj;
      expect(Array.isArray(merged.anyOf)).toBe(true);
      const carrier = (merged.anyOf?.[0] ?? {}) as JSONSchemaObj;
      expect(carrier.ifc?.confidentiality).toEqual(["secret"]);
    });

    it("still rejects allOf with an ifc-carrying branch (RULING 5 scope)", () => {
      // allOf is conjunctive: type-disjoint siblings are unsatisfiable by
      // construction, so no carrier reading exists there.
      const conjunctive = {
        allOf: [
          { type: "object", ifc: { confidentiality: ["secret"] } },
          { type: "undefined" },
        ],
      } as const;
      expect(() => mergeCfcSchemaEnvelopes(conjunctive, conjunctive))
        .toThrow(/divergent allOf branches/);
    });

    it("still recurses INTO the admitted carrier (nested divergence refuses)", () => {
      const carrierWithNestedDivergence = {
        anyOf: [
          { type: "undefined" },
          {
            type: "object",
            properties: {
              inner: {
                anyOf: [
                  { type: "string", ifc: { confidentiality: ["a"] } },
                  { type: "number", ifc: { confidentiality: ["b"] } },
                ],
              },
            },
          },
        ],
      } as const;
      expect(() =>
        mergeCfcSchemaEnvelopes(
          carrierWithNestedDivergence,
          carrierWithNestedDivergence,
        )
      ).toThrow(/divergent anyOf branches/);
    });
  });

  it("rejects divergent ifc branches nested under a tuple slot", () => {
    // The guard's recursion visits prefixItems slots as well as properties
    // and items, so a divergent-ifc shape under a slot cannot escape it.
    const withTupleBranches = {
      type: "array",
      prefixItems: [{
        oneOf: [
          { type: "string", ifc: { confidentiality: ["secret"] } },
          { type: "number", ifc: { confidentiality: ["other"] } },
        ],
      }],
    } as const;
    expect(() => mergeCfcSchemaEnvelopes(withTupleBranches, withTupleBranches))
      .toThrow(/divergent oneOf branches/);
  });

  it("rejects divergent ifc branches nested under additionalProperties", () => {
    const withMapBranches = {
      type: "object",
      additionalProperties: {
        anyOf: [
          { type: "string", ifc: { confidentiality: ["secret"] } },
          { type: "number", ifc: { confidentiality: ["other"] } },
        ],
      },
    } as const;
    expect(() => mergeCfcSchemaEnvelopes(withMapBranches, withMapBranches))
      .toThrow(/divergent anyOf branches/);
  });

  it("allows non-object divergent branches without ifc labels", () => {
    const merged = mergeCfcSchemaEnvelopes({
      anyOf: [true, { type: "string" }],
    }, {
      anyOf: [true, { type: "string" }],
    });

    expect((merged as JSONSchemaObj).anyOf).toEqual([
      true,
      { type: "string" },
    ]);
  });

  it("merges writeAuthorizedBy claims that differ only by the identity stamp", () => {
    // Within one transaction the same protected field can be written through
    // two schema inputs: one recorded under a verified identity (its claim is
    // rebound with the identity's `moduleIdentity`) and one under no identity
    // (claim stays unstamped). The binding (file + path) is identical; only the
    // provenance stamp differs. The merge must keep the stamped claim rather
    // than reject the commit — the same tolerance prepare's
    // schemasEqualIgnoringWriterStamp applies elsewhere; without it every
    // profile element write fails with "writeAuthorizedBy must remain stable
    // at /elements".
    const unstamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
      },
    };
    const stamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
        moduleIdentity: "module-identity-hash",
      },
    };

    for (
      const [left, right] of [[stamped, unstamped], [unstamped, stamped]]
    ) {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: left },
          },
        },
      }, {
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: right },
          },
        },
      });

      expect(
        (
          (merged as JSONSchemaObj).properties?.elements as JSONSchemaObj
        ).ifc?.writeAuthorizedBy,
      ).toEqual(stamped);
    }
  });

  it("strips a legacy bundleId stamp from pre-migration claims", () => {
    // Backward compat: a pre-migration claim may carry a legacy `bundleId`
    // (alongside, or instead of, `moduleIdentity`). `bundleId` is inert under
    // verification (which reads `moduleIdentity`), but reconciliation must
    // still strip it before comparing — otherwise a surviving `bundleId` on
    // one side manufactures a false conflict and rejects an otherwise-matching
    // protected write with "writeAuthorizedBy must remain stable".
    const unstamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
      },
    };
    const legacyStamped = {
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
        bundleId: "fid1:bundle",
        moduleIdentity: "module-identity-hash",
      },
    };

    for (
      const [left, right] of [
        [legacyStamped, unstamped],
        [unstamped, legacyStamped],
      ]
    ) {
      const merged = mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: left },
          },
        },
      }, {
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: { writeAuthorizedBy: right },
          },
        },
      });

      expect(
        (
          (merged as JSONSchemaObj).properties?.elements as JSONSchemaObj
        ).ifc?.writeAuthorizedBy,
      ).toEqual(legacyStamped);
    }
  });

  it("keeps the stored stamp when identity stamps conflict (version boundary, no rotation)", () => {
    // Same binding, two different stamps: a version boundary, not a merge
    // conflict. Claims are minted born stamped, so a republished module
    // re-presents this binding under its new moduleIdentity on every
    // envelope write — the stored stamp wins (never rotated; the new
    // version's field writes stay fail-closed at verification pending
    // setsrc-history delegation) and the envelope's sibling writes keep
    // committing instead of aborting the whole transaction.
    const claimFor = (moduleIdentity: string) => ({
      __ctWriterIdentityOf: {
        file: "/system/profile-home.tsx",
        path: ["addElement"],
        moduleIdentity,
      },
    });
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        elements: {
          type: "array",
          ifc: { writeAuthorizedBy: claimFor("fid1:left") },
        },
      },
    }, {
      type: "object",
      properties: {
        elements: {
          type: "array",
          ifc: { writeAuthorizedBy: claimFor("fid1:right") },
        },
        displayName: { type: "string" },
      },
    });
    // deno-lint-ignore no-explicit-any
    expect((merged as any).properties.elements.ifc.writeAuthorizedBy)
      .toEqual(claimFor("fid1:left"));
    // This is the production reason for reconciling instead of aborting: the
    // candidate envelope can still contribute an unrelated sibling schema.
    // deno-lint-ignore no-explicit-any
    expect((merged as any).properties.displayName).toEqual({ type: "string" });
  });

  it("rejects writeAuthorizedBy claims with different bindings", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/system/profile-home.tsx",
                  path: ["addElement"],
                },
              },
            },
          },
        },
      }, {
        type: "object",
        properties: {
          elements: {
            type: "array",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/system/profile-home.tsx",
                  path: ["removeElement"],
                },
              },
            },
          },
        },
      })
    ).toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("rejects stamped writeAuthorizedBy claims with different bindings", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes({
        ifc: {
          writeAuthorizedBy: {
            __ctWriterIdentityOf: {
              file: "/system/profile-home.tsx",
              path: ["save"],
              moduleIdentity: "module-identity-hash",
            },
          },
        } as any,
      }, {
        ifc: {
          writeAuthorizedBy: {
            __ctWriterIdentityOf: {
              file: "/system/profile-home.tsx",
              path: ["delete"],
            },
          },
        } as any,
      })
    ).toThrow(/writeAuthorizedBy must remain stable/);
  });

  it("treats true schema nodes as permissive when merging envelopes", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: {
        result: true,
      },
    }, {
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            approved: { type: "boolean" },
          },
        },
      },
    });

    expect((merged as JSONSchemaObj).properties?.result).toMatchObject({
      type: "object",
      properties: {
        approved: { type: "boolean" },
      },
    });
  });
});

describe("storedSchemaCoversCandidateEnvelope (merge-skip decision)", () => {
  // The merge-skip decision must not judge envelopes "covered" via the items
  // branch while their tuple slots differ: coverage=true skips the merge, so
  // that would drop the candidate's slot info instead of merging it
  // (fail-open).

  it("covers a candidate that declares nothing", () => {
    // `true` and the empty object schema carry no label, no policy claim and
    // no shape, so a merge leaves the stored envelope as it stands. The
    // stored side saying nothing about the path is the case that matters
    // most: the merge reads the STORED envelope, so a writer naming nothing
    // would otherwise be refused for a defect in a schema it neither wrote
    // nor touches.
    const stored = {
      type: "object",
      properties: { name: { type: "string", ifc: { confidentiality: ["s"] } } },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, true)).toBe(true);
    expect(storedSchemaCoversCandidateEnvelope(stored, {})).toBe(true);
    expect(storedSchemaCoversCandidateEnvelope(undefined, true)).toBe(true);
    expect(storedSchemaCoversCandidateEnvelope(undefined, {})).toBe(true);
    expect(
      storedSchemaCoversCandidateEnvelope(stored, {
        type: "object",
        properties: { error: true },
      }),
    ).toBe(true);
  });

  it("does not cover a candidate carrying only `ifc`, `default` or `$defs`", () => {
    // `cfcSchemaIsTrue` admits all three as true schemas. Each carries
    // something the merge has to fold in, so none of them is a schema that
    // declares nothing.
    const stored = { type: "object" } as const;
    expect(
      storedSchemaCoversCandidateEnvelope(stored, {
        ifc: { confidentiality: ["s"] },
      }),
    ).toBe(false);
    expect(storedSchemaCoversCandidateEnvelope(stored, { default: 1 })).toBe(
      false,
    );
    expect(
      storedSchemaCoversCandidateEnvelope(stored, { $defs: { a: true } }),
    ).toBe(false);
    expect(
      storedSchemaCoversCandidateEnvelope(undefined, { default: 1 }),
    ).toBe(false);
  });

  it("does not cover a nothing-declaring candidate against a stored `false`", () => {
    // `false` admits no value, so there is nothing for a candidate to be
    // folded into: `mergeCfcSchemaEnvelopes` refuses the form, and the write
    // with it.
    expect(storedSchemaCoversCandidateEnvelope(false, true)).toBe(false);
    expect(
      storedSchemaCoversCandidateEnvelope(
        { type: "object", properties: { error: false } },
        { type: "object", properties: { error: true } },
      ),
    ).toBe(false);
  });

  it("does not cover a candidate key a stored rest claim would govern", () => {
    // The merge pulls an object-valued `additionalProperties` claim down
    // onto a key the candidate names, which is what mints that key's label.
    // Skipping the merge would land the value unlabeled.
    const stored = {
      type: "object",
      properties: { a: { type: "string", ifc: { confidentiality: ["seed"] } } },
      additionalProperties: { ifc: { confidentiality: ["secret"] } },
    } as const;
    expect(
      storedSchemaCoversCandidateEnvelope(stored, {
        type: "object",
        properties: { error: true },
      }),
    ).toBe(false);
    // A key the stored side names itself is judged on that named schema.
    expect(
      storedSchemaCoversCandidateEnvelope(stored, {
        type: "object",
        properties: { a: true },
      }),
    ).toBe(true);
  });

  it("differing tuple slots are not judged covered by matching items", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string", default: "x" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("covers slot-wise when arities are equal and slots cover", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(true);
  });

  it("fails closed on differing tuple arities", () => {
    // With differing arities, the candidate's `items` claims positions the
    // stored side covers with slots — the shared items branch cannot
    // compare those, so coverage must fail closed and merge.
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("does not judge a candidate additionalProperties claim covered via properties alone", () => {
    // The properties branch must compare rest claims rather than return
    // early, or a candidate map-value claim is dropped instead of merged.
    const stored = {
      type: "object",
      properties: { a: { type: "string" } },
    } as const;
    const candidate = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("boolean rest claims must match exactly for coverage", () => {
    const stored = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      additionalProperties: false,
    } as const;
    const covered = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    } as const;
    const open = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: true,
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, covered)).toBe(true);
    expect(storedSchemaCoversCandidateEnvelope(stored, open)).toBe(false);
  });

  it("fails closed when only the candidate declares prefixItems", () => {
    const stored = {
      type: "array",
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "number" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("stored-only named properties must cover the candidate rest claim", () => {
    // The candidate rest claim governs every key absent from the
    // CANDIDATE's properties — including stored-NAMED keys. An unlabeled
    // stored `b` does not cover a confidential rest claim, so coverage must
    // fail closed and merge.
    const stored = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: {
        type: "string",
        ifc: { confidentiality: ["x"] },
      },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("covers the rest claim when stored-only named properties carry it too", () => {
    const restClaim = {
      type: "string",
      ifc: { confidentiality: ["x"] },
    } as const;
    const stored = {
      type: "object",
      properties: { a: { type: "string" }, b: restClaim },
      additionalProperties: restClaim,
    } as const;
    const candidate = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: restClaim,
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(true);
  });

  it("fails closed when the candidate declares more slots than stored", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });

  it("stored-only prefixItems fails closed — rest items do not speak for slots", () => {
    const stored = {
      type: "array",
      prefixItems: [{ type: "string" }],
      items: { type: "number" },
    } as const;
    const candidate = {
      type: "array",
      items: { type: "number" },
    } as const;
    expect(storedSchemaCoversCandidateEnvelope(stored, candidate)).toBe(false);
  });
});

describe("cfcSchemaMergeIssue", () => {
  // `cfcSchemaMergeIssue` is the dry-run seam over the SAME merge: `cf piece
  // setsrc --check` asks it whether a candidate envelope would be accepted
  // rather than attempting the swap and taking a low-level commit rejection.
  // What it must not do is reimplement the rules, so these cases pin that its
  // verdict is the merge's own — including the message, verbatim.

  it("reports no issue when the merge succeeds", () => {
    expect(cfcSchemaMergeIssue({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" } },
    })).toBe(undefined);
  });

  it("discriminates the additive-required migration class", () => {
    // The class the runnability backstop rolls forward on: an old document
    // predating a now-required field that declares no default. A caller has to
    // be able to tell it apart from a hard incompatibility, because only this
    // one is recoverable.
    const issue = cfcSchemaMergeIssue({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["b"],
    });
    expect(issue?.migration).toBe(true);
    expect(issue?.message).toContain("needs a default");
  });

  it("reports a weakened ifc claim as a hard incompatibility", () => {
    const issue = cfcSchemaMergeIssue({
      type: "object",
      properties: { a: { type: "string", ifc: { confidentiality: ["x"] } } },
    }, {
      type: "object",
      properties: { a: { type: "string", ifc: { confidentiality: ["y"] } } },
    });
    expect(issue?.migration).toBe(false);
    expect(issue?.message).toContain("confidentiality cannot be weakened");
  });

  it("refuses two different claims whose identity is an array", () => {
    // A claim reconciles with another only when their bindings correspond,
    // which is read from the identity's `file` and `path`. An array carries
    // neither. Different bindings conflict.
    const mergeArrayIdentities = () =>
      mergeCfcSchemaEnvelopes({
        ifc: {
          writeAuthorizedBy: { __ctWriterIdentityOf: ["one"] },
        } as any,
      }, {
        ifc: {
          writeAuthorizedBy: { __ctWriterIdentityOf: ["two"] },
        } as any,
      });

    expect(mergeArrayIdentities).toThrow(
      "writeAuthorizedBy must remain stable",
    );
  });
});

describe("schema comparison over a fabric-valued default", () => {
  // A fabric-valued default has no properties for a schema comparison to
  // read, so a comparison built on a property walk calls two schemas that
  // differ only there equal -- and coverage=true skips the merge, discarding
  // the candidate's default.

  const withDefault = (bytes: readonly number[]) => ({
    type: "object",
    properties: {
      a: {
        type: "object",
        default: new FabricBytes(new Uint8Array(bytes)) as never,
      },
    },
  } as const);

  it("does not judge differing fabric defaults covered", () => {
    expect(
      storedSchemaCoversCandidateEnvelope(
        withDefault([1, 2]),
        withDefault([3]),
      ),
    ).toBe(false);
  });

  it("still judges equal fabric defaults covered", () => {
    expect(
      storedSchemaCoversCandidateEnvelope(
        withDefault([1, 2]),
        withDefault([1, 2]),
      ),
    ).toBe(true);
  });

  it("merges a fabric default onto a plain one rather than to `{}`", () => {
    const merged = mergeCfcSchemaEnvelopes({
      type: "object",
      properties: { a: { type: "object", default: { x: 1 } } },
    }, withDefault([7])) as JSONSchemaObj;
    const properties = merged.properties as Record<string, JSONSchemaObj>;
    expect(properties.a.default).toBeInstanceOf(FabricBytes);
  });
});

describe("schema comparison over a link-valued default", () => {
  // `stripWriterIdentityStamp` runs over the whole schema before two are
  // compared, and it rebuilds every record it visits. A link is a reference
  // rather than a record of the writer's, so it is carried whole; rebuilding
  // one would strip nothing and erase the difference between two schemas that
  // point at different documents.

  const linkTo = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

  const withLink = (id: string) =>
    ({
      type: "object",
      properties: { a: { type: "object", default: linkTo(id) as never } },
    }) as const;

  it("does not judge differing link defaults covered", () => {
    expect(
      storedSchemaCoversCandidateEnvelope(
        withLink("of:sp-one"),
        withLink("of:sp-two"),
      ),
    ).toBe(false);
  });

  it("still judges equal link defaults covered", () => {
    expect(
      storedSchemaCoversCandidateEnvelope(
        withLink("of:sp-one"),
        withLink("of:sp-one"),
      ),
    ).toBe(true);
  });
});

describe("storedCfcEnvelopeMergeIssue", () => {
  // The dry run of what the persist loop does with a stored envelope: the
  // merge-skipping fast paths, then the merge. `cf piece setsrc --check`
  // drives it for the piece's argument and result documents, so what these
  // cases pin is that its verdict is the persist loop's — the options the
  // loop passes reach the merge, and a candidate the stored envelope already
  // stands for raises nothing.

  it("returns `undefined` for a candidate the stored envelope covers", () => {
    const stored = {
      type: "object",
      properties: { a: { type: "string", ifc: { confidentiality: ["x"] } } },
    } as const;
    expect(storedCfcEnvelopeMergeIssue(stored, {
      type: "object",
      properties: { a: { type: "string" } },
    })).toBe(undefined);
  });

  it("reports a newly required field without a default as the migration class", () => {
    const issue = storedCfcEnvelopeMergeIssue({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["b"],
    });
    expect(issue?.migration).toBe(true);
    expect(issue?.message).toContain("needs a default");
  });

  it("returns `undefined` for a newly required field under a generated output path", () => {
    // The exemption setup's result write carries: the module materializes
    // the whole document in the same transaction, so no older value is there
    // to preserve. The preflight passes `[[]]` for the result document, and
    // the verdict has to change with it.
    expect(storedCfcEnvelopeMergeIssue({
      type: "object",
      properties: { a: { type: "string" } },
    }, {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["b"],
    }, { generatedOutputPaths: [[]] })).toBe(undefined);
  });

  it("reports two stamped writer claims naming different bindings", () => {
    const claim = (path: string) => ({
      type: "object",
      properties: {
        name: {
          type: "string",
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: {
                file: "/app/main.tsx",
                path: [path],
                moduleIdentity: "cf:module/one",
              },
            },
          },
        },
      },
    } as const);
    const issue = storedCfcEnvelopeMergeIssue(
      claim("setName"),
      claim("assignName"),
    );
    expect(issue?.migration).toBe(false);
    expect(issue?.message).toBe(
      "writeAuthorizedBy must remain stable at /name",
    );
  });
});

describe("cfcSchemaPoliciesEqual", () => {
  const CLAIM = { writeAuthorizedBy: ["writer"] };
  const inline = {
    type: "object",
    properties: {
      list: {
        type: "array",
        ifc: CLAIM,
        items: { type: "object", properties: { n: { type: "number" } } },
        default: [],
      },
    },
  } as const;

  it("compares two spellings of one policy equal", () => {
    // A nested definition map carried along, another default, and absent
    // claims spelled as members holding `undefined`, the way a merge leaves
    // them.
    const respelled = {
      type: "object",
      properties: {
        list: {
          type: "array",
          ifc: { ...CLAIM, confidentiality: undefined },
          items: {
            type: "object",
            properties: { n: { type: "number" } },
            $defs: {},
          },
          default: {},
        },
      },
    } as unknown as JSONSchemaObj;
    expect(cfcSchemaPoliciesEqual(inline, respelled)).toBe(true);
  });

  it("tells a changed claim apart", () => {
    const changed = {
      ...inline,
      properties: {
        list: {
          ...inline.properties.list,
          ifc: { writeAuthorizedBy: ["other"] },
        },
      },
    } as JSONSchemaObj;
    expect(cfcSchemaPoliciesEqual(inline, changed)).toBe(false);
    const dropped = {
      ...inline,
      properties: { list: { ...inline.properties.list, ifc: undefined } },
    } as unknown as JSONSchemaObj;
    expect(cfcSchemaPoliciesEqual(inline, dropped)).toBe(false);
  });
});
