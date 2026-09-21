import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";

describe("generated-cell-restoration", () => {
  for (
    const route of [
      "setup",
      "warm-watcher",
      "warm-synced-watcher",
      "cold-watcher",
    ] as const
  ) {
    it(`retains old anonymous state when restoring through ${route} in a fresh runtime`, async () => {
      const signer = await Identity.fromPassphrase(
        "generated-cell-restoration",
      );
      const space = signer.did();
      const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const connect = () =>
        new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
        });
      const writer = connect();
      let reader: Runtime | undefined;
      let cancel: (() => void) | undefined;
      try {
        const compile = (value: string) =>
          writer.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: `
                import { pattern, Writable } from "commonfabric";
                export default pattern<Record<string, never>, { slots: Writable<string>[] }>(() => ({
                  slots: [0].map(() => new Writable("${value}")),
                }));
              `,
            }],
          }, { space });
        const v1 = await compile("v1-default");
        const v2 = await compile("v2-default");
        const ref1 = writer.patternManager.getArtifactEntryRef(v1)!;
        const ref2 = writer.patternManager.getArtifactEntryRef(v2)!;
        const schema = {
          type: "object",
          properties: {
            slots: { type: "array", items: { type: "string" } },
          },
        } as const;
        const piece = writer.getCell<{ slots: string[] }>(
          space,
          "restored-piece",
          schema,
        );
        await writer.setup(undefined, v1, {}, piece);
        const original = piece.key("slots").key(0).resolveAsCell();
        const originalLink = original.getAsNormalizedFullLink();
        expect(original.get()).toBe("v1-default");
        expect(
          (await writer.editWithRetry((tx) =>
            original.withTx(tx).set("v1-sentinel")
          )).error,
        ).toBeUndefined();
        await writer.setup(undefined, v2, {}, piece);
        expect(piece.get()).toEqual({ slots: ["v2-default"] });
        await writer.patternManager.flushCompileCacheWrites();
        await writer.storageManager.synced();
        await writer.dispose();

        reader = connect();
        const reopened = reader.getCellFromLink<{ slots: string[] }>(
          piece.getAsNormalizedFullLink(),
        ).asSchema(schema);
        await reopened.sync();
        expect(await reader.start(reopened)).toBe(true);
        cancel = reopened.sink(() => {});
        await reader.idle();
        expect(reopened.get()).toEqual({ slots: ["v2-default"] });
        expect(reopened.getMetaRaw("generatedCellIdentity")).toEqual({
          version: 1,
          ...ref2,
        });
        const replica = reader.storageManager.open(space).replica;
        expect(
          replica.hasLocalDocumentCoverage?.(
            originalLink.id,
            originalLink.scope,
          ),
        ).toBe(false);
        let namingSteps = 0;
        reader.runner.accessForTestingOnly.dependencySyncer = (
          target,
          pattern,
          inputs,
          sync,
        ) => {
          namingSteps++;
          return sync(target, pattern, inputs);
        };
        if (route === "setup") {
          const loaded = await reader.patternManager.loadPatternByIdentity(
            ref1.identity,
            ref1.symbol,
            space,
          );
          expect(loaded).toBeDefined();
          await reader.setup(undefined, loaded!, {}, reopened);
        } else {
          if (route === "warm-watcher" || route === "warm-synced-watcher") {
            expect(
              await reader.patternManager.loadPatternByIdentity(
                ref1.identity,
                ref1.symbol,
                space,
              ),
            ).toBeDefined();
          }
          if (route === "warm-synced-watcher") {
            await reader.getCellFromLink(originalLink).sync();
          }
          const tx = reader.edit();
          reopened.withTx(tx).setMetaRaw(
            "patternIdentity",
            ref1,
            rawMetaWriteAuthorization,
          );
          expect((await tx.commit()).error).toBeUndefined();
        }
        await reader.idle();
        await reader.runner.idlePointerMaintenance();
        await reader.runner.idlePieceInstantiationSettlements();
        await reader.idle();
        await reader.storageManager.synced();
        if (route === "warm-synced-watcher") {
          expect(namingSteps).toBe(0);
        } else if (route !== "setup") {
          expect(namingSteps).toBeGreaterThan(0);
        }
        expect(await reopened.pull()).toEqual({ slots: ["v1-sentinel"] });
        expect(reopened.getMetaRaw("generatedCellIdentity")).toEqual({
          version: 1,
          ...ref1,
        });
      } finally {
        cancel?.();
        if (reader !== undefined) {
          reader.runner.accessForTestingOnly.dependencySyncer = undefined;
          await reader.idle();
          await reader.dispose();
        }
        await writer.dispose();
        await server.close();
      }
    });
  }
});
