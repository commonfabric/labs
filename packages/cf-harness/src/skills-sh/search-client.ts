/**
 * A read-only client over the public skills.sh search route: what a candidate
 * skill is called and where it lives, and never a byte of what it says.
 *
 * This is the discovery half of `docs/plans/external-skill-acquisition.md`.
 * Nothing here fetches, materializes, or returns skill text; a hit is an
 * identifier that a later, pinned acquisition step resolves.
 *
 * Two properties are the point, and both are tested:
 *
 * - **Every string the registry returns is hostile.** A name is an injection
 *   vector and an identifier is a squat, so a value is sanitized before it can
 *   reach any context, and an identifier that does not match the shape the
 *   registry documents is dropped rather than passed through sanitized.
 * - **A response is a hit when it parses into the shape required, and at no
 *   earlier point.** The registry answers some paths it does not serve with an
 *   HTML page under a 200, so a status check is not evidence that the thing
 *   asked for came back.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";

/** Default origin of the public search route. */
export const SKILLS_SH_DEFAULT_ORIGIN = "https://skills.sh";

/** Hits returned to a caller. Beyond this a caller narrows its query. */
export const SKILLS_SH_MAX_RESULTS = 20;

/** Longest a sanitized registry string may be before it is truncated. */
export const SKILLS_SH_MAX_FIELD_CHARS = 200;

/**
 * A registry identifier, `{owner}/{repo}/{slug}`, with a character set per
 * segment rather than one shared class: an owner and a repository follow the
 * source host's naming rules, while a slug is the registry's own and admits
 * more -- `stitch::react-native` is a real listing, and a single tight class
 * would drop it. No segment may be made only of dots, which is a traversal
 * step wearing a name.
 *
 * An identifier that does not match is not repaired into one. It is dropped,
 * because a value that had to be repaired to look legitimate is the case the
 * repair would hide.
 */
const SKILL_ID_PATTERN =
  /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._:-]{1,100}$/;

/** A segment made only of dots: `.`, `..`, and anything longer. */
const DOT_ONLY_SEGMENT = /(?:^|\/)\.+(?:\/|$)/;

/** A source repository, `{owner}/{repo}`. */
const SOURCE_PATTERN = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** A registry owner, as the search route accepts one. */
const OWNER_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

/**
 * One candidate. The hit type has no field for skill text and that absence is
 * the boundary.
 */
export interface SkillsShSearchHit {
  /** Registry identifier, `{owner}/{repo}/{slug}`. Not a content address. */
  readonly id: string;

  /** Display name, sanitized. Never authority for anything. */
  readonly name: string;

  /** Source repository, `{owner}/{repo}`. Where a pinned address is found. */
  readonly source: string;

  /**
   * The registry's install count, when it reported one.
   *
   * Carried as a number and nothing more. The registry's index is populated by
   * unauthenticated client telemetry, so this is forgeable by anyone who can
   * make an HTTP request: it may be shown as what it is, and it may never rank
   * a selection, gate a decision, or stand in for review.
   */
  readonly installs?: number;
}

export interface SkillsShSearchResult {
  readonly hits: readonly SkillsShSearchHit[];

  /**
   * Entries the registry returned that this client refused. Reported rather
   * than swallowed: a caller that sees five hits where it expected six should
   * be able to tell that one was dropped from a response that parsed.
   */
  readonly rejected: number;
}

export type SkillsShSearchFailureCode =
  | "invalid_query"
  | "request_failed"
  | "http_error"
  | "unparseable_response";

export class SkillsShSearchError extends Error {
  override readonly name = "SkillsShSearchError";
  readonly code: SkillsShSearchFailureCode;

  constructor(code: SkillsShSearchFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

// A terminal escape is a sequence, not a character, so removing the escape
// byte alone would leave its parameters behind as visible text -- the
// difference between deleting an injected sequence and rendering it. These
// four cover the families that carry a payload: operating-system commands,
// the device-control group, control sequences, and the two-character escapes.
// The payload-carrying families also terminate at end of input: a sequence
// the input ends before terminating still carries its payload, and requiring
// the terminator would hand that payload back as visible text.
const ESCAPE_SEQUENCES: readonly RegExp[] = [
  // deno-lint-ignore no-control-regex
  /\x1b][\s\S]*?(?:\x07|\x1b\\|$)/g,
  // deno-lint-ignore no-control-regex
  /\x1b[P^_][\s\S]*?(?:\x1b\\|$)/g,
  // deno-lint-ignore no-control-regex
  /\x1b[[][\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g,
  // deno-lint-ignore no-control-regex
  /\x1b[\x20-\x7e]/g,
];

// What is left once the sequences are gone: stray control and C1 codepoints,
// and the zero-width and bidirectional characters that let one span of text
// render as another.
const UNSAFE_CODEPOINTS =
  // deno-lint-ignore no-control-regex
  /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * A registry string made safe to place in context: escape sequences and unsafe
 * codepoints are removed outright rather than replaced, runs of whitespace
 * collapse to single spaces so nothing can lay itself out as a separate
 * instruction, and the result is capped.
 */
export const sanitizeRegistryString = (value: string): string => {
  let stripped = value;
  for (const sequence of ESCAPE_SEQUENCES) {
    stripped = stripped.replace(sequence, "");
  }
  // Whitespace collapses before the codepoints are stripped, not after: a
  // newline is both, and removing it first would join the two lines it
  // separated into one word.
  const collapsed = stripped.replace(/\s+/g, " ").replace(UNSAFE_CODEPOINTS, "")
    .trim();
  return collapsed.length > SKILLS_SH_MAX_FIELD_CHARS
    ? collapsed.slice(0, SKILLS_SH_MAX_FIELD_CHARS)
    : collapsed;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isObjectNotArray(value) ? value as Record<string, unknown> : undefined;

/**
 * One entry, or `undefined` when it is not a hit this client will report.
 * Every refusal is about the entry's shape, and none of them repairs it.
 */
const readHit = (entry: unknown): SkillsShSearchHit | undefined => {
  const record = asRecord(entry);
  if (record === undefined) return undefined;

  const { id, source } = record;
  if (typeof id !== "string" || !SKILL_ID_PATTERN.test(id)) return undefined;
  if (DOT_ONLY_SEGMENT.test(id)) return undefined;
  if (typeof source !== "string" || !SOURCE_PATTERN.test(source)) {
    return undefined;
  }
  // An identifier that does not sit under the source it claims describes two
  // different places at once, and there is no reading of that worth keeping.
  if (!id.startsWith(`${source}/`)) return undefined;

  const name = sanitizeRegistryString(
    typeof record.name === "string" ? record.name : "",
  );
  if (name === "") return undefined;

  const { installs } = record;
  return {
    id,
    name,
    source,
    ...(typeof installs === "number" && Number.isFinite(installs) &&
        installs >= 0
      ? { installs }
      : {}),
  };
};

export interface SkillsShSearchClientOptions {
  readonly fetch?: HarnessFetch;
  readonly origin?: string;
}

export interface SkillsShSearchRequest {
  readonly query: string;

  /** Restrict to one registry owner. Shape-checked before it is sent. */
  readonly owner?: string;

  readonly limit?: number;
}

/**
 * Read-only access to the public search route.
 *
 * The route this calls is undocumented and unversioned -- the registry's
 * documented API describes a different surface, behind a credential we cannot
 * obtain -- so a caller should treat `request_failed` and
 * `unparseable_response` as ordinary outcomes rather than anomalies.
 */
export class SkillsShSearchClient {
  readonly #fetch: HarnessFetch;
  readonly #origin: string;

  constructor(options: SkillsShSearchClientOptions = {}) {
    this.#fetch = options.fetch ?? defaultHarnessFetch;
    this.#origin = (options.origin ?? SKILLS_SH_DEFAULT_ORIGIN).replace(
      /\/+$/,
      "",
    );
  }

  async search(request: SkillsShSearchRequest): Promise<SkillsShSearchResult> {
    const query = request.query.trim();
    if (query.length < 2) {
      throw new SkillsShSearchError(
        "invalid_query",
        "skills.sh search requires a query of at least two characters",
      );
    }
    if (
      request.owner !== undefined && !OWNER_PATTERN.test(request.owner)
    ) {
      throw new SkillsShSearchError(
        "invalid_query",
        "skills.sh search owner must be a registry owner name",
      );
    }

    // Clamping a malformed limit would send the malformation on: NaN and 2.5
    // survive Math.min/Math.max, reach the query string, and then compare
    // against hit counts. A malformed limit is refused, not smoothed over.
    if (
      request.limit !== undefined &&
      (!Number.isInteger(request.limit) || request.limit < 1)
    ) {
      throw new SkillsShSearchError(
        "invalid_query",
        "skills.sh search limit must be a positive integer",
      );
    }
    const limit = Math.min(
      request.limit ?? SKILLS_SH_MAX_RESULTS,
      SKILLS_SH_MAX_RESULTS,
    );
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (request.owner !== undefined) params.set("owner", request.owner);
    const url = `${this.#origin}/api/search?${params.toString()}`;

    let response: Response;
    try {
      response = await this.#fetch(url);
    } catch (error) {
      throw new SkillsShSearchError(
        "request_failed",
        `skills.sh search could not be reached: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!response.ok) {
      throw new SkillsShSearchError(
        "http_error",
        `skills.sh search answered ${response.status}`,
      );
    }

    // The parse is the gate. A path this registry does not serve answers with
    // its own HTML page under a 200, so `response.ok` says that something came
    // back and never that it is the thing asked for.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SkillsShSearchError(
        "unparseable_response",
        "skills.sh search answered with a body that is not JSON",
      );
    }
    const entries = asRecord(body)?.skills;
    if (!Array.isArray(entries)) {
      throw new SkillsShSearchError(
        "unparseable_response",
        "skills.sh search answered without a skills array",
      );
    }

    const hits: SkillsShSearchHit[] = [];
    let rejected = 0;
    for (const entry of entries) {
      const hit = readHit(entry);
      if (hit === undefined) {
        rejected += 1;
        continue;
      }
      if (hits.length < limit) hits.push(hit);
    }
    return { hits, rejected };
  }
}

/** Builds the skills.sh search client used by a run. */
export type HarnessSkillsShSearchClientFactory = () => Promise<
  SkillsShSearchClient
>;

/** Creates a client factory over one configured registry origin. */
export const createHarnessSkillsShSearchClientFactory = (
  baseUrl: string,
  fetch?: HarnessFetch,
): HarnessSkillsShSearchClientFactory =>
() =>
  Promise.resolve(
    new SkillsShSearchClient({
      origin: baseUrl,
      ...(fetch !== undefined ? { fetch } : {}),
    }),
  );

/**
 * Caches a healthy client for one run. A rejected construction is forgotten
 * so the next call may retry it.
 */
export const cacheHarnessSkillsShSearchClientFactory = (
  factory: HarnessSkillsShSearchClientFactory,
): HarnessSkillsShSearchClientFactory => {
  let client: Promise<SkillsShSearchClient> | undefined;
  return () => {
    if (client === undefined) {
      const attempt = Promise.resolve().then(factory).catch((error) => {
        if (client === attempt) client = undefined;
        throw error;
      });
      client = attempt;
    }
    return client;
  };
};
