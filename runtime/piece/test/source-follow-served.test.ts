/**
 * A serving loop follows a piece's `system:` origin before its first start of
 * the piece in a tenure, where a client's open would.
 *
 * A writer creates a space root and a non-root piece from `system:` sources a
 * local patterns route serves, and leaves; the space parks idle. The route
 * then serves a second release, as a deployment does between the tenure that
 * parked and the one its restart begins. A client sends an event to the piece
 * without opening it, so the serving runtime activates the space, loads the
 * piece and runs the handler; the handler writes its release's marker, which
 * says which release ran. Which runtime follows the space root is
 * `source-follow-view-scoped.test.ts`'s subject, in runtime-client. Runs with
 * the serving loop on this thread and in a worker, as
 * `SERVER_EXECUTION_WORKER` puts it.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  getPatternIdentityRef,
  getPatternSource,
  type NormalizedFullLink,
  Runtime,
} from "@commonfabric/runner";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("source follow served");
const serviceSigner = await Identity.fromPassphrase(
  "source follow served service",
);

const ROOT_FILE = "system/default-app/default-app.tsx";
const PROBE_FILE = "system/probe/probe.tsx";
const PROBE_SOURCE = `system:${PROBE_FILE}`;

const rootRelease = (marker: string) =>
  [
    "import { pattern } from 'commonfabric';",
    `export default pattern<{ items?: string[] }>(({ items }) => ({ items, marker: "${marker}" }));`,
    "",
  ].join("\n");

const probeRelease = (marker: string) =>
  `/// <cts-enable />
import { handler, NAME, pattern, Writable } from "commonfabric";

const mark = handler<{ note: string }, { marks: Writable<string[]> }>(
  (event, { marks }) => {
    marks.set([...(marks.get() ?? []), "${marker}:" + event.note]);
  },
);

export default pattern<{ items?: string[] }>(() => {
  const marks = new Writable<string[]>([]).for("marks");
  return { [NAME]: "Probe", marks, mark: mark({ marks }) };
});
`;

describe("source-follow-served", () => {
  for (const worker of [false, true]) {
    describe(`with the serving loop ${worker ? "in a worker" : "in-process"}`, () => {
      let temporary: string;
      let route: PatternsRoute;
      let http: Deno.HttpServer<Deno.NetAddr>;
      let apiUrl: URL;
      let serving: ServingMemoryServer;
      let cleanups: Array<() => Promise<void>>;
      let parkWaiters: Array<{ space: MemorySpace; resolve: () => void }>;
      const identityRequests: string[] = [];

      /** Resolves when the serving loop next parks `space`. */
      const parkOf = (space: MemorySpace) =>
        new Promise<void>((resolve) => parkWaiters.push({ space, resolve }));

      const writeRelease = async (marker: string) => {
        const files = [
          [ROOT_FILE, rootRelease(marker)],
          [PROBE_FILE, probeRelease(marker)],
        ] as const;
        for (const [file, contents] of files) {
          const path = join(temporary, file);
          await Deno.mkdir(join(path, ".."), { recursive: true });
          await Deno.writeTextFile(path, contents);
        }
        // A route made afresh models a release replacing its source cache.
        route = new PatternsRoute(temporary);
      };

      /** A client runtime on the serving server, closed by `close`. */
      const openRuntime = (
        experimental: { serverExecution?: boolean } = {},
      ) => {
        const storageManager = EmulatedStorageManager.connectTo(
          serving.server,
          { as: signer },
        );
        const runtime = new Runtime({ apiUrl, storageManager, experimental });
        const close = async () => {
          await runtime.dispose();
          await storageManager.close();
        };
        return { runtime, close };
      };

      /** A client runtime closed when the test ends. */
      const runtimeFor = (
        experimental: { serverExecution?: boolean } = {},
      ) => {
        const opened = openRuntime(experimental);
        cleanups.push(opened.close);
        return opened.runtime;
      };

      /** The pattern the piece at `link` names, as a runtime opened now reads it. */
      const storedIdentity = async (link: NormalizedFullLink) => {
        const fresh = runtimeFor().getCellFromLink(link);
        await fresh.sync();
        return getPatternIdentityRef(fresh)?.identity;
      };

      beforeEach(async () => {
        cleanups = [];
        parkWaiters = [];
        temporary = await Deno.makeTempDir({ prefix: "source-follow-" });
        await writeRelease("v1");
        http = Deno.serve(
          { hostname: "127.0.0.1", port: 0, onListen() {} },
          async (request) => {
            const url = new URL(request.url);
            if (url.searchParams.has("identity")) {
              identityRequests.push(url.pathname);
            }
            return await route.serve(request) ??
              new Response("Not found", { status: 404 });
          },
        );
        apiUrl = new URL(`http://127.0.0.1:${http.addr.port}`);
        serving = await startServingMemoryServer({
          apiUrl,
          serviceIdentity: serviceSigner,
          ensureSpaceRoots: true,
          worker,
          // A space nobody demands parks as soon as its last client's
          // session has expired, so the release below falls between tenures;
          // a deployment's restart keeps no parked runtime, whose pieces
          // would still be running.
          policy: { idleParkMs: 1, parkedRuntimeRetentionMs: 0 },
          onSpaceParked: (parkedSpace) => {
            const waiting = parkWaiters.filter((w) => w.space === parkedSpace);
            parkWaiters = parkWaiters.filter((w) => w.space !== parkedSpace);
            for (const waiter of waiting) waiter.resolve();
          },
        });
      });

      afterEach(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        await serving?.close();
        await http?.shutdown();
        await Deno.remove(temporary, { recursive: true });
      });

      it("runs the release a non-root piece names after its origin moved", async () => {
        // The first release, created by a writer that does not run under
        // server execution.
        const { runtime: writer, close: closeWriter } = openRuntime();
        const space: MemorySpace = await writer.createSpace();
        const session = createSession({ identity: signer, spaceDid: space });
        const writerPieces = new PiecesController(session, writer);
        await writerPieces.synced();
        await writerPieces.ensureDefaultPattern();
        const program = await writer.harness.resolve(
          new HttpProgramResolver(
            new URL(`/api/patterns/${PROBE_FILE}`, apiUrl).href,
          ),
        );
        const pattern = await writer.patternManager.compilePattern(program, {
          space,
        });
        const probe = await writerPieces.runPersistent(pattern, {}, "probe", {
          origin: PROBE_SOURCE,
        });
        await writer.idle();
        await writer.storageManager.synced();
        expect(getPatternSource(probe)).toBe(PROBE_SOURCE);
        const probeV1 = getPatternIdentityRef(probe)?.identity;
        const probeLink = probe.getAsNormalizedFullLink();

        // The writer leaves, and the space parks with nobody demanding it.
        const parked = parkOf(space);
        await writerPieces.dispose();
        await closeWriter();
        await parked;

        // The second release.
        await writeRelease("v2");
        identityRequests.length = 0;

        // A client under server execution sends to the piece without opening
        // it, and reads what the served run of the handler wrote.
        const sender = new PiecesController(
          session,
          runtimeFor({ serverExecution: true }),
          { deferSpaceCellSync: true },
        );
        await sender.ready;
        const piece = await sender.get(probeLink.id);
        await piece.result.set({ note: "sent" }, ["mark"]);
        const marks = await piece.result.get(["marks"]);
        await serving.idle();

        const probeV2 = await route.identity(PROBE_FILE);
        expect(probeV2).not.toBe(probeV1);
        // The handler that ran is the second release's, and the piece now
        // names that release.
        expect(marks).toEqual(["v2:sent"]);
        expect(identityRequests).toContain(`/api/patterns/${PROBE_FILE}`);
        expect(await storedIdentity(probeLink)).toBe(probeV2);
      });
    });
  }
});
