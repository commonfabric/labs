import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  getDerivedInternalCellLink,
  Runtime,
  systemPatternSource,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { seedStoredEnvelope } from "../../runner/test/cfc-seed-envelope.ts";
import { type SpaceConfig } from "../lib/piece.ts";
import { profileNameProtection } from "../lib/profile-name-protection.ts";

const owner = await Identity.fromPassphrase("cli name protection owner");
const space = (await Identity.fromPassphrase("cli name protection space"))
  .did();
const route = "/api/patterns/system/profile-home.tsx";
const contents = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);

describe("profileNameProtection()", () => {
  let runtime: Runtime;
  let profile: Cell<unknown>;
  let requests: SpaceConfig[];
  let disposals: number;

  beforeEach(async () => {
    runtime = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: StorageManager.emulate({ as: owner }),
    });
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: route,
      files: [{ name: route, contents }],
    }, { space, tx });
    profile = runtime.getCell(space, "cli repair profile");
    runtime.runner.run(tx, pattern, { initialName: "Saved name" }, profile, {
      sourceOrigin: systemPatternSource("system/profile-home.tsx"),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await profile.pull();
    await runtime.idle();
    const descriptor = pattern.derivedInternalCells!.find((item) =>
      item.partialCause === "name"
    )!;
    const target = getDerivedInternalCellLink(profile, descriptor);
    const strip = runtime.edit();
    const { cfc: _cfc, ...legacy } = strip.readOrThrow(target) as Record<
      string,
      FabricValue
    >;
    seedStoredEnvelope(strip, target, { ...legacy, value: "Saved name" });
    runtime.prepareTxForCommit(strip);
    expect((await strip.commit()).error).toBeUndefined();
    requests = [];
    disposals = 0;
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  function load(config: SpaceConfig): Promise<PiecesController> {
    requests.push(config);
    const pieces = new PiecesController({ as: owner, space }, runtime, {
      deferSpaceCellSync: true,
    });
    pieces.dispose = () => {
      disposals++;
      return Promise.resolve();
    };
    return Promise.resolve(pieces);
  }

  function config() {
    return {
      cell: `//${space}/${profile.getAsNormalizedFullLink().id}`,
      apiUrl: "https://profile.test",
      identity: "/unread.key",
      space: owner.did(),
    };
  }

  it("inspects the explicit profile space and applies only the reviewed receipt", async () => {
    const before = await profileNameProtection(config(), load);
    expect(before.status).toBe("repairable");
    expect(before.name).toBe("Saved name");
    expect(before.profile.id).toBe(profile.getAsNormalizedFullLink().id);
    expect(before.profile.space).toBe(space);
    const after = await profileNameProtection({
      ...config(),
      expectedInspection: before.inspection,
    }, load);
    expect(after.status).toBe("protected");
    expect(after.name).toBe(before.name);
    expect(after.positions.map((position) => position.target)).toEqual(
      before.positions.map((position) => position.target),
    );
    expect(requests.map((request) => request.space)).toEqual([space, space]);
    expect(disposals).toBe(2);
  });

  it("disposes the connection when the exact target is not a profile", async () => {
    const empty = runtime.getCell(space, "not a profile");
    await expect(profileNameProtection({
      ...config(),
      cell: `//${space}/${empty.getAsNormalizedFullLink().id}`,
    }, load)).rejects.toThrow("no retained pattern identity");
    expect(requests).toHaveLength(1);
    expect(disposals).toBe(1);
  });
});
