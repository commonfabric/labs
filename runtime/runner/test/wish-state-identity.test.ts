/**
 * Two sessions, each running a piece from its own compilation of the piece's
 * pattern, over one shared space. The two compilations declare the wish's
 * result under schemas that differ, so the serialized inputs of the wish node
 * differ while its output slot is the same. A module's pattern identity hashes
 * its authored source and imports alone, not the schemas compiling it
 * generated, so two such compilations can stand under one identity. Both
 * compilations name one wish state, and each reads its own user's result
 * through it.
 *
 * Each wish resolves its output slot's write redirects when it writes its
 * result, and that resolution reads the slot, so a wish re-runs when another
 * session rewrites the slot. The wish built-in is registered with a 50 ms
 * debounce, and the fake clock the runner suite installs moves only when a
 * test moves it, which is why a case that looks for a loop ticks the clock:
 * without the ticks no wish re-run comes due, and a loop between the two
 * sessions would never show.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { parseLink } from "../src/link-utils.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const alice = await Identity.fromPassphrase("wish state identity alice");
const bob = await Identity.fromPassphrase("wish state identity bob");
const space = (await Identity.fromPassphrase("wish state identity space"))
  .did();

const CAUSE = "wish state identity piece";
const TAG = "wish_state_identity_profile";

/** Rounds of clock time both sessions run through once settled. */
const ROUNDS = 6;

/** Clock time per round, past the debounce a wish's re-run waits out. */
const ROUND_MS = 1000;

type Result = { name: string | undefined; found: unknown };

/**
 * A piece whose `name` is the viewer's own favorite tagged `TAG`, found through
 * the viewer's Home, with the wish's result declared as `resultType`.
 */
const program = (resultType: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { pattern, wish } from "commonfabric";',
      "",
      "export default pattern<{}, { name: string | undefined; found: unknown }>(",
      "  () => {",
      `    const found = wish<${resultType}>({ query: "#${TAG}", scope: ["~"] });`,
      "    return { name: found.result?.name, found };",
      "  },",
      ");",
    ].join("\n"),
  }],
});

describe("wish-state-identity", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let a: Runtime;
  let b: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: alice });
    storageB = EmulatedStorageManager.connectTo(server, { as: bob });
    a = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    b = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await a?.dispose();
    await b?.dispose();
    await storageA?.close();
    await storageB?.close();
    await server?.close();
  });

  /** Gives `user`'s Home one favorite tagged `TAG`, named after the user. */
  async function seedHome(runtime: Runtime, user: Identity): Promise<void> {
    const home = user.did() as MemorySpace;
    const tx = runtime.edit();
    const favorite = runtime.getCell(home, "favorite", undefined, tx);
    favorite.set({ name: `favorite of ${user.did()}` });
    const homeCell = runtime.getCell(home, home, undefined, tx);
    homeCell.set({
      defaultPattern: { favorites: [{ cell: favorite, tags: [TAG] }] },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
  }

  /** Syncs `runtime` with the server and refreshes `result` from it. */
  async function settle(
    runtime: Runtime,
    storage: EmulatedStorageManager,
    result: { pull(): Promise<unknown> },
  ): Promise<void> {
    await runtime.idle();
    await storage.synced();
    await result.pull();
  }

  /**
   * The wish state `result`'s `found` slot links to: the slot is the wish
   * node's output document, and what it holds is the link the wish wrote.
   */
  async function wishStateLink(
    runtime: Runtime,
    result: Cell<Result>,
  ): Promise<NormalizedFullLink> {
    const slot = runtime.getCellFromLink(
      parseLink(result.key("found").getRaw(), result)!,
    );
    await slot.pull();
    return parseLink(slot.getRaw(), slot)!;
  }

  /**
   * Alice's session creates the piece from a program declaring the wish's
   * result as `{ name: string }`, and watches its result, as a session
   * rendering the piece does. Returns the result, the compilation, and the
   * function that stops the watch.
   */
  async function createAsAlice(): Promise<{
    resultA: Cell<Result>;
    compiledA: Pattern;
    cancelA: () => void;
  }> {
    const txA = a.edit();
    const compiledA = await a.patternManager.compilePattern(
      program("{ name: string }"),
      { space, tx: txA },
    );
    const resultA = a.getCell<Result>(space, CAUSE, undefined, txA);
    a.run(txA, compiledA, {}, resultA);
    a.prepareTxForCommit(txA);
    expect((await txA.commit().settled).error).toBeUndefined();
    const cancelA = resultA.key("name").sink(() => {});
    await settle(a, storageA, resultA);
    return { resultA, compiledA, cancelA };
  }

  it("names one state when a compilation whose wish inputs differ repoints the piece", async () => {
    // Bob's session runs the piece from its own compilation, which writes that
    // compilation's pattern identity into the piece. Alice's session follows
    // the pointer and re-runs Bob's program, so both sessions end on one
    // compilation, and what the case shows is that the wish state survives the
    // change of compilation under it. Nothing is left running two compilations
    // for a loop to form between, so the case does not look for one.

    await seedHome(a, alice);
    await seedHome(b, bob);
    const { resultA, cancelA } = await createAsAlice();
    expect(resultA.key("name").get()).toBe(`favorite of ${alice.did()}`);
    const stateA = await wishStateLink(a, resultA);
    expect(stateA.scope).toBe("user");

    // Bob's session runs the same piece from a program declaring the result
    // with one more member, so its wish node serializes different inputs to
    // the same output slot.
    const compiledB = await b.patternManager.compilePattern(
      program("{ name: string; avatar?: string }"),
      { space },
    );
    const resultB = b.getCell<Result>(space, CAUSE, compiledB.resultSchema);
    await b.runner.runSynced(resultB, compiledB, {});
    const cancelB = resultB.key("name").sink(() => {});
    try {
      await b.settled();
      await settle(b, storageB, resultB);
      await settle(a, storageA, resultA);
      expect(resultB.key("name").get()).toBe(`favorite of ${bob.did()}`);
      expect(resultA.key("name").get()).toBe(`favorite of ${alice.did()}`);

      // One state document behind the shared slot, from both sides.
      const stateB = await wishStateLink(b, resultB);
      expect(stateB).toMatchObject({ id: stateA.id, scope: "user" });
      expect(await wishStateLink(a, resultA)).toMatchObject({
        id: stateA.id,
        scope: "user",
      });
    } finally {
      cancelB();
      cancelA();
    }
  });

  it("settles two artifacts under one pattern identity on one state", async () => {
    // Bob's session starts the piece from its stored pointer, as a session
    // opening an existing piece does, with its own artifact registered under
    // that identity. Neither pointer moves, so both compilations stay live side
    // by side for as long as both sessions run. A wish that wrote a state of
    // its own behind the shared slot would take the slot back on every round,
    // and the remote-echo breaker would count each turn. With one state behind
    // the slot, a settled pair writes nothing however long the clock runs.

    await seedHome(a, alice);
    await seedHome(b, bob);
    const { resultA, compiledA, cancelA } = await createAsAlice();
    const identity = a.patternManager.getArtifactEntryRef(compiledA);
    expect(identity).toBeDefined();

    // Bob's session holds, under that same identity, an artifact whose wish
    // declares its result with one more member, and starts the piece from its
    // stored pointer.
    const compiledB = await b.patternManager.compilePattern(
      program("{ name: string; avatar?: string }"),
      { space },
    );
    b.patternManager.associatePatternIdentity(compiledB, identity!);
    const resultB = b.getCell<Result>(space, CAUSE, compiledB.resultSchema);
    await resultB.sync();
    expect(await b.runner.startWithCommit(resultB)).toBe(true);
    const cancelB = resultB.key("name").sink(() => {});
    try {
      await settle(b, storageB, resultB);
      await settle(a, storageA, resultA);

      // Both compilations are live: the pointer still names the identity
      // Alice's session wrote, and Bob's runtime resolves it to its own
      // artifact.
      for (const result of [resultA, resultB]) {
        expect(result.getMetaRaw("patternIdentity")).toEqual(identity);
      }
      expect(
        b.patternManager.artifactFromIdentitySync(
          identity!.identity,
          identity!.symbol,
        ),
      ).toBe(compiledB);

      // One state behind the shared slot, read from both sides.
      const state = await wishStateLink(a, resultA);
      expect(state.scope).toBe("user");
      expect(await wishStateLink(b, resultB)).toMatchObject({
        id: state.id,
        scope: "user",
      });

      // Once settled, neither session writes again however long both run.
      const engine = await server.engineForSpace(space);
      const seq = Engine.serverSeq(engine);
      for (let round = 0; round < ROUNDS; round++) {
        await clock.tick(ROUND_MS);
        await settle(a, storageA, resultA);
        await settle(b, storageB, resultB);
      }
      expect(Engine.serverSeq(engine)).toBe(seq);
      expect(resultA.key("name").get()).toBe(`favorite of ${alice.did()}`);
      expect(resultB.key("name").get()).toBe(`favorite of ${bob.did()}`);
      const nothing = { active: 0, trips: 0, cyclesObserved: 0 };
      expect(a.scheduler.getEchoBreakerStats()).toEqual(nothing);
      expect(b.scheduler.getEchoBreakerStats()).toEqual(nothing);
    } finally {
      cancelB();
      cancelA();
    }
  });
});
