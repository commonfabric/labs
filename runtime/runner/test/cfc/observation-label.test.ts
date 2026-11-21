import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import { atomPropagationClass } from "../../src/cfc/atom-classes.ts";
import { readObservationShapes } from "../../src/cfc/observation-classes.ts";
import {
  deriveFlowJoin,
  observationLabelResolverFor,
} from "../../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { normalizeCellScope } from "../../src/scope.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  linkResolutionProbe,
  machineryRead,
} from "../../src/storage/reactivity-log.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("observation-label-resolver");

describe("ObservationLabelResolver", () => {
  it("returns for one read the label deriveFlowJoin joins from it alone", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const paths = [[], ["a"], ["a", "b"], ["a", "*"], ["c"]];
      const classes = [undefined, "value", "shape", "followRef"] as const;
      const origins = [undefined, "declared", "derived", "structure"] as const;
      const entries: LabelMapEntry[] = paths.flatMap((path, index) =>
        origins.map((origin, offset): LabelMapEntry => ({
          path,
          origin,
          observes: classes[(index + offset) % classes.length],
          label: {
            confidentiality: [`entry-${index}-${offset}`],
            integrity: [
              { type: CFC_ATOM_TYPE.PolicyCertified, policy: `p-${index}` },
              { type: CFC_ATOM_TYPE.InjectionSafe },
            ],
          },
        }))
      );
      const seed = runtime.edit();
      const address = runtime.getCell(signer.did(), "resolver", undefined, seed)
        .getAsNormalizedFullLink();
      writeSeedEnvelopeDoc(seed, signer.did());
      seedStoredEnvelope(seed, { ...address, path: [] }, {
        value: {},
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      const document = {
        space: address.space,
        id: address.id,
        scope: normalizeCellScope(address.scope),
      };
      let compared = 0;
      for (const path of [...paths, ["missing"]]) {
        for (const shape of readObservationShapes()) {
          for (const machinery of [false, true]) {
            const nonRecursive = shape === "shape";
            const tx = runtime.edit();
            try {
              tx.readOrThrow({ ...address, path: ["value", ...path] }, {
                nonRecursive,
                meta: {
                  ...(shape === "followRef" ? linkResolutionProbe : {}),
                  ...(machinery ? machineryRead : {}),
                },
              });
              const join = deriveFlowJoin(tx);
              const resolved = observationLabelResolverFor(tx).resolve(
                document,
                "application/json",
                path,
                {
                  shape,
                  nonRecursive,
                  coveredByTrace: false,
                  machinery,
                  declaredOnward: undefined,
                },
              );
              // A wiring read's probe is no observation at all, so the join
              // takes nothing from it.
              if (shape === "followRef" && machinery) {
                expect(join.confidentiality).toEqual([]);
                continue;
              }
              expect(resolved.label?.confidentiality ?? []).toEqual(
                join.confidentiality,
              );
              expect(
                shape === "followRef" ? [] : (resolved.label?.integrity ?? [])
                  .filter((atom) =>
                    atomPropagationClass(atom) === "hereditary"
                  ),
              ).toEqual(join.integrity);
              compared++;
            } finally {
              tx.abort();
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(20);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("resolves a document with no stored metadata to no label", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const tx = runtime.edit();
      try {
        const resolved = observationLabelResolverFor(tx).resolve(
          {
            space: signer.did(),
            id: "of:unlabeled",
            scope: normalizeCellScope(undefined),
          },
          "application/json",
          ["a"],
          {
            shape: "value",
            nonRecursive: false,
            coveredByTrace: false,
            machinery: false,
            declaredOnward: undefined,
          },
        );
        expect(resolved.label).toBeUndefined();
        expect(resolved.document.metadata).toBeUndefined();
      } finally {
        tx.abort();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
