/**
 * Runs the store-wide profile root repair end to end: profiles created on a
 * memory server that enforces access-control lists, a snapshot of its store
 * taken the way an operator takes one, with `VACUUM INTO`, and the repair run
 * as an unrelated identity over a fresh connection to the same store.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { PiecesController } from "@commonfabric/piece/ops";
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
import {
  contentFingerprint,
  diffFingerprints,
  discoverSpaceDbs,
  getValueAt,
  openSpace,
} from "@commonfabric/state-inspector";

import { TestStorageManager } from "../../runner/test/memory-v2-test-utils.ts";
import {
  createProfileThroughHome,
  PrincipalSessionFactory,
} from "../../runner/test/support/profile-create-host.ts";
import type { SpaceConfig } from "../lib/piece.ts";
import {
  profileSpaceRoot,
  type ProfileSpaceRootConfig,
} from "../lib/profile-space-root.ts";

const unrootedOwner = await Identity.fromPassphrase("repair-root unrooted");
const plantedOwner = await Identity.fromPassphrase("repair-root planted");
const rootedOwner = await Identity.fromPassphrase("repair-root rooted");
const unlistedOwner = await Identity.fromPassphrase("repair-root unlisted");
const admin = await Identity.fromPassphrase("repair-root admin");

const patternsRoot = join(import.meta.dirname!, "..", "..", "patterns");

describe("profileSpaceRoot()", () => {
  let storeDir: string;
  let snapshotDir: string;
  let server: MemoryV2Server.Server | undefined;
  let runtimes: Runtime[];
  // Each profile's space and the id its Home lists it by.
  let unrooted: NormalizedFullLink;
  let planted: NormalizedFullLink;
  let rooted: NormalizedFullLink;
  let unlisted: NormalizedFullLink;

  const serve = () => {
    server = new MemoryV2Server.Server({
      store: new URL(`file://${storeDir}/`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: "did:key:z6Mk-profile-repair-root" },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    return server;
  };

  const runtimeAs = (as: Identity) => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.create(
        { as, memoryHost: new URL("memory://") },
        new PrincipalSessionFactory(server!),
      ),
    });
    runtimes.push(runtime);
    return runtime;
  };

  const stop = async () => {
    for (const runtime of runtimes.splice(0).reverse()) {
      await runtime.dispose();
    }
    await server?.close();
    server = undefined;
  };

  /** The connections the command opens, each as the admin. */
  const load = (config: SpaceConfig) => {
    const pieces = new PiecesController(
      { as: admin, space: config.space as MemorySpace },
      runtimeAs(admin),
      { deferSpaceCellSync: true },
    );
    pieces.dispose = () => Promise.resolve();
    return Promise.resolve(pieces);
  };

  const config = (
    extra: Partial<ProfileSpaceRootConfig> = {},
  ): ProfileSpaceRootConfig => ({
    apiUrl: "http://127.0.0.1:8000",
    identity: "/unread.key",
    snapshot: snapshotDir,
    ...extra,
  });

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

  beforeEach(async () => {
    runtimes = [];
    storeDir = await Deno.makeTempDir({ prefix: "repair-root-store-" });
    snapshotDir = await Deno.makeTempDir({ prefix: "repair-root-snapshot-" });
    serve();
    unrooted = await createProfileThroughHome(runtimeAs(unrootedOwner), "U", {
      shape: "not-root",
    });
    planted = await createProfileThroughHome(runtimeAs(plantedOwner), "P", {
      shape: "not-root",
    });
    rooted = await createProfileThroughHome(runtimeAs(rootedOwner), "R", {
      shape: "root",
    });
    unlisted = await createProfileThroughHome(runtimeAs(unlistedOwner), "N", {
      shape: "not-root",
    });

    // The planted profile's space gets the root an open of it would have
    // made, the real default app, written by the admin.
    const plantRuntime = runtimeAs(admin);
    const space = planted.space as MemorySpace;
    const program = await resolveLocalProgram(
      (resolver) => plantRuntime.harness.resolve(resolver),
      {
        main: join(patternsRoot, "system", "default-app.tsx"),
        root: patternsRoot,
      },
    );
    const pattern = await plantRuntime.patternManager.compilePattern(program, {
      space,
    });
    const { error } = await plantRuntime.editWithRetry((tx) => {
      const root: Cell<unknown> = plantRuntime.getCell(
        space,
        spaceRootPatternConfig(false).cause,
        undefined,
        tx,
      );
      plantRuntime.runner.run(tx, pattern, {}, root, {
        sourceOrigin: DEFAULT_APP_PATTERN_SOURCE,
      });
      plantRuntime.getSpaceCell(space).withTx(tx).key("defaultPattern").set(
        root,
      );
    });
    expect(error).toBeUndefined();
    await plantRuntime.storageManager.synced();
    await stop();

    // The snapshot leaves out the unlisted profile's Home, so no Home in it
    // lists that profile.
    for (
      const { did, path } of discoverSpaceDbs({
        dirs: [storeDir],
        defaultRoots: false,
      })
    ) {
      if (did === unlistedOwner.did()) continue;
      const db = new Database(path, { readonly: true });
      try {
        db.exec(`VACUUM INTO '${snapshotDir}/${did}.sqlite'`);
      } finally {
        db.close();
      }
    }
    serve();
  });

  afterEach(async () => {
    await stop();
    await Deno.remove(storeDir, { recursive: true });
    await Deno.remove(snapshotDir, { recursive: true });
  });

  it("inspects each listed profile, and reports an unlisted one as skipped", async () => {
    const report = await profileSpaceRoot(config(), { load });
    expect(report.applied).toBe(false);
    const statusBySpace = Object.fromEntries(
      report.rows.map((row) => [row.named.space, row.status]),
    );
    expect(statusBySpace).toEqual({
      [unrooted.space]: "unrooted",
      [planted.space]: "junk-root",
      [rooted.space]: "root",
      [unlisted.space]: "unlisted",
    });
    expect(report.summary).toEqual({
      unrooted: 1,
      "junk-root": 1,
      root: 1,
      unlisted: 1,
    });
    const homeBySpace = Object.fromEntries(
      report.rows.map((row) => [row.named.space, row.home]),
    );
    expect(homeBySpace[unrooted.space]).toBe(unrootedOwner.did());
    expect(homeBySpace[unlisted.space]).toBeUndefined();
    expect((await profileSpaceRoot(config(), { load })).inspection).toBe(
      report.inspection,
    );
  });

  it("applies the inspected plan, after which every listed profile is its space's root", async () => {
    const plan = await profileSpaceRoot(config(), { load });
    const applied = await profileSpaceRoot(
      config({ expectedInspection: plan.inspection }),
      { load },
    );
    expect(applied.applied).toBe(true);
    expect(applied.summary).toEqual({ root: 3, unlisted: 1 });
    for (const listed of [unrooted, planted, rooted]) {
      expect(await rootIdOf(listed.space)).toBe(await profileIdOf(listed));
    }
    expect(await rootIdOf(unlisted.space)).toBeUndefined();

    const again = await profileSpaceRoot(config(), { load });
    expect(again.summary).toEqual({ root: 3, unlisted: 1 });
  });

  describe("what a run writes", () => {
    /**
     * Applies the plan unless `inspectOnly`, then returns, per repaired
     * space, the entities that differ from the snapshot, with each one's
     * value, and the space cell's id.
     */
    const written = async (inspectOnly: boolean) => {
      const plan = await profileSpaceRoot(config(), { load });
      if (!inspectOnly) {
        await profileSpaceRoot(
          config({ expectedInspection: plan.inspection }),
          { load },
        );
      }
      const spaceCells = Object.fromEntries(
        [unrooted, planted].map((listed) => [
          listed.space,
          runtimeAs(admin).getSpaceCell(listed.space as MemorySpace)
            .getAsNormalizedFullLink().id,
        ]),
      );
      await stop();
      const out: Record<string, { spaceCell: string; differ: unknown[] }> = {};
      for (const listed of [unrooted, planted]) {
        const live = discoverSpaceDbs({ dirs: [storeDir], defaultRoots: false })
          .find((d) => d.did === listed.space)!;
        const before = openSpace(`${snapshotDir}/${listed.space}.sqlite`);
        const after = openSpace(live.path);
        try {
          const diff = diffFingerprints(
            contentFingerprint(before),
            contentFingerprint(after),
          );
          expect(diff.removed).toEqual([]);
          out[listed.space] = {
            spaceCell: spaceCells[listed.space],
            differ: [...diff.added, ...diff.changed].map((entity) => ({
              id: entity.id,
              value: getValueAt(after, { id: entity.id }).value,
            })),
          };
        } finally {
          before.close();
          after.close();
        }
      }
      return out;
    };

    it("writes nothing when it only inspects", async () => {
      const out = await written(true);
      expect(out[unrooted.space].differ).toEqual([]);
      expect(out[planted.space].differ).toEqual([]);
    });

    it("writes the space cell of a space it repairs, and one empty content-addressed document", async () => {
      const out = await written(false);
      for (const listed of [unrooted, planted]) {
        const { spaceCell, differ } = out[listed.space];
        const ids = differ.map((entity) => (entity as { id: string }).id);
        expect(ids).toContain(spaceCell);
        const others = differ.filter((entity) =>
          (entity as { id: string }).id !== spaceCell
        );
        expect(others).toHaveLength(1);
        expect((others[0] as { id: string }).id.startsWith("cid:")).toBe(true);
        expect((others[0] as { value: unknown }).value).toEqual({});
      }
    });
  });

  it("repairs an unlisted profile it is given by address", async () => {
    const cells = [`//${unlisted.space}/${unlisted.id}`];
    const plan = await profileSpaceRoot(config({ cells }), { load });
    expect(plan.rows.map((row) => row.status)).toEqual(["unrooted"]);
    await profileSpaceRoot(
      config({ cells, expectedInspection: plan.inspection }),
      { load },
    );
    expect(await rootIdOf(unlisted.space)).toBe(await profileIdOf(unlisted));
  });

  it("returns one row for a profile named twice", async () => {
    const cell = `//${unrooted.space}/${unrooted.id}`;
    const plan = await profileSpaceRoot(config({ cells: [cell, cell] }), {
      load,
    });
    expect(plan.rows.map((row) => row.status)).toEqual(["unrooted"]);
  });

  it("leaves a profile whose inspection failed alone when it applies, reporting it failed", async () => {
    // The connection to one profile's space is refused for both inspections,
    // the plan's and the apply's own, and accepted after that.
    let refusals = 2;
    const flaky = (spaceConfig: SpaceConfig) => {
      if (spaceConfig.space === unrooted.space && refusals > 0) {
        refusals--;
        return Promise.reject(new Error("the connection was refused"));
      }
      return load(spaceConfig);
    };
    const plan = await profileSpaceRoot(config(), { load: flaky });
    const failedRow = plan.rows.find((row) =>
      row.named.space === unrooted.space
    );
    expect(failedRow?.status).toBe("failed");

    const applied = await profileSpaceRoot(
      config({ expectedInspection: plan.inspection }),
      { load: flaky },
    );
    const appliedRow = applied.rows.find((row) =>
      row.named.space === unrooted.space
    );
    expect(appliedRow?.status).toBe("failed");
    expect(await rootIdOf(unrooted.space)).toBeUndefined();
  });

  it("refuses to apply a receipt from another plan, and changes nothing", async () => {
    await expect(
      profileSpaceRoot(config({ expectedInspection: "not the plan" }), {
        load,
      }),
    ).rejects.toThrow("changed after inspection");
    expect(await rootIdOf(unrooted.space)).toBeUndefined();
  });
});
