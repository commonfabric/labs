/**
 * What the CFC write gate costs a prepare that writes somewhere unprotected.
 *
 * `verifyInputRequirements` quantifies each protected schema entry over the
 * transaction's labeled reads, and building that set resolves one stored label
 * per read. Resolving one walks the label map of the document the read landed
 * in, joining every entry that bears on the path, so the set costs reads times
 * label-map size — once per write target, once per prepare. Persisted flow
 * labels are what make the second factor large: a document accumulates a
 * derived entry per written path.
 *
 * Only a schema entry declaring `requiredIntegrity` or `maxConfidentiality`
 * consults that set, so it is built on demand and a target declaring neither
 * resolves nothing. These two arms are the guard on that. They read the same
 * documents, carrying the same stored labels, and write the same values to the
 * same number of targets. The only difference is whether the target schema
 * declares a ceiling, and that is the only thing that should reach the read
 * labels: the unprotected arm measures a prepare that skips the gate, the
 * protected arm one that pays for it. A prepare that resolves the labels
 * whether or not anything consults them closes the gap between the two.
 */

import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-gate-read-labels");

/**
 * The clause every seeded entry carries: the signing user. That is the shape a
 * persisted flow label takes, and one this writer can carry, so the seeded
 * state exercises label resolution rather than a writer-fit misfit.
 */
const USER_CLAUSE = { type: CFC_ATOM_TYPE.User, subject: signer.did() };

/** Labeled documents the measured transaction reads. */
const SOURCES = 16;

/** Stored label-map entries per read document. */
const ENTRIES = 16;

/** Write targets per prepare, so the reads-times-targets product is visible. */
const TARGETS = 8;

const FIELDS = Array.from({ length: ENTRIES }, (_, index) => `field${index}`);

/**
 * A target schema declaring a confidentiality ceiling the seeded reads fit.
 * Declaring it is what makes the target's entry protected, and a protected
 * entry is the one thing that consults the gate's read set.
 */
const PROTECTED_SCHEMA: JSONSchema = {
  type: "object",
  properties: { copied: { type: "number" } },
  ifc: { maxConfidentiality: [USER_CLAUSE] },
};

const UNPROTECTED_SCHEMA: JSONSchema = {
  type: "object",
  properties: { copied: { type: "number" } },
};

type Fixture = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  sourceNames: string[];
  targetSchema: JSONSchema;
};

/**
 * `SOURCES` documents, each carrying `ENTRIES` labeled fields, plus the schema
 * document their stored metadata references.
 */
const seedLabeledSources = async (
  prefix: string,
  targetSchema: JSONSchema,
): Promise<Fixture> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // Both arms measure a prepare that runs under persisted flow labels.
    cfcFlowLabels: "persist",
  });
  const sourceNames = Array.from(
    { length: SOURCES },
    (_, index) => `${prefix}-source-${index}`,
  );
  const seed = runtime.edit();
  writeSeedEnvelopeDoc(seed, signer.did());
  for (const name of sourceNames) {
    const id = parseLink(
      runtime.getCell(signer.did(), name, {
        type: "object",
        properties: Object.fromEntries(
          FIELDS.map((field) => [field, { type: "string" }]),
        ),
      }).getAsLink(),
    ).id as URI;
    seedStoredEnvelope(seed, {
      space: signer.did(),
      scope: "space",
      id,
      path: [],
    }, {
      value: Object.fromEntries(
        FIELDS.map((field) => [field, `${name}-${field}`]),
      ),
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: FIELDS.map((field) => ({
            path: [field],
            label: {
              confidentiality: [USER_CLAUSE],
              // Distinct per field, so resolving a recursive read at the root
              // joins as many atoms as the map has entries — the shape a
              // document accumulates under persisted flow labels.
              integrity: [{
                type: CFC_ATOM_TYPE.LinkReference,
                source: { space: signer.did(), id, path: [field] },
              }],
            },
          })),
        },
      },
    });
  }
  const committed = await seed.commit();
  if (committed.error) throw committed.error;
  return { runtime, storageManager, sourceNames, targetSchema };
};

/**
 * One prepare: read every labeled source at its root — a recursive read, so
 * resolving its label joins every entry below the root — write a derived value
 * to each of `TARGETS` documents, and prepare the boundary. Nothing commits:
 * the transaction is abandoned, so each iteration prepares against the same
 * stored state.
 */
const prepareOnce = (
  { runtime, sourceNames, targetSchema }: Fixture,
): void => {
  const tx = runtime.edit();
  let width = 0;
  for (const name of sourceNames) {
    const source = runtime.getCell(signer.did(), name, undefined, tx);
    width += Object.keys(source.getRaw() as Record<string, unknown>).length;
  }
  for (let index = 0; index < TARGETS; index++) {
    runtime.getCell(
      signer.did(),
      `${sourceNames[0]}-derived-${index}`,
      targetSchema,
      tx,
    ).set({ copied: width });
  }
  tx.prepareCfc();
  tx.abort();
};

const teardown = async ({ runtime, storageManager }: Fixture) => {
  await runtime.dispose();
  await storageManager.close();
};

const unprotected = await seedLabeledSources("unprotected", UNPROTECTED_SCHEMA);
const protectedTargets = await seedLabeledSources(
  "protected",
  PROTECTED_SCHEMA,
);

Deno.bench({
  name: "prepare, unprotected write targets",
  group: "cfc-gate-read-labels",
  baseline: true,
  fn: () => prepareOnce(unprotected),
});

Deno.bench({
  name: "prepare, write targets declaring a ceiling",
  group: "cfc-gate-read-labels",
  fn: () => prepareOnce(protectedTargets),
});

globalThis.addEventListener("unload", () => {
  void teardown(unprotected);
  void teardown(protectedTargets);
});
