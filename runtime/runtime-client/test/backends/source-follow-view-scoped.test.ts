/**
 * Opening a piece the way the shell does follows the piece's `system:` origin
 * on an ordinary client, and leaves it to the serving runtime on a client
 * that replicates views under server execution.
 *
 * A writer creates a space root and a non-root piece from `system:` sources
 * a local patterns route serves, the route then serves a second release, and
 * a web reader opens both through the processor's handlers, as the shell
 * does: the root through `GetSpaceRootPattern`, the piece through `PieceGet`
 * with `runIt`. A fresh runtime then reads which pattern each one names.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSource,
  Runtime,
} from "@commonfabric/runner";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { RequestType } from "../../src/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const signer = await Identity.fromPassphrase("source follow view scoped");

const ROOT_FILE = "system/default-app/default-app.tsx";
const PROBE_FILE = "system/probe/probe.tsx";
const PROBE_SOURCE = `system:${PROBE_FILE}`;

const release = (marker: string) =>
  [
    "import { pattern } from 'commonfabric';",
    `export default pattern<{ items?: string[] }>(({ items }) => ({ items, marker: "${marker}" }));`,
    "",
  ].join("\n");

describe("runtime-processor", () => {
  for (const mode of ["ordinary", "view-scoped"] as const) {
    describe(`opening pieces with ${mode} replication`, () => {
      let temporary: string;
      let route: PatternsRoute;
      let http: Deno.HttpServer<Deno.NetAddr>;
      let apiUrl: URL;
      let server: ReturnType<typeof newLoopbackServer>;
      let writer: Runtime;
      let reader: Runtime;
      let space: MemorySpace;
      let root: Cell<unknown>;
      let probe: Cell<unknown>;
      let rootV1: string | undefined;
      let probeV1: string | undefined;
      const identityRequests: string[] = [];

      const writeRelease = async (marker: string) => {
        for (const file of [ROOT_FILE, PROBE_FILE]) {
          const path = join(temporary, file);
          await Deno.mkdir(join(path, ".."), { recursive: true });
          await Deno.writeTextFile(path, release(marker));
        }
        // A route made afresh models a release replacing its source cache.
        route = new PatternsRoute(temporary);
      };

      /** The pattern `cell` names, as a runtime opened now reads it. */
      const storedIdentity = async (cell: Cell<unknown>) => {
        const observer = new Runtime({
          apiUrl,
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
        });
        try {
          const fresh = observer.getCellFromLink(
            cell.getAsNormalizedFullLink(),
          );
          await fresh.sync();
          return getPatternIdentityRef(fresh)?.identity;
        } finally {
          await observer.dispose();
        }
      };

      beforeEach(async () => {
        setServerExecutionConfig(true);
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
        server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });

        // The first release, as a writer that does not replicate views
        // creates it.
        writer = new Runtime({
          apiUrl,
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
        });
        space = await writer.createSpace();
        const writerPieces = new PiecesController(
          createSession({ identity: signer, spaceDid: space }),
          writer,
        );
        await writerPieces.synced();
        root = (await writerPieces.ensureDefaultPattern()).getCell();
        const program = await writer.harness.resolve(
          new HttpProgramResolver(
            new URL(`/api/patterns/${PROBE_FILE}`, apiUrl).href,
          ),
        );
        const pattern = await writer.patternManager.compilePattern(program, {
          space,
        });
        probe = await writerPieces.runPersistent(pattern, {}, "probe", {
          origin: PROBE_SOURCE,
        });
        await writer.idle();
        await writer.storageManager.synced();
        expect(getPatternSource(probe)).toBe(PROBE_SOURCE);
        rootV1 = getPatternIdentityRef(root)?.identity;
        probeV1 = getPatternIdentityRef(probe)?.identity;
        expect(rootV1).toBeDefined();
        expect(probeV1).toBeDefined();

        // The second release.
        await writeRelease("v2");
        identityRequests.length = 0;

        reader = new Runtime({
          apiUrl,
          storageManager: EmulatedStorageManager.connectTo(server, {
            as: signer,
          }),
          clientClass: "web",
          experimental: {
            serverExecution: true,
            viewScopedReplication: mode === "view-scoped",
          },
        });
      });

      afterEach(async () => {
        await reader?.sourceReconciler.idle();
        await reader?.dispose();
        await writer?.dispose();
        await server?.close();
        await http?.shutdown();
        await Deno.remove(temporary, { recursive: true });
        resetServerExecutionConfig();
      });

      const processorFor = () =>
        buildProcessor({
          runtime: reader,
          cc: new PiecesController(
            createSession({ identity: signer, spaceDid: space }),
            reader,
          ),
          space,
          identity: signer,
        });

      it("follows a non-root piece's origin only where the client runs the piece", async () => {
        const processor = processorFor();
        await processor.handlePieceGet({
          type: RequestType.PieceGet,
          pieceId: probe.getAsNormalizedFullLink().id,
          runIt: true,
          space,
        });
        await reader.sourceReconciler.idle();
        await reader.storageManager.synced();

        const probeV2 = await route.identity(PROBE_FILE);
        const after = await storedIdentity(probe);
        if (mode === "ordinary") {
          expect(identityRequests).toContain(`/api/patterns/${PROBE_FILE}`);
          expect(after).toBe(probeV2);
        } else {
          expect(identityRequests).not.toContain(`/api/patterns/${PROBE_FILE}`);
          expect(after).toBe(probeV1);
        }
      });

      it("follows the space root's origin only where the client runs the root", async () => {
        const processor = processorFor();
        await processor.handleGetSpaceRootPattern({
          type: RequestType.GetSpaceRootPattern,
          space,
          start: true,
        });
        await reader.sourceReconciler.idle();
        await reader.storageManager.synced();

        const rootV2 = await route.identity(ROOT_FILE);
        const after = await storedIdentity(root);
        if (mode === "ordinary") {
          expect(identityRequests).toContain(`/api/patterns/${ROOT_FILE}`);
          expect(after).toBe(rootV2);
        } else {
          // The root, like any piece, is the serving runtime's to follow.
          expect(identityRequests).not.toContain(`/api/patterns/${ROOT_FILE}`);
          expect(after).toBe(rootV1);
        }
      });
    });
  }
});
