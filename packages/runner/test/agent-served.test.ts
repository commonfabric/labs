/**
 * The `agent` builtin on a serving runtime: a request a served piece makes is
 * queued in the requester's home-space index, whether that home space is the
 * space being served or another one. A wave that drops the index write has it
 * issued again once, and the request ends `refused` if the wave drops it again.
 * A request whose index write was lost with its space's tenure is indexed when
 * the space is served again.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import { agentQueueIndexCell } from "../src/builtins/agent.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { servingRuntimeFactory } from "../src/executor/serving-runtime.ts";
import { WaveAccumulator, waveRunContextOf } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { seedHomeAgentQueue } from "./support/agent-queue.ts";

const service = await Identity.fromPassphrase("agent served service");
const alice = await Identity.fromPassphrase("agent served alice");
const shared = await Identity.fromPassphrase("agent served shared space");

const AGENT_PATTERN = [
  "import { agent, pattern } from 'commonfabric';",
  "export default pattern<{ task: string }>(({ task }) =>",
  "  agent({",
  "    task,",
  "    inputs: {},",
  "    resultSchema: {",
  "      type: 'object',",
  "      properties: { answer: { type: 'string' } },",
  "      required: ['answer'],",
  "    },",
  "  })",
  ");",
].join("\n");

type AgentResult = {
  pending?: boolean;
  error?: string;
  run?: { state?: string };
};

describe("agent-served", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let client: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    host = new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      createRuntime: servingRuntimeFactory({
        server,
        identity: service,
        apiUrl: new URL("https://fabric.example/"),
      }),
      policy: { idleParkMs: 600_000 },
    });
    client = new Runtime({
      apiUrl: new URL("https://fabric.example/"),
      storageManager: EmulatedStorageManager.connectTo(server, { as: alice }),
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await host.close();
    await client.dispose();
    await server.close();
  });

  /**
   * Seeds alice's home agent queue, runs a pattern calling `agent()` in
   * `space` as alice, and returns the request's result cell and alice's
   * home-space queue once the queue lists an entry from this host or the
   * request has ended.
   */
  const request = async (space: MemorySpace) => {
    const home = alice.did() as MemorySpace;
    const seed = client.edit();
    seedHomeAgentQueue(client, home, seed);
    expect((await seed.commit()).error).toBeUndefined();

    const compiled = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: AGENT_PATTERN }],
    }, { space });
    const argument = client.getCell<{ task: string }>(space, "agent-argument");
    const result = client.getCell<AgentResult>(
      space,
      "agent-result",
      compiled.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const tx = client.edit();
    argument.withTx(tx).set({ task: "summarize the reading list" });
    client.run(tx, compiled, argument, result);
    expect((await tx.commit()).error).toBeUndefined();
    const cancelDemand = result.sink(() => {});

    const queue = agentQueueIndexCell(client, home);
    await queue.sync();
    await withStuckNet(
      Promise.race([
        waitForCellValue<{ host: string }[]>(
          client,
          queue.key("entries"),
          (entries) =>
            (entries ?? []).some((entry) =>
              entry.host === "https://fabric.example"
            ),
        ),
        waitForCellValue<AgentResult>(
          client,
          result,
          (value) => value?.error !== undefined,
        ),
      ]),
      "the agent request's queue entry or its refusal",
    );
    cancelDemand();
    return { result, queue };
  };

  it("indexes a request in the requester's home queue when that home space is not the served space", async () => {
    const { result, queue } = await request(shared.did() as MemorySpace);

    expect(result.get()?.error).toBeUndefined();
    expect(result.get()?.run?.state).toBe("queued");
    expect(queue.get()?.entries?.length).toBe(1);
  });

  it("indexes a request in the requester's home queue when that home space is the served space", async () => {
    const { result, queue } = await request(alice.did() as MemorySpace);

    expect(result.get()?.error).toBeUndefined();
    expect(result.get()?.run?.state).toBe("queued");
    expect(queue.get()?.entries?.length).toBe(1);
  });

  it("indexes a request whose index write was abandoned with the space's tenure once the space is served again", async () => {
    const home = alice.did() as MemorySpace;
    const realSeal = WaveAccumulator.prototype.seal;
    const parks: Promise<void>[] = [];
    using _sealStub = stub(
      WaveAccumulator.prototype,
      "seal",
      async function (this: WaveAccumulator, tx) {
        const sealed = await realSeal.call(this, tx);
        // The first index write parks the space while it sits in the open
        // wave, which abandons the wave and ends that tenure.
        if (
          parks.length === 0 &&
          waveRunContextOf(tx)?.actionId.startsWith("agent/index/") === true
        ) {
          parks.push(host.spaceServer(home)!.park("test-tenure-ends"));
        }
        return sealed;
      },
    );

    const { result, queue } = await request(home);
    await Promise.all(parks);

    expect(parks.length).toBe(1);
    expect(result.get()?.error).toBeUndefined();
    expect(result.get()?.run?.state).toBe("queued");
    expect(queue.get()?.entries?.map((entry) => entry.host)).toEqual([
      "https://fabric.example",
    ]);
  });

  describe("when the wave drops the index write", () => {
    /**
     * Has another writer replace the queue's entries each time one of the
     * first `times` index writes seals into the open wave, before that wave
     * commits. The index write cannot be merged with that, so the wave drops
     * it. Returns how many writes were raced so far.
     */
    const raceIndexWrites = (times: number) => {
      const home = alice.did() as MemorySpace;
      const realSeal = WaveAccumulator.prototype.seal;
      const raced = { count: 0 };
      const sealStub = stub(
        WaveAccumulator.prototype,
        "seal",
        async function (this: WaveAccumulator, tx) {
          const sealed = await realSeal.call(this, tx);
          if (
            raced.count < times &&
            waveRunContextOf(tx)?.actionId.startsWith("agent/index/") === true
          ) {
            raced.count += 1;
            const race = client.edit();
            agentQueueIndexCell(client, home).key("entries").withTx(race).set([
              {
                run: client.getCell(home, `another run ${raced.count}`),
                host: `other${raced.count}.example`,
              },
            ]);
            expect((await race.commit()).error).toBeUndefined();
          }
          return sealed;
        },
      );
      return { raced, [Symbol.dispose]: () => sealStub.restore() };
    };

    it("issues the write again and indexes the request after one drop", async () => {
      using race = raceIndexWrites(1);

      const { result, queue } = await request(alice.did() as MemorySpace);

      expect(race.raced.count).toBe(1);
      expect(result.get()?.error).toBeUndefined();
      expect(result.get()?.run?.state).toBe("queued");
      expect(queue.get()?.entries?.map((entry) => entry.host)).toEqual([
        "other1.example",
        "https://fabric.example",
      ]);
    });

    it("ends the record as `refused` after a second drop", async () => {
      using race = raceIndexWrites(2);

      const { result, queue } = await request(alice.did() as MemorySpace);

      expect(race.raced.count).toBe(2);
      expect(result.get()?.error).toBe("REFUSED");
      expect(result.get()?.run?.state).toBe("refused");
      expect(queue.get()?.entries?.map((entry) => entry.host)).toEqual([
        "other2.example",
      ]);
    });
  });
});
