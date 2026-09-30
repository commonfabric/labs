import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  buildCfcPolicyArtifactManifest,
  CFC_POLICY_MANIFEST_ID_PREFIX,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import {
  createTxCfcModulePolicyResolver,
  preparedDigestFor,
  type PreparedDigestInput,
} from "../src/cfc/mod.ts";
import { TransactionWrapper } from "../src/storage/extended-storage-transaction.ts";
import { snapshotQueryResult } from "../src/query-result-proxy.ts";
import { isAuthorizationRead } from "../src/storage/reactivity-log.ts";

const signer = await Identity.fromPassphrase("manifest-consultation");
const reference = cfcAtom.modulePolicyRef(
  "sha256:module",
  "releaseRules",
  "sha256:manifest",
  "did:key:subject",
);

const base: PreparedDigestInput = {
  consumedReads: [],
  attemptedWrites: [],
  writes: [],
  writeAttemptLog: [],
  dereferenceTraces: [],
  triggerReads: [],
  writePolicyInputs: [],
};

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
  origin?: string;
};

const storedDocument = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
):
  | { value?: unknown; cfc?: { labelMap?: { entries: StoredEntry[] } } }
  | undefined => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      value?: unknown;
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id);
};

// Seed a source doc whose `secret` field carries a confidentiality label, so
// a transaction that reads it derives a tainted per-tx flow join.
const seedSecretSource = async (runtime: Runtime, name: string) => {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    signer.did(),
    name,
    {
      type: "object",
      properties: { secret: { type: "string" } },
    },
  );
  const sourceId = parseLink(sourceCell.getAsLink()).id!;
  writeSeedEnvelopeDoc(seed, signer.did());
  seedStoredEnvelope(seed, {
    space: signer.did(),
    scope: "space",
    id: sourceId,
    path: [],
  }, {
    value: { secret: "s3cr3t" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: ["secret"] },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

const persistenceArtifact = (moduleIdentity: string) =>
  buildCfcPolicyArtifactManifest({
    formatVersion: 1,
    moduleIdentity,
    symbol: "rules",
    template: {
      templateVersion: 1,
      exchangeRules: [],
      dependencies: { authorityOnly: [], dataBearing: [] },
      integrityRequirements: {},
    },
  });

// Run the consultation flow that persists a manifest inside a tainted
// transaction: read the labeled source, write a derived value whose declared
// store policy covers the join and carries the module-policy reference, and
// prepare twice — the first prepare installs the manifest document (a
// privileged write now in the journal), the recorded consultation invalidates
// the prepared state, and the second prepare re-measures the journal with the
// manifest write present.
const runTaintedManifestPersistence = async (
  runtime: Runtime,
  artifact: ReturnType<typeof buildCfcPolicyArtifactManifest>,
  names: { source: string; derived: string },
  escalate: "enforce-strict" | undefined,
) => {
  runtime.registerCfcPolicyManifests(undefined, [artifact]);
  await seedSecretSource(runtime, names.source);

  const tx = runtime.edit();
  if (escalate !== undefined) {
    tx.setCfcEnforcementMode(escalate);
  }
  const source = runtime.getCell(signer.did(), names.source, undefined, tx);
  const raw = source.getRaw() as { secret?: string };
  expect(raw.secret).toBe("s3cr3t");
  const derived = runtime.getCell(
    signer.did(),
    names.derived,
    {
      type: "object",
      properties: { copied: { type: "string" } },
      ifc: {
        confidentiality: ["secret", {
          type: CFC_ATOM_TYPE.Policy,
          policyRefKind: "module",
          moduleIdentity: artifact.manifest.moduleIdentity,
          symbol: artifact.manifest.symbol,
          policyDigest: artifact.policyDigest,
          subject: { __ctOwningSpace: true },
        }],
      },
    } as const,
    tx,
  );
  derived.set({ copied: `${raw.secret}!` });
  tx.prepareCfc();
  tx.recordCfcConsultedPolicyManifest({
    reference: cfcAtom.modulePolicyRef(
      artifact.manifest.moduleIdentity,
      artifact.manifest.symbol,
      artifact.policyDigest,
      "did:key:additional-subject",
    ),
    state: "absent",
  });
  expect(tx.prepareCfc()).not.toBe("");
  expect((await tx.commit()).ok).toBeDefined();
  return { tx, derivedId: derived.getAsNormalizedFullLink().id };
};

describe("module-policy manifest consultation", () => {
  it("binds present/absent state into the prepared digest", () => {
    const present = { reference, state: "present" as const };
    const absent = { reference, state: "absent" as const };
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [present],
    })).not.toBe(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [absent],
    }));
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [],
    })).toBe(preparedDigestFor(base));
  });

  it("canonicalizes consultation order", () => {
    const other = {
      reference: cfcAtom.modulePolicyRef(
        reference.moduleIdentity,
        reference.symbol,
        reference.policyDigest,
        "did:key:other",
      ),
      state: "present" as const,
    };
    const first = { reference, state: "present" as const };
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [first, other],
    })).toBe(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [other, first],
    }));

    const absent = { reference, state: "absent" as const };
    expect(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [first, absent],
    })).toBe(preparedDigestFor({
      ...base,
      consultedPolicyManifests: [absent, first],
    }));
  });

  it("records durable-loader results on the transaction", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      const present = createTxCfcModulePolicyResolver(tx, () => ({
        policyDigest: reference.policyDigest,
      }));
      expect(present(reference)).toEqual({
        policyDigest: reference.policyDigest,
      });
      expect(tx.getCfcState().consultedPolicyManifests).toEqual([{
        reference,
        state: "present",
      }]);
      tx.markCfcRelevant("manifest-consultation-test");
      tx.prepareCfc();
      expect(present(reference)).toEqual({
        policyDigest: reference.policyDigest,
      });

      const absent = createTxCfcModulePolicyResolver(tx, () => undefined);
      expect(absent(reference)).toBeUndefined();
      expect(tx.getCfcState().consultedPolicyManifests).toEqual([{
        reference,
        state: "absent",
      }]);

      const failing = createTxCfcModulePolicyResolver(tx, () => {
        throw new Error("loader failed");
      });
      expect(() => failing(reference)).toThrow("loader failed");
      expect(tx.getCfcState().consultedPolicyManifests).toEqual([{
        reference,
        state: "absent",
      }]);
      tx.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("registers, installs, resolves, and wraps durable manifests", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const artifact = buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: "sha256:durable-module",
      symbol: "rules",
      template: {
        templateVersion: 1,
        exchangeRules: [{
          name: "release",
          preCondition: {
            confidentiality: [{ thisPolicy: true }],
            integrity: ["release-guard"],
          },
          postCondition: { confidentiality: [], integrity: [] },
        }],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
    const durableReference = cfcAtom.modulePolicyRef(
      artifact.manifest.moduleIdentity,
      artifact.manifest.symbol,
      artifact.policyDigest,
      signer.did(),
    );
    try {
      expect(runtime.resolveCfcPolicyManifest(null)).toBeUndefined();
      expect(runtime.resolveCfcPolicyManifest([])).toBeUndefined();
      expect(runtime.installCfcPolicyManifest(signer.did(), {})).toBe(false);

      runtime.registerCfcPolicyManifests(undefined, [artifact]);
      expect(runtime.resolveCfcPolicyManifest(durableReference)).toEqual(
        artifact,
      );
      const install = runtime.edit();
      const schema = {
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
      runtime.getCell(
        signer.did(),
        "manifest-install-source",
        schema,
        install,
      ).set("secret");
      install.prepareCfc();
      install.recordCfcConsultedPolicyManifest({
        reference: cfcAtom.modulePolicyRef(
          artifact.manifest.moduleIdentity,
          artifact.manifest.symbol,
          artifact.policyDigest,
          "did:key:additional-subject",
        ),
        state: "absent",
      });
      install.prepareCfc();
      expect((await install.commit()).ok).toBeDefined();

      const scan = runtime.edit();
      expect(scan.readValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: cfcPolicyManifestDocId(artifact.policyDigest),
        path: [],
      })).toEqual(artifact);
      runtime.getCell(signer.did(), "manifest-scan-probe", undefined, scan)
        .get();
      expect(
        runtime.resolveCfcPolicyManifest(durableReference, scan),
      ).toEqual(artifact);
      const wrapper = new TransactionWrapper(scan);
      wrapper.recordCfcConsultedPolicyManifest({
        reference: durableReference,
        state: "present",
      });
      expect(
        wrapper.resolveCfcPolicyManifest(durableReference, signer.did()),
      ).toEqual(artifact);
      expect(wrapper.hasCfcPolicyManifest(signer.did(), durableReference)).toBe(
        true,
      );
      expect(
        wrapper.installCfcPolicyManifest(signer.did(), durableReference),
      ).toBe(true);
      scan.abort();

      const coldRuntime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      const coldRead = coldRuntime.edit();
      expect(
        coldRuntime.resolveCfcPolicyManifest(
          durableReference,
          coldRead,
          signer.did(),
        ),
      ).toEqual(artifact);
      expect(
        coldRuntime.hasCfcPolicyManifest(
          signer.did(),
          durableReference,
          coldRead,
        ),
      ).toBe(true);
      expect(
        coldRuntime.installCfcPolicyManifest(
          signer.did(),
          durableReference,
          coldRead,
        ),
      ).toBe(true);
      coldRead.abort();

      const tamper = storageManager.edit();
      expect(
        tamper.write({
          space: signer.did(),
          id: cfcPolicyManifestDocId(artifact.policyDigest),
          type: "application/json",
          path: ["value"],
        }, { forged: true }).ok,
      ).toBeDefined();
      expect((await tamper.commit()).ok).toBeDefined();
      const invalid = coldRuntime.edit();
      expect(
        coldRuntime.resolveCfcPolicyManifest(
          durableReference,
          invalid,
          signer.did(),
        ),
      ).toBeUndefined();
      invalid.abort();
      await coldRuntime.dispose();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("verifies factored manifest contents and rejects a changed referenced rule", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const rule = {
      name: "release",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: ["release-guard"],
      },
      postCondition: { confidentiality: [], integrity: [] },
    };
    const artifact = buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: "sha256:factored-module",
      symbol: "rules",
      template: {
        templateVersion: 1,
        exchangeRules: [rule],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
    const ref = cfcAtom.modulePolicyRef(
      artifact.manifest.moduleIdentity,
      artifact.manifest.symbol,
      artifact.policyDigest,
      signer.did(),
    );
    const child = runtime.getCell(signer.did(), "factored-rule")
      .getAsNormalizedFullLink();
    try {
      const seed = storageManager.edit();
      seed.write({ ...child, path: [] }, { value: rule });
      seed.write({
        space: signer.did(),
        scope: "space",
        id: cfcPolicyManifestDocId(artifact.policyDigest),
        path: [],
      }, {
        value: {
          ...artifact,
          manifest: {
            ...artifact.manifest,
            template: {
              ...artifact.manifest.template,
              exchangeRules: [createSigilLinkFromParsedLink(child)],
            },
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();
      const read = runtime.edit();
      expect(runtime.resolveCfcPolicyManifest(ref, read, signer.did())).toEqual(
        artifact,
      );
      expect(read.getCfcState().referenceObservations).toEqual([]);
      expect(
        [...read.getReadActivities!()].some((activity) =>
          activity.id === child.id && activity.path[0] === "value" &&
          isAuthorizationRead(activity.meta)
        ),
      ).toBe(true);
      read.writeValueOrThrow(
        runtime.getCell(signer.did(), "manifest-dependent-write")
          .getAsNormalizedFullLink(),
        "verified",
      );

      const tamper = storageManager.edit();
      tamper.write({ ...child, path: ["value", "name"] }, "different rule");
      expect((await tamper.commit()).error).toBeUndefined();
      expect((await read.commit()).error).toMatchObject({
        name: "StorageTransactionInconsistent",
        address: { id: child.id },
      });
      const changed = runtime.edit();
      expect(runtime.resolveCfcPolicyManifest(ref, changed, signer.did()))
        .toBeUndefined();
      changed.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("fails closed on malformed and colliding durable artifacts", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const artifact = buildCfcPolicyArtifactManifest({
      formatVersion: 1,
      moduleIdentity: "sha256:destination-errors",
      symbol: "rules",
      template: {
        templateVersion: 1,
        exchangeRules: [],
        dependencies: { authorityOnly: [], dataBearing: [] },
        integrityRequirements: {},
      },
    });
    const otherArtifact = buildCfcPolicyArtifactManifest({
      ...artifact.manifest,
      symbol: "otherRules",
    });
    const reference = cfcAtom.modulePolicyRef(
      artifact.manifest.moduleIdentity,
      artifact.manifest.symbol,
      artifact.policyDigest,
      signer.did(),
    );
    const writeRawManifest = async (
      space: ReturnType<typeof signer.did>,
      value: unknown,
    ) => {
      const raw = storageManager.edit();
      raw.write({
        space,
        id: cfcPolicyManifestDocId(artifact.policyDigest),
        type: "application/json",
        path: ["value"],
      }, value as never);
      expect((await raw.commit()).ok).toBeDefined();
    };

    try {
      runtime.registerCfcPolicyManifests(undefined, [artifact]);

      const malformedSpace = (await Identity.fromPassphrase(
        "malformed manifest destination",
      )).did();
      await writeRawManifest(malformedSpace, { forged: true });
      const malformed = runtime.edit();
      expect(() =>
        runtime.installCfcPolicyManifest(
          malformedSpace,
          reference,
          malformed,
        )
      ).toThrow("invalid destination artifact");
      malformed.abort();

      await writeRawManifest(malformedSpace, ["not a manifest object"]);
      const wrongShape = runtime.edit();
      expect(() =>
        runtime.installCfcPolicyManifest(
          malformedSpace,
          reference,
          wrongShape,
        )
      ).toThrow("invalid destination artifact");
      expect(wrongShape.getReactivityLog?.().writes).toEqual([]);
      wrongShape.abort();

      const collisionSpace = (await Identity.fromPassphrase(
        "colliding manifest destination",
      )).did();
      await writeRawManifest(collisionSpace, otherArtifact);
      const collision = runtime.edit();
      expect(() =>
        runtime.installCfcPolicyManifest(
          collisionSpace,
          reference,
          collision,
        )
      ).toThrow("immutable destination collision");
      collision.abort();

      const validSpace = (await Identity.fromPassphrase(
        "valid manifest destination",
      )).did();
      await writeRawManifest(validSpace, artifact);
      const malformedReference = runtime.edit();
      expect(
        runtime.resolveCfcPolicyManifest(null, malformedReference, validSpace),
      ).toBeUndefined();
      expect(
        runtime.resolveCfcPolicyManifest({}, malformedReference, validSpace),
      ).toBeUndefined();
      expect(
        runtime.resolveCfcPolicyManifest(
          { ...reference, moduleIdentity: "sha256:wrong" },
          malformedReference,
          validSpace,
        ),
      ).toBeUndefined();
      malformedReference.abort();

      // A transaction over storage that cannot take a commit precondition.
      class NoPrecondition extends TransactionWrapper {}
      Object.defineProperty(
        NoPrecondition.prototype,
        "addCommitPrecondition",
        { value: undefined },
      );
      const binding = runtime.edit();
      const noPrecondition = new NoPrecondition(binding);
      expect(() =>
        runtime.resolveCfcPolicyManifest(
          reference,
          noPrecondition,
          validSpace,
        )
      ).toThrow("storage cannot bind manifest consultation");
      binding.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("commits a tainted flow that persists its manifest under enforce-strict", async () => {
    // Reserved manifest documents are not value-write targets: the privileged
    // persistence during prepare is CFC machinery. So the strict writer-fit
    // must not measure the manifest write against its own (undeclared) store
    // policy.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    const artifact = persistenceArtifact("sha256:strict-persist-module");
    try {
      const { tx, derivedId } = await runTaintedManifestPersistence(
        runtime,
        artifact,
        {
          source: "manifest-strict-source",
          derived: "manifest-strict-derived",
        },
        "enforce-strict",
      );

      const stored = storedDocument(
        storageManager,
        cfcPolicyManifestDocId(artifact.policyDigest),
      );
      expect(stored?.value).toEqual(artifact);
      expect(stored?.cfc).toBeUndefined();
      // The value target went through the persist loop while the manifest
      // document did not: its envelope carries the declared store policy,
      // and no derived component beside it — the tainted join is the
      // declared policy, which the §4.6.4 redundant-entry collapse leaves
      // stated once.
      const derivedEntries =
        storedDocument(storageManager, derivedId)?.cfc?.labelMap?.entries ?? [];
      expect(derivedEntries.some((entry) =>
        entry.origin === "declared" &&
        (entry.label.confidentiality ?? []).includes("secret")
      )).toBe(true);
      expect(derivedEntries.some((entry) => entry.origin === "derived")).toBe(
        false,
      );
      expect(
        tx.getCfcState().diagnostics.filter((diagnostic) =>
          diagnostic.includes(CFC_POLICY_MANIFEST_ID_PREFIX)
        ),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("flags no writer-fit diagnostic naming a manifest document under enforce-explicit", async () => {
    // Reserved manifest documents are not value-write targets: the privileged
    // persistence during prepare is CFC machinery. So the flagged modes must
    // not attach flow labels or misfit flags to it.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    const artifact = persistenceArtifact("sha256:explicit-flag-module");
    try {
      const { tx } = await runTaintedManifestPersistence(
        runtime,
        artifact,
        {
          source: "manifest-flag-source",
          derived: "manifest-flag-derived",
        },
        undefined,
      );

      const stored = storedDocument(
        storageManager,
        cfcPolicyManifestDocId(artifact.policyDigest),
      );
      expect(stored?.value).toEqual(artifact);
      expect(stored?.cfc).toBeUndefined();
      expect(
        tx.getCfcState().diagnostics.filter((diagnostic) =>
          diagnostic.includes("writer-fit") &&
          diagnostic.includes(CFC_POLICY_MANIFEST_ID_PREFIX)
        ),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("snapshots circular values without recursing forever", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const snapshot = snapshotQueryResult(circular);
    expect(snapshot).not.toBe(circular);
    expect(snapshot.self).toBe(snapshot);
  });
});
