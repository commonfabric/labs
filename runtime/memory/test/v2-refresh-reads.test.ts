/**
 * How many documents a refresh reads out of the engine, and that a refresh
 * which reads an unchanged document from the graph's own cache still walks
 * the version the engine holds.
 */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import type { FabricValue } from "@commonfabric/api";
import { describe, it } from "@commonfabric/test-support/test";

import { resolveScopeKey } from "../v2.ts";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  partitionGraphQuery,
  refreshTrackedGraph,
  toDirtyKey,
  trackGraph,
} from "../v2/query.ts";

const space = "did:key:z6Mk-memory-v2-refresh-reads";
const identity = { principal: "did:key:alice", sessionId: "session:alice" };
const bob = { principal: "did:key:bob", sessionId: "session:bob" };

const link = (id: string) => ({
  "/": { "link@1": { id, path: [], space, scope: "space" } },
});

type Operation = {
  op: "set";
  id: string;
  scope?: "user";
  value: { value: FabricValue };
};

const set = (id: string, value: FabricValue): Operation => ({
  op: "set",
  id,
  value: { value },
});

/**
 * A list of links under a schema that declares no type, which a walk follows
 * through every link it finds.
 */
const untypedListRoot = {
  id: "of:list",
  selector: { path: [], schema: true },
} as const;

/** A list of links, each followed to its target's name. */
const listRoot = {
  id: "of:list",
  selector: {
    path: [],
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          next: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    },
  },
} as const;

describe("v2-refresh-reads", () => {
  let localSeq = 0;
  const commit = (
    engine: Engine,
    operations: Operation[],
    as: typeof identity = identity,
  ) => {
    applyCommit(engine, {
      ...as,
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations,
      },
    });
  };

  const withEngine = async (fn: (engine: Engine) => void): Promise<void> => {
    const path = await Deno.makeTempFile({ suffix: ".sqlite" });
    const engine = await open({ url: toFileUrl(path) });
    try {
      fn(engine);
    } finally {
      close(engine);
      await Deno.remove(path);
    }
  };

  const ids = (keys: Iterable<string>) =>
    [...keys].map((key) => key.slice(key.lastIndexOf("/") + 1)).toSorted();

  describe("refreshTrackedGraph()", () => {
    it("reads the same number of documents when one link of a list changes, however many links the list holds", async () => {
      // The list's other links name documents that did not change, which
      // the graph read when it first walked them. The schema declares no
      // type, so the walk of the changed list passes through each of them.
      const readsWith = async (links: number) => {
        let reads = 0;
        await withEngine((engine) => {
          const members = Array.from({ length: links }, (_, i) => `of:m${i}`);
          commit(engine, [
            ...members.map((id) => set(id, { name: id })),
            set("of:other", { name: "other" }),
            set("of:list", members.map(link)),
          ]);
          const tracked = trackGraph(
            space,
            engine,
            { roots: [untypedListRoot] },
            undefined,
            identity,
          );
          expect(tracked.state.entities.size).toBe(links + 1);

          commit(engine, [
            set("of:list", [link("of:other"), ...members.slice(1).map(link)]),
          ]);
          const refreshed = refreshTrackedGraph(
            space,
            engine,
            tracked.state,
            new Set([toDirtyKey("of:list")]),
          );

          expect(ids(refreshed!.updates.keys())).toEqual([
            "of:list",
            "of:other",
          ]);
          expect(ids(refreshed!.removed)).toEqual(["of:m0"]);
          reads = refreshed!.stats.managerReads;
        });
        return reads;
      };

      // The changed list and the document its new link names.
      expect(await readsWith(4)).toBe(2);
      expect(await readsWith(64)).toBe(2);
    });

    it("walks the version of a document an earlier refresh read when a later one reaches it under a wider selector", async () => {
      // `of:m0` has a watch of its own that reads its name alone, so the
      // refresh that finds it changed does not follow its new link. The list
      // then links to it under a schema that does, and the walk of the list
      // passes through `of:m0` without reading it from the engine again.
      await withEngine((engine) => {
        commit(engine, [
          set("of:m0", { name: "m0" }),
          set("of:far", { name: "far" }),
          set("of:list", []),
        ]);
        const tracked = trackGraph(
          space,
          engine,
          {
            roots: [listRoot, {
              id: "of:m0",
              selector: {
                path: [],
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                },
              },
            }],
          },
          undefined,
          identity,
        );

        commit(engine, [
          set("of:m0", { name: "m0", next: link("of:far") }),
        ]);
        const first = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:m0")]),
        );
        expect(ids(first!.updates.keys())).toEqual(["of:m0"]);

        commit(engine, [set("of:list", [link("of:m0")])]);
        const second = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:list")]),
        );

        expect(ids(second!.updates.keys())).toEqual(["of:far", "of:list"]);
        expect(second!.stats.managerReads).toBe(2);
      });
    });

    it("walks the stored version of a linked document that changed in the same commit as the list", async () => {
      await withEngine((engine) => {
        commit(engine, [
          set("of:m0", { name: "m0" }),
          set("of:far", { name: "far" }),
          set("of:list", [link("of:m0")]),
        ]);
        const tracked = trackGraph(
          space,
          engine,
          { roots: [listRoot] },
          undefined,
          identity,
        );

        commit(engine, [
          set("of:m0", { name: "m0", next: link("of:far") }),
          set("of:list", [link("of:m0"), link("of:m0")]),
        ]);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:list"), toDirtyKey("of:m0")]),
        );

        expect(ids(refreshed!.updates.keys())).toEqual([
          "of:far",
          "of:list",
          "of:m0",
        ]);
      });
    });

    it("delivers the stored version of another principal's instance that a root names by its key", async () => {
      // The querying session is alice's, and the root names bob's instance
      // of a document in the user scope, so the root is walked in a graph
      // of bob's (`partitionGraphQuery()`), and a change to it is reported
      // under bob's key.
      const bobKey = resolveScopeKey("user", bob);
      const profile = (name: string): Operation => ({
        op: "set",
        id: "of:profile",
        scope: "user",
        value: { value: { name } },
      });
      await withEngine((engine) => {
        commit(engine, [profile("before")], bob);
        const parts = partitionGraphQuery({
          roots: [{
            id: "of:profile",
            scope: "user",
            entityScopeKey: bobKey,
            selector: { path: [], schema: true },
          }],
        }, identity);
        expect(parts.map((part) => part.instance)).toEqual([bobKey]);
        const tracked = trackGraph(
          space,
          engine,
          parts[0].query,
          undefined,
          parts[0].identity,
        );
        const bobDocument = (entities: Map<string, { document: unknown }>) =>
          [...entities].filter(([key]) => key.includes(`/${bobKey}/`)).map((
            [, entity],
          ) => entity.document);
        expect(bobDocument(tracked.state.entities)).toEqual([
          { value: { name: "before" } },
        ]);

        commit(engine, [profile("after")], bob);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:profile", bobKey)]),
        );

        expect(bobDocument(refreshed!.updates)).toEqual([
          { value: { name: "after" } },
        ]);
      });
    });
  });
});
