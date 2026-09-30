import { expect } from "@std/expect";
import { join } from "@std/path/join";
import { toFileUrl } from "@std/path/to-file-url";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { Engine, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { createPatternsRoute } from "@/routes/patterns/patterns-server.ts";

/**
 * The load-bearing invariant of the `?identity` endpoint: the identity the
 * toolshed computes the *light* way (no compiler) must equal the
 * `patternIdentity` a worker stores when it compiles the same source over HTTP.
 * They agree only if both name modules by the same authored path — the
 * identity folds each module's path in — so this pins the toolshed to the
 * worker's URL-pathname naming against the REAL system patterns.
 */

const signer = await Identity.fromPassphrase("identity parity");

const patternsRoot = toFileUrl(
  join(import.meta.dirname!, "..", "..", "..", "patterns") + "/",
);

describe("?identity parity with a worker HTTP compile", () => {
  let server: Deno.HttpServer;
  let ac: AbortController;
  let host: string;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    ac = new AbortController();
    server = Deno.serve({ port: 0, signal: ac.signal }, async (req) => {
      const pathname = new URL(req.url).pathname;
      const rel = pathname.replace(/^\/api\/patterns\//, "");
      try {
        const buf = await Deno.readFile(new URL(rel, patternsRoot));
        return new Response(buf, {
          headers: { "content-type": "text/typescript-jsx" },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    });
    host = `http://localhost:${(server.addr as Deno.NetAddr).port}`;
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(host), storageManager });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
    ac.abort();
    await server.finished;
  });

  async function workerCompiledIdentity(
    filename: string,
    sourceRoots: readonly string[] = [],
  ): Promise<string> {
    const program = await runtime.harness.resolve(
      new HttpProgramResolver(
        new URL(`/api/patterns/${filename}`, host).href,
      ),
      { sourceRoots: sourceRoots.map((root) => `/api/patterns/${root}`) },
    );
    const { entryIdentity } = await (runtime.harness as Engine)
      .compileToRecordGraph(program);
    return entryIdentity;
  }

  it("default-app.tsx: endpoint identity == worker compile", async () => {
    const worker = await workerCompiledIdentity("system/default-app.tsx");
    const endpoint = await createPatternsRoute().identity(
      "system/default-app.tsx",
    );
    expect(endpoint).toBe(worker);
  });

  it("home.tsx: endpoint identity == worker compile", async () => {
    const worker = await workerCompiledIdentity("system/home.tsx");
    const endpoint = await createPatternsRoute().identity("system/home.tsx");
    expect(endpoint).toBe(worker);
  });

  it("identifies the shared loom with all four attached tests as the worker compiles it", async () => {
    // These are publicationRoot.sourceRoots in commonfabric/loom's
    // src/services/loom-daemon/shared-loom-runtime.ts.
    const roots = [
      "loom/main.test.tsx",
      "loom/presentation-refusals.test.tsx",
      "loom/multi-user.test.tsx",
      "loom/url-view.test.tsx",
    ];
    const worker = await workerCompiledIdentity("loom/main.tsx", roots);
    const endpoint = await createPatternsRoute().identity(
      "loom/main.tsx",
      roots,
    );
    expect(endpoint).toBe(worker);
  });

  // The surfaces the wish builtin instantiates record a `system:` origin and
  // are opened through the same route. A surface whose light identity differs
  // from what compiling its source produces is refused every time it opens, so
  // it belongs here beside the roots.
  it("profile-create.tsx: endpoint identity == worker compile", async () => {
    const worker = await workerCompiledIdentity("system/profile-create.tsx");
    const endpoint = await createPatternsRoute().identity(
      "system/profile-create.tsx",
    );
    expect(endpoint).toBe(worker);
  });

  it("profile-picker.tsx: endpoint identity == worker compile", async () => {
    const worker = await workerCompiledIdentity("system/profile-picker.tsx");
    const endpoint = await createPatternsRoute().identity(
      "system/profile-picker.tsx",
    );
    expect(endpoint).toBe(worker);
  });

  it("suggestion.tsx: endpoint identity == worker compile", async () => {
    const worker = await workerCompiledIdentity("system/suggestion.tsx");
    const endpoint = await createPatternsRoute().identity(
      "system/suggestion.tsx",
    );
    expect(endpoint).toBe(worker);
  });
});
