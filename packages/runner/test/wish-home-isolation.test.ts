import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";

import { wish } from "../src/builtins/wish.ts";
import type { Cell } from "../src/cell.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";

const service = await Identity.fromPassphrase("home wish service");
const users = await Promise.all(
  ["home wish Alice", "home wish Bob"].map((name) =>
    Identity.fromPassphrase(name)
  ),
);

describe("wish-home-isolation", () => {
  it("resolves each stamped user's favorites through the same headless wish", async () => {
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const holder = executionLeaseHolder(service.did());
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: service,
      id: holder,
    });
    const lease = new ExecutionLeaseCycle({
      engine: await server.engineForSpace(service.did()),
      space: service.did(),
      holder,
    });
    expect(lease.acquire()).toBe(true);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const cancels: (() => void)[] = [];
    try {
      for (const user of users) {
        const tx = runtime.edit();
        const provider = runtime.getCell(
          user.did(),
          "resource provider",
          undefined,
          tx,
        );
        provider.set({ name: user.did() });
        const home = runtime.getCell(user.did(), user.did(), undefined, tx);
        home.set({
          defaultPattern: {
            favorites: [{ cell: provider, tags: ["loom_resources_v1"] }],
          },
        });
        expect((await tx.commit()).error).toBeUndefined();
      }
      const setup = runtime.edit();
      const parent = runtime.getCell(
        service.did(),
        "shared consumer",
        undefined,
        setup,
      );
      parent.set({});
      const inputs = runtime.getCell(
        service.did(),
        "wish arguments",
        undefined,
        setup,
      );
      inputs.set({
        query: "#loom_resources_v1",
        scope: ["~"],
        headless: true,
        schema: {
          $ref: "#/$defs/Resources",
          scope: "user",
          asCell: ["cell"],
          $defs: {
            Resources: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
      });
      expect((await setup.commit()).error).toBeUndefined();
      const observed: unknown[] = [];
      const action = wish(
        inputs as Cell<[unknown, unknown]>,
        (tx, value) => {
          const state = (value as Cell<{ result: Cell<{ name: string }> }>)
            .withTx(tx).get();
          observed.push(state.result.withTx(tx).get());
        },
        (cancel) => cancels.push(cancel),
        [parent],
        parent,
        runtime,
      );
      for (const user of [users[0], users[1], users[0]]) {
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: "home wish",
          kind: "derivation",
          attributionFromScope: true,
          scopeKeyIdentity: { principal: user.did(), sessionId: user.did() },
        });
        action.action(tx);
        expect((await tx.commit()).error).toBeUndefined();
      }
      expect(observed.map((state) => (state as { name: string }).name))
        .toEqual([users[0].did(), users[1].did(), users[0].did()]);
    } finally {
      cancels.forEach((cancel) => cancel());
      await runtime.dispose({ closeStorage: false });
      lease.release();
      await storageManager.close();
      await server.close();
    }
  });
});
