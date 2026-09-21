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
  it("refuses malformed private-read and opt-in responses without treating them as success", async () => {
    const signer = await Identity.fromPassphrase("sdk-response-validation");
    const other = (await Identity.fromPassphrase("sdk-response-other")).did();
    const host = "https://inbox.example";
    const clientFor = (value: unknown) =>
      new InboxClient({
        host,
        signer,
        fetch: () => Promise.resolve(Response.json(value)),
      });
    for (
      const value of [null, [], { recipientDid: other, enabled: true }, {
        recipientDid: signer.did(),
        enabled: false,
      }]
    ) {
      await expect(clientFor(value).enable()).rejects.toThrow(
        "invalid-response",
      );
    }
    for (
      const value of [{ recipientDid: other, enabled: true }, {
        recipientDid: signer.did(),
        enabled: "true",
      }]
    ) {
      await expect(clientFor(value).status(signer.did())).rejects.toThrow(
        "invalid-response",
      );
    }
    for (
      const value of [{ messages: {}, nextCursor: null }, {
        messages: [],
        nextCursor: 1,
      }]
    ) {
      await expect(clientFor(value).list()).rejects.toThrow("invalid-response");
    }
    await expect(
      clientFor({ acknowledged: "true" }).acknowledge({
        senderDid: other,
        operationId: "selected",
      }),
    ).rejects.toThrow("invalid-response");
    const invalidJSON = new InboxClient({
      host,
      signer,
      fetch: () => Promise.resolve(new Response("not JSON")),
    });
    await expect(invalidJSON.list()).rejects.toThrow("invalid-response");
  });
  it("rejects poisoned message pages and a selected message bound to another delivery", async () => {
    const signer = await Identity.fromPassphrase("sdk-message-validation");
    const senderDid = (await Identity.fromPassphrase("sdk-message-sender"))
      .did();
    const other = (await Identity.fromPassphrase("sdk-message-other")).did();
    const payload = { text: "private" };
    const receipt = {
      recipientDid: signer.did(),
      senderDid,
      operationId: "selected",
      payloadHash: hashStringOf(payload),
      receivedAt: Date.now(),
    };
    const clientFor = (value: unknown) =>
      new InboxClient({
        host: "https://inbox.example",
        signer,
        fetch: () => Promise.resolve(Response.json(value)),
      });
    for (
      const poisoned of [null, { receipt: null, payload }, {
        receipt,
        payload: "changed",
      }, {
        receipt: { ...receipt, payloadHash: hashStringOf("x".repeat(16384)) },
        payload: "x".repeat(16384),
      }]
    ) {
      await expect(clientFor({ messages: [poisoned], nextCursor: null }).list())
        .rejects.toThrow("invalid-response");
    }
    for (
      const changed of [{ senderDid: other }, { operationId: "different" }]
    ) {
      await expect(
        clientFor({ message: { receipt: { ...receipt, ...changed }, payload } })
          .get({ senderDid, operationId: "selected" }),
      ).rejects.toThrow("invalid-response");
    }
    const knownRefusal = new InboxClient({
      host: "https://inbox.example",
      signer,
      fetch: () =>
        Promise.resolve(
          Response.json({ code: "rate-limited", error: "private text" }, {
            status: 429,
          }),
        ),
    });
    await expect(knownRefusal.list()).rejects.toThrow("rate-limited");
  });
});
