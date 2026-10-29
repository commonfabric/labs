import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CfcAtom } from "@commonfabric/api/cfc";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";
import {
  cfcSchemaMergeIssue,
  cfcSchemaPoliciesEqual,
  mergeCfcSchemaEnvelopes,
} from "../src/cfc/schema-merge.ts";
import {
  canonicalizeCfcSchemaDocument,
  resolveCfcSchemaRefs,
} from "../src/cfc/schema-refs.ts";
import { validateSchemaDefinition } from "../src/cfc/schema-sanitization.ts";
import {
  storedCfcEnvelopeMergeIssue,
  storedSchemaCoversCandidateEnvelope,
} from "../src/cfc/prepare.ts";
import { cfcSchemaEntries } from "../src/cfc/schema-label-view.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

describe("mergeCfcSchemaEnvelopes", () => {
  describe("a recursion meeting itself", () => {
    // A tree whose node names itself for its children, with a claim on each
    // node's label. Two documents spelling that definition differently meet
    // it again one level down, where the merge refers to the merged
    // definition of the pair rather than to either side's own.

    const tree = (labelClaim: unknown): JSONSchemaObj =>
      ({
        type: "object",
        properties: { root: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: {
              label: { type: "string", ifc: labelClaim },
              children: { type: "array", items: { $ref: "#/$defs/Node" } },
            },
          },
        },
      }) as unknown as JSONSchemaObj;
    const writer = (moduleIdentity?: string, path = ["pin"]) => ({
      writeAuthorizedBy: {
        __ctWriterIdentityOf: {
          file: "/main.tsx",
          path,
          ...(moduleIdentity === undefined ? {} : { moduleIdentity }),
        },
      },
    });
    const resolved = (schema: JSONSchema, node: JSONSchema): JSONSchemaObj => {
      const object = node as JSONSchemaObj;
      return typeof object.$ref === "string"
        ? resolveCfcSchemaRefs(object, schema) as JSONSchemaObj
        : object;
    };
    /** The merged node at `path` (`*` for items), its references followed. */
    const at = (schema: JSONSchema, path: readonly string[]): JSONSchemaObj =>
      path.reduce(
        (node, segment) =>
          resolved(
            schema,
            (segment === "*"
              ? node.items
              : (node.properties as Record<string, JSONSchema>)[segment])!,
          ),
        resolved(schema, schema),
      );
    const stampAt = (schema: JSONSchema, path: readonly string[]) =>
      ((at(schema, path).ifc as ReturnType<typeof writer>).writeAuthorizedBy
        .__ctWriterIdentityOf as { moduleIdentity?: string }).moduleIdentity;

    it("keeps the stored stamp at every level beneath the recurrence", () => {
      const merged = mergeCfcSchemaEnvelopes(
        tree(writer("m1")),
        tree(writer("m2")),
      );
      expect(stampAt(merged, ["root", "label"])).toBe("m1");
      expect(stampAt(merged, ["root", "children", "*", "label"])).toBe("m1");
      expect(
        stampAt(merged, ["root", "children", "*", "children", "*", "label"]),
      ).toBe("m1");
    });

    it("holds both sides' claims at every level beneath the recurrence", () => {
      const merged = mergeCfcSchemaEnvelopes(
        tree(writer()),
        tree({ requiredIntegrity: ["reviewed"] }),
      );
      const deep = at(merged, [
        "root",
        "children",
        "*",
        "children",
        "*",
        "label",
      ]).ifc as Record<string, unknown>;
      expect(deep.writeAuthorizedBy).toEqual(writer().writeAuthorizedBy);
      expect(deep.requiredIntegrity).toEqual(["reviewed"]);
    });

    it("merges the same candidate into its own result unchanged", () => {
      // The merged document names the pair's merged definition where the
      // stored one wrote the recursion out, so merging the candidate again
      // meets the same pair at the same place and writes nothing further out.

      const candidate = tree(writer("m2"));
      const merged = mergeCfcSchemaEnvelopes(tree(writer("m1")), candidate);
      expect(mergeCfcSchemaEnvelopes(merged, candidate)).toEqual(merged);
    });

    it("throws for two references that do not resolve rather than minting a definition from them", () => {
      // Where the policies differ, every reference is resolved before the
      // merge, so a pair naming nothing never reaches the merge of two
      // bodies.

      const unresolved = (name: string): JSONSchemaObj => ({
        type: "object",
        properties: { pin: { $ref: `#/$defs/${name}` } },
        $defs: { Other: { type: "string", ifc: writer() } },
      });
      expect(() =>
        mergeCfcSchemaEnvelopes(
          unresolved("Missing"),
          unresolved("AlsoMissing"),
        )
      ).toThrow(/requires resolved schemas/);
    });

    it("throws for a definition that changes the stored writer inside the recursion", () => {
      expect(() =>
        mergeCfcSchemaEnvelopes(
          tree(writer()),
          tree(writer(undefined, ["other"])),
        )
      ).toThrow(/writeAuthorizedBy/);
    });
  });

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

  it("merges a schema naming other value stamps than the first, keeping both", () => {
    // A value stamp is the stamping write's own, so naming fewer than an
    // earlier schema did weakens nothing.
    const stamping = (...addIntegrity: CfcAtom[]): JSONSchema => ({
      type: "object",
      properties: { note: { type: "string", ifc: { addIntegrity } } },
    });
    const merged = mergeCfcSchemaEnvelopes(
      stamping("reviewed"),
      stamping("checked"),
    );

    expect(
      ((merged as JSONSchemaObj).properties?.note as JSONSchemaObj).ifc
        ?.addIntegrity,
    ).toEqual(["reviewed", "checked"]);
  });

  it("throws when a schema leaves out a principal claim the first names in `addIntegrity`", () => {
    const claiming = (...addIntegrity: CfcAtom[]): JSONSchema => ({
      type: "object",
      properties: { note: { type: "string", ifc: { addIntegrity } } },
    });

    expect(() =>
      mergeCfcSchemaEnvelopes(
        claiming({ kind: "authored-by", subject: "did:key:author" }),
        claiming("checked"),
      )
    ).toThrow(/addIntegrity cannot be weakened/);
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

  it("keeps the claims a reference carries when the candidate declares a label at that position", () => {
    // Resolving a reference lets an `ifc` beside it replace the referenced
    // body's `ifc`, so the merge has to meet the two declarations rather than
    // set the candidate's beside the stored reference.

    const stored = {
      type: "object",
      properties: { pin: { $ref: "#/$defs/Pin" } },
      $defs: {
        Pin: {
          type: "string",
          ifc: {
            uiContract: { helper: "UiAction", action: "PinNote" },
            writeAuthorizedBy: ["pin-builtin"],
            requiredIntegrity: ["pin-approved"],
          },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: {
        pin: { type: "string", ifc: { confidentiality: ["writer-clause"] } },
      },
    } as const;

    const entries = cfcSchemaEntries(
      mergeCfcSchemaEnvelopes(stored, candidate),
    );
    expect(entries.map((entry) => entry.path)).toEqual([["pin"]]);
    expect((entries[0].schema as JSONSchemaObj).ifc).toEqual({
      confidentiality: ["writer-clause"],
      uiContract: { helper: "UiAction", action: "PinNote" },
      writeAuthorizedBy: ["pin-builtin"],
      requiredIntegrity: ["pin-approved"],
    });
  });

  it("keeps the claims a reference carries when the candidate refers to another definition at that position", () => {
    const stored = {
      type: "object",
      properties: { pin: { $ref: "#/$defs/Pin" } },
      $defs: {
        Pin: {
          type: "string",
          ifc: { uiContract: { helper: "UiAction", action: "PinNote" } },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { pin: { $ref: "#/$defs/Endorsed" } },
      $defs: {
        Endorsed: { type: "string", ifc: { addIntegrity: ["endorsed"] } },
      },
    } as const;

    const entries = cfcSchemaEntries(
      mergeCfcSchemaEnvelopes(stored, candidate),
    );
    expect(entries.map((entry) => entry.path)).toEqual([["pin"]]);
    expect((entries[0].schema as JSONSchemaObj).ifc).toEqual({
      uiContract: { helper: "UiAction", action: "PinNote" },
      addIntegrity: ["endorsed"],
    });
  });

  it("keeps the claims a reference's body declares beneath an `ifc` beside the reference", () => {
    const stored = {
      type: "object",
      properties: {
        pin: {
          $ref: "#/$defs/Pin",
          ifc: { confidentiality: ["store-clause"] },
        },
      },
      $defs: {
        Pin: {
          type: "string",
          ifc: { uiContract: { helper: "UiAction", action: "PinNote" } },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: {
        pin: {
          type: "string",
          ifc: { confidentiality: ["store-clause", "writer-clause"] },
        },
      },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(stored, candidate) as JSONSchemaObj;
    expect((merged.properties?.pin as JSONSchemaObj).ifc).toEqual({
      confidentiality: ["store-clause", "writer-clause"],
      uiContract: { helper: "UiAction", action: "PinNote" },
    });
  });

  it("keeps the claims a reference carries when the candidate refers to a definition declaring nothing", () => {
    const stored = {
      type: "object",
      properties: { pin: { $ref: "#/$defs/Pin" } },
      $defs: {
        Pin: {
          type: "string",
          ifc: { uiContract: { helper: "UiAction", action: "PinNote" } },
        },
      },
    } as const;
    const candidate = {
      type: "object",
      properties: { pin: { $ref: "#/$defs/Plain" } },
      $defs: { Plain: { type: "string" } },
    } as const;

    const merged = mergeCfcSchemaEnvelopes(stored, candidate) as JSONSchemaObj;
    const entries = cfcSchemaEntries(merged);
    expect(entries.map((entry) => entry.path)).toEqual([["pin"]]);
    expect((entries[0].schema as JSONSchemaObj).ifc).toEqual({
      uiContract: { helper: "UiAction", action: "PinNote" },
    });
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

  describe("an unstamped stored claim meeting a stamped one from another root", () => {
    // A claim stored before writer stamps existed carries only the file its
    // compile spelled, relative to whatever root that compile used. A stamped
    // claim from the pattern's next release adopts it when both name the same
    // export of the same file below a known pattern root. Main replaced such
    // claims outright, whatever they named.

    const claim = (file: string, path: string[], moduleIdentity?: string) => ({
      __ctWriterIdentityOf: {
        file,
        path,
        ...(moduleIdentity !== undefined && { moduleIdentity }),
      },
    });
    // `release` stands for a caller that vouches for the stamp (a release
    // installing its module, or the writer the stamp names).
    type Claim = ReturnType<typeof claim>;
    const merge = (stored: Claim, candidate: Claim, release = true) =>
      (
        (mergeCfcSchemaEnvelopes({
          type: "object",
          properties: {
            mru: { type: "array", ifc: { writeAuthorizedBy: stored } },
          },
        }, {
          type: "object",
          properties: {
            mru: { type: "array", ifc: { writeAuthorizedBy: candidate } },
          },
        }, { adoptsStamp: release ? () => true : undefined }) as JSONSchemaObj)
          .properties?.mru as JSONSchemaObj
      ).ifc?.writeAuthorizedBy;

    it("adopts the stamp for the same export below a pattern root", () => {
      const stamped = claim(
        "/packages/patterns/system/profile-create.tsx",
        ["setMruProfile"],
        "release-2",
      );
      for (
        const stored of [
          "/system/profile-create.tsx",
          "/api/patterns/system/profile-create.tsx",
          "/patterns/system/profile-create.tsx",
        ]
      ) {
        expect(merge(claim(stored, ["setMruProfile"]), stamped)).toEqual(
          stamped,
        );
      }
    });

    it("refuses to adopt outside a release", () => {
      expect(() =>
        merge(
          claim("/system/profile-create.tsx", ["setMruProfile"]),
          claim(
            "/packages/patterns/system/profile-create.tsx",
            ["setMruProfile"],
            "release-2",
          ),
          false,
        )
      ).toThrow("writeAuthorizedBy must remain stable at /mru");
    });

    it("refuses an unstamped claim over a stamped one, and a root further in", () => {
      expect(() =>
        merge(
          claim(
            "/api/patterns/system/profile-create.tsx",
            ["setMruProfile"],
            "release-1",
          ),
          claim("/packages/patterns/system/profile-create.tsx", [
            "setMruProfile",
          ]),
        )
      ).toThrow("writeAuthorizedBy must remain stable at /mru");
      for (
        const [stored, candidate] of [
          [
            "/evil/api/patterns/system/profile-create.tsx",
            "/packages/patterns/system/profile-create.tsx",
          ],
          ["//profile-create.tsx", "/packages/patterns//profile-create.tsx"],
          [
            "/system/../profile-create.tsx",
            "/packages/patterns/system/../profile-create.tsx",
          ],
          // A stamp spelled below no known root.
          [
            "/api/patterns/system/profile-create.tsx",
            "/system/profile-create.tsx",
          ],
        ]
      ) {
        expect(() =>
          merge(
            claim(stored, ["setMruProfile"]),
            claim(candidate, ["setMruProfile"], "release-2"),
          )
        ).toThrow("writeAuthorizedBy must remain stable at /mru");
      }
    });

    it("refuses a stored claim that names no file", () => {
      expect(() =>
        merge(
          { __ctWriterIdentityOf: { path: ["setMruProfile"] } } as never,
          claim(
            "/packages/patterns/system/profile-create.tsx",
            ["setMruProfile"],
            "release-2",
          ),
        )
      ).toThrow("writeAuthorizedBy must remain stable at /mru");
    });

    it("refuses the same file name in another directory", () => {
      expect(() =>
        merge(
          claim("/system/profile-create.tsx", ["setMruProfile"]),
          claim(
            "/packages/patterns/other/profile-create.tsx",
            ["setMruProfile"],
            "release-2",
          ),
        )
      ).toThrow("writeAuthorizedBy must remain stable at /mru");
    });

    it("refuses another export of the same file", () => {
      expect(() =>
        merge(
          claim("/system/profile-create.tsx", ["setMruProfile"]),
          claim(
            "/packages/patterns/system/profile-create.tsx",
            ["setDefaultProfile"],
            "release-2",
          ),
        )
      ).toThrow("writeAuthorizedBy must remain stable at /mru");
    });

    it("refuses a file with no directory below the root", () => {
      // A temporary stage names the file alone. (A spelling one leading
      // segment away, which the toolchain's old strip produced, corresponds
      // by the rule that predates this one.)
      for (
        const [stored, candidate] of [
          ["/profile-create.tsx", "/packages/patterns/profile-create.tsx"],
          ["/profile-create.tsx", "/api/patterns/profile-create.tsx"],
        ]
      ) {
        expect(() =>
          merge(
            claim(stored, ["setMruProfile"]),
            claim(candidate, ["setMruProfile"], "release-2"),
          )
        ).toThrow("writeAuthorizedBy must remain stable at /mru");
      }
    });

    it("keeps a stored stamp against another release's", () => {
      // Stamped against stamped is a version boundary: the stored stamp stays,
      // and the new release writes the field only with a delegation
      // (module-delegation.test.ts).
      const stored = claim(
        "/api/patterns/system/profile-create.tsx",
        ["setMruProfile"],
        "release-1",
      );
      expect(
        merge(
          stored,
          claim(
            "/packages/patterns/system/profile-create.tsx",
            ["setMruProfile"],
            "release-2",
          ),
        ),
      ).toEqual(stored);
    });
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

  describe("over definitions", () => {
    // `inline` with `list` named by reference into the root's definition
    // map, which also holds `extra`, a definition nothing references.
    const referenced = (listClaim: unknown, extraClaim: unknown) =>
      ({
        type: "object",
        properties: { list: { $ref: "#/$defs/List" } },
        $defs: {
          List: { ...inline.properties.list, ifc: listClaim },
          Extra: { type: "string", ifc: extraClaim },
        },
      }) as unknown as JSONSchemaObj;

    it("compares a claim reached through a reference equal to the same claim inline", () => {
      expect(cfcSchemaPoliciesEqual(inline, referenced(CLAIM, CLAIM))).toBe(
        true,
      );
    });

    it("compares two documents equal where only a definition no reference reaches differs", () => {
      expect(
        cfcSchemaPoliciesEqual(
          referenced(CLAIM, CLAIM),
          referenced(CLAIM, { writeAuthorizedBy: ["other"] }),
        ),
      ).toBe(true);
    });

    it("tells apart a changed claim in a definition a reference reaches", () => {
      expect(
        cfcSchemaPoliciesEqual(
          referenced(CLAIM, CLAIM),
          referenced({ writeAuthorizedBy: ["other"] }, CLAIM),
        ),
      ).toBe(false);
      expect(
        cfcSchemaPoliciesEqual(inline, referenced(undefined, CLAIM)),
      ).toBe(false);
    });

    it("tells apart a changed claim in a referenced body beside a claim at the reference", () => {
      const sited = (bodyClaim: unknown) =>
        ({
          type: "object",
          properties: { list: { $ref: "#/$defs/List", ifc: CLAIM } },
          $defs: {
            List: {
              ...inline.properties.list,
              ifc: { confidentiality: bodyClaim },
            },
          },
        }) as unknown as JSONSchemaObj;
      expect(cfcSchemaPoliciesEqual(sited(["one"]), sited(["one"]))).toBe(
        true,
      );
      expect(cfcSchemaPoliciesEqual(sited(["one"]), sited(["two"]))).toBe(
        false,
      );
    });
  });

  describe("over recursive definitions", () => {
    // A tree whose node names itself for its children, with a claim on each
    // node's label; and two definitions naming each other the same way.
    const tree = (labelClaim: unknown) =>
      ({
        type: "object",
        properties: { root: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: {
              label: { type: "string", ifc: labelClaim },
              children: { type: "array", items: { $ref: "#/$defs/Node" } },
            },
          },
        },
      }) as unknown as JSONSchemaObj;
    const mutual = (bClaim: unknown) =>
      ({
        type: "object",
        properties: { root: { $ref: "#/$defs/A" } },
        $defs: {
          A: {
            type: "object",
            ifc: CLAIM,
            properties: { next: { $ref: "#/$defs/B" } },
          },
          B: {
            type: "object",
            ifc: bClaim,
            properties: { next: { $ref: "#/$defs/A" } },
          },
        },
      }) as unknown as JSONSchemaObj;

    it("compares a self-referencing definition equal to itself, and tells apart a changed claim inside it", () => {
      expect(cfcSchemaPoliciesEqual(tree(CLAIM), tree(CLAIM))).toBe(true);
      expect(
        cfcSchemaPoliciesEqual(
          tree(CLAIM),
          tree({ writeAuthorizedBy: ["other"] }),
        ),
      ).toBe(false);
    });

    it("compares two definitions naming each other equal to themselves, and tells apart a changed claim in either", () => {
      expect(cfcSchemaPoliciesEqual(mutual(CLAIM), mutual(CLAIM))).toBe(true);
      expect(
        cfcSchemaPoliciesEqual(
          mutual(CLAIM),
          mutual({ writeAuthorizedBy: ["other"] }),
        ),
      ).toBe(false);
    });

    it("compares a self-referencing definition reached through a `cid:` document equal to the same definition spelled locally, and tells apart a changed claim", () => {
      // A member of a registered schema document that names itself is read
      // back with that reference spelled as a `cid:` reference into the same
      // document, so the walk recurses across `cid:` references.
      const release = acquireSchemaRegistryLease();
      try {
        const external = (labelClaim: unknown) => {
          const { $defs } = tree(labelClaim);
          const group = { $defs } as unknown as JSONSchemaObj;
          const hash = internSchemaAsTaggedHashString(group);
          registerSchemaDocument(hash, group);
          return {
            type: "object",
            properties: { root: { $ref: `cid:${hash}#/$defs/Node` } },
          } as unknown as JSONSchemaObj;
        };
        // Compared with the same tree spelled locally, so that the `cid:`
        // reference counts only by what it names.
        expect(cfcSchemaPoliciesEqual(external(CLAIM), tree(CLAIM))).toBe(true);
        expect(
          cfcSchemaPoliciesEqual(
            external(CLAIM),
            tree({ writeAuthorizedBy: ["other"] }),
          ),
        ).toBe(false);
      } finally {
        release();
      }
    });
  });

  describe("with positions left out", () => {
    // `inline` with a claim beneath each item of `list`, which differs
    // between the two documents.
    const beneath = (claim: unknown) =>
      ({
        type: "object",
        properties: {
          list: {
            ...inline.properties.list,
            items: {
              type: "object",
              properties: { n: { type: "number", ifc: claim } },
            },
          },
        },
      }) as unknown as JSONSchemaObj;
    const left = beneath(CLAIM);
    const right = beneath({ writeAuthorizedBy: ["other"] });

    it("compares two documents equal where they differ only beneath a position left out", () => {
      expect(cfcSchemaPoliciesEqual(left, right)).toBe(false);
      expect(
        cfcSchemaPoliciesEqual(
          left,
          right,
          (path) => path.length > 2 && path[0] === "list" && path[1] === "*",
        ),
      ).toBe(true);
    });

    it("tells apart a changed claim at a position not left out", () => {
      expect(
        cfcSchemaPoliciesEqual(
          left,
          right,
          (path) => path.length > 0 && path[0] === "other",
        ),
      ).toBe(false);
    });
  });
});

describe("canonicalizeCfcSchemaDocument", () => {
  // A definition reused from several places, with a policy on it, so that a
  // candidate whose policy differs sends the merge through the resolving
  // path that attaches the document's map to each expanded body.
  const envelope = (round: number): JSONSchemaObj => ({
    type: "object",
    properties: {
      main: { $ref: "#/$defs/Profile" },
      recent: { type: "array", items: { $ref: "#/$defs/Profile" } },
    },
    $defs: {
      Profile: {
        type: "object",
        properties: {
          name: { type: "string" },
          // Strengthened each round, so each candidate's policy differs
          // from the stored one and the merge takes the resolving path.
          secret: {
            type: "string",
            ifc: {
              confidentiality: Array.from(
                { length: round + 1 },
                (_, index) => `c${index}`,
              ),
            },
          },
        },
      },
    },
  });
  const countDefs = (schema: unknown): number => {
    let count = 0;
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, member] of Object.entries(value)) {
        if (key === "$defs" && member && typeof member === "object") {
          count += Object.keys(member).length;
        }
        walk(member);
      }
    };
    walk(schema);
    return count;
  };
  const nestedMaps = (schema: unknown): number => {
    let count = 0;
    const walk = (value: unknown, atRoot: boolean): void => {
      if (Array.isArray(value)) {
        value.forEach((member) => walk(member, false));
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, member] of Object.entries(value)) {
        if (key === "$defs" && !atRoot) count++;
        walk(member, false);
      }
    };
    walk(schema, true);
    return count;
  };

  it("keeps a repeatedly merged envelope's definition map bounded", () => {
    let merged: JSONSchema = envelope(0);
    const sizes: number[] = [];
    for (let round = 1; round <= 12; round++) {
      merged = mergeCfcSchemaEnvelopes(merged, envelope(round));
      sizes.push(JSON.stringify(merged).length);
    }
    // From the 6th merge to the 12th the document grows only by the six
    // tags the label gained (under 100 chars); left unpruned, each merge
    // adds a renamed copy of the candidate's definition that nothing
    // references, about 200 chars a round.
    expect(sizes[11] - sizes[5]).toBeLessThan(100);
    expect(nestedMaps(merged)).toBe(0);
    // At most one definition per distinct meaning that is still reachable.
    expect(countDefs(merged)).toBeLessThanOrEqual(1);
  });

  it("folds content-identical definitions onto one name and rewrites refs", () => {
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Entry" },
        b: { $ref: "#/$defs/__cfc_hoisted_0_Entry" },
        c: { $ref: "#/$defs/Other", $defs: { Entry: { type: "string" } } },
      },
      $defs: {
        Entry: { type: "string" },
        __cfc_hoisted_0_Entry: { type: "string" },
        __cfc_hoisted_1_Other: { type: "null" },
        Other: { type: "number" },
        // Authored and unreferenced: kept, with what it refers to.
        Unused: { type: "array", items: { $ref: "#/$defs/Spare" } },
        Spare: { type: "boolean" },
      },
    }) as JSONSchemaObj;
    expect(canonical.$defs).toEqual({
      Entry: { type: "string" },
      Other: { type: "number" },
      Spare: { type: "boolean" },
      Unused: { type: "array", items: { $ref: "#/$defs/Spare" } },
    });
    expect(canonical.properties).toEqual({
      a: { $ref: "#/$defs/Entry" },
      b: { $ref: "#/$defs/Entry" },
      c: { $ref: "#/$defs/Other" },
    });
  });

  it("folds a minted copy of a self-referential definition onto the original", () => {
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Node" },
        b: { $ref: "#/$defs/__cfc_hoisted_3_Node" },
      },
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
        __cfc_hoisted_3_Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/__cfc_hoisted_3_Node" } },
        },
      },
    }) as JSONSchemaObj;
    expect(canonical.$defs).toEqual({
      Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
    });
    expect(canonical.properties).toEqual({
      a: { $ref: "#/$defs/Node" },
      b: { $ref: "#/$defs/Node" },
    });
  });

  it("never folds two authored definitions onto each other", () => {
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: { a: { $ref: "#/$defs/Tag" }, b: { $ref: "#/$defs/Label" } },
      $defs: {
        Tag: { type: "string" },
        Label: { type: "string" },
        __cfc_hoisted_0_Tag: { type: "string" },
      },
    }) as JSONSchemaObj;
    expect(canonical.$defs).toEqual({
      Label: { type: "string" },
      Tag: { type: "string" },
    });
    expect(canonical.properties).toEqual({
      a: { $ref: "#/$defs/Tag" },
      b: { $ref: "#/$defs/Label" },
    });
  });

  // Deno disables the legacy `__proto__` setter, so an assignment into `{}`
  // keeps the name as an own property here and the failure this guards
  // against shows only under `deno test --unsafe-proto`, which restores
  // browser semantics; the file passes under both.
  it("keeps a definition named __proto__", () => {
    const definition = {
      type: "string",
      ifc: { confidentiality: ["secret"] },
    } as const;
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { a: { $ref: "#/$defs/__proto__" } },
      $defs: Object.fromEntries([["__proto__", definition]]),
    };
    const canonical = canonicalizeCfcSchemaDocument(schema) as JSONSchemaObj;
    expect(Object.hasOwn(canonical.$defs!, "__proto__")).toBe(true);
    expect(Object.entries(canonical.$defs!)).toEqual([
      ["__proto__", definition],
    ]);
    const merged = mergeCfcSchemaEnvelopes(schema, schema) as JSONSchemaObj;
    expect(Object.hasOwn(merged.$defs ?? {}, "__proto__")).toBe(true);
  });

  it("prunes a retained authored definition below the root", () => {
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: { a: { type: "string" } },
      $defs: {
        Unused: {
          type: "object",
          properties: { x: { type: "number", $defs: { Stale: true } } },
          $defs: { AlsoStale: { type: "null" } },
        },
      },
    }) as JSONSchemaObj;
    expect(canonical.$defs).toEqual({
      Unused: { type: "object", properties: { x: { type: "number" } } },
    });
  });

  it("reads a literal $ref inside policy or default data as data, not as a ref", () => {
    // Two definitions that differ only in a literal atom carrying a `$ref`
    // member, and a minted copy of the definition the atoms name: folding
    // must leave the atoms as they are, so the two stay distinct and the
    // policies of a document merged with itself are unchanged.
    const schema: JSONSchemaObj = {
      type: "object",
      properties: {
        a: { $ref: "#/$defs/A" },
        b: { $ref: "#/$defs/B" },
        c: { $ref: "#/$defs/__cfc_hoisted_0_X" },
        d: { $ref: "#/$defs/X", default: { $ref: "#/$defs/Y" } },
      },
      $defs: {
        A: {
          type: "string",
          ifc: {
            confidentiality: [
              { type: "https://example.com/Reader", $ref: "#/$defs/X" },
            ],
          },
        },
        B: {
          type: "string",
          ifc: {
            confidentiality: [
              { type: "https://example.com/Reader", $ref: "#/$defs/Y" },
            ],
          },
        },
        X: { type: "string" },
        Y: { type: "string" },
        __cfc_hoisted_0_X: { type: "string" },
      },
    };
    const canonical = canonicalizeCfcSchemaDocument(schema) as JSONSchemaObj;
    const defs = canonical.$defs as Record<string, JSONSchemaObj>;
    expect(Object.keys(defs).toSorted()).toEqual(["A", "B", "X", "Y"]);
    expect(defs.A.ifc).toEqual((schema.$defs!.A as JSONSchemaObj).ifc);
    expect(defs.B.ifc).toEqual((schema.$defs!.B as JSONSchemaObj).ifc);
    expect((canonical.properties as Record<string, JSONSchemaObj>).d).toEqual({
      $ref: "#/$defs/X",
      default: { $ref: "#/$defs/Y" },
    });
    expect(
      cfcSchemaPoliciesEqual(schema, mergeCfcSchemaEnvelopes(schema, schema)),
    )
      .toBe(true);
  });

  it("keeps definitions apart whose Fabric-valued defaults differ", () => {
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Bytes" },
        b: { $ref: "#/$defs/__cfc_hoisted_0_Bytes" },
      },
      $defs: {
        Bytes: {
          type: "object",
          default: new FabricBytes(new Uint8Array([1, 2])),
        },
        __cfc_hoisted_0_Bytes: {
          type: "object",
          default: new FabricBytes(new Uint8Array([3])),
        },
      },
    } as unknown as JSONSchemaObj) as JSONSchemaObj;
    expect(Object.keys(canonical.$defs!).toSorted()).toEqual([
      "Bytes",
      "__cfc_hoisted_0_Bytes",
    ]);
    expect((canonical.properties as Record<string, JSONSchemaObj>).b).toEqual({
      $ref: "#/$defs/__cfc_hoisted_0_Bytes",
    });
  });

  it("is a fixpoint: canonicalizing a canonical document changes nothing", () => {
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Node" },
        b: { $ref: "#/$defs/__cfc_hoisted_3_Node" },
        c: { $ref: "#/$defs/Other", $defs: { Other: { type: "number" } } },
      },
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
        },
        __cfc_hoisted_3_Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/__cfc_hoisted_3_Node" } },
        },
        Other: { type: "number" },
        Spare: { type: "boolean" },
      },
    });
    expect(canonicalizeCfcSchemaDocument(canonical)).toEqual(canonical);
  });

  it("brings a stored document of the earlier shape down to its definitions in one merge", () => {
    // The shape a stored envelope took on before merges left documents in
    // canonical form: the root map holding the definitions under their own
    // names and under many minted names, each minted copy referring to its
    // own kind, and bodies carrying the whole root map.
    const copies = 30;
    const base = (suffix: string): Record<string, JSONSchema> => ({
      [`A${suffix}`]: {
        type: "object",
        properties: {
          s: { type: "string", ifc: { confidentiality: ["c"] } },
          link: { $ref: `#/$defs/B${suffix}` },
        },
      },
      [`B${suffix}`]: {
        type: "object",
        properties: {
          n: { type: "number" },
          deeper: { $ref: `#/$defs/C${suffix}` },
        },
      },
      [`C${suffix}`]: {
        type: "object",
        properties: { z: { type: "boolean" } },
      },
    });
    const rootMap: Record<string, JSONSchema> = { ...base("") };
    for (let index = 0; index < copies; index++) {
      for (const [name, definition] of Object.entries(base(`-${index}`))) {
        const kind = name[0];
        rootMap[`__cfc_hoisted_${index}_${kind}`] = JSON.parse(
          JSON.stringify(definition).replaceAll(
            `#/$defs/${kind === "A" ? "B" : "C"}-${index}`,
            `#/$defs/__cfc_hoisted_${index}_${kind === "A" ? "B" : "C"}`,
          ),
        );
      }
    }
    const resolvedBody = (ref: string): JSONSchemaObj => ({
      type: "object",
      properties: { s: { type: "string" }, link: { $ref: ref } },
      $defs: rootMap,
    });
    const stored: JSONSchemaObj = {
      type: "object",
      properties: {
        a: resolvedBody("#/$defs/__cfc_hoisted_7_B"),
        b: resolvedBody("#/$defs/__cfc_hoisted_12_B"),
        c: { $ref: "#/$defs/A" },
      },
      $defs: rootMap,
    };
    const candidate: JSONSchemaObj = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: { s: { type: "string" }, link: { $ref: "#/$defs/B" } },
        },
        b: {
          type: "object",
          properties: { s: { type: "string" }, link: { $ref: "#/$defs/B" } },
        },
        c: { $ref: "#/$defs/A" },
      },
      $defs: base(""),
    };
    const merged = mergeCfcSchemaEnvelopes(stored, candidate) as JSONSchemaObj;
    expect(Object.keys(merged.$defs ?? {}).toSorted()).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(merged).includes("__cfc_hoisted")).toBe(false);
    expect(nestedMaps(merged)).toBe(0);
    expect(JSON.stringify(merged).length).toBeLessThan(
      JSON.stringify(candidate).length * 2,
    );
    expect(JSON.stringify(stored).length).toBeGreaterThan(
      JSON.stringify(merged).length * 50,
    );
  });

  it("never reads an unresolved ref as a class while comparing definitions", () => {
    // `N` refers to a definition that does not exist and whose name is the
    // text a class could be spelled as; `M` refers to a definition that does.
    // The two mean different things and must stay apart.
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: {
        m: { $ref: "#/$defs/__cfc_hoisted_0_M" },
        n: { $ref: "#/$defs/__cfc_hoisted_1_N" },
      },
      $defs: {
        A: { type: "string" },
        __cfc_hoisted_0_M: {
          type: "object",
          properties: { x: { $ref: "#/$defs/A" } },
        },
        __cfc_hoisted_1_N: {
          type: "object",
          properties: { x: { $ref: "#/$defs/class 0" } },
        },
      },
    }) as JSONSchemaObj;
    expect(Object.keys(canonical.$defs!).toSorted()).toEqual([
      "A",
      "__cfc_hoisted_0_M",
      "__cfc_hoisted_1_N",
    ]);
    expect((canonical.properties as Record<string, JSONSchemaObj>).n).toEqual({
      $ref: "#/$defs/__cfc_hoisted_1_N",
    });
  });

  it("folds only once the partition is stable, whatever inert maps the definitions carry", () => {
    // Minted C, D and F; B and F look alike until the C/D distinction has
    // propagated to them, and the inert maps the bodies carry (in this
    // order) must not take part in the comparison.
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { value: { $ref: "#/$defs/__cfc_hoisted_3_F" } },
      $defs: {
        A: {},
        B: {
          type: "object",
          ifc: { confidentiality: [] },
          properties: { next: { $ref: "#/$defs/__cfc_hoisted_1_D" } },
          $defs: { B: { type: "number" }, A: { type: "string" } },
        },
        __cfc_hoisted_0_C: {
          type: "object",
          ifc: { confidentiality: [{ type: "https://example.com/Secret" }] },
          properties: { next: { $ref: "#/$defs/__cfc_hoisted_1_D" } },
          $defs: { A: { type: "string" } },
        },
        __cfc_hoisted_1_D: {
          type: "object",
          ifc: { confidentiality: [{ type: "https://example.com/Secret" }] },
          properties: { next: { $ref: "#/$defs/B" } },
          $defs: { A: { type: "string" } },
        },
        __cfc_hoisted_3_F: {
          type: "object",
          ifc: { confidentiality: [] },
          properties: { next: { $ref: "#/$defs/__cfc_hoisted_0_C" } },
          $defs: { A: { type: "string" }, B: { type: "number" } },
        },
      },
    };
    expect(validateSchemaDefinition(schema)).toBeUndefined();
    const canonical = canonicalizeCfcSchemaDocument(schema);
    expect(cfcSchemaPoliciesEqual(schema, canonical)).toBe(true);
    const merged = mergeCfcSchemaEnvelopes(schema, schema);
    expect(validateSchemaDefinition(merged)).toBeUndefined();
    expect(cfcSchemaPoliciesEqual(schema, merged)).toBe(true);
  });

  it("keeps an unresolved reference unresolved through the merge", () => {
    const schema: JSONSchemaObj = {
      type: "object",
      properties: { bad: { $ref: "#/$defs/__cfc_hoisted_0_C" } },
      $defs: {
        A: { type: "string" },
        B: { $ref: "#/$defs/A" },
        __cfc_hoisted_0_C: { $ref: "#/$defs/class 0" },
      },
    };
    expect(validateSchemaDefinition(schema)).toContain("cannot resolve");
    expect(validateSchemaDefinition(mergeCfcSchemaEnvelopes(schema, schema)))
      .toContain("cannot resolve");
  });

  it("drops a nested map, which is inert under the root's whatever it holds", () => {
    const canonical = canonicalizeCfcSchemaDocument({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/Entry", $defs: { Entry: { type: "number" } } },
      },
      $defs: { Entry: { type: "string" } },
    }) as JSONSchemaObj;
    expect(canonical).toEqual({
      type: "object",
      properties: { a: { $ref: "#/$defs/Entry" } },
      $defs: { Entry: { type: "string" } },
    });
  });
});

describe("mergeCfcSchemaEnvelopes with definitions that refer to each other", () => {
  // Three definitions in a chain, the first carrying a policy: a candidate
  // whose policy differs is resolved before the merge, so its bodies arrive
  // carrying its own definition map, and the hoist renames the candidate's
  // names. The map a body carries is renamed with it, so the merged document
  // canonicalizes to the three definitions it has, however often it merges.
  const envelope = (round: number): JSONSchemaObj => ({
    type: "object",
    properties: {
      a: { $ref: "#/$defs/A" },
      b: { $ref: "#/$defs/B" },
      c: { $ref: "#/$defs/C" },
    },
    $defs: {
      A: {
        type: "object",
        properties: {
          s: {
            type: "string",
            ifc: {
              confidentiality: Array.from(
                { length: round + 1 },
                (_, index) => `c${index}`,
              ),
            },
          },
          link: { $ref: "#/$defs/B" },
        },
      },
      B: {
        type: "object",
        properties: { n: { type: "number" }, deeper: { $ref: "#/$defs/C" } },
      },
      C: { type: "object", properties: { z: { type: "boolean" } } },
    },
  });

  it("keeps the map a resolved body carries consistent with the root map", () => {
    let merged: JSONSchema = envelope(0);
    const sizes: number[] = [];
    for (let round = 1; round <= 6; round++) {
      merged = mergeCfcSchemaEnvelopes(merged, envelope(round));
      sizes.push(JSON.stringify(merged).length);
    }
    const root = merged as JSONSchemaObj;
    expect(Object.keys(root.$defs ?? {}).toSorted()).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(merged).includes("__cfc_hoisted")).toBe(false);
    expect(sizes[5] - sizes[2]).toBeLessThan(40);
  });
});
