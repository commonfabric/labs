import { Database } from "@db/sqlite";
import { toFileUrl } from "@std/path";
import { Server } from "../v2/server.ts";
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { InboxStore } from "../inbox-store.ts";

describe("InboxStore", () => {
  it("enables only the explicit recipient and retains readiness after reopening", async () => {
    const recipient = (await Identity.fromPassphrase("inbox-recipient")).did();
    const other = (await Identity.fromPassphrase("inbox-other")).did();
    const directory = await Deno.makeTempDir();
    let store = new InboxStore(`${directory}/inbox.sqlite`);
    try {
      expect(store.status(recipient).enabled).toBe(false);
      expect(store.enable(recipient)).toEqual({
        recipientDid: recipient,
        enabled: true,
      });
      store.close();
      store = new InboxStore(`${directory}/inbox.sqlite`);
      expect(store.status(recipient).enabled).toBe(true);
      expect(store.status(other).enabled).toBe(false);
    } finally {
      store.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
  it("keeps immutable receipts across retries, acknowledgement and reopening", async () => {
    const recipientDid = (await Identity.fromPassphrase("inbox-recipient"))
      .did();
    const senderDid = (await Identity.fromPassphrase("inbox-sender")).did();
    const other = (await Identity.fromPassphrase("inbox-other")).did();
    const directory = await Deno.makeTempDir();
    let store = new InboxStore(`${directory}/inbox.sqlite`);
    const request = {
      recipientDid,
      operationId: "delivery-1",
      payload: { hello: "world", nested: [1, true] },
    };
    const key = { senderDid, operationId: request.operationId };
    try {
      expect(() => store.send(senderDid, request)).toThrow("not-enabled");
      store.enable(recipientDid);
      const receipt = store.send(senderDid, request);
      expect(
        store.send(senderDid, {
          ...request,
          payload: { nested: [1, true], hello: "world" },
        }),
      ).toEqual(receipt);
      expect(() =>
        store.send(senderDid, { ...request, payload: { hello: "changed" } })
      ).toThrow("operation-conflict");
      expect(store.list(other).messages).toEqual([]);
      expect(store.get(other, key).message).toBeNull();
      expect(store.acknowledge(other, key).acknowledged).toBe(false);
      expect(store.get(recipientDid, key).message).toEqual({
        receipt,
        payload: request.payload,
      });
      store.close();
      store = new InboxStore(`${directory}/inbox.sqlite`);
      expect(store.get(recipientDid, key).message?.receipt).toEqual(receipt);
      expect(store.acknowledge(recipientDid, key).acknowledged).toBe(true);
      expect(store.get(recipientDid, key).message).toBeNull();
      expect(store.list(recipientDid).messages).toEqual([]);
      expect(store.send(senderDid, request)).toEqual(receipt);
      expect(store.list(recipientDid).messages).toEqual([]);
    } finally {
      store.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
  it("bounds payloads and sender pending capacity without hiding exact retries", async () => {
    const recipientDid = (await Identity.fromPassphrase("quota-recipient"))
      .did();
    const senderDid = (await Identity.fromPassphrase("quota-sender")).did();
    const store = new InboxStore(":memory:");
    try {
      store.enable(recipientDid);
      expect(() =>
        store.send(senderDid, {
          recipientDid,
          operationId: "oversize",
          payload: "x".repeat(16384),
        })
      ).toThrow("invalid-payload");
      expect(() =>
        store.send(senderDid, {
          recipientDid,
          operationId: "invalid",
          payload: NaN,
        })
      ).toThrow("invalid-payload");
      const receipts = [];
      for (let i = 0; i < 100; i++) {
        receipts.push(
          store.send(senderDid, {
            recipientDid,
            operationId: `message-${i}`,
            payload: i,
          }),
        );
      }
      expect(() =>
        store.send(senderDid, {
          recipientDid,
          operationId: "overflow",
          payload: 0,
        })
      ).toThrow("inbox-full");
      expect(
        store.send(senderDid, {
          recipientDid,
          operationId: "message-0",
          payload: 0,
        }),
      ).toEqual(receipts[0]);
      const page1 = store.list(recipientDid, { limit: 7 });
      const page2 = store.list(recipientDid, {
        limit: 7,
        cursor: page1.nextCursor!,
      });
      expect(page1.messages.length).toBe(7);
      expect(page2.messages[0].receipt.operationId).toBe("message-7");
      store.acknowledge(recipientDid, { senderDid, operationId: "message-0" });
      expect(
        store.send(senderDid, {
          recipientDid,
          operationId: "after-ack",
          payload: 0,
        }).operationId,
      ).toBe("after-ack");
    } finally {
      store.close();
    }
  });
  it("enforces the recipient capacity across distinct senders", async () => {
    const recipientDid = (await Identity.fromPassphrase("total-capacity"))
      .did();
    const senders = await Promise.all(
      Array.from(
        { length: 11 },
        (_, i) => Identity.fromPassphrase(`quota-sender-${i}`),
      ),
    );
    const store = new InboxStore(":memory:");
    try {
      store.enable(recipientDid);
      for (let i = 0; i < 1000; i++) {
        store.send(senders[i % 10].did(), {
          recipientDid,
          operationId: `message-${i}`,
          payload: null,
        });
      }
      expect(() =>
        store.send(senders[10].did(), {
          recipientDid,
          operationId: "overflow",
          payload: null,
        })
      ).toThrow("inbox-full");
      store.acknowledge(recipientDid, {
        senderDid: senders[0].did(),
        operationId: "message-0",
      });
      expect(
        store.send(senders[10].did(), {
          recipientDid,
          operationId: "accepted",
          payload: null,
        }).operationId,
      ).toBe("accepted");
    } finally {
      store.close();
    }
  });
  it("owns the inbox database through memory server shutdown and reopening", async () => {
    const directory = await Deno.makeTempDir();
    const recipient = (await Identity.fromPassphrase("lifecycle-recipient"))
      .did();
    try {
      for (const name of ["directory/", "single.sqlite"]) {
        const location = toFileUrl(`${directory}/${name}`);
        const first = new Server({
          store: location,
          authorizeSessionOpen: () => undefined,
          sessionOpenAuth: { audience: recipient },
        });
        const store = await first.inboxStore();
        store.enable(recipient);
        await first.close();
        expect(() => store.status(recipient)).toThrow();
        const second = new Server({
          store: location,
          authorizeSessionOpen: () => undefined,
          sessionOpenAuth: { audience: recipient },
        });
        try {
          expect((await second.inboxStore()).status(recipient).enabled).toBe(
            true,
          );
        } finally {
          await second.close();
        }
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
  it("paginates durable insertion sequences beyond signed 32-bit integers", async () => {
    const recipient = (await Identity.fromPassphrase("wide-sequence")).did();
    const directory = await Deno.makeTempDir();
    const path = `${directory}/inbox.sqlite`;
    const store = new InboxStore(path);
    try {
      store.enable(recipient);
      const database = new Database(path);
      try {
        database.exec(
          "INSERT INTO sqlite_sequence(name,seq) VALUES ('inbox_messages',2147483648)",
        );
      } finally {
        database.close();
      }
      store.send(recipient, {
        recipientDid: recipient,
        operationId: "first",
        payload: null,
      });
      store.send(recipient, {
        recipientDid: recipient,
        operationId: "second",
        payload: null,
      });
      const first = store.list(recipient, { limit: 1 });
      expect(first.nextCursor).toBe("2147483649");
      expect(
        store.list(recipient, { limit: 1, cursor: first.nextCursor! })
          .messages[0].receipt.operationId,
      ).toBe("second");
    } finally {
      store.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
});
