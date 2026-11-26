/**
 * `cf pattern mine`: the caller's own patterns, one row per lineage (a
 * pattern and its later versions), with where each stands on the way to
 * being found: its listing, its bucket, how many people used it, and what
 * moves it on.
 */

import type {
  PatternIndexBucket,
  PatternIndexFinding,
  PatternIndexListedPattern,
  PatternIndexListing,
} from "@commonfabric/pattern-index/client";
import { shellWord } from "./shell-quote.ts";

/** One lineage as `cf pattern mine` reports it. */
export interface MinePatternRow {
  /** The newest version's id. */
  patternId: string;

  lineageId: string;

  /** How many versions of the lineage the index holds. */
  versions: number;

  name?: string;
  description: string;
  listing?: PatternIndexListing;
  listed?: boolean;
  bucket?: PatternIndexBucket;

  /** Distinct people per event type, where the index reports aggregates. */
  counts?: Record<string, number>;

  /** The privacy gardener's findings, for a held pattern. */
  findings?: PatternIndexFinding[];

  /** What to do, or what happens, next. */
  next: string;

  /** The entry file this machine published it from, when known. */
  entry?: string;
}

/** What moves a pattern on, from where it stands. */
const nextStep = (
  row: Pick<
    PatternIndexListedPattern,
    "listing" | "listed" | "bucket" | "patternId" | "channel"
  >,
  entry: string | undefined,
): string => {
  const publish = `cf pattern share ${
    entry === undefined ? "<entry file>" : shellWord(entry)
  }`;
  switch (row.listing) {
    case "not_requested":
      return `not shared: run ${publish} to share it on beta, by link`;
    case "pending":
      return "checking: the index's privacy check is reading it";
    case "held":
      return `held: fix the findings, then run ${publish}`;
    case "error":
      return "error: the check failed to run and waits for an admin re-run";
    default:
      break;
  }
  if (row.channel === "beta") {
    return `on beta, by link only: cf pattern stable ${
      entry === undefined ? "<entry file>" : shellWord(entry)
    } makes it findable`;
  }
  if (row.listed === false) return "unlisted";
  switch (row.bucket) {
    case "unvetted":
      return `listed in Unvetted: it moves to Main once you open it in a loom (/deploy index:${row.patternId})`;
    case "main":
      return "in Main: other people's use ranks it";
    case "featured":
      return "featured";
    default:
      return "listed";
  }
};

/**
 * Groups `patterns` by lineage, newest version first within each, and
 * newest lineage first. `entryFor` names the entry file a version was
 * published from on this machine.
 */
export const mineRows = async (
  patterns: readonly PatternIndexListedPattern[],
  entryFor: (patternId: string) => Promise<string | undefined>,
): Promise<MinePatternRow[]> => {
  const lineages = new Map<string, PatternIndexListedPattern[]>();
  for (const pattern of patterns) {
    // A deployment that predates `mine` answers every pattern; only one
    // marked as the caller's is.
    if (pattern.mine !== true) continue;
    const key = pattern.lineageId ?? pattern.patternId;
    lineages.set(key, [...(lineages.get(key) ?? []), pattern]);
  }
  const newestFirst = (
    a: PatternIndexListedPattern,
    b: PatternIndexListedPattern,
  ) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  const rows: MinePatternRow[] = [];
  for (const [lineageId, versions] of lineages) {
    versions.sort(newestFirst);
    const newest = versions[0];
    const entry = await entryFor(newest.patternId);
    const findings = newest.listing === "held"
      ? Object.values(newest.gates ?? {}).flatMap((gate) =>
        gate.status === "failed" ? [...(gate.findings ?? [])] : []
      )
      : [];
    const counts = newest.aggregates === undefined
      ? undefined
      : Object.fromEntries(
        Object.entries(newest.aggregates).map(([type, aggregate]) => [
          type,
          aggregate.value,
        ]),
      );
    rows.push({
      patternId: newest.patternId,
      lineageId,
      versions: versions.length,
      ...(newest.name !== undefined ? { name: newest.name } : {}),
      description: newest.description,
      ...(newest.listing !== undefined ? { listing: newest.listing } : {}),
      ...(newest.listed !== undefined ? { listed: newest.listed } : {}),
      ...(newest.bucket !== undefined ? { bucket: newest.bucket } : {}),
      ...(counts !== undefined ? { counts } : {}),
      ...(findings.length > 0 ? { findings } : {}),
      ...(entry !== undefined ? { entry } : {}),
      next: nextStep(newest, entry),
    });
  }
  const created = new Map(
    patterns.map((pattern) => [pattern.patternId, pattern.createdAt ?? ""]),
  );
  return rows.sort((a, b) =>
    (created.get(b.patternId) ?? "").localeCompare(
      created.get(a.patternId) ?? "",
    )
  );
};

/** The rows as lines for a person. */
export const mineLines = (rows: readonly MinePatternRow[]): string[] => {
  if (rows.length === 0) {
    return [
      "You have shared no patterns. Start with: cf pattern share <entry file>",
    ];
  }
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      `${row.name ?? row.description}  ${row.patternId}${
        row.versions > 1 ? ` (${row.versions} versions)` : ""
      }`,
    );
    lines.push(`  ${row.next}`);
    if (row.counts !== undefined && Object.keys(row.counts).length > 0) {
      lines.push(
        `  ${
          Object.entries(row.counts).map(([type, n]) => `${type}: ${n}`).join(
            ", ",
          )
        }`,
      );
    }
    for (const finding of row.findings ?? []) {
      lines.push(
        `  - ${finding.category}${
          finding.file !== undefined
            ? ` in ${finding.file}${
              finding.line !== undefined ? `:${finding.line}` : ""
            }`
            : " in the metadata"
        }: ${finding.why}`,
      );
    }
  }
  return lines;
};
