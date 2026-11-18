import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import type { RuntimeProgram } from "@commonfabric/runner";
import type { PatternIndexPublishResponse } from "@commonfabric/pattern-index/client";
import { checkpoint } from "../commands/pattern.ts";
import type {
  DeployedSource,
  VersionOutcome,
} from "../lib/pattern-versions.ts";
import type { RunningPattern } from "../lib/piece.ts";

const PROGRAM: RuntimeProgram = {
  main: "/bins.tsx",
  files: [{ name: "/bins.tsx", contents: 'export default () => "bins";\n' }],
};

const RUNNING: RunningPattern = {
  space: "did:key:z6Mkspace",
  id: "fid1:piece",
  patternId: "pat-running",
  program: PROGRAM,
};

const RECORDED: PatternIndexPublishResponse = {
  patternId: "pat-running",
  created: true,
  versionId: "ver-1",
  lineageId: "lin-1",
  seq: 4,
  visibility: "private",
  share: "none",
  autoShare: "kept_private",
};

const OPTIONS = {
  apiUrl: "https://cf.dev",
  space: "s",
  identity: "/unused/test.key",
  cell: "fid1:piece",
};

describe("cf pattern checkpoint", () => {
  afterEach(() => {
    Deno.exitCode = 0;
  });

  /** Runs the command against `outcome`, answering what it sent and printed. */
  const run = async (
    outcome: VersionOutcome,
    more: { json?: boolean } = {},
  ) => {
    const sent: DeployedSource[] = [];
    const printed: unknown[] = [];
    let readFor: unknown;
    await checkpoint({ ...OPTIONS, ...more }, "./bins.tsx", {
      readRunning: (config) => {
        readFor = config;
        return Promise.resolve(RUNNING);
      },
      recordVersion: (deployed) => {
        sent.push(deployed);
        return Promise.resolve(outcome);
      },
      render: (value) => printed.push(value),
    });
    return { sent, printed, readFor };
  };

  it("keeps what the piece runs, not the files, as a private version of the entry's lineage", async () => {
    const { sent, printed, readFor } = await run({
      status: "recorded",
      created: true,
      response: RECORDED,
    });

    expect(readFor).toMatchObject({ piece: "fid1:piece" });
    expect(sent).toHaveLength(1);
    const [deployed] = sent;
    expect(deployed.entry).toBe(resolve("./bins.tsx"));
    expect(deployed.keepPrivate).toBe(true);
    expect(await deployed.patternId()).toBe("pat-running");
    expect(deployed.program).toBe(PROGRAM);
    expect(deployed.piece).toEqual({
      space: "did:key:z6Mkspace",
      id: "fid1:piece",
    });
    expect(Object.hasOwn(deployed, "origin")).toBe(false);
    expect(printed).toEqual([
      "Kept as private version 4; cf pattern history lists them.",
    ]);
    expect(Deno.exitCode).toBe(0);
  });

  it("says why and exits 1 when no version was kept, since one was asked for", async () => {
    for (
      const [outcome, line] of [
        [
          { status: "failed", reason: "index down" },
          "No version kept: index down.",
        ],
        [
          { status: "not-joined", firstTime: false },
          "No version kept: this machine has not joined a pattern index (cf index join).",
        ],
        [
          { status: "skipped", reason: "it is pat-x unchanged" },
          "No version kept: it is pat-x unchanged.",
        ],
      ] satisfies [VersionOutcome, string][]
    ) {
      Deno.exitCode = 0;
      const { printed } = await run(outcome);
      expect(printed).toEqual([line]);
      expect(Deno.exitCode).toBe(1);
    }
  });

  it("reports the outcome as JSON", async () => {
    const { printed } = await run(
      { status: "recorded", created: false, response: RECORDED },
      { json: true },
    );
    expect(printed).toEqual([{
      status: "unchanged",
      version: 4,
      visibility: "private",
      autoShare: "kept_private",
    }]);
  });

  it("refuses without a piece, before reading anything", async () => {
    let read = false;
    await expect(
      checkpoint(
        { apiUrl: "https://cf.dev", space: "s", identity: "/unused/test.key" },
        "./bins.tsx",
        {
          readRunning: () => {
            read = true;
            return Promise.resolve(RUNNING);
          },
        },
      ),
    ).rejects.toThrow(/Missing required option/);
    expect(read).toBe(false);
  });
});
