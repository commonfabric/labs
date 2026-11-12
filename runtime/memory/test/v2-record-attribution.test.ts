import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import type { FabricValue, JSONSchema } from "@commonfabric/api";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  refreshTrackedGraph,
  releaseTrackedRoots,
  rootReferrersOf,
  toDirtyKey,
  trackGraph,
} from "../v2/query.ts";

const space = "did:key:z6Mk-memory-v2-record-attribution";
const identity = { principal: "did:key:alice", sessionId: "session:alice" };

const link = (id: string, path: string[] = []) => ({
  "/": { "link@1": { id, path, space, scope: "space" } },
});

/** A write-redirect link: an array element holding one is the slot it
 * names. */
const redirect = (id: string) => ({
  "/": {
    "link@1": { id, path: [], space, scope: "space", overwrite: "redirect" },
  },
});

const set = (id: string, value: FabricValue) => ({
  op: "set" as const,
  id,
  value: { value },
});

describe("v2-record-attribution", () => {
  // `of:list` links to `of:x`, and its watch's schema reaches through
  // `of:x` to `of:y`. A watch of its own on `of:x` reaches its name alone.
  // So `of:x` is tracked under two records, and only the one the list's
  // walk made reaches `of:y`.

  const listRoot = {
    id: "of:list",
    selector: {
      path: [],
      schema: {
        type: "object",
        properties: {
          item: {
            type: "object",
            properties: {
              child: {
                type: "object",
                properties: { name: { type: "string" } },
              },
            },
          },
        },
      },
    },
  } as const;

  /** A watch of `of:x`'s own, under `schema`. */
  const xRoot = (schema: JSONSchema) => ({
    id: "of:x",
    selector: { path: [], schema },
  });

  /** `of:x`'s name alone. */
  const nameOnly = {
    type: "object",
    properties: { name: { type: "string" } },
  } as const;

  let localSeq = 0;
  const commit = (engine: Engine, operations: ReturnType<typeof set>[]) => {
    applyCommit(engine, {
      ...identity,
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

  const withTracked = (
    xSchema: JSONSchema,
    fn: (engine: Engine, tracked: ReturnType<typeof trackGraph>) => void,
  ): Promise<void> =>
    withEngine((engine) => {
      commit(engine, [
        set("of:list", { item: link("of:x") }),
        set("of:x", { name: "x", child: link("of:y") }),
        set("of:y", { name: "y" }),
      ]);
      fn(
        engine,
        trackGraph(
          space,
          engine,
          { roots: [listRoot, xRoot(xSchema)] },
          undefined,
          identity,
        ),
      );
    });

  const ids = (keys: Iterable<string>) =>
    [...keys].map((key) => key.slice(key.lastIndexOf("/") + 1)).toSorted();

  describe("refreshTrackedGraph()", () => {
    it("retracts what only a retired record reached, and keeps the document its other record holds", async () => {
      await withTracked(nameOnly, (engine, tracked) => {
        expect(ids(tracked.state.entities.keys())).toEqual([
          "of:list",
          "of:x",
          "of:y",
        ]);

        commit(engine, [set("of:list", {})]);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:list")]),
        );

        expect(ids(refreshed!.removed)).toEqual(["of:y"]);
        expect(ids(tracked.state.entities.keys())).toEqual([
          "of:list",
          "of:x",
        ]);
        // The retired record released what its own walk reached, so the
        // refresh read the changed list and nothing else: `of:x`, which
        // keeps the record its own watch made, was not walked again.
        expect(refreshed!.stats.managerReads).toBe(1);
      });
    });

    it("retracts what only a retired record reached when one commit both unlinks the document and changes it", async () => {
      // The refresh walks `of:x` again as a changed document under both of
      // its records before the list's record of it retires.
      for (const order of [["of:list", "of:x"], ["of:x", "of:list"]]) {
        await withTracked(nameOnly, (engine, tracked) => {
          commit(engine, [
            set("of:list", {}),
            set("of:x", { name: "x2", child: link("of:y") }),
          ]);
          const refreshed = refreshTrackedGraph(
            space,
            engine,
            tracked.state,
            new Set(order.map((id) => toDirtyKey(id))),
          );

          expect(ids(refreshed!.removed)).toEqual(["of:y"]);
          expect(ids(tracked.state.entities.keys())).toEqual([
            "of:list",
            "of:x",
          ]);
        });
      }
    });

    it("reads no more on a write that moves one list's link off a document many lists link to", async () => {
      // Every list links to `of:s` under the same selector, so each keeps
      // the record of it as the first list does, and one list moving its
      // link releases one attribution and walks no other list.
      const readsWith = async (lists: number) => {
        let reads = 0;
        await withEngine((engine) => {
          commit(engine, [
            set("of:s", { name: "s" }),
            set("of:n", { name: "n" }),
            ...Array.from(
              { length: lists },
              (_, i) => set(`of:l${i}`, { item: link("of:s") }),
            ),
          ]);
          const tracked = trackGraph(
            space,
            engine,
            {
              roots: Array.from({ length: lists }, (_, i) => ({
                ...listRoot,
                id: `of:l${i}`,
              })),
            },
            undefined,
            identity,
          );
          commit(engine, [set("of:l0", { item: link("of:n") })]);
          const refreshed = refreshTrackedGraph(
            space,
            engine,
            tracked.state,
            new Set([toDirtyKey("of:l0")]),
          );
          expect(ids(refreshed!.removed)).toEqual([]);
          reads = refreshed!.stats.managerReads;
        });
        return reads;
      };

      expect(await readsWith(32)).toBe(await readsWith(2));
    });

    it("retracts a cycle between records of a document another of its records keeps", async () => {
      // The list's schema follows `of:x` to `of:y` and back to `of:x` under
      // a record of its own, so once the list lets go, `of:x`'s second
      // record and `of:y` keep only each other; `of:x`'s own watch keeps
      // its first record.
      await withEngine((engine) => {
        commit(engine, [
          set("of:list", { item: link("of:x") }),
          set("of:x", { name: "x", child: link("of:y") }),
          set("of:y", { back: link("of:x") }),
        ]);
        const x = {
          type: "object",
          properties: {
            name: { type: "string" },
            child: {
              type: "object",
              properties: { back: { $ref: "#/$defs/X" } },
            },
          },
        } as const;
        const tracked = trackGraph(
          space,
          engine,
          {
            roots: [{
              id: "of:list",
              selector: {
                path: [],
                schema: {
                  $defs: { X: x },
                  type: "object",
                  properties: { item: { $ref: "#/$defs/X" } },
                },
              },
            }, xRoot(nameOnly)],
          },
          undefined,
          identity,
        );

        commit(engine, [set("of:list", {})]);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:list")]),
        );

        expect(ids(refreshed!.removed)).toEqual(["of:y"]);
        expect(ids(tracked.state.entities.keys())).toEqual([
          "of:list",
          "of:x",
        ]);
      });
    });

    it("keeps what a root reaches through a document it walks without a schema after another record of the document stops reaching it", async () => {
      // A `true` schema walks `of:x`'s `a` link by link: `first` reaches
      // `of:y`, which links back to `of:x` under a record of its own, and
      // then `second` reaches `of:z` for the root's record. When `of:y`
      // stops linking back, that other record retires, and `of:z` stays.
      for (
        const selector of [
          {
            path: [],
            schema: { type: "object", properties: { a: true } },
          },
          { path: ["a"], schema: true },
        ] as const
      ) {
        await withEngine((engine) => {
          commit(engine, [
            set("of:x", {
              a: { first: link("of:y"), second: link("of:z") },
              other: 1,
            }),
            set("of:y", { back: link("of:x") }),
            set("of:z", { n: 1 }),
          ]);
          const tracked = trackGraph(
            space,
            engine,
            { roots: [{ id: "of:x", selector }] },
            undefined,
            identity,
          );
          expect(ids(tracked.state.entities.keys())).toContain("of:z");

          commit(engine, [set("of:y", { back: 1 })]);
          refreshTrackedGraph(
            space,
            engine,
            tracked.state,
            new Set([toDirtyKey("of:y")]),
          );

          expect(ids(tracked.state.entities.keys())).toContain("of:z");
        });
      }
    });

    it("keeps what a root reaches through a later array element after an earlier element's link back into the document stops", async () => {
      // `of:a`'s first item redirects to `of:b`, which links back into
      // `of:a`'s `sub` under a record of its own; the second item links to
      // `of:d` for the root's record. Under a schema and without one alike,
      // `of:b` dropping its link retires that other record, and `of:d`
      // stays.
      for (
        const items of [{ type: "array", items: nameOnly }, true] as const
      ) {
        await withEngine((engine) => {
          commit(engine, [
            set("of:a", {
              items: [redirect("of:b"), link("of:d")],
              sub: { name: "s" },
            }),
            set("of:b", link("of:a", ["sub"])),
            set("of:d", { name: "d" }),
          ]);
          const tracked = trackGraph(
            space,
            engine,
            {
              roots: [{
                id: "of:a",
                selector: {
                  path: [],
                  schema: { type: "object", properties: { items } },
                },
              }],
            },
            undefined,
            identity,
          );
          expect(ids(tracked.state.entities.keys())).toContain("of:d");

          commit(engine, [set("of:b", { name: "b" })]);
          refreshTrackedGraph(
            space,
            engine,
            tracked.state,
            new Set([toDirtyKey("of:b")]),
          );

          expect(ids(tracked.state.entities.keys())).toContain("of:d");
        });
      }
    });

    it("keeps what a document's remaining record reaches when another of its records retires", async () => {
      // `of:x`'s own watch reaches `of:y` as the list's does.
      await withTracked(listRoot.selector.schema.properties.item, (
        engine,
        tracked,
      ) => {
        commit(engine, [set("of:list", {})]);
        const refreshed = refreshTrackedGraph(
          space,
          engine,
          tracked.state,
          new Set([toDirtyKey("of:list")]),
        );

        expect(ids(refreshed!.removed)).toEqual([]);
        expect(ids(tracked.state.entities.keys())).toEqual([
          "of:list",
          "of:x",
          "of:y",
        ]);
        expect(refreshed!.stats.managerReads).toBe(1);
      });
    });
  });

  describe("releaseTrackedRoots()", () => {
    it("retracts what a later array element reached when the root reaching it is released, though an earlier element links into the document", async () => {
      // `of:a`'s first item links to its own `sub`, which a second watch
      // keeps; only the first watch's walk reaches `of:d`, through the
      // second item.
      await withEngine((engine) => {
        commit(engine, [
          set("of:a", {
            items: [link("of:a", ["sub"]), link("of:d")],
            sub: { name: "s" },
          }),
          set("of:d", { name: "d" }),
        ]);
        const items = {
          id: "of:a",
          selector: {
            path: [],
            schema: {
              type: "object",
              properties: { items: { type: "array", items: nameOnly } },
            },
          },
        } as const;
        const sub = {
          id: "of:a",
          selector: { path: ["sub"], schema: nameOnly },
        } as const;
        const tracked = trackGraph(
          space,
          engine,
          { roots: [items, sub] },
          undefined,
          identity,
        );
        expect(ids(tracked.state.entities.keys())).toEqual(["of:a", "of:d"]);

        releaseTrackedRoots(
          space,
          engine,
          tracked.state,
          rootReferrersOf(space, [items], identity),
        );

        expect(ids(tracked.state.entities.keys())).toEqual(["of:a"]);
      });
    });

    it("retracts what a wider record reached when its root is released, and keeps the record a link it covered needs", async () => {
      // `of:g`'s own watch walks it under `true`, reaching `of:z`; `of:one`
      // links to `of:g` needing its flavor alone, which that record
      // covers. Releasing `of:g`'s watch walks `of:one`'s link on its own.
      await withEngine((engine) => {
        commit(engine, [
          set("of:g", { flavor: "maple", extra: link("of:z") }),
          set("of:z", { name: "z" }),
          set("of:one", { glaze: link("of:g") }),
        ]);
        const g = { id: "of:g", selector: { path: [], schema: true } } as const;
        const tracked = trackGraph(
          space,
          engine,
          {
            roots: [g, {
              id: "of:one",
              selector: {
                path: [],
                schema: {
                  type: "object",
                  properties: {
                    glaze: {
                      type: "object",
                      properties: { flavor: { type: "string" } },
                    },
                  },
                },
              },
            }],
          },
          undefined,
          identity,
        );
        expect(ids(tracked.state.entities.keys())).toEqual([
          "of:g",
          "of:one",
          "of:z",
        ]);

        const released = releaseTrackedRoots(
          space,
          engine,
          tracked.state,
          rootReferrersOf(space, [g], identity),
        );

        expect(ids(released.removed)).toEqual(["of:z"]);
        expect(ids(tracked.state.entities.keys())).toEqual(["of:g", "of:one"]);
      });
    });

    it("retracts what a document's link into itself reached when the root reaching it is released", async () => {
      // `of:d`'s `a` links to its own `b`, which links to `of:f`, so `of:d`
      // is tracked under the root's record and under a record its own link
      // made.
      await withEngine((engine) => {
        commit(engine, [
          set("of:d", { a: link("of:d", ["b"]), b: { f: link("of:f") } }),
          set("of:f", { name: "f" }),
          set("of:other", { name: "o" }),
        ]);
        const root = {
          id: "of:d",
          selector: {
            path: [],
            schema: {
              type: "object",
              properties: {
                a: {
                  type: "object",
                  properties: { f: nameOnly },
                },
              },
            },
          },
        } as const;
        const tracked = trackGraph(
          space,
          engine,
          {
            roots: [root, {
              id: "of:other",
              selector: { path: [], schema: true },
            }],
          },
          undefined,
          identity,
        );
        expect(ids(tracked.state.entities.keys())).toEqual([
          "of:d",
          "of:f",
          "of:other",
        ]);

        const released = releaseTrackedRoots(
          space,
          engine,
          tracked.state,
          rootReferrersOf(space, [root], identity),
        );

        expect(ids(released.removed)).toEqual(["of:d", "of:f"]);
        expect(ids(tracked.state.entities.keys())).toEqual(["of:other"]);
      });
    });
  });
});
