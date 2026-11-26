import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { SERVER_EXECUTION_EFFECTS_DOC_ID } from "@commonfabric/memory/v2";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { clock } from "@commonfabric/test-support/fake-clock";

import { Runtime } from "../src/runtime.ts";
import type { EffectsChannel } from "../src/speculation/effects-channel.ts";
import { getTransactionWriteAttempts } from "../src/storage/transaction-inspection.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("effects channel ack cov");
const space = signer.did();

describe("EffectsChannel", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
  });

  afterEach(async () => {
    await runtime.dispose({ closeStorage: false });
    await manager.close();
    await server.close();
  });

  /** This session's instance of the effects document, at `path`. */
  function effectsCell(path: string[]) {
    return runtime.getCellFromLink<unknown>({
      space,
      id: SERVER_EXECUTION_EFFECTS_DOC_ID as never,
      scope: "session",
      path,
    });
  }

  /**
   * Commits `value` at `path` of this session's effects instance, as it
   * stands: an object in it stays in the document rather than becoming one
   * of its own, as the server writes an intent.
   */
  async function write(path: string[], value: FabricValue): Promise<void> {
    const tx = runtime.edit();
    effectsCell(path).withTx(tx).setRaw(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    await clock.settle();
  }

  describe("instance members", () => {
    describe("enactOnce()", () => {
      it("acks an intent delivered twice during its enactment once, after the enactment succeeds", async () => {
        const channel: EffectsChannel = runtime.effectsChannel!;
        channel.ensureSubscribed(space);
        await clock.settle();

        // Every transaction committed from the moment the enactment
        // succeeds, and which of them write an ack.
        const committed: { acks: boolean }[] = [];
        let counting = false;
        const edit = runtime.edit.bind(runtime);
        using _edits = stub(runtime, "edit", (...args) => {
          const tx = edit(...args);
          const commit = tx.commit.bind(tx);
          tx.commit = (...commitArgs) => {
            if (counting) {
              committed.push({
                acks: (getTransactionWriteAttempts(tx) ?? []).some((
                  attempt,
                ) =>
                  attempt.id === SERVER_EXECUTION_EFFECTS_DOC_ID &&
                  attempt.path.includes("acks")
                ),
              });
            }
            return commit(...commitArgs);
          };
          return tx;
        });

        const enactment = Promise.withResolvers<void>();
        const enacted = channel.enactOnce("n1", () => enactment.promise);

        // Two deliveries of the unacked intent while it is still enacting.
        await write(["entries"], [{ nonce: "n1", kind: "navigate" }]);
        await write(["poke"], 1);
        expect(effectsCell(["acks"]).get()).toBeUndefined();

        counting = true;
        enactment.resolve();
        expect(await enacted).toBe(true);
        await runtime.idle();
        await manager.synced();

        expect(committed).toEqual([{ acks: true }]);
        expect(effectsCell(["acks"]).get()).toEqual({ n1: true });
      });
    });
  });
});
