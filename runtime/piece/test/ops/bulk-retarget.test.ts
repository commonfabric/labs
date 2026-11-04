/**
 * The retarget apply: preflight classification, the serial plan-order
 * apply over grouped sessions, the re-proof each row gets in its group's
 * own session, one retained-source load per session, resume as
 * re-invocation, the stop that names its remainder — a session boundary
 * that fails once outcomes exist among the stops — and the refusals — a
 * plan surveyed against another space, a source resolving off its recorded
 * reference, foreign operations, incomplete plans. Sessions come
 * from a counting factory whose close defers disposal: the emulated store
 * lives in its runtimes, so the boundaries are observed while the state
 * survives; the drill exercises real disposal against a real server.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, type DID, Identity } from "@commonfabric/identity";
import { Runtime, setPatternSource } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "../../src/ops/bulk-local.deno.ts";
import {
  type ApplyReport,
  type ApplyRow,
  type ApplySessions,
  retargetPieces,
} from "../../src/ops/bulk-retarget.deno.ts";
import type {
  PiecePlan,
  PiecePlanRow,
  RetargetOp,
} from "../../src/ops/bulk-plan.ts";
import { readPiecePin } from "../../src/ops/bulk-survey.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("bulk retarget");

/** A generation's source text; `version` is what tells generations apart. */
function memberSource(version: string): string {
  return [
    "import { NAME, pattern } from 'commonfabric';",
    "export default pattern<{ seed?: string }>(({ seed }) => ({",
    "  [NAME]: 'Member',",
    `  version: ${JSON.stringify(version)},`,
    "  seed,",
    "}));",
    "",
  ].join("\n");
}

describe("bulk-retarget", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: DID;
  let runtimes: Runtime[];
  let opens: number;
  let closes: number;
  let sessions: ApplySessions;
  let dir: string;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    space = await storageManager.createSpace({ [signer.did()]: "OWNER" });
    runtimes = [];
    opens = 0;
    closes = 0;
    sessions = {
      open: () => openSession(),
      // Disposal deferred to afterEach: the emulated store lives in its
      // runtimes, so closing for real would lose the space between groups.
      // The boundary itself — one close per open — is still observed.
      close: () => {
        closes += 1;
        return Promise.resolve();
      },
    };
    dir = await Deno.makeTempDir({ prefix: "bulk-retarget-src" });
    await Deno.writeTextFile(`${dir}/member-v1.tsx`, memberSource("one"));
    await Deno.writeTextFile(`${dir}/member-v2.tsx`, memberSource("two"));
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await storageManager.close();
    await Deno.remove(dir, { recursive: true });
  });

  /**
   * A counted session over `name`, the space under test by default. Every
   * open a run sees comes through here, so the open and close counts stay
   * comparable however a test bends the factory.
   */
  async function openSession(
    spaceDid: DID = space,
  ): Promise<PiecesController> {
    opens += 1;
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    runtimes.push(runtime);
    const pieces = new PiecesController(
      createSession({ identity: signer, spaceDid }),
      runtime,
    );
    await pieces.synced();
    return pieces;
  }

  /** Create `count` pieces on v1 and the plan retargeting them to v2. */
  async function seed(
    count: number,
  ): Promise<{ plan: PiecePlan; ids: string[] }> {
    const setup = await sessions.open();
    const v1 = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/member-v1.tsx`,
    });
    const v2 = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/member-v2.tsx`,
    });
    const v1id = await programEntryIdentity(v1);
    const v2id = await programEntryIdentity(v2);
    const space = setup.getSpace();
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const piece = await setup.create(v1, { input: { seed: `s${index}` } });
      ids.push(piece.id);
    }
    await setup.synced();
    await sessions.close(setup);
    const rows: PiecePlanRow[] = ids.map((piece) => ({
      piece,
      phase: "items",
      expect: { patternIdentity: v1id, symbol: "default", retained: true },
      op: {
        kind: "retarget",
        source: { main: `${dir}/member-v2.tsx` },
        patternIdentity: v2id,
        symbol: "default",
      } satisfies RetargetOp,
    }));
    return {
      plan: {
        header: {
          kind: "piece-plan",
          v: 1,
          space,
          takenAt: "2026-08-25T00:00:00.000Z",
          selector: "collection",
          enumerated: {
            collection: count,
            registry: count,
            registeredOutside: 0,
          },
        },
        rows,
      },
      ids,
    };
  }

  async function pinOf(piece: string) {
    const reader = await sessions.open();
    const pin = await readPiecePin(reader, piece);
    await sessions.close(reader);
    return pin;
  }

  /**
   * Sessions whose `nth` close rejects: the boundary failure a run must
   * survive with the outcomes it already holds, counting the preflight's
   * close as the first.
   */
  function failingCloseAt(nth: number): ApplySessions {
    let attempts = 0;
    return {
      open: () => sessions.open(),
      close: (pieces) => {
        attempts += 1;
        if (attempts === nth) {
          return Promise.reject(new Error("the session would not release"));
        }
        return sessions.close(pieces);
      },
    };
  }

  /**
   * Sessions whose first apply-session read of `victim` is preceded by
   * another writer putting `main` on it — the race a group session's own
   * read is there to catch.
   */
  function raceTo(main: string, victim: string): ApplySessions {
    let raced = false;
    let sessionIndex = 0;
    return {
      open: async () => {
        sessionIndex += 1;
        const applySession = sessionIndex >= 2;
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get") {
              return async (id: string, run?: boolean) => {
                if (id === victim && !raced && applySession) {
                  raced = true;
                  const program = await resolveLocalSourceProgram(
                    pieces.runtime,
                    { main },
                  );
                  const piece = await target.get(id, false);
                  await piece.setPattern(program, {
                    dangerouslyAllowIncompatibleSchema: true,
                  });
                  await pieces.synced();
                }
                return target.get(id, run);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };
  }

  /**
   * Sessions in which another writer changes `victim`'s ORIGIN — and only
   * its origin — between the engine's classifying read and the write step's
   * own. The pattern reference is untouched, so the row still classifies as
   * outstanding and the write still commits; what moves is the value the
   * write detaches, which is the reading the report has to take from the
   * write rather than from the plan.
   */
  function changeOriginBeforeWrite(
    victim: string,
    origin: string,
  ): ApplySessions {
    let sessionIndex = 0;
    return {
      open: async () => {
        sessionIndex += 1;
        const applySession = sessionIndex >= 2;
        let reads = 0;
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get") {
              return async (id: string, run?: boolean) => {
                if (id === victim && applySession) {
                  reads += 1;
                  // The engine reads once to classify the row, and the write
                  // step reads again to write it. Landing on the second is
                  // landing inside the window the write itself closes.
                  if (reads === 2) {
                    const piece = await target.get(id, false);
                    const { error } = await pieces.runtime.editWithRetry(
                      (tx) => {
                        setPatternSource(piece.getCell(), tx, origin);
                      },
                    );
                    if (error !== undefined) throw error;
                    await pieces.synced();
                  }
                }
                return target.get(id, run);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };
  }

  it("classifies every row from one preflight read on a dry run", async () => {
    const { plan } = await seed(2);
    const before = { opens, closes };

    const report = await retargetPieces(sessions, { plan });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "outstanding",
    ]);
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(true);
    // The dry run is the preflight alone: one session, opened and closed.
    expect(opens - before.opens).toBe(1);
    expect(closes - before.closes).toBe(1);
  });

  it("applies serially over bounded session groups, and reports timing", async () => {
    const { plan, ids } = await seed(3);
    const before = { opens, closes };
    const seen: string[] = [];
    let tick = 0;

    const report = await retargetPieces(sessions, {
      plan,
      apply: true,
      groupSize: 2,
      onRow: (row) => seen.push(`${row.verdict}:${row.piece}`),
      now: () => tick += 5,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    expect(report.applied).toBe(3);
    expect(report.complete).toBe(true);
    expect(report.rows.every((row) => row.elapsedMs !== undefined)).toBe(true);
    expect(seen.length).toBe(3);
    // Preflight plus ceil(3/2) groups: three sessions, each closed.
    expect(opens - before.opens).toBe(3);
    expect(closes - before.closes).toBe(3);

    const pin = await pinOf(ids[0]);
    expect(pin?.patternIdentity).toBe(
      (plan.rows[0].op as RetargetOp).patternIdentity,
    );
  });

  it("carries the plan's origin onto every report row, and the write detaches it", async () => {
    const { plan, ids } = await seed(1);
    const origin = "https://origins.test/member.tsx";
    const stamper = await sessions.open();
    const target = await stamper.get(ids[0], false);
    const { error } = await stamper.runtime.editWithRetry((tx) => {
      setPatternSource(target.getCell(), tx, origin);
    });
    if (error !== undefined) throw error;
    await stamper.synced();
    await sessions.close(stamper);
    const following: PiecePlan = {
      header: plan.header,
      rows: [{
        ...plan.rows[0],
        expect: { ...plan.rows[0].expect, origin },
      }],
    };

    const dry = await retargetPieces(sessions, { plan: following });
    const applied = await retargetPieces(sessions, {
      plan: following,
      apply: true,
    });

    // The dry run has no write to report, so it carries the plan's record
    // and nothing about a detach — that being the only moment the detach is
    // still a decision.
    expect(dry.rows[0].verdict).toBe("outstanding");
    expect(dry.rows[0].origin).toBe(origin);
    expect(dry.rows[0].detachedOrigin).toBeUndefined();
    // The applied row carries both, and here they agree: nothing moved the
    // origin between the survey and the write.
    expect(applied.rows[0].verdict).toBe("applied");
    expect(applied.rows[0].origin).toBe(origin);
    expect(applied.rows[0].detachedOrigin).toBe(origin);
    // What the report records is a real detach: the piece follows nothing
    // afterwards, and re-attaching it is by hand from the string the row
    // carried.
    expect((await pinOf(ids[0]))?.origin).toBeUndefined();
  });

  it("reports the origin the write detached, not the one the plan recorded", async () => {
    const { plan, ids } = await seed(1);
    const recorded = "https://origins.test/recorded.tsx";
    const live = "https://origins.test/live.tsx";
    const stamper = await sessions.open();
    const target = await stamper.get(ids[0], false);
    const { error } = await stamper.runtime.editWithRetry((tx) => {
      setPatternSource(target.getCell(), tx, recorded);
    });
    if (error !== undefined) throw error;
    await stamper.synced();
    await sessions.close(stamper);
    const following: PiecePlan = {
      header: plan.header,
      rows: [{
        ...plan.rows[0],
        expect: { ...plan.rows[0].expect, origin: recorded },
      }],
    };

    const report = await retargetPieces(
      changeOriginBeforeWrite(ids[0], live),
      { plan: following, apply: true },
    );

    // Only the reference is a precondition, so moving the origin alone does
    // not refuse the row — the write lands and detaches what it found.
    expect(report.rows[0].verdict).toBe("applied");
    expect(report.rows[0].detachedOrigin).toBe(live);
    // The plan's reading survives beside it rather than being overwritten:
    // an operator whose plan said one thing while the run did another is
    // owed both, the disagreement being what tells them the plan went stale.
    expect(report.rows[0].origin).toBe(recorded);
    expect((await pinOf(ids[0]))?.origin).toBeUndefined();
  });

  it("reports no detached origin when the write found the piece already detached", async () => {
    const { plan, ids } = await seed(1);
    const recorded = "https://origins.test/recorded.tsx";
    const stamper = await sessions.open();
    const target = await stamper.get(ids[0], false);
    const { error } = await stamper.runtime.editWithRetry((tx) => {
      setPatternSource(target.getCell(), tx, recorded);
    });
    if (error !== undefined) throw error;
    await stamper.synced();
    // Somebody detaches the piece by hand between the survey and the run.
    await target.changeSource({ kind: "detach" });
    await stamper.synced();
    await sessions.close(stamper);
    const following: PiecePlan = {
      header: plan.header,
      rows: [{
        ...plan.rows[0],
        expect: { ...plan.rows[0].expect, origin: recorded },
      }],
    };

    const report = await retargetPieces(sessions, {
      plan: following,
      apply: true,
    });

    // The row's write detached nothing, and reporting the recorded origin as
    // detached would send an operator re-attaching an origin this run never
    // touched. The plan's reading stays, labelled as the plan's.
    expect(report.rows[0].verdict).toBe("applied");
    expect(report.rows[0].detachedOrigin).toBeUndefined();
    expect(report.rows[0].origin).toBe(recorded);
  });

  it("resumes as a re-invocation: landed rows are not rewritten", async () => {
    const { plan } = await seed(2);
    await retargetPieces(sessions, { plan, apply: true });

    const again = await retargetPieces(sessions, { plan, apply: true });

    expect(again.rows.map((row) => row.verdict)).toEqual([
      "landed",
      "landed",
    ]);
    expect(again.applied).toBe(0);
    expect(again.complete).toBe(true);
  });

  it("does not start when preflight finds a piece on neither reference", async () => {
    const { plan, ids } = await seed(2);
    // Something other than the plan moves the second piece: a third
    // generation neither recorded nor produced by its row.
    await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));
    const mover = await sessions.open();
    const v3 = await resolveLocalSourceProgram(mover.runtime, {
      main: `${dir}/member-v3.tsx`,
    });
    const moved = await mover.get(ids[1], false);
    await moved.setPattern(v3);
    await mover.synced();
    await sessions.close(mover);

    const report = await retargetPieces(sessions, { plan, apply: true });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "moved-elsewhere",
    ]);
    expect(report.rows[1].problem).toContain("neither");
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      plan.rows[0].expect.patternIdentity,
    );
  });

  it("refuses a source that no longer produces the recorded reference", async () => {
    const { plan, ids } = await seed(3);
    // The source file changes after the plan was reviewed: the recomputed
    // identity disagrees with the row, and the row before it has landed.
    const tampered: PiecePlan = {
      header: plan.header,
      rows: plan.rows.map((row, index) =>
        index === 1
          ? {
            ...row,
            op: {
              ...(row.op as RetargetOp),
              patternIdentity: "I".padEnd(43, "x"),
            },
          }
          : row
      ),
    };

    const report = await retargetPieces(sessions, {
      plan: tampered,
      apply: true,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "refused",
      "unattempted",
    ]);
    expect(report.rows[1].problem).toContain("resolves to");
    // The refused row was attempted — its reads and resolution ran — so it
    // reports what it cost; the row after the stop was not.
    expect(typeof report.rows[1].elapsedMs).toBe("number");
    expect(report.rows[2].elapsedMs).toBeUndefined();
    expect(report.applied).toBe(1);
    expect(report.complete).toBe(false);
    expect((await pinOf(ids[2]))?.patternIdentity).toBe(
      plan.rows[2].expect.patternIdentity,
    );
  });

  it("stops on a mid-run failure, names the rest, and completes on re-invocation", async () => {
    const { plan, ids } = await seed(3);
    // The second apply-session read of the middle piece fails once: the
    // run stops there with the tail named, and the same invocation later
    // completes from where it stood.
    // The failure holds for the whole armed session, so the state check's
    // own re-read fails too and the row honestly reports unknown state.
    let armed = false;
    const flaky: ApplySessions = {
      open: async () => {
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get" && armed) {
              return (id: string, run?: boolean) => {
                if (id === ids[1]) {
                  return Promise.reject(new Error("the connection dropped"));
                }
                return target.get(id, run);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };
    const arm = () => {
      armed = true;
    };

    const first: ApplyReport = await (async () => {
      const preflightAware: ApplySessions = {
        open: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 2) arm();
            return await flaky.open();
          };
        })(),
        close: flaky.close,
      };
      return await retargetPieces(preflightAware, { plan, apply: true });
    })();

    expect(first.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "failed",
      "unattempted",
    ]);
    expect(first.rows[1].problem).toContain("the connection dropped");
    expect(first.rows[1].problem).toContain("state is unknown");
    expect(first.rows[2].piece).toBe(ids[2]);
    expect(first.complete).toBe(false);

    const resumed = await retargetPieces(sessions, { plan, apply: true });
    expect(resumed.rows.map((row) => row.verdict)).toEqual([
      "landed",
      "applied",
      "applied",
    ]);
    expect(resumed.applied).toBe(2);
    expect(resumed.complete).toBe(true);
  });

  it("blocks the start on a preflight read failure, naming the row", async () => {
    const { plan, ids } = await seed(2);
    const flaky: ApplySessions = {
      open: async () => {
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get") {
              return (id: string, run?: boolean) => {
                if (id === ids[1]) {
                  return Promise.reject(new Error("the connection dropped"));
                }
                return target.get(id, run);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };

    const report = await retargetPieces(flaky, { plan, apply: true });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "failed",
    ]);
    expect(report.rows[1].problem).toContain("the run did not start");
    expect(report.applied).toBe(0);
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      plan.rows[0].expect.patternIdentity,
    );
  });

  it("names every unattempted piece across the groups a stop skips", async () => {
    const { plan, ids } = await seed(4);
    const tampered: PiecePlan = {
      header: {
        ...plan.header,
        enumerated: { ...plan.header.enumerated, collection: 4, registry: 4 },
      },
      rows: plan.rows.map((row, index) =>
        index === 1
          ? {
            ...row,
            op: {
              ...(row.op as RetargetOp),
              patternIdentity: "I".padEnd(43, "x"),
            },
          }
          : row
      ),
    };

    const report = await retargetPieces(sessions, {
      plan: tampered,
      apply: true,
      groupSize: 2,
    });

    // The stop lands inside group one; group two is never opened, and its
    // rows are named rather than counted.
    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "refused",
      "unattempted",
      "unattempted",
    ]);
    expect(report.rows[2].piece).toBe(ids[2]);
    expect(report.rows[3].piece).toBe(ids[3]);
  });

  it("names the remainder when a group's session cannot be opened", async () => {
    const { plan, ids } = await seed(3);
    const before = { opens, closes };
    let attempts = 0;
    // Preflight and the first apply group open; the second group's session
    // does not, after two writes have already been committed.
    const failingGroup: ApplySessions = {
      open: () => {
        attempts += 1;
        if (attempts === 3) {
          return Promise.reject(new Error("the session could not start"));
        }
        return sessions.open();
      },
      close: (pieces) => sessions.close(pieces),
    };

    const report = await retargetPieces(failingGroup, {
      plan,
      apply: true,
      groupSize: 2,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
      "unattempted",
    ]);
    expect(report.rows[2].piece).toBe(ids[2]);
    // No piece is at fault, so the reason is the run's rather than a row's.
    expect(report.rows[2].problem).toBeUndefined();
    expect(report.stopReason).toContain("the session could not start");
    expect(report.stopReason).toContain("could not be opened");
    // Nothing was written for it, so it carries no cost either.
    expect(report.rows[2].elapsedMs).toBeUndefined();
    expect(report.applied).toBe(2);
    expect(report.complete).toBe(false);
    // The session that never opened is never closed: the run's two live
    // sessions are its two closes.
    expect(opens - before.opens).toBe(2);
    expect(closes - before.closes).toBe(2);
    // The writes the first group committed are still committed.
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      (plan.rows[0].op as RetargetOp).patternIdentity,
    );
  });

  it("stops when a group's session serves another space", async () => {
    const { plan, ids } = await seed(3);
    const elsewhere = await storageManager.createSpace({
      [signer.did()]: "OWNER",
    });
    const before = { opens, closes };
    let attempts = 0;
    const strayGroup: ApplySessions = {
      open: () => {
        attempts += 1;
        // Preflight and the first apply group serve the plan's space; the
        // second group's session answers for the other one.
        return attempts === 3 ? openSession(elsewhere) : sessions.open();
      },
      close: (pieces) => sessions.close(pieces),
    };

    const report = await retargetPieces(strayGroup, {
      plan,
      apply: true,
      groupSize: 2,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
      "unattempted",
    ]);
    expect(report.rows[2].piece).toBe(ids[2]);
    // Untouched, not accused: the row is where the plan left it, and a run
    // that read the wrong space would report it moved by another writer.
    expect(report.rows[2].problem).toBeUndefined();
    expect(report.applied).toBe(2);
    expect(report.complete).toBe(false);
    expect(report.stopReason).toContain(plan.header.space);
    expect(report.stopReason).toContain(elsewhere);
    // The session opened, so it is released like any other.
    expect(opens - before.opens).toBe(3);
    expect(closes - before.closes).toBe(3);
    // The other space holds nothing at that address, this run included.
    const strayReader = await openSession(elsewhere);
    const strayPin = await readPiecePin(strayReader, ids[2]);
    await sessions.close(strayReader);
    expect(strayPin).toBeUndefined();
    // The row stands where it stood in the plan's own space.
    expect((await pinOf(ids[2]))?.patternIdentity).toBe(
      plan.rows[2].expect.patternIdentity,
    );
  });

  it("hands a row callback's throw back rather than failing the row it settled", async () => {
    const { plan, ids } = await seed(3);
    const before = { opens, closes };
    const seen: ApplyRow[] = [];
    let failure: unknown;

    // The reporter gives up on the first row whose write lands.
    const report = await retargetPieces(sessions, {
      plan,
      apply: true,
      groupSize: 2,
      onRow: (row) => {
        seen.push(row);
        if (row.verdict === "applied") {
          throw new Error("the reporter gave up");
        }
      },
    }).catch((error: unknown) => {
      failure = error;
      return undefined;
    });

    // One plan row, one report row: the piece whose write landed is never
    // also reported failed, and the run does not carry on past the throw.
    expect(seen.map((row) => row.verdict)).toEqual(["applied"]);
    expect(seen[0].piece).toBe(ids[0]);
    // The caller's own error reaches the caller, in place of a report.
    expect((failure as Error | undefined)?.message).toBe(
      "the reporter gave up",
    );
    expect(report).toBeUndefined();
    // The session in hand was released on the way out.
    expect(opens - before.opens).toBe(2);
    expect(closes - before.closes).toBe(2);
    // The write the caller was told about did land, and stands.
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      (plan.rows[0].op as RetargetOp).patternIdentity,
    );
  });

  it("releases a wrong-space group's session when a row callback throws", async () => {
    const { plan } = await seed(3);
    const elsewhere = await storageManager.createSpace({
      [signer.did()]: "OWNER",
    });
    const before = { opens, closes };
    let attempts = 0;
    const strayGroup: ApplySessions = {
      open: () => {
        attempts += 1;
        return attempts === 3 ? openSession(elsewhere) : sessions.open();
      },
      close: (pieces) => sessions.close(pieces),
    };

    // The reporter gives up exactly on the row the wrong-space group names.
    await expect(
      retargetPieces(strayGroup, {
        plan,
        apply: true,
        groupSize: 2,
        onRow: (row) => {
          if (row.verdict === "unattempted") {
            throw new Error("the reporter gave up");
          }
        },
      }),
    ).rejects.toThrow("the reporter gave up");

    // The run kept no session: the wrong-space one was released on the way
    // out, so every open this run made has its close.
    expect(opens - before.opens).toBe(3);
    expect(closes - before.closes).toBe(3);
  });

  it("names the remainder when a group's session cannot be released", async () => {
    const { plan, ids } = await seed(3);

    // Preflight releases; the first apply group's session does not, its two
    // writes already committed.
    const report = await retargetPieces(failingCloseAt(2), {
      plan,
      apply: true,
      groupSize: 2,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
      "unattempted",
    ]);
    expect(report.rows[2].piece).toBe(ids[2]);
    expect(report.stopReason).toContain("the session would not release");
    expect(report.stopReason).toContain("could not be released");
    expect(report.applied).toBe(2);
    expect(report.complete).toBe(false);
    // The writes the group committed outlive the failure that followed them.
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      (plan.rows[0].op as RetargetOp).patternIdentity,
    );
    expect((await pinOf(ids[1]))?.patternIdentity).toBe(
      (plan.rows[1].op as RetargetOp).patternIdentity,
    );
    // The named piece is untouched: its group never opened.
    expect((await pinOf(ids[2]))?.patternIdentity).toBe(
      plan.rows[2].expect.patternIdentity,
    );
  });

  it("reports a last group that cannot be released as an incomplete run", async () => {
    const { plan } = await seed(2);

    // Every row applied, and then the only apply group's session would not
    // release. There is no remainder to name, so the reason is all that
    // separates this from a clean completion — and it must.
    const report = await retargetPieces(failingCloseAt(2), {
      plan,
      apply: true,
    });

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
    ]);
    expect(report.applied).toBe(2);
    expect(report.complete).toBe(false);
    expect(report.stopReason).toContain("could not be released");
  });

  it("keeps the classification when the preflight session cannot be released", async () => {
    const { plan, ids } = await seed(2);

    const dry = await retargetPieces(failingCloseAt(1), { plan });

    expect(dry.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "outstanding",
    ]);
    expect(dry.applied).toBe(0);
    expect(dry.complete).toBe(false);
    expect(dry.stopReason).toContain("preflight session could not be released");

    // The same failure on an apply run blocks the start: the classification
    // is reported and nothing is written.
    const attempted = await retargetPieces(failingCloseAt(1), {
      plan,
      apply: true,
    });

    expect(attempted.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "outstanding",
    ]);
    expect(attempted.applied).toBe(0);
    expect(attempted.complete).toBe(false);
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      plan.rows[0].expect.patternIdentity,
    );
  });

  it("re-proves each row in its own group session: a race skips or stops", async () => {
    // Between preflight and a row's write, another writer moves pieces:
    // one onto the row's own target (skipped as landed, never rewritten),
    // and — in a second run — one onto a third generation (a stop).
    await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));

    const landedRace = await seed(2);
    const landed = await retargetPieces(
      raceTo(`${dir}/member-v2.tsx`, landedRace.ids[0]),
      { plan: landedRace.plan, apply: true },
    );
    expect(landed.rows.map((row) => row.verdict)).toEqual([
      "landed",
      "applied",
    ]);
    expect(landed.applied).toBe(1);
    // The skipped row was still attempted: the read that reclassified it
    // cost what it cost, and the row reports it.
    expect(typeof landed.rows[0].elapsedMs).toBe("number");

    const movedRace = await seed(2);
    const moved = await retargetPieces(
      raceTo(`${dir}/member-v3.tsx`, movedRace.ids[0]),
      { plan: movedRace.plan, apply: true },
    );
    expect(moved.rows.map((row) => row.verdict)).toEqual([
      "moved-elsewhere",
      "unattempted",
    ]);
    expect(moved.rows[0].problem).toContain("after preflight");
    expect(typeof moved.rows[0].elapsedMs).toBe("number");
    expect(moved.rows[1].elapsedMs).toBeUndefined();
    expect(moved.applied).toBe(0);
  });

  it("stops when a row preflight saw landed is moved before its group runs", async () => {
    // The preflight verdict decides nothing at write time: a row already on
    // its target when the run started is proved again in its group's
    // session, so a writer moving it in between is a stop rather than a
    // report of a completion that never happened.
    await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));
    const { plan, ids } = await seed(2);
    const lander = await sessions.open();
    const v2 = await resolveLocalSourceProgram(lander.runtime, {
      main: `${dir}/member-v2.tsx`,
    });
    const already = await lander.get(ids[0], false);
    await already.setPattern(v2);
    await lander.synced();
    await sessions.close(lander);

    const report = await retargetPieces(
      raceTo(`${dir}/member-v3.tsx`, ids[0]),
      { plan, apply: true },
    );

    expect(report.rows.map((row) => row.verdict)).toEqual([
      "moved-elsewhere",
      "unattempted",
    ]);
    expect(report.rows[0].problem).toContain("after preflight");
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
  });

  it("loads a retained source once per session rather than once per row", async () => {
    // Every row of a board on one generation shares one retained-source
    // load within a session: the cache is the session's, so the loads a run
    // pays are its session count, not its row count.
    let loads = 0;
    const counted: ApplySessions = {
      open: async () => {
        const pieces = await sessions.open();
        const patternManager = new Proxy(pieces.runtime.patternManager, {
          get(target, prop) {
            if (prop === "getPatternSourceProgramByIdentity") {
              return (
                ...args: Parameters<
                  typeof target.getPatternSourceProgramByIdentity
                >
              ) => {
                loads += 1;
                return target.getPatternSourceProgramByIdentity(...args);
              };
            }
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const runtime = new Proxy(pieces.runtime, {
          get(target, prop) {
            if (prop === "patternManager") return patternManager;
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "runtime") return runtime;
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };
    const { plan } = await seed(3);

    await retargetPieces(counted, { plan });
    // The dry run is the preflight session alone, and its three rows share
    // one generation.
    expect(loads).toBe(1);

    loads = 0;
    const report = await retargetPieces(counted, {
      plan,
      apply: true,
      groupSize: 2,
    });

    expect(report.applied).toBe(3);
    // Preflight plus two apply groups: one load each, not one per row.
    expect(loads).toBe(3);
  });

  it("honors the compatibility override from the row field alone", async () => {
    // The v2 here narrows the input schema, which the pattern-compatibility
    // gate refuses; only a row carrying the override may pass it.
    await Deno.writeTextFile(
      `${dir}/member-incompat.tsx`,
      [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ count?: number }>(({ count }) => ({",
        "  [NAME]: 'Member',",
        "  count,",
        "}));",
        "",
      ].join("\n"),
    );
    const { plan, ids } = await seed(1);
    const probe = await sessions.open();
    const incompat = await resolveLocalSourceProgram(probe.runtime, {
      main: `${dir}/member-incompat.tsx`,
    });
    const incompatId = await programEntryIdentity(incompat);
    await sessions.close(probe);
    const toIncompat = (allow: boolean): PiecePlan => ({
      header: plan.header,
      rows: [{
        ...plan.rows[0],
        op: {
          kind: "retarget",
          source: { main: `${dir}/member-incompat.tsx` },
          patternIdentity: incompatId,
          symbol: "default",
          ...(allow ? { allowIncompatible: true } : {}),
        },
      }],
    });

    const refused = await retargetPieces(sessions, {
      plan: toIncompat(false),
      apply: true,
    });
    expect(refused.rows[0].verdict).toBe("failed");
    expect(refused.rows[0].problem).toContain("still on its recorded");

    const allowed = await retargetPieces(sessions, {
      plan: toIncompat(true),
      apply: true,
    });
    expect(allowed.rows[0].verdict).toBe("applied");
    expect((await pinOf(ids[0]))?.patternIdentity).toBe(incompatId);
  });

  it("refuses a plan surveyed against another space", async () => {
    // A piece address names a piece within a space; replayed elsewhere, the
    // same addresses can name pieces the plan's reviewer never saw.
    const { plan, ids } = await seed(1);

    await expect(
      retargetPieces(sessions, {
        plan: {
          header: { ...plan.header, space: "did:key:somewhere-else" },
          rows: plan.rows,
        },
        apply: true,
      }),
    ).rejects.toThrow(
      `The plan names space did:key:somewhere-else; this run targets ` +
        `${plan.header.space}.`,
    );

    expect((await pinOf(ids[0]))?.patternIdentity).toBe(
      plan.rows[0].expect.patternIdentity,
    );
  });

  it("refuses foreign operations, empty work, and incomplete plans", async () => {
    const { plan } = await seed(1);
    await expect(
      retargetPieces(sessions, {
        plan: {
          header: plan.header,
          rows: [{
            ...plan.rows[0],
            expect: { ...plan.rows[0].expect, documentHash: "9f2c" },
            op: { kind: "repair", fixer: "f.ts", fixerIdentity: "impl-v1" },
          }],
        },
        apply: true,
      }),
    ).rejects.toThrow("retargets alone");
    await expect(
      retargetPieces(sessions, {
        plan: {
          header: plan.header,
          rows: [{ piece: plan.rows[0].piece, expect: plan.rows[0].expect }],
        },
      }),
    ).rejects.toThrow("nothing to apply");
    await expect(
      retargetPieces(sessions, {
        plan: {
          header: {
            ...plan.header,
            problems: [{ piece: "fid1:x", problem: "unreadable" }],
          },
          rows: plan.rows,
        },
      }),
    ).rejects.toThrow("incomplete plan");
    await expect(
      retargetPieces(sessions, { plan, groupSize: 0 }),
    ).rejects.toThrow("positive integer");
  });
  it("refuses a live run over a row whose prior source is not retained", async () => {
    // The reversibility gate, and it belongs here rather than at the
    // reversal: accepting "this piece cannot be rolled back" is only a
    // decision while the piece has not moved yet.
    const { plan, ids } = await seed(2);
    const unretained: PiecePlan = {
      header: plan.header,
      rows: plan.rows.map((row, index) =>
        index === 0
          ? { ...row, expect: { ...row.expect, retained: false } }
          : row
      ),
    };
    await expect(
      retargetPieces(sessions, { plan: unretained, apply: true }),
    ).rejects.toThrow("the prior source is not retained for " + ids[0]);
    // Nothing was written: the run never started.
    expect((await pinOf(ids[1]))?.patternIdentity).toBe(
      plan.rows[1].expect.patternIdentity,
    );
  });

  it("reports over an unretained row on a dry run, asking for no acceptance", async () => {
    // A dry run moves nothing, and reporting where such a piece stands is
    // how the operator finds out there is something to decide.
    const { plan } = await seed(2);
    const unretained: PiecePlan = {
      header: plan.header,
      rows: plan.rows.map((row, index) =>
        index === 0
          ? { ...row, expect: { ...row.expect, retained: false } }
          : row
      ),
    };
    const report = await retargetPieces(sessions, { plan: unretained });
    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "outstanding",
    ]);
    expect(report.complete).toBe(true);
  });

  it("runs an unretained row once the operator accepts it by name", async () => {
    const { plan, ids } = await seed(2);
    const unretained: PiecePlan = {
      header: plan.header,
      rows: plan.rows.map((row, index) =>
        index === 0
          ? { ...row, expect: { ...row.expect, retained: false } }
          : row
      ),
    };
    const report = await retargetPieces(sessions, {
      plan: unretained,
      accepted: [ids[0]],
      apply: true,
    });
    expect(report.applied).toBe(2);
    expect(report.complete).toBe(true);
  });

  it("refuses an acceptance that covers no unretained row of the plan", async () => {
    // An operator who believes they accounted for a piece must not be
    // accounting for none.
    const { plan, ids } = await seed(2);
    const unretained: PiecePlan = {
      header: plan.header,
      rows: plan.rows.map((row, index) =>
        index === 0
          ? { ...row, expect: { ...row.expect, retained: false } }
          : row
      ),
    };
    await expect(
      retargetPieces(sessions, {
        plan: unretained,
        accepted: [ids[1]],
        apply: true,
      }),
    ).rejects.toThrow("nothing accepts as unrollbackable for " + ids[1]);
  });
  it("refuses a piece another writer moved between the recheck and the write", async () => {
    // The window the engine's recheck alone cannot close. In one group
    // session the victim is read twice: once by the recheck that proves its
    // standing, once by the write itself. A writer landing between the two
    // is invisible to the recheck, and a write that adopted whatever it
    // found would commit over that change. The write carries the proved
    // reference as its own precondition instead, so the row is refused —
    // the same rule the rollback's write step holds to.
    const { plan, ids } = await seed(3);
    await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));
    const victim = ids[0];
    let gets = 0;
    let raced = false;
    let sessionIndex = 0;
    const raceBeforeWrite: ApplySessions = {
      open: async () => {
        sessionIndex += 1;
        const applySession = sessionIndex >= 2;
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get") {
              return async (id: string, run?: boolean) => {
                if (id === victim && applySession) {
                  gets += 1;
                  // The second read of this piece in the apply session is
                  // the write's own; the first was the recheck. Racing
                  // here lands exactly between them.
                  if (gets === 2 && !raced) {
                    raced = true;
                    const other = await resolveLocalSourceProgram(
                      pieces.runtime,
                      { main: `${dir}/member-v3.tsx` },
                    );
                    const piece = await target.get(id, false);
                    await piece.setPattern(other, {
                      dangerouslyAllowIncompatibleSchema: true,
                    });
                    await pieces.synced();
                  }
                }
                return target.get(id, run);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };
    const report = await retargetPieces(raceBeforeWrite, {
      plan,
      apply: true,
    });
    expect(raced).toBe(true);
    expect(report.rows[0].verdict).toBe("refused");
    expect(report.rows[0].problem).toContain("this write was proved against");
    // The other writer's change stands: the run stopped rather than writing
    // over something this plan never accounted for.
    const pin = await pinOf(victim);
    expect(pin?.patternIdentity).toBe(
      await programEntryIdentity(
        await resolveLocalSourceProgram((await sessions.open()).runtime, {
          main: `${dir}/member-v3.tsx`,
        }),
      ),
    );
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
    expect(report.rows[1].verdict).toBe("unattempted");
    expect(report.rows[2].verdict).toBe("unattempted");
  });
});
