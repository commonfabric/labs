/**
 * A client that replicates views under server execution leaves a space's root
 * to the serving runtime, which creates it when the space is active, and sends
 * to Home without running Home itself.
 *
 * The serving runtimes and the client fetch patterns from two routes over the
 * same directory, so what the client fetched is the client's alone: a client
 * that compiled a root fetched its source.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { getPatternSource, Runtime } from "@commonfabric/runner";
import {
  type ListeningServingMemoryServer,
  listenServingMemoryServer,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("served space root");
const serviceSigner = await Identity.fromPassphrase(
  "served space root service",
);
const home = signer.did() as MemorySpace;

const HOME_FILE = "system/home/home.tsx";
const DEFAULT_APP_FILE = "system/default-app/default-app.tsx";

const HOME_SOURCE = `/// <cts-enable />
import { handler, NAME, pattern, Writable } from "commonfabric";

type SpaceEntry = { did: string; name: string };

const addSpace = handler<SpaceEntry, { spaces: Writable<SpaceEntry[]> }>(
  (entry, { spaces }) => {
    spaces.set([...(spaces.get() ?? []), entry]);
  },
);

export default pattern<Record<string, never>>(() => {
  const spaces = new Writable<SpaceEntry[]>([]).for("spaces");
  return { [NAME]: "Home", spaces, addSpace: addSpace({ spaces }) };
});
`;

const DEFAULT_APP_SOURCE = `import { pattern } from "commonfabric";
export default pattern<{ items?: string[] }>(({ items }) => ({ items }));
`;

describe("pieces-controller", () => {
  let temporary: string;
  let servers: Deno.HttpServer<Deno.NetAddr>[];
  let serving: ListeningServingMemoryServer;
  let clientApiUrl: URL;
  let clientRequests: string[];
  let cleanups: Array<() => Promise<void>>;

  /** What every answer of the serving runtimes' route waits for first. */
  let servingRouteOpen: Promise<void>;

  /**
   * Serves the patterns under `temporary`, recording each path into `log`, and
   * answering each request once `open()` resolves.
   */
  const serveRoute = (
    route: PatternsRoute,
    log?: string[],
    open: () => Promise<void> = () => Promise.resolve(),
  ): URL => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        log?.push(new URL(request.url).pathname);
        await open();
        return await route.serve(request) ??
          new Response("Not found", { status: 404 });
      },
    );
    servers.push(server);
    return new URL(`http://127.0.0.1:${server.addr.port}`);
  };

  /**
   * A runtime on the serving server over the network, closed when the test
   * ends, as a deployment's clients reach it: its first session in its own
   * Home writes that Home's access list. `web` makes it a browser's: a client
   * under server execution that replicates views.
   */
  const runtimeFor = (
    options: { apiUrl: URL; web?: boolean },
  ): Runtime => {
    const storageManager = StorageManager.open({
      as: signer,
      memoryHost: serving.url,
    });
    const runtime = new Runtime({
      apiUrl: options.apiUrl,
      storageManager,
      ...(options.web
        ? { clientClass: "web", experimental: { serverExecution: true } }
        : {}),
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await storageManager.close();
    });
    return runtime;
  };

  const controllerFor = async (
    runtime: Runtime,
    space: MemorySpace,
  ): Promise<PiecesController> => {
    const controller = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
    );
    cleanups.push(() => controller.dispose());
    await controller.synced();
    return controller;
  };

  beforeEach(async () => {
    servers = [];
    cleanups = [];
    clientRequests = [];
    temporary = await Deno.makeTempDir({ prefix: "served-space-root-" });
    for (
      const [file, contents] of [
        [HOME_FILE, HOME_SOURCE],
        [DEFAULT_APP_FILE, DEFAULT_APP_SOURCE],
      ]
    ) {
      const path = join(temporary, file);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, contents);
    }
    const route = new PatternsRoute(temporary);
    servingRouteOpen = Promise.resolve();
    const servingApiUrl = serveRoute(route, undefined, () => servingRouteOpen);
    clientApiUrl = serveRoute(route, clientRequests);
    serving = await listenServingMemoryServer({
      apiUrl: servingApiUrl,
      serviceIdentity: serviceSigner,
      ensureSpaceRoots: true,
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await serving?.close();
    for (const server of servers) await server.shutdown();
    await Deno.remove(temporary, { recursive: true });
  });

  describe("ensureDefaultPattern() on a client that replicates views", () => {
    it("resolves a new space's root from the serving runtime and fetches no root source", async () => {
      const client = runtimeFor({ apiUrl: clientApiUrl, web: true });
      const space = await client.createSpace();
      expect(await client.viewReplication.enable(space)).toBe(true);

      const root = await (await controllerFor(client, space))
        .ensureDefaultPattern();

      expect(getPatternSource(root.getCell())).toBe(
        `system:${DEFAULT_APP_FILE}`,
      );
      expect(clientRequests).not.toContain(`/api/patterns/${DEFAULT_APP_FILE}`);
    });

    it("resolves a root the serving runtime links after the client has synced the space", async () => {
      // The serving runtime cannot fetch the root's source until the client
      // has read the space with no root in it.
      const routeOpened = Promise.withResolvers<void>();
      servingRouteOpen = routeOpened.promise;
      const client = runtimeFor({ apiUrl: clientApiUrl, web: true });
      const space = await client.createSpace();
      expect(await client.viewReplication.enable(space)).toBe(true);
      const controller = await controllerFor(client, space);
      const ensured = controller.ensureDefaultPattern();
      await client.idle();
      await client.storageManager.synced();
      routeOpened.resolve();

      const root = await ensured;

      expect(getPatternSource(root.getCell())).toBe(
        `system:${DEFAULT_APP_FILE}`,
      );
    });

    it("resolves a new Home's root from the serving runtime and fetches no root source", async () => {
      const client = runtimeFor({ apiUrl: clientApiUrl, web: true });
      expect(await client.viewReplication.enable(home)).toBe(true);

      const root = await (await controllerFor(client, home))
        .ensureDefaultPattern();

      expect(getPatternSource(root.getCell())).toBe(`system:${HOME_FILE}`);
      expect(clientRequests).not.toContain(`/api/patterns/${HOME_FILE}`);
    });
  });

  describe("createSpace() on a client that replicates views", () => {
    it("records the new space in a Home the serving runtime creates for a new user", async () => {
      const client = runtimeFor({ apiUrl: clientApiUrl, web: true });
      const controller = await controllerFor(client, home);
      const space = await controller.createSpace("Garden");

      const homeRoot = (await controller.ensureDefaultPattern()).getCell();
      const observer = runtimeFor({ apiUrl: clientApiUrl });
      const spaces = observer.getCellFromLink(
        homeRoot.getAsNormalizedFullLink(),
      ).key("spaces");
      await spaces.sync();
      expect(spaces.get()).toEqual([{ did: space, name: "Garden" }]);
      expect(clientRequests).not.toContain(`/api/patterns/${HOME_FILE}`);
    });

    it("records the new space in Home without loading Home's pattern in the client", async () => {
      // Home exists before the client arrives, as it does for a returning
      // user.
      const writer = runtimeFor({ apiUrl: clientApiUrl });
      const homeRoot = (await (await controllerFor(writer, home))
        .ensureDefaultPattern()).getCell();
      await writer.idle();
      await writer.storageManager.synced();

      const client = runtimeFor({ apiUrl: clientApiUrl, web: true });
      const controller = await controllerFor(client, home);
      const loadsBefore = client.patternManager.getCompileCacheStats();
      const space = await controller.createSpace("Garden");

      // Running Home's handler here would have loaded Home's pattern, which
      // every route through the compile cache counts.
      expect(client.patternManager.getCompileCacheStats()).toEqual(
        loadsBefore,
      );
      // What Home recorded is durable by the time `createSpace()` returns, so
      // a runtime opened now reads it.
      const observer = runtimeFor({ apiUrl: clientApiUrl });
      const spaces = observer.getCellFromLink(
        homeRoot.getAsNormalizedFullLink(),
      ).key("spaces");
      await spaces.sync();
      expect(spaces.get()).toEqual([{ did: space, name: "Garden" }]);
    });
  });
});
