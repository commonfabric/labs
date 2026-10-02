/** Host-control regression tests use real client/router signatures and durable custody. */
// @ts-types="@types/ws"
import type WebSocket from "ws";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { sha256 } from "@commonfabric/content-hash";
import { getMemoryProtocolFlags } from "../v2.ts";
import { RoutedEpochStore } from "../v2/routed-epochs.ts";
import { RoutedMemoryHost } from "../v2/routed-host.ts";
import { routedFlags } from "../v2/routed-parser.ts";
import {
  readRoutedProof,
  RoutedReader,
  routedStatementPayload,
  RoutedWriter,
} from "../v2/routed-wire.ts";
import { Server } from "../v2/server.ts";

class Socket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  output: Uint8Array[] = [];
  changed = Promise.withResolvers<void>();
  send(bytes: string | Uint8Array) {
    this.output.push(
      typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
    );
    this.changed.resolve();
  }
  close() {
    if (this.readyState !== 3) {
      this.readyState = 3;
      this.changed.resolve();
      this.dispatchEvent(new Event("close"));
    }
  }
  receive(bytes: Uint8Array) {
    this.dispatchEvent(
      new MessageEvent("message", { data: bytes.slice().buffer }),
    );
  }
  async take(): Promise<Uint8Array> {
    while (!this.output.length) {
      assertEquals(this.readyState, 1);
      this.changed = Promise.withResolvers<void>();
      await this.changed.promise;
    }
    return this.output.shift()!;
  }
}
Deno.test("toolshed independently refuses context/epoch/proof replay and isolates router revocation", async () => {
  const root = Deno.makeTempDirSync(), now = Math.floor(Date.now() / 1000);
  const [toolshed, router, other, client, space] = await Promise.all(
    [91, 92, 93, 94, 95].map((seed) =>
      Identity.fromRaw(new Uint8Array(32).fill(seed))
    ),
  );
  const store = new RoutedEpochStore(`${root}/ledger`);
  const server = new Server({
    store: new URL("memory://routed-host-proof-custody"),
    acl: { mode: "enforce" },
    ownsSpace: (did) => did === space.did(),
    requireExplicitAcl: true,
    authorizeSessionOpen: undefined,
    sessionOpenAuth: undefined,
  });
  const host = new RoutedMemoryHost({
    server,
    identity: toolshed,
    deployment: "fixture",
    routers: new Map(
      [router, other].map((r) => [r.did(), new Set(["127.0.0.1"])]),
    ),
    ownership: (did) => did === space.did() ? 1 : undefined,
    epochs: store,
  });
  const flags = routedFlags({
    ...getMemoryProtocolFlags(),
    modernCellRep: true,
    connectionAuth: true,
    routedAuthV1: true,
  });
  async function link(identity: Identity, epoch: Uint8Array) {
    const socket = new Socket();
    host.accept(
      socket as unknown as WebSocket,
      "/memory/router-link",
      "127.0.0.1",
    );
    const hello = new RoutedReader((await socket.take()).slice(0, -64), "mlh1");
    assertEquals(hello.text(), toolshed.did());
    const nonce = hello.fixed(32);
    socket.receive(
      await new RoutedWriter("mlc1").text("fixture").text(identity.did()).text(
        toolshed.did(),
      ).fixed(epoch).fixed(nonce).sign(identity),
    );
    assertEquals(new TextDecoder().decode(await socket.take()), "mlo1");
    let sequence = 0;
    return {
      socket,
      request: async (op: number, payload: Uint8Array) => {
        socket.receive(
          new RoutedWriter("mlq1").time(++sequence).fixed(new Uint8Array([op]))
            .blob(payload).bytes,
        );
        const reply = new RoutedReader(await socket.take(), "mls1");
        assertEquals(reply.time(), sequence);
        const status = reply.fixed(1)[0], bytes = reply.blob();
        reply.end();
        return { status, bytes };
      },
    };
  }
  const epoch = new Uint8Array(16).fill(1),
    context = new Uint8Array(16).fill(2),
    challenge = new Uint8Array(32).fill(3);
  const statement = await routedStatementPayload({
    principal: client.did(),
    router: router.did(),
    deployment: "fixture",
    challenge,
    iat: now,
    exp: now + 600,
  }).sign(client);
  async function proof(ctx = context, ep = epoch) {
    const issuance = await new RoutedWriter("mrc1").text("fixture").text(
      router.did(),
    ).fixed(ep).fixed(ctx).fixed(challenge).time(now).time(now + 60).sign(
      router,
    );
    const receipt = await new RoutedWriter("mrr1").fixed(sha256(issuance)).text(
      client.did(),
    ).fixed(sha256(statement)).time(now).sign(router);
    return new RoutedWriter("mrp1").blob(statement).blob(issuance).blob(receipt)
      .bytes;
  }
  const admit = (ctx: Uint8Array, p: Uint8Array) =>
    new RoutedWriter("mvp1").fixed(ctx).blob(flags).blob(p).bytes;
  try {
    const first = await link(router, epoch),
      independent = await link(other, new Uint8Array(16).fill(8));
    const original = await proof();
    readRoutedProof(original);
    assertEquals((await first.request(6, admit(context, original))).status, 0);
    assertEquals((await first.request(6, admit(context, original))).status, 0);
    assertEquals(
      (await first.request(
        6,
        admit(
          new Uint8Array(16).fill(4),
          await proof(new Uint8Array(16).fill(4)),
        ),
      )).status,
      1,
    );
    assertEquals(first.socket.readyState, 1);
    assertEquals(
      (await first.request(
        4,
        new RoutedWriter("mrl1").fixed(context).text(client.did()).bytes,
      )).status,
      0,
    );
    assertEquals((await first.request(6, admit(context, original))).status, 1);
    const renewed = await link(router, new Uint8Array(16).fill(5));
    assertEquals(first.socket.readyState, 3);
    assertEquals(
      (await renewed.request(
        6,
        admit(context, await proof(context, new Uint8Array(16).fill(5))),
      )).status,
      1,
    );
    host.revokeRouter(router.did());
    assertEquals(renewed.socket.readyState, 3);
    assertEquals(independent.socket.readyState, 1);
    assertEquals(
      (await independent.request(6, admit(context, original))).status,
      1,
    );
    assert(independent.socket.readyState === 1);
    // Losing durable custody must close every context on the affected link,
    // including a different context from the one triggering the failed write.
    const contexts = [new Uint8Array(16).fill(31), new Uint8Array(16).fill(32)];
    for (const ctx of contexts) {
      const challenge = new Uint8Array(32).fill(ctx[0]);
      const statement = await routedStatementPayload({
        principal: client.did(),
        router: other.did(),
        deployment: "fixture",
        challenge,
        iat: now,
        exp: now + 600,
      }).sign(client);
      const issuance = await new RoutedWriter("mrc1").text("fixture").text(
        other.did(),
      )
        .fixed(new Uint8Array(16).fill(8)).fixed(ctx).fixed(challenge).time(now)
        .time(now + 60).sign(other);
      const receipt = await new RoutedWriter("mrr1").fixed(sha256(issuance))
        .text(client.did()).fixed(sha256(statement)).time(now).sign(other);
      const proof =
        new RoutedWriter("mrp1").blob(statement).blob(issuance).blob(receipt)
          .bytes;
      assertEquals((await independent.request(6, admit(ctx, proof))).status, 0);
    }
    store.close();
    await assertRejects(() => independent.request(3, contexts[0]));
    assertEquals(independent.socket.readyState, 3);
  } finally {
    host.close();
    await server.close();
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
