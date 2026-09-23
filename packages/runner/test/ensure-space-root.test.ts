// The space-root ensure core's pins (OW45 arm-B server-ensure stage 1;
// design PR #6209 §1/§2): existence at the runner level — creation with
// the OCC re-check, provenance stamping, and the per-attempt stamp hook.
// The serving SEAT (owed step,
// lease, counters, owner snapshot) is pinned in
// executor-space-root-ensure.test.ts; these pins hold the core steady for
// both callers (the serving seat and the client controller's delegated
// creation arm).

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  createSpaceRootIfAbsent,
  DEFAULT_APP_PATTERN_SOURCE,
  ensureSpaceRootPattern,
  HOME_PATTERN_SOURCE,
  resolveSpaceRootPattern,
  spaceRootPatternConfig,
} from "../src/ensure-space-root.ts";
import {
  getEntityId,
  getPatternIdentityRef,
  getPatternSource,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
} from "../src/index.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("ensure space root core");
const space = signer.did() as MemorySpace;

const HOME_PATH = "/api/patterns/system/home.tsx";
const APP_PATH = "/api/patterns/system/default-app.tsx";

function rootSource(marker: string): string {
  return [
    "import { computed, pattern } from 'commonfabric';",
    "const Root = pattern<Record<string, never>, { marker: string }>(" +
    `() => ({ marker: computed(() => "${marker}") }));`,
    "export default Root;",
    "",
  ].join("\n");
}

describe("space-root ensure core", () => {
  /** The served patterns route, in-process: pathname → TSX. Mutable so a
   * test can age the served source under a persisted root. */
  let files: Map<string, string>;

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const identityFor = (entry: string): Promise<string> =>
    resolveEntryIdentity(entry, (name) => {
      const contents = files.get(name);
      return contents !== undefined
        ? Promise.resolve(contents)
        : Promise.reject(new Error(`not found: ${name}`));
    });

  const fetchStub: RuntimeFetch = (input, _init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const body = files.get(url.pathname);
    if (body === undefined) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    if (url.searchParams.has("identity")) {
      return identityFor(url.pathname).then((id) => new Response(id));
    }
    return Promise.resolve(new Response(body));
  };

  const createRuntime = (): Runtime => {
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: fetchStub,
    });
    return runtime;
  };

  beforeEach(() => {
    files = new Map([
      [HOME_PATH, rootSource("home-v1")],
      [APP_PATH, rootSource("app-v1")],
    ]);
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await runtime?.sourceReconciler.idle();
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager.close();
  });

  it("resolves nothing on a fresh space, then the created root with its provenance", async () => {
    createRuntime();
    expect(await resolveSpaceRootPattern(runtime, space)).toBeUndefined();

    const created = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      { fetch: fetchStub },
    );
    expect(created.error).toBeUndefined();
    expect(created.createdByThisCall).toBe(true);
    await runtime.idle();

    const root = await resolveSpaceRootPattern(runtime, space);
    expect(root).toBeDefined();
    // Born with the provenance it will keep: the `system:` ref, and the
    // compiled identity of the served source under its default export.
    expect(getPatternSource(root!)).toBe(HOME_PATTERN_SOURCE);
    const ref = getPatternIdentityRef(root!);
    expect(ref?.identity).toBe(await identityFor(HOME_PATH));
    expect(ref?.symbol).toBe("default");
  });

  it("re-creation converges on ONE root by address (the OCC invariant)", async () => {
    createRuntime();
    const first = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      { fetch: fetchStub },
    );
    expect(first.createdByThisCall).toBe(true);
    await runtime.idle();
    const firstRoot = await resolveSpaceRootPattern(runtime, space);

    // The creation CAUSE derives the piece cell's entity id, so a rival
    // creation — here, a second call over a set-up-but-never-started
    // root, whose in-transaction value read is undefined (the computeds
    // never ran, so the fast arm cannot engage) — re-runs setup over the
    // SAME address and the space still holds exactly one root. The
    // client-arm fast path (`existingDefault?.get()` truthy on a live
    // root) is the piece suite's to pin; what the CORE guarantees is
    // address convergence whichever arm fires.
    const second = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      { fetch: fetchStub },
    );
    expect(second.error).toBeUndefined();
    await runtime.idle();
    const secondRoot = await resolveSpaceRootPattern(runtime, space);
    expect(getEntityId(secondRoot!)).toEqual(getEntityId(firstRoot!));
  });

  it("runs the stamp hook inside the creation attempt", async () => {
    createRuntime();
    let stamped = 0;
    const created = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      {
        fetch: fetchStub,
        stampCreationTx: () => {
          stamped += 1;
        },
      },
    );
    expect(created.createdByThisCall).toBe(true);
    expect(stamped).toBe(1);
    await runtime.idle();
  });

  it("ensure creates a fresh root, then resolves it on the next run", async () => {
    createRuntime();
    const first = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: true,
    });
    expect(first.outcome).toBe("created");
    await runtime.idle();

    const second = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: true,
    });
    expect(second.outcome).toBe("resolved-existing");
  });

  it("refuses an existing root at a different reserved address", async () => {
    createRuntime();
    await ensureSpaceRootPattern(runtime, space, { isHomeSpace: true });
    await runtime.idle();
    const original = await resolveSpaceRootPattern(runtime, space);
    await expect(ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: false,
      genesisRoot: { source: HOME_PATTERN_SOURCE, cause: "another-root" },
    })).rejects.toThrow(
      "Default pattern conflicts with the genesis root reservation",
    );
    expect((await resolveSpaceRootPattern(runtime, space))?.equals(original!))
      .toBe(true);
  });

  it("non-home ensure uses the system default-app source (the unruled custom-URL fork's interim)", async () => {
    createRuntime();
    const result = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: false,
    });
    expect(result.outcome).toBe("created");
    await runtime.idle();
    const root = await resolveSpaceRootPattern(runtime, space);
    expect(getPatternSource(root!)).toBe(DEFAULT_APP_PATTERN_SOURCE);
    expect(getPatternIdentityRef(root!)?.identity).toBe(
      await identityFor(APP_PATH),
    );
  });

  it("the in-tx fast arm returns early on a live re-check", async () => {
    createRuntime();
    // Fast arm (the OCC re-check seeing a LIVE root): read through the
    // caller-supplied spaceCell hook — the same seam the delegated
    // client passes and the piece suite's creation-race test stubs.
    // The emulated fixture's schema-filtered read cannot produce a
    // truthy value for an unstarted root (see the convergence pin), so
    // the stub is what makes this arm deterministic here; the live
    // measurement exercised it for real (r02–r06: six client-side
    // fast-arm resolves against the served root).
    const stubSpaceCell = {
      withTx: () => ({
        key: (key: string) => {
          expect(key).toBe("defaultPattern");
          return { get: () => ({ get: () => ({}) }) };
        },
      }),
    } as never;
    const raced = await createSpaceRootIfAbsent(
      runtime,
      space,
      spaceRootPatternConfig(true),
      { fetch: fetchStub, spaceCell: stubSpaceCell },
    );
    expect(raced.createdByThisCall).toBe(false);
    expect(raced.error).toBeUndefined();
    await runtime.idle();
  });

  it("creation that cannot commit AND no root to resolve THROWS with the commit error as cause", async () => {
    createRuntime();
    // Every creation attempt aborts its own transaction, and nothing
    // else creates — the ensure must throw the failed-to-create-or-find
    // error (the seat's counted-failure arm consumes it).
    await expect(
      ensureSpaceRootPattern(runtime, space, {
        isHomeSpace: true,
        stampCreationTx: (tx) => tx.abort("coverage pin: doomed creation"),
      }),
    ).rejects.toThrow("failed to create or find");
    await runtime.idle();
  });

  it("leaves a persisted root's source alone (following it belongs to whoever opens it)", async () => {
    createRuntime();
    expect(
      (await ensureSpaceRootPattern(runtime, space, { isHomeSpace: true }))
        .outcome,
    ).toBe("created");
    await runtime.idle();
    const bornIdentity = await identityFor(HOME_PATH);

    // The served source moves while the root is not running. A serving
    // tenure opens nothing, so its ensure must not adopt the new source:
    // the root keeps what it runs until a user opens it.
    files.set(HOME_PATH, rootSource("home-v2"));
    expect(await identityFor(HOME_PATH)).not.toBe(bornIdentity);

    const ensured = await ensureSpaceRootPattern(runtime, space, {
      isHomeSpace: true,
    });
    expect(ensured.outcome).toBe("resolved-existing");
    await runtime.idle();

    const root = await resolveSpaceRootPattern(runtime, space);
    expect(getPatternIdentityRef(root!)?.identity).toBe(bornIdentity);
  });
});
