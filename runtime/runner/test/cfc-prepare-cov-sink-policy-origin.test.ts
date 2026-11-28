import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { CfcConfClause } from "@commonfabric/memory/v2/cfc-release-authority";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-sink-policy-origin",
);
const space = signer.did();
const elsewhere = (await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-sink-policy-origin-elsewhere",
)).did();

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:policy-module",
  symbol: "rules",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

const POLICY = {
  type: CFC_ATOM_TYPE.Policy,
  policyRefKind: "module",
  moduleIdentity: artifact.manifest.moduleIdentity,
  symbol: artifact.manifest.symbol,
  policyDigest: artifact.policyDigest,
  subject: space,
};

const address = (of: MemorySpace, id: URI) => ({
  space: of,
  id,
  scope: "space" as const,
  type: "application/json" as const,
  path: [],
});

/** The reasons that refuse the `fetchJson` request. */
const sinkReasons = (reasons: readonly string[]) =>
  reasons.filter((reason) => reason.includes("fetchJson"));

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  /**
   * Prepares a transaction that observed label metadata carrying `clause`
   * and then requested the `fetchJson` sink, whose ceiling admits nothing.
   * Returns the transaction, which wrote one document of `space`, and the
   * reasons it was refused for.
   */
  const requestAfterObserving = (clause: CfcConfClause) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
      cfcPolicyEvaluation: "enforce",
    });
    const tx = runtime.edit();
    tx.writeValueOrThrow(address(space, "of:note"), "noted");
    tx.recordCfcLabelMetadataObservation({
      target: {
        space,
        id: "of:introspected",
        scope: "space",
        path: ["cfc", "labels", "value"],
      },
      observes: "labelMetadata",
      confidentiality: [clause],
    });
    tx.recordCfcWritePolicyInput({
      kind: "sink-request",
      effectId: "introspection-egress",
      sink: "fetchJson",
      request: { url: "https://example.com" },
    });
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    return {
      tx,
      reasons: prepared.status === "invalidated" ? prepared.reasons : [],
    };
  };

  describe("a sink request after observing a module policy no read carried", () => {
    // Label metadata names no document whose space holds a copy of the
    // policy's manifest, so the policy cannot be resolved for the release.

    it("is refused as undecided, and opens no other space to the commit", () => {
      const { tx, reasons } = requestAfterObserving(POLICY);
      try {
        expect(sinkReasons(reasons)).toEqual([
          "cfcPolicyManifest: module policy did not resolve for sink-request fetchJson",
        ]);
        let thrown: unknown;
        try {
          tx.writeValueOrThrow(address(elsewhere, "of:elsewhere"), 1);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toMatchObject({
          name: "StorageTransactionWriteIsolationError",
        });
      } finally {
        tx.abort();
      }
    });

    it("is refused as a verdict where the clause names no policy", () => {
      const { tx, reasons } = requestAfterObserving("secret");
      tx.abort();
      expect(sinkReasons(reasons)).toEqual([
        expect.stringMatching(/^cfc-verdict: sink-request /),
      ]);
    });
  });
});
