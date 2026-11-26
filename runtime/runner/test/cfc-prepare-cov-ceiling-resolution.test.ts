import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

import type { JSONSchema } from "../src/builder/types.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { isVerdictReason } from "../src/cfc/verdict-reason.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-ceiling-resolution",
);
const space = signer.did();

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:ceiling-policy-module",
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

const TARGET_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { maxConfidentiality: [] } },
  },
  required: ["out"],
} as JSONSchema;

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Seeds a source whose stored label holds the module policy clause beside
  // value evidence, with the policy's manifest installed in the space where
  // `installed` says so, then copies the source into a field whose ceiling
  // admits no clause, with policy evaluation enforced. Returns the reasons
  // the preparation refused it for, each with whether it is a verdict, and
  // the diagnostics naming a module policy.
  const copyUnderCeiling = async (installed: boolean) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcPolicyEvaluation: "enforce",
    });
    if (installed) {
      // A write a `PolicyOf` clause labels installs the manifest it names.
      runtime.registerCfcPolicyManifests(space, [artifact]);
      const install = runtime.edit();
      runtime.getCell(space, "installer", {
        type: "string",
        ifc: {
          confidentiality: [{ ...POLICY, subject: { __ctOwningSpace: true } }],
        },
      } as JSONSchema, install).set("installed");
      expect((await install.commit().settled).error).toBeUndefined();
    }
    const source = runtime.getCell(space, "source");
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(
      seed,
      { ...source.getAsNormalizedFullLink(), path: [] },
      {
        value: "secret",
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: {
                confidentiality: [POLICY],
                integrity: [{ type: "Evidence" }],
              },
              origin: "derived",
              observes: "value",
            }],
          },
        },
      },
    );
    expect((await seed.commit().settled).error).toBeUndefined();
    const tx = runtime.edit();
    const value = source.withTx(tx).get();
    runtime.getCell(space, "target", TARGET_SCHEMA, tx).set(
      { out: value } as never,
    );
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    const diagnostics = tx.getCfcState().diagnostics.filter((diagnostic) =>
      diagnostic.includes("module policy")
    );
    tx.abort();
    return {
      reasons: prepared.status === "invalidated"
        ? prepared.reasons.map((reason) => ({
          reason,
          verdict: isVerdictReason(reason),
        }))
        : [],
      diagnostics,
    };
  };

  describe("a ceiling miss over a module policy clause", () => {
    // A miss evaluated over a manifest that resolves is a verdict on the
    // data. One evaluated over a manifest that does not resolve kept a clause
    // a rewrite might have cleared, so it is not.

    it("is a verdict where the manifest resolves", async () => {
      const { reasons, diagnostics } = await copyUnderCeiling(true);
      expect(reasons).toEqual([{
        reason: expect.stringContaining("maxConfidentiality failed at /out"),
        verdict: true,
      }]);
      expect(diagnostics).toEqual([]);
    });

    it("is no verdict, and names the missing manifest, where the manifest does not resolve", async () => {
      const { reasons, diagnostics } = await copyUnderCeiling(false);
      expect(reasons).toEqual([{
        reason: "maxConfidentiality failed at /out",
        verdict: false,
      }]);
      expect(diagnostics).toEqual([
        `policy-evaluation(enforce): module policy missing-manifest digest ${artifact.policyDigest} at input requirement /out`,
      ]);
    });
  });
});
