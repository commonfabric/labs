import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { MirrorData } from "../../topics/tools/mirror.ts";
import {
  type BoardServer,
  boardServer,
} from "../../topics/tools/board-fixture.ts";
import { readReports } from "./read.ts";

const PATTERNS_ROOT = fromFileUrl(new URL("../../..", import.meta.url));
const ID = "0123456789abcdef".repeat(2);
const BOARD_MAIN = fromFileUrl(new URL("../main.tsx", import.meta.url));

describe("the reports pattern's storage, read through the copy", () => {
  let board: BoardServer;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(async () => {
    board = await boardServer();
    storage = EmulatedStorageManager.connectTo(board.server, {
      as: await Identity.fromPassphrase("feedback reports tool layout"),
    });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
    await board.close();
  });

  it("returns the reports the board's own verbs wrote, each with its sender", async () => {
    // Written by the pattern in this checkout, so a change to where it
    // stores a report, or to the label that names its sender, fails here.
    const space = storage.as.did();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: BOARD_MAIN, root: PATTERNS_ROOT },
    );
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    const tx = runtime.edit();
    const root = runtime.run(
      tx,
      compiled,
      {},
      runtime.getCell(space, "feedback-reports-tool-board", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = root.sink(() => {});
    await runtime.idle();

    root.key("addReport").send({
      agentName: "cfs-feedback",
      id: ID,
      name: "quiet-heron-41",
      kind: "broke",
      words: "Mail stopped.",
      structured: {
        source: "failure-card",
        want: { cause: "auth-expired", stop: "gmail-sync" },
        futureField: { kept: [1] },
      },
    });
    await runtime.idle();
    root.key("linkTopic").send({
      agentName: "Triage",
      id: ID,
      topic: "of:fid1:topic",
    });
    await runtime.idle();
    await storage.synced();
    cancel();

    const data: MirrorData = { pieces: {}, docs: {} };
    const source = await board.open(space);
    try {
      const reports = await readReports(
        data,
        root.getAsNormalizedFullLink().id,
        source,
      );

      expect(reports).toEqual([{
        id: ID,
        name: "quiet-heron-41",
        kind: "broke",
        words: "Mail stopped.",
        structured: {
          source: "failure-card",
          want: { cause: "auth-expired", stop: "gmail-sync" },
          futureField: { kept: [1] },
        },
        createdAt: reports[0]?.createdAt,
        topic: "of:fid1:topic",
        // Who linked the report, from the link's own label.
        topicAuthors: [space],
        authors: [space],
      }]);
      expect(reports[0].createdAt).toBeGreaterThan(0);
    } finally {
      await source.close();
    }
  });
});
