/**
 * Drives `StorageManager.serverFlags()` against a memory server with and
 * without server execution attached. The case that matters is the second: an
 * `ExecutorHost` serves a space as soon as a session opens on it, and starts by
 * ensuring the space's root, so reading the flags must open no session there.
 * A real session opened afterward is the control, showing the host would have
 * served the space and ensured its root had one been opened.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { ExecutorHost } from "../src/executor/host.ts";
import {
  HOME_PATTERN_SOURCE,
  resolveSpaceRootPattern,
} from "../src/ensure-space-root.ts";
import {
  ACLManager,
  getPatternSource,
  resolveEntryIdentity,
} from "../src/index.ts";
import { Runtime, type RuntimeFetch } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { awaitReplica } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("server flags space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase("server flags service");
const readerSigner = await Identity.fromPassphrase("server flags reader");

/** The Home root the host's ensure creates, served at the system route. */
const HOME_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern(() => ({ marker: 'home' }));",
  "",
].join("\n");
const HOME_PATH = "/api/patterns/system/home.tsx";

const fetchStub: RuntimeFetch = (input) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url,
  );
  if (url.pathname !== HOME_PATH) {
    return Promise.resolve(new Response("not found", { status: 404 }));
  }
  return url.searchParams.has("identity")
    ? resolveEntryIdentity(HOME_PATH, () => Promise.resolve(HOME_SOURCE))
      .then((identity) => new Response(identity))
    : Promise.resolve(new Response(HOME_SOURCE));
};

describe("StorageManager.serverFlags()", () => {
  let server: MemoryV2Server.Server;
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /** A manager of `as`'s own over the test's server. */
  const managerAs = (as: Identity) => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    cleanups.push(() => manager.close());
    return manager;
  };

  /** A client runtime of `as`'s own over the test's server. */
  const runtimeAs = (as: Identity) => {
    const manager = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: manager,
      fetch: fetchStub,
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    return runtime;
  };

  it("returns `serverExecution: false` from a server with no server execution attached", async () => {
    const flags = await managerAs(readerSigner).serverFlags(space);
    expect(flags?.serverExecution).toBe(false);
  });

  it("returns `serverExecution: true` from a served store without opening a session on the space", async () => {
    // The space has an owner and no root, so the first session opened on it
    // has the host serve it and ensure its root.
    const writer = runtimeAs(spaceSigner);
    await new ACLManager(writer, space as never).set(space as never, "OWNER");
    await writer.idle();
    await writer.storageManager.synced();
    await writer.dispose();

    // Every space a session opens on, as the host is told of it.
    const opened: string[] = [];
    const install = server.setServerExecutionObserver.bind(server);
    server.setServerExecutionObserver = (
      observer: MemoryV2Server.ServerExecutionObserver | undefined,
    ) =>
      install(
        observer === undefined ? undefined : {
          ...observer,
          sessionOpened: (opening) => {
            opened.push(opening);
            observer.sessionOpened?.(opening);
          },
        },
      );
    const host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: serviceSigner,
        });
        const runtime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager: manager,
          fetch: fetchStub,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 2_000, idleParkMs: 600_000 },
    });
    cleanups.push(() => host.close());

    const flags = await managerAs(readerSigner).serverFlags(space);
    expect(flags?.serverExecution).toBe(true);
    expect(opened).toEqual([]);
    expect(host.stats().rootEnsure.runs).toBe(0);

    // The control: a session opened on the space is served, and its root is
    // ensured. The root itself is the witness, not `rootEnsure.created`:
    // the test clock can fire the ensure's deadline while its program
    // resolution awaits work no timer stands for, counting the attempt as
    // failed while the detached work goes on to create the root.
    const reader = runtimeAs(readerSigner);
    let root: Awaited<ReturnType<typeof resolveSpaceRootPattern>>;
    await awaitReplica(reader.storageManager, async () => {
      root = await resolveSpaceRootPattern(reader, space);
      return root !== undefined;
    });
    expect(opened).toContain(space);
    expect(getPatternSource(root!)).toBe(HOME_PATTERN_SOURCE);
  });
});
