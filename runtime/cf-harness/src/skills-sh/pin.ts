/**
 * Host-side resolution of a mutable skills.sh discovery hit to the immutable
 * commit at the source repository's default-branch head. This module is
 * machinery for the later acquisition step, not a model-facing tool: the
 * model chooses a candidate, and the host resolves where that candidate
 * points without exposing the GitHub request or response.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";
import type { SkillsShSearchHit } from "./search-client.ts";

const GITHUB_API_BASE_URL = "https://api.github.com";
const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SLUG_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const DOT_ONLY_SEGMENT = /^\.+$/;
const FULL_GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface SkillsShPinnedAddress {
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
  readonly commitSha: string;
  readonly resolvedAt: string;
}

export type SkillsShPinResolutionFailureCode =
  | "invalid_hit"
  | "request_failed"
  | "http_error"
  | "unparseable_response";

export class SkillsShPinResolutionError extends Error {
  override readonly name = "SkillsShPinResolutionError";
  readonly code: SkillsShPinResolutionFailureCode;

  constructor(code: SkillsShPinResolutionFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ResolveSkillsShHitPinOptions {
  readonly fetch?: HarnessFetch;
  readonly now?: () => string;
}

/** Validated path segments carried by a skills.sh discovery id. */
export interface SkillsShAddressSegments {
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
}

/** Returns the three trusted path segments, or refuses before any request. */
export const parseSkillsShSkillId = (id: string): SkillsShAddressSegments => {
  const [owner, repo, slug, extra] = id.split("/");
  if (
    extra !== undefined || owner === undefined || repo === undefined ||
    slug === undefined || !OWNER_PATTERN.test(owner) ||
    !REPO_PATTERN.test(repo) || !SLUG_PATTERN.test(slug) ||
    DOT_ONLY_SEGMENT.test(repo) || DOT_ONLY_SEGMENT.test(slug)
  ) {
    throw new SkillsShPinResolutionError(
      "invalid_hit",
      "skills.sh pin resolution requires an id with owner, repository, and skill segments",
    );
  }
  return { owner, repo, slug };
};

/**
 * Splits a pin into the skill it names and the commit it pins, or `undefined`
 * where the string carries no commit.
 *
 * The one place the pin spelling is decided, so that a caller recognizing a
 * pin and a caller parsing one cannot come to different answers about the same
 * string.
 *
 * The head is not validated here: a caller that needs a skill address says so
 * by running it through {@link parseSkillsShSkillId}, and a caller that only
 * has to recognize the shape does not pay for that.
 */
export const splitSkillsShPin = (
  pin: string,
): { readonly id: string; readonly commitSha: string } | undefined => {
  const at = pin.lastIndexOf("@");
  if (at <= 0) {
    return undefined;
  }
  const commitSha = pin.slice(at + 1);
  return FULL_GIT_COMMIT_SHA_PATTERN.test(commitSha)
    ? { id: pin.slice(0, at), commitSha }
    : undefined;
};

/** Adds the discovery hit's redundant source agreement to the id check. */
const parseHitId = (hit: SkillsShSearchHit): SkillsShAddressSegments => {
  const parsed = parseSkillsShSkillId(hit.id);
  if (hit.source !== `${parsed.owner}/${parsed.repo}`) {
    throw new SkillsShPinResolutionError(
      "invalid_hit",
      "skills.sh pin resolution requires an id whose owner and repository match its source",
    );
  }
  return parsed;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isObjectNotArray(value) ? value as Record<string, unknown> : undefined;

/** Fetches one GitHub API object, parsing the body rather than trusting status. */
const fetchGithubObject = async (
  fetch: HarnessFetch,
  url: string,
): Promise<Record<string, unknown>> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    throw new SkillsShPinResolutionError(
      "request_failed",
      `GitHub pin resolution could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!response.ok) {
    throw new SkillsShPinResolutionError(
      "http_error",
      `GitHub pin resolution answered ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SkillsShPinResolutionError(
      "unparseable_response",
      "GitHub pin resolution answered with a body that is not JSON",
    );
  }
  const object = asRecord(body);
  if (object === undefined) {
    throw new SkillsShPinResolutionError(
      "unparseable_response",
      "GitHub pin resolution answered without an object",
    );
  }
  return object;
};

/** Shared GitHub resolution after the discovery address has been validated. */
const resolveSkillsShParsedPin = async (
  id: string,
  parsed: SkillsShAddressSegments,
  options: ResolveSkillsShHitPinOptions = {},
): Promise<SkillsShPinnedAddress> => {
  const { owner, repo, slug } = parsed;
  const fetch = options.fetch ?? defaultHarnessFetch;
  const repositoryUrl = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}`;
  const repository = await fetchGithubObject(fetch, repositoryUrl);
  const defaultBranch = repository.default_branch;
  if (
    typeof defaultBranch !== "string" || defaultBranch.length === 0 ||
    defaultBranch.length > 255
  ) {
    throw new SkillsShPinResolutionError(
      "unparseable_response",
      "GitHub repository metadata carried no usable default branch",
    );
  }

  const branchUrl = `${repositoryUrl}/branches/${
    encodeURIComponent(defaultBranch)
  }`;
  const branch = await fetchGithubObject(fetch, branchUrl);
  const commitSha = asRecord(branch.commit)?.sha;
  if (
    typeof commitSha !== "string" ||
    !FULL_GIT_COMMIT_SHA_PATTERN.test(commitSha)
  ) {
    throw new SkillsShPinResolutionError(
      "unparseable_response",
      "GitHub default-branch metadata carried no full commit SHA",
    );
  }

  return {
    id,
    owner,
    repo,
    slug,
    commitSha,
    resolvedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
};

/**
 * Resolves a validated discovery id without asking the registry for anything
 * else. The repository mapping is derived from the id's own path segments.
 */
export const resolveSkillsShSkillIdPin = async (
  id: string,
  options: ResolveSkillsShHitPinOptions = {},
): Promise<SkillsShPinnedAddress> =>
  await resolveSkillsShParsedPin(id, parseSkillsShSkillId(id), options);

/**
 * Resolves `hit` to the full commit SHA at its source repository's default
 * branch head. The registry's own served hash is not consulted or stored: it
 * is an unverified change detector, not a pin.
 */
export const resolveSkillsShHitPin = async (
  hit: SkillsShSearchHit,
  options: ResolveSkillsShHitPinOptions = {},
): Promise<SkillsShPinnedAddress> =>
  await resolveSkillsShParsedPin(hit.id, parseHitId(hit), options);
