/**
 * `cf piece repair`'s command action and its `runRepair` seam: flag intake
 * and passthrough, output in both modes, the exit discipline, and the run
 * end to end against a real controller over emulated storage — the fixer
 * module injected, so no disk import runs in a unit test.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController, type RepairReport } from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { decode } from "@commonfabric/utils/encoding";

import {
  programEntryIdentity,
  resolveLocalSourceProgram,
} from "@commonfabric/piece/ops/bulk-local";

import { type RepairRunRequest, runRepair, zeroRowFixer } from "../lib/bulk.ts";
import { resetUnreportedRunGuardsForTest } from "../lib/unreported-run.ts";
import { guardHarness } from "./unreported-run-helpers.ts";
import { piece, repairFromCommand, setQuietMode } from "../commands/piece.ts";

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

const signer = await Identity.fromPassphrase("cli bulk repair");

const OPTIONS = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  space: "home",
  cell: "board",
  quiet: true,
  fixer: "fix-seeds.ts",
};

const REPORT: RepairReport = {
  rows: [{
    piece: "fid1:aaa",
    phase: "members",
    verdict: "would-change",
    documentHash: "9f2c",
    changes: [{ path: "/seed", kind: "changed", before: "a", after: "A" }],
  }],
  plan: {
    header: {
      kind: "piece-plan",
      v: 1,
      space: "did:key:test",
      takenAt: "2026-08-25T00:00:00.000Z",
      selector: "collection",
      enumerated: { collection: 1, registry: 0, registeredOutside: 0 },
    },
    rows: [{
      piece: "fid1:aaa",
      phase: "members",
      expect: {
        patternIdentity: "idA",
        symbol: "default",
        retained: true,
        documentHash: "9f2c",
      },
      op: { kind: "repair", fixer: "fix-seeds.ts", fixerIdentity: "impl-v1" },
    }],
  },
  applied: 0,
  complete: true,
};

describe("piece-repair", () => {
  // The fixtures pass `quiet`, and the action applies it globally.
  afterEach(() => setQuietMode(false));
  // The process-end hook is installed once per process, by the first run to
  // arm a guard; a case that injects its own effects starts from none.
  beforeEach(() => resetUnreportedRunGuardsForTest());

  describe("repairFromCommand()", () => {
    it("prints the emitted plan to stdout and the verdict tally as a hint", async () => {
      const hints: string[] = [];
      let request: RepairRunRequest | undefined;
      const out = await captureStdout(() =>
        repairFromCommand({ ...OPTIONS, path: "topics" }, {
          runRepair: (_config, req) => {
            request = req;
            return Promise.resolve(REPORT);
          },
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(out).toContain('"kind":"piece-plan"');
      expect(out).toContain('"kind":"repair"');
      expect(request?.selector).toEqual({
        kind: "collection",
        holder: "board",
        path: ["topics"],
      });
      expect(request?.fixerName).toBe("fix-seeds.ts");
      expect(request?.fixerPath.endsWith("/fix-seeds.ts")).toBe(true);
      expect(request?.apply).toBeUndefined();
      // The dry run's product is the exact diff, so it renders beside the
      // tally.
      expect(hints).toEqual([
        "would-change: 1",
        '~ fid1:aaa /seed "a" -> "A"',
      ]);
    });

    it("renders the dry diff through the canonical debug stringifier", async () => {
      const hints: string[] = [];
      const fabric: RepairReport = {
        ...REPORT,
        rows: [{
          piece: "fid1:aaa",
          verdict: "would-change",
          documentHash: "9f2c",
          changes: [
            { path: "/gone", kind: "removed", before: 1 },
            {
              path: "/pin",
              kind: "added",
              after: FabricHash.fromString("fid1:" + "A".repeat(43)),
            },
          ],
        }],
      };
      await captureStdout(() =>
        repairFromCommand({ ...OPTIONS, path: "topics" }, {
          runRepair: () => Promise.resolve(fabric),
          printHint: (message) => {
            hints.push(message);
          },
        })
      );
      expect(hints).toContain("- fid1:aaa /gone 1");
      const added = hints.find((line) => line.startsWith("+ fid1:aaa /pin"));
      // A Fabric special value renders in the canonical debug form — its
      // kind named, never an empty shell; the value-exact rendering is the
      // --json encoding's job.
      expect(added).toBeDefined();
      expect(added).toContain("/Hash(");
    });

    it("emits --json in the canonical FabricValue encoding", async () => {
      const a = FabricHash.fromString("fid1:" + "A".repeat(43));
      const b = FabricHash.fromString("fid1:" + "B".repeat(42) + "A");
      const fabric: RepairReport = {
        ...REPORT,
        rows: [{
          piece: "fid1:aaa",
          verdict: "would-change",
          documentHash: "9f2c",
          changes: [{ path: "/pin", kind: "changed", before: a, after: b }],
        }],
      };
      const out = await captureStdout(() =>
        repairFromCommand({ ...OPTIONS, path: "topics", json: true }, {
          runRepair: () => Promise.resolve(fabric),
          printHint: () => {},
        })
      );
      expect(out.startsWith("fvj1:")).toBe(true);
      // Two distinct hashes stay two distinct hashes, not two empty shells.
      expect(out).toContain("A".repeat(43));
      expect(out).toContain("B".repeat(42));
    });

    it("passes the plan path and the apply flag through", async () => {
      let request: RepairRunRequest | undefined;
      await captureStdout(() =>
        repairFromCommand(
          { ...OPTIONS, path: "topics", plan: "plan.jsonl", apply: true },
          {
            runRepair: (_config, req) => {
              request = req;
              return Promise.resolve(REPORT);
            },
            printHint: () => {},
          },
        )
      );
      expect(request?.planPath?.endsWith("/plan.jsonl")).toBe(true);
      expect(request?.apply).toBe(true);
    });

    it("writes the plan to --out and exits nonzero on an incomplete run", async () => {
      let written: { path: string; text: string } | undefined;
      const hints: string[] = [];
      const incomplete: RepairReport = {
        ...REPORT,
        rows: [{
          piece: "fid1:aaa",
          phase: "members",
          verdict: "refused",
          documentHash: "9f2c",
          problem: "the fixer threw",
        }],
        complete: false,
      };
      await expect(
        captureStdout(() =>
          repairFromCommand({ ...OPTIONS, path: "topics", out: "plan.jsonl" }, {
            runRepair: () => Promise.resolve(incomplete),
            writeTextFile: (path, text) => {
              written = { path: String(path), text: String(text) };
              return Promise.resolve();
            },
            printHint: (message) => {
              hints.push(message);
            },
            printError: () => {},
            exit: (code) => {
              expect(code).toBe(1);
              throw new ExitSentinel();
            },
          })
        ),
      ).rejects.toThrow(ExitSentinel);
      expect(written?.path).toBe("plan.jsonl");
      expect(written?.text).toContain('"piece-plan"');
      expect(hints).toContain("refused: fid1:aaa the fixer threw");
    });

    it("routes cf piece repair to repairFromCommand", () => {
      const registered = piece.getCommand("repair") as unknown as {
        actionHandler?: unknown;
      };
      expect(registered?.actionHandler).toBe(repairFromCommand);
    });

    it("reports the run and exits nonzero when the process outlives it", async () => {
      // The repair runs one session rather than the retarget's grouped ones,
      // and ends the same way if an await stops settling: the fixer's writes
      // are half-made, the process drains, and code 0 says otherwise.
      const process = guardHarness();
      const abandoned = repairFromCommand(
        { ...OPTIONS, path: "topics", apply: true },
        {
          runRepair: () => new Promise<RepairReport>(() => {}),
          render: () => {},
          printHint: () => {},
          guard: process.deps,
        },
      );
      await Promise.resolve();
      expect(process.endProcess()).toBe(1);
      expect(process.errors.join("\n")).toContain(
        "Repair ended before it reported",
      );
      // `repairPieces` reports each row as it settles, so this process is
      // watching and a count of zero is a fact about the run rather than a
      // blind spot. This run settles none before it is abandoned, and the
      // line says so — the wording an unwatched run must never use.
      expect(process.errors.join("\n")).toContain(
        "No row settled before it ended",
      );
      expect(process.errors.join("\n")).not.toContain("is not known here");
      expect(abandoned).toBeInstanceOf(Promise);
    });

    it("says the report failed, not that the run never returned, when output throws", async () => {
      // What this line must get right is that the engine DID return: the
      // failure is the report's, not a run that never came back.
      const process = guardHarness();
      await expect(
        repairFromCommand(
          { ...OPTIONS, path: "topics", apply: true, json: true },
          {
            runRepair: () => Promise.resolve(REPORT),
            render: () => {
              throw new Error("stdout failed");
            },
            printHint: () => {},
            guard: process.deps,
          },
        ),
      ).rejects.toThrow("stdout failed");
      expect(process.endProcess()).toBe(1);
      const said = process.errors.join("\n");
      expect(said).toContain("Repair ran to a report");
      expect(said).not.toContain("still in flight");
      expect(said).not.toContain("it did not return");
      expect(said).not.toContain("this run counts its rows only in the report");
    });

    it("counts the rows the engine reports, and names them if it is abandoned", async () => {
      // The guard can only name where an abandoned run reached if something
      // told it which rows settled. Driving the callback the command hands
      // over — rather than only asserting that one exists — is what proves a
      // row travels all the way to the line the operator reads.
      const process = guardHarness();
      const abandoned = repairFromCommand(
        { ...OPTIONS, path: "topics", apply: true },
        {
          runRepair: (_config, req) => {
            req.onRow?.({ piece: "of:fid1:alpha", verdict: "repaired" });
            req.onRow?.({ piece: "of:fid1:bravo", verdict: "conforms" });
            return new Promise<RepairReport>(() => {});
          },
          render: () => {},
          printHint: () => {},
          guard: process.deps,
        },
      );
      await Promise.resolve();
      expect(process.endProcess()).toBe(1);
      const said = process.errors.join("\n");
      expect(said).toContain("2 rows settled");
      expect(said).toContain("repaired: 1");
      expect(said).toContain("conforms: 1");
      expect(said).not.toContain("No row settled");
      expect(abandoned).toBeInstanceOf(Promise);
    });

    it("says nothing at process end once the run has reported", async () => {
      const process = guardHarness();
      await captureStdout(() =>
        repairFromCommand({ ...OPTIONS, path: "topics" }, {
          runRepair: () => Promise.resolve(REPORT),
          printHint: () => {},
          guard: process.deps,
        })
      );
      expect(process.endProcess()).toBe(0);
      expect(process.errors).toEqual([]);
    });

    it("says nothing at process end when the run threw", async () => {
      // A plan pinned to another fixer is refused before the module is even
      // imported. That refusal IS the report, and the CLI prints it on the
      // way to a nonzero exit; a guard line beside it would be a second
      // account of a run that already gave one.
      const process = guardHarness();
      await expect(
        repairFromCommand({ ...OPTIONS, path: "topics", apply: true }, {
          runRepair: () =>
            Promise.reject(new Error("The plan runs another fixer.")),
          printHint: () => {},
          guard: process.deps,
        }),
      ).rejects.toThrow("another fixer");
      expect(process.endProcess()).toBe(0);
      expect(process.errors).toEqual([]);
    });
  });

  describe("runRepair()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: (await Identity.generate()).did(),
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /** The smallest repairable member; `seed` is what the fixer changes. */
    function memberProgram(): RuntimeProgram {
      return {
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<{ seed?: string }>(({ seed }) => ({",
            "  [NAME]: 'Member',",
            "  seed,",
            "}));",
            "",
          ].join("\n"),
        }],
      };
    }

    const upperSeed = {
      default: (document: Readonly<Record<string, unknown>>) => ({
        ...document,
        ...(typeof document.seed === "string"
          ? { seed: document.seed.toUpperCase() }
          : {}),
      }),
    };

    it("imports the fixer, runs dry, and applies from the emitted plan", async () => {
      const member = await pieces.create(memberProgram(), {
        input: { seed: "alpha" },
      });
      const base = {
        selector: { kind: "list" as const, pieces: [member.id] },
        fixerPath: "/repairs/fix-seeds.ts",
        fixerName: "fix-seeds.ts",
      };
      // One snapshot serves identity and execution alike; the stubs stand
      // in for both halves of that single resolution.
      const snapshot = {
        main: "/fix-seeds.ts",
        files: [{ name: "/fix-seeds.ts", contents: "// stub" }],
      };
      const deps = {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces: unknown, token: string) =>
          Promise.resolve(token),
        resolveFixerProgram: (path: string) => {
          expect(path).toBe("/repairs/fix-seeds.ts");
          return Promise.resolve(snapshot);
        },
        programIdentity: (program: unknown) => {
          expect(program).toBe(snapshot);
          return Promise.resolve("impl-v1");
        },
        importProgram: (program: unknown) => {
          expect(program).toBe(snapshot);
          return Promise.resolve(upperSeed);
        },
      };

      const dry = await runRepair({} as never, base, deps as never);
      expect(dry.rows[0].verdict).toBe("would-change");
      expect(dry.applied).toBe(0);
      expect(dry.plan.rows[0].op).toEqual({
        kind: "repair",
        fixer: "fix-seeds.ts",
        fixerIdentity: "impl-v1",
      });

      // The emitted plan drives the apply, read back through the codec.
      const applied = await runRepair({} as never, {
        ...base,
        planPath: "/plans/repair.jsonl",
        apply: true,
      }, {
        ...deps,
        readTextFile: (path: string) => {
          expect(path).toBe("/plans/repair.jsonl");
          return Promise.resolve(
            [
              JSON.stringify(dry.plan.header),
              ...dry.plan.rows.map((row) => JSON.stringify(row)),
            ].join("\n"),
          );
        },
      } as never);
      expect(applied.rows[0].verdict).toBe("repaired");
      expect(applied.complete).toBe(true);

      // An edited fixer resolves to a different closure identity, and the
      // reviewed plan refuses before the module is even imported — a
      // dynamic import runs top-level code nobody reviewed.
      let imported = false;
      await expect(
        runRepair({} as never, {
          ...base,
          planPath: "/plans/repair.jsonl",
          apply: true,
        }, {
          ...deps,
          importProgram: () => {
            imported = true;
            return Promise.resolve(upperSeed);
          },
          programIdentity: () => Promise.resolve("impl-v2"),
          readTextFile: () =>
            Promise.resolve(
              [
                JSON.stringify(dry.plan.header),
                ...dry.plan.rows.map((row) => JSON.stringify(row)),
              ].join("\n"),
            ),
        } as never),
      ).rejects.toThrow("different fixer implementation");
      expect(imported).toBe(false);

      // A plan that cannot run any fixer — an op-less row — refuses before
      // the import too, for the same reason.
      let importedOpless = false;
      await expect(
        runRepair({} as never, {
          ...base,
          planPath: "/plans/repair.jsonl",
          apply: true,
        }, {
          ...deps,
          importProgram: () => {
            importedOpless = true;
            return Promise.resolve(upperSeed);
          },
          readTextFile: () =>
            Promise.resolve(
              [
                JSON.stringify(dry.plan.header),
                ...dry.plan.rows.map((row) => {
                  const { op: _, ...survey } = row;
                  return JSON.stringify(survey);
                }),
              ].join("\n"),
            ),
        } as never),
      ).rejects.toThrow("no repair operation");
      expect(importedOpless).toBe(false);

      const cell = await member.input.getCell();
      await cell.pull();
      expect(
        (cell.getRaw({ lastNode: "value" }) as { seed?: unknown }).seed,
      ).toBe("ALPHA");
    });

    it("hashes and executes one snapshot, whatever the disk does after", async () => {
      const member = await pieces.create(memberProgram(), {
        input: { seed: "alpha" },
      });
      const dir = await Deno.makeTempDir({ prefix: "cli-repair-fixer" });
      try {
        const fixerPath = `${dir}/fix-seeds.ts`;
        await Deno.writeTextFile(
          fixerPath,
          [
            'import { transform } from "./helper.ts";',
            "export default (document: Readonly<Record<string, unknown>>) => ({",
            "  ...document,",
            '  ...(typeof document.seed === "string"',
            "    ? { seed: transform(document.seed) }",
            "    : {}),",
            "});",
            "",
          ].join("\n"),
        );
        await Deno.writeTextFile(
          `${dir}/helper.ts`,
          "export const transform = (text: string) => text.toUpperCase();\n",
        );
        // The resolution is the test's hook: it hands the run the REAL
        // resolved snapshot, then rewrites both files on disk. The default
        // identity and import run on the snapshot, so the recorded pin and
        // the executed behavior must both be the originals.
        const snapshot = await resolveLocalSourceProgram(pieces.runtime, {
          main: fixerPath,
        });
        const expectedIdentity = await programEntryIdentity(snapshot);
        const dry = await runRepair({} as never, {
          selector: { kind: "list", pieces: [member.id] },
          fixerPath,
          fixerName: "fix-seeds.ts",
        }, {
          loadPieces: () => Promise.resolve(pieces),
          resolvePieceAddress: (_pieces: unknown, token: string) =>
            Promise.resolve(token),
          resolveFixerProgram: async () => {
            await Deno.writeTextFile(
              `${dir}/helper.ts`,
              "export const transform = (text: string) => " +
                "text.toLowerCase();\n",
            );
            await Deno.writeTextFile(
              fixerPath,
              "export default () => ({ hijacked: true });\n",
            );
            return snapshot;
          },
        } as never);
        expect(dry.rows[0].verdict).toBe("would-change");
        expect(dry.rows[0].changes).toEqual([
          { path: "/seed", kind: "changed", before: "alpha", after: "ALPHA" },
        ]);
        const op = dry.plan.rows[0].op;
        if (op?.kind !== "repair") throw new Error("expected a repair op");
        expect(op.fixerIdentity).toBe(expectedIdentity);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("never imports the fixer for a zero-row plan", async () => {
      // A holder with an empty collection: the dry run's plan has no
      // member rows, which is a valid artifact — and one that pins
      // nothing, so nothing may run under it, the import included.
      const holder = await pieces.create({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: [
            "import { NAME, pattern } from 'commonfabric';",
            "export default pattern<{ members?: unknown[] }>(",
            "  ({ members }) => ({ [NAME]: 'Holder', members }),",
            ");",
            "",
          ].join("\n"),
        }],
      }, { input: { members: [] } });
      // A real (if trivial) fixer file, so the default snapshot
      // resolution and identity run for real; only the import is a spy.
      const dir = await Deno.makeTempDir({ prefix: "cli-repair-zero" });
      const fixerPath = `${dir}/fix.ts`;
      await Deno.writeTextFile(
        fixerPath,
        "export default (d: Readonly<Record<string, unknown>>) => ({ ...d });\n",
      );
      let imports = 0;
      const deps = {
        loadPieces: () => Promise.resolve(pieces),
        resolvePieceAddress: (_pieces: unknown, token: string) =>
          Promise.resolve(token),
        importProgram: () => {
          imports += 1;
          return Promise.resolve(upperSeed);
        },
      };
      const base = {
        selector: {
          kind: "collection" as const,
          holder: holder.id,
          path: ["members"],
        },
        fixerPath,
        fixerName: "fix.ts",
      };
      const dry = await runRepair({} as never, base, deps as never);
      expect(dry.plan.rows).toEqual([]);
      expect(imports).toBe(1);

      const applied = await runRepair({} as never, {
        ...base,
        planPath: "/plans/empty.jsonl",
        apply: true,
      }, {
        ...deps,
        readTextFile: () => Promise.resolve(JSON.stringify(dry.plan.header)),
      } as never);
      expect(applied.rows).toEqual([]);
      expect(applied.complete).toBe(true);
      expect(applied.applied).toBe(0);
      // The dry run imported once; the zero-row apply imported nothing.
      expect(imports).toBe(1);
      await Deno.remove(dir, { recursive: true });
      // The stub a zero-row run carries refuses if anything ever calls it.
      expect(() => zeroRowFixer()).toThrow("runs no fixer");
    });

    it("refuses a fixer module that does not default-export a function", async () => {
      const member = await pieces.create(memberProgram(), {
        input: { seed: "alpha" },
      });
      await expect(
        runRepair({} as never, {
          selector: { kind: "list", pieces: [member.id] },
          fixerPath: "/repairs/empty.ts",
          fixerName: "empty.ts",
        }, {
          loadPieces: () => Promise.resolve(pieces),
          resolvePieceAddress: (_pieces: unknown, token: string) =>
            Promise.resolve(token),
          resolveFixerProgram: () =>
            Promise.resolve({
              main: "/empty.ts",
              files: [{ name: "/empty.ts", contents: "" }],
            }),
          programIdentity: () => Promise.resolve("impl-v1"),
          importProgram: () => Promise.resolve({}),
        } as never),
      ).rejects.toThrow("must default-export the fixer function");
    });
  });
});
