/**
 * Reads the newest test-selection manifest from the store, and answers the
 * questions a tile or a page asks of the manifest it gets back. The bucket
 * is publicly readable, so no credential is involved, and a manifest is
 * untrusted input like every record line: it goes through the shared
 * validator whole.
 *
 * A store that cannot be read, and a body that is not a manifest, are
 * faults, and are raised as such: the dashboard grays a tile whose collection
 * throws and puts the reason under it. Reporting nothing is reserved for a
 * store that holds no manifest, which is the one case where "none has been
 * published" is true.
 *
 * One refusal is singled out from the rest, because it behaves
 * differently. A body written in a shape from further ahead than this
 * reader is settled: the store creates objects and never overwrites one,
 * so that body is what the name holds and a later read gets the same
 * answer. It carries its own type, so a reader can record it and stop
 * fetching the object, and so the dashboard can say which shape it found
 * rather than the phrase it gives a source that went quiet. Every other
 * refusal stays a plain fault and is read again.
 *
 * `writtenAhead` is what separates the two, and every reader of this
 * store asks it rather than comparing a declared shape against a bound of
 * its own, so a dashboard passing over a body and a validator refusing one
 * cannot come to disagree. A body from a shape this reader does read and
 * still cannot parse is a broken object rather than one from further
 * ahead, and is read again.
 *
 * Following the dashboard's values (README.md): what this feeds reports on
 * the system. It names tests, never people.
 */

import {
  declaredSchema,
  type LanePlan,
  listObjects,
  type Manifest,
  MANIFEST_SCHEMA_VERSION,
  objectUrl,
  parseManifest,
  SELECTION_AREA,
  writtenAhead,
} from "@commonfabric/test-support/records";

export const TEST_SELECTION_BUCKET = "cf-ci-metadata";
// The area is the one the publisher names, rather than a second copy of
// it here that would part company the first time either moved. The
// trailing slash is what keeps the listing inside the area, since a bare
// "v1" prefix also matches "v10".
export const TEST_SELECTION_PREFIX = `labs/test-selection/${SELECTION_AREA}/`;

/** The generation time in a manifest's object name, when it is one. */
export function generatedAtOf(objectName: string): string | undefined {
  return objectName.match(
    /\/manifest-(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)-[^/]*\.json\.gz$/,
  )?.[1];
}

/** Fetches the newest manifest, or `undefined` when the store holds none. */
export async function newestManifest(options: {
  bucket?: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Manifest | undefined> {
  const newest = (await manifestNames(options)).at(-1);
  if (newest === undefined) return undefined;
  return readManifest(newest, options);
}

/** Lists the available manifests in generation order. */
export async function manifestNames(options: {
  bucket?: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<string[]> {
  const names = await listObjects({
    bucket: options.bucket ?? TEST_SELECTION_BUCKET,
    prefix: options.prefix ?? TEST_SELECTION_PREFIX,
    fetch: options.fetchImpl ?? fetch,
  });
  return names.filter((name) => {
    const at = generatedAtOf(name);
    return at !== undefined && Number.isFinite(Date.parse(at));
  }).sort();
}

/**
 * A manifest body declaring a version this reader is not built for. The
 * object holding it is immutable, so a later read of that name returns the
 * same body and the same answer.
 */
export class ManifestSchemaError extends Error {
  #reason: string;

  constructor(name: string, schema: number) {
    const reason = `store holds schema ${schema}, ` +
      `this dashboard reads ${MANIFEST_SCHEMA_VERSION}`;
    super(`manifest ${name}: ${reason}`);
    this.#reason = reason;
  }

  /** The refusal alone, for a line too narrow to carry the object name. */
  get reason(): string {
    return this.#reason;
  }
}

/** Fetches and validates a manifest, throwing when the object is unreadable. */
export async function readManifest(name: string, options: {
  bucket?: string;
  fetchImpl?: typeof fetch;
} = {}): Promise<Manifest> {
  const response = await (options.fetchImpl ?? fetch)(
    objectUrl(options.bucket ?? TEST_SELECTION_BUCKET, name),
  );
  if (!response.ok) {
    throw new Error(`manifest ${name}: HTTP ${response.status}`);
  }
  // The store serves these with transcoding, so a plain fetch has
  // already decoded the gzip the object is stored under.
  const text = await response.text();
  // A manifest holds every identity the store knows, so the body is
  // parsed once here and the one value answers both questions asked of
  // it.
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`manifest ${name}: not a manifest`);
  }
  const manifest = parseManifest(body);
  if (manifest !== undefined) return manifest;
  const schema = declaredSchema(body);
  if (schema !== undefined && writtenAhead(body)) {
    throw new ManifestSchemaError(name, schema);
  }
  throw new Error(`manifest ${name}: not a manifest`);
}

/**
 * How long a manifest listing and its measurements are shared. The tiles
 * refresh on the same cadence as the workflow activity. Unchanged manifests
 * reuse their full latest inventory or their cached historical counts.
 */
export const MANIFEST_SHARE_MS = 30_000;

/** Where a tile or a page gets the manifest it reports on. */
export type ManifestReader = () => Promise<Manifest | undefined>;

/**
 * A positive number the manifest's dials name, or `fallback` when they do
 * not name one. Every manifest records the dials it was built with, so a
 * reader takes a policy number from the manifest in front of it rather
 * than from a copy here that would quietly disagree with it.
 */
export function numberDial(
  dials: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = dials[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/**
 * Seconds of planned work a lane may hold, for a manifest whose dials do
 * not name a budget.
 */
export const LANE_BUDGET_FALLBACK_SECONDS = 230;

/** The budget a manifest was built with, or the fallback. */
export function laneBudgetOf(dials: Record<string, unknown>): number {
  return numberDial(dials, "LANE_BUDGET_SECONDS", LANE_BUDGET_FALLBACK_SECONDS);
}

/** Days of history a flake share is measured over, when the dials say. */
export const FLAKE_WINDOW_FALLBACK_DAYS = 60;

/** The flake share past which a test is held back, when the dials say. */
export const FLAKE_EXCLUSION_FALLBACK = 0.05;

/** How many identities one lane of the reference packing would run. */
export function laneTestCount(lane: LanePlan): number {
  return lane.batches.reduce((sum, batch) => sum + batch.identities.length, 0);
}

/** How many identities the whole packing would run. */
export function selectedCount(manifest: Manifest): number {
  return manifest.lanes.reduce(
    (total, lane) => total + laneTestCount(lane),
    0,
  );
}

/** How many identities are held back for being too noisy to judge by. */
export function flakyCount(manifest: Manifest): number {
  return manifest.withheld.filter((entry) => entry.reason === "flaky").length;
}
