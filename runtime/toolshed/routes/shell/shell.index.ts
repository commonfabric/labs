import * as path from "@std/path";

import ports from "@commonfabric/ports" with { type: "json" };
import { cors } from "@hono/hono/cors";

import {
  type DeploymentMetaContent,
  shellFlagsFromDeclared,
} from "@commonfabric/runner/deployment-meta";

import env from "@/env.ts";
import { buildInfo, compiled, shellBuildId } from "@/lib/build-info.ts";
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
    immutableBuildId: shellBuildId(commitSha, environment.ENV),
    index: await loadShellIndex(
      staticRoot,
      () => shellDeploymentPage(environment, posture()),
      deps,
    ),
    ...(deps !== undefined ? { deps } : {}),
  });
}

/**
 * Where a compiled toolshed's shell bundle sits: the production build in a
 * production deployment, and the development build in any other.
 */
export function compiledShellRoot(environment: Pick<typeof env, "ENV">) {
  return path.fromFileUrl(
    new URL(
      environment.ENV === "production"
        ? "../../shell-frontend"
        : "../../shell-frontend-dev",
      import.meta.url,
    ),
  );
}

/**
 * The router serving the shell's pages: the bundle `compiledRouter` builds in
 * a compiled toolshed; otherwise the shell's dev server at `shellUrl`, reached
 * through `fetch`, when one is named; and otherwise a 404 saying how to bring
 * the shell up.
 */
export async function shellFrontendRouter(
  { compiled, shellUrl, compiledRouter, fetch = globalThis.fetch }: {
    compiled: boolean;
    shellUrl: string | undefined;
    compiledRouter: () => ReturnType<typeof compiledShellRouter>;
    fetch?: typeof globalThis.fetch;
  },
) {
  if (compiled) {
    return await compiledRouter();
  }
  const router = createRouter();
  if (!shellUrl) {
    router.get("/*", (c) =>
      c.text(
        `Shell app not available. Set SHELL_URL=http://localhost:${ports.shell} or run the compiled binary`,
        404,
      ));
    return router;
  }
  // Root-level resources the shell app requests.
  for (
    const resource of ["/DEV_SOCKET.js", "/scripts/*", "/styles/*", "/assets/*"]
  ) {
    router.get(resource, (c) => fetch(`${shellUrl}${c.req.path}`));
  }
  router.get("/*", async (c) => {
    const targetUrl = `${shellUrl}${c.req.path || "/"}`;
    try {
      return await fetch(targetUrl, {
        method: c.req.method,
        headers: c.req.header(),
      });
    } catch (_) {
      return c.text(
        `Failed to proxy to ${targetUrl}. Is the shell dev server running?`,
        502,
      );
    }
  });
  return router;
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

router.route(
  "/",
  await shellFrontendRouter({
    compiled,
    shellUrl: Deno.env.get("SHELL_URL"),
    compiledRouter: () =>
      compiledShellRouter(compiledShellRoot(env), env, buildInfo.commitSha),
  }),
);

export default router;
