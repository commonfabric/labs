/** Checks flow labels per observation against a linear longest-prefix oracle. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { maxOf } from "@commonfabric/utils/math";

import { atomPropagationClass } from "../../src/cfc/atom-classes.ts";
import { uniqueCfcAtoms } from "../../src/cfc/observation.ts";
import {
  readConsumesEntry,
  type ReadObservationShape,
  readObservationShapes,
} from "../../src/cfc/observation-classes.ts";
import { isPrefix } from "../../src/cfc/path-prefix-index.ts";
import { deriveFlowJoin } from "../../src/cfc/prepare.ts";
import type {
  IFCLabel,
  LabelEntryOrigin,
  LabelMapEntry,
} from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
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

/** Resolves a class-filtered scan, keeping component and template buckets apart. */
function scan(
  entries: LabelMapEntry[],
  path: string[],
  shape: ReadObservationShape,
  machinery: boolean,
  nonRecursive = shape === "shape",
): IFCLabel {
  // A reference-identity read issued by the runtime's own wiring is not an
  // observation at all: `forEachFlowObservation` skips it beside the ones a
  // dereference trace covers, so it consumes nothing and marks no space.
  if (shape === "followRef" && machinery) {
    return { confidentiality: [], integrity: [] };
  }
  const template = (entry: LabelMapEntry) =>
    (entry.origin === "structure" || entry.origin === "derived") &&
    entry.path.includes("*");
  // A standalone probe asks which reference sits at the slot it names, so it
  // drops the runtime-minted templates strictly beneath that slot.
  const beneathProbe = (entry: LabelMapEntry) =>
    shape === "followRef" && template(entry) &&
    entry.path.length > path.length && isPrefix(path, entry.path);
  const selected = entries.filter((entry) =>
    readConsumesEntry(shape, entry) && !(machinery && template(entry)) &&
    !beneathProbe(entry)
  );
  // A concrete structure entry and an enumerate entry label a container
  // node, so they apply to a read of that node and not to a read beneath it.
  const atItsNodeOnly = (entry: LabelMapEntry) =>
    entry.observes === "enumerate" ||
    (entry.origin === "structure" && !template(entry));
  const ancestors = selected.filter((entry) =>
    isPrefix(entry.path, path) &&
    (!atItsNodeOnly(entry) || entry.path.length === path.length)
  );
  const buckets = new Map<string, LabelMapEntry[]>();
  for (const entry of ancestors) {
    const bucket = `${entry.origin ?? "legacy"}:${
      template(entry) && entry.observes === "shape"
    }`;
    const group = buckets.get(bucket) ?? [];
    group.push(entry);
    buckets.set(bucket, group);
  }
  const consumed = [...buckets.values()].flatMap((group) => {
    const longest = maxOf(group.map((entry) => entry.path.length));
    return group.filter((entry) => entry.path.length === longest);
  });
  if (!nonRecursive) {
    const descendants = selected.filter((entry) =>
      entry.path.length > path.length && isPrefix(path, entry.path)
    );
    for (const entry of descendants) consumed.push(entry);
  }
  return {
    confidentiality: uniqueCfcAtoms(
      consumed.flatMap((entry) => entry.label.confidentiality ?? []),
    ),
    integrity: shape === "followRef" ? [] : uniqueCfcAtoms(
      consumed.flatMap((entry) => entry.label.integrity ?? [])
        .filter((atom) => atomPropagationClass(atom) === "hereditary"),
    ),
  };
}

/** Includes wildcard queries, empty segments, escaped-pointer text, and value fields. */
function corpus(): string[][] {
  const paths = [[], ["value"], ["value", "value"], ["a/b"], ["~1"]];
  let level: string[][] = [[]];
  for (let depth = 0; depth < 3; depth++) {
    level = level.flatMap((path) =>
      ["a", "b", "*", ""].map((segment) => [...path, segment])
    );
    for (const path of level) paths.push(path);
  }
  return paths;
}

const signer = await Identity.fromPassphrase("flow-join-generated-corpus");

describe("deriveFlowJoin()", () => {
  it("matches a linear oracle per read across generated paths, origins, and classes", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const paths = corpus();
      const originValues: Record<LabelEntryOrigin, true> = {
        declared: true,
        derived: true,
        structure: true,
        link: true,
        minted: true,
        "external-ingest": true,
        "label-metadata": true,
      };
      const origins = [
        undefined,
        ...Object.keys(originValues) as LabelEntryOrigin[],
      ];
      const classes = [
        undefined,
        "value",
        "shape",
        "enumerate",
        "followRef",
        "labelMetadata",
      ] as const;
      const entries: LabelMapEntry[] = paths.flatMap((path, index) =>
        origins.map((origin, offset): LabelMapEntry => ({
          path,
          origin,
          observes: classes[(index + offset) % classes.length],
          label: {
            confidentiality: ["shared", `entry-${index}-${offset}`],
            integrity: [
              {
                type: CFC_ATOM_TYPE.PolicyCertified,
                policy: `policy-${index % 3}`,
              },
              { type: CFC_ATOM_TYPE.InjectionSafe },
            ],
          },
        }))
      );
      const seed = runtime.edit();
      const address = runtime.getCell(signer.did(), "corpus", undefined, seed)
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
      expect((await seed.commit()).error).toBeUndefined();
      const valueFields = runtime.edit();
      try {
        const literalPaths = [[], ["value"], ["value", "value"]];
        for (const path of literalPaths) {
          valueFields.readOrThrow({ ...address, path: ["value", ...path] }, {
            nonRecursive: true,
          });
        }
        expect(deriveFlowJoin(valueFields).confidentiality).toEqual(
          uniqueCfcAtoms(
            literalPaths.flatMap((path) =>
              scan(entries, path, "shape", false).confidentiality ?? []
            ),
          ),
        );
      } finally {
        valueFields.abort();
      }
      const batch = runtime.edit();
      const batchLabels: IFCLabel[] = [];
      const batchIntegrity: unknown[][] = [];
      try {
        // One pass sees mixed classes and exclusions on the same document.
        for (let index = 0; index < 30; index++) {
          const shape = readObservationShapes()[index % 3];
          const machinery = index % 2 === 0;
          const path = paths[index % 5];
          batch.readOrThrow({ ...address, path: ["value", ...path] }, {
            nonRecursive: shape === "shape",
            meta: {
              ...(shape === "followRef" ? linkResolutionProbe : {}),
              ...(machinery ? machineryRead : {}),
            },
          });
          const label = scan(entries, path, shape, machinery);
          batchLabels.push(label);
          if (shape !== "followRef") batchIntegrity.push(label.integrity ?? []);
        }
        const join = deriveFlowJoin(batch);
        expect(join.confidentiality).toEqual(uniqueCfcAtoms(
          batchLabels.flatMap((label) => label.confidentiality ?? []),
        ));
        expect(join.integrity).toEqual(
          batchIntegrity[0].filter((atom) =>
            batchIntegrity.every((atoms) =>
              atoms.some((other) => deepEqual(atom, other))
            )
          ),
        );
        batch.readOrThrow({ ...address, id: "of:unlabeled", path: ["value"] });
        expect(deriveFlowJoin(batch).integrity).toEqual([]);
      } finally {
        batch.abort();
      }
      const profiles = readObservationShapes().flatMap((shape) =>
        (shape === "followRef" ? [false, true] : [shape === "shape"])
          .map((nonRecursive) => ({ shape, nonRecursive }))
      );
      for (const path of [...paths, ["missing"]]) {
        for (const { shape, nonRecursive } of profiles) {
          for (const machinery of [false, true]) {
            const tx = runtime.edit();
            try {
              tx.readOrThrow({ ...address, path: ["value", ...path] }, {
                nonRecursive,
                meta: {
                  ...(shape === "followRef" ? linkResolutionProbe : {}),
                  ...(machinery ? machineryRead : {}),
                },
              });
              const actual = deriveFlowJoin(tx, { collectLabeledSpaces: true });
              const expected = scan(
                entries,
                path,
                shape,
                machinery,
                nonRecursive,
              );
              expect(actual.confidentiality).toEqual(expected.confidentiality);
              expect(actual.integrity).toEqual(expected.integrity);
              expect([...actual.labeledSpaces!]).toEqual(
                expected.confidentiality!.length ? [signer.did()] : [],
              );
            } finally {
              tx.abort();
            }
          }
        }
      }
      const changed = runtime.edit();
      try {
        changed.readOrThrow({ ...address, path: ["value", "a"] });
        expect(deriveFlowJoin(changed).confidentiality).toEqual(
          scan(entries, ["a"], "value", false).confidentiality,
        );
        changed.writeOrThrow({ ...address, path: ["cfc"] }, {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: [],
              label: { confidentiality: ["replacement"] },
            }],
          },
        });
        expect(deriveFlowJoin(changed).confidentiality).toEqual([
          "replacement",
        ]);
      } finally {
        changed.abort();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
