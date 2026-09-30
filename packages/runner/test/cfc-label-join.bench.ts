/**
 * What joining a document's stored label costs a prepare, as the stored map
 * grows.
 *
 * A recursive read materializes everything under its path, so its effective
 * label is the entry at the path joined with every entry below it. Under
 * persisted flow labels a document accumulates an entry per written path, so
 * that join runs over a map that grows for the life of the document — and it
 * runs more than once per prepare: the write gate resolves the read labels
 * for a protected write target, and the transaction-global flow join resolves
 * them again.
 *
 * Each entry here carries an integrity atom naming its own path, so no two
 * entries contribute the same atom and the join's result is as long as the
 * map. That is the growing-label case; a document whose entries all carry one
 * shared clause joins to a result of one atom however long the map is.
 *
 * The sizes are the axis, and they are in the names, because one point cannot
 * tell a join that costs the map's size from one that costs its square.
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

const signer = await Identity.fromPassphrase("runner-cfc-label-join");

/** The clause every seeded entry carries: the signing user. */
const USER_CLAUSE = { type: CFC_ATOM_TYPE.User, subject: signer.did() };

/**
 * A target schema declaring a confidentiality ceiling the seeded reads fit.
 * Declaring it makes the target protected, and a protected target is what
 * makes the write gate consult the transaction's read labels.
 */
const TARGET_SCHEMA: JSONSchema = {
  type: "object",
  properties: { copied: { type: "number" } },
  ifc: { maxConfidentiality: [USER_CLAUSE] },
};

/** Stored label-map sizes to measure the join against. */
const SIZES = [8, 64, 256] as const;

type Fixture = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  sourceName: string;
};

/** One document carrying `entries` labeled fields, plus its schema document. */
const seedLabeledSource = async (entries: number): Promise<Fixture> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });
  const fields = Array.from({ length: entries }, (_, index) => `field${index}`);
  const sourceName = `source-${entries}`;
  const id = parseLink(
    runtime.getCell(signer.did(), sourceName, {
      type: "object",
      properties: Object.fromEntries(
        fields.map((field) => [field, { type: "string" }]),
      ),
    }).getAsLink(),
  ).id as URI;
  const seed = runtime.edit();
  writeSeedEnvelopeDoc(seed, signer.did());
  seedStoredEnvelope(seed, {
    space: signer.did(),
    scope: "space",
    id,
    path: [],
  }, {
    value: Object.fromEntries(fields.map((field) => [field, field])),
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: fields.map((field) => ({
          path: [field],
          label: {
            confidentiality: [USER_CLAUSE],
            integrity: [{
              type: CFC_ATOM_TYPE.LinkReference,
              source: { space: signer.did(), id, path: [field] },
            }],
          },
        })),
      },
    },
  });
  const committed = await seed.commit();
  if (committed.error) throw committed.error;
  return { runtime, storageManager, sourceName };
};

/**
 * One prepare: read the labeled document at its root — a recursive read, so
 * resolving its label joins every entry below the root — write a derived
 * value to a protected target, and prepare the boundary. Nothing commits, so
 * every iteration prepares against the same stored state.
 *
 * Only the prepare is timed. Opening a transaction, reading the source and
 * writing the target are what a transaction reaching the boundary has done
 * already, and their cost does not vary with the stored label map, so timing
 * them alongside would report runtime construction under this benchmark's
 * name.
 */
const prepareOnce = (
  { runtime, sourceName }: Fixture,
  timer: Deno.BenchContext,
): void => {
  const tx = runtime.edit();
  const source = runtime.getCell(signer.did(), sourceName, undefined, tx);
  const width = Object.keys(source.getRaw() as Record<string, unknown>).length;
  runtime.getCell(signer.did(), `${sourceName}-derived`, TARGET_SCHEMA, tx)
    .set({ copied: width });
  timer.start();
  try {
    tx.prepareCfc();
    timer.end();
  } finally {
    // A prepare that throws would otherwise leave the transaction open, and
    // every later iteration would measure a runtime holding it.
    tx.abort();
  }
};

const teardown = async ({ runtime, storageManager }: Fixture) => {
  await runtime.dispose();
  await storageManager.close();
};

const fixtures: Fixture[] = [];
for (const size of SIZES) {
  const fixture = await seedLabeledSource(size);
  fixtures.push(fixture);
  Deno.bench({
    name: `entries ${size}`,
    group: "cfc label join",
    fn: (timer) => prepareOnce(fixture, timer),
  });
}

globalThis.addEventListener("unload", () => {
  for (const fixture of fixtures) void teardown(fixture);
});
