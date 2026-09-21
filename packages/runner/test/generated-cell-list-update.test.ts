import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

describe("generated-cell-list-update", () => {
  for (const lazyMaterialization of [true, false]) {
    it(`isolates generated list-child state and resumes it with \`lazyMaterialization=${lazyMaterialization}\``, async () => {
      const signer = await Identity.fromPassphrase(
        "generated-cell-list-update",
      );
      const space = signer.did();
      const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
        experimental: { lazyMaterialization },
      });
      let reader: Runtime | undefined;
      const cancels: Array<() => void> = [];
      try {
        const source = (label: string) => `
        import { pattern, Writable } from "commonfabric";
        export default pattern<{ items: { id: string }[] }>(({ items }) => ({
          rows: items.map((item) => ({
            purpose: "${label}",
            id: item.id,
            slots: [0].map(() => new Writable("${label}-default")),
            named: new Writable("named-default").for("named"),
          })),
        }));
      `;
        const compile = (label: string) =>
          runtime.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: source(label) }],
          }, { space });
        const v1 = await compile("shipping");
        const v2 = await compile("billing");
        const piece = runtime.getCell(space, "generated-list");
        const schema = {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  purpose: { type: "string" },
                  id: { type: "string" },
                  slots: { type: "array", items: { type: "string" } },
                  named: { type: "string" },
                },
              },
            },
          },
        } as const;
        const view = piece.asSchema<
          {
            rows: {
              purpose: string;
              id: string;
              slots: string[];
              named: string;
            }[];
          }
        >(schema);
        await runtime.setup(undefined, v1, { items: [{ id: "a" }] }, piece);
        expect(await runtime.start(piece)).toBe(true);
        cancels.push(view.sink(() => {}));
        await view.pull();
        await runtime.settled();
        expect(view.get().rows[0].slots).toEqual(["shipping-default"]);
        const oldSlot = view.key("rows").key(0).key("slots").key(0)
          .resolveAsCell();
        const named = view.key("rows").key(0).key("named").resolveAsCell();
        expect(
          (await runtime.editWithRetry((tx) => {
            oldSlot.withTx(tx).set("shipping-user");
            named.withTx(tx).set("named-user");
          })).error,
        ).toBeUndefined();
        await runtime.setup(undefined, v2, undefined, piece);
        await runtime.idle();
        await runtime.runner.idlePointerMaintenance();
        await runtime.settled();
        expect(view.get()).toEqual({
          rows: [{
            purpose: "billing",
            id: "a",
            slots: ["billing-default"],
            named: "named-user",
          }],
        });
        const newSlot = view.key("rows").key(0).key("slots").key(0)
          .resolveAsCell();
        expect(newSlot.getAsNormalizedFullLink().id).not.toBe(
          oldSlot.getAsNormalizedFullLink().id,
        );
        expect(oldSlot.get()).toBe("shipping-user");
        expect(
          (await runtime.editWithRetry((tx) =>
            newSlot.withTx(tx).set("billing-user")
          )).error,
        ).toBeUndefined();
        await runtime.patternManager.flushCompileCacheWrites();
        await runtime.storageManager.synced();
        reader = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
          experimental: { lazyMaterialization },
        });
        const reopened = reader.getCellFromLink(
          piece.getAsNormalizedFullLink(),
        );
        await reopened.sync();
        expect(await reader.start(reopened)).toBe(true);
        const reopenedView = reopened.asSchema<
          typeof view extends { get(): infer V } ? V : never
        >(schema);
        cancels.push(reopenedView.sink(() => {}));
        await reopenedView.pull();
        await reader.settled();
        expect(reopenedView.get()).toEqual({
          rows: [{
            purpose: "billing",
            id: "a",
            slots: ["billing-user"],
            named: "named-user",
          }],
        });
      } finally {
        for (const cancel of cancels) cancel();
        await reader?.dispose();
        await runtime.dispose();
        await server.close();
      }
    });
  }
});
