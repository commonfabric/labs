import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { MirrorData } from "./mirror.ts";
import { refreshMirror } from "./sync.ts";
import { type BoardServer, boardServer } from "./board-fixture.ts";

const PATTERNS_ROOT = fromFileUrl(
  new URL("../../..", import.meta.url),
);
const BOARD_MAIN = fromFileUrl(
  new URL("../main.tsx", import.meta.url),
);

describe("the Topics pattern's storage, read through the copy", () => {
  let board: BoardServer;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(async () => {
    board = await boardServer();
    storage = EmulatedStorageManager.connectTo(board.server, {
      as: await Identity.fromPassphrase("topics tool pattern layout"),
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

  it("returns the Topics, comments, and links the board's own verbs wrote", async () => {
    // The fixture the other tests read is written by hand; this one is
    // written by the Topics pattern in this checkout, so a change to where
    // the pattern stores a Topic fails here.

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
      runtime.getCell(space, "topics-tool-board", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const cancel = root.sink(() => {});
    await runtime.idle();

    root.key("addTopic").send({
      title: "Fryer test",
      body: "Fails when the oil is cold.",
      agentName: "Sol",
    });
    await runtime.idle();
    const topic = root.key("topics").key(0);
    topic.key("addComment").send({ body: "Reproduced.", agentName: "Bo" });
    topic.key("addLink").send({
      url: "https://example.com/pull/1",
      kind: "pr",
      label: "Fix",
      agentName: "Bo",
    });
    await runtime.idle();
    await storage.synced();
    cancel();

    const data: MirrorData = { pieces: {}, docs: {} };
    const source = await board.open(space);
    try {
      const { topics } = await refreshMirror(
        data,
        root.getAsNormalizedFullLink().id,
        source,
      );

      expect(topics.map((t) => ({
        number: t.number,
        title: t.title,
        body: t.body,
        createdBy: t.createdBy,
        comments: t.comments.map((c) => [c.author, c.body, c.removed]),
        links: t.links.map((l) => [l.kind, l.url, l.label, l.addedBy]),
      }))).toEqual([{
        number: "1",
        title: "Fryer test",
        body: "Fails when the oil is cold.",
        createdBy: "Sol (agent)",
        comments: [["Bo (agent)", "Reproduced.", false]],
        links: [["pr", "https://example.com/pull/1", "Fix", "Bo (agent)"]],
      }]);
      expect(topics[0].lastActivityAt).toBeGreaterThan(0);
    } finally {
      await source.close();
    }
  });
});
