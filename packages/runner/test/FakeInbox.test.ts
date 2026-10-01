import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { FakeInbox } from "../src/for-testing-only.deno.ts";
import { signFirstPartyHttpRequest } from "../src/toolshed-http-auth.ts";

const alice = await Identity.fromPassphrase("fake-inbox alice");
const bob = await Identity.fromPassphrase("fake-inbox bob");

/** A space-access notice payload naming a fixed space and document. */
const NOTICE = {
  type: "space-access-notice",
  v: 1,
  space: "did:key:z6MkspaceSpaceSpaceSpaceSpaceSpaceSpaceSpaceSpa",
  entry: "of:room",
};

/** A `send` envelope to `recipient` carrying `NOTICE`. */
function envelope(recipient: Identity, operationId = "notice-1"): string {
  return JSON.stringify({
    recipientDid: recipient.did(),
    operationId,
    payload: NOTICE,
  });
}

/** A `POST` of `body` to `url`, signed by `signer` as a first-party request. */
async function signed(
  url: URL,
  body: string,
  signer: Identity,
): Promise<Request> {
  const headers = await signFirstPartyHttpRequest({
    url,
    method: "POST",
    body,
    signer,
    headers: { "Content-Type": "application/json" },
  });
  return new Request(url, { method: "POST", body, headers });
}

describe("FakeInbox", () => {
  let inbox: FakeInbox;
  let sendUrl: URL;

  beforeEach(() => {
    inbox = new FakeInbox();
    sendUrl = new URL("/api/inbox/send", inbox.apiUrl);
  });

  afterEach(() => {
    inbox.close();
  });

  describe("instance members", () => {
    describe("fetch()", () => {
      it("hands a request to another origin to the fallback with its body unread", async () => {
        const seen: string[] = [];
        const forwarding = new FakeInbox({
          fallback: async (input) => {
            seen.push(await (input as Request).text());
            return new Response("forwarded");
          },
        });
        try {
          const response = await forwarding.fetch(
            new Request("http://example.test/api/other", {
              method: "POST",
              body: "the body",
            }),
          );
          expect(await response.text()).toBe("forwarded");
          expect(seen).toEqual(["the body"]);
        } finally {
          forwarding.close();
        }
      });

      it("returns `404 invalid-request` for another origin when there is no fallback", async () => {
        const response = await inbox.fetch("http://example.test/api/other");
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ code: "invalid-request" });
      });

      it("returns `401 invalid-proof` for a send without a valid proof", async () => {
        const response = await inbox.fetch(sendUrl, {
          method: "POST",
          body: envelope(bob),
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ code: "invalid-proof" });
        expect(inbox.sends).toBe(1);
      });

      it("returns `400 invalid-request` for a signed send whose body is not JSON", async () => {
        const response = await inbox.fetch(
          await signed(sendUrl, "not json", alice),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ code: "invalid-request" });
        expect(inbox.refusals).toEqual(["invalid-request"]);
      });

      it("returns `400 invalid-request` for a signed send whose envelope names no recipient", async () => {
        const response = await inbox.fetch(
          await signed(
            sendUrl,
            JSON.stringify({ operationId: "notice-1", payload: NOTICE }),
            alice,
          ),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ code: "invalid-request" });
      });

      it("returns `409 not-enabled` for a send to a recipient who has not enabled their inbox", async () => {
        const response = await inbox.fetch(
          await signed(sendUrl, envelope(bob), alice),
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({ code: "not-enabled" });
        expect(inbox.refusals).toEqual(["not-enabled"]);
        expect(inbox.messages).toEqual([]);
      });

      it("accepts a signed send to an enabled recipient, recording the signer as its sender", async () => {
        inbox.enable(bob.did());
        const response = await inbox.fetch(
          await signed(sendUrl, envelope(bob), alice),
        );
        expect(response.status).toBe(200);
        expect(inbox.messages.map((message) => message.payload)).toEqual([
          NOTICE,
        ]);
        expect(inbox.messages[0].receipt.senderDid).toBe(alice.did());
        expect(inbox.messagesFor(bob.did()).length).toBe(1);
      });

      it("accepts a send to anyone when every recipient is enabled", async () => {
        const open = new FakeInbox({ everyRecipientEnabled: true });
        try {
          const url = new URL("/api/inbox/send", open.apiUrl);
          const response = await open.fetch(
            await signed(url, envelope(bob), alice),
          );
          expect(response.status).toBe(200);
          expect(open.messagesFor(bob.did()).length).toBe(1);
        } finally {
          open.close();
        }
      });

      it("reports a repeated send once in `messages`", async () => {
        inbox.enable(bob.did());
        await inbox.fetch(await signed(sendUrl, envelope(bob), alice));
        await inbox.fetch(await signed(sendUrl, envelope(bob), alice));
        expect(inbox.sends).toBe(2);
        expect(inbox.messages.length).toBe(1);
      });
    });
  });
});
