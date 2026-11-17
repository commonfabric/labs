/**
 * The pattern index's one call for a brand's repository sync,
 * `syncBrandPatterns`. Unlike every other index call it is not CF1-signed:
 * a GitHub Actions job holds no key, and authenticates with a GitHub OIDC
 * token instead (`github-oidc.ts`), sent as a bearer token. The index reads
 * the brand, repository, branch and commit from the token, so the body's
 * `repository` and `commit` must match it.
 */

import type { JSONSchema } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import type { PatternIndexProgram } from "./client.ts";
import type { PatternIndexFetch } from "./http-fetch.ts";

/** The most patterns one call may carry. */
export const MAX_BRAND_SYNC_PATTERNS = 25;

/** One repository entry file's newest source. */
export interface BrandSyncPattern {
  /** The entry file's path from the repository root: its lineage. */
  path: string;

  patternId: string;
  program: PatternIndexProgram;
  meta: {
    description: string;
    hashtags: readonly string[];
    keywords?: readonly string[];
  };
  schemas?: { argumentSchema?: JSONSchema; resultSchema?: JSONSchema };
  dependencies?: readonly string[];
}

export interface BrandSyncRequest {
  /** `owner/name`; must be the token's. */
  repository: string;

  /** Must be the token's commit. */
  commit: string;

  /** At most {@link MAX_BRAND_SYNC_PATTERNS}. */
  patterns?: readonly BrandSyncPattern[];

  /** Paths deleted from the repository, whose lineages are withdrawn. */
  removed?: readonly string[];
}

export interface BrandSyncResult {
  path: string;
  patternId: string;
  lineageId: string;

  /** `false` when the lineage's newest version already had this source. */
  created: boolean;
}

export interface BrandSyncResponse {
  brand: { githubOrg: string; displayName: string };
  results: readonly BrandSyncResult[];
  removed: readonly { path: string; withdrawn: boolean }[];
}

/** A refusal from the index, with its HTTP status. */
export class BrandSyncError extends Error {
  override name = "BrandSyncError";
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`pattern index syncBrandPatterns ${status}: ${detail}`);
    this.status = status;
  }
}

/** What keeps `answer` from being a {@link BrandSyncResponse}, if anything. */
const responseProblem = (answer: unknown): string | undefined => {
  if (!isObjectNotArray(answer)) return "it is not an object";
  if (!Array.isArray(answer.results)) return "results is not an array";
  for (const [index, result] of answer.results.entries()) {
    if (
      !isObjectNotArray(result) || typeof result.path !== "string" ||
      typeof result.patternId !== "string" ||
      typeof result.created !== "boolean"
    ) {
      return `results[${index}] is malformed`;
    }
  }
  if (answer.removed !== undefined && !Array.isArray(answer.removed)) {
    return "removed is not an array";
  }
  return undefined;
};

/**
 * Posts `request` to the index at `baseUrl` with `token` as its bearer.
 *
 * @throws BrandSyncError when the index refuses, or answers with a body this
 *   client cannot read.
 */
export const syncBrandPatterns = async (
  baseUrl: string,
  token: string,
  request: BrandSyncRequest,
  fetchFn: PatternIndexFetch = (input, init) => fetch(input, init),
): Promise<BrandSyncResponse> => {
  const response = await fetchFn(
    new URL(`${baseUrl.replace(/\/+$/, "")}/syncBrandPatterns`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    },
  );
  const text = await response.text();
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = undefined;
  }
  if (!response.ok) {
    const error = isObjectNotArray(answer) && typeof answer.error === "string"
      ? answer.error
      : text.slice(0, 200);
    throw new BrandSyncError(response.status, error);
  }
  const problem = answer === undefined
    ? "it is not JSON"
    : responseProblem(answer);
  if (problem !== undefined) {
    throw new BrandSyncError(response.status, `malformed answer: ${problem}`);
  }
  const read = answer as BrandSyncResponse;
  return { ...read, removed: read.removed ?? [] };
};
