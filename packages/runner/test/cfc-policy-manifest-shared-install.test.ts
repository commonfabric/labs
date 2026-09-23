import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import type { EventHandler } from "../src/scheduler/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import { isRetryableCommitRejection } from "../src/storage/rejection.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const signer = await Identity.fromPassphrase("shared manifest install");
const space = signer.did();

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:shared-install-module",
  symbol: "rules",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

// A different artifact stored under `artifact`'s digest: what a forged or
// colliding manifest at that content address looks like.
const collidingArtifact = buildCfcPolicyArtifactManifest({
  ...artifact.manifest,
  symbol: "otherRules",
});

const policyOfSchema = {
  type: "string",
  ifc: {
    confidentiality: [{
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: artifact.manifest.moduleIdentity,
      symbol: artifact.manifest.symbol,
      policyDigest: artifact.policyDigest,
      subject: { __ctOwningSpace: true },
    }],
  },
} as const;

describe("cfc-policy-manifest-shared-install", () => {
  // Two runtimes on one server model two participants of a shared space.
  // Each writes a value labeled with the same PolicyOf, so each installs the
  // same content-addressed manifest document beside its value. The second
  // runtime has never loaded that document when it writes.
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
    rtA.registerCfcPolicyManifests(undefined, [artifact]);
    rtB.registerCfcPolicyManifests(undefined, [artifact]);
  });

  afterEach(async () => {
    // A rejected commit leaves its catch-up load in flight; let it land
    // rather than failing against a closed client.
    await storageB.synced();
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  // A labeled write the way a retrying writer makes it: a retryable
  // rejection runs the transaction again once storage has caught up.
  const writeLabeled = (runtime: Runtime, name: string) =>
    runtime.editWithRetry((tx) => {
      runtime.getCell(space, name, policyOfSchema, tx).set(`${name} secret`);
    });

  // What the server holds, read through a runtime that has loaded nothing,
  // so no replica left behind by the writers can answer instead.
  const serverValue = async (id: string, schema?: JSONSchema) => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const cell = runtime.getCellFromEntityId(space, id, [], schema);
      await cell.sync();
      return cell.get();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  };

  const briefId = (name: string) =>
    rtA.getCell(space, name, policyOfSchema).getAsNormalizedFullLink().id;

  const manifestId = cfcPolicyManifestDocId(artifact.policyDigest);

  it("reports a stale absence of the installed manifest as a retryable conflict", async () => {
    expect((await writeLabeled(rtA, "a-brief")).error).toBeUndefined();

    const tx = rtB.edit();
    rtB.getCell(space, "b-brief", policyOfSchema, tx).set("b-brief secret");
    rtB.prepareTxForCommit(tx);
    const committed = await tx.commit({ resolveAt: "verdict" });

    // The guard is the transaction's confirmed read of the absent manifest:
    // the rejection names that document, which is what the retry catches up.
    expect(committed.error).toMatchObject({
      name: "ConflictError",
      conflict: { of: manifestId },
    });
    expect(isRetryableCommitRejection(committed.error!)).toBe(true);
  });

  // This case and the event case below prove only that the write lands: a
  // blind overwrite of identical bytes would pass them too. The retryable
  // conflict above and the collision case at the end are what show an
  // install never overwrites.
  it("commits a second participant's first write once the manifest is already installed", async () => {
    expect((await writeLabeled(rtA, "a-brief")).error).toBeUndefined();

    const committed = await writeLabeled(rtB, "b-brief");

    expect(committed.error).toBeUndefined();
    expect(await serverValue(briefId("b-brief"))).toBe("b-brief secret");
    expect(await serverValue(manifestId)).toEqual(artifact);
  });

  it("handles a second participant's first event that writes a labeled value", async () => {
    expect((await writeLabeled(rtA, "a-brief")).error).toBeUndefined();
    const stream = rtB.getCell<unknown>(space, "b-submit");
    const brief = rtB.getCell(space, "b-brief", policyOfSchema);
    const submit: EventHandler = (tx) => {
      brief.withTx(tx).set("b-brief secret");
    };
    rtB.scheduler.addEventHandler(submit, stream.getAsNormalizedFullLink());

    // The first participant watches for the write, so only a committed
    // value can satisfy the wait: the second participant's own replica shows
    // its optimistic write before the commit settles either way.
    const observed = rtA.getCell(space, "b-brief", policyOfSchema);
    await observed.sync();

    rtB.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {});

    await waitForCellValue<string>(
      rtA,
      observed,
      (value) => value === "b-brief secret",
      { stuckLabel: "the second participant's labeled event write" },
    );
  });

  it("refuses a second participant's write when a different manifest holds the digest", async () => {
    const forge = storageA.edit();
    forge.write({
      space,
      id: manifestId,
      type: "application/json",
      path: ["value"],
    }, collidingArtifact as never);
    expect((await forge.commit()).ok).toBeDefined();

    const committed = await writeLabeled(rtB, "b-brief");

    expect(committed.error?.message).toContain(
      "immutable destination collision",
    );
    expect(await serverValue(briefId("b-brief"))).toBeUndefined();
    expect(await serverValue(manifestId)).toEqual(collidingArtifact);
  });
});
