import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  getServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import { ensurePieceRunningVerdict } from "../src/ensure-piece-running.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("owning-result scope identity");
const space = owner.did();
const id = "of:scoped-owning-result";

async function settle<T>(work: Promise<T>): Promise<T> {
  await clock.settle();
  return await work;
}

describe("ensurePieceRunningVerdict()", () => {
  for (const enabled of [false, true]) {
    describe(enabled ? "serving runtime" : "client runtime", () => {
      let prior: boolean;
      let server: ReturnType<typeof newSharedServer>;
      let manager: ReturnType<typeof EmulatedStorageManager.connectTo>;
      let runtime: Runtime;

      beforeEach(() => {
        prior = getServerExecutionConfig();
        setServerExecutionConfig(enabled);
        server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
        manager = EmulatedStorageManager.connectTo(server, { as: owner });
        runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          experimental: { serverExecution: enabled },
          servingPosture: enabled,
        });
      });

      afterEach(async () => {
        try {
          await settle(runtime.dispose());
          await settle(manager.close());
          await settle(server.close());
        } finally {
          setServerExecutionConfig(prior);
        }
      });

      async function writeBacklink(scope: "space" | "user") {
        const engine = await server.engineForSpace(space);
        const result = runtime.getCellFromLink({ space, id, scope, path: [] });
        const commit = Engine.applyCommit(engine, {
          space,
          principal: owner.did(),
          sessionId: "scoped-owning-result-fixture",
          commitClass: "system",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id, scope: "space", value: { value: {} } },
              {
                op: "set",
                id,
                scope: "user",
                value: { value: {}, result: result.getAsWriteRedirectLink() },
              },
            ],
          },
        });
        expect(commit.revisions).toHaveLength(2);
      }

      it("follows a backlink to the same ID in another scope", async () => {
        await writeBacklink("space");
        const verdict = await settle(ensurePieceRunningVerdict(runtime, {
          space,
          id,
          scope: "user",
          path: [],
        }, { propagateErrors: true }));

        expect(verdict).toEqual({
          started: false,
          reason: "no-pattern-meta",
          rootId: id,
          observedDocIds: [id],
        });
        expect(server.demandSetSizesForSpace(space).perSession)
          .toMatchObject([{ tracked: 2, watches: 2 }]);
      });

      it("rejects a backlink to the same ID and scope as a cycle", async () => {
        await writeBacklink("user");
        const verdict = await settle(ensurePieceRunningVerdict(runtime, {
          space,
          id,
          scope: "user",
          path: [],
        }, { propagateErrors: true }));

        expect(verdict).toEqual({
          started: false,
          reason: "chain-cycle",
          observedDocIds: [id],
        });
        expect(server.demandSetSizesForSpace(space).perSession)
          .toMatchObject([{ tracked: 1, watches: 1 }]);
      });
    });
  }
});
