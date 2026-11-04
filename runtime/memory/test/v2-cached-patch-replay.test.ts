/** Patch reconstruction from immutable revisions already in the engine cache. */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { ClientCommit, EntityDocument } from "../v2.ts";
import {
  applyCommit,
  close,
  type Engine,
  evictDocumentCacheEntries,
  open,
  type OpenOptions,
  read,
} from "../v2/engine.ts";

const withEngine = async (
  run: (engine: Engine) => void,
  options: Omit<OpenOptions, "url"> = {},
) => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path), ...options });
  try {
    run(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const commit = (
  engine: Engine,
  localSeq: number,
  operations: ClientCommit["operations"],
) =>
  applyCommit(engine, {
    sessionId: "session:cached-patches",
    commit: { localSeq, reads: { confirmed: [], pending: [] }, operations },
  });

const seed = (engine: Engine) => {
  commit(engine, 1, [{
    op: "set",
    id: "of:cached-patches",
    value: { value: { untouched: { list: [1, 2, 3] }, count: 0 } },
  }]);
};

const patch = (count: number): ClientCommit["operations"][number] => ({
  op: "patch",
  id: "of:cached-patches",
  patches: [{ op: "replace", path: "/value/count", value: count }],
});

const value = (document: EntityDocument | null) =>
  document?.value as { untouched: { list: number[] }; count: number };

describe("cached patch replay", () => {
  it("shares untouched subtrees from a cached set revision", async () => {
    await withEngine((engine) => {
      seed(engine);
      const original = value(read(engine, { id: "of:cached-patches" }));
      commit(engine, 2, [patch(1)]);
      const updated = value(read(engine, { id: "of:cached-patches" }));
      expect(updated.count).toBe(1);
      expect(updated.untouched).toBe(original.untouched);
      expect(original.count).toBe(0);
      expect(Object.isFrozen(updated.untouched.list)).toBe(true);
    });
  });

  it("replays only the suffix after a cached patch revision", async () => {
    await withEngine((engine) => {
      seed(engine);
      commit(engine, 2, [patch(1)]);
      const previous = value(read(engine, { id: "of:cached-patches" }));
      commit(engine, 3, [patch(2), patch(3)]);
      const current = value(read(engine, { id: "of:cached-patches" }));
      expect(current.count).toBe(3);
      expect(current.untouched).toBe(previous.untouched);
      expect(previous.count).toBe(1);
      expect(value(read(engine, { id: "of:cached-patches", seq: 2 })))
        .toBe(previous);
    });
  });

  it("reconstructs the same value when earlier revisions are evicted", async () => {
    await withEngine((engine) => {
      seed(engine);
      commit(engine, 2, [patch(1)]);
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      commit(engine, 3, [patch(2)]);
      expect(read(engine, { id: "of:cached-patches" })).toEqual({
        value: { untouched: { list: [1, 2, 3] }, count: 2 },
      });
    });
  });

  it("excludes a cached future revision from a historical replay", async () => {
    await withEngine((engine) => {
      seed(engine);
      commit(engine, 2, [patch(1)]);
      commit(engine, 3, [patch(2)]);
      const future = value(read(engine, { id: "of:cached-patches" }));
      // The one-entry cache holds only the newer revision. This historical
      // read must reconstruct its own bounded range.
      expect(engine.documentCache.size).toBe(1);
      expect(value(read(engine, { id: "of:cached-patches", seq: 2 })).count)
        .toBe(1);
      expect(future.count).toBe(2);
      expect(value(read(engine, { id: "of:cached-patches" })).count).toBe(2);
    }, { documentCacheMaxEntries: 1 });
  });

  it("rejects an inapplicable patch without caching its rolled-back revision", async () => {
    await withEngine((engine) => {
      seed(engine);
      const previous = value(read(engine, { id: "of:cached-patches" }));
      expect(() =>
        commit(engine, 2, [{
          op: "patch",
          id: "of:cached-patches",
          patches: [{ op: "add", path: "/value/count/child", value: 1 }],
        }])
      ).toThrow("path is not traversable");
      expect(value(read(engine, { id: "of:cached-patches" }))).toBe(previous);
      commit(engine, 2, [patch(9)]);
      expect(value(read(engine, { id: "of:cached-patches" })).count).toBe(9);
      expect(previous.count).toBe(0);
    });
  });
});
