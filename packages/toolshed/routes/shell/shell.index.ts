import { exists } from "@std/fs";
import * as path from "@std/path";

import ports from "@commonfabric/ports" with { type: "json" };
import { cors } from "@hono/hono/cors";

import {
  type DeploymentMetaContent,
  shellFlagsFromDeclared,
} from "@commonfabric/runner/deployment-meta";

import env from "@/env.ts";
import { buildInfo } from "@/lib/build-info.ts";
import { createRouter } from "@/lib/create-app.ts";
import { experimentalPosture } from "@/lib/experimental-posture.ts";
import {
  createShellStaticRouter,
  loadShellIndex,
  type ShellStaticDeps,
  StaticResponse,
} from "@/routes/shell/shell-static.ts";

export { createShellStaticRouter, StaticResponse };

/**
 * What this toolshed's page tells the shell about its deployment: the memory
 * URL its clients open Memory on (`MEMORY_PUBLIC_URL`), `null` where the
 * deployment has none, and the flags the shell takes from its deployment
 * (`SHELL_DEPLOYMENT_FLAGS`), out of the posture `posture` gives, which is
 * what `/api/meta` publishes as `experimental`: `null` until a Runtime
 * exists, and otherwise only the flags of the list that posture resolved,
 * taken by the rule the shell reads them with (`shellFlagsFromDeclared`).
 * The two surfaces publish one value because they read one posture.
 */
export function shellDeploymentPage(
  environment: Pick<typeof env, "MEMORY_PUBLIC_URL">,
  posture: Record<string, boolean> | null,
): DeploymentMetaContent {
  return {
    memoryUrl: environment.MEMORY_PUBLIC_URL ?? null,
    experimental: posture === null ? null : shellFlagsFromDeclared(posture),
  };
}

/**
 * The router a compiled toolshed serves its shell with: the immutable build
 * namespace, and the page built once, carrying what the shell takes from the
 * deployment ({@link shellDeploymentPage}). The page is built on the first
 * request for it, since the Runtime whose posture it carries is constructed
 * after the routes are (`loadShellIndex`).
 *
 * @throws If the bundle's `index.html` cannot carry the element, which
 * refuses startup.
 */
export async function compiledShellRouter(
  staticRoot: string,
  environment: Pick<typeof env, "ENV" | "MEMORY_PUBLIC_URL">,
  commitSha: string | null | undefined,
  deps?: ShellStaticDeps,
  /** The posture `/api/meta` publishes; a seam for tests. */
  posture: () => Record<string, boolean> | null = experimentalPosture,
) {
  return createShellStaticRouter(staticRoot, {
    // build-binaries uses the mode name when no commit SHA was supplied;
    // mirror that fallback so locally compiled binaries retain a working
    // default worker URL too.
    immutableBuildId: commitSha ??
      (environment.ENV === "production" ? "production" : "development"),
    index: await loadShellIndex(
      staticRoot,
      () => shellDeploymentPage(environment, posture()),
      deps,
    ),
    ...(deps !== undefined ? { deps } : {}),
  });
}

const router = createRouter();

router.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "OPTIONS"],
  }),
);

// Keep the served shell document NON-cross-origin-isolated.
//
// The shell hosts untrusted user programs ("patterns") inside this same page,
// sandboxed with SES. A core Spectre-class defense is that pattern code cannot
// build a high-resolution timer: SharedArrayBuffer / Atomics and an un-clamped
// performance.now() are unavailable. In a browser those primitives are gated
// behind `crossOriginIsolated === true`, which a page only earns when it is
// served with both `Cross-Origin-Opener-Policy: same-origin` AND
// `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
//
// We deliberately serve neither isolating combination so `crossOriginIsolated`
// stays false. This is defense-in-depth on top of the SES taming: even if that
// taming ever regressed, a non-isolated page still hands patterns no parallel
// counter and no fine clock. We accept forgoing browser-process isolation
// against cross-origin Spectre because our threat is untrusted code inside our
// own origin, not other origins attacking us.
//
// COOP is set to the non-isolating `same-origin-allow-popups`, and COEP is
// pinned to `unsafe-none`. These run after the handler so they override any
// header an upstream change might set. See
// docs/specs/sandboxing/cross-origin-isolation.md.
router.use("/*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  c.header("Cross-Origin-Embedder-Policy", "unsafe-none");
});

const dirname = import.meta?.dirname;
if (!dirname) {
  throw new Error("File does not have dirname in toolshed.");
}
const projectRoot = path.join(dirname, "..", "..");
const shellStaticRoot = path.join(
  projectRoot,
  env.ENV === "production" ? "shell-frontend" : "shell-frontend-dev",
);
const COMPILED = await exists(path.join(projectRoot, "COMPILED"));
const SHELL_URL = Deno.env.get("SHELL_URL");

if (COMPILED) {
  // Production mode - serve static files
  router.route(
    "/",
    await compiledShellRouter(shellStaticRoot, env, buildInfo.commitSha),
  );
} else if (SHELL_URL) {
  // Development mode with proxy

  // Handle root-level resources that shell app requests
  router.get("/DEV_SOCKET.js", async (_) => {
    return await fetch(`${SHELL_URL}/DEV_SOCKET.js`);
  });

  router.get("/scripts/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/styles/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/assets/*", async (c) => {
    return await fetch(`${SHELL_URL}${c.req.path}`);
  });

  router.get("/*", async (c) => {
    const reqPath = c.req.path || "/";
    const targetUrl = `${SHELL_URL}${reqPath}`;

    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers: c.req.header(),
      });

      return response;
    } catch (_) {
      return c.text(
        `Failed to proxy to ${targetUrl}. Is the shell dev server running?`,
        502,
      );
    }
  });
} else {
  // Development mode without proxy
  router.get("/*", (c) => {
    return c.text(
      `Shell app not available. Set SHELL_URL=http://localhost:${ports.shell} or run the compiled binary`,
      404,
    );
  });
}

export default router;
