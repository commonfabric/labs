import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { createSession, Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import {
  type Cell,
  DEFAULT_APP_PATTERN_SOURCE,
  type MemorySpace,
  type NormalizedFullLink,
  resolveSpaceRootPattern,
  Runtime,
  spaceRootPatternConfig,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";

import { TestStorageManager } from "../../../runner/test/memory-v2-test-utils.ts";
import {
  createProfileThroughHome,
  PrincipalSessionFactory,
} from "../../../runner/test/support/profile-create-host.ts";
import { PiecesController } from "../../src/ops/pieces-controller.ts";
import {
  inspectProfileSpaceRoot,
  repairProfileRootsOf,
  repairProfileSpaceRoot,
} from "../../src/ops/profile-space-root.ts";

const owner = await Identity.fromPassphrase("profile root housekeeping owner");
const stranger = await Identity.fromPassphrase(
  "profile root housekeeping stranger",
);
const admin = await Identity.fromPassphrase("profile root housekeeping admin");

const patternsRoot = join(import.meta.dirname!, "..", "..", "..", "patterns");

describe("profile-space-root", () => {
  let server: MemoryV2Server.Server;
  let runtimes: Runtime[];

  /** A runtime acting as `as`, over the test server. */
  const runtimeAs = (as: Identity) => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.create(
        { as, memoryHost: new URL("memory://") },
        new PrincipalSessionFactory(server),
      ),
    });
    runtimes.push(runtime);
    return runtime;
  };

  /** A controller over `space`, acting as `as` through `runtime`. */
  const controllerOver = (runtime: Runtime, as: Identity, space: string) =>
    new PiecesController(
      createSession({ identity: as, spaceDid: space as MemorySpace }),
      runtime,
    );

  /**
   * Runs the real default app, written by the admin, at `cause` in `space`,
   * and links it as the space's root.
   */
  const plantDefaultApp = async (space: string, cause: string) => {
    const plantRuntime = runtimeAs(admin);
    const program = await resolveLocalProgram(
      (resolver) => plantRuntime.harness.resolve(resolver),
      {
        main: join(patternsRoot, "system", "default-app.tsx"),
        root: patternsRoot,
      },
    );
    const pattern = await plantRuntime.patternManager.compilePattern(program, {
      space: space as MemorySpace,
    });
    const { error } = await plantRuntime.editWithRetry((tx) => {
      const root: Cell<unknown> = plantRuntime.getCell(
        space as MemorySpace,
        cause,
        undefined,
        tx,
      );
      plantRuntime.runner.run(tx, pattern, {}, root, {
        sourceOrigin: DEFAULT_APP_PATTERN_SOURCE,
      });
      plantRuntime.getSpaceCell(space as MemorySpace).withTx(tx).key(
        "defaultPattern",
      ).set(root);
    });
    expect(error).toBeUndefined();
    await plantRuntime.storageManager.synced();
  };

  /** The id the space's root resolves to, read by a fresh runtime. */
  const rootIdOf = async (space: string) =>
    (await resolveSpaceRootPattern(runtimeAs(admin), space as MemorySpace))
      ?.getAsNormalizedFullLink().id;

  /** The id the listed slot `link` resolves to: the profile itself. */
  const profileIdOf = async (link: NormalizedFullLink) => {
    const named = runtimeAs(admin).getCellFromLink(link);
    await named.sync();
    return named.resolveAsCell().getAsNormalizedFullLink().id;
  };

  /**
   * A stand-in for Home in `runtime`'s home space, whose `profiles` list
   * holds `links`.
   */
  const homeListing = async (
    runtime: Runtime,
    links: NormalizedFullLink[],
  ): Promise<Cell<unknown>> => {
    const space = runtime.userIdentityDID as MemorySpace;
    let home!: Cell<unknown>;
    const { error } = await runtime.editWithRetry((tx) => {
      home = runtime.getCell(
        space,
        `listing ${crypto.randomUUID()}`,
        undefined,
        tx,
      );
      home.set({
        profiles: links.map((link) => runtime.getCellFromLink(link)),
      });
    });
    expect(error).toBeUndefined();
    await runtime.storageManager.synced();
    return home;
  };

  /**
   * Returns controllers over each space as `as`, through `runtime`, that
   * refuse to link a root, so that a run through them shows it linked
   * nothing.
   */
  const refusingLinks = (runtime: Runtime, as: Identity) => (space: string) => {
    const controller = controllerOver(runtime, as, space);
    controller.linkDefaultPattern = () =>
      Promise.reject(new Error("a root was linked"));
    return controller;
  };

  beforeEach(() => {
    runtimes = [];
    server = new MemoryV2Server.Server({
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-profile-root-housekeeping" },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    for (const runtime of runtimes.splice(0).reverse()) {
      await runtime.dispose();
    }
    await server.close();
  });

  describe("PiecesController.repairProfileRoots()", () => {
    /** Runs the repair from `owner`'s Home, as Home's housekeeping does. */
    const repairAsOwner = async () => {
      const runtime = runtimeAs(owner);
      await controllerOver(runtime, owner, owner.did()).repairProfileRoots();
    };

    it("makes a listed profile whose space has no root that space's root", async () => {
      const listed = await createProfileThroughHome(runtimeAs(owner), "U", {
        shape: "not-root",
        hostIsRoot: true,
      });
      expect(await rootIdOf(listed.space)).toBeUndefined();

      await repairAsOwner();

      expect(await rootIdOf(listed.space)).toBe(await profileIdOf(listed));
    });

    it("replaces a root that a space-root ensure created, with nothing added to it, with the listed profile", async () => {
      const listed = await createProfileThroughHome(runtimeAs(owner), "J", {
        shape: "not-root",
        hostIsRoot: true,
      });
      await plantDefaultApp(listed.space, spaceRootPatternConfig(false).cause);
      const planted = await rootIdOf(listed.space);
      expect(planted).not.toBe(await profileIdOf(listed));

      await repairAsOwner();

      expect(await rootIdOf(listed.space)).toBe(await profileIdOf(listed));
    });

    it("leaves a root that no space-root ensure created alone", async () => {
      const listed = await createProfileThroughHome(runtimeAs(owner), "O", {
        shape: "not-root",
        hostIsRoot: true,
      });
      await plantDefaultApp(listed.space, "a root no ensure made");
      const planted = await rootIdOf(listed.space);
      expect(planted).toBeDefined();

      await repairAsOwner();

      expect(await rootIdOf(listed.space)).toBe(planted);
    });

    it("throws for a controller over a space other than the identity's Home", async () => {
      const runtime = runtimeAs(owner);
      const elsewhere = controllerOver(
        runtime,
        owner,
        await runtime.createSpace({ grants: {} }),
      );

      await expect(elsewhere.repairProfileRoots()).rejects.toThrow(
        "Only a controller over the identity's Home space",
      );
    });
  });

  describe("repairProfileSpaceRoot()", () => {
    it("commits no link, and rejects, when its signal has aborted", async () => {
      const listed = await createProfileThroughHome(runtimeAs(owner), "U", {
        shape: "not-root",
        hostIsRoot: true,
      });
      const runtime = runtimeAs(owner);
      const controller = controllerOver(runtime, owner, listed.space);
      const found = await inspectProfileSpaceRoot(controller, listed.id);
      expect(found.action).toBe("link");
      const aborted = new AbortController();
      aborted.abort();

      await expect(
        repairProfileSpaceRoot(
          controller,
          listed.id,
          found.inspection,
          aborted.signal,
        ),
      ).rejects.toThrow("StorageTransactionAborted");

      expect(await rootIdOf(listed.space)).toBeUndefined();
    });
  });

  describe("repairProfileRootsOf()", () => {
    it("links nothing for a profile already its space's root, or one whose root is occupied", async () => {
      const rooted = await createProfileThroughHome(runtimeAs(owner), "R", {
        shape: "root",
        hostCause: "rooted host",
      });
      const occupied = await createProfileThroughHome(runtimeAs(owner), "O", {
        shape: "not-root",
        hostCause: "occupied host",
      });
      await plantDefaultApp(occupied.space, "a root no ensure made");
      const unrooted = await createProfileThroughHome(runtimeAs(owner), "U", {
        shape: "not-root",
        hostCause: "unrooted host",
      });
      const runtime = runtimeAs(owner);

      await repairProfileRootsOf(
        await homeListing(runtime, [rooted, occupied]),
        owner.did(),
        refusingLinks(runtime, owner),
      );
      // The same run over an unrooted profile does link, which the stand-in
      // refuses, so the run above linked nothing.
      await expect(
        repairProfileRootsOf(
          await homeListing(runtime, [unrooted]),
          owner.did(),
          refusingLinks(runtime, owner),
        ),
      ).rejects.toThrow(AggregateError);
    });

    it("links nothing for a profile it has already repaired", async () => {
      const listed = await createProfileThroughHome(runtimeAs(owner), "U", {
        shape: "not-root",
        hostIsRoot: true,
      });
      const runtime = runtimeAs(owner);
      const home = await homeListing(runtime, [listed]);
      await repairProfileRootsOf(
        home,
        owner.did(),
        (space) => controllerOver(runtime, owner, space),
      );
      expect(await rootIdOf(listed.space)).toBe(await profileIdOf(listed));

      await repairProfileRootsOf(
        home,
        owner.did(),
        refusingLinks(runtime, owner),
      );

      expect(await rootIdOf(listed.space)).toBe(await profileIdOf(listed));
    });

    it("leaves alone a listed profile that another identity owns", async () => {
      const theirs = await createProfileThroughHome(runtimeAs(stranger), "S", {
        shape: "not-root",
        hostIsRoot: true,
      });
      const runtime = runtimeAs(owner);

      await repairProfileRootsOf(
        await homeListing(runtime, [theirs]),
        owner.did(),
        (space) => controllerOver(runtime, owner, space),
      );

      expect(await rootIdOf(theirs.space)).toBeUndefined();
    });

    it("goes on to the other profiles when one fails, and then rejects with that failure", async () => {
      const failing = await createProfileThroughHome(runtimeAs(owner), "F", {
        shape: "not-root",
        hostCause: "failing host",
      });
      const repaired = await createProfileThroughHome(runtimeAs(owner), "U", {
        shape: "not-root",
        hostCause: "repaired host",
      });
      const runtime = runtimeAs(owner);
      const refused = new Error("the connection was refused");

      const run = repairProfileRootsOf(
        await homeListing(runtime, [failing, repaired]),
        owner.did(),
        (space) => {
          if (space === failing.space) throw refused;
          return controllerOver(runtime, owner, space);
        },
      );

      await expect(run).rejects.toThrow(AggregateError);
      expect((await run.catch((error) => error)).errors).toEqual([refused]);
      expect(await rootIdOf(failing.space)).toBeUndefined();
      expect(await rootIdOf(repaired.space)).toBe(await profileIdOf(repaired));
    });

    it("repairs nothing once its signal has aborted", async () => {
      const listed = await createProfileThroughHome(runtimeAs(owner), "U", {
        shape: "not-root",
        hostIsRoot: true,
      });
      const runtime = runtimeAs(owner);
      const aborted = new AbortController();
      aborted.abort();

      await repairProfileRootsOf(
        await homeListing(runtime, [listed]),
        owner.did(),
        (space) => controllerOver(runtime, owner, space),
        aborted.signal,
      );

      expect(await rootIdOf(listed.space)).toBeUndefined();
    });

    it("does nothing for a Home with no `profiles` list", async () => {
      const runtime = runtimeAs(owner);
      const home = runtime.getCell(owner.did() as MemorySpace, "no list");
      let asked = 0;

      await repairProfileRootsOf(home, owner.did(), (space) => {
        asked++;
        return controllerOver(runtime, owner, space);
      });

      expect(asked).toBe(0);
    });
  });
});
