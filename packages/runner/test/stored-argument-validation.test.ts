/**
 * Checks stored-argument validation and its fallback with real storage graphs.
 * Direct overlay cases supply cyclic snapshots that eager reads reject before
 * the fallback can exercise its own termination and cache guards.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { validateSchemaValue } from "../src/cfc/schema-sanitization.ts";
import { extractDefaultValues } from "../src/runner-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  acceptsOpaqueCellOrUnresolvedLink,
  overlayUnreadableLinkPlaceholders,
  storedArgumentValidationIssue,
} from "../src/stored-argument-validation.ts";

/** Materialized snapshot whose cycle remains observable by identity. */
interface MaterializedNode {
  /** Linked value that materialization could not read. */
  pending: unknown;

  /** Optional back edge through the materialized graph. */
  next?: MaterializedNode;
}

const signer = await Identity.fromPassphrase("stored-argument-validation");
const space = signer.did();

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
      using reads = spy(tx, "read");
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      const graphReads = reads.calls.filter((call) =>
        graphIds.has(call.args[0].id)
      ).length;
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
      using reads = spy(tx, "read");
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
      expect(reads.calls.length).toBeGreaterThan(0);
      expect(reads.calls.length).toBeLessThan(4 * nodes.length);
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
      using reads = spy(tx, "read");
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      expect(
        reads.calls.some((call) =>
          call.args[0].id === second.getAsNormalizedFullLink().id
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
});
