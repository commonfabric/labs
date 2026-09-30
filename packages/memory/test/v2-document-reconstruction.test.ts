/**
 * What a run of patch commits costs the engine in replayed patch rows.
 *
 * A patch commit stores the patch, not the document it produces, so anything
 * that wants the document back replays a chain of them. Commits want it:
 * snapshot materialization reads the revision the commit has just written, and
 * that read is where a document under a run of patch commits is rebuilt over
 * and over. A rebuild that starts at the document's base or snapshot decodes
 * the whole document and replays every row since — up to `snapshotInterval` of
 * them, so the run's cost is its length times the interval, plus a document
 * decode per commit. A rebuild that starts at the revision before it replays
 * one row and decodes nothing.
 *
 * The count is the engine's `patchReplays`, which rises by one for each stored
 * patch row a rebuild applies.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  close,
  documentCacheDiagnostics,
  type Engine,
  evictDocumentCacheEntries,
  open,
  type OpenOptions,
  read,
} from "../v2/engine.ts";
import { SYNC_SCHEMA_REF_PREFIX } from "../v2/sync-schema-ref.ts";

/** The one document every test here installs and then patches. */
const ENTITY = "of:doc";

/** Patch rows per materialized snapshot, stated rather than inherited. */
const SNAPSHOT_INTERVAL = 10;

/** Patch commits each run applies: four snapshots' worth and a tail. */
const PATCH_COMMITS = SNAPSHOT_INTERVAL * 4 + 7;

/** Snapshots those commits materialize. */
const SNAPSHOTS = Math.floor(PATCH_COMMITS / SNAPSHOT_INTERVAL);

/** Patch commits after the newest snapshot. */
const TAIL = PATCH_COMMITS % SNAPSHOT_INTERVAL;

/** Sequence numbers the run's snapshots are taken at. The install holds seq 1
 * and each patch commit the next, so the snapshot due at the interval's nth
 * multiple is taken one seq past it. */
const SNAPSHOT_SEQS = Array.from(
  { length: SNAPSHOTS },
  (_, index) => (index + 1) * SNAPSHOT_INTERVAL + 1,
);

/** Rows the same run replays with nothing resident: every row back to the
 * base or snapshot, once per commit. Each snapshot cycle replays one row,
 * then two, up to the interval, and the tail does the same as far as it
 * reaches. */
const triangle = (n: number) => n * (n + 1) / 2;
const UNCACHED_REPLAYS = SNAPSHOTS * triangle(SNAPSHOT_INTERVAL) +
  triangle(TAIL);

const commit = (localSeq: number, operations: unknown[]) =>
  ({
    localSeq,
    reads: { confirmed: [], pending: [] },
    operations,
  }) as never;

const install = (engine: Engine): void => {
  applyCommit(engine, {
    sessionId: "s:a",
    commit: commit(1, [{
      op: "set",
      id: ENTITY,
      value: { value: { rows: ["a", "b", "c"], n: 0, m: 0 } },
    }]),
  } as never);
};

/** Installs the document, then replaces one field once per patch commit. */
const installThenPatch = (engine: Engine): void => {
  install(engine);
  for (let index = 1; index <= PATCH_COMMITS; index++) {
    applyCommit(engine, {
      sessionId: "s:a",
      commit: commit(index + 1, [{
        op: "patch",
        id: ENTITY,
        patches: [{ op: "replace", path: "/value/n", value: index }],
      }]),
    } as never);
  }
};

/** Snapshots the run materialized, oldest first. */
const snapshotSeqs = (engine: Engine): number[] =>
  engine.database.prepare(
    `SELECT seq FROM snapshot WHERE id = ? ORDER BY seq`,
  ).all<{ seq: number }>(ENTITY).map((row) => row.seq);

const withEngine = async (
  fn: (engine: Engine) => void,
  options: Omit<OpenOptions, "url"> = {},
): Promise<void> => {
  const path = await Deno.makeTempFile({ suffix: ".sqlite" });
  const engine = await open({
    url: toFileUrl(path),
    snapshotInterval: SNAPSHOT_INTERVAL,
    // Every snapshot the run materializes is kept, so the seqs below are what
    // was written rather than what survived compaction.
    snapshotRetention: SNAPSHOTS,
    ...options,
  });
  try {
    fn(engine);
  } finally {
    close(engine);
    await Deno.remove(path);
  }
};

describe("v2 document reconstruction", () => {
  it("replays one row per patch commit, not the chain behind it", async () => {
    await withEngine((engine) => {
      installThenPatch(engine);

      expect(documentCacheDiagnostics(engine).patchReplays).toBe(PATCH_COMMITS);
    });
  });

  it("replays the chain for a document the cache retains nothing of", async () => {
    // A budget below any document's weight declines every entry, which is the
    // regime an operator is reading `patchReplays` against `misses` to find.
    await withEngine((engine) => {
      installThenPatch(engine);
      const { patchReplays, misses } = documentCacheDiagnostics(engine);

      expect(patchReplays).toBe(UNCACHED_REPLAYS);
      expect(patchReplays).toBeGreaterThan(misses);
    }, { documentCacheBudgetBytes: 1 });
  });

  it("replays from the newest snapshot for a document nothing holds", async () => {
    await withEngine((engine) => {
      installThenPatch(engine);
      const resident = documentCacheDiagnostics(engine).patchReplays;
      evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);
      read(engine, { id: ENTITY } as never);

      expect(documentCacheDiagnostics(engine).patchReplays - resident).toBe(
        TAIL,
      );
    });
  });

  it("materializes a snapshot every `snapshotInterval` patch commits", async () => {
    await withEngine((engine) => {
      installThenPatch(engine);

      expect(snapshotSeqs(engine)).toEqual(SNAPSHOT_SEQS);
    });
  });

  it("counts the rebuild a commit-time schema-reference check drives", async () => {
    // A commit whose serialization carries the reserved prefix anywhere — here
    // as ordinary text, in no schema position, so the check passes — rebuilds
    // the pre-state to look at it. That rebuild replays rows like any other.
    await withEngine((engine) => {
      install(engine);
      const patch = (localSeq: number, path: string, value: unknown) =>
        applyCommit(engine, {
          sessionId: "s:a",
          commit: commit(localSeq, [{
            op: "patch",
            id: ENTITY,
            patches: [{ op: "replace", path, value }],
          }]),
        } as never);

      patch(2, "/value/n", 1);
      const plain = documentCacheDiagnostics(engine).patchReplays;
      patch(3, "/value/rows/0", `${SYNC_SCHEMA_REF_PREFIX}not-a-schema`);

      expect(plain).toBe(1);
      expect(documentCacheDiagnostics(engine).patchReplays - plain).toBe(2);
    });
  });

  it("counts a patch row once however many operations it carries", async () => {
    await withEngine((engine) => {
      install(engine);
      applyCommit(engine, {
        sessionId: "s:a",
        commit: commit(2, [{
          op: "patch",
          id: ENTITY,
          patches: [
            { op: "replace", path: "/value/n", value: 1 },
            { op: "replace", path: "/value/m", value: 2 },
          ],
        }]),
      } as never);

      expect(documentCacheDiagnostics(engine).patchReplays).toBe(1);
      expect(read(engine, { id: ENTITY } as never)).toEqual({
        value: { rows: ["a", "b", "c"], n: 1, m: 2 },
      });
    });
  });
});
