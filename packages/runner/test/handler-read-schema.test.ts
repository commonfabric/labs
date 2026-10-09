import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { getLogger } from "@commonfabric/utils/logger";

import { Runtime } from "../src/runtime.ts";
import { type EventHandler, txToReactivityLog } from "../src/scheduler.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("handler-read-schema", () => {
  for (const handle of [false, true]) {
    it(`loads only the declared field through a ${handle ? "cell" : "value"} argument`, async () => {
      const signer = await Identity.fromPassphrase("handler read schema");
      const storage = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      const traversal = getLogger("traverse");
      const warnings = traversal.countsByKey.traverse?.warn ?? 0;
      try {
        const setup = runtime.edit();
        const title = runtime.getCell<string>(signer.did(), "title", {
          type: "string",
        }, setup);
        const extra = runtime.getCell<string>(signer.did(), "extra", {
          type: "string",
        }, setup);
        title.set("Maple");
        extra.set("Unrequested detail");
        const source = runtime.getCell<{ title: string; extra: string }>(
          signer.did(),
          "source",
          {
            type: "object",
            properties: {
              title: { type: "string" },
              extra: { type: "string" },
            },
            required: ["title", "extra"],
          },
          setup,
        );
        source.set({ title, extra });
        expect((await setup.commit().settled).error).toBeUndefined();
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{
            name: "/main.tsx",
            contents: `/// <cts-enable />
            import { Cell, handler, pattern, Writable } from "commonfabric";
            interface Summary { title: string; }
            const capture = handler<unknown, {
              source: ${handle ? "Cell<Summary>" : "Summary"};
              selected: Writable<string>;
            }>((_event, { source, selected }) => {
              selected.set(${handle ? "source.get().title" : "source.title"});
            });
            export default pattern<{ source: Cell<Summary> }>(
              ({ source }) => {
                const selected = new Writable("");
                return { selected, capture: capture({ source, selected }) };
              },
            );
          `,
          }],
        }, { space: signer.did() });
        const callbacks: NonNullable<
          Parameters<typeof runtime.scheduler.addEventHandler>[2]
        >[] = [];
        const handlers: EventHandler[] = [];
        const register = runtime.scheduler.addEventHandler.bind(
          runtime.scheduler,
        );
        using _registration = stub(
          runtime.scheduler,
          "addEventHandler",
          (...args) => {
            if (args[2]) callbacks.push(args[2]);
            handlers.push(args[0]);
            return register(...args);
          },
        );
        const result = await runtime.runSynced(
          runtime.getCell(signer.did(), "reader"),
          compiled,
          { source: source.withTx(undefined) },
        );
        expect(callbacks).toHaveLength(1);
        await source.withTx(undefined).pull();
        const presync = runtime.edit();
        try {
          await handlers[0].presyncInputs?.({}, undefined, presync);
        } finally {
          presync.abort();
        }
        const preflight = runtime.edit();
        try {
          callbacks[0](preflight, {});
          const log = txToReactivityLog(preflight);
          const ids = [...log.reads, ...log.shallowReads].map((read) =>
            read.id
          );
          expect(ids).not.toContain(extra.getAsNormalizedFullLink().id);
          expect(ids).toContain(title.getAsNormalizedFullLink().id);
        } finally {
          preflight.abort();
        }
        const update = runtime.edit();
        title.withTx(update).set("Chocolate");
        expect((await update.commit().settled).error).toBeUndefined();
        result.key("capture").send({});
        await runtime.idle();
        expect(result.key("selected").get()).toBe("Chocolate");
        expect(traversal.countsByKey.traverse?.warn ?? 0).toBe(warnings);
      } finally {
        await runtime.dispose();
        await storage.close();
      }
    });
  }
});
