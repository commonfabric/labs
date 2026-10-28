import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { bringUpHomeRootForRefusedWrite } from "../src/home-root.ts";
import { Runtime, type RuntimeFetch } from "../src/index.ts";
import { SpaceRootMissingError } from "../src/space-root-slot.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";

const user = await Identity.fromPassphrase("home root user");
const home = user.did() as MemorySpace;
const service = await Identity.fromPassphrase("home root service");
const elsewhere = (await Identity.fromPassphrase("home root elsewhere"))
  .did() as MemorySpace;

describe("home-root", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  /** The URLs fetched so far. Nothing is served, so each fetch is a 404. */
  let fetched: string[];

  const fetch: RuntimeFetch = (input) => {
    fetched.push(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  /** A runtime acting as `as`, serving or not. */
  function makeRuntime(as: Identity, servingPosture: boolean): Runtime {
    fetched = [];
    storageManager = StorageManager.emulate({ as });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch,
      ...(servingPosture
        ? { servingPosture, experimental: { serverExecution: true } }
        : {}),
    });
    return runtime;
  }

  afterEach(async () => {
    await runtime?.idle();
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  it("starts the Home root's creation for a write refused beneath the user's own Home", async () => {
    const rt = makeRuntime(user, false);

    const creation = bringUpHomeRootForRefusedWrite(
      rt,
      new SpaceRootMissingError(home),
    );

    expect(creation).toBeDefined();
    await expect(creation!).rejects.toThrow("404");
    expect(fetched.some((url) => url.includes("/system/home.tsx"))).toBe(true);
  });

  it("returns `undefined` for a write refused beneath another space", () => {
    const rt = makeRuntime(user, false);

    const creation = bringUpHomeRootForRefusedWrite(
      rt,
      new SpaceRootMissingError(elsewhere),
    );
    creation?.catch(() => {});

    expect(creation).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  it("returns `undefined` for an error other than a refused write", () => {
    const rt = makeRuntime(user, false);

    const creation = bringUpHomeRootForRefusedWrite(rt, new Error(home));
    creation?.catch(() => {});

    expect(creation).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  it("returns `undefined` on a serving runtime, which creates no Home root", () => {
    const rt = makeRuntime(service, true);

    const creation = bringUpHomeRootForRefusedWrite(
      rt,
      new SpaceRootMissingError(service.did() as MemorySpace),
    );
    creation?.catch(() => {});

    expect(creation).toBeUndefined();
    expect(fetched).toEqual([]);
  });
});
