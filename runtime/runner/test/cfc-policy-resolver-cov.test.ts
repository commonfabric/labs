import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import { createRuntimeCfcModulePolicySource } from "../src/cfc/policy-resolver.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("module-policy-source-load");
const SPACE = signer.did();

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:load-module",
  symbol: "releaseOnLoad",
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "release",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{ type: "IntegrityEvidence" }],
      },
      postCondition: { confidentiality: [], integrity: [] },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});
const reference = cfcAtom.modulePolicyRef(
  artifact.manifest.moduleIdentity,
  artifact.manifest.symbol,
  artifact.policyDigest,
  SPACE,
);

/**
 * Runs `body` with a runtime whose replica has not read the manifest another
 * session stored in `SPACE`.
 */
const withColdRuntime = async (
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const server = newSharedServer();
  const writer = EmulatedStorageManager.connectTo(server, { as: signer });
  const reader = EmulatedStorageManager.connectTo(server, { as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: reader,
  });
  try {
    const raw = writer.edit();
    raw.write({
      space: SPACE,
      id: cfcPolicyManifestDocId(artifact.policyDigest),
      type: "application/json",
      path: ["value"],
    }, artifact as never);
    expect((await raw.commit().settled).ok).toBeDefined();
    await body(runtime);
    await reader.synced();
  } finally {
    await runtime.dispose();
    await writer.close();
    await reader.close();
    await server.close();
  }
};

/**
 * A source over `runtime` that records the space of each manifest document it
 * asks the runtime for.
 */
const recordingSource = (runtime: Runtime) => {
  const requested: MemorySpace[] = [];
  const source = createRuntimeCfcModulePolicySource({
    readTx: runtime.readTx.bind(runtime),
    resolveCfcPolicyManifest: runtime.resolveCfcPolicyManifest.bind(runtime),
    getCellFromEntityId: <T>(space: MemorySpace, entityId: string) => {
      requested.push(space);
      return runtime.getCellFromEntityId<T>(space, entityId);
    },
  });
  return { source, requested };
};

describe("createRuntimeCfcModulePolicySource()", () => {
  describe("load()", () => {
    it("loads the manifest document a reference selects, so the next lookup resolves it", async () => {
      await withColdRuntime(async (runtime) => {
        const { source, requested } = recordingSource(runtime);

        await source.load(reference, SPACE);

        expect(requested).toEqual([SPACE]);
        expect(source.resolve(reference, [SPACE])).toEqual(artifact);
      });
    });

    it("requests no document for a malformed reference", async () => {
      await withColdRuntime(async (runtime) => {
        const { source, requested } = recordingSource(runtime);

        await source.load({ ...reference, subject: "" } as never, SPACE);

        expect(requested).toEqual([]);
        expect(source.resolve(reference, [SPACE])).toBeUndefined();
      });
    });

    it("requests no document for an empty space", async () => {
      await withColdRuntime(async (runtime) => {
        const { source, requested } = recordingSource(runtime);

        await source.load(reference, "");

        expect(requested).toEqual([]);
        expect(source.resolve(reference, [SPACE])).toBeUndefined();
      });
    });
  });
});
