import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";

describe("generated-cell-update-refusal", () => {
  for (const legacy of [false, true]) {
    for (const refusal of ["abort", "schema", "watcher-commit"] as const) {
      it(`keeps ${legacy ? "legacy" : "versioned"} nodes reactive after a refused ${refusal} update`, async () => {
        const signer = await Identity.fromPassphrase(
          "generated-cell-update-refusal",
        );
        const space = signer.did();
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
          experimental: { serverExecution: false },
        });
        const compile = (factor: number, requiredType: string) =>
          runtime.patternManager.compilePattern({
            main: "/main.tsx",
            files: [{
              name: "/main.tsx",
              contents: `
                import { computed, pattern, Writable } from "commonfabric";
                interface Args { input: Writable<number>; required: ${requiredType}; }
                export default pattern<Args, { slots: number[] }>(({ input }) => {
                  const slots = [0].map(() => computed(() => input.get() * ${factor}));
                  return { slots };
                });
              `,
            }],
          }, { space });
        let cancel: (() => void) | undefined;
        const prepare = runtime.prepareTxForCommit;
        try {
          const v1 = await compile(2, "string");
          const v2 = await compile(
            3,
            refusal === "schema" ? "number" : "string",
          );
          const v2Ref = runtime.patternManager.getArtifactEntryRef(v2)!;
          const input = runtime.getCell<number>(space, "refusal-input");
          const piece = runtime.getCell<{ slots: number[] }>(
            space,
            "refusal-piece",
          );
          const seed = runtime.edit();
          input.withTx(seed).set(1);
          if (legacy) {
            piece.withTx(seed).setMetaRaw(
              "patternIdentity",
              runtime.patternManager.getArtifactEntryRef(v1)!,
              rawMetaWriteAuthorization,
            );
          }
          await runtime.setup(seed, v1, { input, required: "sentinel" }, piece);
          if (legacy) {
            piece.withTx(seed).setMetaRaw(
              "generatedCellIdentity",
              undefined,
              rawMetaWriteAuthorization,
            );
          }
          expect((await seed.commit()).error).toBeUndefined();
          expect(await runtime.start(piece)).toBe(true);
          cancel = piece.sink(() => {});
          await runtime.idle();
          expect(piece.get()).toEqual({ slots: [2] });
          const before = {
            namespace: piece.getMetaRaw("generatedCellIdentity"),
            pointer: piece.getMetaRaw("patternIdentity"),
            setup: piece.getMetaRaw("patternSetupIdentity"),
            manifest: piece.getMetaRaw("internal"),
            projection: piece.getRaw(),
          };
          const refused: boolean[] = [];
          if (refusal === "abort") {
            const tx = runtime.edit();
            await runtime.setup(tx, v2, undefined, piece);
            expect(piece.withTx(tx).getMetaRaw("generatedCellIdentity"))
              .not.toEqual(before.namespace);
            expect(tx.abort("candidate refused").error).toBeUndefined();
          } else if (refusal === "schema") {
            await expect(runtime.setup(undefined, v2, undefined, piece)).rejects
              .toThrow("updated arguments do not match the candidate schema");
          } else {
            // The watcher owns this setup transaction. Inspecting its writes
            // selects it without adding reads to unrelated commits.
            const pieceId = piece.getAsNormalizedFullLink().id;
            runtime.prepareTxForCommit = (tx) => {
              const stagesNamespace = [...tx.getWriteDetails?.(space) ?? []]
                .some(({ address }) =>
                  address.id === pieceId &&
                  address.path[0] === "generatedCellIdentity"
                );
              if (stagesNamespace) {
                refuseAtCommitBoundary(tx, space, "reject the watcher setup");
                tx.addCommitCallback((_settled, result) => {
                  refused.push(isCfcEnforcementRejection(result.error));
                });
              }
              prepare.call(runtime, tx);
            };
            expect(runtime.sealDestinationInstalled).toBe(false);
            const tx = runtime.edit();
            piece.withTx(tx).setMetaRaw(
              "patternIdentity",
              v2Ref,
              rawMetaWriteAuthorization,
            );
            expect((await tx.commit()).error).toBeUndefined();
          }
          await runtime.runner.idlePointerMaintenance();
          await runtime.runner.idlePieceInstantiationSettlements();
          await runtime.idle();
          runtime.prepareTxForCommit = prepare;
          if (refusal === "watcher-commit") expect(refused).toEqual([true]);
          expect({
            namespace: piece.getMetaRaw("generatedCellIdentity"),
            pointer: piece.getMetaRaw("patternIdentity"),
            setup: piece.getMetaRaw("patternSetupIdentity"),
            manifest: piece.getMetaRaw("internal"),
            projection: piece.getRaw(),
          }).toEqual({
            ...before,
            pointer: refusal === "watcher-commit" ? v2Ref : before.pointer,
          });
          expect(
            (await runtime.editWithRetry((tx) => input.withTx(tx).set(4)))
              .error,
          ).toBeUndefined();
          await runtime.idle();
          expect(piece.get()).toEqual({ slots: [8] });
        } finally {
          runtime.prepareTxForCommit = prepare;
          cancel?.();
          await runtime.idle();
          await runtime.patternManager.flushCompileCacheWrites();
          await runtime.storageManager.synced();
          await runtime.dispose();
          await server.close();
        }
      });
    }
  }
});
