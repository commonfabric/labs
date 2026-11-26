/**
 * Exercises what a client that runs a piece itself under server execution
 * shows once the serving runtime's answer to a model call arrives later than
 * the client's own runs of the piece: the served value a computed derives
 * from that answer, the same one a fresh client loads (top/3639).
 */

import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";

import { defer } from "@commonfabric/async/defer";
import { Identity } from "@commonfabric/identity";
import {
  addMockObjectResponse,
  enableMockMode,
  resetMockMode,
  setMockResponseGate,
} from "@commonfabric/llm";
import * as Engine from "@commonfabric/memory/v2/engine";
import { withStuckNet } from "@commonfabric/test-support/stuck-net";

import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { awaitReplica, settleServing } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("late answer space");
const service = await Identity.fromPassphrase("late answer service");
const alice = await Identity.fromPassphrase("late answer alice");
const space = spaceSigner.did() as MemorySpace;

const ROW = { title: "the served suggestion" };

type Outcome = {
  /** What the client running the piece shows for the derived key. */
  running: unknown;

  /** What a fresh client loads for the same key. */
  fresh: unknown;

  /** The running client's speculations still standing in the space, once
   * none is left or, when `awaitRetirement` is off, as the answer lands. */
  standing: number;
};

/**
 * Runs the piece on a client, has the serving runtime answer the model call
 * only after the client's runs have settled, and waits for the store and the
 * client's replica to hold the value the served computed derived from it.
 * With `awaitRetirement`, also waits for the client's speculations to retire,
 * which they never do while one of them waits for a document the served run
 * does not write.
 */
async function runLateAnswer(
  { awaitRetirement }: { awaitRetirement: boolean },
): Promise<Outcome> {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const managers = new Map<Runtime, EmulatedStorageManager>();
  let host: ExecutorHost | undefined;
  let cancel: (() => void) | undefined;
  const answer = defer<void>();
  const openClient = () => {
    const manager = EmulatedStorageManager.connectTo(server, { as: alice });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    managers.set(runtime, manager);
    return runtime;
  };
  enableMockMode();
  addMockObjectResponse(() => true, { object: ROW, id: "late-answer" });
  setMockResponseGate(() => answer.promise);
  try {
    host = new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      // The execution host owns an asynchronous factory contract.
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

    const client = openClient();
    const engine = await server.engineForSpace(space);
    const pattern = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { computed, generateObject, pattern } from "commonfabric";
export default pattern<{ topic: string }, { "[SUGGESTIONS]": any }>(
  ({ topic }) => {
    const read = generateObject<{ title: string }>({
      prompt: topic,
      schema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    });
    return {
      "[SUGGESTIONS]": computed(() => read.result ? [read.result] : []),
    };
  },
);
`,
      }],
    }, { space });
    const argument = client.getCell<{ topic: string }>(
      space,
      "late-answer-input",
      pattern.argumentSchema,
    );
    const result = client.getCell<{ "[SUGGESTIONS]": unknown }>(
      space,
      "late-answer-result",
      pattern.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const start = client.edit();
    argument.withTx(start).key("topic").set("late answer prompt");
    client.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    const suggestions = result.key("[SUGGESTIONS]");
    cancel = suggestions.sink(() => {});
    await settleServing(engine, client, space);
    await client.idle();

    // The serving runtime's call answers only now, after the client has run
    // the piece and its runs have settled.
    answer.resolve();

    // The key holds a link to the computed's own output document, which is
    // where the served value lands.
    const link = suggestions.resolveAsCell().getAsNormalizedFullLink();
    const replica = client.storageManager.open(space).replica;
    await awaitReplica(client.storageManager, () => {
      let stored: unknown = Engine.read(engine, {
        id: link.id as never,
        scope: "space",
      })?.value;
      for (const key of link.path) {
        stored = (stored as Record<string, unknown> | undefined)?.[key];
      }
      const head = Engine.selectDocHead(engine, {
        id: link.id as never,
        scopeKey: "space",
      });
      const confirmed =
        replica.speculationRetirementView?.(link.id, "space").confirmedSeq ??
          0;
      return Array.isArray(stored) && stored.length === 1 &&
        confirmed >= head;
    });
    await client.idle();
    if (awaitRetirement) {
      // Sleeps on the entries' own settlement: an entry that waits for a
      // document the served run never writes keeps it asleep until the net
      // fails the wait.
      await withStuckNet(
        client.speculationOverlay!.waitForSpaceQuiescence(space),
        "the running client's speculations retiring",
      );
    }

    const fresh = openClient().getCellFromLink(
      suggestions.getAsNormalizedFullLink(),
    );
    await fresh.sync();
    await fresh.resolveAsCell().sync();
    return {
      running: suggestions.get(),
      fresh: fresh.get(),
      standing: client.speculationOverlay?.entryCount(space) ?? 0,
    };
  } finally {
    cancel?.();
    answer.resolve();
    resetMockMode();
    await host?.close();
    for (const runtime of managers.keys()) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers.values()) await manager.close();
    await server.close();
  }
}

describe("served-late-answer-watching-client", () => {
  it("shows a client running the piece the value derived from a late served answer", async () => {
    const { running, fresh } = await runLateAnswer({
      awaitRetirement: false,
    });

    expect(fresh).toEqual([ROW]);
    expect(running).toEqual([ROW]);
  });

  it("retires every one of the running client's speculations once the late answer is served", async () => {
    const { fresh, standing } = await runLateAnswer({ awaitRetirement: true });

    expect(fresh).toEqual([ROW]);
    expect(standing).toBe(0);
  });
});
