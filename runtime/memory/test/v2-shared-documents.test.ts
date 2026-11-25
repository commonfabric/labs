/**
 * Sessions tracking the same revision of a document hold one decoded copy of
 * it, even once the engine's document cache has evicted that revision, and a
 * copy no session holds any longer is collected.
 *
 * Every engine here opens with a document-cache budget of one byte, which
 * retains nothing, so what the sessions share they do not share through that
 * cache.
 */

import { expect } from "@std/expect";
import { fromFileUrl, toFileUrl } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { describe, it } from "@commonfabric/test-support/test";

import {
  applyCommit,
  close,
  documentCacheDiagnostics,
  type Engine,
  open,
} from "../v2/engine.ts";
import { trackGraph } from "../v2/query.ts";
import type { FabricValue } from "@commonfabric/api";
import type { CellScope } from "../v2.ts";

const SPACE = "did:key:z6Mk-memory-v2-shared-documents";
const alice = { principal: "did:key:alice", sessionId: "session:alice" };
const bob = { principal: "did:key:bob", sessionId: "session:bob" };

const withEngine = async (
  fn: (engine: Engine) => void,
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({
    url: toFileUrl(path),
    documentCacheBudgetBytes: 1,
  });
  try {
    fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

const write = (
  engine: Engine,
  writer: { principal: string; sessionId: string },
  localSeq: number,
  documents: { id: string; scope?: CellScope; value: FabricValue }[],
): void => {
  applyCommit(engine, {
    ...writer,
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: documents.map(({ id, scope, value }) => ({
        op: "set" as const,
        id,
        ...(scope === undefined ? {} : { scope }),
        value: { value },
      })),
    },
  });
};

const queryOf = (roots: { id: string; scope?: CellScope }[]) => ({
  roots: roots.map(({ id, scope }) => ({
    id,
    ...(scope === undefined ? {} : { scope }),
    selector: { path: [], schema: false as const },
  })),
});

/**
 * Tracks `query` for `identity`, and returns the document each tracked key
 * holds, by entity id, and how many documents the evaluation scanned for
 * embedded schema refs.
 */
const track = (
  identity: { principal: string; sessionId: string },
  engine: Engine,
  query: ReturnType<typeof queryOf>,
): { documents: Map<string, unknown>; schemaRefScans: number } => {
  const { state, stats } = trackGraph(
    SPACE,
    engine,
    query,
    undefined,
    identity,
  );
  return {
    documents: new Map(
      [...state.entities.values()].map((
        snapshot,
      ) => [snapshot.id, snapshot.document]),
    ),
    schemaRefScans: stats.schemaRefScans,
  };
};

describe("shared decoded documents", () => {
  it("gives two sessions tracking the same revisions one decoded copy, scanned once", async () => {
    await withEngine((engine) => {
      const ids = ["of:shared-a", "of:shared-b"];
      write(
        engine,
        alice,
        1,
        ids.map((id) => ({ id, value: { id, items: [1, 2, 3] } })),
      );
      const query = queryOf(ids.map((id) => ({ id })));

      const forAlice = track(alice, engine, query);
      const forBob = track(bob, engine, query);

      expect(documentCacheDiagnostics(engine).entries).toBe(0);
      expect([...forAlice.documents.keys()].toSorted()).toEqual(ids);
      for (const id of ids) {
        expect(forAlice.documents.get(id)).toEqual({
          value: { id, items: [1, 2, 3] },
        });
        expect(forBob.documents.get(id)).toBe(forAlice.documents.get(id));
      }
      expect(forAlice.schemaRefScans).toBe(ids.length);
      expect(forBob.schemaRefScans).toBe(0);
    });
  });

  it("decodes a new revision rather than serving the one before it", async () => {
    await withEngine((engine) => {
      const changing = "of:shared-changing";
      const steady = "of:shared-steady";
      write(engine, alice, 1, [
        { id: changing, value: "first" },
        { id: steady, value: "steady" },
      ]);
      const query = queryOf([{ id: changing }, { id: steady }]);
      const forAlice = track(alice, engine, query);

      write(engine, alice, 2, [{ id: changing, value: "second" }]);
      const forBob = track(bob, engine, query);

      expect(forAlice.documents.get(changing)).toEqual({ value: "first" });
      expect(forBob.documents.get(changing)).toEqual({ value: "second" });
      expect(forBob.documents.get(steady)).toBe(forAlice.documents.get(steady));
      expect(forBob.schemaRefScans).toBe(1);
    });
  });

  it("keeps each user's instance of a user-scoped document apart", async () => {
    await withEngine((engine) => {
      const profile = "of:shared-profile";
      write(engine, alice, 1, [
        { id: profile, scope: "user", value: { name: "alice" } },
      ]);
      write(engine, bob, 1, [
        { id: profile, scope: "user", value: { name: "bob" } },
      ]);
      const query = queryOf([{ id: profile, scope: "user" }]);

      const forAlice = track(alice, engine, query);
      const forBob = track(bob, engine, query);

      expect(forAlice.documents.get(profile)).toEqual({
        value: { name: "alice" },
      });
      expect(forBob.documents.get(profile)).toEqual({
        value: { name: "bob" },
      });
      expect(forBob.schemaRefScans).toBe(1);
    });
  });

  it("collects a decoded copy once no session holds it", async () => {
    // Collecting garbage on demand needs `--expose-gc`, which only a process
    // of its own can be started with.
    const output = await runDenoCommandWithTemporaryLock({
      root: fromFileUrl(new URL("../../../", import.meta.url)),
      args: (lock) => [
        "run",
        "--frozen",
        `--lock=${lock}`,
        "--allow-read",
        "--allow-write",
        "--allow-ffi",
        "--allow-env",
        "--v8-flags=--expose-gc",
        fromFileUrl(
          new URL("./v2-shared-documents-release-helper.ts", import.meta.url),
        ),
      ],
    });

    const decoder = new TextDecoder();
    expect(output.success, decoder.decode(output.stderr)).toBe(true);
    expect(JSON.parse(decoder.decode(output.stdout))).toEqual({
      whileBobHoldsIt: true,
      onceNobodyHoldsIt: false,
      readAgain: { value: { name: "shared" } },
    });
  });
});
