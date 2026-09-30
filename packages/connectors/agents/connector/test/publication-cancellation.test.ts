import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { AgentFabricTarget } from "../src/fabric.ts";
import { readStableCellGraphValue } from "../src/fabric-graph.ts";
import type { CollectedSource } from "../src/reconcile.ts";

describe("AgentFabricTarget", () => {
  describe("publish()", () => {
    for (const abortBeforeCommit of [true, false]) {
      it(
        abortBeforeCommit
          ? "cancels before its first graph commit and releases graph storage"
          : "finishes its publication when canceled after the first commit starts",
        async () => {
          const signer = await Identity.fromPassphrase(
            "agent publication cancellation test",
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
          const controller = new AbortController();
          const reason = new Error("publication canceled");
          let releases = 0;
          let commitsStarted = 0;
          try {
            const target = await AgentFabricTarget.open(
              connection,
              undefined,
              () => {
                if (abortBeforeCommit) controller.abort(reason);
                return Promise.resolve({
                  connection,
                  release: () => {
                    releases++;
                    return Promise.resolve();
                  },
                });
              },
            );
            const previousIndex = await readStableCellGraphValue(
              connection,
              target.cells.allIndex,
            );
            const collected: CollectedSource = {
              source: {
                id: "sample",
                driver: "acp",
                capabilities: {
                  inventory: true,
                  read: true,
                  prompt: false,
                  cancel: false,
                  rename: false,
                  setMode: false,
                  setConfigOption: false,
                },
              },
              sessions: [{
                summary: {
                  nativeSessionId: "one",
                  title: "One",
                  cwd: null,
                  createdAt: null,
                  updatedAt: null,
                  archived: false,
                  active: false,
                  raw: {},
                },
                events: [{ type: "message", text: "hello" }],
                normalizedMessages: [],
                complete: true,
              }],
              errors: [],
              complete: true,
            };
            const publication = target.publish([collected], {
              signal: controller.signal,
              onCommit: () => {
                commitsStarted++;
                if (!abortBeforeCommit) controller.abort(reason);
              },
            });

            if (abortBeforeCommit) {
              await expect(publication).rejects.toBe(reason);
              expect(commitsStarted).toBe(0);
              expect(
                await readStableCellGraphValue(
                  connection,
                  target.cells.allIndex,
                ),
              ).toEqual(previousIndex);
            } else {
              await expect(publication).resolves.toBe(1);
              expect(commitsStarted).toBe(1);
              expect((await target.publishedSessions()).size).toBe(1);
            }
            expect(controller.signal.aborted).toBe(true);
            expect(releases).toBe(1);
          } finally {
            await runtime.dispose();
          }
        },
      );
    }
  });
});
