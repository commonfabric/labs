/**
 * What a FabriChat message row tallies from a message whose reactions include
 * one its schema doesn't accept, from a runtime that runs the row directly. No
 * handler stores such a reaction, so a pattern test, which writes through the
 * room's handlers, can't make one; this writes the message and its reactions
 * as plain data, each reaction a document of its own, as a send stores them.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { FabricEpochNsec } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

const PATTERNS_ROOT = fromFileUrl(new URL("../..", import.meta.url));
const ROW_MAIN = fromFileUrl(new URL("./message-row.tsx", import.meta.url));

describe("message-row", () => {
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(async () => {
    storage = EmulatedStorageManager.emulate({
      as: await Identity.fromPassphrase("fabrichat row malformed reactions"),
    });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  /**
   * Runs a row over a message whose reactions are the one `reactionBy` makes
   * of a reactor's profile, between two well-formed ones, and returns the
   * row's `tallies`, once derived.
   */
  const talliesAround = async (
    reactionBy: (profile: unknown) => Record<string, unknown>,
  ) => {
    const space = storage.as.did();
    const program = await resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      { main: ROW_MAIN, root: PATTERNS_ROOT },
    );
    const compiled = await runtime.patternManager.compilePattern(
      { ...program, mainExport: "FabriChatMessageRow" },
      { space },
    );
    // Everything is written as plain data, outside the room's schema, so
    // neither its write policy nor its types apply.
    const tx = runtime.edit();
    const cell = (cause: string, value: unknown) => {
      const made = runtime.getCell<unknown>(space, cause, undefined, tx);
      made.set(value);
      return made;
    };
    const alice = cell("fabrichat-row-malformed-reactions-alice", {
      name: "Alice",
    });
    const bob = cell("fabrichat-row-malformed-reactions-bob", { name: "Bob" });
    const reactions = cell(
      "fabrichat-row-malformed-reactions-reactions",
      [
        {
          emoji: "👍",
          sentAt: new FabricEpochNsec(10n),
          reactorProfile: alice,
        },
        reactionBy(bob),
        { emoji: "🎉", sentAt: new FabricEpochNsec(12n), reactorProfile: bob },
      ].map((each, index) =>
        cell(`fabrichat-row-malformed-reactions-reaction-${index}`, each)
      ),
    );
    const messages = cell("fabrichat-row-malformed-reactions-messages", [
      { body: "Hello", sentAt: new FabricEpochNsec(1n), reactions },
    ]);
    const row = runtime.run(
      tx,
      compiled,
      {
        message: messages.key(0),
        inThread: false,
        kind: "group",
        composer: {},
        places: {},
        cannotWrite: false,
        rowFacts: {},
        messages,
      },
      runtime.getCell(
        space,
        "fabrichat-row-malformed-reactions",
        undefined,
        tx,
      ),
    );
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    const tallies = row.key("tallies");
    await tallies.pull();
    return tallies.get();
  };

  /** Checks that `tallies` count the two well-formed reactions and only them. */
  const expectOnlyWellFormed = (
    tallies: Awaited<ReturnType<typeof talliesAround>>,
  ) => {
    // A row that tallies nothing reads `undefined` here.
    expect(tallies).toBeDefined();
    expect(tallies).toEqual([
      expect.objectContaining({ emoji: "👍", count: 1 }),
      expect.objectContaining({ emoji: "🎉", count: 1 }),
    ]);
  };

  describe("tallies", () => {
    it("counts each well-formed reaction", async () => {
      expect(
        await talliesAround((profile) => ({
          emoji: "😀",
          sentAt: new FabricEpochNsec(11n),
          reactorProfile: profile,
        })),
      ).toEqual([
        expect.objectContaining({ emoji: "👍", count: 1 }),
        expect.objectContaining({ emoji: "😀", count: 1 }),
        expect.objectContaining({ emoji: "🎉", count: 1 }),
      ]);
    });

    describe("a stored reaction its schema doesn't accept", () => {
      it("is left out when its `sentAt` is a bare bigint", async () => {
        expectOnlyWellFormed(
          await talliesAround((profile) => ({
            emoji: "😀",
            sentAt: 11n,
            reactorProfile: profile,
          })),
        );
      });

      it("is left out when its `emoji` isn't text", async () => {
        expectOnlyWellFormed(
          await talliesAround((profile) => ({
            emoji: 42,
            sentAt: new FabricEpochNsec(11n),
            reactorProfile: profile,
          })),
        );
      });

      it("is left out when it lacks a `sentAt`", async () => {
        expectOnlyWellFormed(
          await talliesAround((profile) => ({
            emoji: "😀",
            reactorProfile: profile,
          })),
        );
      });

      it("is left out when it lacks a `reactorProfile`", async () => {
        expectOnlyWellFormed(
          await talliesAround(() => ({
            emoji: "😀",
            sentAt: new FabricEpochNsec(11n),
          })),
        );
      });

      it("is left out when its `reactorProfile` isn't a link", async () => {
        expectOnlyWellFormed(
          await talliesAround(() => ({
            emoji: "😀",
            sentAt: new FabricEpochNsec(11n),
            reactorProfile: 42,
          })),
        );
      });
    });
  });
});
