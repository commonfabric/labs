import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";

import { UI } from "../src/builder/types.ts";
import { wish } from "../src/builtins/wish.ts";
import type { Cell } from "../src/cell.ts";
import { resolveSpaceRootPattern } from "../src/ensure-space-root.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  Runtime,
  type RuntimeFetch,
} from "../src/index.ts";
import { isSigilLink } from "../src/link-types.ts";
import { SpaceRootMissingError } from "../src/space-root-slot.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const user = await Identity.fromPassphrase("wish home root user");
const home = user.did() as MemorySpace;
const patternSpace = (await Identity.fromPassphrase("wish home root pattern"))
  .did();

const HOME_PATH = "/api/patterns/system/home.tsx";

/**
 * The served patterns route, in-process: a Home root owning the lists a wish
 * reaches, and a profile create surface that hands back the `profiles` it is
 * handed, with a handler `add` that appends a name to them and a handler `peek`
 * that only reads them, counting them into its own `seen`. A test may take a
 * route away.
 */
let files: Map<string, string>;

function servedFiles(): Map<string, string> {
  return new Map([
    [
      HOME_PATH,
      [
        "import { pattern, Writable } from 'commonfabric';",
        "export default pattern<void>(() => ({",
        "  profiles: new Writable<string[]>([]).for('profiles'),",
        "  favorites: new Writable<string[]>([]).for('favorites'),",
        "}));",
        "",
      ].join("\n"),
    ],
    [
      "/api/patterns/system/profile-create.tsx",
      [
        "import { handler, pattern, Writable } from 'commonfabric';",
        "const add = handler<",
        "  { name: string },",
        "  { profiles: Writable<string[]> }",
        ">((event, { profiles }) => {",
        "  profiles.push(event.name);",
        "});",
        "const peek = handler<",
        "  Record<string, never>,",
        "  { profiles: Writable<string[]>; seen: Writable<number> }",
        ">((_event, { profiles, seen }) => {",
        "  seen.set((profiles.get() ?? []).length);",
        "});",
        "export default pattern<{ profiles: Writable<string[]> }>(",
        "  ({ profiles }) => {",
        "    const seen = new Writable<number>(-1).for('seen');",
        "    return {",
        "      profiles,",
        "      seen,",
        "      add: add({ profiles }),",
        "      peek: peek({ profiles, seen }),",
        "    };",
        "  },",
        ");",
        "",
      ].join("\n"),
    ],
  ]);
}

const fetchStub: RuntimeFetch = (input) => {
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
    return resolveEntryIdentity(url.pathname, (name) => {
      const contents = files.get(name);
      return contents !== undefined
        ? Promise.resolve(contents)
        : Promise.reject(new Error(`not found: ${name}`));
    }).then((identity) => new Response(identity));
  }
  return Promise.resolve(new Response(body));
};

describe("wish-home-root", () => {
  beforeEach(() => {
    files = servedFiles();
  });

  describe("on a client runtime", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pattern: ReturnType<typeof createTrustedBuilder>["commonfabric"][
      "pattern"
    ];
    let wishFn: ReturnType<typeof createTrustedBuilder>["commonfabric"][
      "wish"
    ];

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: user });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
        fetch: fetchStub,
      });
      ({ pattern, wish: wishFn } = createTrustedBuilder(runtime).commonfabric);
    });

    afterEach(async () => {
      await runtime.idle();
      await runtime.dispose();
      await storageManager.close();
    });

    /**
     * Runs `query` as a wish in `space`, by default one other than Home, and
     * demands it.
     */
    async function runWish(
      query: string,
      label: string,
      options: { headless?: boolean; scope?: ("~" | ".")[] } = {},
      space: MemorySpace = patternSpace,
    ) {
      const wishPattern = pattern(() => ({
        found: wishFn({ query, ...options }),
      }));
      const tx = runtime.edit();
      const resultCell = runtime.getCell<Record<string, any>>(
        space,
        label,
        undefined,
        tx,
      );
      const result = runtime.run(tx, wishPattern, {}, resultCell);
      expect((await tx.commit().settled).error).toBeUndefined();
      const stop = result.key("found").sink(() => {});
      await result.pull();
      await runtime.idle();
      return { found: result.key("found"), stop };
    }

    /** The raw `defaultPattern` slot of the Home space cell. */
    function homeSlot(): unknown {
      return (runtime.getCell(home, home).getRaw() as
        | { defaultPattern?: unknown }
        | undefined)?.defaultPattern;
    }

    /** The profile create surface a `#profile` wish offers, started. */
    async function createSurface(found: Cell<any>): Promise<Cell<any>> {
      expect(
        found.key(UI).key("props").key("data-profile-create-ui").get(),
      ).toBe("wish");
      const surface = found.key(UI).key("props").key("$cell")
        .resolveAsCell() as Cell<any>;
      await surface.pull();
      await runtime.idle();
      return surface;
    }

    it("offers the profile create surface for a `#profile` with no profile, and creates no Home root", async () => {
      const { found, stop } = await runWish("#profile", "profile wish");
      try {
        expect(found.get()?.error).toBe("No profile exists yet");
        await createSurface(found);
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });

    it("creates no Home root for a handler that only reads beneath the empty slot", async () => {
      const { found, stop } = await runWish(
        "#profile",
        "profile read",
        {},
        home,
      );
      try {
        const surface = await createSurface(found);

        surface.key("peek").send({});
        await runtime.idle();

        expect(surface.key("seen").get()).toBe(0);
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });

    it("brings up the Home root at the create surface's handler's write, which then lands under it", async () => {
      // In the Home space itself, so that the stand-in surface's handler,
      // which creates no profile space of its own, writes one space only.
      const { found, stop } = await runWish(
        "#profile",
        "profile write",
        {},
        home,
      );
      try {
        const surface = await createSurface(found);
        expect(homeSlot()).toBeUndefined();

        surface.key("add").send({ name: "Ada" });
        await runtime.idle();

        expect(isSigilLink(homeSlot())).toBe(true);
        const root = await resolveSpaceRootPattern(runtime, home);
        expect(getPatternIdentityRef(root!)).toBeDefined();
        expect((root as Cell<any>).key("profiles").get()).toEqual(["Ada"]);
      } finally {
        stop();
      }
    });

    it("refuses a write outside a handler beneath a Home with no root, and leaves the slot empty", async () => {
      const { found, stop } = await runWish("#favorites", "favorites wish");
      try {
        expect(found.get()?.error).toBeUndefined();
        expect(homeSlot()).toBeUndefined();

        const tx = runtime.edit();
        expect(() =>
          (found.key("result").withTx(tx) as Cell<any>).push("a favorite")
        ).toThrow(SpaceRootMissingError);
        tx.abort();
        await runtime.idle();

        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });

    it("refuses a handler's write beneath a Home whose root could not be created, and leaves the slot empty", async () => {
      files.delete(HOME_PATH);
      const errors: unknown[] = [];
      runtime.scheduler.onError((error) => errors.push(error));
      const { found, stop } = await runWish(
        "#profile",
        "unservable home",
        {},
        home,
      );
      try {
        const surface = await createSurface(found);

        surface.key("add").send({ name: "Ada" });
        await runtime.idle();

        const refusal = errors.find((error) =>
          error instanceof SpaceRootMissingError
        ) as (SpaceRootMissingError & { frame?: unknown }) | undefined;
        expect(refusal).toBeDefined();
        expect(String(refusal!.cause)).toContain("404");
        expect(refusal!.frame).toBeDefined();
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });

    it("offers no create surface for a headless `#profile` with no profile, and creates no Home root", async () => {
      const { found, stop } = await runWish("#profile", "headless profile", {
        headless: true,
      });
      try {
        expect(found.get()?.error).toBe("No profile exists yet");
        expect(
          found.key(UI).key("props").key("data-profile-create-ui").get(),
        ).toBeUndefined();
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });

    it("resolves a headless `#agent_queue` to nothing on a Home with no root, and creates none", async () => {
      const { found, stop } = await runWish("#agent_queue", "headless queue", {
        headless: true,
      });
      try {
        expect(found.get()?.error).toBeUndefined();
        expect(found.get()?.result).toBeUndefined();
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });

    it("resolves a headless `~`-scoped `#default` to nothing on a Home with no root, and creates none", async () => {
      const { found, stop } = await runWish(
        "#default",
        "headless home default",
        {
          headless: true,
          scope: ["~"],
        },
      );
      try {
        expect(found.get()?.error).toBeUndefined();
        expect(found.get()?.result).toBeUndefined();
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });

    it("reports no chat manager for a Home with no root, and creates none", async () => {
      const { found, stop } = await runWish("#chatManager", "chat manager");
      try {
        expect(String(found.get()?.error)).toContain(
          "The home space holds no chat manager",
        );
        expect(homeSlot()).toBeUndefined();
      } finally {
        stop();
      }
    });
  });

  it("resolves a headless wish to nothing for a Home with no root on a serving runtime, and creates none", async () => {
    const service = await Identity.fromPassphrase("wish home root service");
    const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    const holder = executionLeaseHolder(service.did());
    const storageManager = EmulatedStorageManager.connectTo(server, {
      as: service,
      id: holder,
    });
    const lease = new ExecutionLeaseCycle({
      engine: await server.engineForSpace(service.did()),
      space: service.did(),
      holder,
    });
    expect(lease.acquire()).toBe(true);
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: fetchStub,
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    const cancels: (() => void)[] = [];
    try {
      const setup = runtime.edit();
      const parent = runtime.getCell(
        service.did(),
        "favorites consumer",
        undefined,
        setup,
      );
      parent.set({});
      const inputs = runtime.getCell(
        service.did(),
        "favorites wish arguments",
        undefined,
        setup,
      );
      inputs.set({ query: "#favorites", headless: true });
      expect((await setup.commit().settled).error).toBeUndefined();
      const observed: unknown[] = [];
      const action = wish(
        inputs as Cell<[unknown, unknown]>,
        (tx, value) => {
          observed.push((value as Cell<{ error?: string }>).withTx(tx).get());
        },
        (cancel) => cancels.push(cancel),
        [parent],
        parent,
        runtime,
      );
      const run = async () => {
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: "favorites wish",
          kind: "derivation",
          attributionFromScope: true,
          scopeKeyIdentity: { principal: home, sessionId: home },
        });
        action.action(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.storageManager.crossSpaceSettled?.();
      };
      // The first run waits on the load of the Home space cell, and the second
      // finds it absent.
      await run();
      await run();
      expect(observed.at(-1)).toBeDefined();
      expect((observed.at(-1) as { error?: string }).error).toBeUndefined();
      expect((observed.at(-1) as { result?: unknown }).result)
        .toBeUndefined();
      expect(
        (runtime.getCell(home, home).getRaw() as
          | { defaultPattern?: unknown }
          | undefined)?.defaultPattern,
      ).toBeUndefined();
    } finally {
      cancels.forEach((cancel) => cancel());
      await runtime.dispose({ closeStorage: false });
      lease.release();
      await storageManager.close();
      await server.close();
    }
  });
});
