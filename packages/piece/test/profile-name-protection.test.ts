import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  getDerivedInternalCellLink,
  getPatternIdentityRef,
  type IExtendedStorageTransaction,
  isLink,
  parseLink,
  resolveEntryIdentity,
  Runtime,
  systemPatternSource,
} from "@commonfabric/runner";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../../runner/src/storage/v2-emulate.ts";
import { newSharedServer } from "../../runner/test/memory-v2-test-utils.ts";

import { seedStoredEnvelope } from "../../runner/test/cfc-seed-envelope.ts";
import {
  inspectProfileNameProtection,
  type ProfileNameProtectionInspection,
  repairProfileNameProtection,
} from "../src/ops/profile-name-protection.ts";

const owner = await Identity.fromPassphrase("profile name protection owner");
const profileSpace =
  (await Identity.fromPassphrase("profile name protection space")).did();
const route = "/api/patterns/system/profile-home.tsx";
// The complete profile source from 9b8ec42df exercises its real dynamic name chain.
const previous = Deno.readTextFileSync(
  new URL("./fixtures/profile-home-dynamic-name.tsx.txt", import.meta.url),
);
const current = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);

describe("profile name protection repair", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let profile: Cell<unknown>;
  let served: { contents: string; identity: string };

  beforeEach(async () => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: owner });
    served = {
      contents: previous,
      identity: await resolveEntryIdentity(
        route,
        () => Promise.resolve(previous),
      ),
    };
    runtime = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: manager,
      fetch: (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return Promise.resolve(
          new Response(
            url.pathname === route
              ? (url.searchParams.has("identity")
                ? served.identity
                : served.contents)
              : "not found",
            { status: url.pathname === route ? 200 : 404 },
          ),
        );
      },
    });
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: route,
      files: [{ name: route, contents: previous }],
    }, { space: profileSpace, tx });
    profile = runtime.getCell(profileSpace, "legacy-profile");
    runtime.runner.run(tx, pattern, { initialName: "Saved name" }, profile, {
      sourceOrigin: systemPatternSource("system/profile-home.tsx"),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await profile.pull();
    await runtime.idle();
    // Reproduce the persisted omission made by the dynamic-name runtime: both
    // the named lift output and its terminal cell existed without envelopes.
    const descriptor = pattern.derivedInternalCells!.find((item) =>
      item.partialCause === "name"
    )!;
    let target = getDerivedInternalCellLink(profile, descriptor);
    const strip = runtime.edit();
    for (let depth = 0; depth < 2; depth++) {
      const physical = { ...target, path: [] };
      const envelope = strip.readOrThrow(physical) as Record<
        string,
        FabricValue
      >;
      const { cfc: _cfc, ...legacy } = envelope;
      seedStoredEnvelope(strip, physical, legacy);
      const value = strip.readValueOrThrow(target);
      if (!isLink(value)) break;
      target = parseLink(value, target);
    }
    runtime.prepareTxForCommit(strip);
    expect((await strip.commit()).error).toBeUndefined();
    served = {
      contents: current,
      identity: await resolveEntryIdentity(
        route,
        () => Promise.resolve(current),
      ),
    };
    expect(await runtime.sourceReconciler.reconcile(profile)).toBe("updated");
    await runtime.runner.idlePointerMaintenance();
    await runtime.idle();
    await profile.pull();
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  async function withInspectionTransaction(
    tx: IExtendedStorageTransaction,
    run: () => Promise<void>,
  ) {
    const identity = getPatternIdentityRef(profile)!;
    const program = await runtime.patternManager
      .getPatternSourceProgramByIdentity(
        identity.identity,
        profileSpace,
      );
    const pattern = await runtime.patternManager.loadPatternByIdentity(
      identity.identity,
      identity.symbol,
      profileSpace,
      { repairCache: false },
    );
    const read = runtime.readTx();
    // Artifact loading has its own transactions. Hold its verified results
    // fixed so the injected transaction belongs only to the inspection.
    using _source = stub(
      runtime.patternManager,
      "getPatternSourceProgramByIdentity",
      () => Promise.resolve(program),
    );
    using _pattern = stub(
      runtime.patternManager,
      "loadPatternByIdentity",
      () => Promise.resolve(pattern),
    );
    using _read = stub(runtime, "readTx", (provided) => provided ?? read);
    using _edit = stub(runtime, "edit", () => tx);
    await run();
  }

  async function expectStoredStateRefused(
    change: (
      tx: IExtendedStorageTransaction,
      before: ProfileNameProtectionInspection,
    ) => void,
    message: string,
  ) {
    const before = await inspectProfileNameProtection(runtime, profile);
    const tx = runtime.edit();
    change(tx, before);
    await withInspectionTransaction(tx, async () => {
      // Expose an invalid stored snapshot to inspection without persisting it
      // through the runtime's own metadata validation.
      await expect(inspectProfileNameProtection(runtime, profile)).rejects
        .toThrow(message);
    });
    expect(await inspectProfileNameProtection(runtime, profile)).toEqual(
      before,
    );
  }

  it("refuses a detached profile or an incomplete source setup", async () => {
    for (const key of ["patternSource", "patternSetupIdentity"] as const) {
      await expectStoredStateRefused((tx) => {
        profile.withTx(tx).setMetaRaw(
          key,
          undefined,
          rawMetaWriteAuthorization,
        );
      }, "source-attached profile with completed setup");
    }
  });

  it("requires a readable protection envelope on the profile root", async () => {
    await expectStoredStateRefused((tx, before) => {
      seedStoredEnvelope(tx, { ...before.profile, path: ["cfc"] }, undefined);
    }, "profile's protection envelope is unavailable");
  });

  it("requires the name projection to identify its exact named cell", async () => {
    await expectStoredStateRefused((tx, before) => {
      seedStoredEnvelope(tx, {
        ...before.profile,
        path: ["value", "name"],
      }, "Unlinked name");
    }, "not a supported cell link");
    await expectStoredStateRefused((tx, before) => {
      seedStoredEnvelope(tx, {
        ...before.profile,
        path: ["value", "name"],
      }, runtime.getCell(profileSpace, "unrelated name cell").getAsLink());
    }, "outside its named internal cell");
  });

  it("refuses a name chain that crosses a storage scope or space", async () => {
    await expectStoredStateRefused((tx, before) => {
      const target = { ...before.positions[0].target, scope: "user" as const };
      seedStoredEnvelope(tx, {
        ...before.profile,
        path: ["value", "name"],
      }, runtime.getCellFromLink(target).getAsLink());
    }, "leaves its supported space or scope");
    await expectStoredStateRefused((tx, before) => {
      seedStoredEnvelope(tx, {
        ...before.positions[0].target,
        path: ["value"],
      }, runtime.getCell(owner.did(), "foreign name cell").getAsLink());
    }, "leaves its supported space or scope");
  });

  it("refuses unreadable or conflicting protection already on a name cell", async () => {
    await expectStoredStateRefused((tx, before) => {
      seedStoredEnvelope(tx, {
        ...before.positions[0].target,
        path: ["cfc"],
      }, { version: 99 });
    }, "stored CFC metadata version 99");
    await expectStoredStateRefused((tx, before) => {
      seedStoredEnvelope(tx, {
        ...before.positions[0].target,
        path: ["cfc"],
      }, {
        version: 1,
        schemaHash: "missing-schema",
        labelMap: { version: 1, entries: [] },
      });
    }, "schema");
    await expectStoredStateRefused((tx, before) => {
      const source = { ...before.profile, path: ["avatar"] };
      const value = tx.readValueOrThrow(source);
      if (!isLink(value)) throw new Error("Expected the profile's avatar link");
      const avatar = parseLink(value, source);
      const metadata = tx.readOrThrow({ ...avatar, path: ["cfc"] });
      seedStoredEnvelope(tx, {
        ...before.positions[0].target,
        path: ["cfc"],
      }, metadata);
    }, "conflicting or incomplete existing protection");
  });

  it("requires a retained identity and verified source and pattern", async () => {
    await expect(
      inspectProfileNameProtection(
        runtime,
        runtime.getCell(profileSpace, "empty"),
      ),
    ).rejects.toThrow("no retained pattern identity");
    {
      using _source = stub(
        runtime.patternManager,
        "getPatternSourceProgramByIdentity",
        () => Promise.resolve(undefined),
      );
      await expect(inspectProfileNameProtection(runtime, profile)).rejects
        .toThrow("verified profile source is unavailable or unsupported");
    }
    {
      using _pattern = stub(
        runtime.patternManager,
        "loadPatternByIdentity",
        () => Promise.resolve(undefined),
      );
      await expect(inspectProfileNameProtection(runtime, profile)).rejects
        .toThrow("verified profile pattern is unavailable");
    }
    expect((await inspectProfileNameProtection(runtime, profile)).status).toBe(
      "repairable",
    );
  });

  it("requires the profile source to declare the supported named cell", async () => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: route,
      files: [{
        name: route,
        contents: current.replace('.for("name")', '.for("differentName")'),
      }],
    }, { space: profileSpace, tx });
    const renamed = runtime.getCell(profileSpace, "renamed-internal-cell");
    runtime.runner.run(tx, pattern, {}, renamed, {
      sourceOrigin: systemPatternSource("system/profile-home.tsx"),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await renamed.pull();
    await runtime.idle();
    await expect(inspectProfileNameProtection(runtime, renamed)).rejects
      .toThrow("does not have the supported named name cell");
  });

  it("reports a concurrent write without installing the inspected protection", async () => {
    const before = await inspectProfileNameProtection(runtime, profile);
    const target = before.positions.at(-1)!.target;
    const tx = runtime.edit();
    const commit = tx.commit.bind(tx);
    const edit = runtime.edit.bind(runtime);
    await withInspectionTransaction(tx, async () => {
      using _commit = stub(tx, "commit", async () => {
        const concurrent = edit();
        concurrent.writeValueOrThrow(target, "Concurrent name");
        runtime.prepareTxForCommit(concurrent);
        expect((await concurrent.commit()).error).toBeUndefined();
        return await commit();
      });
      await expect(
        repairProfileNameProtection(runtime, profile, before.inspection),
      ).rejects.toThrow("Transaction consistency violated");
    });
    const after = await inspectProfileNameProtection(runtime, profile);
    expect(after.name).toBe("Concurrent name");
    expect(
      after.positions.every((position) => position.protection === "missing"),
    )
      .toBe(true);
  });

  it("protects the existing saved name without replacing its cells", async () => {
    const before = await inspectProfileNameProtection(runtime, profile);
    expect(before.status).toBe("repairable");
    expect(before.name).toBe("Saved name");
    expect(before.owner).toBe(owner.did());
    expect(before.positions).toHaveLength(2);
    const after = await repairProfileNameProtection(
      runtime,
      profile,
      before.inspection,
    );
    expect(after.status).toBe("protected");
    expect(after.name).toBe(before.name);
    expect(after.positions.map((position) => position.target)).toEqual(
      before.positions.map((position) => position.target),
    );
    expect(
      await repairProfileNameProtection(runtime, profile, after.inspection),
    ).toEqual(after);

    // A separate replica learns the persisted protection without running the
    // profile. Ordinary string writes and intermediate-link retargets fail.
    await manager.synced();
    const coldManager = EmulatedStorageManager.connectTo(server, { as: owner });
    const cold = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: coldManager,
    });
    try {
      const coldProfile = cold.getCellFromLink(before.profile);
      const coldInspection = await inspectProfileNameProtection(
        cold,
        coldProfile,
      );
      expect(coldInspection).toEqual(after);
      for (const { target } of after.positions) {
        const attack = cold.edit();
        cold.getCellFromLink(target, { type: "string" }, attack).set(
          "Attacker name",
        );
        cold.prepareTxForCommit(attack);
        expect((await attack.commit()).error?.message).toMatch(
          /writeAuthorizedBy|missing schema write-policy/,
        );
      }
      const retarget = cold.edit();
      retarget.writeValueOrThrow(after.positions[0].target, "Replacement name");
      cold.prepareTxForCommit(retarget);
      expect((await retarget.commit()).error?.message).toContain(
        "missing schema write-policy",
      );
      expect((await inspectProfileNameProtection(cold, coldProfile)).name).toBe(
        "Saved name",
      );
    } finally {
      await cold.dispose();
    }

    const edit = runtime.edit();
    profile.withTx(edit).key("setName").send({ name: "Owner rename" });
    runtime.prepareTxForCommit(edit);
    expect((await edit.commit()).error).toBeUndefined();
    await profile.pull();
    await runtime.idle();
    expect((await inspectProfileNameProtection(runtime, profile)).name).toBe(
      "Owner rename",
    );
    const next = current + "\n// Follow-up source release.\n";
    served = {
      contents: next,
      identity: await resolveEntryIdentity(route, () => Promise.resolve(next)),
    };
    expect(await runtime.sourceReconciler.reconcile(profile)).toBe("updated");
    await runtime.runner.idlePointerMaintenance();
    await runtime.idle();
    await profile.pull();
    expect(profile.key("name").asSchema({ type: "string" }).get()).toBe(
      "Owner rename",
    );
    expect((await inspectProfileNameProtection(runtime, profile)).status).toBe(
      "protected",
    );
  });
  it("refuses a stale inspection without protecting the changed name", async () => {
    const before = await inspectProfileNameProtection(runtime, profile);
    const change = runtime.edit();
    change.writeValueOrThrow(
      before.positions.at(-1)!.target,
      "Changed since review",
    );
    runtime.prepareTxForCommit(change);
    expect((await change.commit()).error).toBeUndefined();
    await expect(
      repairProfileNameProtection(runtime, profile, before.inspection),
    ).rejects.toThrow("changed after inspection");
    const after = await inspectProfileNameProtection(runtime, profile);
    expect(after.status).toBe("repairable");
    expect(after.name).toBe("Changed since review");
  });

  it("refuses a different login even though the schema declares current principal", async () => {
    await manager.synced();
    const stranger = await Identity.fromPassphrase("profile repair stranger");
    const otherManager = EmulatedStorageManager.connectTo(server, {
      as: stranger,
    });
    const other = new Runtime({
      apiUrl: new URL("https://profile.test"),
      storageManager: otherManager,
    });
    try {
      await expect(
        inspectProfileNameProtection(
          other,
          other.getCellFromLink(profile.getAsNormalizedFullLink()),
        ),
      ).rejects.toThrow("existing profile owner's");
    } finally {
      await other.dispose();
    }
  });
  it("leaves a newly created protected profile unchanged", async () => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: route,
      files: [{ name: route, contents: current }],
    }, { space: profileSpace, tx });
    const fresh = runtime.getCell(profileSpace, "fresh-profile");
    runtime.runner.run(tx, pattern, {}, fresh, {
      sourceOrigin: systemPatternSource("system/profile-home.tsx"),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await fresh.pull();
    await runtime.idle();
    const before = await inspectProfileNameProtection(runtime, fresh);
    expect(before.status).toBe("protected");
    expect(before.positions).toHaveLength(1);
    expect(await repairProfileNameProtection(runtime, fresh, before.inspection))
      .toEqual(before);
  });

  it("refuses a name chain with an unsupported value", async () => {
    const before = await inspectProfileNameProtection(runtime, profile);
    const tx = runtime.edit();
    tx.writeValueOrThrow(before.positions.at(-1)!.target, { nested: "name" });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await expect(inspectProfileNameProtection(runtime, profile)).rejects
      .toThrow("unsupported legacy cell layout");
  });
});
