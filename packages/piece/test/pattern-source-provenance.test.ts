import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  getEntityId,
  getPatternIdentityRef,
  getPatternSource,
  resolveSystemPatternSource,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createSession, Identity } from "@commonfabric/identity";
import {
  DEFAULT_APP_PATTERN_SOURCE,
  deriveSystemPatternSource,
  HOME_PATTERN_SOURCE,
  PiecesController,
} from "../src/ops/pieces-controller.ts";

// The route the ref expands to: still what the module is NAMED, because the
// worker compiles this pattern over HTTP.
const DEFAULT_APP_PATTERN_PATH = resolveSystemPatternSource(
  DEFAULT_APP_PATTERN_SOURCE,
)!;

const signer = await Identity.fromPassphrase("pattern source provenance");

// A minimal, self-contained pattern the fetch stub serves as the "default app".
const DEFAULT_APP_SOURCE = [
  "import { pattern } from 'commonfabric';",
  "export default pattern<{ items: string[] }>(({ items }) => ({ items }));",
  "",
].join("\n");

/**
 * Override globalThis.fetch to serve pattern source from memory (no network, so
 * no --allow-net needed). HttpProgramResolver and runtime.fetch both route
 * through globalThis.fetch.
 */
function installFetchStub(
  sources: Record<string, string>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const source = sources[url.pathname];
    if (source === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.resolve(
      new Response(source, {
        headers: { "content-type": "text/typescript-jsx" },
      }),
    );
  }) as typeof globalThis.fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("deriveSystemPatternSource", () => {
  it("returns home.tsx for the home space, default-app.tsx otherwise", () => {
    const runtime = {
      userIdentityDID: "did:key:home",
    } as unknown as Runtime;
    expect(deriveSystemPatternSource("did:key:home" as never, runtime)).toBe(
      HOME_PATTERN_SOURCE,
    );
    expect(deriveSystemPatternSource("did:key:other" as never, runtime)).toBe(
      DEFAULT_APP_PATTERN_SOURCE,
    );
  });
});

describe("ensureDefaultPattern stamps patternSource", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let controller: PiecesController;
  let restoreFetch: () => void;

  beforeEach(async () => {
    restoreFetch = installFetchStub({
      "/api/patterns/system/default-app.tsx": DEFAULT_APP_SOURCE,
    });
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    controller = new PiecesController(session, runtime);
    await controller.synced();
  });

  afterEach(async () => {
    try {
      await controller?.dispose();
    } catch { /* already disposed */ }
    await storageManager?.close();
    restoreFetch();
  });

  it("OFF-arm witness (OW45 arm-B stage 1): the creation arm still runs on a plain client — root created, linked, and re-ensured", async () => {
    // No serverExecution flag anywhere in this fixture: this is the OFF
    // client, and its creation editWithRetry must still run — now
    // through the runner's shared ensure core (createSpaceRootIfAbsent),
    // which the stage-1 delegation must not have forked or gated. The
    // server half does not exist OFF (the toolshed OFF pin severs the
    // bootstrap), so a root appearing HERE is the client arm working.
    const piece = await controller.ensureDefaultPattern();
    expect(getPatternSource(piece.getCell())).toBe(DEFAULT_APP_PATTERN_SOURCE);
    const linked = await controller.getDefaultPattern(false);
    expect(getEntityId(linked!)).toEqual(getEntityId(piece.getCell()));
    // Idempotent: a second ensure resolves the SAME root (no second
    // creation, no re-link churn).
    const again = await controller.ensureDefaultPattern();
    expect(getEntityId(again.getCell())).toEqual(getEntityId(piece.getCell()));
  });

  it("stamps the default-app source ref on a non-home root", async () => {
    const piece = await controller.ensureDefaultPattern();
    const source = getPatternSource(piece.getCell());
    expect(source).toBe(DEFAULT_APP_PATTERN_SOURCE);
    const identityRef = getPatternIdentityRef(piece.getCell())!;
    expect(await piece.getPatternRef()).toEqual({
      ...identityRef,
      source: {
        ref: `cf:pattern:${identityRef.identity}`,
        entry: DEFAULT_APP_PATTERN_PATH,
        origin: DEFAULT_APP_PATTERN_SOURCE,
      },
    });
  });
});
