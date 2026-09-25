/**
 * A refresh scans the documents it delivers for embedded schema refs. The
 * scans are answered from the graph state's own per-version record — every
 * scope, the closure's own documents included — so the documents a refresh
 * scans again are the ones that changed.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  refreshTrackedGraph,
  toDirtyKey,
  type TrackedGraphState,
  trackGraph,
} from "../v2/query.ts";

const identity = { principal: "did:key:alice", sessionId: "session:alice" };

const withEngine = async (
  fn: (engine: Engine) => Promise<void>,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  try {
    await fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

/** Every delivered document has a scan record at its delivered version. */
const expectRecordPerVersion = (state: TrackedGraphState) => {
  expect(state.schemaRefs.size).toBe(state.entities.size);
  for (const [key, snapshot] of state.entities) {
    expect(state.schemaRefs.get(key)?.seq).toBe(snapshot.seq);
  }
};

describe("v2-refresh-schema-ref-scans", () => {
  describe("refreshTrackedGraph()", () => {
    it("scans only the changed documents, per-user ones included", async () => {
      await withEngine((engine) => {
        const space = "did:key:z6Mk-memory-v2-refresh-scans";
        const root = "of:refresh-scans-root";
        const argument = "of:refresh-scans-argument";
        const profile = "of:refresh-scans-profile";
        const argumentSchema = {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
        };
        const rootWith = (title: string) => ({
          value: { title },
          argument: {
            "/": {
              "link@1": { id: argument, path: [], schema: argumentSchema },
            },
          },
        });
        // The argument is named alongside the root: the root's `argument`
        // link is data on the root, and only a named document is delivered.
        const query = {
          roots: [
            { id: root, selector: { path: [], schema: false as const } },
            { id: argument, selector: { path: [], schema: false as const } },
            {
              id: profile,
              scope: "user" as const,
              selector: { path: [], schema: false as const },
            },
          ],
        };
        applyCommit(engine, {
          sessionId: identity.sessionId,
          principal: identity.principal,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: argument,
                value: { value: { label: "shared" } },
              },
              { op: "set", id: root, value: rootWith("first") },
              {
                op: "set",
                id: profile,
                scope: "user",
                value: { value: { name: "alice" } },
              },
            ],
          },
        });

        const tracked = trackGraph(space, engine, query, undefined, identity);
        // Every delivered document is scanned once on the first evaluation.
        expect(tracked.state.entities.size).toBe(3);
        expect(tracked.stats.schemaRefScans).toBe(3);
        expectRecordPerVersion(tracked.state);

        applyCommit(engine, {
          sessionId: identity.sessionId,
          principal: identity.principal,
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [{ op: "set", id: root, value: rootWith("second") }],
          },
        });

        const refreshed = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey(root)]),
        );
        expect(refreshed).not.toBeNull();
        expect([...refreshed!.updates.values()].map((entity) => entity.id))
          .toEqual([root]);
        // Only the document that changed was scanned again: the unchanged
        // space-scoped argument and the per-user profile — which no
        // engine-wide cache holds — were answered from the state's record.
        expect(refreshed!.stats.schemaRefScans).toBe(1);
        expectRecordPerVersion(tracked.state);
        return Promise.resolve();
      });
    });

    it("records the schema documents the closure delivered, so an unchanged refresh scans nothing", async () => {
      await withEngine((engine) => {
        const space = "did:key:z6Mk-memory-v2-refresh-scans-closure";
        const root = "of:refresh-scans-closure-root";
        const target = "of:refresh-scans-closure-target";
        // `outer` references `leaf`, so the root's one link schema delivers
        // two schema documents through the closure.
        const leafSchema = { type: "string", title: "scans-leaf" } as const;
        const leafHash = internSchemaAsTaggedHashString(leafSchema);
        const outerSchema = {
          type: "object",
          properties: { x: { $ref: `cid:${leafHash}` } },
        } as const;
        const outerHash = internSchemaAsTaggedHashString(outerSchema);
        applyCommit(engine, {
          sessionId: identity.sessionId,
          principal: identity.principal,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              {
                op: "set",
                id: `cid:${leafHash}`,
                value: { value: leafSchema },
              },
              {
                op: "set",
                id: `cid:${outerHash}`,
                value: { value: outerSchema },
              },
              { op: "set", id: target, value: { value: { n: 1 } } },
              {
                op: "set",
                id: root,
                value: {
                  value: {
                    x: {
                      "/": {
                        "link@1": {
                          id: target,
                          path: [],
                          schema: { $ref: `cid:${outerHash}` },
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        });

        const tracked = trackGraph(
          space,
          engine,
          {
            roots: [{ id: root, selector: { path: [], schema: false } }],
          },
          undefined,
          identity,
        );
        // The root was scanned; the two schema documents its closure
        // delivered were verified, and recorded at their versions without
        // a scan of their own.
        expect(tracked.state.entities.has(`${space}/space/cid:${leafHash}`))
          .toBe(true);
        expect(tracked.state.entities.has(`${space}/space/cid:${outerHash}`))
          .toBe(true);
        expect(tracked.stats.schemaRefScans).toBe(1);
        expectRecordPerVersion(tracked.state);

        // A refresh over the unchanged root answers it from the record and
        // scans nothing.
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey(root)]),
        );
        expect(refreshed).not.toBeNull();
        expect(refreshed!.stats.schemaRefScans).toBe(0);
        expectRecordPerVersion(tracked.state);
        return Promise.resolve();
      });
    });
  });
});
