/**
 * Host-side acquisition of one skills.sh discovery id from its immutable
 * GitHub commit. The recursive tree is the payload inventory; only after that
 * inventory passes the path whitelist are the admitted files fetched.
 *
 * A skill is a directory: `SKILL.md` and, where it has them, the scripts its
 * prose tells a model to run. Both are acquired, at the one pinned commit and
 * each under the same size cap, and every other path refuses the whole
 * payload. What the acquired tree is NOT is a registry entry — it stays
 * host-side, and nothing here writes into the skills root.
 */

import { sha256 } from "@commonfabric/content-hash";
import { toUnpaddedBase64url } from "@commonfabric/utils/base64url";
import { isObjectNotArray } from "@commonfabric/utils/types";

import {
  defaultHarnessFetch,
  type HarnessFetch,
} from "../contracts/http-fetch.ts";
import {
  parseSkillsShSkillId,
  type ResolveSkillsShHitPinOptions,
  resolveSkillsShSkillIdPin,
  type SkillsShPinnedAddress,
} from "./pin.ts";
import { sanitizeRegistryString } from "./search-client.ts";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_RAW_BASE_URL = "https://raw.githubusercontent.com";
const FULL_GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MAX_TREE_PATH_CHARS = 4_096;

/** Maximum exact byte length admitted for any one acquired file. */
export const SKILLS_SH_MAX_SKILL_BYTES = 256 * 1_024;

/**
 * Most scripts one acquisition admits.
 *
 * The size cap bounds a file and this bounds the fetch: without it the number
 * of requests one acquisition makes is whatever the pinned tree says, which is
 * the publisher's number rather than ours. A skill that needs more than this
 * many scripts refuses rather than being acquired in part, on the same ground
 * every other path refusal here stands on.
 */
export const SKILLS_SH_MAX_SCRIPTS = 16;

/** The directory an acquired skill's executable files live under. */
const SCRIPTS_DIRECTORY = "scripts";

/**
 * The filenames a script may have: printable ASCII without a path separator,
 * a control codepoint, or a leading dot.
 *
 * An admitted path is not only checked, it is REPORTED — it reaches
 * `loadedPaths`, the tool output, and the run record, none of which sanitize
 * on the way out. A name is the publisher's text, so a control codepoint or a
 * terminal escape in one would cross into an operator's console on the
 * strength of having been admitted. The refusal is the whitelist's own:
 * whatever this does not admit refuses the payload rather than being dropped.
 */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type SkillsShAcquisitionFailureCode =
  | "invalid_pin"
  | "request_failed"
  | "http_error"
  | "unparseable_response"
  | "tree_truncated"
  | "skill_not_found"
  | "skill_ambiguous"
  | "instructions_only"
  | "too_many_scripts"
  | "skill_too_large"
  | "invalid_skill_text";

export class SkillsShAcquisitionError extends Error {
  override readonly name = "SkillsShAcquisitionError";
  readonly code: SkillsShAcquisitionFailureCode;
  readonly offendingCount?: number;
  readonly offendingPaths?: readonly string[];
  readonly candidatePaths?: readonly string[];

  constructor(
    code: SkillsShAcquisitionFailureCode,
    message: string,
    details: {
      offendingPaths?: readonly string[];
      candidatePaths?: readonly string[];
    } = {},
  ) {
    super(message);
    this.code = code;
    if (details.offendingPaths !== undefined) {
      this.offendingCount = details.offendingPaths.length;
      this.offendingPaths = details.offendingPaths;
    }
    if (details.candidatePaths !== undefined) {
      this.candidatePaths = details.candidatePaths;
    }
  }
}

/**
 * One script acquired beside a skill's instructions, at the same commit.
 *
 * `path` is relative to the skill root, so it is what the skill's own prose
 * names and what an allowlist entry matches; the digest is over the exact
 * bytes fetched, as `SKILL.md`'s is.
 *
 * The payload is those bytes rather than a decoded string. Decoding is lossy
 * at exactly the point the digest is checked: a UTF-8 byte-order mark is not
 * a character, so a decode drops it and every later byte count and digest
 * would describe a file the pinned commit never served.
 */
export interface SkillsShAcquiredScript {
  readonly path: string;
  readonly sourceUrl: string;
  readonly bytes: Uint8Array;
  readonly valueDigest: string;
}

export interface SkillsShAcquiredSkill {
  readonly pin: SkillsShPinnedAddress;
  readonly skillRoot: string;
  readonly sourceUrl: string;
  readonly text: string;
  readonly valueDigest: string;

  /**
   * The skill's scripts, in path order, empty for a skill that ships none.
   * Held apart from {@link text} because only the instructions are what the
   * skill handle carries to a model; a script is something to run, and the
   * run is gated by the operator's allowlist rather than by this fetch.
   */
  readonly scripts: readonly SkillsShAcquiredScript[];

  /** Every path this acquisition admitted, `SKILL.md` first. */
  readonly loadedPaths: readonly string[];
}

export interface AcquireSkillsShPinnedSkillOptions {
  readonly fetch?: HarnessFetch;
}

interface GithubTreeEntry {
  readonly path: string;
  readonly mode: "040000" | "100644" | "100755" | "120000" | "160000";
  readonly type: "blob" | "tree" | "commit";
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  isObjectNotArray(value) ? value as Record<string, unknown> : undefined;

const safeHostileText = (value: unknown): string =>
  sanitizeRegistryString(
    value instanceof Error ? value.message : String(value),
  );

const acquisitionError = (
  code: SkillsShAcquisitionFailureCode,
  message: string,
): SkillsShAcquisitionError => new SkillsShAcquisitionError(code, message);

const fetchResponse = async (
  fetch: HarnessFetch,
  url: string,
  label: string,
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(
      url,
      label === "GitHub tree"
        ? {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        }
        : undefined,
    );
  } catch (error) {
    throw acquisitionError(
      "request_failed",
      `${label} could not be reached: ${safeHostileText(error)}`,
    );
  }
  if (!response.ok) {
    throw acquisitionError(
      "http_error",
      `${label} answered ${response.status}`,
    );
  }
  return response;
};

const isUsableTreePath = (path: string): boolean => {
  if (
    path.length === 0 || path.length > MAX_TREE_PATH_CHARS ||
    path.startsWith("/") || path.endsWith("/")
  ) {
    return false;
  }
  return path.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
};

const readTreeEntries = (body: unknown): readonly GithubTreeEntry[] => {
  const record = asRecord(body);
  if (record === undefined || !Array.isArray(record.tree)) {
    throw acquisitionError(
      "unparseable_response",
      "GitHub tree answered without a tree array",
    );
  }
  if (record.truncated === true) {
    throw acquisitionError(
      "tree_truncated",
      "GitHub marked the recursive tree as truncated; the payload inventory is unreadable",
    );
  }
  if (record.truncated !== false) {
    throw acquisitionError(
      "unparseable_response",
      "GitHub tree answered without an explicit truncation status",
    );
  }

  const entries: GithubTreeEntry[] = [];
  for (const item of record.tree) {
    const entry = asRecord(item);
    const path = entry?.path;
    const mode = entry?.mode;
    const type = entry?.type;
    if (
      typeof path !== "string" || !isUsableTreePath(path) ||
      (mode !== "040000" && mode !== "100644" && mode !== "100755" &&
        mode !== "120000" && mode !== "160000") ||
      (type !== "blob" && type !== "tree" && type !== "commit")
    ) {
      throw acquisitionError(
        "unparseable_response",
        "GitHub tree carried a malformed tree entry",
      );
    }
    entries.push({ path, mode, type });
  }
  return entries;
};

const skillCandidatePaths = (
  pin: SkillsShPinnedAddress,
  entries: readonly GithubTreeEntry[],
): readonly string[] =>
  entries.flatMap((entry) => {
    if (entry.path === "SKILL.md") {
      return pin.repo === pin.slug ? [entry.path] : [];
    }
    const segments = entry.path.split("/");
    if (segments.at(-1) !== "SKILL.md") return [];
    return segments.at(-2) === pin.slug ? [entry.path] : [];
  });

const candidateRoot = (skillPath: string): string => {
  const slash = skillPath.lastIndexOf("/");
  return slash === -1 ? "" : skillPath.slice(0, slash);
};

/**
 * Whether one tree entry is a script this acquisition admits: a regular file
 * directly under the root's `scripts/`, named by a single path segment.
 *
 * Nested directories, symlinks, submodules and unsafe filenames are not
 * admitted, and each refuses the whole payload rather than being dropped — the
 * same rule the whitelist has always held, applied to a wider set of paths. A
 * symlink is the one worth naming: its target is a path the tree does not
 * vouch for, so admitting it would make the acquired bytes something other
 * than what the inventory said.
 */
const isAdmittedScript = (
  entry: GithubTreeEntry,
  relativePath: string,
): boolean => {
  if (entry.type !== "blob") return false;
  if (entry.mode !== "100644" && entry.mode !== "100755") return false;
  const segments = relativePath.split("/");
  return segments.length === 2 && segments[0] === SCRIPTS_DIRECTORY &&
    SAFE_SCRIPT_NAME.test(segments[1] ?? "");
};

const displayPath = (path: string): string =>
  sanitizeRegistryString(path) || "(unsafe path)";

const encodedTreePath = (path: string): string =>
  path.split("/").map((segment) => encodeURIComponent(segment)).join("/");

/**
 * The digest an acquisition records over the bytes a pinned commit served.
 *
 * Exported because `run_skill_script` re-checks an acquired script's file
 * against this digest before executing it, and a comparison of two digests is
 * only a comparison when one function produced both — the encoding is part of
 * the value, not a presentation of it.
 */
export const skillsShValueDigest = (bytes: Uint8Array): string =>
  `sha256:${toUnpaddedBase64url(sha256(bytes))}`;

const readCappedBytes = async (
  response: Response,
  label: string,
): Promise<Uint8Array> => {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;
      if (total + value.byteLength > SKILLS_SH_MAX_SKILL_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Cancellation is cleanup; it cannot replace the size refusal.
        }
        throw acquisitionError(
          "skill_too_large",
          `the pinned ${label} exceeds the ${SKILLS_SH_MAX_SKILL_BYTES}-byte limit`,
        );
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

/**
 * Fetches the recursive tree and every admitted file at exactly
 * `pin.commitSha`.
 *
 * The whitelist judges the selected candidate root's subtree, not the whole
 * repository: sibling skills and repository-level files outside that root are
 * not part of the acquired payload. Inside that subtree two things are
 * admitted — the root `SKILL.md`, and the regular files directly under
 * `scripts/` whose filenames are printable ASCII without a path separator, a
 * control codepoint or a leading dot. Any other path refuses the whole
 * payload, a skill shipping more than {@link SKILLS_SH_MAX_SCRIPTS} scripts
 * refuses on the inventory before anything is fetched, and each admitted file
 * is read under {@link SKILLS_SH_MAX_SKILL_BYTES}.
 *
 * Silently dropping a path would make what was acquired true of the payload
 * and invisible in the record; a skill whose prose references `scripts/foo.py`
 * is not that skill without the script, and would instead instruct a model to
 * run something that is not there.
 */
export const acquireSkillsShPinnedSkill = async (
  pin: SkillsShPinnedAddress,
  options: AcquireSkillsShPinnedSkillOptions = {},
): Promise<SkillsShAcquiredSkill> => {
  let parsedPin: ReturnType<typeof parseSkillsShSkillId>;
  try {
    parsedPin = parseSkillsShSkillId(pin.id);
  } catch {
    throw acquisitionError(
      "invalid_pin",
      "external skill acquisition requires a validated discovery address",
    );
  }
  if (
    parsedPin.owner !== pin.owner || parsedPin.repo !== pin.repo ||
    parsedPin.slug !== pin.slug ||
    !FULL_GIT_COMMIT_SHA_PATTERN.test(pin.commitSha)
  ) {
    throw acquisitionError(
      "invalid_pin",
      "external skill acquisition requires a validated address and full lowercase commit SHA",
    );
  }
  const fetch = options.fetch ?? defaultHarnessFetch;
  const treeUrl =
    `${GITHUB_API_BASE_URL}/repos/${pin.owner}/${pin.repo}/git/trees/${pin.commitSha}?recursive=1`;
  const treeResponse = await fetchResponse(fetch, treeUrl, "GitHub tree");
  let treeBody: unknown;
  try {
    treeBody = await treeResponse.json();
  } catch {
    throw acquisitionError(
      "unparseable_response",
      "GitHub tree answered with a body that is not JSON",
    );
  }
  const entries = readTreeEntries(treeBody);
  const candidates = skillCandidatePaths(pin, entries);
  if (candidates.length === 0) {
    throw acquisitionError(
      "skill_not_found",
      "the pinned tree contains no root SKILL.md for the exact discovery slug",
    );
  }
  if (candidates.length > 1) {
    const candidatePaths = candidates.map(displayPath);
    throw new SkillsShAcquisitionError(
      "skill_ambiguous",
      `the pinned tree contains ${candidatePaths.length} candidate roots for the exact discovery slug`,
      { candidatePaths },
    );
  }

  const skillPath = candidates[0];
  const skillEntry = entries.find((entry) => entry.path === skillPath);
  if (
    skillEntry?.type !== "blob" ||
    (skillEntry.mode !== "100644" && skillEntry.mode !== "100755")
  ) {
    throw acquisitionError(
      "unparseable_response",
      "the candidate root SKILL.md is not a regular file",
    );
  }
  const root = candidateRoot(skillPath);
  const rootPrefix = root === "" ? "" : `${root}/`;
  const payloadEntries = entries.filter((entry) =>
    root === "" || entry.path.startsWith(rootPrefix)
  );
  const withinRoot = (path: string): string =>
    root === "" ? path : path.slice(rootPrefix.length);
  const scriptEntries = payloadEntries.filter((entry) =>
    isAdmittedScript(entry, withinRoot(entry.path))
  );
  const admitted = new Set<string>([
    skillPath,
    // The `scripts` directory entry itself is admitted with what it holds: a
    // tree entry is the listing rather than a payload, and refusing it would
    // refuse every skill that ships a script at all.
    ...payloadEntries
      .filter((entry) =>
        entry.type === "tree" && withinRoot(entry.path) === SCRIPTS_DIRECTORY
      )
      .map((entry) => entry.path),
    ...scriptEntries.map((entry) => entry.path),
  ]);
  const offendingPaths = payloadEntries
    .filter((entry) => !admitted.has(entry.path))
    .map((entry) => displayPath(withinRoot(entry.path)));
  if (offendingPaths.length > 0) {
    throw new SkillsShAcquisitionError(
      "instructions_only",
      `acquisition refused ${offendingPaths.length} paths outside \`SKILL.md\` and \`${SCRIPTS_DIRECTORY}/\`: ${
        offendingPaths.join(", ")
      }`,
      { offendingPaths },
    );
  }
  if (scriptEntries.length > SKILLS_SH_MAX_SCRIPTS) {
    throw acquisitionError(
      "too_many_scripts",
      `the pinned skill ships ${scriptEntries.length} scripts, above the ${SKILLS_SH_MAX_SCRIPTS} one acquisition admits`,
    );
  }
  const sourceUrl =
    `${GITHUB_RAW_BASE_URL}/${pin.owner}/${pin.repo}/${pin.commitSha}/${
      encodedTreePath(skillPath)
    }`;
  const skillResponse = await fetchResponse(
    fetch,
    sourceUrl,
    "GitHub raw SKILL.md",
  );
  const bytes = await readCappedBytes(skillResponse, "SKILL.md");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw acquisitionError(
      "invalid_skill_text",
      "the pinned SKILL.md bytes are not UTF-8",
    );
  }
  if (text.trim().length === 0) {
    throw acquisitionError(
      "invalid_skill_text",
      "the pinned SKILL.md is empty",
    );
  }

  // Fetched after the instructions and in path order, so a partial failure
  // leaves the same refusal whichever script it was, and the record a
  // successful acquisition writes lists the payload in one stable order.
  const scripts: SkillsShAcquiredScript[] = [];
  for (
    const entry of [...scriptEntries].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    )
  ) {
    const relativePath = withinRoot(entry.path);
    const scriptUrl =
      `${GITHUB_RAW_BASE_URL}/${pin.owner}/${pin.repo}/${pin.commitSha}/${
        encodedTreePath(entry.path)
      }`;
    const scriptResponse = await fetchResponse(
      fetch,
      scriptUrl,
      `GitHub raw ${displayPath(relativePath)}`,
    );
    const scriptBytes = await readCappedBytes(
      scriptResponse,
      displayPath(relativePath),
    );
    // Decoded only to refuse what is not UTF-8. The bytes are what travels on,
    // so the decoded string is deliberately discarded.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(scriptBytes);
    } catch {
      throw acquisitionError(
        "invalid_skill_text",
        `the pinned ${displayPath(relativePath)} bytes are not UTF-8`,
      );
    }
    scripts.push({
      path: relativePath,
      sourceUrl: scriptUrl,
      bytes: scriptBytes,
      valueDigest: skillsShValueDigest(scriptBytes),
    });
  }

  return {
    pin,
    skillRoot: root === "" ? "." : displayPath(root),
    sourceUrl,
    text,
    valueDigest: skillsShValueDigest(bytes),
    scripts,
    loadedPaths: ["SKILL.md", ...scripts.map((script) => script.path)],
  };
};

export interface SkillsShAcquisitionClientOptions {
  readonly fetch?: HarnessFetch;
}

/** GitHub pin resolution and pinned acquisition for one run. */
export class SkillsShAcquisitionClient {
  readonly #fetch: HarnessFetch;

  constructor(options: SkillsShAcquisitionClientOptions = {}) {
    this.#fetch = options.fetch ?? defaultHarnessFetch;
  }

  resolvePin(
    id: string,
    options: Omit<ResolveSkillsShHitPinOptions, "fetch"> = {},
  ): Promise<SkillsShPinnedAddress> {
    return resolveSkillsShSkillIdPin(id, { ...options, fetch: this.#fetch });
  }

  acquirePin(pin: SkillsShPinnedAddress): Promise<SkillsShAcquiredSkill> {
    return acquireSkillsShPinnedSkill(pin, { fetch: this.#fetch });
  }
}

/** Builds the pinned-acquisition client used by a run. */
export type HarnessSkillsShAcquisitionClientFactory = () => Promise<
  SkillsShAcquisitionClient
>;

/** Creates a client factory over the host's GitHub fetch capability. */
export const createHarnessSkillsShAcquisitionClientFactory = (
  fetch?: HarnessFetch,
): HarnessSkillsShAcquisitionClientFactory =>
() =>
  Promise.resolve(
    new SkillsShAcquisitionClient(fetch === undefined ? {} : { fetch }),
  );

/** Caches a healthy client for one run and forgets a rejected construction. */
export const cacheHarnessSkillsShAcquisitionClientFactory = (
  factory: HarnessSkillsShAcquisitionClientFactory,
): HarnessSkillsShAcquisitionClientFactory => {
  let client: Promise<SkillsShAcquisitionClient> | undefined;
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
