/**
 * `cf pattern stable` and `cf pattern link`: the two channels a shared
 * pattern is on, in the person's words. The index keeps them (shared
 * versions numbered 1, 2, 3…; beta opens by link, stable is findable), so
 * this only names the entry's lineage and asks it.
 */

import {
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexLineage,
  type PatternIndexLink,
  type PatternIndexVersionSummary,
} from "@commonfabric/pattern-index/client";
import { PatternHistoryError } from "./pattern-history.ts";

/** What `cf pattern stable` did. */
export interface StableReport {
  /** The shared version number now on stable. */
  number: number;

  /** False when it was stable already. */
  changed: boolean;
}

/** The lineage's newest shared version, the one beta gives. */
const newestShared = (
  versions: readonly PatternIndexVersionSummary[],
): { versionId: string; number: number; stable: boolean } | undefined => {
  let newest:
    | { versionId: string; number: number; stable: boolean }
    | undefined;
  for (const { versionId, shared } of versions) {
    if (shared === undefined) continue;
    if (newest === undefined || shared.number > newest.number) {
      newest = { versionId, ...shared };
    }
  }
  return newest;
};

/**
 * Makes the lineage's newest shared version stable: what search, the
 * catalog and a plain link give. It passed the check when it was shared, so
 * nothing new is exposed.
 */
export async function makeStable(
  client: Pick<PatternIndexClient, "listVersions" | "shareVersion">,
  lineage: PatternIndexLineage,
  entry: string,
): Promise<StableReport> {
  const { versions } = await client.listVersions({
    lineageId: lineage.lineageId,
  });
  const newest = newestShared(versions);
  if (newest === undefined) {
    throw new PatternHistoryError(
      `Nothing of ${entry} is shared yet, or its share is still being checked: cf pattern share shares it on beta first.`,
    );
  }
  if (newest.stable) return { number: newest.number, changed: false };
  try {
    const answer = await client.shareVersion({
      versionId: newest.versionId,
      channel: "stable",
    });
    return { number: answer.shared ?? newest.number, changed: true };
  } catch (error) {
    if (error instanceof PatternIndexError && error.status === 409) {
      throw new PatternHistoryError(
        `A newer version of ${entry} was shared since this looked; run cf pattern stable again.`,
      );
    }
    throw error;
  }
}

/** Which version a link names. */
export type LinkChannel = "stable" | "beta" | number;

/** What `cf pattern link` found. */
export interface LinkReport {
  /** The link: the lineage's pseudonym, with `@beta` or `@<n>`. */
  ref: string;

  /** What it names now. */
  link: PatternIndexLink;
}

const refFor = (pseudonym: string, channel: LinkChannel): string =>
  channel === "stable" ? pseudonym : `${pseudonym}@${channel}`;

/** Resolves `ref`, or `undefined` when it names nothing yet (404). */
async function resolve(
  client: Pick<PatternIndexClient, "getPattern">,
  ref: string,
): Promise<PatternIndexLink | undefined> {
  try {
    return (await client.getPattern({ ref })).link;
  } catch (error) {
    if (error instanceof PatternIndexError && error.status === 404) {
      return undefined;
    }
    throw error;
  }
}

/**
 * A link to the lineage's version on `channel`, checked against the index
 * so it is never one that opens nothing. Asked for stable when nothing is
 * stable yet, it gives beta, and says so in the link it returns.
 */
export async function patternLink(
  client: Pick<PatternIndexClient, "getPattern">,
  lineage: PatternIndexLineage,
  entry: string,
  channel: LinkChannel,
): Promise<LinkReport> {
  const tried = channel === "stable" ? ["stable", "beta"] as const : [channel];
  for (const each of tried) {
    const ref = refFor(lineage.pseudonym, each);
    const link = await resolve(client, ref);
    if (link !== undefined) return { ref, link };
  }
  throw new PatternHistoryError(
    typeof channel === "number"
      ? `${entry} has no shared version ${channel}.`
      : `Nothing of ${entry} is shared yet, or its share is still being checked: cf pattern share shares it on beta.`,
  );
}

/** The link as a line for a person. */
export const linkLine = (entry: string, report: LinkReport): string => {
  const { link } = report;
  const what = link.channel === "number"
    ? `exactly version ${link.number}`
    : `${link.channel}, version ${link.number} now`;
  return `${report.ref}: ${entry} on ${what}. Anyone with an account can open it.`;
};
