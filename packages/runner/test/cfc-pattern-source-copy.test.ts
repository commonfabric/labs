import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { CfcMetadata, IFCLabel } from "../src/cfc/types.ts";
import { sourceDocKey } from "../src/compilation-cache/cell-cache.ts";
import { sourceCfcMetadataProhibitsCrossSpaceCopy } from "../src/pattern-manager.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc-pattern-source-copy");
const space = signer.did();
const destinationSpace = (await Identity.fromPassphrase(
  "cfc-pattern-source-copy-destination",
)).did();
const program = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { pattern } from 'commonfabric';",
      "import { value } from './value.ts';",
      "export default pattern(() => ({ value }));",
    ].join("\n"),
  }, {
    name: "/value.ts",
    contents: "export const value = 'copied public value';",
  }],
};

describe("cfc-pattern-source-copy", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  /** Persists a real multi-module source closure with precise reference labels. */
  async function compileSource() {
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
    });
    await runtime.patternManager.flushCompileCacheWrites();
    const entry = runtime.patternManager.getArtifactEntryRef(compiled)!;
    const tx = runtime.edit();
    try {
      const source = runtime.getCell(space, sourceDocKey(entry.identity));
      const metadata = readStoredCfcMetadata(
        tx,
        source.getAsNormalizedFullLink(),
      );
      expect(metadata?.version).toBe(3);
      expect(metadata!.labelMap.entries).toContainEqual(
        expect.objectContaining({
          path: ["code"],
          origin: "link",
          observes: "followRef",
          referenceAcquisition: "complete",
          label: expect.objectContaining({
            integrity: [
              expect.objectContaining({ type: CFC_ATOM_TYPE.LinkReference }),
            ],
          }),
        }),
      );
      return { entry, source, metadata: metadata! };
    } finally {
      tx.abort();
    }
  }

  it("copies verified public module bytes without carrying old link identities", async () => {
    const { entry, metadata } = await compileSource();
    expect(sourceCfcMetadataProhibitsCrossSpaceCopy(metadata)).toBe(false);
    const cold = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    try {
      const recovered = await cold.patternManager
        .getPatternSourceProgramByIdentity(
          entry.identity,
          space,
          destinationSpace,
        );
      expect(recovered?.files).toEqual(expect.arrayContaining(program.files));
      const cloned = await cold.patternManager.compilePattern(recovered!, {
        space: destinationSpace,
      });
      await cold.patternManager.flushCompileCacheWrites();
      const cloneEntry = cold.patternManager.getArtifactEntryRef(cloned)!;
      expect(cloneEntry.identity).toBe(entry.identity);
      const destination = await cold.patternManager
        .getPatternSourceProgramByIdentity(
          cloneEntry.identity,
          destinationSpace,
        );
      expect(destination?.files).toEqual(recovered!.files);
    } finally {
      await cold.dispose({ closeStorage: false });
    }
  });

  for (
    const restriction of ["private-reference", "content-integrity"] as const
  ) {
    it(`refuses cross-space source recovery with ${restriction}`, async () => {
      const { entry, source, metadata } = await compileSource();
      const label: IFCLabel = restriction === "private-reference"
        ? { confidentiality: ["private-source-selection"] }
        : { integrity: ["reviewed-source-content"] };
      const extra = restriction === "private-reference"
        ? { origin: "link" as const, observes: "followRef" as const }
        : { origin: "declared" as const, observes: "value" as const };
      const protectedMetadata: CfcMetadata = {
        ...metadata,
        labelMap: {
          ...metadata.labelMap,
          entries: [...metadata.labelMap.entries, {
            path: ["code"],
            label,
            ...extra,
          }],
        },
      };
      // Installs stored policy below Runtime preparation; source recovery
      // still exercises the normal Runtime verification boundary.
      const seed = storage.edit();
      expect(
        seed.write(
          { ...source.getAsNormalizedFullLink(), path: ["cfc"] },
          protectedMetadata,
        ).error,
      ).toBeUndefined();
      expect((await seed.commit()).error).toBeUndefined();
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy(protectedMetadata)).toBe(
        true,
      );
      await expect(runtime.patternManager.getPatternSourceProgramByIdentity(
        entry.identity,
        space,
        destinationSpace,
      )).rejects.toThrow("carries CFC provenance that cannot be copied");
    });
  }

  it("refuses content and legacy labels that resemble reference identity evidence", () => {
    const marker: CfcMetadata = {
      version: 3,
      schemaHash: "unused-by-metadata-classifier",
      labelMap: {
        version: 1,
        entries: [{
          path: ["code"],
          origin: "link",
          observes: "followRef",
          referenceAcquisition: "complete",
          label: { integrity: [{ type: CFC_ATOM_TYPE.LinkReference }] },
        }],
      },
    };
    expect(sourceCfcMetadataProhibitsCrossSpaceCopy(marker)).toBe(false);
    for (const version of [1, 2] as const) {
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy({ ...marker, version }))
        .toBe(true);
    }
    for (
      const changes of [
        { origin: "declared" as const },
        { observes: "value" as const },
        { label: { integrity: [{ type: CFC_ATOM_TYPE.InjectionSafe }] } },
        {
          label: {
            integrity: [{ type: CFC_ATOM_TYPE.LinkReference }, "reviewed"],
          },
        },
      ]
    ) {
      expect(sourceCfcMetadataProhibitsCrossSpaceCopy({
        ...marker,
        labelMap: {
          version: 1,
          entries: [{ ...marker.labelMap.entries[0], ...changes }],
        },
      })).toBe(true);
    }
  });
});
