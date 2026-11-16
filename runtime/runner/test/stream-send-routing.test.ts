import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { type Cell, createCell } from "../src/cell.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import type {
  IExtendedStorageTransaction,
  TransactionSealDestination,
} from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("stream send routing");
const space = signer.did();
const foreignSpace = (await Identity.fromPassphrase("stream send foreign"))
  .did();

describe("cell", () => {
  describe("Cell", () => {
    describe("instance members", () => {
      describe("send()", () => {
        let storageManager: ReturnType<typeof StorageManager.emulate>;

        beforeEach(() => {
          storageManager = StorageManager.emulate({ as: signer });
        });

        afterEach(async () => {
          await storageManager.close();
        });

        /** The link of a stream in `streamSpace`, under `scope`. */
        function streamLinkIn(
          runtime: Runtime,
          streamSpace: MemorySpace,
          scope: NormalizedFullLink["scope"],
        ): NormalizedFullLink {
          return {
            ...runtime.getCell(streamSpace, "routed-stream")
              .getAsNormalizedFullLink(),
            scope,
          };
        }

        /** A stream cell over `link`, bound to `tx`. */
        function streamAt(
          runtime: Runtime,
          link: NormalizedFullLink,
          tx?: IExtendedStorageTransaction,
        ): Cell<unknown> {
          return createCell(runtime, link, tx, false, "stream");
        }

        describe("from a client under server execution", () => {
          let runtime: Runtime;

          beforeEach(() => {
            runtime = new Runtime({
              apiUrl: new URL(import.meta.url),
              storageManager,
              experimental: { serverExecution: true },
            });
          });

          afterEach(async () => {
            await runtime.dispose();
          });

          it("appends the event to the stream at the scope its link names", () => {
            const appended: unknown[] = [];
            storageManager.open(space).replica.enqueueEventAppend = (entry) => {
              appended.push(entry.stream);
              return Promise.resolve({ delivered: true });
            };
            const scoped = streamLinkIn(runtime, space, "user");
            const spaceWide = streamLinkIn(runtime, space, "space");

            streamAt(runtime, scoped).send({ n: 1 });
            streamAt(runtime, spaceWide).send({ n: 2 });

            expect(appended).toEqual([
              { id: scoped.id, path: [], scope: "user" },
              { id: spaceWide.id, path: [], scope: "space" },
            ]);
          });
        });

        describe("from a served run", () => {
          let runtime: Runtime;

          beforeEach(() => {
            runtime = new Runtime({
              apiUrl: new URL(import.meta.url),
              storageManager,
              servingPosture: true,
              experimental: { serverExecution: true },
            });
          });

          afterEach(async () => {
            await runtime.dispose();
          });

          /** A transaction stamped as a served handler run's. */
          function servedRunTx(): IExtendedStorageTransaction {
            const tx = runtime.edit();
            stampWaveRunContext(tx, {
              actionId: "routing",
              kind: "event-handler",
            });
            return tx;
          }

          /** A destination homed at `home`, recording what it stages. */
          function destination(
            home: MemorySpace | undefined,
            staged: OutboxAppendRow[] | undefined,
          ): TransactionSealDestination {
            return {
              seal: () => Promise.resolve({ ok: {} }),
              ...(home !== undefined ? { space: home } : {}),
              ...(staged !== undefined
                ? { stageOutboundAppend: (_tx, row) => staged.push(row) }
                : {}),
            };
          }

          it("stages a send to another space on the outbox, at the scope its link names", () => {
            const staged: OutboxAppendRow[] = [];
            runtime.installSealDestination(destination(space, staged));
            const tx = servedRunTx();
            const link = streamLinkIn(runtime, foreignSpace, "user");

            streamAt(runtime, link, tx).send({ n: 3 });

            expect(
              staged.map(({ targetSpace, targetStreamLink }) => ({
                targetSpace,
                targetStreamLink,
              })),
            ).toEqual([{
              targetSpace: foreignSpace,
              targetStreamLink: { id: link.id, path: [], scope: "user" },
            }]);
            tx.abort();
          });

          it("throws for a send to another space where the destination has no outbox", () => {
            runtime.installSealDestination(destination(space, undefined));
            const tx = servedRunTx();

            expect(() =>
              streamAt(
                runtime,
                streamLinkIn(runtime, foreignSpace, "space"),
                tx,
              )
                .send({ n: 4 })
            )
              .toThrow(
                "cross-space event emission requires the serving loop's outbox",
              );
            tx.abort();
          });

          it("throws for a send where a destination with an outbox names no home space", () => {
            const staged: OutboxAppendRow[] = [];
            runtime.installSealDestination(destination(undefined, staged));
            const tx = servedRunTx();

            expect(() =>
              streamAt(
                runtime,
                streamLinkIn(runtime, foreignSpace, "space"),
                tx,
              )
                .send({ n: 5 })
            )
              .toThrow("server-side emission refused");
            expect(staged).toEqual([]);
            tx.abort();
          });
        });
      });
    });
  });
});
