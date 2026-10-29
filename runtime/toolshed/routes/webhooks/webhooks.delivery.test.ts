/**
 * End-to-end check of the part of the webhook flow this PR actually changes: a
 * cell link serialized to the `fcl1:` wire string (as `CellHandle.toWireString`
 * produces it) must decode, resolve to the right cell, and deliver a payload to
 * that cell's inbox stream. This mirrors `sendToStream`'s decode -> resolve ->
 * send path; that function reaches the `@/index.ts` runtime singleton (which is
 * uninitialized in tests), so it can't be called directly here, but the logic
 * exercised is identical, against the house in-memory `StorageManager.emulate`
 * runtime.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  assertWebhookCellLinkRefPayload,
  type JSONSchema,
  linkRefFrom,
  linkRefPayloadFromString,
  linkRefPayloadToString,
} from "@commonfabric/runner/shared";

const STREAM_SCHEMA: JSONSchema = {
  asCell: ["stream"],
  type: "object",
  properties: { data: { type: "string" } },
};

describe("webhook cell-link wire delivery (fcl1: -> resolve -> stream)", () => {
  let signer: Identity;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: ReturnType<Runtime["edit"]>;

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("webhook delivery test");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://webhook-test.invalid"),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime.dispose();
    await storageManager.close();
  });

  it("delivers a payload to the inbox stream addressed by its fcl1: link", async () => {
    const space = signer.did();

    // The pattern-side inbox stream the webhook targets, plus a plain cell the
    // event handler writes into so we can observe what was delivered.
    const inbox = runtime.getCell(space, "webhook-inbox", STREAM_SCHEMA, tx);
    const received = runtime.getCell<unknown>(
      space,
      "webhook-received",
      undefined,
      tx,
    );
    received.set(null);
    await tx.commit().settled;
    tx = runtime.edit();

    runtime.scheduler.addEventHandler((eventTx, event) => {
      received.withTx(eventTx).send(event);
    }, inbox.getAsNormalizedFullLink());

    // Mint the wire string exactly as `CellHandle.toWireString` does, from the
    // inbox's addressing fields only.
    const link = inbox.getAsNormalizedFullLink();
    const wire = linkRefPayloadToString({
      id: link.id,
      space: link.space,
      path: link.path.map((p) => String(p)),
      ...(link.scope !== undefined ? { scope: link.scope } : {}),
    });
    expect(wire.startsWith("fcl1:")).toBe(true);

    // Decode + resolve + send, mirroring `sendToStream`.
    const payload = linkRefPayloadFromString(wire);
    assertWebhookCellLinkRefPayload(payload);
    const streamCell = runtime.getCellFromLink(linkRefFrom(payload))
      .asSchema({ asCell: ["stream"] });
    streamCell.withTx(tx).send({ data: "hello-webhook" });
    await tx.commit().settled;
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(await received.pull()).toEqual({ data: "hello-webhook" });
  });
});
