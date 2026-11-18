/**
 * Checks stored-argument validation and its fallback with real storage graphs.
 * Direct overlay cases supply cyclic snapshots that eager reads reject before
 * the fallback can exercise its own termination and cache guards.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";
import { validateSchemaValue } from "../src/cfc/schema-sanitization.ts";
import {
  extractDefaultValues,
  mergeSchemaDefaults,
} from "../src/runner-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  acceptsOpaqueCellOrUnresolvedLink,
  materializeStagedArgumentForValidation,
  materializeStoredValueForValidation,
  overlayUnreadableLinkPlaceholders,
  storedArgumentValidationIssue,
} from "../src/stored-argument-validation.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

/** Materialized snapshot whose cycle remains observable by identity. */
interface MaterializedNode {
  /** Linked value that materialization could not read. */
  pending: unknown;

  /** Optional back edge through the materialized graph. */
  next?: MaterializedNode;
}

const signer = await Identity.fromPassphrase("stored-argument-validation");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("stored-argument-elsewhere"))
  .did();

/**
 * Spies on both of `tx`'s reads, the one that returns a failure and the one
 * that throws it, until disposed.
 */
function spyReads(tx: IExtendedStorageTransaction): {
  /** The address of every read made so far. */
  addresses(): IMemorySpaceAddress[];
  [Symbol.dispose](): void;
} {
  const read = spy(tx, "read");
  const readOrThrow = spy(tx, "readOrThrow");
  return {
    addresses: () =>
      [...read.calls, ...readOrThrow.calls].map((call) => call.args[0]),
    [Symbol.dispose]() {
      read.restore();
      readOrThrow.restore();
    },
  };
}

describe("stored-argument-validation", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  it("defers unreadable leaves in a shared graph with work proportional to its nodes", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      let next = runtime.getCell(space, "leaf", undefined, tx);
      next.set({ pending: absent });
      const graphIds = new Set([next.getAsNormalizedFullLink().id]);
      for (let depth = 0; depth < 12; depth++) {
        const node = runtime.getCell(space, `node-${depth}`, undefined, tx);
        node.set({ left: next, right: next, pending: absent });
        graphIds.add(node.getAsNormalizedFullLink().id);
        next = node;
      }
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ graph: next });
      const schema: JSONSchema = {
        type: "object",
        properties: { graph: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: {
              left: { $ref: "#/$defs/Node" },
              right: { $ref: "#/$defs/Node" },
              pending: { type: "string" },
            },
            required: ["pending"],
          },
        },
      };
      const before = argument.getRaw();
      using reads = spyReads(tx);
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      const graphReads = reads.addresses().filter((address) =>
        graphIds.has(address.id)
      )
        .length;
      expect(graphReads).toBeGreaterThan(0);
      expect(graphReads).toBeLessThan(100 * graphIds.size);
      expect(argument.getRaw()).toEqual(before);
    } finally {
      tx.abort();
    }
  });

  it("validates a shared cyclic graph with work proportional to its nodes", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const nodes = Array.from(
        { length: 13 },
        (_, i) => runtime.getCell(space, `shared-cycle-${i}`, undefined, tx),
      );
      const snapshots: Record<string, unknown>[] = nodes.map(() => ({
        pending: undefined,
      }));
      for (let i = 0; i < nodes.length; i++) {
        const next = (i + 1) % nodes.length;
        nodes[i].set({
          pending: absent,
          left: nodes[next],
          right: nodes[next],
        });
        snapshots[i].left = snapshots[next];
        snapshots[i].right = snapshots[next];
      }
      for (const snapshot of snapshots) Object.freeze(snapshot);
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ graph: nodes[0] });
      const raw = argument.getRaw();
      using reads = spyReads(tx);
      const result = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        raw,
        Object.freeze({ graph: snapshots[0] }),
      ) as { graph: Record<string, unknown> };
      // A finite schema can inspect each node, leaving the back edges opaque.
      let schema: JSONSchema = true;
      for (let i = 0; i < nodes.length; i++) {
        schema = {
          type: "object",
          properties: {
            pending: { type: "string" },
            left: schema,
            right: schema,
          },
          required: ["pending"],
        };
      }
      expect(validateSchemaValue(schema, result.graph, schema, {
        acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
      })).toBeUndefined();
      expect(reads.addresses().length).toBeGreaterThan(0);
      expect(reads.addresses().length).toBeLessThan(4 * nodes.length);
      let entry = result.graph;
      for (let i = 0; i < nodes.length; i++) {
        expect(entry.pending).toBeDefined();
        expect(entry.left).toBe(entry.right);
        entry = entry.left as typeof entry;
      }
      expect(entry).toBe(result.graph);
      expect(snapshots.every((node) => node.pending === undefined)).toBe(true);
    } finally {
      tx.abort();
    }
  });

  it("leaves an unmodeled cyclic graph unread during stored argument validation", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const first = runtime.getCell(space, "ui-first", undefined, tx);
      const second = runtime.getCell(space, "ui-second", undefined, tx);
      first.set({ left: second, right: second });
      second.set({ left: first, right: first });
      const topic = runtime.getCell(space, "topic", undefined, tx);
      topic.set({ mentions: absent, $UI: first });
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ topics: [topic] });
      const schema: JSONSchema = {
        type: "object",
        properties: {
          topics: {
            type: "array",
            items: {
              type: "object",
              properties: { mentions: { type: "array" } },
              required: ["mentions"],
            },
          },
        },
      };
      const before = argument.getRaw();
      using reads = spyReads(tx);
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      expect(
        reads.addresses().some((address) =>
          address.id === second.getAsNormalizedFullLink().id
        ),
      ).toBe(false);
      expect(argument.getRaw()).toEqual(before);
    } finally {
      tx.abort();
    }
  });

  it("keeps differently defaulted views of one linked endpoint distinct", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const shared = runtime.getCell(space, "shared", undefined, tx);
      shared.set({ pending: absent });
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ left: shared, right: shared });
      const schema: JSONSchema = {
        type: "object",
        properties: Object.fromEntries(["left", "right"].map((tag) => [tag, {
          type: "object",
          properties: {
            pending: { type: "string" },
            tag: { type: "string", const: tag, default: tag },
          },
          required: ["pending", "tag"],
        }])),
        required: ["left", "right"],
      };
      const defaults = extractDefaultValues(schema);
      expect(storedArgumentValidationIssue(argument, schema, defaults, tx))
        .toBeUndefined();

      // Reusing a completed overlay must not hide a value staged by a later
      // validation, even when both validations use the same transaction.
      absent.set(42);
      expect(storedArgumentValidationIssue(argument, schema, defaults, tx))
        .toContain("pending: value does not match type string");
    } finally {
      tx.abort();
    }
  });

  it("preserves opaque Cell handles beside an unreadable linked value", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const held = runtime.getCell(space, "held", undefined, tx);
      held.set({ label: "linked value" });
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ held, pending: absent });
      const result = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        argument.getRaw(),
        { held, pending: undefined },
      ) as { held: unknown; pending: unknown };
      expect(result.held).toBe(held);
      const schema: JSONSchema = {
        type: "object",
        properties: {
          held: { type: "object", asCell: ["cell"] },
          pending: { type: "string" },
        },
        required: ["held", "pending"],
      };
      expect(validateSchemaValue(schema, result, schema, {
        acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
      })).toBeUndefined();
    } finally {
      tx.abort();
    }
  });

  it("preserves stored instances while deferring unreadable links", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const failure = FabricError.fromNativeError(new Error("stored failure"));
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ pending: absent, failure });
      const schema: JSONSchema = {
        type: "object",
        properties: { pending: { type: "string" }, failure: true },
        required: ["pending", "failure"],
      };
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();

      const raw = argument.getRaw() as { failure: unknown };
      const snapshot = Object.freeze({
        pending: undefined,
        failure: raw.failure,
      });
      const view = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        raw,
        snapshot,
      ) as { failure: unknown };
      expect(view.failure).toBe(snapshot.failure);

      const incompatible: JSONSchema = {
        ...schema,
        properties: {
          pending: { type: "string" },
          failure: { type: "string" },
        },
      };
      expect(
        storedArgumentValidationIssue(argument, incompatible, undefined, tx),
      )
        .toBe("failure: value does not match type string");
    } finally {
      tx.abort();
    }
  });

  it("hands a stored instance under an object-typed slot through whole", () => {
    // The materialized argument is a query-result view, and a view over a
    // `FabricInstance` has `Object.prototype` for its prototype, so the
    // defaults merge took one for a record and copied it: the copy threw a
    // proxy-invariant `TypeError` before any verdict while the view reported
    // the instance's freeze shield, and without that it would rebuild the
    // instance as a record, with any default inside the slot filled in. The
    // merge hands it back whole now. The untyped slot above (`failure:
    // true`) never descends, which is why that case passed all along.
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({
        pending: absent,
        err: FabricError.fromNativeError(new Error("boom")),
      });
      const view = argument.asSchema(undefined).withTx(tx).get() as {
        err: object;
      };
      const slotSchemas: JSONSchema[] = [
        { type: "object" },
        { anyOf: [{ type: "object" }, { type: "string" }] },
        {
          type: "object",
          properties: { note: { type: "string", default: "filled" } },
        },
      ];
      for (const err of slotSchemas) {
        const schema: JSONSchema = {
          type: "object",
          properties: { pending: { type: "string" }, err },
          required: ["pending"],
        };
        const merged = mergeSchemaDefaults(view, undefined, schema, {
          mergeMaterializedLinks: true,
        }) as { err: object };
        expect(merged.err).toBe(view.err);
        expect(merged.err.constructor.name).toBe("FabricError");
        // The validator judges the view as the keyless record it looks like
        // (the gap the marker in `query-result-proxy.ts` records), so the
        // verdict is the one the untyped slot gets above. Whether
        // `{ type: "object" }` should admit an instance at all is a separate
        // question.
        expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
          .toBeUndefined();
      }
      const incompatible: JSONSchema = {
        type: "object",
        properties: { pending: { type: "string" }, err: { type: "string" } },
        required: ["pending"],
      };
      expect(
        storedArgumentValidationIssue(argument, incompatible, undefined, tx),
      ).toBe("err: value does not match type string");
    } finally {
      tx.abort();
    }
  });

  it("keeps absent snapshot fields absent unless their raw value is a link", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ pending: absent, extra: 1 });
      const snapshot = Object.freeze({ pending: undefined });
      const view = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        argument.getRaw(),
        snapshot,
      );
      const schema: JSONSchema = {
        type: "object",
        properties: { pending: { type: "string" } },
        required: ["pending"],
        additionalProperties: false,
      };
      expect(Object.keys(view as object)).toEqual(["pending"]);
      expect(validateSchemaValue(schema, view, schema, {
        acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
      })).toBeUndefined();
      expect(snapshot).toEqual({ pending: undefined });
      expect(argument.getRaw()).toMatchObject({ extra: 1 });
    } finally {
      tx.abort();
    }
  });

  it("judges a link that reaches another space without reading what it reaches", async () => {
    // What another space holds is another piece's data, under labels of its
    // own, so the judgement leaves it to the reads that follow the link. The
    // same value in the argument's own space is judged in full.

    const elsewhere = runtime.getCell(otherSpace, "elsewhere", undefined);
    const write = runtime.edit();
    elsewhere.withTx(write).set({ count: "many" });
    expect((await write.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    try {
      const nearby = runtime.getCell(space, "nearby", undefined, tx);
      nearby.set({ count: "many" });
      const argument = runtime.getCell(space, "argument", undefined, tx);
      const sourceSchema: JSONSchema = {
        type: "object",
        properties: { count: { type: "number" } },
      };
      const schema: JSONSchema = {
        type: "object",
        properties: { source: sourceSchema },
      };

      argument.set({ source: elsewhere });
      using reads = spyReads(tx);
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      expect(
        reads.addresses().some((address) =>
          address.id === elsewhere.getAsNormalizedFullLink().id
        ),
      ).toBe(false);

      // A read through the link, under the slot's schema, is where its value
      // is checked: the wrong-typed field reads as absent.
      expect(argument.key("source").asSchema(sourceSchema).get())
        .toStrictEqual({});

      argument.set({ source: nearby });
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toContain("count: value does not match type number");
    } finally {
      tx.abort();
    }
  });

  it("judges a link under a union's branch without reading what it reaches in another space", async () => {
    // Only one branch of the union declares `entry`, so the schema at that
    // path, taken without choosing a branch, admits anything. The link held
    // below it is still one into another space.

    const elsewhere = runtime.getCell(otherSpace, "room", undefined);
    const write = runtime.edit();
    elsewhere.withTx(write).set({ count: 1 });
    expect((await write.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    try {
      const argument = runtime.getCell(space, "argument", undefined, tx);
      const schema: JSONSchema = {
        type: "object",
        properties: {
          outcome: {
            anyOf: [
              {
                type: "object",
                properties: { status: { enum: ["pending"] } },
                required: ["status"],
              },
              {
                type: "object",
                properties: {
                  status: { enum: ["done"] },
                  entry: {
                    type: "object",
                    properties: { room: { type: "unknown" } },
                  },
                },
                required: ["status"],
              },
            ],
          },
        },
      };

      argument.set({ outcome: { status: "done", entry: { room: elsewhere } } });
      using reads = spy(tx, "read");
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      expect(
        reads.calls.filter((call) =>
          call.args[0].id === elsewhere.getAsNormalizedFullLink().id
        ),
      ).toStrictEqual([]);
    } finally {
      tx.abort();
    }
  });

  it("refuses literal absences beside an unreadable linked value", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const argument = runtime.getCell(space, "argument", undefined, tx);
      const schema: JSONSchema = {
        type: "object",
        properties: {
          pending: { type: "string" },
          literal: { type: "string" },
        },
        required: ["pending", "literal"],
      };
      argument.set({ pending: absent, literal: undefined });
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toContain("literal: value does not match type string");
      argument.set({ pending: absent });
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toContain("missing required property literal");
    } finally {
      tx.abort();
    }
  });

  it("accepts a stored `bigint` where the argument schema declares `integer`", () => {
    // The shape a FabriChat row's argument carries: a map of places whose
    // thread roots hold a `bigint` time, declared `bigint` and so typed
    // `integer`.
    const tx = runtime.edit();
    try {
      const argument = runtime.getCell(space, "argument", undefined, tx);
      const schema: JSONSchema = {
        type: "object",
        properties: {
          places: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                replies: { type: "number" },
                latestReplyAt: { type: ["integer", "null"] },
              },
              required: ["replies"],
            },
          },
        },
        required: ["places"],
      };
      argument.set({
        places: { root: { replies: 1, latestReplyAt: 1760600000000000000n } },
      });
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      argument.set({ places: { root: { replies: 1, latestReplyAt: "soon" } } });
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toContain("latestReplyAt: value does not match type integer|null");
    } finally {
      tx.abort();
    }
  });

  it("preserves cycles and distinct stored locations without changing the snapshot", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const a = runtime.getCell(space, "cycle-a", undefined, tx);
      const b = runtime.getCell(space, "cycle-b", undefined, tx);
      a.set({ next: b, pending: absent });
      b.set({ next: a, pending: absent });
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ first: a, second: b });
      const node: MaterializedNode = { pending: undefined };
      node.next = node;
      const snapshot = { first: node, second: node };
      const result = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        argument.getRaw(),
        snapshot,
      ) as typeof snapshot;

      for (const entry of [result.first, result.second]) {
        expect(entry.pending).toBeDefined();
        expect(entry.next?.pending).toBeDefined();
        expect(entry.next?.next).toBe(entry);
      }
      expect(result.first).not.toBe(result.second);
      expect(result.first.next).toBe(result.second);
      const schema: JSONSchema = {
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: {
              pending: { type: "string" },
              next: { $ref: "#/$defs/Node" },
            },
            required: ["pending"],
          },
        },
      };
      expect(validateSchemaValue(schema, result.first, schema, {
        acceptOpaqueValue: acceptsOpaqueCellOrUnresolvedLink,
      })).toContain("recursive schema validation made no progress");
      expect(node.pending).toBeUndefined();
      expect(node.next).toBe(node);
      expect(snapshot.first).toBe(node);
      expect(snapshot.second).toBe(node);
    } finally {
      tx.abort();
    }
  });

  it("shares a cyclic view reached through an alias", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const a = runtime.getCell(space, "cycle-a", undefined, tx);
      const alias = runtime.getCell(space, "cycle-alias", undefined, tx);
      a.set({ next: alias, pending: absent });
      alias.set(a);
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ first: a, second: alias });
      const node: MaterializedNode = { pending: undefined };
      node.next = node;
      const snapshot = { first: node, second: node };
      const result = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        argument.getRaw(),
        snapshot,
      ) as typeof snapshot;

      expect(result.first.pending).toBeDefined();
      expect(result.first.next).toBe(result.first);
      expect(result.second.pending).toBeDefined();
      expect(result.second.next).toBe(result.first);
      expect(result.second).toBe(result.first);
      expect(node.pending).toBeUndefined();
      expect(snapshot.first).toBe(node);
      expect(snapshot.second).toBe(node);
    } finally {
      tx.abort();
    }
  });

  it("finds stored `FabricError`s with different messages unique under `uniqueItems`", () => {
    // The default merge hands the validator the argument read through views,
    // and a view of a `FabricInstance` has no own keys: compared as it reads,
    // every such entry equals every other.

    const tx = runtime.edit();
    try {
      const argument = runtime.getCell(space, "unique-errors", undefined, tx);
      argument.set([
        { v: FabricError.fromNativeError(new Error("AAA")) },
        { v: FabricError.fromNativeError(new Error("ZZZ")) },
      ]);
      const schema: JSONSchema = { type: "array", uniqueItems: true };

      expect(validateSchemaValue(schema, argument.getRaw())).toBeUndefined();
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
    } finally {
      tx.abort();
    }
  });

  it("matches a `const` equal to a stored argument holding a `FabricError`", () => {
    const tx = runtime.edit();
    try {
      const argument = runtime.getCell(space, "const-error", undefined, tx);
      argument.set({ v: FabricError.fromNativeError(new Error("boom")) });
      const schema = { const: argument.getRaw() } as JSONSchema;

      expect(validateSchemaValue(schema, argument.getRaw())).toBeUndefined();
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
    } finally {
      tx.abort();
    }
  });

  it("finds a view of a stored `FabricError` in an `enum` holding the stored value", () => {
    const tx = runtime.edit();
    try {
      const argument = runtime.getCell<{ v: unknown }>(
        space,
        "enum-error",
        undefined,
        tx,
      );
      argument.set(
        { v: FabricError.fromNativeError(new Error("boom")) } as never,
      );
      const stored = (argument.getRaw() as { v: unknown }).v;
      const schema = { enum: [stored] } as JSONSchema;

      expect(validateSchemaValue(schema, argument.get().v)).toBeUndefined();
    } finally {
      tx.abort();
    }
  });

  describe("a stored link in a slot typed as a handle", () => {
    // The value a handle's link reaches is judged by its top level alone:
    // its type, and its `enum` and `const` when it is not a container.

    /**
     * Returns the issue `slotSchema` finds with a slot holding a link to a
     * document in the argument's own space whose value is `reached`. The
     * argument's schema defines `#/$defs/text` as a string.
     */
    function linkedSlotIssue(
      slotSchema: JSONSchema,
      reached: unknown,
    ): string | undefined {
      const tx = runtime.edit();
      try {
        const target = runtime.getCell<unknown>(space, "target", undefined, tx);
        target.set(reached);
        const argument = runtime.getCell(space, "argument", undefined, tx);
        argument.set({ slot: target });
        const schema: JSONSchema = {
          type: "object",
          properties: { slot: slotSchema },
          $defs: { text: { type: "string" } },
        };
        return storedArgumentValidationIssue(argument, schema, undefined, tx);
      } finally {
        tx.abort();
      }
    }

    it("holds a reached primitive to the handle's `enum`", () => {
      const slot: JSONSchema = {
        type: "string",
        enum: ["red", "green"],
        asCell: ["cell"],
      };
      expect(linkedSlotIssue(slot, "red")).toBeUndefined();
      expect(linkedSlotIssue(slot, "blue")).toContain("slot:");
    });

    it("holds a reached primitive to the handle's `const`", () => {
      const slot: JSONSchema = { const: "red", asCell: ["cell"] };
      expect(linkedSlotIssue(slot, "red")).toBeUndefined();
      expect(linkedSlotIssue(slot, "blue")).toContain("slot:");
    });

    it("leaves the members of a reached container out of the judgement", () => {
      const slot: JSONSchema = {
        type: "array",
        items: { type: "string" },
        enum: [["red"]],
        asCell: ["cell"],
      };
      expect(linkedSlotIssue(slot, [1, 2])).toBeUndefined();
      expect(linkedSlotIssue(slot, "red")).toContain("slot:");
    });

    it("holds a reached value to every branch of the handle's `allOf`", () => {
      const slot: JSONSchema = {
        allOf: [true, { type: "string" }],
        asCell: ["cell"],
      };
      expect(linkedSlotIssue(slot, "red")).toBeUndefined();
      expect(linkedSlotIssue(slot, 7)).toContain("slot:");
    });

    it("holds a reached value to both the handle's `anyOf` and its `oneOf`", () => {
      const slot: JSONSchema = {
        anyOf: [{ type: "string" }, { type: "number" }],
        oneOf: [{ type: "string" }, { type: "boolean" }],
        asCell: ["cell"],
      };
      expect(linkedSlotIssue(slot, "red")).toBeUndefined();
      expect(linkedSlotIssue(slot, 7)).toContain("slot:");
      expect(linkedSlotIssue(slot, true)).toContain("slot:");
    });

    it("follows the handle's references to judge the reached value", () => {
      const missing: JSONSchema = {
        $ref: "#/$defs/missing",
        asCell: ["cell"],
      };
      expect(linkedSlotIssue(missing, 7)).toBe(
        "slot: cannot resolve schema reference #/$defs/missing",
      );

      const present: JSONSchema = { $ref: "#/$defs/text", asCell: ["cell"] };
      expect(linkedSlotIssue(present, "red")).toBeUndefined();
      expect(linkedSlotIssue(present, 7)).toContain("slot:");
    });
  });

  describe("a stored link to a document that stores a confidentiality label", () => {
    // What a labeled document holds is read under its labels, which a read
    // here would join to the transaction doing the judging, and so to what it
    // writes, such as a nested piece's result. The judgement leaves it to the
    // reads that follow the link, as it does a link to another space.

    /** The schema of an argument whose `source` holds a counter. */
    const schema: JSONSchema = {
      type: "object",
      properties: {
        source: { type: "object", properties: { count: { type: "number" } } },
      },
    };

    /**
     * Commits a document holding `value` at `cause`, labeled at its root with
     * `confidentiality` where that holds any atom, and returns its cell.
     */
    const seedDocument = async (
      cause: string,
      value: unknown,
      confidentiality: readonly string[],
    ) => {
      const tx = runtime.edit();
      const cell = runtime.getCell<unknown>(space, cause, undefined, tx);
      const id = cell.getAsNormalizedFullLink().id;
      writeSeedEnvelopeDoc(tx, space);
      seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
        value,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: confidentiality.length === 0 ? [] : [{
              path: [],
              label: { confidentiality: [...confidentiality] },
            }],
          },
        },
      } as never);
      expect((await tx.commit().settled).error).toBeUndefined();
      return cell;
    };

    it("judges the slot as holding a link and reads none of the labeled document's value", async () => {
      // TODO(danfuzz): Which way the link goes turns on whether the document
      // stores a label entry holding a confidentiality atom, which label
      // metadata keeps observable: an entry's existence and its atoms'
      // presence. If either ever becomes hidden, this outcome reveals it. See
      // the matching `TODO` at `reachesBeyondOwnData()` in
      // `stored-argument-validation.ts`.

      const sealed = await seedDocument(
        "sealed-source",
        { count: "many" },
        ["sealed"],
      );
      const plain = await seedDocument("plain-source", { count: "many" }, []);
      const tx = runtime.edit();
      try {
        const argument = runtime.getCell(space, "argument", undefined, tx);
        argument.set({ source: sealed });
        const sealedId = sealed.getAsNormalizedFullLink().id;
        using reads = spyReads(tx);
        expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
          .toBeUndefined();
        expect(
          reads.addresses().filter((address) =>
            address.id === sealedId && address.path[0] === "value"
          ),
        ).toEqual([]);

        // The same value in a document that stores no label is judged.
        argument.set({ source: plain });
        expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
          .toContain("count: value does not match type number");
      } finally {
        tx.abort();
      }
    });

    it("judges a staged query result over a labeled document as a link and reads none of its value", async () => {
      // A caller may hand the setup a query result over a cell rather than
      // the cell; the staged view takes the reference from it all the same.

      const sealed = await seedDocument(
        "sealed-query-source",
        { count: "many" },
        ["sealed"],
      );
      const tx = runtime.edit();
      try {
        const argument = runtime.getCell(space, "argument", undefined, tx);
        argument.set({ source: sealed });
        const staged = { source: sealed.withTx(tx).getAsQueryResult() };
        const sealedId = sealed.getAsNormalizedFullLink().id;
        using reads = spyReads(tx);
        expect(
          storedArgumentValidationIssue(argument, schema, undefined, tx, {
            value: staged,
            cellAt: (link) => runtime.getCellFromLink(link, undefined, tx),
          }),
        ).toBeUndefined();
        expect(
          reads.addresses().filter((address) =>
            address.id === sealedId && address.path[0] === "value"
          ),
        ).toEqual([]);
      } finally {
        tx.abort();
      }
    });
  });

  describe("an argument a setup has just staged", () => {
    // Validation given the staged value takes the argument's slots, and which
    // reference sits at each, from it, so it reads none of them back; what a
    // reference reaches it judges as reading the argument back does.

    /** The schema of an argument whose `source` holds a counter. */
    const schema: JSONSchema = {
      type: "object",
      properties: {
        source: { type: "object", properties: { count: { type: "number" } } },
        note: { type: "string" },
      },
    };

    /**
     * Commits an argument of a `source` link to a counter holding `count`, in
     * a document that stores no label, and a `note`; returns the two cells.
     */
    const commitArgument = async (count: unknown) => {
      const tx = runtime.edit();
      const source = runtime.getCell<unknown>(space, "source", undefined, tx);
      source.set({ count });
      const argument = runtime.getCell<unknown>(
        space,
        "argument",
        undefined,
        tx,
      );
      argument.set({ source, note: "plain" });
      expect((await tx.commit().settled).error).toBeUndefined();
      return { source, argument };
    };

    /**
     * Returns the issue one validation of `argument` finds, read back or from
     * `staged`, and the address of each read it makes, in a transaction of
     * its own.
     */
    const judgeOnce = (
      argument: Cell<unknown>,
      staged?: unknown,
    ) => {
      const tx = runtime.edit();
      try {
        const cell = argument.withTx(tx);
        using reads = spyReads(tx);
        const issue = storedArgumentValidationIssue(
          cell,
          schema,
          undefined,
          tx,
          staged === undefined ? undefined : {
            value: staged,
            cellAt: (link) => runtime.getCellFromLink(link, undefined, tx),
          },
        );
        return {
          issue,
          reads: reads.addresses().map((address) =>
            JSON.stringify([address.id, address.scope, address.path])
          ),
        };
      } finally {
        tx.abort();
      }
    };

    it("reads nothing of an unlabeled argument that reading it back does not", async () => {
      const { source, argument } = await commitArgument(3);
      const readBack = judgeOnce(argument);
      const fromStaged = judgeOnce(argument, { source, note: "plain" });

      expect(fromStaged.issue).toBeUndefined();
      expect(readBack.issue).toBeUndefined();
      const readBackSet = new Set(readBack.reads);
      expect(fromStaged.reads.filter((read) => !readBackSet.has(read)))
        .toEqual([]);
      // Reading back reads the argument document's own slots, which the
      // staged view takes from what was staged.
      const argumentId = argument.getAsNormalizedFullLink().id;
      const argumentReads = (reads: readonly string[]) =>
        reads.filter((read) => JSON.parse(read)[0] === argumentId);
      expect(argumentReads(readBack.reads).length).toBeGreaterThan(
        argumentReads(fromStaged.reads).length,
      );
    });

    describe("judged both ways", () => {
      // The staged view and reading the argument back see the same slots and
      // return the same issue, whatever the staged value leaves out or adds.

      /**
       * Writes `stored` as the argument document, in a transaction of its
       * own, and returns, for `staged` judged under `argumentSchema`, the
       * slots each view holds and the issue each returns.
       */
      const judgeBothWays = (
        stored: (tx: IExtendedStorageTransaction) => unknown,
        staged: (tx: IExtendedStorageTransaction) => unknown,
        argumentSchema: JSONSchema,
      ) => {
        const tx = runtime.edit();
        try {
          const argument = runtime.getCell<unknown>(
            space,
            "both-ways",
            undefined,
            tx,
          );
          argument.set(stored(tx));
          const stagedArgument = {
            value: staged(tx),
            cellAt: (link: Parameters<typeof runtime.getCellFromLink>[0]) =>
              runtime.getCellFromLink(link, undefined, tx),
          };
          // The view's slots, and whether it is a record or an instance.
          const keys = (view: unknown) => {
            if (view === null || typeof view !== "object") return view;
            const prototype = Object.getPrototypeOf(view);
            return [
              prototype === Object.prototype || prototype === null
                ? "record"
                : view.constructor.name,
              ...Object.keys(view).sort(),
            ];
          };
          return {
            readBack: {
              slots: keys(
                materializeStoredValueForValidation(
                  argument,
                  argumentSchema,
                  tx,
                )
                  .value,
              ),
              issue: storedArgumentValidationIssue(
                argument,
                argumentSchema,
                undefined,
                tx,
              ),
            },
            fromStaged: {
              slots: keys(
                materializeStagedArgumentForValidation(
                  argument,
                  stagedArgument,
                  argumentSchema,
                  tx,
                ).value,
              ),
              issue: storedArgumentValidationIssue(
                argument,
                argumentSchema,
                undefined,
                tx,
                stagedArgument,
              ),
            },
          };
        } finally {
          tx.abort();
        }
      };

      it("agrees on a slot the document holds and the staged value does not", () => {
        // A setup's write fills a scoped slot it is not given with a link to
        // the instance that holds it; a link to another space stands in here.

        const { readBack, fromStaged } = judgeBothWays(
          (tx) => ({
            a: "x",
            elsewhere: runtime.getCell(otherSpace, "elsewhere", undefined, tx),
          }),
          () => ({ a: "x" }),
          {
            type: "object",
            properties: { a: { type: "string" }, elsewhere: {} },
            required: ["elsewhere"],
          },
        );

        expect(fromStaged).toEqual(readBack);
        expect(readBack).toEqual({
          slots: ["record", "a", "elsewhere"],
          issue: undefined,
        });
      });

      it("agrees on a slot the staged value holds and the document does not", () => {
        const { readBack, fromStaged } = judgeBothWays(
          () => ({ a: "x" }),
          () => ({ a: "x", extra: 3 }),
          {
            type: "object",
            properties: { a: { type: "string" }, extra: { type: "string" } },
          },
        );

        expect(fromStaged).toEqual(readBack);
        expect(readBack).toEqual({ slots: ["record", "a"], issue: undefined });
      });

      it("agrees on a cell the caller passes", () => {
        const counter = (tx: IExtendedStorageTransaction) =>
          runtime.getCell<unknown>(space, "counter", undefined, tx);
        const { readBack, fromStaged } = judgeBothWays(
          (tx) => {
            counter(tx).set({ count: "many" });
            return { source: counter(tx) };
          },
          (tx) => ({ source: counter(tx) }),
          schema,
        );

        expect(fromStaged).toEqual(readBack);
        expect(readBack.issue).toContain(
          "count: value does not match type number",
        );
      });

      it("agrees on an argument that is a class instance", () => {
        const stamp = new FabricEpochNsec(5n);
        const { readBack, fromStaged } = judgeBothWays(
          () => stamp,
          () => stamp,
          { type: "object" },
        );

        expect(fromStaged).toEqual(readBack);
        expect(readBack.slots).toEqual(["FabricEpochNsec"]);
      });
    });

    it("returns the issue reading it back returns for what a reference reaches", async () => {
      const { source, argument } = await commitArgument("many");
      const readBack = judgeOnce(argument);
      const fromStaged = judgeOnce(argument, { source, note: "plain" });

      expect(readBack.issue).toContain(
        "count: value does not match type number",
      );
      expect(fromStaged.issue).toBe(readBack.issue);
    });
  });
});
