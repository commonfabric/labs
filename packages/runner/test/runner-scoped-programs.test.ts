import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import type { Cell } from "../src/cell.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const alice = await Identity.fromPassphrase("scoped program lifecycle Alice");
const bob = await Identity.fromPassphrase("scoped program lifecycle Bob");
const space = bob.did();

describe("runner-scoped-programs", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let lease: ExecutionLeaseCycle;
  let demands: Array<() => void>;

  beforeEach(async () => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const holder = executionLeaseHolder(bob.did());
    storage = EmulatedStorageManager.connectTo(server, { as: bob, id: holder });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      servingPosture: true,
      experimental: { serverExecution: true },
    });
    const engine = await server.engineForSpace(space);
    lease = new ExecutionLeaseCycle({ engine, space, holder });
    expect(lease.acquire()).toBe(true);
    demands = [];
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    for (const cancel of demands) cancel();
    await runtime.dispose();
    lease.release();
    await storage.close();
    await server.close();
  });

  /** Creates a reactive child whose input remains directly writable. */
  async function liveChild(scope: "space" | "user" = "space") {
    const program = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { computed, pattern } from "commonfabric";
export default pattern<{ value: number }, { doubled: number }>(
  ({ value }) => ({ doubled: computed(() => value * 2) }),
);
`,
      }],
    }, { space });
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "compiled-child",
      program.resultSchema,
      undefined,
      scope,
    );
    const tx = runtime.edit();
    runtime.run(tx, program, { value: 3 }, result);
    expect((await tx.commit()).error).toBeUndefined();
    demands.push(result.sink(() => {}));
    expect(await result.pull()).toEqual({ doubled: 6 });
    return result;
  }

  /** Updates the child's durable input and waits for its reactive work. */
  async function updateChild(result: Cell<unknown>, value: number) {
    const argument = result.getArgumentCell();
    expect(argument).toBeDefined();
    const tx = runtime.edit();
    argument!.withTx(tx).key("value").set(value);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
  }

  it("keeps a legacy instance reactive beside a pending versioned instance", async () => {
    const program = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
        import { computed, pattern } from "commonfabric";
        export default pattern<{ value: number }>(({ value }) => ({
          values: [0].map(() => computed(() => value * 2)),
        }));
      `,
      }],
    }, { space });
    const ref = runtime.patternManager.getArtifactEntryRef(program)!;
    const result = runtime.getCell<{ values: number[] }>(
      space,
      "mixed-generated-formats",
      program.resultSchema,
      undefined,
      "user",
    );
    const aliceTx = runtime.edit();
    stampWaveRunContext(aliceTx, {
      actionId: "alice-generated-format",
      kind: "bookkeeping",
      scopeKeyIdentity: { principal: alice.did(), sessionId: "alice-format" },
      attributionFromScope: true,
    });
    runtime.run(aliceTx, program, { value: 2 }, result.withTx(aliceTx));
    expect(result.withTx(aliceTx).getMetaRaw("generatedCellIdentity")).toEqual({
      version: 1,
      ...ref,
    });
    const bobTx = runtime.edit();
    result.withTx(bobTx).setMetaRaw(
      "patternIdentity",
      ref,
      rawMetaWriteAuthorization,
    );
    runtime.run(bobTx, program, { value: 3 }, result.withTx(bobTx));
    expect(result.withTx(bobTx).getMetaRaw("generatedCellIdentity")).toEqual({
      version: 0,
      ...ref,
    });
    expect((await bobTx.commit()).error).toBeUndefined();
    demands.push(result.sink(() => {}));
    expect(await result.pull()).toEqual({ values: [6] });
    expect(aliceTx.abort("Alice's versioned setup is refused").error)
      .toBeUndefined();
    await updateChild(result, 5);
    expect(result.get()).toEqual({ values: [10] });
  });

  it("keeps Bob's shared program reactive when Alice's first setup aborts", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const program = pattern<{ value: number }>(({ value }) => ({
      doubled: lift((input: number) => input * 2)(value),
    }));
    const result = runtime.getCell<{ doubled: number }>(
      space,
      "shared-first-setup",
      program.resultSchema,
      undefined,
      "user",
    );
    const aliceTx = runtime.edit();
    aliceTx.tx.scopeKeyIdentity = {
      principal: alice.did(),
      sessionId: "Alice's session",
    };
    runtime.run(aliceTx, program, { value: 2 }, result.withTx(aliceTx));
    expect(runtime.runner.cancels.size).toBe(1);

    const bobTx = runtime.edit();
    runtime.run(bobTx, program, { value: 3 }, result.withTx(bobTx));
    expect((await bobTx.commit()).error).toBeUndefined();
    demands.push(result.sink(() => {}));
    expect(await result.pull()).toEqual({ doubled: 6 });

    expect(aliceTx.abort("Alice's setup is refused").error).toBeUndefined();
    await runtime.idle();
    expect(runtime.runner.cancels.size).toBe(1);
    await updateChild(result, 5);
    expect(result.get()).toEqual({ doubled: 10 });
  });

  it("keeps a space-scoped child reactive when its clear transaction aborts", async () => {
    const result = await liveChild();
    const tx = runtime.edit();
    runtime.runner.clearInTransaction(tx, result);
    expect(result.withTx(tx).get()).toBeUndefined();
    expect(tx.abort("The clear is refused").error).toBeUndefined();

    await updateChild(result, 5);
    expect(result.get()).toEqual({ doubled: 10 });
    expect(runtime.runner.cancels.size).toBe(1);
  });

  it("keeps a scoped child reactive until its last parent group releases it", async () => {
    const result = await liveChild("user");
    const releaseAlice = runtime.runner.retainChild(result);
    const releaseBob = runtime.runner.retainChild(result);
    releaseAlice();
    releaseAlice();

    await updateChild(result, 5);
    expect(result.get()).toEqual({ doubled: 10 });
    expect(runtime.runner.cancels.size).toBe(1);

    releaseBob();
    expect(runtime.runner.cancels.size).toBe(0);
    await updateChild(result, 7);
    expect(result.get()).toEqual({ doubled: 10 });
    expect(runtime.runner.cancels.size).toBe(0);
  });

  it("keeps a space-scoped child reactive when its clear wave is withdrawn", async () => {
    const result = await liveChild();
    const wave = new WaveAccumulator({
      space,
      basisSeq: 0,
      scopeKeyIdentity: runtime.scopeKeyIdentity,
      replicaFor: (space) => storage.open(space).replica,
    });
    try {
      runtime.installSealDestination(wave);
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "clear-space-child",
        kind: "bookkeeping",
      });
      runtime.runner.clearInTransaction(new TransactionWrapper(tx), result);
      expect((await tx.commit()).error).toBeUndefined();
      const settlement = waveSettlementOf(tx);
      expect(settlement).toBeDefined();
      expect(runtime.runner.cancels.size).toBe(1);

      runtime.clearSealDestination();
      wave.abandon("The clear wave is withdrawn");
      expect((await settlement)?.error).toBeDefined();
    } finally {
      runtime.clearSealDestination();
      wave.abandon("The withdrawal test is complete");
      await wave.settled();
    }
    await updateChild(result, 5);
    expect(result.get()).toEqual({ doubled: 10 });
    expect(runtime.runner.cancels.size).toBe(1);
  });

  it("stops a space-scoped child's graph after its clear commits", async () => {
    const result = await liveChild();
    const argument = result.getArgumentCell()!;
    const tx = runtime.edit();
    runtime.runner.clearInTransaction(tx, result);
    expect((await tx.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(result.get()).toBeUndefined();
    expect(runtime.runner.cancels.size).toBe(0);

    const update = runtime.edit();
    argument.withTx(update).key("value").set(5);
    expect((await update.commit()).error).toBeUndefined();
    await runtime.idle();
    expect(result.get()).toBeUndefined();
    expect(runtime.runner.cancels.size).toBe(0);
  });
});
