import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { ExecutorHost } from "../../src/executor/host.ts";
import type { CurrencyIndexMode } from "../../src/executor/store-currency.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";
import { ArrivalLog, awaitEach } from "../support/serving-waits.ts";

/** The space whose piece computes an output once for each viewer. */
const source = (await Identity.fromPassphrase(
  "space-server carried demand source",
)).did() as MemorySpace;

/** The space whose piece reads that output, and which the viewers open. */
const reader = (await Identity.fromPassphrase(
  "space-server carried demand reader",
)).did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "space-server carried demand service",
);
const setupSigner = await Identity.fromPassphrase(
  "space-server carried demand setup",
);
const aliceSigner = await Identity.fromPassphrase(
  "space-server carried demand alice",
);
const bobSigner = await Identity.fromPassphrase(
  "space-server carried demand bob",
);

/**
 * A piece with one output, `mine`, derived from `n` once for each viewer
 * who demands it.
 */
const SOURCE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern, PerUser } from 'commonfabric';",
      "export default pattern<{ n?: number }, { mine: string }>(({ n }) => {",
      "  const mine = computed((): PerUser<string> => 'mine:' + String(n ?? 0));",
      "  return { mine };",
      "});",
    ].join("\n"),
  }],
};

/** A piece with one output, `shout`, derived from what it was handed. */
const READER_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { computed, pattern } from 'commonfabric';",
      "export default pattern<{ from: string }, { shout: string }>(",
      "  ({ from }) => ({ shout: computed(() => 'read:' + from) }),",
      ");",
    ].join("\n"),
  }],
};

/** Longer than the memory server keeps the session of a client that left. */
const DETACHED_SESSION_MS = 31_000;

describe("SpaceServer", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost | undefined;
  let cycles: ArrivalLog<unknown>;

  /** The runtimes the host made, one for each space it has served. */
  let servingRuntimes: Runtime[];
  const opened: { runtime: Runtime; manager: EmulatedStorageManager }[] = [];

  /** A client runtime over the shared server, acting for `as`. */
  const openRuntime = (as: Identity): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    opened.push({ runtime, manager });
    return runtime;
  };

  /** Disposes the runtime `openRuntime()` returned last. */
  const closeLastRuntime = async () => {
    const { runtime, manager } = opened.pop()!;
    await runtime.dispose();
    await manager.close();
  };

  beforeEach(() => {
    server = newSharedServer({
      subscriptionRefreshDelayMs: 0,
      // A serving runtime's read of a named instance in a space it does
      // not serve is admitted for the service identity.
      delegatingDids: [serviceSigner.did()],
    });
    cycles = new ArrivalLog();
    servingRuntimes = [];
  });

  /** A host that keeps the currency index as `mode` says. */
  const newHost = (mode: CurrencyIndexMode): ExecutorHost =>
    new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (space) => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
          servingHomeSpace: space,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        servingRuntimes.push(runtime);
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: {
        idleParkMs: 600_000,
        currencyIndex: mode,
        currencyEpoch: "test-epoch",
      },
      onWaveCycle: cycles.record,
    });

  afterEach(async () => {
    await host?.close();
    host = undefined;
    for (const { runtime, manager } of opened.splice(0)) {
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  /** The rows of `source`'s demand set that another space carried there. */
  const carriedIntoSource = () =>
    server.demandForSpace(source).flatMap((share) => [
      ...share.rows.values(),
    ]).filter((row) => row.origin !== undefined);

  /**
   * The scope keys at which `source`'s store holds an instance of a
   * document some computation derived.
   */
  const derivedInstancesOfSource = async (): Promise<string[]> =>
    ((await server.engineForSpace(source)).database.prepare(
      `SELECT DISTINCT scope_key FROM head WHERE id LIKE 'computed:%'`,
    ).all() as Array<{ scope_key: string }>).map((row) => row.scope_key)
      .sort();

  /** The key of `signer`'s own instances. */
  const ownKey = (signer: Identity): string =>
    resolveScopeKey("user", { principal: signer.did() });

  /** Resolves once `viewer` reads `shout` from the reader piece's result. */
  const reads = (
    viewer: Runtime,
    result: Cell<{ shout: string }>,
    shout: string,
  ) =>
    waitForCellValue(
      viewer,
      result.key("shout"),
      (value: string | undefined) => value === shout,
      { stuckLabel: `a viewer to read ${shout} through the piece` },
    );

  /** Whether a serving runtime runs the piece rooted at `root`. */
  const serves = (root: NormalizedFullLink) =>
    servingRuntimes.some((runtime) =>
      runtime.runner.isRunning(runtime.getCellFromLink(root))
    );

  /** Commits a write to a document of `reader` that no piece reads. */
  const touchReader = async () => {
    const writer = openRuntime(setupSigner);
    const cell = writer.getCell<number>(reader, "carried demand touch", {
      type: "number",
    });
    await cell.sync();
    const tx = writer.edit();
    cell.withTx(tx).set(1);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.storageManager.synced();
    await closeLastRuntime();
  };

  /** Sets the source piece's `n`, as a client that then leaves. */
  const changeSourceInput = async (n: number) => {
    const setup = openRuntime(setupSigner);
    const sourceArgument = setup.getCell<{ n?: number }>(
      source,
      "carried demand source argument",
    );
    await sourceArgument.sync();
    const tx = setup.edit();
    sourceArgument.withTx(tx).set({ n });
    expect((await tx.commit().settled).error).toBeUndefined();
    await setup.storageManager.synced();
    await closeLastRuntime();
  };

  /**
   * Stands the source piece up as a client that then leaves, so that no
   * session of `source` demands it, and the reader piece as alice, whose
   * argument is the source piece's `mine`, under a host that keeps the
   * index as `mode` says. Returns once bob watches the reader's result too.
   */
  const standUp = async (mode: CurrencyIndexMode = "record") => {
    host = newHost(mode);
    await server.writeDocument(source, aclDocId(source), {
      [setupSigner.did()]: "OWNER",
      [aliceSigner.did()]: "READ",
      [bobSigner.did()]: "READ",
    });
    const setup = openRuntime(setupSigner);
    const made = await setup.patternManager.compilePattern(SOURCE_PROGRAM, {
      space: source,
    });
    const sourceArgument = setup.getCell<{ n?: number }>(
      source,
      "carried demand source argument",
      made.argumentSchema,
    );
    const sourceResult = setup.getCell<{ mine: string }>(
      source,
      "carried demand source result",
      made.resultSchema,
    );
    await sourceArgument.sync();
    await sourceResult.sync();
    {
      const tx = setup.edit();
      sourceArgument.withTx(tx).set({ n: 0 });
      setup.run(tx, made, sourceArgument, sourceResult);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    sourceResult.sink(() => {});
    await waitForCellValue(
      setup,
      sourceResult.key("mine"),
      (mine: string | undefined) => mine === "mine:0",
      { stuckLabel: "the setup client's own instance to be computed" },
    );
    await host!.whenQuiescent();
    await closeLastRuntime();
    await host!.whenQuiescent();
    await clock.tick(DETACHED_SESSION_MS);
    await host!.whenQuiescent();

    const alice = openRuntime(aliceSigner);
    const compiled = await alice.patternManager.compilePattern(
      READER_PROGRAM,
      { space: reader },
    );
    const argument = alice.getCell<{ from: unknown }>(
      reader,
      "carried demand reader argument",
      compiled.argumentSchema,
    );
    const result = alice.getCell<{ shout: string }>(
      reader,
      "carried demand reader result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    {
      const tx = alice.edit();
      argument.withTx(tx).set({
        from: alice.getCell<{ mine: string }>(
          source,
          "carried demand source result",
          made.resultSchema,
          tx,
        ).key("mine"),
      });
      alice.run(tx, compiled, argument, result);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    result.sink(() => {});
    const bob = openRuntime(bobSigner);
    const bobResult = bob.getCell<{ shout: string }>(
      reader,
      "carried demand reader result",
      compiled.resultSchema,
    );
    await bobResult.sync();
    bobResult.sink(() => {});
    return { alice, result, bob, bobResult };
  };

  describe("instance members", () => {
    describe("carrying two viewers' demand into a space whose per-user output a piece read", () => {
      it("has that space's loop compute each viewer's instance, which each viewer then reads through the piece", async () => {
        // Neither viewer has a session in the source space: what demands
        // their instances there is what the reading space's loop carries.

        const { alice, result, bob, bobResult } = await standUp();

        await reads(alice, result, "read:mine:0");
        await reads(bob, bobResult, "read:mine:0");

        expect(await derivedInstancesOfSource()).toEqual(
          [setupSigner, aliceSigner, bobSigner].map(ownKey).sort(),
        );
        expect(host!.stats().currency.carriedRefused).toBe(0);
      });

      it("carries nothing into that space once it holds each viewer's instance as current", async () => {
        const { alice, result, bob, bobResult } = await standUp();
        await reads(alice, result, "read:mine:0");
        await reads(bob, bobResult, "read:mine:0");

        await awaitEach(cycles, () => carriedIntoSource().length === 0);

        expect(host!.stats().currency.carried).toBeGreaterThan(0);
      });

      it("brings each viewer the value that space derives after an input of it changed", async () => {
        const { alice, result, bob, bobResult } = await standUp();
        await reads(alice, result, "read:mine:0");
        await reads(bob, bobResult, "read:mine:0");

        await changeSourceInput(1);

        await reads(alice, result, "read:mine:1");
        await reads(bob, bobResult, "read:mine:1");
      });

      it("vouches for each viewer's slice of the reading piece, which read that viewer's own instance", async () => {
        const { alice, result, bob, bobResult } = await standUp();
        await reads(alice, result, "read:mine:0");
        await reads(bob, bobResult, "read:mine:0");
        await host!.whenQuiescent();

        expect(host!.stats().currency.unvouched["foreign-read"])
          .toBeUndefined();
      });

      it("leaves the reading piece unstarted, and carries nothing, for viewers whose instances in that space have not changed, under `start-upstream`", async () => {
        const { alice, result, bob, bobResult } = await standUp(
          "start-upstream",
        );
        await reads(alice, result, "read:mine:0");
        await reads(bob, bobResult, "read:mine:0");
        await host!.whenQuiescent();
        const root = result.getAsNormalizedFullLink();

        await host!.spaceServer(reader)!.park("test-park");
        await touchReader();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore > 0,
        );
        await host!.whenQuiescent();

        expect(serves(root)).toBe(false);
        expect(carriedIntoSource()).toEqual([]);
      });

      it("starts the reading piece left unstarted once an input of that space's piece changed, and brings each viewer the new value, under `start-upstream`", async () => {
        const { alice, result, bob, bobResult } = await standUp(
          "start-upstream",
        );
        await reads(alice, result, "read:mine:0");
        await reads(bob, bobResult, "read:mine:0");
        await host!.whenQuiescent();
        await host!.spaceServer(reader)!.park("test-park");
        await touchReader();
        await awaitEach(
          cycles,
          () => host!.stats().currency.servedFromStore > 0,
        );
        await host!.whenQuiescent();

        await changeSourceInput(1);

        await reads(alice, result, "read:mine:1");
        await reads(bob, bobResult, "read:mine:1");
      });

      it("carries nothing into that space under `skip`, which then computes no instance for a viewer with no session there", async () => {
        // Alice's client reads the source piece's result as it sets up the
        // reader, which is a session of hers in that space. Bob has none.

        await standUp("skip");
        await host!.whenQuiescent();

        expect(host!.stats().currency.carried).toBe(0);
        expect(carriedIntoSource()).toEqual([]);
        expect(await derivedInstancesOfSource()).toEqual(
          [setupSigner, aliceSigner].map(ownKey).sort(),
        );
      });
    });
  });
});
