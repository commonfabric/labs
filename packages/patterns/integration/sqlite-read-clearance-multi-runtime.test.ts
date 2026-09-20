/**
 * Multi-runtime regression test: CFC Phase 3.b read-time-clearance results
 * are READER-ISOLATED (#4478 review P0, fixed in 52e3e7e7).
 *
 * Two users (alice, bob) share one space and one rule-bearing SQLite db whose
 * rows each name their intended reader. Both runtimes run the same
 * `readClearance: true` query. Before the fix the cleared result landed in a
 * SPACE-scoped result cell keyed by a reader-blind request hash, so the
 * runtime that settled second either reused the other reader's filtered rows
 * (request-hash dedup) or clobbered them with its own — cross-reader
 * disclosure either way. The fix forces the cleared result to per-`user`
 * scope and keys the request hash by the acting reader.
 *
 * Asserts:
 * - each reader's cleared query returns EXACTLY the rows naming them;
 * - `withheld` is per-reader (each reader's own audit count);
 * - the cleared result cell resolves at scope "user" (isolated instance per
 *   reader on one shared link);
 * - the two readers' cleared request hashes DIFFER, while the non-clearance
 *   query keeps ONE shared hash (non-clearance queries unchanged);
 * - two SESSIONS of one reader (alice's Identity in two harness sessions —
 *   two browser tabs) SHARE the user-granularity cleared result and its
 *   request hash: the session joins the request identity only BELOW user
 *   scope (RULED 2026-08-22, verification-coverage.md OW53), so a
 *   user-scoped cleared read stays session-blind in both arms.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "sqlite-read-clearance",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

interface NoteRow {
  id: number;
  reader: string;
  body: string;
}

interface QueryState {
  pending?: boolean;
  result?: NoteRow[];
  error?: unknown;
  withheld?: number;
}

async function queryState(
  session: MultiRuntimeSession,
  key: string,
): Promise<QueryState> {
  return ((await session.read([key])) ?? {}) as QueryState;
}

/** Whether `key` has settled in `session` on exactly `rows` admitted rows. */
async function settled(
  session: MultiRuntimeSession,
  key: string,
  rows: number,
): Promise<boolean> {
  const state = await queryState(session, key);
  return state.pending === false && state.error === undefined &&
    (state.result?.length ?? -1) === rows;
}

/**
 * The steady state the seeded table settles to — one entry per session and
 * query, naming the rows that session's reader is admitted.
 */
const STEADY_ROWS: readonly [label: string, key: string, rows: number][] = [
  ["alice", "qAll", 3],
  ["bob", "qAll", 3],
  ["alice", "qClear", 2],
  ["bob", "qClear", 1],
  ["alice-tab2", "qClear", 2],
];

describe("sqlite read-time clearance across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let alice: MultiRuntimeSession;
  let bob: MultiRuntimeSession;
  let aliceTab2: MultiRuntimeSession;

  beforeAll(async () => {
    // One Identity in two harness sessions = one user with two concurrent
    // sessions (two browser tabs) — the construction the session-identity
    // ruling's user-scoped arm is pinned against below.
    const aliceIdentity = await Identity.fromPassphrase(
      "multi-runtime-harness alice",
      { implementation: "noble" },
    );
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        { label: "alice", identity: aliceIdentity },
        "bob",
        { label: "alice-tab2", identity: aliceIdentity },
      ],
    });
    alice = harness.session("alice");
    bob = harness.session("bob");
    aliceTab2 = harness.session("alice-tab2");

    // One writer seeds rows for BOTH readers (the write gate labels each row
    // from its own data; it does not require the writer to be a reader). The
    // seeded table is the fixture every step reads, not the first step's side
    // effect: CI selects individual tests, so a step run without its
    // neighbors has to find the same table they do.
    await alice.send("seed", {
      rows: [
        { reader: alice.identity.did(), body: "alice-1" },
        { reader: alice.identity.did(), body: "alice-2" },
        { reader: bob.identity.did(), body: "bob-only" },
      ],
    });
    for (const [label, key, rows] of STEADY_ROWS) {
      await harness.waitFor(
        `${label}'s ${key} settles on ${rows} rows`,
        () => settled(harness.session(label), key, rows),
      );
    }
  });

  afterAll(async () => {
    await harness?.dispose();
  });

  it("returns each reader only their own admissible rows", async () => {
    const aliceDid = alice.identity.did();
    const bobDid = bob.identity.did();

    // Baseline sanity: without clearance BOTH readers see all three rows —
    // the table is genuinely shared, so any qClear narrowing is clearance-made.
    const wholeTable = ["alice-1", "alice-2", "bob-only"];
    assertEquals(
      (await queryState(alice, "qAll")).result?.map((r) => r.body),
      wholeTable,
      "alice sees the whole table without clearance",
    );
    assertEquals(
      (await queryState(bob, "qAll")).result?.map((r) => r.body),
      wholeTable,
      "bob sees the whole table without clearance",
    );

    // THE POINT — the cleared query is per-reader: each runtime's acting
    // principal admits exactly the rows naming it, with a per-reader
    // withheld audit count.
    const aliceClear = await queryState(alice, "qClear");
    assertEquals(
      aliceClear.result?.map((r) => r.body),
      ["alice-1", "alice-2"],
      "alice must see exactly her rows",
    );
    assert(
      aliceClear.result!.every((r) => r.reader === aliceDid),
      "every row alice sees must name alice as its reader",
    );
    assertEquals(aliceClear.withheld, 1, "alice's withheld count (bob's row)");

    const bobClear = await queryState(bob, "qClear");
    assertEquals(
      bobClear.result?.map((r) => r.body),
      ["bob-only"],
      "bob must see exactly his row",
    );
    assert(
      bobClear.result!.every((r) => r.reader === bobDid),
      "every row bob sees must name bob as its reader",
    );
    assertEquals(bobClear.withheld, 2, "bob's withheld count (alice's rows)");
  });

  it("isolates the cleared result cell per user and keys the request hash by reader", async () => {
    // One shared link, per-user instances: the cleared result cell must
    // resolve at scope "user" in both runtimes (a space-scoped cell is the
    // pre-fix shared-result leak).
    const aliceLink = await alice.link(["qClear"]);
    const bobLink = await bob.link(["qClear"]);
    assertEquals(aliceLink.scope, "user", "alice's cleared result scope");
    assertEquals(bobLink.scope, "user", "bob's cleared result scope");
    assertEquals(
      aliceLink.id,
      bobLink.id,
      "same base entity — isolation comes from the per-user scope partition",
    );

    // Belt-and-suspenders: a cleared result's request hash includes the
    // acting reader, so the two runtimes must record DIFFERENT hashes (a
    // shared reader-blind hash is what let one reader dedup against the
    // other's rows). requestHash is not in the declared result schema, so
    // read it raw.
    const aliceClearRaw = await alice.readRaw(["qClear"]) as QueryState & {
      requestHash?: string;
    };
    const bobClearRaw = await bob.readRaw(["qClear"]) as QueryState & {
      requestHash?: string;
    };
    assert(aliceClearRaw.requestHash, "alice's cleared query recorded a hash");
    assert(bobClearRaw.requestHash, "bob's cleared query recorded a hash");
    assertNotEquals(
      aliceClearRaw.requestHash,
      bobClearRaw.requestHash,
      "cleared request hashes must be keyed by the acting reader",
    );

    // Contrast: the non-clearance query stays reader-blind — one shared
    // space-scoped result cell, one shared hash (the fix must not re-scope or
    // re-hash plain queries).
    const aliceAllLink = await alice.link(["qAll"]);
    assertEquals(aliceAllLink.scope, "space", "baseline result stays shared");
    const aliceAllRaw = await alice.readRaw(["qAll"]) as {
      requestHash?: string;
    };
    const bobAllRaw = await bob.readRaw(["qAll"]) as { requestHash?: string };
    assert(aliceAllRaw.requestHash, "baseline query recorded a hash");
    assertEquals(
      aliceAllRaw.requestHash,
      bobAllRaw.requestHash,
      "baseline request hash stays reader-blind",
    );
  });

  it("releases nothing about withheld rows beyond the declared surface", async () => {
    // §6 E3 (docs/history/plans/cfc-future-work-implementation.md): "the
    // withheld-count is not observable in the result shape beyond the
    // declared release". The raw stored doc — read with NO result-schema
    // shaping, so it is the query's ENTIRE observable surface — must carry
    // exactly the declared release: the kept rows, the withheld count, and
    // the request bookkeeping. Withheld rows leave no artifacts: no
    // placeholder slots, no index gaps, no ids, no content.
    const bobRaw = await bob.readRaw(["qClear"]) as Record<string, unknown>;
    assertEquals(
      Object.keys(bobRaw).sort(),
      ["pending", "requestHash", "result", "withheld"],
      "the cleared result doc carries ONLY the declared surface",
    );
    const bobRows = bobRaw.result as unknown[];
    assertEquals(bobRows.length, 1, "kept rows only — no per-withheld slots");
    assert(
      bobRows.every((r) => r !== null && r !== undefined),
      "the kept-row array is dense — no placeholder gaps",
    );
    // Content opacity: nothing reachable in bob's raw doc mentions a
    // withheld row (kept rows split into per-row link docs, so the doc
    // itself holds no row content — a leak would surface right here).
    const bobFlat = JSON.stringify(bobRaw);
    for (const leaked of ["alice-1", "alice-2"]) {
      assert(
        !bobFlat.includes(leaked),
        `withheld row content "${leaked}" leaked into bob's raw result doc`,
      );
    }

    const aliceRaw = await alice.readRaw(["qClear"]) as Record<string, unknown>;
    assertEquals(
      Object.keys(aliceRaw).sort(),
      ["pending", "requestHash", "result", "withheld"],
      "the cleared result doc carries ONLY the declared surface",
    );
    assertEquals((aliceRaw.result as unknown[]).length, 2);
    assert(
      !JSON.stringify(aliceRaw).includes("bob-only"),
      "withheld row content leaked into alice's raw result doc",
    );

    // The boundary in the other direction: a NON-clearance query result
    // carries no clearance artifact at all — `withheld` is absent, not 0.
    const allRaw = await alice.readRaw(["qAll"]) as Record<string, unknown>;
    assertEquals(
      Object.keys(allRaw).sort(),
      ["pending", "requestHash", "result"],
      "a non-clearance result must not carry a withheld field",
    );
  });

  it("shares one user-granularity cleared cell across two sessions of one user", async () => {
    // The unchanged arm of the session-identity ruling (RULED 2026-08-22,
    // verification-coverage.md OW53): at USER granularity the session never
    // joins the request identity, so alice's second session resolves the
    // SAME user-scoped cleared cell and the SAME reader-keyed hash — the
    // sharing IS the contract (one cleared cell per
    // query-and-reader-at-matching-granularity). A fix that joined the
    // session above user scope would split these hashes; this step is the
    // live-topology guard against that regression, in both arms (OFF: both
    // tabs hash their own — identical — ambient reader; ON: one served
    // user-granularity identity).
    assertEquals(
      aliceTab2.identity.did(),
      alice.identity.did(),
      "one user, two tabs",
    );

    const tab2Clear = await queryState(aliceTab2, "qClear");
    assertEquals(
      tab2Clear.result?.map((r) => r.body),
      ["alice-1", "alice-2"],
      "the second session sees exactly alice's rows",
    );
    assertEquals(tab2Clear.withheld, 1, "alice's withheld count, both tabs");

    // One shared user-scoped instance — same base entity, same scope, and
    // (the request identity half) the SAME reader-keyed request hash.
    const aliceLink = await alice.link(["qClear"]);
    const tab2Link = await aliceTab2.link(["qClear"]);
    assertEquals(tab2Link.scope, "user", "tab2's cleared result scope");
    assertEquals(tab2Link.id, aliceLink.id, "one base entity across tabs");
    const aliceClearRaw = await alice.readRaw(["qClear"]) as {
      requestHash?: string;
    };
    const tab2ClearRaw = await aliceTab2.readRaw(["qClear"]) as {
      requestHash?: string;
    };
    assert(aliceClearRaw.requestHash, "alice's cleared query recorded a hash");
    assertEquals(
      tab2ClearRaw.requestHash,
      aliceClearRaw.requestHash,
      "a user-scoped cleared request identity is session-blind",
    );
  });
});
