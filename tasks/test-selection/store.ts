/**
 * Where manifests live, and how a lane finds the one it should obey.
 *
 * The store's writer credentials hold `objectCreator` and nothing else,
 * so an object cannot be overwritten once created. That is what makes the
 * whole store trustworthy, and it is why there is no `current.json`: a
 * reader lists the prefix and takes the newest object the store had
 * created at or before the time it is asking about. The timestamp leading
 * a name keeps a listing chronologically readable; what a resolution
 * compares is the creation time the store assigns.
 */

import {
  type Environment,
  gzipText,
  listObjectTimes,
  objectUrl,
  readEnv,
  type TimedObject,
} from "@commonfabric/test-support/records";
import { storeBucket, storePrefix } from "../test-records-config.ts";
import {
  type Manifest,
  MANIFESTS_LOOKED_BACK,
  parseManifest,
  SELECTION_AREA,
  serializeManifest,
  writtenAhead,
} from "./manifest.ts";

/**
 * The dataset area this repository's manifests belong to.
 * TEST_SELECTION_PREFIX overrides, and the infra root sets it to the area
 * rather than to a path inside one, exactly as TEST_RECORDS_PREFIX names
 * `labs/test-records` and the version segment is added by whoever builds
 * an object name.
 */
export function selectionPrefix(env: Environment = Deno.env.get): string {
  const prefix = readEnv("TEST_SELECTION_PREFIX", env);
  if (prefix !== undefined && prefix.length > 0) return prefix;
  return `${storePrefix(env).replace(/\/test-records$/, "")}/test-selection`;
}

/**
 * Where manifests are created. The segment is part of every name rather
 * than part of the configured area, so a workstation and a job agree on
 * it, and it is `SELECTION_AREA` rather than the schema version, so that
 * a change to what is stored leaves every reader looking where the
 * publisher is still writing.
 */
export function manifestPrefix(env: Environment = Deno.env.get): string {
  return `${selectionPrefix(env)}/${SELECTION_AREA}`;
}

/** The area the publisher's rolling aggregate is created under. */
export function statePrefix(env: Environment = Deno.env.get): string {
  return `${manifestPrefix(env)}/state`;
}

/**
 * The name one manifest is created under. The timestamp leads so that a
 * lexical listing is a chronological one, and the identifier that follows
 * makes two publishers starting in the same millisecond two objects
 * rather than a collision.
 */
export function manifestObjectName(
  generatedAt: string,
  id: string,
  env: Environment = Deno.env.get,
): string {
  return `${manifestPrefix(env)}/manifest-${generatedAt}-${id}.json.gz`;
}

/** The name one aggregate state object is created under. */
export function stateObjectName(
  day: string,
  id: string,
  env: Environment = Deno.env.get,
): string {
  return `${statePrefix(env)}/${day}-${id}.json.gz`;
}

/**
 * The day in an aggregate state object's name. Undefined for a name that
 * is not one, which is what an unrelated object under the prefix looks
 * like.
 *
 * The state segment is part of the match, so a name carrying the day in
 * a folder of its own is not one of these. Such an object is nothing the
 * publisher wrote — `stateObjectName` puts the day straight under the
 * segment — and reading one as an aggregate would have a run refuse over
 * a body nobody claimed was one.
 */
export function stateDayOf(objectName: string): string | undefined {
  return objectName.match(
    /\/state\/(\d{4}-\d{2}-\d{2})-[^/]+\.json\.gz$/,
  )?.[1];
}

/**
 * The generation time in a manifest's object name. Undefined for a name
 * that is not one, which is what an unrelated object under the prefix
 * looks like.
 */
export function generatedAtOf(objectName: string): string | undefined {
  const match = objectName.match(
    /\/manifest-(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)-[^/]*\.json\.gz$/,
  );
  return match?.[1];
}

/**
 * The newest manifest the store had created at or before a moment, from a
 * listing.
 *
 * The ordering is on the store's own creation time rather than on the
 * timestamp in the name. A publisher names its manifest from the moment it
 * started and creates the object when it finishes, so a name carries a
 * moment at which the object was not yet there to be read. Ordering on the
 * name would hand a lane that lists during that gap a different manifest
 * from one that lists after it, and the two would pack the corpus
 * differently.
 */
export function newestAtOrBefore(
  objects: readonly TimedObject[],
  at: string,
): string | undefined {
  return newestFirstAtOrBefore(objects, at)[0];
}

/**
 * The same, as every manifest at or before that moment with the newest
 * first, which is the order a reader tries them in when the newest is one
 * it cannot read.
 */
export function newestFirstAtOrBefore(
  objects: readonly TimedObject[],
  at: string,
): string[] {
  // Two manifests can be created in the same millisecond, and then the
  // creation time does not order them. The name does, and every reader
  // sorts it the same way, so the lanes and the dashboard obey one
  // manifest rather than two that happen to share an instant.
  return objects
    .filter(({ name, createdAt }) =>
      generatedAtOf(name) !== undefined && createdAt <= at
    )
    .sort((a, b) => {
      // By code point rather than by locale, because every reader sorts
      // a name the same way and a locale's order is not that.
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
    })
    .map(({ name }) => name);
}

/** What a fetch of the newest manifest found, or why it found nothing. */
export interface ManifestFetch {
  manifest?: Manifest;
  objectName?: string;

  /** Why there is no manifest, for the lane's job summary. */
  absent?: string;
}

/**
 * Fetches the newest manifest at or before a moment.
 *
 * Every way this can go wrong ends the same way: no manifest, with a
 * sentence saying so. A lane with no manifest runs the mandatory set plus
 * a deterministic slice rather than failing, so a store that is
 * unreachable slows selection down and stops nothing.
 */
export async function fetchManifest(options: {
  at: string;
  bucket?: string;
  prefix?: string;
  fetch?: typeof fetch;
  env?: Environment;
}): Promise<ManifestFetch> {
  const env = options.env ?? Deno.env.get;
  const bucket = options.bucket ?? storeBucket(env);
  const prefix = options.prefix ?? manifestPrefix(env);
  let objects: TimedObject[];
  try {
    objects = await listObjectTimes({
      bucket,
      // The trailing slash keeps the listing inside the area: a bare
      // "v1" prefix also matches "v10".
      prefix: `${prefix}/`,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  } catch (error) {
    return { absent: `listing ${prefix} failed: ${error}` };
  }
  const candidates = newestFirstAtOrBefore(objects, options.at)
    .slice(0, MANIFESTS_LOOKED_BACK);
  if (candidates.length === 0) {
    return { absent: `no manifest under ${prefix} at or before ${options.at}` };
  }
  const doFetch = options.fetch ?? fetch;
  let ahead: string | undefined;
  for (const objectName of candidates) {
    let text: string;
    try {
      const url = objectUrl(bucket, objectName);
      const response = await doFetch(url);
      if (!response.ok) {
        return {
          absent: `reading ${objectName} failed: HTTP ${response.status}`,
        };
      }
      // The store serves these with transcoding, so a plain fetch has
      // already decoded the gzip the object is stored under.
      text = await response.text();
    } catch (error) {
      return { absent: `reading ${objectName} failed: ${error}` };
    }
    // One parse for both questions, because a manifest is the whole
    // corpus and this asks them of every candidate.
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    const manifest = parseManifest(body);
    if (manifest !== undefined) return { manifest, objectName };
    // A manifest saying it was written in a shape from further ahead than
    // this reader is one the reader is behind, and the one before it
    // answers instead. Anything else unreadable ends the search: a
    // corrupt object is not a reader waiting to be deployed.
    if (!writtenAhead(body)) {
      return {
        objectName,
        absent: `${objectName} is not a manifest this ` +
          `reader understands`,
      };
    }
    ahead ??= objectName;
  }
  return {
    ...(ahead === undefined ? {} : { objectName: ahead }),
    absent: `every manifest under ${prefix} at or before ${options.at} this ` +
      `reader looked at was written in a newer shape than it reads`,
  };
}

/** The gzipped body one manifest object holds. */
export function manifestBody(manifest: Manifest): Promise<Uint8Array> {
  return gzipText(serializeManifest(manifest));
}
