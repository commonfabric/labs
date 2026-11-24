import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { AgentFabricTarget } from "../src/fabric.ts";
import { readStableCellGraphValue } from "../src/fabric-graph.ts";
import type {
  SourceCollectionOutcome,
  StreamingCollectedSource,
} from "../src/reconcile.ts";
import type { NativeSessionSnapshot } from "../src/types.ts";

/** Supplies a complete transcript with no checkout to observe. */
function snapshot(nativeSessionId: string): NativeSessionSnapshot {
  return {
    summary: {
      nativeSessionId,
      title: nativeSessionId,
      cwd: null,
      createdAt: null,
      updatedAt: null,
      archived: false,
      active: false,
      raw: {},
    },
    events: [],
    normalizedMessages: [],
    complete: true,
  };
}

describe("AgentFabricTarget", () => {
  describe("publish()", () => {
    for (const initiallySupported of [true, false]) {
      it(
        `updates earlier rows when streaming ${
          initiallySupported ? "removes" : "discovers"
        } a capability`,
        async () => {
          const signer = await Identity.fromPassphrase(
            "agent streaming capabilities test",
          );
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: StorageManager.emulate({ as: signer }),
          });
          const connection = {
            runtime,
            spaceDid: signer.did(),
            ownerDid: signer.did(),
          };
          try {
            const target = await AgentFabricTarget.open(connection);
            const capabilities = {
              inventory: true,
              read: true,
              prompt: false,
              cancel: false,
              rename: false,
              setMode: initiallySupported,
              setConfigOption: false,
              modes: initiallySupported ? ["plan"] : [],
            };
            const outcome: SourceCollectionOutcome = {
              consumed: false,
              complete: false,
              sessionCount: 0,
              errors: [],
            };
            const collected: StreamingCollectedSource = {
              source: { id: "sample", driver: "acp", capabilities },
              sessions: (async function* () {
                outcome.consumed = true;
                outcome.sessionCount++;
                yield snapshot("one");
                capabilities.setMode = !initiallySupported;
                capabilities.modes = initiallySupported ? [] : ["plan"];
                outcome.sessionCount++;
                yield snapshot("two");
                outcome.complete = true;
              })(),
              retained: [],
              outcome,
            };

            expect(await target.publish([collected])).toBe(2);
            expect(
              await readStableCellGraphValue(
                connection,
                target.cells.allIndex,
              ),
            ).toMatchObject({
              sources: [{ capabilities }],
              sessions: [
                { nativeSessionId: "one", capabilities },
                { nativeSessionId: "two", capabilities },
              ],
            });
          } finally {
            await runtime.dispose();
          }
        },
      );
    }
  });
});
