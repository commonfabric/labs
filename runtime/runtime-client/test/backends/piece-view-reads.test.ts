/** Checks the documents acquired while resolving a piece for display. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { RequestType } from "../../src/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("piece view read boundaries");
const space = signer.did();

describe("piece-view-reads", () => {
  for (const mode of ["enabled", "disabled", "unsupported"] as const) {
    for (const address of ["direct", "redirect", "nested redirect"] as const) {
      it(`bounds ${address} reads with view replication ${mode}`, async () => {
        setServerExecutionConfig(true);
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const writer = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
        });
        const reader = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
          clientClass: "web",
          experimental: {
            serverExecution: true,
            viewScopedReplication: mode !== "disabled",
          },
        });
        const capability = mode === "unsupported"
          ? stub(reader.viewReplication, "enable", () => Promise.resolve(false))
          : undefined;
        try {
          const root = writer.getCell(space, "root", undefined);
          const hidden = writer.getCell(space, "hidden", undefined);
          const ui = writer.getCell(space, "ui", undefined);
          const slug = writer.getCell(space, "slug", undefined);
          const target = address === "nested redirect" ? root.key("tab") : root;
          const result = await writer.editWithRetry((tx) => {
            hidden.withTx(tx).set({ payload: "Off-screen data" });
            ui.withTx(tx).set({
              type: "vnode",
              name: "div",
              children: ["Hello"],
            });
            target.withTx(tx).set({ $NAME: "Visible name", $UI: ui, hidden });
            slug.withTx(tx).set({
              "/": {
                "link@1": {
                  ...target.getAsNormalizedFullLink(),
                  overwrite: "redirect",
                },
              },
            });
          });
          expect(result.error).toBeUndefined();
          await writer.storageManager.synced();
          const cc = new PiecesController({ as: signer, space }, reader);
          const processor = buildProcessor({ runtime: reader, cc, space });
          const requested = address === "direct" ? root : slug;
          const response = await processor.handlePieceGet({
            type: RequestType.PieceGet,
            pieceId: requested.getAsNormalizedFullLink().id,
            runIt: false,
            space,
          });
          expect(response.piece.cell.id).toBe(
            target.getAsNormalizedFullLink().id,
          );
          expect(response.piece.cell.path).toEqual(
            target.getAsNormalizedFullLink().path,
          );
          const visible = reader.getCellFromLink(response.piece.cell);
          expect(visible.key("$NAME").get()).toBe("Visible name");
          await reader.storageManager.synced();
          const replica = reader.storageManager.open(space).replica;
          expect(
            replica.getDocument(hidden.getAsNormalizedFullLink().id) !==
              undefined,
          )
            .toBe(false);
        } finally {
          capability?.restore();
          await reader.dispose();
          await writer.dispose();
          await server.close();
          resetServerExecutionConfig();
        }
      });
    }
  }
});
