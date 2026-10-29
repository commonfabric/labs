// State-inspector remote dump endpoint — read-only SQLite snapshots for the
// `cf inspect --remote` offline-autopsy workflow.
//
// Security model (lowest-friction, highest-value; see env.ts MEMORY_DUMP_*):
//   1. Perimeter   — staging is reachable only on the Tailscale tailnet, so the
//                    network boundary already provides per-person identity.
//   2. Opt-in      — disabled unless MEMORY_DUMP_ENABLED (staging only); it
//                    hard-refuses to mount under ENV=production with no override.
//                    When disabled the routes 404 as if they never existed.
//   3. App gate    — every request must carry a valid CF1 first-party signature
//                    (reuses @commonfabric/runner/toolshed-http-auth) from a DID
//                    on the allowlist (MEMORY_DUMP_DIDS ∪ MEMORY_SERVICE_DIDS).
//   4. Audit       — every served dump is logged with who/which-space/size.
//
// A dump is the ENTIRE contents of a space, so this is intentionally narrow.

import type { MiddlewareHandler } from "@hono/hono";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import {
  listSpaceStores,
  snapshotSpaceStore,
  spaceStorePath,
} from "@commonfabric/memory/v2/dump";
import { createRouter } from "@/lib/create-app.ts";
import type { AppBindings } from "@/lib/types.ts";
import env from "@/env.ts";
import { memoryEngineStoreUrl } from "@/routes/storage/memory-store-url.ts";
import { dumpAllowSet, isDumpEnabled } from "./memory-dump-policy.ts";

const DUMP_BASE = "/api/storage/memory/dump";

const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const dumpEndpointEnabled = (): boolean =>
  isDumpEnabled({ enabled: env.MEMORY_DUMP_ENABLED, env: env.ENV });

const dumpAllowlist = (): Set<string> =>
  dumpAllowSet({
    dumpDids: env.MEMORY_DUMP_DIDS,
    serviceDids: env.MEMORY_SERVICE_DIDS,
  });

const requireDumpAccess: MiddlewareHandler<AppBindings> = async (c, next) => {
  // Disabled => indistinguishable from "no such route".
  if (!dumpEndpointEnabled()) return c.notFound();

  let userDid: string;
  try {
    ({ userDid } = await verifyFirstPartyHttpRequest({ request: c.req.raw }));
  } catch (error) {
    c.get("logger").warn(
      { path: c.req.path, method: c.req.method, error: errMessage(error) },
      "memory dump: rejected unauthenticated request",
    );
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (!dumpAllowlist().has(userDid)) {
    c.get("logger").warn(
      { path: c.req.path, userDid },
      "memory dump: rejected DID not on allowlist",
    );
    return c.json({ error: "Forbidden" }, 403);
  }

  c.set("verifiedUserDid", userDid);
  await next();
};

const router = createRouter();

router.use(DUMP_BASE, requireDumpAccess);
router.use(`${DUMP_BASE}/*`, requireDumpAccess);

// List the spaces available to dump (canonical DIDs + size/mtime).
router.get(DUMP_BASE, (c) => {
  return c.json({ spaces: listSpaceStores(memoryEngineStoreUrl) });
});

// Download a crash-consistent snapshot of one space's SQLite store.
//
// NOTE (staging-only scope): there is deliberately no size or concurrency cap.
// Each request does a full `VACUUM INTO` copy into a temp dir, so a multi-GB
// space or several concurrent dumps means real disk + CPU pressure with nothing
// throttling it. Acceptable behind the tailnet perimeter with an allowlisted
// caller; a concurrency guard (and possibly a size cap) is a prerequisite before
// this is ever made more broadly available.
router.get(`${DUMP_BASE}/:space`, async (c) => {
  const space = c.req.param("space");
  const userDid = c.get("verifiedUserDid");
  const source = spaceStorePath(memoryEngineStoreUrl, space);
  if (!source) return c.json({ error: "space not found" }, 404);

  // `VACUUM INTO` requires a destination path that does not yet exist, so we
  // snapshot into a fresh temp directory (not a pre-created temp file).
  const tmpDir = await Deno.makeTempDir({ prefix: "cf-dump-" });
  const snapshot = `${tmpDir}/space.sqlite`;
  try {
    snapshotSpaceStore(source, snapshot);
  } catch (error) {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    c.get("logger").error(
      { space, error: errMessage(error) },
      "memory dump: snapshot failed",
    );
    return c.json({ error: "snapshot failed" }, 500);
  }

  // POSIX unlink-after-open: removing the file keeps its data alive via the open
  // fd until the response stream finishes, then the OS reclaims it. This streams
  // the (potentially large) snapshot without buffering it in memory and needs no
  // post-response cleanup hook. A failure between VACUUM and the unlink must
  // still clean the temp dir, or failed downloads leak full snapshots in /tmp.
  let file: Deno.FsFile;
  let size: number;
  try {
    file = await Deno.open(snapshot, { read: true });
    try {
      ({ size } = await file.stat());
    } catch (error) {
      file.close();
      throw error;
    }
  } catch (error) {
    c.get("logger").error(
      { space, error: errMessage(error) },
      "memory dump: could not serve snapshot",
    );
    return c.json({ error: "snapshot failed" }, 500);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }

  c.get("logger").info(
    { space, userDid, sizeBytes: size },
    "memory dump served",
  );

  return new Response(file.readable, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${
        encodeURIComponent(space)
      }.sqlite"`,
    },
  });
});

export default router;
