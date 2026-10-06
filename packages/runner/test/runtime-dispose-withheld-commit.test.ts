import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import type { SessionFactory } from "../src/storage/v2.ts";
import {
  newSharedServer,
  testPrincipalSessionOpenAuthFactory,
  TestStorageManager,
} from "./memory-v2-test-utils.ts";

// A session whose transport delivers the handshake, reads and watches normally
// but, once `withhold` is set, silently swallows every `transact` (commit) send
// so its response never arrives. This mirrors the integration flake: a commit
// whose server-side processing is withheld past dispose — the server holding
// the commit while a gated read it depends on never arrives — so the commit
// promise never settles on its own.
class WithheldCommitSessionFactory implements SessionFactory {
  withhold = false;
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }
  async create(id: string, signer?: Signer) {
    const base = MemoryV2Client.loopback(this.#server);
    const transport: MemoryV2Client.Transport = {
      send: (payload: string) =>
        this.withhold && payload.includes('"transact"')
          ? Promise.resolve()
          : base.send(payload),
      close: () => base.close(),
      setReceiver: (r) => base.setReceiver(r),
      setCloseReceiver: (r) => base.setCloseReceiver?.(r),
    };
    const client = await MemoryV2Client.connect({ transport });
    const session = await client.mount(
      id as MemorySpace,
      {},
      testPrincipalSessionOpenAuthFactory(signer),
    );
    return { client, session };
  }
}

function makeServer(): MemoryV2Server.Server {
  return newSharedServer();
}

Deno.test("runtime.dispose() resolves while a commit is withheld in flight", async () => {
  // runtime.dispose() tears down storage as part of shutdown, and teardown
  // rejects in-flight commits the way it already rejects in-flight reads,
  // rather than awaiting a confirmation that may never arrive. A commit whose
  // response is withheld past dispose never confirms on its own, so a teardown
  // that flushed before closing the client that settles them would wait for
  // this one forever.

  const signer = await Identity.fromPassphrase(
    "runtime-dispose-withheld-commit",
  );
  const factory = new WithheldCommitSessionFactory(makeServer());
  const storageManager = TestStorageManager.create(
    { as: signer, memoryHost: new URL("memory://") },
    factory,
  );
  const runtime = new Runtime({ apiUrl: new URL("memory://"), storageManager });

  const cell = runtime.getCell<{ value: number }>(
    signer.did(),
    "runtime-dispose-withheld-commit",
    { type: "object", properties: { value: { type: "number" } } } as const,
  );

  // From now on, any commit's transport response is withheld.
  factory.withhold = true;
  // Fire-and-forget write: its commit reaches the transport but never confirms,
  // so a commit promise is in flight when we dispose. Teardown cancels it, so
  // tolerate the cancellation.
  const writeTx = runtime.edit();
  cell.withTx(writeTx).set({ value: 1 });
  writeTx.commit().settled.catch(() => {});
  await clock.settle();
  // Guard the precondition: if the commit is not actually in flight, dispose
  // would not exercise the deadlock and the test would pass vacuously.
  assertEquals(storageManager.hasPendingCommits(), true);

  // dispose() must resolve without waiting on the withheld commit. A dispose
  // that blocked on the in-flight commit would time out here.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    runtime.dispose().then(() => "disposed" as const),
    new Promise<"timed-out">((resolve) => {
      timeout = setTimeout(() => resolve("timed-out"), 5000);
      Deno.unrefTimer(timeout);
    }),
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });

  assertEquals(result, "disposed");
});
