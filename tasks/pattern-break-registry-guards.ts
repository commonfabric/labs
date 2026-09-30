/**
 * Static guards over the two accepted-break registries
 * (`pattern-compat-accepted-breaks.ts`, `pattern-vintage-accepted-drops.ts`).
 *
 * The registries' own audits are per-run and per-finding: an entry that stops
 * forgiving anything fails the run that would have used it. These guards are
 * about what an entry IS, before any finding exists:
 *
 * - **No entry may name a required pattern without a ruling.** The home and
 *   default-app roots are the patterns that update aggressively and
 *   unconditionally — a break accepted there is a decision to strand every
 *   space's root the moment it merges, which is never the intent of a
 *   per-pattern exemption. An entry that carries a `requiredPatternOverride`
 *   names the person who made that decision, and passes; one that does not
 *   is refused. The required set comes in from the caller, derived from the
 *   runtime's own constants (the same seam `pattern-vintage` already uses),
 *   so this guard cannot drift from what actually auto-updates.
 * - **Every entry names its decision record, and the record exists.** The
 *   registry line is the declaration; the record under `docs/history/` is the
 *   deliberation — what broke, why it was accepted, and what happens to the
 *   pieces holding the old shape. A record is a Markdown document of that
 *   tree's own: the path may not step back out of it, and the tree's live
 *   scaffolding (`README.md`, `INDEX.md`) does not qualify.
 *   `check-docs-history-index` forces every other document under the tree to
 *   be indexed, so this guard's shape-plus-existence check is membership.
 *
 * Pure and parameterized (entries, required set, existence probe) so the
 * rules are provable against synthetic registries in
 * `pattern-break-registry-guards.test.ts`, with the shipped registries
 * checked against the real tree in the same suite.
 */

import { fromFileUrl } from "@std/path/from-file-url";

import {
  ACCEPTED_CONTRACT_BREAKS,
  type RequiredPatternOverride,
} from "./pattern-compat-accepted-breaks.ts";
import {
  ACCEPTED_STATE_DROPS,
  patternKeyClaims,
} from "./pattern-vintage-accepted-drops.ts";
import {
  reportUnmappedUrls,
  requiredPatternKeys,
  unmappedPatternUrls,
} from "./pattern-vintage-lib.ts";

/**
 * The repository root, absolute. Derived from this module's own location so
 * every gate resolves a record to the same file whatever directory the task
 * was invoked from — the workspace runner does not run them from the root.
 */
const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(
  /\/$/,
  "",
);

/** The registry-independent shape both kinds of entry share. */
export interface BreakRegistryEntry {
  /** Which registry the entry sits in, for reporting. */
  registry: string;

  /** Pattern key: the path relative to `packages/patterns`. */
  pattern: string;

  /** Repo-relative path of the entry's decision record. */
  record: string;

  /** The ruling under which the entry may name a required pattern, if any. */
  requiredPatternOverride?: RequiredPatternOverride;
}

export interface BreakRegistryFinding {
  registry: string;
  pattern: string;
  detail: string;
}

const RECORD_PREFIX = "docs/history/";

/** The history tree's own live scaffolding — never a decision record. */
const RECORD_SCAFFOLDING = new Set(["readme.md", "index.md"]);

/**
 * Why `record` cannot name a decision record, or `undefined` when its shape
 * qualifies. Shape only — existence is the caller's probe, and it runs only
 * on paths this has already passed, so the probe never resolves a traversal
 * out of the tree.
 */
function recordPathProblem(record: string): string | undefined {
  if (!record.startsWith(RECORD_PREFIX)) {
    return `is not under ${RECORD_PREFIX} — the decision record lives in ` +
      `the history tree`;
  }
  // Both separators: on Windows the probe's stat resolves a backslash as a
  // path separator, so a slash-only split would let `..\` step out.
  const segments = record.slice(RECORD_PREFIX.length).split(/[/\\]/);
  if (segments.some((s) => s === ".." || s === "." || s === "")) {
    return `steps back out of ${RECORD_PREFIX} — a dot or empty segment ` +
      `defeats the prefix`;
  }
  if (!record.endsWith(".md")) {
    return `is not a Markdown document — a decision record is one`;
  }
  // The tree root's own two files; a NESTED file by either name is an
  // ordinary indexed document.
  // Compared case-insensitively because the existence probe resolves the live
  // README.md/INDEX.md for alternate casing on common macOS and Windows file
  // systems — the same platforms the separator split above exists for. The
  // shape check must reject those spellings before the probe ever runs.
  if (
    segments.length === 1 &&
    RECORD_SCAFFOLDING.has(segments[0].toLowerCase())
  ) {
    return `is the history tree's own scaffolding, not a decision record`;
  }
  return undefined;
}

/**
 * Whether a key written in an exemption list addresses a required pattern.
 *
 * Asked through `patternKeyClaims` — the registries' own matcher — rather
 * than by string equality or by a rule this module derives for itself. A
 * floor that judged membership its own way would accept a spelling the
 * consumer honors, which is the whole of how an exemption walks around it.
 *
 * Asked in BOTH directions, because the consumer anchors its suffix on the
 * manifest path while a required pattern arrives here as a key. A key
 * SHORTER than the required one claims it by being a suffix of it
 * (`home.tsx` for `system/home.tsx`), and a key LONGER than it claims it by
 * carrying a path prefix the manifest also carries
 * (`packages/patterns/system/home.tsx`, or the `api/patterns/` route a
 * manifest's `main` may name). Either spelling reaches the same pattern, so
 * the floor has to refuse both.
 *
 * The relation is prefix-agnostic on purpose: reconstructing a manifest path
 * to compare against would hardcode one of the prefixes a manifest can
 * actually carry, and the floor would be blind to the others.
 */
function namesRequiredPattern(
  requiredPatternKeys: ReadonlySet<string>,
  pattern: string,
): boolean {
  for (const key of requiredPatternKeys) {
    if (patternKeyClaims(key, pattern) || patternKeyClaims(pattern, key)) {
      return true;
    }
  }
  return false;
}

/**
 * Why an override cannot stand as the ruling it claims to be, or `undefined`
 * when it can: each of its three fields is present and non-blank, and the
 * date is spelled `YYYY-MM-DD`. Shape only — nothing here judges whether the
 * person named ruled what the reason says.
 */
function overrideProblem(
  override: RequiredPatternOverride,
): string | undefined {
  if (override.rulingBy.trim() === "") {
    return "names nobody in \`rulingBy\` — a ruling is a person's";
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(override.on)) {
    return `dates the ruling "${override.on}" — \`on\` is spelled ` +
      `\`YYYY-MM-DD\``;
  }
  if (override.reason.trim() === "") {
    return "carries no \`reason\` — the ruling is quoted or summarized there";
  }
  return undefined;
}

/** Both shipped registries, flattened to the shape the guards judge. */
export function collectBreakRegistryEntries(): BreakRegistryEntry[] {
  return [
    ...ACCEPTED_CONTRACT_BREAKS.map((entry) => ({
      registry: "pattern-compat-accepted-breaks",
      pattern: entry.pattern,
      record: entry.record,
      requiredPatternOverride: entry.requiredPatternOverride,
    })),
    ...ACCEPTED_STATE_DROPS.map((entry) => ({
      registry: "pattern-vintage-accepted-drops",
      pattern: entry.pattern,
      record: entry.record,
    })),
  ];
}

export function guardBreakRegistryEntries(options: {
  entries: readonly BreakRegistryEntry[];
  requiredPatternKeys: ReadonlySet<string>;
  recordExists: (repoRelativePath: string) => boolean;
}): BreakRegistryFinding[] {
  const findings: BreakRegistryFinding[] = [];
  for (const entry of options.entries) {
    if (namesRequiredPattern(options.requiredPatternKeys, entry.pattern)) {
      const override = entry.requiredPatternOverride;
      if (override === undefined) {
        findings.push({
          registry: entry.registry,
          pattern: entry.pattern,
          detail: `names a required pattern — an auto-updating root takes ` +
            `an accepted break only under a \`requiredPatternOverride\` ` +
            `naming who ruled it`,
        });
      } else {
        const problem = overrideProblem(override);
        if (problem !== undefined) {
          findings.push({
            registry: entry.registry,
            pattern: entry.pattern,
            detail: `carries a \`requiredPatternOverride\` that ${problem}`,
          });
        }
      }
    }
    const pathProblem = recordPathProblem(entry.record);
    if (pathProblem !== undefined) {
      findings.push({
        registry: entry.registry,
        pattern: entry.pattern,
        detail: `record "${entry.record}" ${pathProblem}`,
      });
    } else if (!options.recordExists(entry.record)) {
      findings.push({
        registry: entry.registry,
        pattern: entry.pattern,
        detail: `record "${entry.record}" does not exist — an accepted ` +
          `break carries its deliberation, not just its declaration`,
      });
    }
  }
  return findings;
}

/**
 * Findings for patterns exempted from Tier 1 by being unevaluable.
 *
 * `UNEVALUABLE_PATTERNS` is debt made visible: a file that throws while being
 * evaluated yields no contract, so it can never be recorded and never
 * checked. That is a WIDER exemption than any accepted break — not "this
 * finding is forgiven" but "this pattern is not gated at all" — so the floor
 * that keeps the auto-updating roots out of the break registries has to reach
 * it too, or the strictest rule is the one with the easiest way around it.
 *
 * Tier 1 only, because Tier 1 is the gate this list exempts anything from.
 * The list is empty of required patterns today, so this costs nothing now and
 * refuses the one addition that would matter.
 */
export function guardUnevaluableExemptions(options: {
  unevaluable: ReadonlySet<string>;
  requiredPatternKeys: ReadonlySet<string>;
}): BreakRegistryFinding[] {
  const findings: BreakRegistryFinding[] = [];
  for (const pattern of options.unevaluable) {
    if (!namesRequiredPattern(options.requiredPatternKeys, pattern)) continue;
    findings.push({
      registry: "pattern-compat-unevaluable",
      pattern,
      detail: `names a required pattern — an unevaluable pattern is exempt ` +
        `from the update gate entirely, which an auto-updating root may ` +
        `never be. Fix the pattern rather than listing it.`,
    });
  }
  return findings;
}

/**
 * Guard the shipped registries against the real tree, formatted for a task's
 * failure output. Returns `undefined` when every entry is permitted.
 */
export function reportBreakRegistryFindings(options: {
  requiredPatternKeys: ReadonlySet<string>;
  recordExists: (repoRelativePath: string) => boolean;

  /**
   * Tier 1's unevaluable list, when the caller is the gate it exempts from.
   * Omitted by Tier 2, which does not consult it.
   */
  unevaluable?: ReadonlySet<string>;
}): string | undefined {
  const findings = [
    ...guardBreakRegistryEntries({
      entries: collectBreakRegistryEntries(),
      requiredPatternKeys: options.requiredPatternKeys,
      recordExists: options.recordExists,
    }),
    ...(options.unevaluable === undefined ? [] : guardUnevaluableExemptions({
      unevaluable: options.unevaluable,
      requiredPatternKeys: options.requiredPatternKeys,
    })),
  ];
  if (findings.length === 0) return undefined;
  const lines = findings.map((finding) =>
    `  ${finding.registry}: ${finding.pattern}\n    ${finding.detail}`
  );
  return `${findings.length} pattern-exemption entr` +
    `${findings.length === 1 ? "y is" : "ies are"} not permitted:\n\n` +
    lines.join("\n");
}

/**
 * The required-pattern set both gates hold their registries to, or the report
 * to fail with.
 *
 * Derived here rather than in each gate so the two cannot come to different
 * answers about what auto-updates. The unmapped check is part of the
 * derivation and not a separate courtesy: a runtime constant that stops
 * naming a patterns route would leave `requiredPatternKeys` returning a
 * SHORTER list, and a floor that silently requires nothing is worse than no
 * floor.
 */
export function deriveRequiredPatternKeys(
  systemPatternUrls: readonly string[],
): { keys: ReadonlySet<string> } | { error: string } {
  const unmapped = unmappedPatternUrls(systemPatternUrls);
  if (unmapped.length > 0) return { error: reportUnmappedUrls(unmapped) };
  return { keys: new Set(requiredPatternKeys(systemPatternUrls)) };
}

/**
 * An existence probe for records, resolved against an ABSOLUTE repo root.
 *
 * Shared so the gates cannot disagree about what a repo-relative record path
 * resolves to. A probe built from a bare relative path answers differently
 * depending on the directory the task was invoked from, and the workspace
 * runner does not invoke these from the repo root.
 */
export function recordExistsUnder(
  repoRoot: string = REPO_ROOT,
): (repoRelativePath: string) => boolean {
  return (repoRelativePath) => {
    try {
      return Deno.statSync(`${repoRoot}/${repoRelativePath}`).isFile;
    } catch {
      return false;
    }
  };
}
