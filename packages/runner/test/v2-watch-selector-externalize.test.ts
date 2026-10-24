import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { JSONSchemaObj } from "@commonfabric/api";
import { getContainersHashedForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";

import { decomposeSchema } from "../src/schema-decompose.ts";
import {
  acquireSchemaRegistryLease,
  registerSchemaDocument,
} from "../src/schema-registry.ts";
import { externalizeSchema } from "../src/link-utils.ts";
import {
  resetContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "../src/schema-doc-config.ts";
import {
  externalizeSyncSelector,
  normalizeSyncSelector,
  SelectorClosureUnavailableError,
} from "../src/storage/v2-watch.ts";

describe("v2-watch", () => {
  describe("externalizeSyncSelector()", () => {
    afterEach(() => {
      resetContentAddressedSchemasConfig();
    });

    const schema: JSONSchemaObj = {
      type: "object",
      properties: { externalizedField: { $ref: "#/$defs/ExternalizedLeaf" } },
      $defs: {
        ExternalizedLeaf: {
          type: "object",
          properties: { leafField: { type: "string" } },
        },
      },
    };

    it("returns the selector unchanged with the flag off", () => {
      setContentAddressedSchemasConfig(false);
      const selector = { path: [], schema } as const;
      expect(externalizeSyncSelector(selector, () => true)).toBe(selector);
    });

    it("emits a reference when the whole closure is persisted", () => {
      setContentAddressedSchemasConfig(true);
      const decomposed = decomposeSchema(schema);
      const persisted = new Set(decomposed.documents.keys());
      const externalized = externalizeSyncSelector(
        { path: [], schema },
        (hash) => persisted.has(hash),
      );
      expect(externalized.schema).toEqual({ $ref: decomposed.rootRef });
      expect(externalized.path).toEqual([]);
    });

    it("falls back to the inline form when any closure document is absent", () => {
      setContentAddressedSchemasConfig(true);
      const decomposed = decomposeSchema(schema);
      const [first] = decomposed.documents.keys();
      const selector = { path: [], schema } as const;
      expect(
        externalizeSyncSelector(selector, (hash) => hash !== first),
      ).toBe(selector);
    });

    it("leaves boolean selectors alone", () => {
      setContentAddressedSchemasConfig(true);
      const permissive = { path: [], schema: true } as const;
      expect(externalizeSyncSelector(permissive, () => true)).toBe(permissive);
    });

    it("keeps the reference form while its closure is persisted", () => {
      setContentAddressedSchemasConfig(true);
      const doc: JSONSchemaObj = {
        type: "string",
        title: "already-referenced",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const referenced = { path: [], schema: { $ref: `cid:${hash}` } };
      const emitted = externalizeSyncSelector(referenced, () => true);
      expect(emitted.schema).toEqual({ $ref: `cid:${hash}` });
    });

    it("recomposes a ref-bearing schema inline when the space lacks its closure", () => {
      // Unconditional correctness, not flag preference: a reference the
      // target space cannot resolve must not reach the wire — the server
      // answers it loudly — so the schema inlines through the registry.
      setContentAddressedSchemasConfig(true);
      const doc: JSONSchemaObj = {
        type: "string",
        title: "inline-me-back",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const referenced = { path: [], schema: { $ref: `cid:${hash}` } };
      const emitted = externalizeSyncSelector(referenced, () => false);
      expect(emitted.schema).toEqual(doc);
    });

    it("inlines a ref-bearing schema even with the flag off", () => {
      setContentAddressedSchemasConfig(false);
      const doc: JSONSchemaObj = {
        type: "string",
        title: "vintage-client-inline",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const referenced = { path: [], schema: { $ref: `cid:${hash}` } };
      const emitted = externalizeSyncSelector(referenced, () => true);
      expect(emitted.schema).toEqual(doc);
    });

    it("returns one selector, hashing nothing, for each later call over a persisted closure", () => {
      // A sync externalizes its selector every time it is asked for, and a
      // reference built per call is hashed per call to intern it.
      setContentAddressedSchemasConfig(true);
      const selector = normalizeSyncSelector({
        path: ["value"],
        schema: {
          type: "object",
          title: "persisted-again",
          properties: { leaf: { $ref: "#/$defs/Leaf" } },
          $defs: { Leaf: { type: "string" } },
        },
      });
      const first = externalizeSyncSelector(selector, () => true);
      expect(first.schema).toEqual({
        $ref: decomposeSchema(selector.schema as JSONSchemaObj).rootRef,
      });
      const hashedBefore = getContainersHashedForTestingOnly();
      for (let sync = 0; sync < 10; sync++) {
        expect(externalizeSyncSelector(selector, () => true)).toBe(first);
      }
      expect(getContainersHashedForTestingOnly()).toBe(hashedBefore);
    });

    it("returns one selector, hashing nothing, for each later call that recomposes inline", () => {
      // A schema carrying a reference the space lacks goes out inline, and
      // an inline form recomposed per call is hashed whole per call.
      setContentAddressedSchemasConfig(true);
      const doc: JSONSchemaObj = {
        type: "object",
        title: "inline-me-back-again",
        properties: { leaf: { type: "string" } },
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const selector = normalizeSyncSelector({
        path: ["value"],
        schema: {
          type: "object",
          properties: { linked: { $ref: `cid:${hash}` } },
        },
      });
      const first = externalizeSyncSelector(selector, () => false);
      // Recomposition names a document reached by a bare reference after
      // its hash.
      const name = `def_${hash.slice(hash.indexOf(":") + 1).slice(0, 8)}`;
      expect(first.schema).toEqual({
        type: "object",
        properties: { linked: { $ref: `#/$defs/${name}` } },
        $defs: { [name]: doc },
      });
      const hashedBefore = getContainersHashedForTestingOnly();
      for (let sync = 0; sync < 10; sync++) {
        expect(externalizeSyncSelector(selector, () => false)).toBe(first);
      }
      expect(getContainersHashedForTestingOnly()).toBe(hashedBefore);
    });

    it("recomposes inline again once the closure it was persisted under is gone", () => {
      // What a selector externalizes to is decided per call by what the
      // space persists then, whatever an earlier call returned.
      setContentAddressedSchemasConfig(true);
      const doc: JSONSchemaObj = {
        type: "string",
        title: "persisted-then-not",
      };
      const hash = internSchemaAsTaggedHashString(doc);
      registerSchemaDocument(hash, doc);
      const selector = normalizeSyncSelector({
        path: [],
        schema: { $ref: `cid:${hash}` },
      });
      expect(externalizeSyncSelector(selector, () => true).schema).toEqual({
        $ref: `cid:${hash}`,
      });
      expect(externalizeSyncSelector(selector, () => false).schema).toEqual(
        doc,
      );
      expect(externalizeSyncSelector(selector, () => true).schema).toEqual({
        $ref: `cid:${hash}`,
      });
    });

    it("builds a persisted closure's reference again once the registry has cleared", () => {
      // The forms kept for a decomposition are externalized forms, and every
      // retainer of those drops them when the registry clears.
      setContentAddressedSchemasConfig(true);
      const release = acquireSchemaRegistryLease();
      const selector = normalizeSyncSelector({
        path: ["value"],
        schema: {
          type: "object",
          title: "kept-until-clear",
          properties: { leaf: { type: "string" } },
        },
      });
      const first = externalizeSyncSelector(selector, () => true);
      release();

      const hashedBefore = getContainersHashedForTestingOnly();
      expect(externalizeSyncSelector(selector, () => true)).toBe(first);
      // One container: the reference, built and interned anew.
      expect(getContainersHashedForTestingOnly() - hashedBefore).toBe(1);
    });

    it("propagates a failing persistence probe instead of reading it as a refusal", () => {
      setContentAddressedSchemasConfig(true);
      expect(() =>
        externalizeSyncSelector({ path: [], schema }, () => {
          throw new Error("synthetic persistence probe failure");
        })
      ).toThrow("synthetic persistence probe failure");
    });

    it("keeps a selector whose decomposition refuses inline", () => {
      setContentAddressedSchemasConfig(true);
      const refused = {
        path: [],
        schema: {
          type: "object",
          properties: {
            nested: { type: "object", $defs: { Inner: { type: "string" } } },
          },
        },
      } as const;
      expect(externalizeSyncSelector(refused as never, () => true)).toBe(
        refused as never,
      );
    });

    it("passes a structurally refused schema through when its references are persisted", () => {
      // Decomposition refuses structural constructs — here an `$anchor` —
      // and that refusal says nothing about the `cid:` refs the schema
      // carries. What decides emittability is the server's store: with
      // every reference confirmed persisted in the target space, the
      // selector goes to the wire as given and the server can answer it.
      setContentAddressedSchemasConfig(true);
      const release = acquireSchemaRegistryLease();
      try {
        const refForm = externalizeSchema({
          type: "object",
          properties: { label: { type: "string" } },
        }) as JSONSchemaObj;
        expect(typeof refForm.$ref).toBe("string");
        const refused = {
          path: [],
          schema: {
            type: "object",
            properties: {
              linked: refForm,
              anchored: { $anchor: "a", type: "string" },
            },
          },
        } as const;
        expect(externalizeSyncSelector(refused as never, () => true)).toBe(
          refused as never,
        );
      } finally {
        release();
      }
    });

    it("throws for a structurally refused schema whose references are only local", () => {
      // The nuance the pass-through above must not blur: the server
      // validates a selector reference against what the target space
      // persists, so a document the local registry resolves but the space
      // does not hold backs nothing on the wire. Recomposing inline is
      // ruled out by the same structural refusal, so the selector is
      // unemittable and the throw says which references are unconfirmed.
      setContentAddressedSchemasConfig(true);
      const release = acquireSchemaRegistryLease();
      try {
        const refForm = externalizeSchema({
          type: "object",
          properties: { label: { type: "string" } },
        }) as JSONSchemaObj;
        expect(typeof refForm.$ref).toBe("string");
        const refused = {
          path: [],
          schema: {
            type: "object",
            properties: {
              linked: refForm,
              anchored: { $anchor: "a", type: "string" },
            },
          },
        } as const;
        expect(() => externalizeSyncSelector(refused as never, () => false))
          .toThrow(SelectorClosureUnavailableError);
      } finally {
        release();
      }
    });

    it("throws rather than emitting a reference the registry cannot back", () => {
      // The client's send-only-what-you-can-back obligation, enforced at
      // the emission gate: forwarding the ref would only move this failure
      // to the server's loud refusal, one round trip later. A reference
      // with no registered document reaches here only through a retainer
      // that outlived its registry epoch, or from another process without
      // its closure — an invariant violation to surface at its source.
      setContentAddressedSchemasConfig(true);
      const orphanRef = {
        path: [],
        schema: {
          $ref: "cid:fid1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      };
      expect(() => externalizeSyncSelector(orphanRef, () => false)).toThrow(
        SelectorClosureUnavailableError,
      );
    });

    it("throws for a minted reference carried across a registry lease epoch", () => {
      // The invariant made loud: a reference dies with the epoch whose
      // registry backs it, so every retainer of externalized forms must
      // drop them on the registry clear (the wish sidecar pattern caches
      // do exactly that). A ref-form schema that nonetheless crosses the
      // clear reaches this gate unresolvable, and emitting it would only
      // move the failure to the server — the throw names the retainer bug
      // at its source instead.
      setContentAddressedSchemasConfig(true);
      const release = acquireSchemaRegistryLease();
      const inline: JSONSchemaObj = {
        type: "array",
        items: { type: "object", properties: { label: { type: "string" } } },
      };
      const refForm = externalizeSchema(inline) as JSONSchemaObj;
      expect(typeof refForm.$ref).toBe("string");
      release();

      expect(() =>
        externalizeSyncSelector({ path: [], schema: refForm }, () => false)
      ).toThrow(SelectorClosureUnavailableError);
    });
  });
});
