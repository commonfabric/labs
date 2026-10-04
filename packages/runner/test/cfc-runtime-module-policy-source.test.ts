import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import { createRuntimeCfcModulePolicySource } from "../src/cfc/policy-resolver.ts";
import { createRenderConfidentialityResolver } from "../src/cfc/render-ceiling.ts";
import { commitCfcFieldValue } from "../src/cfc/label-representation.ts";
import { atomsOutsideCeiling } from "../src/cfc/observation.ts";

const signer = await Identity.fromPassphrase("runtime-module-policy-resolver");
const SPACE = signer.did();
const VIEWER = "did:key:viewer";
const OTHER_SPACE = (await Identity.fromPassphrase("module-policy-other"))
  .did();

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:release-module",
  symbol: "releaseToMembers",
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseWhenTallied",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: "TallyComplete",
          space: { thisPolicyField: "subject" },
        }],
      },
      postCondition: {
        confidentiality: [{
          type: CFC_ATOM_TYPE.Space,
          id: { thisPolicyField: "subject" },
        }],
        integrity: [],
      },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

const referenceTo = (
  moduleIdentity: string,
  symbol: string,
  subject: Parameters<typeof cfcAtom.modulePolicyRef>[3] = SPACE,
) =>
  cfcAtom.modulePolicyRef(
    moduleIdentity,
    symbol,
    artifact.policyDigest,
    subject,
  );
const reference = referenceTo(
  artifact.manifest.moduleIdentity,
  artifact.manifest.symbol,
);

const withRuntime = async (
  body: (
    runtime: Runtime,
    storageManager: ReturnType<typeof StorageManager.emulate>,
  ) => Promise<void>,
) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  try {
    await body(runtime, storageManager);
    // A lookup kicks a background load of the manifest document; let it land
    // before the storage closes under it.
    await storageManager.synced();
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

const writeRawManifest = async (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  value: unknown,
  space: string = SPACE,
) => {
  const raw = storageManager.edit();
  raw.write({
    space: space as never,
    id: cfcPolicyManifestDocId(artifact.policyDigest),
    type: "application/json",
    path: ["value"],
  }, value as never);
  expect((await raw.commit()).ok).toBeDefined();
};

/** A source whose document reads, and cells it watches, are counted. */
const countingSource = (runtime: Runtime, capacity?: number) => {
  const counts = { reads: 0, watches: 0 };
  const source = createRuntimeCfcModulePolicySource({
    readTx: (tx) => {
      counts.reads++;
      return runtime.readTx(tx);
    },
    resolveCfcPolicyManifest: (...args) =>
      runtime.resolveCfcPolicyManifest(...args),
    getCellFromEntityId: ((...args: never[]) => {
      counts.watches++;
      return (runtime.getCellFromEntityId as (...a: never[]) => unknown)(
        ...args,
      );
    }) as never,
  }, capacity);
  return { source, counts };
};

describe("createRuntimeCfcModulePolicySource()", () => {
  it("resolves a manifest stored in a space the label was read from", async () => {
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact);
      const { resolve } = createRuntimeCfcModulePolicySource(runtime);
      expect(resolve(reference, [SPACE])).toEqual(artifact);
      expect(resolve(reference, [OTHER_SPACE, SPACE])).toEqual(artifact);
    });
  });

  it("reads the label's spaces, not the policy's subject space", async () => {
    // A value copied into OTHER_SPACE keeps its subject, and the copy
    // installed the manifest beside it; the subject space holds none here.
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact, OTHER_SPACE);
      const { resolve } = createRuntimeCfcModulePolicySource(runtime);
      expect(resolve(reference, [OTHER_SPACE])).toEqual(artifact);
      expect(resolve(reference, [SPACE])).toBeUndefined();
      expect(resolve(reference, [])).toBeUndefined();
    });
  });

  it("resolves a reference whose subject is a commitment", async () => {
    // The subject plays no part in finding the manifest, so a cross-space
    // copy's committed subject resolves like a plaintext one.
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact, OTHER_SPACE);
      const { resolve } = createRuntimeCfcModulePolicySource(runtime);
      expect(resolve(
        referenceTo(
          artifact.manifest.moduleIdentity,
          artifact.manifest.symbol,
          commitCfcFieldValue(SPACE),
        ),
        [OTHER_SPACE],
      )).toEqual(artifact);
    });
  });

  it("resolves nothing from a manifest only registered in memory", async () => {
    // The in-memory registry is not the label's space's record; the display
    // boundary reads what the commit that persisted the label installed.
    await withRuntime((runtime) => {
      runtime.registerCfcPolicyManifests(undefined, [artifact]);
      const { resolve } = createRuntimeCfcModulePolicySource(runtime);
      expect(resolve(reference, [SPACE])).toBeUndefined();
      return Promise.resolve();
    });
  });

  it("resolves nothing from a stored manifest that fails verification", async () => {
    await withRuntime(async (runtime, storageManager) => {
      // The rules change while the digest, module and symbol stay, so only
      // recomputing the digest can tell this record from the real one.
      const [rule] = artifact.manifest.template.exchangeRules;
      await writeRawManifest(storageManager, {
        ...artifact,
        manifest: {
          ...artifact.manifest,
          template: {
            ...artifact.manifest.template,
            exchangeRules: [{
              ...rule,
              postCondition: {
                confidentiality: [{ type: CFC_ATOM_TYPE.User, subject: "*" }],
                integrity: [],
              },
            }],
          },
        },
      });
      const { resolve } = createRuntimeCfcModulePolicySource(runtime);
      expect(resolve(reference, [SPACE])).toBeUndefined();
    });
  });

  it("resolves nothing for a reference naming another module or symbol", async () => {
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact);
      const { resolve } = createRuntimeCfcModulePolicySource(runtime);
      expect(resolve(referenceTo(artifact.manifest.moduleIdentity, "other"), [
        SPACE,
      ])).toBeUndefined();
      expect(resolve(referenceTo("sha256:other", artifact.manifest.symbol), [
        SPACE,
      ])).toBeUndefined();
    });
  });

  it("reads and watches nothing for a malformed reference or an empty space", async () => {
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact);
      const { source, counts } = countingSource(runtime);
      const malformed = [
        { ...reference, subject: "" },
        { ...reference, policyDigest: undefined },
        { ...reference, extra: true },
      ] as never[];
      for (const candidate of malformed) {
        expect(source.resolve(candidate, [SPACE])).toBeUndefined();
        source.subscribe(candidate, SPACE, () => {})();
      }
      expect(source.resolve(reference, [""])).toBeUndefined();
      source.subscribe(reference, "", () => {})();
      expect(counts).toEqual({ reads: 0, watches: 0 });
    });
  });

  it("releases a PolicyOf label at the display boundary only once installed", async () => {
    await withRuntime(async (runtime, storageManager) => {
      const resolveLabel = createRenderConfidentialityResolver({
        actingPrincipal: VIEWER,
        memberSpaces: [SPACE],
        modulePolicyResolver:
          createRuntimeCfcModulePolicySource(runtime).resolve,
      });
      const label = {
        confidentiality: [reference],
        integrity: [{ type: "TallyComplete", space: SPACE }],
        spaces: () => [SPACE],
      };
      const ceiling = [cfcAtom.user(VIEWER)];
      expect(atomsOutsideCeiling(resolveLabel(label), ceiling)).toEqual([
        reference,
      ]);
      await writeRawManifest(storageManager, artifact);
      expect(atomsOutsideCeiling(resolveLabel(label), ceiling)).toEqual([]);
    });
  });

  it("reads a space once for a manifest that verified there", async () => {
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact);
      const { source, counts } = countingSource(runtime);
      expect(source.resolve(reference, [SPACE])).toEqual(artifact);
      expect(source.resolve(reference, [SPACE])).toEqual(artifact);
      expect(source.resolve(reference, [SPACE])).toEqual(artifact);
      expect(counts.reads).toEqual(1);
      // A kept manifest still answers only the reference it verified for.
      expect(
        source.resolve(referenceTo(artifact.manifest.moduleIdentity, "other"), [
          SPACE,
        ]),
      ).toBeUndefined();
      expect(counts.reads).toEqual(1);
    });
  });

  it("keeps reading a manifest that has not verified yet", async () => {
    await withRuntime(async (runtime, storageManager) => {
      const { source, counts } = countingSource(runtime);
      expect(source.resolve(reference, [SPACE])).toBeUndefined();
      expect(source.resolve(reference, [SPACE])).toBeUndefined();
      expect(counts.reads).toEqual(2);
      await writeRawManifest(storageManager, artifact);
      expect(source.resolve(reference, [SPACE])).toEqual(artifact);
    });
  });

  it("does not answer one space from another's manifest", async () => {
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact);
      const { resolve } = createRuntimeCfcModulePolicySource(runtime);
      // Verified, and so kept, for SPACE first: the same digest read for
      // another space must still find that space's own document.
      expect(resolve(reference, [SPACE])).toEqual(artifact);
      expect(resolve(reference, [OTHER_SPACE])).toBeUndefined();
      await writeRawManifest(storageManager, artifact, OTHER_SPACE);
      expect(resolve(reference, [OTHER_SPACE])).toEqual(artifact);
    });
  });

  it("keeps only the most recently used manifests", async () => {
    await withRuntime(async (runtime, storageManager) => {
      const third = (await Identity.fromPassphrase("module-policy-third"))
        .did();
      for (const space of [SPACE, OTHER_SPACE, third]) {
        await writeRawManifest(storageManager, artifact, space);
      }
      const { source, counts } = countingSource(runtime, 2);
      source.resolve(reference, [SPACE]);
      source.resolve(reference, [OTHER_SPACE]);
      expect(counts.reads).toEqual(2);
      // Touch SPACE, so OTHER_SPACE is the least recently used when a third
      // entry arrives; first-in-first-out would evict SPACE instead.
      source.resolve(reference, [SPACE]);
      source.resolve(reference, [third]);
      expect(counts.reads).toEqual(3);
      source.resolve(reference, [SPACE]);
      expect(counts.reads).toEqual(3);
      source.resolve(reference, [OTHER_SPACE]);
      expect(counts.reads).toEqual(4);
    });
  });

  it("reports a manifest document that arrives after subscribing", async () => {
    await withRuntime(async (runtime, storageManager) => {
      const source = createRuntimeCfcModulePolicySource(runtime);
      let changes = 0;
      const cancel = source.subscribe(reference, SPACE, () => changes++);
      try {
        expect(changes).toEqual(0);
        await writeRawManifest(storageManager, artifact);
        await runtime.idle();
        expect(changes).toBeGreaterThan(0);
        expect(source.resolve(reference, [SPACE])).toEqual(artifact);
      } finally {
        cancel();
      }
    });
  });

  it("does not watch a manifest that already verifies", async () => {
    await withRuntime(async (runtime, storageManager) => {
      await writeRawManifest(storageManager, artifact);
      const { source, counts } = countingSource(runtime);
      // Never resolved before: subscribing verifies it on the spot.
      source.subscribe(reference, SPACE, () => {})();
      expect(source.resolve(reference, [SPACE])).toEqual(artifact);
      source.subscribe(reference, SPACE, () => {})();
      expect(counts.watches).toEqual(0);
    });
  });
});
