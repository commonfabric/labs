/**
 * Regression for the blind-`$value` write STRUCTURAL precondition (the
 * ancestor-shape check).
 *
 * A blind UI-input `set` drops the value-equality precondition on its write
 * target so it can't lose the own-write race. In its place, handleCellSet threads
 * the cell's PARENT address, which buildReads turns into one nonRecursive read.
 * This test pins WHY that read must be at the parent, not the entity root: it
 * exercises the exact race the parent read exists for — a stale nested patch
 * whose ANCESTOR was concurrently retyped (object -> scalar).
 *
 * - precondition-free: the patch replays onto the retyped base at
 *   commit-materialization and throws a raw "not traversable" (ungraceful; rolls
 *   back inside the commit's SQLite tx, so no durable corruption);
 * - an entity-ROOT structural read does NOT catch it (a TIER-2 patch that retypes
 *   an intermediate ancestor doesn't overlap a root read) — still a raw throw;
 * - the PARENT structural read (what handleCellSet threads) converts it into a
 *   clean ConflictError, which the conflict-recovery path handles gracefully.
 *
 * The in-process multi-runtime harness can't reproduce this end to end: it
 * propagates shared state synchronously, so a session can't hold a stale-but-
 * navigable replica (its navigation into the retyped ancestor fails locally
 * before any commit). Hence this engine-level test.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";

import type { FabricValue } from "@commonfabric/api";

import { type EntityDocument, toDocumentPath } from "../v2.ts";
import {
  applyCommit,
  close,
  ConflictError,
  type Engine,
  open,
  read,
} from "../v2/engine.ts";

const toEntityDocument = (value: FabricValue): EntityDocument => ({ value });

const createEngine = async (): Promise<{ engine: Engine; path: string }> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
};

// seq 1: a doc with a nested object ancestor `notes`. seq 2: writer B retypes
// `notes` from an object to a scalar (a blind patch). Leaves the engine with a
// retyped ancestor that a stale nested patch cannot replay onto.
const setupReshape = (engine: Engine): void => {
  applyCommit(engine, {
    sessionId: "session:setup",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: "entity:doc",
        value: toEntityDocument({ notes: { today: "x" } }),
      }],
    },
  });
  applyCommit(engine, {
    sessionId: "session:reshaper",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "patch",
        id: "entity:doc",
        patches: [{ op: "replace", path: "/value/notes", value: false }],
      }],
    },
  });
};

// Writer A's stale nested patch (replace /value/notes/today), based on seq 1,
// carrying the given structural read (or none).
const aliceNestedPatch = (
  structuralRead?: {
    id: string;
    path: ReturnType<typeof toDocumentPath>;
    seq: number;
    nonRecursive: true;
  },
) => ({
  sessionId: "session:alice",
  commit: {
    localSeq: 1,
    reads: {
      confirmed: structuralRead ? [structuralRead] : [],
      pending: [],
    },
    operations: [{
      op: "patch" as const,
      id: "entity:doc",
      patches: [{
        op: "replace" as const,
        path: "/value/notes/today",
        value: "typed",
      }],
    }],
  },
});

Deno.test("blind $value structural precondition vs a concurrent ancestor reshape", async (t) => {
  await t.step(
    "precondition-free: a nested patch on a retyped ancestor throws a raw non-Conflict error, rolled back",
    async () => {
      const { engine, path } = await createEngine();
      try {
        setupReshape(engine);
        const err = assertThrows(
          () => applyCommit(engine, aliceNestedPatch()),
          Error,
          "not traversable",
        );
        assertEquals(
          err instanceof ConflictError,
          false,
          "must be a raw error, not a clean ConflictError",
        );
        // Rolled back inside the commit's SQLite tx: no durable corruption.
        assertEquals(read(engine, { id: "entity:doc" }), {
          value: { notes: false },
        });
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    },
  );

  await t.step(
    "entity-root structural read does NOT catch the reshape (still a raw throw)",
    async () => {
      const { engine, path } = await createEngine();
      try {
        setupReshape(engine);
        const err = assertThrows(
          () =>
            applyCommit(
              engine,
              aliceNestedPatch({
                id: "entity:doc",
                path: toDocumentPath([]),
                seq: 1,
                nonRecursive: true,
              }),
            ),
          Error,
          "not traversable",
        );
        assertEquals(
          err instanceof ConflictError,
          false,
          "an entity-root read must not convert the reshape into a conflict — " +
            "it is why the structural read must be at the write's parent",
        );
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    },
  );

  await t.step(
    "parent structural read converts the reshape into a clean ConflictError",
    async () => {
      const { engine, path } = await createEngine();
      try {
        setupReshape(engine);
        const err = assertThrows(
          () =>
            applyCommit(
              engine,
              aliceNestedPatch({
                id: "entity:doc",
                path: toDocumentPath(["value", "notes"]),
                seq: 1,
                nonRecursive: true,
              }),
            ),
          ConflictError,
          "stale confirmed read",
        );
        assertEquals(err.name, "ConflictError");
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    },
  );
});
