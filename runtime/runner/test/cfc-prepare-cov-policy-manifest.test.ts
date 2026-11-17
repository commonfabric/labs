import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-policy-manifest",
);
const space = signer.did();

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

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  const start = (): Runtime => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    return runtime;
  };

  describe("a label carried into a document", () => {
    // A module policy clause a write carries into a document needs its
    // manifest installed in that document's space beside it.

    // Seeds `source` with a stored label holding the module policy clause,
    // then copies its value into `copy` and commits.
    const copyLabeledValue = async (runtime: Runtime) => {
      const source = runtime.getCell(space, "source");
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, {
        ...source.getAsNormalizedFullLink(),
        path: [],
      }, {
        value: "secret",
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality: [POLICY] } }],
          },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      const copy = runtime.getCell(space, "copy");
      const tx = runtime.edit();
      copy.withTx(tx).set(source.withTx(tx).get());
      const result = await tx.commit().settled;
      const read = runtime.edit();
      const stored = readStoredCfcMetadata(
        read,
        copy.getAsNormalizedFullLink(),
      );
      read.abort();
      return {
        error: result.error,
        confidentiality: (stored?.labelMap.entries ?? []).flatMap((entry) =>
          entry.label.confidentiality ?? []
        ),
      };
    };

    it("installs a manifest the runtime knows and stores the clause", async () => {
      const runtime = start();
      runtime.registerCfcPolicyManifests(space, [artifact]);
      const { error, confidentiality } = await copyLabeledValue(runtime);
      expect(error).toBeUndefined();
      expect(confidentiality).toContainEqual(POLICY);
    });

    it("refuses the write where no manifest can be installed", async () => {
      const runtime = start();
      const { error, confidentiality } = await copyLabeledValue(runtime);
      expect(String(error?.message)).toContain(
        `cfcPolicyManifest: manifest ${artifact.policyDigest} is not installed in ${space}`,
      );
      expect(confidentiality).toEqual([]);
    });
  });

  describe("a `PolicyOf` schema clause", () => {
    const SCHEMA = {
      type: "string",
      ifc: {
        confidentiality: [{ ...POLICY, subject: { __ctOwningSpace: true } }],
      },
    } as const;

    it("binds the owning space where the installed manifest resolves", async () => {
      const runtime = start();
      runtime.registerCfcPolicyManifests(space, [artifact]);
      const tx = runtime.edit();
      runtime.getCell(space, "policy-of", SCHEMA, tx).set("secret");
      expect((await tx.commit().settled).error).toBeUndefined();
    });

    it("refuses the write where the transaction cannot resolve the manifest it installed", async () => {
      // The transaction's manifest lookup is what the bound clause is later
      // evaluated through, so a lookup that disagrees with the install
      // fails closed.

      const runtime = start();
      runtime.registerCfcPolicyManifests(space, [artifact]);
      const tx = runtime.edit();
      tx.resolveCfcPolicyManifest = () => undefined;
      runtime.getCell(space, "policy-of-unresolved", SCHEMA, tx).set("secret");
      const result = await tx.commit().settled;
      expect(String(result.error?.message)).toContain(
        "cfcPolicyManifest: PolicyOf reference did not resolve",
      );
    });
  });
});
