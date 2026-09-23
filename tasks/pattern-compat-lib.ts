/**
 * Tier 1 of the pattern-update regime: prove that a pattern's current
 * argument/result contract can still be applied to every version of itself
 * that is, or was, deployed.
 *
 * Why this exists as a CI gate rather than a runtime check: `cf piece setsrc`
 * refuses an incompatible replacement (`PieceController.setPattern` calls
 * `assertPatternSchemasBackwardCompatible`), but the *automatic* updater does
 * not — `PatternUpdater` compiles, verifies the entry identity, and applies via
 * `runtime.setup`/`patternIdentity` with no structural comparison at all
 * (docs/specs/pattern-imports/pattern-updates.md, "The specialized system-source
 * updater does not perform the complete pre-apply structural comparison").
 * An incompatible schema that merges is therefore applied silently to every
 * running piece. CI is the only gate, so this reuses the exact function
 * `setsrc` enforces rather than reimplementing the rule.
 *
 * This module is the pure core: no compiling, no filesystem, no git. The task
 * shell (`pattern-compat.ts`) supplies the compiled contracts and the baseline
 * files it read off disk.
 */

import { type JSONSchema, type Pattern } from "@commonfabric/runner";
import { validateSchemaDefinition } from "@commonfabric/runner/cfc";
import { type FabricValue, hashStringOf } from "@commonfabric/data-model";
import { JsonCodecEngine } from "@commonfabric/data-model/codec-json";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { assertPatternSchemasBackwardCompatible } from "../packages/piece/src/schema-compatibility.ts";
import { readOnlyArguments } from "./only-arguments.ts";

/**
 * The two schemas that constitute a pattern's update contract. Nothing else
 * about a pattern participates: `assertPatternSchemasBackwardCompatible` reads
 * exactly these four values across its two arguments, which is why a baseline
 * can be a small JSON file rather than a compiled artifact.
 */
export interface PatternContract {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
}

/** A contract that is, or was, deployed. `label` is its filename stem. */
export interface Baseline {
  label: string;
  contract: PatternContract;
}

export type Finding =

  /** The current contract is not recorded, so nothing pins it for the next PR. */
  | { kind: "missing-baseline"; pattern: string; hash: string }
  /** The current contract cannot be applied over a deployed one. */
  | {
    kind: "incompatible";
    pattern: string;
    baseline: string;
    detail: string;
  }
  /** The current contract is not a well-formed schema on its own terms. */
  | { kind: "invalid-schema"; pattern: string; role: string; detail: string }
  /** Baselines outlived their source: pieces tracking this path are pinned. */
  | { kind: "retired"; pattern: string; baselines: string[] };

/**
 * How much of the base64url SHA-256 goes in a filename. The hash only has to
 * be unique within one pattern's own directory, so 16 characters (96 bits) is
 * far past collision-relevant while keeping `<iso>-<hash>.json` readable.
 */
const HASH_LENGTH = 16;

/**
 * A stable content address for a contract. `hashStringOf` canonicalizes key
 * order (the same machinery `internSchema` hashes through), so a reordered but
 * structurally identical schema addresses to the same baseline instead of
 * minting a spurious one.
 */
export function contractHash(contract: PatternContract): string {
  return hashStringOf({
    argumentSchema: contract.argumentSchema,
    resultSchema: contract.resultSchema,
  }).slice(0, HASH_LENGTH);
}

/** Parsed command line. `only` restricts to paths containing any of its terms. */
export interface CliOptions {
  update: boolean;
  only: string[];
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const read = readOnlyArguments(argv);
  if ("error" in read) throw new Error(read.error);
  const { only, rest } = read;
  let update = false;
  for (const argument of rest) {
    if (argument === "--update") update = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { update, only };
}

/**
 * The share of the patterns `PATTERN_COMPAT_SHARD` names, as `"i/n"` counting
 * from one, or all of them where it names nothing. Compiling a pattern is
 * single-threaded CPU work, so dividing the patterns between processes is
 * what puts more cores to use.
 */
export function parseShard(raw: string | undefined): {
  index: number;
  count: number;
} {
  if (!raw) return { index: 0, count: 1 };
  const match = raw.match(/^(\d+)\/(\d+)$/);
  if (!match) throw new Error(`Invalid shard "${raw}"; expected "i/n".`);
  const index = Number(match[1]) - 1;
  const count = Number(match[2]);
  if (count < 1 || index < 0 || index >= count) {
    throw new Error(`Shard "${raw}" out of range.`);
  }
  return { index, count };
}

/**
 * A baseline's filename. The timestamp is human metadata — when this contract
 * was recorded — and sorts chronologically because ISO basic format does. The
 * authoritative hash is always recomputed from the file's CONTENTS, so a
 * renamed or mislabelled file cannot misreport what it holds.
 */
export function baselineFileName(recordedAt: Date, hash: string): string {
  const stamp = recordedAt.toISOString().replace(/[-:]/g, "").replace(
    /\.\d+Z$/,
    "Z",
  );
  return `${stamp}-${hash}.json`;
}

/** What a baseline file holds. `pattern` is for readability of a lone file. */
export interface StoredBaseline extends PatternContract {
  pattern: string;
}

/**
 * Baselines are encoded with the Fabric JSON codec, not `JSON.stringify`.
 *
 * The schema generator is free to produce values plain JSON cannot represent,
 * and `JSON.stringify` mostly does not refuse them — it substitutes quietly,
 * rendering `-0` as `0` and `NaN` and the infinities as `null` (a bigint is the
 * exception that throws). A baseline that silently flattens a value agrees with
 * buggy output instead of catching it, and worse here, it would never match the
 * contract it was recorded from — the gate would report a missing baseline
 * forever. `packages/schema-generator/test/fixtures-runner.test.ts` documents
 * this same hazard for its goldens and solves it the same way.
 *
 * The encoding's prefix tag identifies it on the wire but is not part of the
 * JSON, so it cannot survive pretty-printing; taking it off and putting it back
 * goes through the codec's own helpers. Pretty-printing matters because these
 * files are read in review. Key order needs no help — a conforming encoder
 * emits plain-object keys in canonical order.
 */
export function encodeBaseline(stored: StoredBaseline): string {
  const body = JSON.parse(
    JsonCodecEngine.unwrapEncodedValueForTesting(
      jsonFromFabricValue(stored as unknown as FabricValue),
    ),
  );
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Inverse of {@link encodeBaseline}. */
export function decodeBaseline(text: string): StoredBaseline {
  return fabricFromJsonValue(
    JsonCodecEngine.wrapEncodedValueForTesting(text.trim()),
  ) as unknown as StoredBaseline;
}

/**
 * `assertPatternSchemasBackwardCompatible` takes two `Pattern`s but reads only
 * their `argumentSchema` and `resultSchema`. The remaining fields are filled
 * with empty values so a stored contract can be checked without recovering the
 * compiled artifact it came from.
 */
const asPattern = (contract: PatternContract): Pattern => ({
  argumentSchema: contract.argumentSchema,
  resultSchema: contract.resultSchema,
  derivedInternalCells: [],
  result: {},
  nodes: [],
});

/**
 * Check one pattern's current contract against every baseline recorded for it.
 *
 * Every baseline is checked, never just the newest. A piece rolls forward from
 * whatever version it last opened at, which may be many releases back, and the
 * evolution-policy allowances in the subset check are not guaranteed to
 * compose across steps — so proving compatibility with N-1 does not prove it
 * with N-5. Checking all of them makes the question moot.
 *
 * `current` is `undefined` when baselines exist for a path that no longer
 * compiles to a pattern.
 */
export function checkPattern(
  pattern: string,
  current: PatternContract | undefined,
  baselines: readonly Baseline[],
): Finding[] {
  if (current === undefined) {
    if (baselines.length === 0) return [];
    return [{
      kind: "retired",
      pattern,
      baselines: baselines.map((baseline) => baseline.label),
    }];
  }

  const findings: Finding[] = [];
  const hash = contractHash(current);
  const recorded = baselines.some((baseline) =>
    contractHash(baseline.contract) === hash
  );

  // An already-recorded contract is unchanged since the run that recorded it,
  // and it was validated and proved then. Re-doing that work every CI run is
  // pure waste, and it is not cheap: both the definition validator and the
  // subset proof blow up combinatorially on some real schemas (validating
  // lobby/main.tsx's schemas alone takes ~55s). Steady state — no contract
  // changed in this PR — therefore costs nothing beyond the compile.
  if (!recorded) {
    findings.push({ kind: "missing-baseline", pattern, hash });
    for (
      const [role, schema] of [
        ["argument", current.argumentSchema],
        ["result", current.resultSchema],
      ] as const
    ) {
      const issue = validateSchemaDefinition(schema);
      if (issue !== undefined) {
        findings.push({ kind: "invalid-schema", pattern, role, detail: issue });
      }
    }
  }

  const candidate = asPattern(current);
  for (const baseline of baselines) {
    // An identical contract needs no proof: "can C be applied over C" is
    // trivially yes.
    if (contractHash(baseline.contract) === hash) continue;
    try {
      assertPatternSchemasBackwardCompatible(
        asPattern(baseline.contract),
        candidate,
      );
    } catch (error) {
      findings.push({
        kind: "incompatible",
        pattern,
        baseline: baseline.label,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return findings;
}

//
// Baseline store
//
// Parameterized by directory so these are testable against a temp tree rather
// than only against the real `packages/patterns` layout.
//

/** Read every recorded contract for a pattern. Absent directory → none. */
export async function readBaselines(
  baselinesDir: string,
  key: string,
): Promise<Baseline[]> {
  const dir = `${baselinesDir}/${key}`;
  const baselines: Baseline[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const stored = decodeBaseline(
      await Deno.readTextFile(`${dir}/${entry.name}`),
    );
    baselines.push({
      label: entry.name.replace(/\.json$/, ""),
      contract: {
        argumentSchema: stored.argumentSchema,
        resultSchema: stored.resultSchema,
      },
    });
  }
  return baselines.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Every pattern key that has a baseline directory, including retired ones.
 *
 * A pattern's own directory is named for its file (`home.tsx`), so a name
 * ending in `.ts`/`.tsx` terminates the walk and anything else is an
 * intermediate path segment (`system/`). That is the only thing distinguishing
 * the two — baselines live at `<dir>/<pattern path>/<file>.json`, and a pattern
 * path is exactly the route suffix the updater keys on.
 */
export async function collectBaselineKeys(
  baselinesDir: string,
): Promise<string[]> {
  const keys: string[] = [];
  async function walk(current: string, prefix: string) {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(current)];
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        keys.push(key);
      } else {
        await walk(`${current}/${entry.name}`, key);
      }
    }
  }
  await walk(baselinesDir, "");
  return keys.sort();
}

/**
 * Baselines whose pattern file is gone. Deleting a served pattern pins every
 * piece tracking it forever — the updater's `?identity` probe just fails and it
 * "does nothing" — so this is worth surfacing even though it needs no compiler.
 *
 * Filesystem-only by design: it must see the whole tree, so it cannot ride
 * along with the sharded, filterable compile pass.
 */
export async function findRetired(
  baselinesDir: string,
  currentPatterns: ReadonlySet<string>,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const key of await collectBaselineKeys(baselinesDir)) {
    if (currentPatterns.has(key)) continue;
    findings.push(
      ...checkPattern(key, undefined, await readBaselines(baselinesDir, key)),
    );
  }
  return findings;
}

/** Record a contract as a new baseline. Returns the filename written. */
export async function writeBaseline(
  baselinesDir: string,
  key: string,
  contract: PatternContract,
  recordedAt: Date,
): Promise<string> {
  const dir = `${baselinesDir}/${key}`;
  await Deno.mkdir(dir, { recursive: true });
  const name = baselineFileName(recordedAt, contractHash(contract));
  const stored: StoredBaseline = { pattern: key, ...contract };
  await Deno.writeTextFile(`${dir}/${name}`, encodeBaseline(stored));
  return name;
}

/**
 * Whether `--update` may record this contract as a new baseline.
 *
 * Only a contract whose *sole* finding is "not recorded" qualifies. A baseline
 * is documented as "a contract that is, or was, deployed", and the store is by
 * design never pruned — so recording anything else permanently constrains every
 * future contract against a version that never shipped and never could.
 *
 * The incompatible case is the one that matters. An incompatible contract
 * cannot merge, so it is never deployed; recording it would mean a later,
 * corrected contract has to prove itself against a version that only ever
 * existed in a failed run, with no way to remove it. Suppressing the repeat
 * "not recorded" noise is not worth that — and the run still fails either way,
 * so `--update` still never clears a finding.
 */
export function shouldRecord(findings: readonly Finding[]): boolean {
  return findings.length === 1 && findings[0].kind === "missing-baseline";
}

/**
 * One `(pattern, baseline)` pair an accepted break forgives.
 *
 * NUL is the separator because it is the one byte neither half can contain,
 * so no two pairs can produce the same key. It is written as an ESCAPE: the
 * literal byte in the source would make the whole file read as binary, which
 * `deno task check-control-characters` refuses for exactly that reason.
 */
export const acceptedBreakKey = (pattern: string, baseline: string): string =>
  `${pattern}\x00${baseline}`;

/**
 * The schema paths an incompatibility finding blames.
 *
 * `assertPatternSchemasBackwardCompatible` throws one error listing its issues
 * as `- <path>: <reason>` lines, so a finding's `detail` names which paths
 * failed rather than only that something did. That is what lets an acceptance
 * be scoped to the removal it was granted for.
 *
 * A line that does not parse comes back whole, deliberately. It matches no
 * accepted path, so an unrecognised message shape fails closed — the finding
 * stands — rather than being forgiven on the strength of a format assumption.
 */
export function incompatibilityPaths(detail: string): string[] {
  const paths: string[] = [];
  for (const line of detail.split("\n")) {
    const issue = line.trimStart();
    if (!issue.startsWith("- ")) continue;
    const body = issue.slice(2);
    const cut = body.indexOf(": ");
    paths.push(cut === -1 ? body : body.slice(0, cut));
  }
  return paths;
}

/**
 * Split findings into the ones that stand and the accepted breaks among them.
 *
 * Only an `incompatible` finding can be accepted. Everything else — a contract
 * that is not recorded, a schema that is invalid on its own terms, baselines
 * that outlived their source — describes work still to do, and an accepted
 * break says nothing about any of them.
 *
 * A finding is forgiven only when EVERY path it blames is one the entry named.
 * The pair alone is not enough: one finding carries every issue the proof found
 * against that baseline, so forgiving by pair would also suppress an unintended
 * break that landed in the same change — and `--update` would then record the
 * broken contract as the new baseline. A finding whose paths cannot be read
 * yields none, which is not a match either.
 *
 * The forgiven ones come back rather than being dropped, because an exemption
 * nobody sees is an exemption nobody reviews: the run prints what it forgave,
 * and uses the same list to fail on a pair that no longer needs forgiving.
 */
export function partitionAcceptedBreaks(
  findings: readonly Finding[],
  accepted: ReadonlyMap<string, ReadonlySet<string>>,
): { standing: Finding[]; forgiven: Finding[] } {
  const standing: Finding[] = [];
  const forgiven: Finding[] = [];
  for (const finding of findings) {
    if (finding.kind !== "incompatible") {
      standing.push(finding);
      continue;
    }
    const paths = accepted.get(
      acceptedBreakKey(finding.pattern, finding.baseline),
    );
    const blamed = incompatibilityPaths(finding.detail);
    const isAccepted = paths !== undefined && blamed.length > 0 &&
      blamed.every((path) => paths.has(path));
    (isAccepted ? forgiven : standing).push(finding);
  }
  return { standing, forgiven };
}
