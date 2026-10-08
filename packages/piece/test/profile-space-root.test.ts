import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
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

import { TestStorageManager } from "../../runner/test/memory-v2-test-utils.ts";
import {
  createProfileThroughHome,
  PrincipalSessionFactory,
} from "../../runner/test/support/profile-create-host.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  inspectProfileSpaceRoot,
  repairProfileSpaceRoot,
} from "../src/ops/profile-space-root.ts";

const owner = await Identity.fromPassphrase("profile space root owner");
const admin = await Identity.fromPassphrase("profile space root admin");

/** The default app's entry module, as the toolshed serves it. */
const DEFAULT_APP_MAIN = "/api/patterns/system/default-app.tsx";

/** A root that exports no `pieceRegistry` at all. */
const NO_REGISTRY_ROOT = [
  "import { pattern } from 'commonfabric';",
  "export default pattern(() => ({ note: 'no registry here' }));",
  "",
].join("\n");

/** A root the way an open of a space without one creates it, near enough. */
const PLANTED_ROOT = [
  "import { pattern, Writable } from 'commonfabric';",
  "export default pattern(() => {",
  "  const pieceRegistry = new Writable<string[]>(REGISTERED).for('pieceRegistry');",
  "  return { pieceRegistry };",
  "});",
  "",
].join("\n");

describe("profile-space-root", () => {
  let server: MemoryV2Server.Server;
  let serverCount = 0;
  let runtimes: Runtime[];

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

  beforeEach(() => {
    runtimes = [];
    server = new MemoryV2Server.Server({
      store: new URL(`memory://profile-space-root-${++serverCount}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-profile-space-root" },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
  });

  afterEach(async () => {
    for (const runtime of runtimes.reverse()) await runtime.dispose();
    await server.close();
  });

  /**
   * Creates a profile as one made before profiles were their space's root,
   * and returns the admin's controller over its space and the id its Home's
   * list names it by.
   */
  const legacyProfile = async () => {
    const listed = await createProfileThroughHome(runtimeAs(owner), "Ada", {
      shape: "not-root",
    });
    const controller = new PiecesController(
      { as: admin, space: listed.space as MemorySpace },
      runtimeAs(admin),
      { deferSpaceCellSync: true },
    );
    return { controller, id: listed.id };
  };

  /**
   * Plants a root in the controller's space at `cause`, following `origin`
   * or the system default source, compiled as `main` or as the default app
   * the toolshed serves, with `registered` in its registry, as the admin.
   */
  const plantRoot = async (
    controller: PiecesController,
    options: {
      cause?: string;
      registered?: string[];
      origin?: string;
      main?: string;
      contents?: string;
    } = {},
  ): Promise<Cell<unknown>> => {
    const runtime = controller.runtime;
    const space = controller.getSpace();
    const main = options.main ?? DEFAULT_APP_MAIN;
    const pattern = await runtime.patternManager.compilePattern({
      main,
      files: [{
        name: main,
        contents: options.contents ?? PLANTED_ROOT.replace(
          "REGISTERED",
          JSON.stringify(options.registered ?? []),
        ),
      }],
    }, { space });
    let root!: Cell<unknown>;
    const { error } = await runtime.editWithRetry((tx) => {
      root = runtime.getCell(
        space,
        options.cause ?? spaceRootPatternConfig(false).cause,
        undefined,
        tx,
      );
      runtime.runner.run(tx, pattern, {}, root, {
        sourceOrigin: options.origin ?? DEFAULT_APP_PATTERN_SOURCE,
      });
    });
    expect(error).toBeUndefined();
    await controller.linkDefaultPattern(root);
    await runtime.storageManager.synced();
    return root;
  };

  /** The space's root, as a fresh runtime of the admin's reads it. */
  const rootAddressOf = async (space: string) => {
    const root = await resolveSpaceRootPattern(
      runtimeAs(admin),
      space as MemorySpace,
    );
    return root?.getAsNormalizedFullLink().id;
  };

  it("links a profile whose space has no root, and finds it the root on a second run", async () => {
    const { controller, id } = await legacyProfile();
    const before = await inspectProfileSpaceRoot(controller, id);
    expect(before.status).toBe("unrooted");
    expect(before.action).toBe("link");
    expect(before.owner).toBe(owner.did());
    expect(before.root).toBeUndefined();

    const after = await repairProfileSpaceRoot(
      controller,
      id,
      before.inspection,
    );
    expect(after.status).toBe("root");
    expect(after.action).toBe("none");
    expect(after.root).toEqual(before.profile);
    expect(await rootAddressOf(before.profile.space)).toBe(before.profile.id);

    const again = await inspectProfileSpaceRoot(controller, id);
    expect(again).toEqual(after);
    expect(await repairProfileSpaceRoot(controller, id, again.inspection))
      .toEqual(after);
  });

  it("replaces a root an open of the space created, with nothing registered in it", async () => {
    const { controller, id } = await legacyProfile();
    const planted = await plantRoot(controller);
    const before = await inspectProfileSpaceRoot(controller, id);
    expect(before.status).toBe("junk-root");
    expect(before.action).toBe("replace");
    expect(before.root?.id).toBe(planted.getAsNormalizedFullLink().id);

    const after = await repairProfileSpaceRoot(
      controller,
      id,
      before.inspection,
    );
    expect(after.status).toBe("root");
    expect(await rootAddressOf(before.profile.space)).toBe(before.profile.id);
  });

  it("refuses to replace a junk root something is registered in while the repair links", async () => {
    const { controller, id } = await legacyProfile();
    const planted = await plantRoot(controller);
    const before = await inspectProfileSpaceRoot(controller, id);
    expect(before.status).toBe("junk-root");

    // Another writer registers a piece in the planted root after the repair's
    // own inspection and before its link commits.
    const link = controller.linkDefaultPattern.bind(controller);
    controller.linkDefaultPattern = async (...args) => {
      const runtime = controller.runtime;
      const { error } = await runtime.editWithRetry((tx) => {
        planted.withTx(tx).key("pieceRegistry").set(["registered meanwhile"]);
      });
      expect(error).toBeUndefined();
      return await link(...args);
    };

    await expect(repairProfileSpaceRoot(controller, id, before.inspection))
      .rejects.toThrow("no longer passes the check it was inspected under");
    expect(await rootAddressOf(controller.getSpace())).toBe(
      planted.getAsNormalizedFullLink().id,
    );
  });

  describe("an occupied root", () => {
    const occupiedCases: [
      string,
      {
        cause?: string;
        registered?: string[];
        origin?: string;
        main?: string;
        contents?: string;
      },
    ][] = [
      ["holds something registered", { registered: ["a piece"] }],
      ["is at another address", { cause: "a root chosen on purpose" }],
      ["follows another source", {
        origin: "https://example.test/root.tsx",
      }],
      ["runs a pattern other than the default app", {
        main: "/hand-authored-root.tsx",
      }],
      ["has no piece registry", { contents: NO_REGISTRY_ROOT }],
    ];
    for (const [condition, options] of occupiedCases) {
      it(`leaves a root alone that ${condition}`, async () => {
        const { controller, id } = await legacyProfile();
        const planted = await plantRoot(controller, options);
        const before = await inspectProfileSpaceRoot(controller, id);
        expect(before.status).toBe("occupied");
        expect(before.action).toBe("none");

        expect(await repairProfileSpaceRoot(controller, id, before.inspection))
          .toEqual(before);
        expect(await rootAddressOf(controller.getSpace())).toBe(
          planted.getAsNormalizedFullLink().id,
        );
      });
    }
  });

  it("reports a piece that is not a profile, and changes nothing", async () => {
    const { controller } = await legacyProfile();
    const planted = await plantRoot(controller, {
      cause: "something else entirely",
    });
    const plantedId = (planted.getAsNormalizedFullLink() as NormalizedFullLink)
      .id;
    const report = await inspectProfileSpaceRoot(controller, plantedId);
    expect(report.status).toBe("not-a-profile");
    expect(report.action).toBe("none");
    expect(report.owner).toBeUndefined();
    expect(await rootAddressOf(controller.getSpace())).toBe(plantedId);
  });

  it("reports an address that names no piece as not a profile", async () => {
    const { controller } = await legacyProfile();
    const nothing = controller.runtime.getCell(
      controller.getSpace(),
      "nothing was ever written here",
    ).getAsNormalizedFullLink().id;
    const report = await inspectProfileSpaceRoot(controller, nothing);
    expect(report.status).toBe("not-a-profile");
    expect(report.reason).toBe(
      "the address names no piece in the profile's space",
    );
  });

  it("refuses a receipt from before the space's root changed", async () => {
    const { controller, id } = await legacyProfile();
    const before = await inspectProfileSpaceRoot(controller, id);
    expect(before.status).toBe("unrooted");
    const planted = await plantRoot(controller);

    await expect(repairProfileSpaceRoot(controller, id, before.inspection))
      .rejects.toThrow("changed after inspection");
    expect(await rootAddressOf(controller.getSpace())).toBe(
      planted.getAsNormalizedFullLink().id,
    );
  });
});
