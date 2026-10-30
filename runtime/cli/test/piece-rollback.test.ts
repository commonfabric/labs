/**
 * `cf piece rollback` and `cf piece restore`: their command actions and the
 * `runRollback` / `runRestore` seams. The derivation the rollback runs from,
 * the acceptance that is per piece and never blanket, the report's one
 * destination in each of its three modes, the restore's three readings —
 * the listing, the preflight, the write — and the exit discipline of both.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type {
  ApplyReport,
  PiecesController,
  RestorableRevision,
  RestoreOutcome,
} from "@commonfabric/piece/ops";
import { decode } from "@commonfabric/text/utf8";

import { runRestore, runRollback } from "../lib/bulk.ts";
import { resetUnreportedRunGuardsForTest } from "../lib/unreported-run.ts";
import { guardHarness } from "./unreported-run-helpers.ts";
import {
  formatRestorableRevision,
  piece,
  restoreFromCommand,
  rollbackFromCommand,
  setQuietMode,
} from "../commands/piece.ts";

function captureStdout(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  return fn().then(() => captured).finally(() => {
    Deno.stdout.writeSync = original;
  });
}

class ExitSentinel extends Error {}

const TARGET = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  space: "home",
  quiet: true,
};

const ROLLBACK_OPTIONS = { ...TARGET, plan: "retarget.jsonl" };

// The 43-character handle length clears the canonical parser's threshold
// below which an id reads as a human name and is refused.
const HANDLE = "baedreiabcdefghijklmnopqrstuvwxyz0123456788";
const OTHER_HANDLE = "baedreizyxwvutsrqponmlkjihgfedcba9876543210";

const PLAN_TEXT = [
  JSON.stringify({
    kind: "piece-plan",
    v: 1,
    space: "did:key:test",
    takenAt: "2026-08-25T00:00:00.000Z",
    selector: "collection",
    enumerated: { collection: 2, registry: 0, registeredOutside: 0 },
  }),
  JSON.stringify({
    piece: `fid1:${HANDLE}`,
    phase: "items",
    expect: {
      patternIdentity: "idA",
      symbol: "Member",
      retained: true,
      revisionId: "rev-a",
    },
    op: {
      kind: "retarget",
      patternIdentity: "idB",
      symbol: "Member",
      source: { main: "/sources/member-v2.tsx", mainExport: "Member" },
    },
  }),
  JSON.stringify({
    piece: `fid1:${OTHER_HANDLE}`,
    phase: "items",
    expect: { patternIdentity: "idA", symbol: "Member", retained: false },
    op: {
      kind: "retarget",
      patternIdentity: "idB",
      symbol: "Member",
      source: { main: "/sources/member-v2.tsx", mainExport: "Member" },
    },
  }),
  "",
].join("\n");

const REPORT: ApplyReport = {
  rows: [
    { piece: "fid1:aaY", phase: "items", verdict: "applied", elapsedMs: 412 },
    { piece: "fid1:bbY", phase: "items", verdict: "landed", elapsedMs: 18 },
  ],
  applied: 1,
  complete: true,
};

const DERIVED = {
  header: {
    kind: "piece-plan" as const,
    v: 1 as const,
    space: "did:key:test",
    takenAt: "later",
    selector: "collection" as const,
    enumerated: { collection: 2, registry: 0, registeredOutside: 0 },
  },
  rows: [],
};

const REVISION: RestorableRevision = {
  revisionId: "rev-a",
  timestamp: 0,
  patternIdentity: "idA",
  symbol: "Member",
  operation: "create",
  retained: true,
  current: false,
};

// Every fixture below spreads `REVISION` into `selected` rather than
// sharing it, because that is what the library returns: the CLI's JSON
// serializer renders a second reference to one object as a circular one, so
// an alias would reach a `--json` reader as `<circular reference>`.
const LISTING: RestoreOutcome = {
  piece: "fid1:aaY",
  revisions: [REVISION, {
    ...REVISION,
    revisionId: "rev-b",
    patternIdentity: "idB",
    operation: "edit",
    current: true,
  }],
  restored: false,
};

describe("piece-rollback", () => {
  // The fixtures pass `quiet`, and the actions apply it globally.
  afterEach(() => setQuietMode(false));
  // The process-end hook is installed once per process, by the first run to
  // arm a guard; a case that injects its own effects starts from none.
  beforeEach(() => resetUnreportedRunGuardsForTest());

  describe("formatRestorableRevision()", () => {
    it("puts the id, the time, the reference, and both standings on one line", () => {
      expect(formatRestorableRevision(LISTING.revisions[1])).toBe(
        "rev-b 1970-01-01T00:00:00.000Z idB#Member edit retained current",
      );
    });

    it("says so for a revision nothing could restore", () => {
      expect(
        formatRestorableRevision({ ...REVISION, retained: false }),
      ).toBe("rev-a 1970-01-01T00:00:00.000Z idA#Member create not-retained");
    });
  });

  describe("rollbackFromCommand()", () => {
    it("prints a line per row as each row settles", async () => {
      const printed: unknown[] = [];
      const hints: string[] = [];
      await rollbackFromCommand(ROLLBACK_OPTIONS, {
        render: (value) => {
          printed.push(value);
        },
        runRollback: (_config, request) => {
          for (const row of REPORT.rows) request.onRow?.(row);
          return Promise.resolve({ report: REPORT, plan: DERIVED });
        },
        printHint: (message) => {
          hints.push(message);
        },
      });
      expect(printed).toEqual([
        "applied fid1:aaY items 412ms",
        "landed fid1:bbY items 18ms",
      ]);
      expect(hints).toEqual([
        "Derived 0 rollback rows from retarget.jsonl",
        "applied: 1 · landed: 1 · written: 1",
      ]);
    });

    it("passes the plan path, the apply flag, and the group size through", async () => {
      let request: { planPath?: string; apply?: boolean; groupSize?: number } =
        {};
      await captureStdout(() =>
        rollbackFromCommand({
          ...ROLLBACK_OPTIONS,
          apply: true,
          groupSize: 7,
        }, {
          runRollback: (_config, given) => {
            request = given;
            return Promise.resolve({ report: REPORT, plan: DERIVED });
          },
          printHint: () => {},
        })
      );
      expect(request.planPath?.endsWith("/retarget.jsonl")).toBe(true);
      expect(request.apply).toBe(true);
      expect(request.groupSize).toBe(7);
    });

    it("names every accepted piece where quiet cannot silence it", async () => {
      const hints: string[] = [];
      const notes: string[] = [];
      let accepted: readonly string[] | undefined;
      await captureStdout(() =>
        rollbackFromCommand({
          ...ROLLBACK_OPTIONS,
          acceptUnretained: [`fid1:${OTHER_HANDLE}`],
        }, {
          runRollback: (_config, request) => {
            accepted = request.accept;
            return Promise.resolve({ report: REPORT, plan: DERIVED });
          },
          printHint: (message) => {
            hints.push(message);
          },
          printNote: (message) => {
            notes.push(message);
          },
        })
      );
      expect(accepted).toEqual([`fid1:${OTHER_HANDLE}`]);
      // A piece the reversal cannot return must be named rather than left
      // to be inferred from a row that is missing — and it goes to the note
      // rather than a hint, which `--quiet` would silence.
      expect(notes).toEqual([
        `accepted as unrollbackable: fid1:${OTHER_HANDLE} (left out of this reversal)`,
      ]);
      expect(hints.join("\n")).not.toContain("unrollbackable");
    });

    it("keeps the runtime's console off stdout in every mode", async () => {
      let jsonOutput: boolean | undefined;
      await captureStdout(() =>
        rollbackFromCommand(ROLLBACK_OPTIONS, {
          runRollback: (config) => {
            jsonOutput = (config as { jsonOutput?: boolean }).jsonOutput;
            return Promise.resolve({ report: REPORT, plan: DERIVED });
          },
          printHint: () => {},
        })
      );
      expect(jsonOutput).toBe(true);
    });

    it("emits the whole report as one canonical document under --json", async () => {
      const out = await captureStdout(() =>
        rollbackFromCommand({ ...ROLLBACK_OPTIONS, json: true }, {
          runRollback: (_config, request) => {
            // A single document cannot stream, so the reporter this mode
            // hands the library observes and never prints. The key set, not
            // each value: an `apply: undefined` riding along is a key the
            // library still has to reason about, and every matcher that asks
            // about one property reads a present-but-undefined key as an
            // absent one.
            expect(Object.keys(request).sort()).toEqual(["onRow", "planPath"]);
            for (const row of REPORT.rows) request.onRow?.(row);
            return Promise.resolve({ report: REPORT, plan: DERIVED });
          },
          printHint: () => {},
        })
      );
      expect(out.startsWith("fvj1:")).toBe(true);
      expect(out).toContain('"elapsedMs":412');
      // What "cannot stream" means, asserted directly: two rows went through
      // the reporter above and stdout still carries one line, the document.
      expect(out.trimEnd().split("\n")).toHaveLength(1);
    });

    it("exits nonzero on a stopped run, naming every unattempted piece", async () => {
      const errors: string[] = [];
      const stopped: ApplyReport = {
        rows: [
          { piece: "fid1:aaY", verdict: "applied", elapsedMs: 5 },
          {
            piece: "fid1:bbY",
            verdict: "refused",
            problem: "The piece's source log holds no revision on idA#Member.",
            elapsedMs: 3,
          },
          { piece: "fid1:ccc", verdict: "unattempted" },
        ],
        applied: 1,
        complete: false,
      };
      await expect(
        captureStdout(() =>
          rollbackFromCommand({ ...ROLLBACK_OPTIONS, apply: true }, {
            runRollback: () =>
              Promise.resolve({ report: stopped, plan: DERIVED }),
            printHint: () => {},
            printError: (message) => {
              errors.push(message);
            },
            exit: (code) => {
              expect(code).toBe(1);
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      const message = errors.join("\n");
      expect(message).toContain("Rollback did not complete");
      expect(message).toContain("  unattempted: fid1:ccc");
      expect(message).toContain("  refused: fid1:bbY The piece's source log");
      expect(message).not.toContain("fid1:aaY");
    });

    it("writes the accepted piece to stderr when nothing intercepts it", async () => {
      // The note's own default, not an injected one: `--quiet` is on, and
      // the piece this reversal cannot return still has to reach stderr.
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(" "));
      };
      try {
        await captureStdout(() =>
          rollbackFromCommand({
            ...ROLLBACK_OPTIONS,
            acceptUnretained: [`fid1:${OTHER_HANDLE}`],
          }, {
            runRollback: () =>
              Promise.resolve({ report: REPORT, plan: DERIVED }),
            printHint: () => {},
          })
        );
      } finally {
        console.error = original;
      }
      expect(errors).toContain(
        `accepted as unrollbackable: fid1:${OTHER_HANDLE} (left out of this reversal)`,
      );
    });

    it("routes cf piece rollback to rollbackFromCommand", () => {
      const registered = piece.getCommand("rollback") as unknown as {
        actionHandler?: unknown;
      };
      expect(registered?.actionHandler).toBe(rollbackFromCommand);
    });

    it("reports what settled and exits nonzero when the process outlives the run", async () => {
      // The rollback runs the retarget's engine over the retarget's grouped
      // sessions, so a run that stops settling ends the process the same
      // silent way — half a reversal made, exit 0, no summary.
      const process = guardHarness();
      const abandoned = rollbackFromCommand(
        { ...ROLLBACK_OPTIONS, apply: true },
        {
          runRollback: (_config, request) => {
            request.onRow?.(REPORT.rows[0]);
            return new Promise<never>(() => {});
          },
          render: () => {},
          printHint: () => {},
          guard: process.deps,
        },
      );
      await Promise.resolve();
      expect(process.endProcess()).toBe(1);
      expect(process.errors.join("\n")).toContain(
        "Rollback ended before it reported",
      );
      expect(process.errors.join("\n")).toContain("1 row settled");
      expect(abandoned).toBeInstanceOf(Promise);
    });

    it("counts the rows a document-mode run settled, which wrote no document", async () => {
      // `--json` builds what it emits from the returned report, so a run
      // that never returns emits nothing and this line is the whole account.
      const process = guardHarness();
      const out = await captureStdout(() => {
        rollbackFromCommand({ ...ROLLBACK_OPTIONS, json: true, apply: true }, {
          runRollback: (_config, request) => {
            request.onRow?.(REPORT.rows[0]);
            return new Promise<never>(() => {});
          },
          printHint: () => {},
          guard: process.deps,
        });
        return Promise.resolve();
      });
      expect(process.endProcess()).toBe(1);
      expect(process.errors.join("\n")).toContain("1 row settled — applied: 1");
      expect(out).toBe("");
    });

    it("says the report failed, not that the run never returned, when output throws", async () => {
      // As the retarget: the engine returned, the writing of it did not, and
      // the guard's line has to say which.
      const process = guardHarness();
      await expect(
        rollbackFromCommand(
          { ...ROLLBACK_OPTIONS, out: "report.json", apply: true },
          {
            runRollback: (_config, request) => {
              for (const row of REPORT.rows) request.onRow?.(row);
              return Promise.resolve({ report: REPORT, plan: DERIVED });
            },
            writeTextFile: () => Promise.reject(new Error("the disk is full")),
            printHint: () => {},
            guard: process.deps,
          },
        ),
      ).rejects.toThrow("the disk is full");
      expect(process.endProcess()).toBe(1);
      const said = process.errors.join("\n");
      expect(said).toContain("Rollback ran to a report");
      expect(said).not.toContain("still in flight");
      expect(said).toContain("2 rows settled — applied: 1 · landed: 1.");
    });

    it("says nothing at process end once the run has reported", async () => {
      const process = guardHarness();
      await captureStdout(() =>
        rollbackFromCommand(ROLLBACK_OPTIONS, {
          runRollback: () => Promise.resolve({ report: REPORT, plan: DERIVED }),
          printHint: () => {},
          guard: process.deps,
        })
      );
      expect(process.endProcess()).toBe(0);
      expect(process.errors).toEqual([]);
    });

    it("says nothing at process end when the run threw", async () => {
      // The derivation refuses before any session opens — an unretained row
      // nobody accepted is the ordinary way. That refusal IS the report, and
      // the CLI prints it on the way to a nonzero exit; a guard line beside
      // it would be a second account of a run that already gave one.
      const process = guardHarness();
      await expect(
        rollbackFromCommand(ROLLBACK_OPTIONS, {
          runRollback: () =>
            Promise.reject(
              new Error("The prior source is not retained for fid1:aaY."),
            ),
          printHint: () => {},
          guard: process.deps,
        }),
      ).rejects.toThrow("not retained");
      expect(process.endProcess()).toBe(0);
      expect(process.errors).toEqual([]);
    });
  });

  describe("runRollback()", () => {
    it("derives the reversal of the plan file and passes the run's knobs", async () => {
      let options: { plan?: unknown; apply?: boolean; groupSize?: number } = {};
      const { plan } = await runRollback({} as never, {
        planPath: "/plans/upgrade.jsonl",
        accept: [`fid1:${OTHER_HANDLE}`],
        apply: true,
        groupSize: 4,
        takenAt: "later",
      }, {
        readTextFile: (path) => {
          expect(path).toBe("/plans/upgrade.jsonl");
          return Promise.resolve(PLAN_TEXT);
        },
        rollbackPieces: (_sessions, given) => {
          options = given;
          return Promise.resolve(REPORT);
        },
      });
      // The row's precondition is the reference the retarget produced, and
      // its operation restores the one the retarget row recorded.
      expect(plan.rows).toEqual([{
        piece: `fid1:${HANDLE}`,
        phase: "items",
        expect: { patternIdentity: "idB", symbol: "Member", retained: true },
        op: {
          kind: "restore",
          patternIdentity: "idA",
          symbol: "Member",
          revisionId: "rev-a",
        },
      }]);
      expect(plan.header.takenAt).toBe("later");
      expect(options.plan).toBe(plan);
      expect(options.apply).toBe(true);
      expect(options.groupSize).toBe(4);
    });

    it("omits the knobs the command did not ask for", async () => {
      let options: Record<string, unknown> = {};
      await runRollback({} as never, {
        planPath: "/plans/upgrade.jsonl",
        accept: [`fid1:${OTHER_HANDLE}`],
      }, {
        readTextFile: () => Promise.resolve(PLAN_TEXT),
        rollbackPieces: (_sessions, given) => {
          options = given as unknown as Record<string, unknown>;
          return Promise.resolve(REPORT);
        },
      });
      expect(Object.keys(options)).toEqual(["plan"]);
    });

    it("refuses to derive a reversal for a row whose prior source is not retained", async () => {
      await expect(
        runRollback({} as never, { planPath: "/plans/upgrade.jsonl" }, {
          readTextFile: () => Promise.resolve(PLAN_TEXT),
          rollbackPieces: () => Promise.resolve(REPORT),
        }),
      ).rejects.toThrow(`not retained for fid1:${OTHER_HANDLE}`);
    });

    it("settles and disposes each session it is handed back", async () => {
      const opened: unknown[] = [];
      const settled: unknown[] = [];
      const disposed: unknown[] = [];
      await runRollback({} as never, {
        planPath: "/plans/upgrade.jsonl",
        accept: [`fid1:${OTHER_HANDLE}`],
      }, {
        readTextFile: () => Promise.resolve(PLAN_TEXT),
        loadPieces: () => {
          const controller = {
            synced: () => {
              settled.push(controller);
              return Promise.resolve();
            },
            dispose: () => {
              // Settling comes first: disposal closes the storage this
              // session's reads are still going through.
              expect(settled).toContain(controller);
              disposed.push(controller);
              return Promise.resolve();
            },
          } as unknown as PiecesController;
          opened.push(controller);
          return Promise.resolve(controller);
        },
        rollbackPieces: async (sessions) => {
          await sessions.close(await sessions.open());
          await sessions.close(await sessions.open());
          return REPORT;
        },
      });
      expect(opened.length).toBe(2);
      expect(disposed).toEqual(opened);
    });
  });

  describe("restoreFromCommand()", () => {
    it("prints one line per revision when none is named", async () => {
      const printed: unknown[] = [];
      const hints: string[] = [];
      await restoreFromCommand({ ...TARGET, cell: "fid1:aaY" }, {
        render: (value) => {
          printed.push(value);
        },
        runRestore: (_config, request) => {
          expect(Object.keys(request ?? {})).toEqual([]);
          return Promise.resolve(LISTING);
        },
        printHint: (message) => {
          hints.push(message);
        },
      });
      expect(printed).toEqual([
        "rev-a 1970-01-01T00:00:00.000Z idA#Member create retained",
        "rev-b 1970-01-01T00:00:00.000Z idB#Member edit retained current",
      ]);
      expect(hints).toEqual(["2 revision(s); name one with --revision"]);
    });

    it("reports what a named revision would restore, writing nothing", async () => {
      const hints: string[] = [];
      let request: { revisionId?: string; apply?: boolean } = {};
      const out = await captureStdout(() =>
        restoreFromCommand({
          ...TARGET,
          cell: "fid1:aaY",
          revision: "rev-a",
        }, {
          runRestore: (_config, given) => {
            request = given ?? {};
            return Promise.resolve({ ...LISTING, selected: { ...REVISION } });
          },
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(request).toEqual({ revisionId: "rev-a" });
      expect(out).toBe(
        "rev-a 1970-01-01T00:00:00.000Z idA#Member create retained\n",
      );
      expect(hints).toEqual([
        "fid1:aaY would be restored to rev-a; --apply writes it",
      ]);
    });

    it("reports a piece already running the named revision as needing nothing", async () => {
      const hints: string[] = [];
      await captureStdout(() =>
        restoreFromCommand({
          ...TARGET,
          cell: "fid1:aaY",
          revision: "rev-b",
          apply: true,
        }, {
          runRestore: () =>
            Promise.resolve({
              ...LISTING,
              selected: LISTING.revisions[1],
            }),
          printHint: (message) => {
            hints.push(message);
          },
          exit: () => {
            throw new ExitSentinel();
          },
        })
      );
      // Nothing written and nothing wrong: the exit stays zero, which is
      // what makes re-invoking a restore a resume rather than an error.
      expect(hints).toEqual(["fid1:aaY already runs rev-b"]);
    });

    it("names the origin a restore would sever for a piece on the revision's reference", async () => {
      const hints: string[] = [];
      await captureStdout(() =>
        restoreFromCommand({
          ...TARGET,
          cell: "fid1:aaY",
          revision: "rev-b",
        }, {
          runRestore: () =>
            Promise.resolve({
              ...LISTING,
              origin: "https://example.test/member.tsx",
              selected: { ...LISTING.revisions[1] },
            }),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      // Running the reference is not standing where the restore would leave
      // the piece: the origin is still ahead of it, so reporting this as
      // needing nothing would hide the write the operator asked for.
      expect(hints).toEqual([
        "fid1:aaY runs the reference of rev-b but follows " +
        "https://example.test/member.tsx; --apply restores it and severs " +
        "that origin",
      ]);
    });

    it("exits nonzero naming what refused a named revision", async () => {
      const errors: string[] = [];
      await expect(
        captureStdout(() =>
          restoreFromCommand({
            ...TARGET,
            cell: "fid1:aaY",
            revision: "rev-z",
            apply: true,
          }, {
            runRestore: () =>
              Promise.resolve({
                ...LISTING,
                problem: "The piece's source log holds no revision rev-z; " +
                  "it holds rev-a, rev-b.",
              }),
            printHint: () => {},
            printError: (message) => {
              errors.push(message);
            },
            exit: (code) => {
              expect(code).toBe(1);
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      expect(errors.join("\n")).toContain("it holds rev-a, rev-b");
    });

    it("carries the runtime's warning for a restore that committed anyway", async () => {
      const hints: string[] = [];
      await captureStdout(() =>
        restoreFromCommand({
          ...TARGET,
          cell: "fid1:aaY",
          revision: "rev-a",
          apply: true,
        }, {
          runRestore: () =>
            Promise.resolve({
              ...LISTING,
              selected: { ...REVISION },
              restored: true,
              warning: "the restored pattern logged an error",
            }),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(hints).toEqual([
        "the restored source ran with a warning: the restored pattern " +
        "logged an error",
        "restored fid1:aaY to rev-a",
      ]);
    });

    it("writes the whole outcome as one JSON document under --json", async () => {
      const out = await captureStdout(() =>
        restoreFromCommand({
          ...TARGET,
          cell: "fid1:aaY",
          revision: "rev-a",
          json: true,
        }, {
          runRestore: () =>
            Promise.resolve({ ...LISTING, selected: { ...REVISION } }),
          printHint: () => {},
        })
      );
      const parsed = JSON.parse(out);
      // The whole outcome, not the per-revision lines: a caller asking for
      // JSON is asking for the listing and the verdict in one value.
      expect(parsed.piece).toBe("fid1:aaY");
      expect(parsed.restored).toBe(false);
      expect(parsed.revisions.length).toBe(2);
      expect(parsed.selected.revisionId).toBe("rev-a");
    });

    it("routes cf piece restore to restoreFromCommand", () => {
      const registered = piece.getCommand("restore") as unknown as {
        actionHandler?: unknown;
      };
      expect(registered?.actionHandler).toBe(restoreFromCommand);
    });
  });

  describe("runRestore()", () => {
    it("resolves the address the way every other piece verb does", async () => {
      let resolved: string | undefined;
      let given: { revisionId?: string; apply?: boolean } | undefined;
      const outcome = await runRestore(
        { piece: "board" } as never,
        { revisionId: "rev-a", apply: true },
        {
          loadPieces: () => Promise.resolve({} as PiecesController),
          resolvePieceAddress: (_pieces, address) => {
            resolved = address;
            return Promise.resolve("fid1:aaY");
          },
          restorePiece: (_pieces, address, options) => {
            expect(address).toBe("fid1:aaY");
            given = options;
            return Promise.resolve(LISTING);
          },
        },
      );
      expect(resolved).toBe("board");
      expect(given).toEqual({ revisionId: "rev-a", apply: true });
      expect(outcome).toBe(LISTING);
    });

    it("omits the knobs the command did not ask for", async () => {
      let given: Record<string, unknown> = { seeded: true };
      await runRestore({ piece: "board" } as never, {}, {
        loadPieces: () => Promise.resolve({} as PiecesController),
        resolvePieceAddress: () => Promise.resolve("fid1:aaY"),
        restorePiece: (_pieces, _address, options) => {
          given = options as unknown as Record<string, unknown>;
          return Promise.resolve(LISTING);
        },
      });
      expect(Object.keys(given)).toEqual([]);
    });
  });
});
