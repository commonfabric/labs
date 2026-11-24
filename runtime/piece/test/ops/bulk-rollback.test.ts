/**
 * The rollback apply: a completed retarget reversed from its own plan, the
 * preconditions checked the way the retarget checks them, the resume that a
 * piece already back makes possible, and the refusals — a piece something
 * else moved, a reference the piece's own log does not hold, a plan
 * carrying operations this run does not apply.
 *
 * Sessions come from a counting factory whose close defers disposal: the
 * emulated store lives in its runtimes, so the boundaries are observed while
 * the state survives; the drill exercises real disposal against a real
 * server.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, type DID, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { ApplySessions } from "../../src/ops/bulk-apply.ts";
import {
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "../../src/ops/bulk-local.deno.ts";
import {
  deriveRollbackPlan,
  type PiecePlan,
  type PiecePlanRow,
  type RetargetOp,
} from "../../src/ops/bulk-plan.ts";
import { rollbackPieces } from "../../src/ops/bulk-rollback.ts";
import { readPiecePin } from "../../src/ops/bulk-survey.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("bulk rollback");

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

describe("bulk-rollback", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let space: DID;
  let runtimes: Runtime[];
  let sessions: ApplySessions;
  let dir: string;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    space = await storageManager.createSpace({ [signer.did()]: "OWNER" });
    runtimes = [];
    sessions = {
      open: () => openSession(),
      // Disposal deferred to afterEach: the emulated store lives in its
      // runtimes, so closing for real would lose the space between groups.
      close: () => Promise.resolve(),
    };
    dir = await Deno.makeTempDir({ prefix: "bulk-rollback-src" });
    await Deno.writeTextFile(`${dir}/member-v1.tsx`, memberSource("one"));
    await Deno.writeTextFile(`${dir}/member-v2.tsx`, memberSource("two"));
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await storageManager.close();
    await Deno.remove(dir, { recursive: true });
  });

  async function openSession(
    spaceDid: DID = space,
  ): Promise<PiecesController> {
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

  /**
   * Create `count` pieces on v1, move every one of them to v2, and return
   * the retarget plan that did it — the artifact a rollback is derived
   * from, with the moves already landed.
   */
  async function retargeted(
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
    const rows: PiecePlanRow[] = [];
    for (let index = 0; index < count; index += 1) {
      const piece = await setup.create(v1, { input: { seed: `s${index}` } });
      ids.push(piece.id);
      const pin = await readPiecePin(setup, piece.id);
      rows.push({
        piece: piece.id,
        phase: "items",
        expect: {
          patternIdentity: v1id,
          symbol: "default",
          retained: true,
          ...(pin?.revisionId === undefined
            ? {}
            : { revisionId: pin.revisionId }),
        },
        op: {
          kind: "retarget",
          source: { main: `${dir}/member-v2.tsx` },
          patternIdentity: v2id,
          symbol: "default",
        } satisfies RetargetOp,
      });
      const controller = await setup.get(piece.id, false);
      await controller.setPattern(v2);
    }
    await setup.synced();
    await sessions.close(setup);
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

  async function versionOf(piece: string): Promise<unknown> {
    const reader = await sessions.open();
    const controller = await reader.get(piece, false);
    const version = await controller.result.get(["version"]);
    await sessions.close(reader);
    return version;
  }

  it("classifies every row as outstanding, writing nothing, without apply", async () => {
    const { plan } = await retargeted(3);
    const report = await rollbackPieces(sessions, {
      plan: deriveRollbackPlan(plan, "later"),
    });
    expect(report.rows.map((row) => row.verdict)).toEqual([
      "outstanding",
      "outstanding",
      "outstanding",
    ]);
    expect(report.applied).toBe(0);
    // A dry run's outstanding rows are that run's answer, not its defect.
    expect(report.complete).toBe(true);
    expect(await versionOf(plan.rows[0].piece)).toBe("two");
  });

  it("returns every piece to the reference its retarget row recorded", async () => {
    const { plan, ids } = await retargeted(3);
    const report = await rollbackPieces(sessions, {
      plan: deriveRollbackPlan(plan, "later"),
      apply: true,
    });
    expect(report.applied).toBe(3);
    expect(report.complete).toBe(true);
    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    for (const id of ids) expect(await versionOf(id)).toBe("one");
  });

  it("reads a completed rollback as all-landed and rewrites nothing", async () => {
    const { plan } = await retargeted(2);
    const rollback = deriveRollbackPlan(plan, "later");
    await rollbackPieces(sessions, { plan: rollback, apply: true });
    const again = await rollbackPieces(sessions, {
      plan: rollback,
      apply: true,
    });
    expect(again.applied).toBe(0);
    expect(again.complete).toBe(true);
    expect(again.rows.every((row) => row.verdict === "landed")).toBe(true);
  });

  it("reads a piece already back on its recorded reference as landed", async () => {
    const { plan, ids } = await retargeted(3);
    const rollback = deriveRollbackPlan(plan, "later");
    // One piece put back by something else — which is what a resume finds
    // for every row the interrupted run had already restored.
    const setup = await sessions.open();
    const v1 = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/member-v1.tsx`,
    });
    await (await setup.get(ids[1], false)).setPattern(v1);
    await setup.synced();
    await sessions.close(setup);
    const report = await rollbackPieces(sessions, {
      plan: rollback,
      apply: true,
    });
    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "landed",
      "applied",
    ]);
    expect(report.applied).toBe(2);
    expect(report.complete).toBe(true);
  });

  it("never starts when a piece is on neither of its row's references", async () => {
    const { plan, ids } = await retargeted(3);
    const rollback = deriveRollbackPlan(plan, "later");
    const setup = await sessions.open();
    const v3 = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/member-v1.tsx`,
    });
    await Deno.writeTextFile(`${dir}/member-v3.tsx`, memberSource("three"));
    const other = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/member-v3.tsx`,
    });
    expect(await programEntryIdentity(other)).not.toBe(
      await programEntryIdentity(v3),
    );
    await (await setup.get(ids[0], false)).setPattern(other);
    await setup.synced();
    await sessions.close(setup);
    const report = await rollbackPieces(sessions, {
      plan: rollback,
      apply: true,
    });
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
    expect(report.rows[0].verdict).toBe("moved-elsewhere");
    expect(report.rows[0].problem).toContain("neither the reference");
    // The run never started, so the rows behind the moved one keep their
    // preflight standing rather than being written.
    expect(report.rows.slice(1).map((row) => row.verdict)).toEqual([
      "outstanding",
      "outstanding",
    ]);
    expect(await versionOf(ids[1])).toBe("two");
  });

  it("refuses a row whose reference the piece's own log does not hold", async () => {
    const { plan } = await retargeted(2);
    const rollback = deriveRollbackPlan(plan, "later");
    const bent: PiecePlan = {
      header: rollback.header,
      rows: rollback.rows.map((row, index) =>
        index === 0
          ? {
            ...row,
            op: {
              kind: "restore" as const,
              patternIdentity: "no-such-identity",
              symbol: "default",
            },
          }
          : row
      ),
    };
    const report = await rollbackPieces(sessions, { plan: bent, apply: true });
    expect(report.rows[0].verdict).toBe("refused");
    expect(report.rows[0].problem).toContain(
      "no revision on no-such-identity#default",
    );
    // A refusal stops the run, and the remainder is named rather than
    // counted.
    expect(report.rows[1].verdict).toBe("unattempted");
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
  });

  it("stops on a restore the piece's own documents have moved past", async () => {
    // Widen a piece's argument, put a value in it that only the wider
    // source accepts, and ask for the narrower one back. The runtime
    // refuses hard, so the row is state-checked after the fact: it names
    // the piece and the reason, reports that nothing was written, and the
    // run stops with the remainder named rather than forcing the restore.
    await Deno.writeTextFile(
      `${dir}/strict.tsx`,
      [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ title: string }>(({ title }) => ({",
        "  [NAME]: 'Member',",
        "  shown: String(title),",
        "}));",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      `${dir}/wide.tsx`,
      [
        "import { NAME, pattern } from 'commonfabric';",
        "export default pattern<{ title: string | number }>(",
        "  ({ title }) => ({ [NAME]: 'Member', shown: String(title) }),",
        ");",
        "",
      ].join("\n"),
    );
    const setup = await sessions.open();
    const strict = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/strict.tsx`,
    });
    const wide = await resolveLocalSourceProgram(setup.runtime, {
      main: `${dir}/wide.tsx`,
    });
    const strictId = await programEntryIdentity(strict);
    const wideId = await programEntryIdentity(wide);
    const space = setup.getSpace();
    const first = await setup.create(strict, { input: { title: "a" } });
    const second = await setup.create(strict, { input: { title: "b" } });
    const rows: PiecePlanRow[] = [];
    for (const piece of [first, second]) {
      const controller = await setup.get(piece.id, false);
      await controller.setPattern(wide);
      rows.push({
        piece: piece.id,
        expect: { patternIdentity: wideId, symbol: "default", retained: true },
        op: {
          kind: "restore" as const,
          patternIdentity: strictId,
          symbol: "default",
        },
      });
    }
    // Only the first piece holds a value the narrower source rejects.
    await (await setup.get(first.id, false)).input.set(7, ["title"]);
    await setup.synced();
    await sessions.close(setup);
    const report = await rollbackPieces(sessions, {
      plan: {
        header: {
          kind: "piece-plan",
          v: 1,
          space,
          takenAt: "2026-08-25T00:00:00.000Z",
          selector: "list",
          enumerated: { collection: 2, registry: 2, registeredOutside: 0 },
        },
        rows,
      },
      apply: true,
    });
    expect(report.rows[0].verdict).toBe("failed");
    expect(report.rows[0].problem).toContain(
      "updated arguments do not match the candidate schema",
    );
    // State-checked after the failure, never probed before it: the piece
    // is still where the row recorded it, so nothing was written.
    expect(report.rows[0].problem).toContain(
      "still on its recorded reference",
    );
    expect(report.rows[1].verdict).toBe("unattempted");
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
    // The unattempted row's piece is untouched, not merely unreported.
    const reader = await sessions.open();
    const pin = await readPiecePin(reader, second.id);
    await sessions.close(reader);
    expect(pin?.patternIdentity).toBe(wideId);
  });

  it("refuses a piece another writer moved between the recheck and the write", async () => {
    // The window the engine's recheck alone cannot close. In one group
    // session the victim is read twice: once by the recheck that proves its
    // standing, once by the write itself. A writer landing between the two
    // is invisible to the recheck, and a restore that adopted whatever it
    // found would commit over that change. The write carries the proved
    // reference as its own precondition instead, so the row is refused.
    const { plan, ids } = await retargeted(3);
    const rollback = deriveRollbackPlan(plan, "later");
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
    const report = await rollbackPieces(raceBeforeWrite, {
      plan: rollback,
      apply: true,
    });
    expect(raced).toBe(true);
    expect(report.rows[0].verdict).toBe("refused");
    expect(report.rows[0].problem).toContain(
      "not the",
    );
    expect(report.rows[0].problem).toContain("this change was proved against");
    // The other writer's change stands: the reversal stopped rather than
    // writing over something this plan never accounted for.
    expect(await versionOf(victim)).toBe("three");
    expect(report.applied).toBe(0);
    expect(report.complete).toBe(false);
    expect(report.rows[1].verdict).toBe("unattempted");
  });

  it("carries the runtime's warning on a row whose restore landed", async () => {
    // A restore that commits and then has its post-commit refresh fail comes
    // back applied with an `executionWarning`. The row landed, so it is not
    // a refusal — but an operator told nothing would read a silent success,
    // so the warning rides the row and the run still completes.
    const { plan, ids } = await retargeted(2);
    const rollback = deriveRollbackPlan(plan, "later");
    const warned = new Set<string>();
    const warning = "the restored piece would not refresh";
    const warningSessions: ApplySessions = {
      open: async () => {
        const pieces = await sessions.open();
        return new Proxy(pieces, {
          get(target, prop, receiver) {
            if (prop === "get") {
              return async (...args: unknown[]) => {
                const controller = await (target.get as unknown as (
                  ...a: unknown[]
                ) => Promise<Record<string, unknown>>)(...args);
                return new Proxy(controller, {
                  get(inner, name, innerReceiver) {
                    if (name === "changeSource") {
                      return async (...callArgs: unknown[]) => {
                        const result = await (inner.changeSource as (
                          ...a: unknown[]
                        ) => Promise<{ status: string }>).apply(
                          inner,
                          callArgs,
                        );
                        if (result.status === "applied") {
                          warned.add(String(args[0]));
                          return { ...result, executionWarning: warning };
                        }
                        return result;
                      };
                    }
                    const value = Reflect.get(inner, name, innerReceiver);
                    return typeof value === "function"
                      ? value.bind(inner)
                      : value;
                  },
                });
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as PiecesController;
      },
      close: (pieces) => sessions.close(pieces),
    };
    const report = await rollbackPieces(warningSessions, {
      plan: rollback,
      apply: true,
    });
    expect(warned.size).toBe(2);
    expect(report.rows.map((row) => row.verdict)).toEqual([
      "applied",
      "applied",
    ]);
    expect(report.rows.map((row) => row.warning)).toEqual([warning, warning]);
    // The writes landed, so the run is complete and nothing was refused.
    expect(report.applied).toBe(2);
    expect(report.complete).toBe(true);
    for (const id of ids) expect(await versionOf(id)).toBe("one");
  });

  it("throws for a plan carrying an operation this run does not apply", async () => {
    const { plan } = await retargeted(1);
    await expect(rollbackPieces(sessions, { plan, apply: true })).rejects
      .toThrow("This run applies restores alone");
  });

  it("throws for a plan whose rows carry no restore at all", async () => {
    const { plan } = await retargeted(1);
    await expect(
      rollbackPieces(sessions, {
        plan: { header: plan.header, rows: [] },
      }),
    ).rejects.toThrow("no restore rows");
  });

  it("refuses a plan surveyed against another space before it reads a row", async () => {
    const { plan } = await retargeted(2);
    const rollback = deriveRollbackPlan(plan, "later");
    const elsewhere: ApplySessions = {
      open: async () =>
        openSession(
          await storageManager.createSpace({ [signer.did()]: "OWNER" }),
        ),
      close: () => Promise.resolve(),
    };
    // The preflight's mismatch refuses the run outright: there is no report
    // to lose yet, and these addresses name other pieces over there.
    await expect(
      rollbackPieces(elsewhere, { plan: rollback, apply: true }),
    ).rejects.toThrow(`The plan names space ${rollback.header.space}`);
    expect(await versionOf(rollback.rows[0].piece)).toBe("two");
  });
});
