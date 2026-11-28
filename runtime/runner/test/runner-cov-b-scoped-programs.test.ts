/**
 * Nodes of a user-scoped piece on a serving runtime with server execution,
 * where one graph serves every instance: a passthrough node's binding for a
 * second instance, and a lift whose result is a pattern instance.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import {
  createTrustedBuilder,
  trustExecutable,
} from "./support/trusted-builder.ts";

const alice = await Identity.fromPassphrase("runner-cov-b scoped Alice");
const bob = await Identity.fromPassphrase("runner-cov-b scoped Bob");
const space = bob.did();

describe("runner scoped programs", () => {
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
    lease = new ExecutionLeaseCycle({
      leases: engine.executionLeases,
      space,
      holder,
    });
    expect(await lease.acquire()).toBe(true);
    demands = [];
  });

  afterEach(async () => {
    runtime.clearSealDestination();
    for (const cancel of demands) cancel();
    await runtime.dispose();
    await lease.release();
    await storage.close();
    await server.close();
  });

  it("binds a passthrough node for an instance that joins an installed graph", async () => {
    const program = trustExecutable(runtime, {
      argumentSchema: {
        type: "object",
        properties: { value: { type: "number" } },
      },
      resultSchema: {},
      result: { copied: { $alias: { partialCause: "out", path: [] } } },
      nodes: [{
        module: { type: "passthrough" },
        inputs: { $alias: { cell: "argument", path: ["value"] } },
        outputs: { $alias: { partialCause: "out", path: [] } },
      }],
    } as Pattern);
    const result = runtime.getCell<{ copied: number }>(
      space,
      "scoped passthrough",
      undefined,
      undefined,
      "user",
    );
    const aliceTx = runtime.edit();
    aliceTx.tx.scopeKeyIdentity = {
      principal: alice.did(),
      sessionId: "Alice's session",
    };
    runtime.run(aliceTx, program, { value: 2 }, result.withTx(aliceTx));
    expect((await aliceTx.commit().settled).error).toBeUndefined();
    expect(runtime.runner.cancels.size).toBe(1);

    const bobTx = runtime.edit();
    runtime.run(bobTx, program, { value: 3 }, result.withTx(bobTx));
    expect((await bobTx.commit().settled).error).toBeUndefined();
    demands.push(result.sink(() => {}));
    await runtime.idle();

    expect(runtime.runner.cancels.size).toBe(1);
    expect(await result.pull()).toEqual({ copied: 3 });
  });

  it("retains the scoped piece a lift's pattern-valued result runs", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const inner = pattern<{ v: number }>(({ v }) => ({
      tripled: lift((input: number) => input * 3)(v),
    }));
    const program = pattern<{ value: number }>(({ value }) => ({
      inner: lift((v: number) => inner({ v }))(value),
    }));
    const result = runtime.getCell<{ inner: { tripled: number } }>(
      space,
      "scoped lift result",
      program.resultSchema,
      undefined,
      "user",
    );
    const tx = runtime.edit();
    runtime.run(tx, program, { value: 2 }, result);
    expect((await tx.commit().settled).error).toBeUndefined();
    demands.push(result.sink(() => {}));
    await runtime.idle();

    expect(await result.pull()).toEqual({ inner: { tripled: 6 } });

    const update = runtime.edit();
    result.getArgumentCell<{ value: number }>()!.withTx(update).key("value")
      .set(5);
    expect((await update.commit().settled).error).toBeUndefined();
    await runtime.idle();
    expect(await result.pull()).toEqual({ inner: { tripled: 15 } });
  });
});
