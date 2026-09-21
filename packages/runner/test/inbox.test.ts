import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { hashStringOf } from "@commonfabric/data-model";
import { InboxClient } from "../src/inbox.ts";

describe("InboxClient", () => {
  it("rejects a receipt bound to another recipient, sender, operation or payload", async () => {
    const signer = await Identity.fromPassphrase("sdk-inbox");
    const other = (await Identity.fromPassphrase("sdk-other")).did();
    const request = {
      recipientDid: signer.did(),
      operationId: "test",
      payload: { text: "private" },
    };
    const good = {
      recipientDid: signer.did(),
      senderDid: signer.did(),
      operationId: "test",
      payloadHash: hashStringOf(request.payload),
      receivedAt: Date.now(),
    };
    for (
      const changed of [
        { recipientDid: other },
        { senderDid: other },
        { operationId: "other" },
        { payloadHash: "other" },
        { receivedAt: -1 },
      ]
    ) {
      const client = new InboxClient({
        host: "https://inbox.example",
        signer,
        fetch: () => Promise.resolve(Response.json({ ...good, ...changed })),
      });
      await expect(client.send(request)).rejects.toThrow("invalid-response");
    }
  });
  it("redacts remote refusals and refuses redirects without retrying", async () => {
    const signer = await Identity.fromPassphrase("sdk-refusal");
    let calls = 0;
    const client = new InboxClient({
      host: "https://inbox.example",
      signer,
      fetch: (_url, options) => {
        calls++;
        expect(options?.redirect).toBe("error");
        return Promise.resolve(
          Response.json({
            code: "private untrusted text",
            error: "private payload",
          }, { status: 500 }),
        );
      },
    });
    await expect(
      client.send({
        recipientDid: signer.did(),
        operationId: "one",
        payload: {},
      }),
    ).rejects.toThrow("service-error");
    expect(calls).toBe(1);
  });
  it("rejects non-JSON and oversized payloads before sending", async () => {
    const signer = await Identity.fromPassphrase("sdk-limits");
    let calls = 0;
    const client = new InboxClient({
      host: "https://inbox.example",
      signer,
      fetch: () => {
        calls++;
        return Promise.resolve(Response.json({}));
      },
    });
    for (const payload of [NaN, Infinity, "x".repeat(16384)]) {
      await expect(
        client.send({
          recipientDid: signer.did(),
          operationId: "invalid",
          payload,
        }),
      ).rejects.toThrow("invalid-payload");
    }
    expect(calls).toBe(0);
  });
});
