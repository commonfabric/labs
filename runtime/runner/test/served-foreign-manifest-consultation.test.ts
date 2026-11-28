import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { getLoggerCountsBreakdown } from "@commonfabric/logger";
import * as Engine from "@commonfabric/memory/v2/engine";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { ServingWaves } from "./support/serving-waves.ts";

const signer = await Identity.fromPassphrase(
  "served foreign manifest consultation",
);
const owner = await Identity.fromPassphrase(
  "served foreign manifest consultation owner",
);
const ownerSpace = owner.did() as MemorySpace;

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:served-foreign-manifest-consultation",
  symbol: "rules",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

/** The module policy the foreign value is labeled with, bound to its space. */
const reference = {
  type: CFC_ATOM_TYPE.Policy,
  policyRefKind: "module",
  moduleIdentity: artifact.manifest.moduleIdentity,
  symbol: artifact.manifest.symbol,
  policyDigest: artifact.policyDigest,
  subject: ownerSpace,
};

/** A string labeled with that policy, bound to the space it is stored in. */
const policyOfSchema = {
  type: "string",
  ifc: {
    confidentiality: [{
      ...reference,
      subject: { __ctOwningSpace: true },
    }],
  },
} as const;

/** The count of foreign writes the serving wave has refused at its seal. */
const foreignWriteRefusals = (): number =>
  getLoggerCountsBreakdown()["wave-accumulator"]?.["foreign-write-refused"]
    ?.warn ?? 0;

describe("served foreign manifest consultation", () => {
  // A derivation served in one space reads a value the owner stored in the
  // owner's own space, and the CFC boundary consults that value's module
  // policy manifest where the value lives. The serving wave holds no write
  // grant for the owner's space.

  let waves: ServingWaves;
  let ownerRuntime: Runtime;
  let ownerStorage: EmulatedStorageManager;

  beforeEach(async () => {
    waves = await ServingWaves.open(signer);
    ownerStorage = EmulatedStorageManager.connectTo(waves.server, {
      as: owner,
      id: "owner",
    });
    ownerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: ownerStorage,
    });
    ownerRuntime.registerCfcPolicyManifests(undefined, [artifact]);
    // A write labeled with the policy installs its manifest beside it.
    const seeded = await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell(ownerSpace, "secret", policyOfSchema, tx)
        .set("held by the owner");
    });
    expect(seeded.error).toBeUndefined();
    await ownerStorage.synced();
    waves.serve();
  });

  afterEach(async () => {
    await ownerRuntime.dispose();
    await ownerStorage.close();
    await waves.dispose();
  });

  /**
   * Runs a derivation that consults the owner's value's manifest in the
   * owner's space, and then does `write`, and returns its commit's result. The
   * derivation reads the value itself only when `readsValue`, since a write of
   * anything after that read would carry the value's label. The serving
   * replica holds the manifest only when `manifestLoaded`, so the consultation
   * finds it present or absent accordingly.
   */
  const deriveFromForeignValue = async (
    { manifestLoaded, readsValue = true, write = () => {} }: {
      manifestLoaded: boolean;
      readsValue?: boolean;
      write?: (tx: ReturnType<Runtime["edit"]>) => void;
    },
  ) => {
    const { runtime } = waves;
    const foreign = runtime.getCell<string>(ownerSpace, "secret");
    await foreign.sync();
    if (manifestLoaded) {
      await runtime.getCellFromEntityId(
        ownerSpace,
        cfcPolicyManifestDocId(artifact.policyDigest),
      ).sync();
    }
    const tx = runtime.edit();
    stampWaveRunContext(tx, { actionId: "derive", kind: "derivation" });
    if (readsValue) {
      expect(foreign.withTx(tx).get()).toBe("held by the owner");
    }
    const consulted = runtime.resolveCfcPolicyManifest(
      reference,
      tx,
      ownerSpace,
    );
    expect(consulted !== undefined).toBe(manifestLoaded);
    write(tx);
    return await tx.commit().settled;
  };

  it("commits a derivation that writes its own space, without refusing a foreign write", async () => {
    const before = foreignWriteRefusals();
    const ownerSeq = Engine.serverSeq(
      await waves.server.engineForSpace(ownerSpace),
    );
    const derived = waves.runtime.getCell<boolean>(waves.space, "derived");

    const result = await deriveFromForeignValue({
      manifestLoaded: true,
      readsValue: false,
      write: (tx) => derived.withTx(tx).set(true),
    });
    await waves.commitAll();

    expect(result.error).toBeUndefined();
    expect(foreignWriteRefusals()).toBe(before);
    expect(await derived.pull()).toBe(true);
    expect(
      Engine.serverSeq(await waves.server.engineForSpace(ownerSpace)),
      "the owner's space took no commit",
    ).toBe(ownerSeq);
  });

  it("commits a derivation that writes its own space and finds the manifest absent", async () => {
    const ownerSeq = Engine.serverSeq(
      await waves.server.engineForSpace(ownerSpace),
    );
    const derived = waves.runtime.getCell<boolean>(waves.space, "derived");

    const result = await deriveFromForeignValue({
      manifestLoaded: false,
      readsValue: false,
      write: (tx) => derived.withTx(tx).set(true),
    });
    await waves.commitAll();

    expect(result.error).toBeUndefined();
    expect(await derived.pull()).toBe(true);
    expect(
      Engine.serverSeq(await waves.server.engineForSpace(ownerSpace)),
      "the owner's space took no commit",
    ).toBe(ownerSeq);
  });

  it("commits a derivation that writes nothing and finds the manifest absent", async () => {
    const before = foreignWriteRefusals();
    const ownerSeq = Engine.serverSeq(
      await waves.server.engineForSpace(ownerSpace),
    );

    const result = await deriveFromForeignValue({ manifestLoaded: false });
    await waves.commitAll();

    expect(result.error).toBeUndefined();
    expect(foreignWriteRefusals()).toBe(before);
    expect(
      Engine.serverSeq(await waves.server.engineForSpace(ownerSpace)),
      "the owner's space took no commit",
    ).toBe(ownerSeq);
  });

  it("refuses a derivation that writes the owner's space", async () => {
    const before = foreignWriteRefusals();
    const { runtime } = waves;

    const result = await deriveFromForeignValue({
      manifestLoaded: true,
      write: (tx) =>
        runtime.getCell<string>(ownerSpace, "secret", undefined, tx)
          .set("overwritten"),
    });

    expect(result.error?.message).toContain("foreign-space write refused");
    expect(foreignWriteRefusals()).toBe(before + 1);
  });
});
