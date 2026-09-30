/**
 * Collects compact measurements from every available selection manifest. The
 * shared reader keeps the latest full manifest for the detail page and stores
 * historical counts on disk. The bucket listing determines the chart's extent.
 *
 * An object whose schema this reader does not implement is fetched once
 * and then remembered for as long as the process runs, so a refresh does
 * not pay for it again. A manifest is the largest thing the dashboard fetches
 * and a whole store of them is tens of megabytes, against a refresh every
 * half minute. That opinion is held in memory and never written to the
 * cache file, because what a reader can validate is a property of the
 * build holding it: a later build reading the same store may accept what
 * this one refused, and a refusal on disk would outlive the reason for
 * it. Every other failed read is left to the next refresh, which may get
 * a different answer.
 */

import { pooledMap } from "@std/async/pool";
import { z } from "zod";

import {
  type Manifest,
  MANIFESTS_LOOKED_BACK,
} from "@commonfabric/test-support/records";

import { dashboardCacheFile } from "./history-files.ts";
import { escapeHtml, friendlyError, memo, multiSparkline } from "./lib.ts";
import {
  flakyCount,
  generatedAtOf,
  MANIFEST_SHARE_MS,
  ManifestSchemaError,
  manifestNames,
  type ManifestReader,
  readManifest,
  selectedCount,
  TEST_SELECTION_BUCKET,
  TEST_SELECTION_PREFIX,
} from "./test-selection-manifest.ts";
import { CHART_LINE } from "./theme.ts";
import type { TileView } from "./types.ts";

/** Counts retained from one validated manifest. */
const countsSchema = z.object({
  known: z.number().int().nonnegative(),
  selected: z.number().int().nonnegative(),
  flaky: z.number().int().nonnegative(),
});

/** Validated contents of the derived cache file. */
const cacheSchema = z.object({
  version: z.literal(1),
  bucket: z.string(),
  prefix: z.string(),
  counts: z.record(z.string(), countsSchema),
});

/** A manifest's measured counts, independent of its full test inventory. */
type SelectionCounts = z.infer<typeof countsSchema>;

/** One published measurement, or a gap where it could not be measured. */
export interface SelectionSample {
  /** Manifest generation time in milliseconds since the Unix epoch. */
  at: number;

  /** Counts, or `null` for an unreadable manifest or an empty corpus. */
  counts: SelectionCounts | null;
}

/** History available from a complete listing of the manifest store. */
export interface SelectionHistory {
  /** Measurements in generation order, including missing measurements. */
  samples: SelectionSample[];

  /** Failures while collecting or caching measurements. */
  errors: string[];
}

/** Shared data source for the two tiles and their detail page. */
export interface TestSelectionSource {
  /** Reads the latest full manifest independently of historical collection. */
  latest: ManifestReader;

  /** Reads all listed manifests, reusing their persisted counts. */
  history(): Promise<SelectionHistory>;
}

/** Extracts the measurements plotted by the test tiles. */
function countsOf(manifest: Manifest): SelectionCounts {
  return {
    known: manifest.entries.length,
    selected: selectedCount(manifest),
    flaky: flakyCount(manifest),
  };
}

/**
 * Builds a shared source with bounded downloads and a cache of immutable
 * measurements. Corrupt or incompatible cache contents are reconstructed from
 * the bucket. Cache failures are reported alongside the readable measurements.
 */
export function makeTestSelectionSource(options: {
  bucket?: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
  cacheFile?: string;
} = {}): TestSelectionSource {
  const bucket = options.bucket ?? TEST_SELECTION_BUCKET;
  const prefix = options.prefix ?? TEST_SELECTION_PREFIX;
  const list = memo(MANIFEST_SHARE_MS, () => manifestNames(options));
  let current:
    | { name: string; manifest: Manifest }
    | { name: string; error: ManifestSchemaError }
    | undefined;
  let cached: Record<string, SelectionCounts> | undefined;
  // One answer per object name, for every object this reader has read and
  // refused over the version it declares. The newest-manifest reader and
  // the historical collection both consult it and both add to it, so the
  // two cannot come to hold different answers about one object.
  let refused = new Map<string, ManifestSchemaError>();
  let persisted = "";

  const newest = memo(MANIFEST_SHARE_MS, async () => {
    const names = (await list()).slice(-MANIFESTS_LOOKED_BACK).reverse();
    if (names.length === 0) {
      current = undefined;
      return { name: undefined, manifest: undefined };
    }
    // The newest body this reader can read, over the same stretch of the
    // store a lane looks back across. A body from further ahead is passed
    // over; anything else unreadable ends the search, because a reader
    // that half understands a body should not answer from it.
    let newestAhead: { name: string; error: ManifestSchemaError } | undefined;
    for (const name of names) {
      if (current?.name === name && "manifest" in current) return current;
      let known = refused.get(name);
      if (known === undefined) {
        try {
          current = { name, manifest: await readManifest(name, options) };
          return current;
        } catch (error) {
          // The shape a body declares cannot change, so it is kept and the
          // object is not fetched again. Every other failure may come back
          // differently on the next read.
          if (!(error instanceof ManifestSchemaError)) return { name, error };
          refused.set(name, error);
          known = error;
        }
      }
      newestAhead ??= { name, error: known };
    }
    // Every body looked at is written further ahead than this reader.
    // Reporting nothing would say the store holds no manifest, which is
    // the one thing a reader this far behind its publisher must not say,
    // so it reports the newest shape it passed over.
    current = newestAhead;
    return newestAhead ?? { name: undefined, manifest: undefined };
  });

  const latest: ManifestReader = async () => {
    const result = await newest();
    if ("error" in result) throw result.error;
    return result.manifest;
  };

  const history = memo(
    MANIFEST_SHARE_MS,
    async (): Promise<SelectionHistory> => {
      const names = await list();
      const head = await newest();
      const file = options.cacheFile ??
        dashboardCacheFile("fabric-wall-test-selection.json");
      const errors: string[] = [];
      if (cached === undefined) {
        cached = {};
        try {
          const text = await Deno.readTextFile(file);
          const parsed = cacheSchema.safeParse(JSON.parse(text));
          if (
            parsed.success && parsed.data.bucket === bucket &&
            parsed.data.prefix === prefix
          ) {
            cached = parsed.data.counts;
            persisted = text;
          }
        } catch (error) {
          if (
            !(error instanceof Deno.errors.NotFound) &&
            !(error instanceof SyntaxError)
          ) {
            errors.push(`Could not read history cache: ${error}`);
          }
        }
      }

      const kept: Record<string, SelectionCounts> = {};
      const keptRefusals = new Map<string, ManifestSchemaError>();
      const samples: SelectionSample[] = [];
      // A full manifest holds the whole corpus. We reduce each response before
      // starting more downloads, bounding the number of inventories in memory.
      for await (
        const sample of pooledMap(
          3,
          names,
          async (name): Promise<SelectionSample> => {
            let counts = cached?.[name];
            const known = refused.get(name);
            if (counts === undefined && known !== undefined) {
              // The object is not fetched again, and the refusal is
              // reported on every pass it still applies to, so the warning
              // the dashboard carries lasts as long as the condition does.
              keptRefusals.set(name, known);
              errors.push(`${name}: ${known.message}`);
            } else if (counts === undefined) {
              try {
                if (head.name === name && "error" in head) throw head.error;
                counts = countsOf(
                  current?.name === name && "manifest" in current
                    ? current.manifest
                    : await readManifest(name, options),
                );
              } catch (error) {
                if (error instanceof ManifestSchemaError) {
                  keptRefusals.set(name, error);
                }
                errors.push(
                  `${name}: ${error instanceof Error ? error.message : error}`,
                );
              }
            }
            if (counts !== undefined) kept[name] = counts;
            return {
              at: Date.parse(generatedAtOf(name) ?? ""),
              counts: counts === undefined || counts.known === 0
                ? null
                : counts,
            };
          },
        )
      ) {
        samples.push(sample);
      }
      samples.sort((a, b) => a.at - b.at);
      cached = kept;
      // Both are rebuilt from the listing, so a name that has left it is
      // forgotten rather than held against a store that no longer has it.
      refused = keptRefusals;
      const counts = Object.fromEntries(
        names.flatMap((name) =>
          kept[name] === undefined ? [] : [[name, kept[name]]]
        ),
      );
      const serialized = JSON.stringify({ version: 1, bucket, prefix, counts });
      if (serialized !== persisted) {
        const temporary = `${file}.tmp`;
        try {
          await Deno.writeTextFile(temporary, serialized);
          await Deno.rename(temporary, file);
          persisted = serialized;
        } catch (error) {
          errors.push(`Could not write history cache: ${error}`);
        }
      }
      return { samples, errors };
    },
  );
  return { latest, history };
}

/**
 * What a tile says under its dash when the latest manifest could not be
 * read. A schema this reader does not implement is a named condition and
 * the dashboard says it; anything else is a source that did not answer, which
 * `friendlyError` has the words for.
 */
export function collectionSub(error: unknown): string {
  return error instanceof ManifestSchemaError
    ? error.reason
    : friendlyError(String(error));
}

/** Collects both tile inputs, retaining readable history when the latest fails. */
export async function collectSelectionTile(
  source: TestSelectionSource,
  metric: "flaky" | "selected",
  render: (manifest: Manifest | undefined) => TileView,
  publish?: (view: TileView) => void,
): Promise<TileView> {
  const [view, history] = await Promise.all([
    source.latest().then(render, (error) => ({
      ...render(undefined),
      sub: collectionSub(error),
    })).then((view) => {
      publish?.(view);
      return view;
    }),
    source.history(),
  ]);
  return withSelectionHistory(view, history, metric);
}

/** Adds a time-positioned history chart and any collection warning to a tile. */
export function withSelectionHistory(
  view: TileView,
  history: SelectionHistory,
  metric: "flaky" | "selected",
): TileView {
  const { samples, errors } = history;
  const first = samples.at(0)?.at ?? 0;
  const duration = (samples.at(-1)?.at ?? first) - first;
  const series: Parameters<typeof multiSparkline>[0] = [];
  let segment: (typeof series)[number] | undefined;
  for (const { at, counts } of samples) {
    if (counts === null) {
      segment = undefined;
      continue;
    }
    if (segment === undefined) {
      segment = { vals: [], xs: [], color: CHART_LINE, showSinglePoint: true };
      series.push(segment);
    }
    segment.vals.push(
      metric === "flaky" ? counts.flaky : counts.selected / counts.known * 100,
    );
    segment.xs?.push(duration === 0 ? 0.5 : (at - first) / duration);
  }
  const extra = multiSparkline(series);
  return {
    ...view,
    extra: extra || undefined,
    duration: extra === "" ? undefined : duration,
    aside: errors.length === 0 ? view.aside : (view.aside ?? "") +
      `<span class="hfacet" title="${
        escapeHtml(errors.join("\n"))
      }">history warning</span>`,
  };
}

/** Shared source for the running dashboard. */
export const sharedTestSelection = makeTestSelectionSource();
