import { fromFileUrl } from "@std/path";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { pino } from "pino";
import { Identity } from "@commonfabric/identity";
import { InboxStore } from "@commonfabric/memory/inbox-store";
import { InboxClient } from "@commonfabric/runner/inbox";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { createRouter } from "../lib/create-app.ts";
import { createInboxRouter } from "../routes/inbox/router.ts";

function terminate(child: Deno.ChildProcess) {
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

async function startInboxProcess(
  directory: string,
  initialize?: () => Promise<void>,
) {
  const root = fromFileUrl(new URL("../../../", import.meta.url));
  const lock = `${directory}/deno-${crypto.randomUUID()}.lock`;
  await Deno.copyFile(`${root}/deno.lock`, lock);
  const child = new Deno.Command(Deno.execPath(), {
    cwd: root,
    args: [
      "run",
      `--lock=${lock}`,
      "--frozen",
      "-A",
      fromFileUrl(new URL("./fixtures/inbox-server.ts", import.meta.url)),
      `${directory}/inbox.sqlite`,
      ...(initialize ? ["--initialize-barrier"] : []),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const diagnostics = new Response(child.stderr).text();
  const lines = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    terminate(child);
    await child.status;
    await lines.cancel();
    lines.releaseLock();
    await diagnostics;
  };
  try {
    let buffered = "";
    const readLine = async () => {
      while (!buffered.includes("\n")) {
        const chunk = await lines.read();
        if (chunk.done) throw new Error("Inbox child exited before readiness");
        buffered += chunk.value;
      }
      const end = buffered.indexOf("\n");
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      return JSON.parse(line);
    };
    if (initialize) {
      expect((await readLine()).initializing).toBe(true);
      await initialize();
      const writer = child.stdin.getWriter();
      await writer.write(new Uint8Array([1]));
      await writer.close();
    } else {
      await child.stdin.close();
    }
    const { port } = await readLine();
    return { host: `http://127.0.0.1:${port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function fixture(publicHost?: string) {
  const directory = await Deno.makeTempDir();
  let store = new InboxStore(`${directory}/inbox.sqlite`);
  const owner = await Identity.fromPassphrase("http-inbox-owner");
  const sender = await Identity.fromPassphrase("http-inbox-sender");
  const stranger = await Identity.fromPassphrase("http-inbox-stranger");
  const router = createInboxRouter({
    store: () => Promise.resolve(store),
    host: publicHost,
  });
  const diagnostics: Record<string, unknown>[] = [];
  const logger = pino({ level: "warn" }, {
    write(message) {
      diagnostics.push(JSON.parse(message));
    },
  });
  const mounted = createRouter();
  mounted.use("*", async (c, next) => {
    c.set("logger", logger);
    await next();
  });
  mounted.route("/", router);
  const http = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (request) => mounted.fetch(request));
  const host = `http://127.0.0.1:${http.addr.port}`;
  const client = (signer: Identity) => new InboxClient({ host, signer });
  return {
    owner,
    sender,
    stranger,
    host,
    client,
    diagnostics,
    reopen() {
      store.close();
      store = new InboxStore(`${directory}/inbox.sqlite`);
    },
    async close() {
      await http.shutdown();
      store.close();
      await Deno.remove(directory, { recursive: true });
    },
  };
}

describe("inbox HTTP and SDK", () => {
  it("returns safe refusals for malformed bodies, invalid targets, and full inboxes", async () => {
    const owner = await Identity.fromPassphrase("router-validation");
    const store = new InboxStore(":memory:");
    const router = createInboxRouter({ store: () => Promise.resolve(store) });
    const post = async (operation: string, body: string) => {
      const url = new URL(`/api/inbox/${operation}`, "http://localhost:8000");
      const headers = await signFirstPartyHttpRequest({
        url,
        method: "POST",
        body,
        signer: owner,
      });
      return router.fetch(new Request(url, { method: "POST", headers, body }));
    };
    try {
      for (
        const [operation, body, status, code] of [
          ["enable", "{invalid-json", 400, "invalid-request"],
          [
            "send",
            JSON.stringify({
              recipientDid: owner.did(),
              operationId: "oversize",
              payload: "x".repeat(20001),
            }),
            413,
            "invalid-request",
          ],
          [
            "status",
            JSON.stringify({ recipientDid: "not-a-did" }),
            400,
            "invalid-request",
          ],
          [
            "send",
            JSON.stringify({
              recipientDid: owner.did(),
              operationId: "payload",
              payload: "x".repeat(16384),
            }),
            400,
            "invalid-payload",
          ],
        ] as const
      ) {
        const response = await post(operation, body);
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ code });
      }
      expect(store.status(owner.did()).enabled).toBe(false);
      store.enable(owner.did());
      for (let i = 0; i < 100; i++) {
        store.send(owner.did(), {
          recipientDid: owner.did(),
          operationId: `message-${i}`,
          payload: null,
        });
      }
      const full = await post(
        "send",
        JSON.stringify({
          recipientDid: owner.did(),
          operationId: "overflow",
          payload: null,
        }),
      );
      expect(full.status).toBe(429);
      expect(await full.json()).toEqual({ code: "inbox-full" });
      const acknowledged = await post(
        "acknowledge",
        JSON.stringify({ senderDid: owner.did(), operationId: "message-0" }),
      );
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toEqual({ acknowledged: true });
      const accepted = await post(
        "send",
        JSON.stringify({
          recipientDid: owner.did(),
          operationId: "overflow",
          payload: null,
        }),
      );
      expect(accepted.status).toBe(200);
      expect((await accepted.json()).operationId).toBe("overflow");
    } finally {
      store.close();
    }
  });
  it("returns a generic service error without exposing storage failure details", async () => {
    const signer = await Identity.fromPassphrase("router-storage-failure");
    let calls = 0;
    const router = createInboxRouter({
      store: () => {
        calls++;
        throw new Error("private storage path and message content");
      },
    });
    const url = new URL("http://localhost:8000/api/inbox/list");
    const body = "{}";
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      body,
      signer,
    });
    const response = await router.fetch(
      new Request(url, { method: "POST", headers, body }),
    );
    expect(calls).toBe(1);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "service-error" });
  });
  it("authenticates the sender, isolates recipient reads, and retains receipts after reopening", async () => {
    const f = await fixture();
    try {
      const owner = f.client(f.owner),
        sender = f.client(f.sender),
        stranger = f.client(f.stranger);
      const request = {
        recipientDid: f.owner.did(),
        operationId: "first-delivery",
        payload: { root: "opaque-reference", title: "private-title" },
      };
      expect((await sender.status(f.owner.did())).enabled).toBe(false);
      await expect(sender.send(request)).rejects.toThrow("not-enabled");
      await owner.enable();
      const receipts = await Promise.all(
        Array.from({ length: 12 }, () => sender.send(request)),
      );
      expect(
        receipts.every((receipt) =>
          JSON.stringify(receipt) === JSON.stringify(receipts[0])
        ),
      ).toBe(true);
      expect((await owner.list()).messages).toEqual([{
        receipt: receipts[0],
        payload: request.payload,
      }]);
      expect((await stranger.list()).messages).toEqual([]);
      const key = {
        senderDid: f.sender.did(),
        operationId: request.operationId,
      };
      expect((await stranger.get(key)).message).toBeNull();
      expect((await stranger.acknowledge(key)).acknowledged).toBe(false);
      await expect(
        sender.send({
          ...request,
          payload: { root: "different", title: "private-title" },
        }),
      ).rejects.toThrow("operation-conflict");
      f.reopen();
      expect((await owner.get(key)).message?.receipt).toEqual(receipts[0]);
      await owner.acknowledge(key);
      expect(await sender.send(request)).toEqual(receipts[0]);
      expect((await owner.list()).messages).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("refuses unsigned calls, sender spoofing, recipient overrides, and altered signed bodies", async () => {
    const f = await fixture();
    try {
      const unsigned = await fetch(`${f.host}/api/inbox/enable`, {
        method: "POST",
        body: "{}",
      });
      expect(unsigned.status).toBe(401);
      await unsigned.body?.cancel();
      for (
        const [operation, body] of [
          ["send", {
            recipientDid: f.owner.did(),
            senderDid: f.owner.did(),
            operationId: "spoof",
            payload: {},
          }],
          ["enable", { recipientDid: f.owner.did() }],
          ["list", { recipientDid: f.owner.did() }],
          ["acknowledge", {
            recipientDid: f.owner.did(),
            senderDid: f.sender.did(),
            operationId: "spoof",
          }],
        ] as const
      ) {
        const url = new URL(`/api/inbox/${operation}`, f.host),
          text = JSON.stringify(body);
        const headers = await signFirstPartyHttpRequest({
          url,
          method: "POST",
          body: text,
          signer: f.stranger,
        });
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: text,
        });
        expect(response.status).toBe(400);
        await response.body?.cancel();
      }
      const url = new URL("/api/inbox/status", f.host);
      const headers = await signFirstPartyHttpRequest({
        url,
        method: "POST",
        body: JSON.stringify({ recipientDid: f.owner.did() }),
        signer: f.sender,
      });
      const altered = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ recipientDid: f.stranger.did() }),
      });
      expect(altered.status).toBe(401);
      await altered.body?.cancel();
      expect((await f.client(f.owner).status(f.owner.did())).enabled).toBe(
        false,
      );
      const preflight = await fetch(url, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "CF-Request-Proof",
        },
      });
      expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
      await preflight.body?.cancel();
    } finally {
      await f.close();
    }
  });
  it("logs the configured authority when it refuses a proof", async () => {
    const f = await fixture("https://public.example");
    try {
      const url = new URL("/api/inbox/enable", f.host);
      const headers = await signFirstPartyHttpRequest({
        url,
        method: "POST",
        body: "{}",
        signer: f.owner,
      });
      const refused = await fetch(url, { method: "POST", headers, body: "{}" });
      expect(refused.status).toBe(401);
      await refused.body?.cancel();
      expect(f.diagnostics).toHaveLength(1);
      expect(f.diagnostics[0]).toMatchObject({
        path: "/api/inbox/enable",
        method: "POST",
        authority: "https://public.example",
        error: "Invalid signature",
        msg: "Rejected unauthenticated first-party HTTP request",
      });
      const logged = JSON.stringify(f.diagnostics);
      const signed = [...headers].filter(([name]) =>
        name.startsWith("cf-request-")
      );
      expect(signed.map(([name]) => name).sort()).toEqual([
        "cf-request-auth",
        "cf-request-body-sha256",
        "cf-request-proof",
      ]);
      for (const [, value] of signed) expect(logged).not.toContain(value);
    } finally {
      await f.close();
    }
  });
  it("recovers a committed delivery after the response is lost without restoring acknowledged payload", async () => {
    const f = await fixture();
    try {
      await f.client(f.owner).enable();
      let dropped = false;
      const sender = new InboxClient({
        host: f.host,
        signer: f.sender,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          await response.body?.cancel();
          dropped = true;
          throw new Error("lost transport");
        },
      });
      const request = {
        recipientDid: f.owner.did(),
        operationId: "uncertain",
        payload: { text: "secret" },
      };
      await expect(sender.send(request)).rejects.toThrow("outcome-unknown");
      expect(dropped).toBe(true);
      const original = (await f.client(f.owner).list()).messages[0].receipt;
      await f.client(f.owner).acknowledge({
        senderDid: f.sender.did(),
        operationId: request.operationId,
      });
      f.reopen();
      expect(await f.client(f.sender).send(request)).toEqual(original);
      expect((await f.client(f.owner).list()).messages).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("retains an acknowledged HTTP commit after abrupt service termination", async () => {
    const directory = await Deno.makeTempDir();
    let process: Awaited<ReturnType<typeof startInboxProcess>> | undefined;
    try {
      process = await startInboxProcess(directory);
      const { host } = process;
      const owner = await Identity.fromPassphrase("crash-inbox-owner");
      const sender = await Identity.fromPassphrase("crash-inbox-sender");
      await new InboxClient({ host, signer: owner }).enable();
      const request = {
        recipientDid: owner.did(),
        operationId: "before-crash",
        payload: { text: "durable" },
      };
      const receipt = await new InboxClient({ host, signer: sender }).send(
        request,
      );
      await process.close();
      const reopened = new InboxStore(`${directory}/inbox.sqlite`);
      try {
        expect(
          reopened.get(owner.did(), {
            senderDid: sender.did(),
            operationId: request.operationId,
          }).message,
        ).toEqual({ receipt, payload: request.payload });
        expect(reopened.send(sender.did(), request)).toEqual(receipt);
        expect(reopened.list(owner.did()).messages.length).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      await process?.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
  it("deduplicates concurrent deliveries across independent service processes", async () => {
    const directory = await Deno.makeTempDir();
    const processes: Array<Awaited<ReturnType<typeof startInboxProcess>>> = [];
    try {
      processes.push(await startInboxProcess(directory));
      processes.push(await startInboxProcess(directory));
      const recipient = await Identity.fromPassphrase("process-recipient");
      const sender = await Identity.fromPassphrase("process-sender");
      const owner = new InboxClient({
        host: processes[0].host,
        signer: recipient,
      });
      const clients = processes.map((process) =>
        new InboxClient({ host: process.host, signer: sender })
      );
      await owner.enable();
      for (let i = 0; i < 10; i++) {
        const request = {
          recipientDid: recipient.did(),
          operationId: `race-${i}`,
          payload: { i },
        };
        const receipts = await Promise.all(
          clients.map((client) => client.send(request)),
        );
        expect(receipts[0]).toEqual(receipts[1]);
      }
      expect((await owner.list()).messages.length).toBe(10);
    } finally {
      for (const process of processes) await process.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
  it("initializes one fresh database from simultaneous independent service processes", async () => {
    const directory = await Deno.makeTempDir();
    const processes: Array<Awaited<ReturnType<typeof startInboxProcess>>> = [];
    const released = Promise.withResolvers<void>();
    let waiting = 0;
    const initialize = async () => {
      if (++waiting === 2) released.resolve();
      await released.promise;
    };
    try {
      const started = await Promise.allSettled([0, 1].map(async () => {
        try {
          const process = await startInboxProcess(directory, initialize);
          processes.push(process);
        } catch (error) {
          released.resolve();
          throw error;
        }
      }));
      expect(started.every((result) => result.status === "fulfilled")).toBe(
        true,
      );
      const recipient = await Identity.fromPassphrase("simultaneous-startup");
      const clients = processes.map(({ host }) =>
        new InboxClient({ host, signer: recipient })
      );
      await clients[0].enable();
      expect((await clients[1].status(recipient.did())).enabled).toBe(true);
      const receipt = await clients[1].send({
        recipientDid: recipient.did(),
        operationId: "startup",
        payload: "durable",
      });
      expect((await clients[0].list()).messages[0].receipt).toEqual(receipt);
    } finally {
      released.resolve();
      for (const process of processes) await process.close();
      await Deno.remove(directory, { recursive: true });
    }
  });
  it("hashes the JSON value delivered on the wire for negative zero and sparse arrays", async () => {
    const f = await fixture();
    try {
      const owner = f.client(f.owner), sender = f.client(f.sender);
      await owner.enable();
      for (
        const [operationId, payload] of [["negative-zero", -0], [
          "sparse-array",
          Array<number>(1),
        ]] as const
      ) {
        const receipt = await sender.send({
          recipientDid: f.owner.did(),
          operationId,
          payload,
        });
        const value =
          (await owner.get({ senderDid: f.sender.did(), operationId })).message;
        expect(value?.receipt).toEqual(receipt);
        expect(value?.payload).toEqual(JSON.parse(JSON.stringify(payload)));
      }
      const url = new URL("/api/inbox/send", f.host);
      const body =
        `{"recipientDid":"${f.owner.did()}","operationId":"raw-negative","payload":-0}`;
      const headers = await signFirstPartyHttpRequest({
        url,
        method: "POST",
        body,
        signer: f.sender,
      });
      const response = await fetch(url, { method: "POST", body, headers });
      expect(response.status).toBe(200);
      await response.body?.cancel();
      const all = await owner.list();
      expect(all.messages.length).toBe(3);
      expect(all.messages[2].payload).toBe(0);
    } finally {
      await f.close();
    }
  });
});
