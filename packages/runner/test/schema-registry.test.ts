import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
import {
  internSchema,
  internSchemaAsTaggedHashString,
} from "@commonfabric/data-model-schema";
import {
  containsExternalSchemaRef,
  parseExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  acquireSchemaRegistryLease,
  isSchemaDocumentClosureComplete,
  lookupSchemaDocument,
  registerSchemaDocument,
  SchemaDocumentHashMismatchError,
} from "../src/schema-registry.ts";
import { getLogger } from "@commonfabric/utils/logger";
import {
  type DecomposedSchema,
  decomposeSchema,
} from "../src/schema-decompose.ts";
import { resolveSchema, schemaHasIfc } from "../src/schema.ts";
import { ContextualFlowControl } from "../src/cfc.ts";
import { resolveSchemaRefsCanonical } from "../src/traverse.ts";

/** Registers every document of a decomposition. */
const registerAll = (decomposed: DecomposedSchema): void => {
  for (const [hash, document] of decomposed.documents) {
    registerSchemaDocument(hash, document);
  }
};

describe("schema-registry", () => {
  describe("registerSchemaDocument()", () => {
    it("returns the interned schema and makes it retrievable by hash", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { registered: { type: "string" } },
      };
      const hash = internSchemaAsTaggedHashString(schema);
      const interned = registerSchemaDocument(hash, schema);
      expect(interned).toEqual(schema);
      expect(lookupSchemaDocument(hash)).toBe(interned);
    });

    it("is idempotent for the same hash", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { idempotent: { type: "number" } },
      };
      const hash = internSchemaAsTaggedHashString(schema);
      const first = registerSchemaDocument(hash, schema);
      expect(registerSchemaDocument(hash, { ...schema })).toBe(first);
    });

    it("throws for content that does not hash to the claimed id, and registers nothing", () => {
      const claimed = internSchemaAsTaggedHashString({
        type: "number",
        title: "forgery target",
      });
      expect(() =>
        registerSchemaDocument(claimed, {
          type: "string",
          title: "forged content",
        })
      ).toThrow(SchemaDocumentHashMismatchError);
      expect(lookupSchemaDocument(claimed)).toBeUndefined();
    });

    it("throws for mismatched content even when the hash already holds the correct document", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { occupied: { type: "boolean" } },
      };
      const hash = internSchemaAsTaggedHashString(schema);
      registerSchemaDocument(hash, schema);
      expect(() =>
        registerSchemaDocument(hash, { type: "string", title: "late forgery" })
      ).toThrow(SchemaDocumentHashMismatchError);
      expect(lookupSchemaDocument(hash)).toEqual(schema);
    });
  });

  describe("lookupSchemaDocument()", () => {
    it("returns `undefined` for a hash nothing registered", () => {
      expect(lookupSchemaDocument("fid1:never-registered")).toBeUndefined();
    });
  });

  describe("acquireSchemaRegistryLease()", () => {
    it("clears the registry when the last lease releases, and not before", () => {
      const releaseA = acquireSchemaRegistryLease();
      const releaseB = acquireSchemaRegistryLease();
      const schema: JSONSchema = {
        type: "object",
        properties: { leased: { type: "string" } },
      };
      const hash = internSchemaAsTaggedHashString(schema);
      registerSchemaDocument(hash, schema);

      releaseA();
      expect(lookupSchemaDocument(hash)).toBeDefined();
      releaseB();
      expect(lookupSchemaDocument(hash)).toBeUndefined();
    });

    it("counts a release once, however many times it is called", () => {
      const releaseA = acquireSchemaRegistryLease();
      const releaseB = acquireSchemaRegistryLease();
      const schema: JSONSchema = {
        type: "object",
        properties: { leasedTwice: { type: "string" } },
      };
      const hash = internSchemaAsTaggedHashString(schema);
      registerSchemaDocument(hash, schema);

      releaseA();
      releaseA();
      expect(lookupSchemaDocument(hash)).toBeDefined();
      releaseB();
      expect(lookupSchemaDocument(hash)).toBeUndefined();
    });

    it("stops resolving through caches warmed in an earlier lease epoch", () => {
      const release = acquireSchemaRegistryLease();
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { epochBound: { $ref: "#/$defs/EpochChild" } },
        $defs: {
          EpochChild: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
      };
      const decomposed = decomposeSchema(schema);
      registerAll(decomposed);
      const refSchema = internSchema({
        $ref: decomposed.rootRef,
      }) as JSONSchemaObj;

      // Warm every identity-keyed cache with successes.
      expect(resolveSchema(refSchema)).not.toBe(false);
      expect(resolveSchemaRefsCanonical(refSchema)).toBeDefined();
      expect(schemaHasIfc(refSchema)).toBe(true);

      release();

      // The epoch ended: the same frozen schema fails closed everywhere. A
      // cache surviving the clear would keep resolving here.
      expect(lookupSchemaDocument(
        parseExternalSchemaRef(decomposed.rootRef)!.taggedHash,
      )).toBeUndefined();
      expect(resolveSchema(refSchema)).toBe(false);
      expect(resolveSchemaRefsCanonical(refSchema)).toBeUndefined();
      expect(schemaHasIfc(refSchema)).toBe(false);

      // And the next epoch recovers on arrival, as always.
      registerAll(decomposed);
      expect(resolveSchema(refSchema)).not.toBe(false);
      expect(schemaHasIfc(refSchema)).toBe(true);
    });

    it("retains lease-less registrations until the next last-lease-out transition", () => {
      // The memory server's shape: registration with no lease held.
      const schema: JSONSchema = {
        type: "object",
        properties: { leaseless: { type: "string" } },
      };
      const hash = internSchemaAsTaggedHashString(schema);
      registerSchemaDocument(hash, schema);
      expect(lookupSchemaDocument(hash)).toBeDefined();

      const release = acquireSchemaRegistryLease();
      release();
      expect(lookupSchemaDocument(hash)).toBeUndefined();
    });
  });

  describe("resolution through the registry", () => {
    it("resolves a bare external ref to the registered document", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: {
          home: { $ref: "#/$defs/BareAddress" },
        },
        $defs: {
          BareAddress: {
            type: "object",
            properties: { bareStreet: { type: "string" } },
          },
        },
      };
      const decomposed = decomposeSchema(schema);
      registerAll(decomposed);
      const resolved = resolveSchema({ $ref: decomposed.rootRef });
      // The root document resolves shallowly: its property refs stay
      // external, dereferenced later when traversal visits them.
      expect(resolved).toEqual({
        type: "object",
        properties: {
          home: {
            $ref: `cid:${
              internSchemaAsTaggedHashString({
                type: "object",
                properties: { bareStreet: { type: "string" } },
              })
            }`,
          },
        },
      });
    });

    it("resolves a fragment ref to a member view whose refs into the group are external", () => {
      const schema: JSONSchemaObj = {
        $ref: "#/$defs/FragFolder",
        $defs: {
          FragFolder: {
            type: "object",
            properties: {
              children: {
                type: "array",
                items: { $ref: "#/$defs/FragEntry" },
              },
            },
          },
          FragEntry: {
            anyOf: [{ type: "string" }, { $ref: "#/$defs/FragFolder" }],
          },
        },
      };
      const decomposed = decomposeSchema(schema);
      registerAll(decomposed);
      const groupHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
      const memberRef = (name: string) => `cid:${groupHash}#/$defs/${name}`;
      const resolved = resolveSchema({
        $ref: decomposed.rootRef,
      }) as JSONSchemaObj;
      expect(resolved.type).toBe("object");
      // The view carries no `$defs`: its refs into the group name the group
      // document, so they resolve wherever the view is later embedded...
      expect(resolved.$defs).toBeUndefined();
      const items = (resolved.properties!.children as JSONSchemaObj)
        .items as JSONSchemaObj;
      expect(items).toEqual({ $ref: memberRef("FragEntry") });
      // ...and a ref inside the view resolves through the registry.
      const entry = ContextualFlowControl.resolveSchemaRefs(
        items,
        resolved,
      ) as JSONSchemaObj;
      expect(entry.anyOf).toEqual([
        { type: "string" },
        { $ref: memberRef("FragFolder") },
      ]);
    });

    it("follows a local ref whose definition body is an external ref", () => {
      const inner: JSONSchemaObj = {
        type: "object",
        properties: { chainedLeaf: { type: "string" } },
      };
      const innerHash = internSchemaAsTaggedHashString(inner);
      registerSchemaDocument(innerHash, inner);
      const outer: JSONSchemaObj = {
        type: "object",
        properties: { x: { type: "number" } },
        $defs: { Chained: { $ref: `cid:${innerHash}` } },
      };
      const resolved = ContextualFlowControl.resolveSchemaRefs(
        { $ref: "#/$defs/Chained" },
        outer,
      );
      expect(resolved).toEqual(inner);
    });

    it("throws from the OrThrow resolver for an unregistered document — a delivery-guarantee violation is loud", () => {
      // The read-side delivery guarantee says a document arrives WITH the
      // schema documents its embedded refs need. An unresolvable external
      // ref on an OrThrow path therefore signals a consistency bug in
      // delivery, not a state to tolerate quietly.
      const orphanRef = `cid:${
        internSchemaAsTaggedHashString({
          type: "object",
          properties: { orThrowOrphan: { type: "string" } },
        })
      }`;
      expect(() =>
        ContextualFlowControl.resolveSchemaRefsOrThrow({ $ref: orphanRef })
      ).toThrow("Failed to resolve");
      expect(() =>
        ContextualFlowControl.resolveSchemaRefsOrThrow(
          { $ref: "#/$defs/NoSuchDef" },
          { type: "object" },
        )
      ).toThrow("Failed to resolve");
    });

    it("returns `false` from resolveSchema() for an unregistered document", () => {
      const orphanRef = `cid:${
        internSchemaAsTaggedHashString({
          type: "object",
          properties: { neverRegistered: { type: "string" } },
        })
      }`;
      expect(resolveSchema({ $ref: orphanRef })).toBe(false);
    });

    it("treats a registered document with an unregistered child as a miss until the closure completes", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { gated: { $ref: "#/$defs/GatedSecret" } },
        $defs: {
          GatedSecret: {
            type: "string",
            ifc: { confidentiality: ["secret"] },
          },
        },
      };
      const decomposed = decomposeSchema(schema);
      const rootHash = parseExternalSchemaRef(decomposed.rootRef)!.taggedHash;
      registerSchemaDocument(rootHash, decomposed.documents.get(rootHash)!);

      const refSchema = internSchema({
        $ref: decomposed.rootRef,
      }) as JSONSchemaObj;
      // The root document alone must not resolve: a derived result (the IFC
      // scan below) computed over the closure's hole would be memoized by
      // the root's stable identity and never invalidated.
      expect(resolveSchema(refSchema)).toBe(false);
      expect(schemaHasIfc(refSchema)).toBe(false);

      registerAll(decomposed);

      // The same frozen schema now resolves, and the IFC scan sees the
      // child's label — a memoized pre-arrival verdict would return `false`
      // here forever.
      expect(resolveSchema(refSchema)).not.toBe(false);
      expect(schemaHasIfc(refSchema)).toBe(true);
    });

    it("returns `false` for a fragment ref into a document whose `$defs` is an array", () => {
      const document = {
        $defs: [{ type: "string" }],
      } as unknown as JSONSchema;
      const hash = internSchemaAsTaggedHashString(document);
      registerSchemaDocument(hash, document);
      expect(resolveSchema({ $ref: `cid:${hash}#/$defs/0` })).toBe(false);
    });

    it("resolves after the document arrives, through the same frozen ref schema", () => {
      const schema: JSONSchemaObj = {
        type: "object",
        properties: { arrival: { $ref: "#/$defs/LateDoc" } },
        $defs: {
          LateDoc: {
            type: "object",
            properties: { lateMarker: { type: "number" } },
          },
        },
      };
      const decomposed = decomposeSchema(schema);
      const refSchema = internSchema({
        $ref: decomposed.rootRef,
      }) as JSONSchemaObj;

      // Two failed resolutions through every cache layer, then the
      // documents arrive, then the SAME schema object resolves. A memoized
      // miss anywhere pins the first `false` forever and fails this test.
      expect(resolveSchema(refSchema)).toBe(false);
      expect(resolveSchemaRefsCanonical(refSchema)).toBeUndefined();
      expect(resolveSchema(refSchema)).toBe(false);

      registerAll(decomposed);

      const resolved = resolveSchema(refSchema) as JSONSchemaObj;
      expect(resolved.type).toBe("object");
      expect(Object.keys(resolved.properties!)).toEqual(["arrival"]);
      expect(resolveSchemaRefsCanonical(refSchema)).toBe(resolved);
    });
  });

  describe("containsExternalSchemaRef()", () => {
    it("returns `true` for an external ref at the root, in a subschema, and inside `$defs`", () => {
      expect(containsExternalSchemaRef({ $ref: "cid:fid1:abc" })).toBe(true);
      expect(containsExternalSchemaRef({
        type: "object",
        properties: { x: { $ref: "cid:fid1:abc" } },
      })).toBe(true);
      expect(containsExternalSchemaRef({
        type: "object",
        $defs: { T: { $ref: "cid:fid1:abc" } },
      })).toBe(true);
    });

    it("returns `false` for local refs and for boolean schemas", () => {
      expect(containsExternalSchemaRef({
        type: "object",
        properties: { x: { $ref: "#/$defs/T" } },
        $defs: { T: { type: "string" } },
      })).toBe(false);
      expect(containsExternalSchemaRef(true)).toBe(false);
      expect(containsExternalSchemaRef(undefined)).toBe(false);
    });
  });

  describe("closure walks and fragment views", () => {
    it("confirms a diamond closure, meeting the shared dependency once", () => {
      const shared: JSONSchema = { type: "string", title: "diamond-shared" };
      const sharedHash = internSchemaAsTaggedHashString(shared);
      const left: JSONSchema = {
        type: "object",
        properties: { l: { $ref: `cid:${sharedHash}` } },
      };
      const leftHash = internSchemaAsTaggedHashString(left);
      const right: JSONSchema = {
        type: "object",
        properties: { r: { $ref: `cid:${sharedHash}` } },
      };
      const rightHash = internSchemaAsTaggedHashString(right);
      const root: JSONSchema = {
        type: "object",
        properties: {
          a: { $ref: `cid:${leftHash}` },
          b: { $ref: `cid:${rightHash}` },
        },
      };
      const rootHash = internSchemaAsTaggedHashString(root);
      registerSchemaDocument(sharedHash, shared);
      registerSchemaDocument(leftHash, left);
      registerSchemaDocument(rightHash, right);
      registerSchemaDocument(rootHash, root);
      expect(isSchemaDocumentClosureComplete(rootHash)).toBe(true);
    });

    it("logs the miss for an unregistered document and an incomplete closure", () => {
      const cfcLogger = getLogger("cfc");
      const previousLevel = cfcLogger.level;
      cfcLogger.level = "debug";
      try {
        const absent = internSchemaAsTaggedHashString({
          type: "string",
          title: "never-registered-log",
        });
        expect(resolveSchema({ $ref: `cid:${absent}` })).toBe(false);

        const leaf: JSONSchema = {
          type: "string",
          title: "incomplete-log-leaf",
        };
        const leafHash = internSchemaAsTaggedHashString(leaf);
        const root: JSONSchema = {
          type: "object",
          properties: { x: { $ref: `cid:${leafHash}` } },
        };
        const rootHash = internSchemaAsTaggedHashString(root);
        registerSchemaDocument(rootHash, root);
        expect(resolveSchema({ $ref: `cid:${rootHash}` })).toBe(false);
      } finally {
        cfcLogger.level = previousLevel;
      }
    });

    it("serves a repeated fragment resolution from the member-view cache", () => {
      const group: JSONSchema = {
        $defs: { CachedMember: { type: "string", title: "member-cache" } },
      };
      const groupHash = internSchemaAsTaggedHashString(group);
      registerSchemaDocument(groupHash, group);
      const first = resolveSchema({
        $ref: `cid:${groupHash}#/$defs/CachedMember`,
      });
      const second = resolveSchema({
        $ref: `cid:${groupHash}#/$defs/CachedMember`,
        description: "a distinct referrer, the same member view",
      });
      expect(first).not.toBe(false);
      expect(second).not.toBe(false);
    });

    it("closes resolution for a fragment naming no member", () => {
      const cfcLogger = getLogger("cfc");
      const previousLevel = cfcLogger.level;
      cfcLogger.level = "debug";
      try {
        const group: JSONSchema = {
          $defs: { OnlyMember: { type: "string", title: "only-member" } },
        };
        const groupHash = internSchemaAsTaggedHashString(group);
        registerSchemaDocument(groupHash, group);
        expect(resolveSchema({ $ref: `cid:${groupHash}#/$defs/AbsentMember` }))
          .toBe(false);
      } finally {
        cfcLogger.level = previousLevel;
      }
    });

    it("resolves a boolean member of a schema-document group", () => {
      const group: JSONSchema = {
        $defs: {
          AlwaysTrue: true,
          BooleanAnchor: { type: "string", title: "boolean-member-anchor" },
        },
      };
      const groupHash = internSchemaAsTaggedHashString(group);
      registerSchemaDocument(groupHash, group);
      // A `true` member view resolves as the unconstrained schema, and
      // `resolveSchema` returns it as `true`: a schema that admits every
      // value, distinct from `undefined`, which says no schema was given, and
      // from the `false` that closes resolution.
      expect(resolveSchema({ $ref: `cid:${groupHash}#/$defs/AlwaysTrue` }))
        .toBe(true);
    });
  });
});
