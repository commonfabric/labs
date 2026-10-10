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
import {
  extractDefaultValues,
  mergeSchemaDefaults,
} from "../src/runner-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { isLinkResolutionProbe } from "../src/storage/reactivity-log.ts";
import {
  acceptsOpaqueCellOrUnresolvedLink,
  handleBoundarySchema,
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

  describe("asCell positions", () => {
    // An `asCell` position holds a reference. Validation checks that it is one
    // and leaves the target to whoever reads through the handle, so the
    // target's contents neither refuse the argument nor join the read set.

    const portraitSchema = (asCell: boolean): JSONSchema => ({
      type: "object",
      properties: {
        mediaType: { type: "string" },
        width: { type: "number" },
      },
      required: ["mediaType"],
      ...(asCell ? { asCell: ["cell"] } : {}),
    });

    const peopleSchema = (asCell: boolean): JSONSchema => ({
      type: "object",
      properties: {
        people: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              name: { type: "string" },
              portrait: portraitSchema(asCell),
            },
            required: ["name"],
          },
        },
      },
      required: ["people"],
    });

    /** Stages people whose portraits link to separate, malformed documents. */
    const stagePeople = (tx: ReturnType<Runtime["edit"]>) => {
      const portraitIds = new Set<string>();
      const people: Record<string, unknown> = {};
      for (const key of ["ada", "grace"]) {
        const portrait = runtime.getCell(
          space,
          `portrait-${key}`,
          undefined,
          tx,
        );
        portrait.set({ mediaType: 42, width: 10 });
        portraitIds.add(portrait.getAsNormalizedFullLink().id);
        const person = runtime.getCell(space, `person-${key}`, undefined, tx);
        person.set({ name: key, portrait });
        people[key] = person;
      }
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ people });
      return { argument, portraitIds };
    };

    it("returns no issue for a malformed document behind an asCell link", () => {
      const tx = runtime.edit();
      try {
        const { argument } = stagePeople(tx);
        expect(
          storedArgumentValidationIssue(
            argument,
            peopleSchema(true),
            undefined,
            tx,
          ),
        ).toBeUndefined();
      } finally {
        tx.abort();
      }
    });

    it("reads no contents of the document behind an asCell link", () => {
      const tx = runtime.edit();
      try {
        const { argument, portraitIds } = stagePeople(tx);
        using reads = spy(tx, "read");
        storedArgumentValidationIssue(
          argument,
          peopleSchema(true),
          undefined,
          tx,
        );
        // Resolving the link probes whether the target is itself a link,
        // which observes the reference and not the target's contents.
        const contentReads = reads.calls.filter((call) =>
          portraitIds.has(call.args[0].id) &&
          !isLinkResolutionProbe(call.args[1]?.meta)
        );
        expect(contentReads).toEqual([]);
      } finally {
        tx.abort();
      }
    });

    it("returns the mismatch for a malformed document behind a by-value link", () => {
      const tx = runtime.edit();
      try {
        const { argument } = stagePeople(tx);
        expect(
          storedArgumentValidationIssue(
            argument,
            peopleSchema(false),
            undefined,
            tx,
          ),
        ).toContain("mediaType: value does not match type string");
      } finally {
        tx.abort();
      }
    });

    it("returns no issue for an inline value at an asCell position", () => {
      // The reader holds an inline value at a handle position as a handle
      // too, and judges it when read through the handle, so its contents are
      // left to that read whether stored inline or behind a link.
      const tx = runtime.edit();
      try {
        const argument = runtime.getCell(space, "argument", undefined, tx);
        argument.set({
          people: { ada: { name: "ada", portrait: { mediaType: 42 } } },
        });
        expect(
          storedArgumentValidationIssue(
            argument,
            peopleSchema(true),
            undefined,
            tx,
          ),
        ).toBeUndefined();
      } finally {
        tx.abort();
      }
    });

    it("returns the mismatch for a by-value field of the referring document", () => {
      const tx = runtime.edit();
      try {
        const { argument } = stagePeople(tx);
        const person = runtime.getCell(space, "person-ada", undefined, tx);
        person.key("name").set(7 as never);
        expect(
          storedArgumentValidationIssue(
            argument,
            peopleSchema(true),
            undefined,
            tx,
          ),
        ).toContain("name: value does not match type string");
      } finally {
        tx.abort();
      }
    });

    describe("handleBoundarySchema", () => {
      it("returns `true` for a schema declaring no handle", () => {
        expect(handleBoundarySchema(peopleSchema(false))).toBe(true);
      });

      it("returns the path to each handle and nothing else", () => {
        expect(handleBoundarySchema(peopleSchema(true))).toEqual({
          properties: {
            people: {
              additionalProperties: {
                properties: { portrait: { asCell: ["cell"] } },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        });
      });

      it("returns `true` for a union whose branch declares a handle", () => {
        expect(handleBoundarySchema({
          anyOf: [{ type: "string" }, { type: "object", asCell: ["cell"] }],
        })).toBe(true);
      });

      it("keeps a local reference only to a definition leading to a handle", () => {
        expect(handleBoundarySchema({
          $ref: "#/$defs/Root",
          $defs: {
            Root: {
              type: "object",
              properties: {
                held: { $ref: "#/$defs/Held" },
                plain: { $ref: "#/$defs/Plain" },
              },
            },
            Held: { type: "object", asCell: ["cell"] },
            Plain: { type: "object", properties: { x: { type: "number" } } },
          },
        })).toEqual({
          $ref: "#/$defs/Root",
          $defs: {
            Root: {
              properties: { held: { $ref: "#/$defs/Held" } },
              additionalProperties: true,
            },
            Held: { asCell: ["cell"] },
          },
        });
      });

      it("keeps a recursive definition that leads to a handle", () => {
        const node: JSONSchema = {
          type: "object",
          properties: {
            next: { $ref: "#/$defs/Node" },
            held: { type: "string", asCell: ["cell"] },
          },
        };
        expect(handleBoundarySchema({
          $ref: "#/$defs/Node",
          $defs: { Node: node },
        })).toEqual({
          $ref: "#/$defs/Node",
          $defs: {
            Node: {
              properties: {
                next: { $ref: "#/$defs/Node" },
                held: { asCell: ["cell"] },
              },
              additionalProperties: true,
            },
          },
        });
      });

      it("returns `true` for a reference to a document that has not arrived", () => {
        expect(handleBoundarySchema({
          type: "object",
          properties: {
            held: { $ref: "cid:fid1:absent-schema-document" },
          },
        })).toBe(true);
      });
    });
  });
});
