/**
 * Which of Home's spaces a release pass leaves open while Home runs: the home
 * space is the storage manager's own, and a profile space is one Home's own
 * actions read, so neither is released, while a space nothing reads is.
 */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  type MemorySpace,
  Runtime,
  type URI,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const owner = await Identity.fromPassphrase("space session release home");

const PATTERNS = fromFileUrl(new URL("../../../patterns/", import.meta.url));

describe("space-session-release-home", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let http: Deno.HttpServer<Deno.NetAddr>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let profileSpace: string;

  beforeAll(async () => {
    server = newLoopbackServer();
    const route = new PatternsRoute(PATTERNS);
    http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) =>
        await route.serve(request) ??
          new Response("Not found", { status: 404 }),
    );
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(`http://127.0.0.1:${http.addr.port}`),
      storageManager: storage,
    });
    const home = (await new PiecesController(
      createSession({ identity: owner, spaceDid: owner.did() }),
      runtime,
    ).ensureDefaultPattern()).getCell();
    await runtime.idle();
    await home.pull();
    const tx = runtime.edit();
    const click = {
      type: "click",
      target: { value: "Release owner" },
      provenance: reviewedActionProvenance("dom", {
        surface: "ProfileCreateSurface",
        action: "CreateProfile",
      }),
    };
    markRendererTrustedEvent(click);
    home.withTx(tx).key("createProfile").send(click);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    const profiles = await home.key("profiles").asSchema(
      { type: "array", items: { asCell: ["cell"] } } as const,
    ).pull() as Cell<unknown>[];
    profileSpace = profiles[0].resolveAsCell().space;
  });

  afterAll(async () => {
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
    await http?.shutdown();
  });

  it("keeps Home's space and its profile's space open, and releases a space nothing reads", async () => {
    // Another runtime of the owner's writes a document in a space of its
    // own, which this runtime then loads with nothing to read it.
    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: owner,
    });
    const writer = new Runtime({
      apiUrl: new URL(`http://127.0.0.1:${http.addr.port}`),
      storageManager: writerStorage,
    });
    let elsewhere: MemorySpace;
    let id: URI;
    try {
      elsewhere = await writer.createSpace();
      const write = writer.edit();
      const counter = writer.getCell(elsewhere, "counter", undefined, write);
      counter.set({ n: 1 });
      expect((await write.commit().settled).error).toBeUndefined();
      await writerStorage.synced();
      id = counter.getAsNormalizedFullLink().id as URI;
    } finally {
      await writer.dispose();
      await writerStorage.close();
    }
    expect(
      (await storage.open(elsewhere).sync(id, { path: [], schema: false }))
        .error,
    ).toBeUndefined();
    expect(storage.openedSpaces()).toContain(elsewhere);

    await runtime.releaseUnreadDocuments();
    await runtime.releaseUnreadDocuments();

    const opened = storage.openedSpaces();
    expect(profileSpace).not.toBe(owner.did());
    expect(opened).toContain(owner.did());
    expect(opened).toContain(profileSpace);
    expect(opened).not.toContain(elsewhere);
  });
});
