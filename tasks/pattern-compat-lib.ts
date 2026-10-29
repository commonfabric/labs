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
 * running piece. CI is the only gate, so this reuses the exact proof `setsrc`
 * enforces rather than reimplementing the rule, taking its issues as data
 * (`patternSchemaIncompatibilities`) rather than as the lines of its refusal.
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
import {
  formatSchemaIncompatibility,
  patternSchemaIncompatibilities,
} from "../runtime/piece/src/schema-compatibility.ts";
import { readOnlyArguments } from "./only-arguments.ts";
import type { AcceptedContractBreak } from "./pattern-compat-accepted-breaks.ts";
import { matchesPatternFilter } from "./pattern-files.ts";

/**
 * The two schemas that constitute a pattern's update contract. Nothing else
 * about a pattern participates: `patternSchemaIncompatibilities` reads
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
  /**
   * One issue that stops the current contract being applied over a deployed
   * one. `path` is the schema path it blames, `undefined` for an issue at no
   * path, such as a baseline schema invalid on its own terms; `detail` is the
   * issue as the proof states it.
   */
  | {
    kind: "incompatible";
    pattern: string;
    baseline: string;
    path: string | undefined;
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
 * forever. `base/schema-generator/test/fixtures-runner.test.ts` documents
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
 * `patternSchemaIncompatibilities` takes two `Pattern`s but reads only
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
    const issues = patternSchemaIncompatibilities(
      asPattern(baseline.contract),
      candidate,
    );
    for (const issue of issues) {
      findings.push({
        kind: "incompatible",
        pattern,
        baseline: baseline.label,
        path: issue.path,
        detail: formatSchemaIncompatibility(issue),
      });
    }
  }

  return findings;
}

//
// Baseline store
//
// Parameterized by directory so these are testable against a temp tree rather
// than only against the real `patterns` layout.
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
 * The items one run of the gate judges: those `--only` selects, or every item
 * where it selects none.
 */
export function selectItems(
  items: readonly string[],
  only: readonly string[],
): string[] {
  return only.length === 0
    ? [...items]
    : items.filter((item) =>
      only.some((match) => matchesPatternFilter(item, match))
    );
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
 * Split findings into the ones that stand and the accepted breaks among them.
 *
 * Only an `incompatible` finding can be accepted. Everything else — a contract
 * that is not recorded, a schema that is invalid on its own terms, baselines
 * that outlived their source — describes work still to do, and an accepted
 * break says nothing about any of them.
 *
 * A finding is forgiven only when the path it blames is one the entry named
 * for its pair. The pair alone is not enough: the proof reports every issue it
 * found against that baseline, so forgiving by pair would also suppress an
 * unintended break that landed in the same change — and `--update` would then
 * record the broken contract as the new baseline. A finding blaming no path is
 * not a match either.
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
    const isAccepted = finding.path !== undefined &&
      paths?.has(finding.path) === true;
    (isAccepted ? forgiven : standing).push(finding);
  }
  return { standing, forgiven };
}

/**
 * The parts of accepted breaks that forgave nothing in a run: each pair no
 * finding was forgiven against, and for each entry, the paths it names that
 * no forgiven finding over its pairs blamed.
 *
 * An entry forgives exactly the paths it names. The proof reports every issue
 * it finds, so a named path that none of the entry's pairs blames is an
 * exemption outliving its break, the same as a pair that needs no forgiving,
 * and kept, it would silently forgive a later break at that path against the
 * pairs the entry lists.
 *
 * Only entries for the patterns in `examined` are judged, because a run given
 * `--only` sees no finding for any other pattern, and the run that examined a
 * pattern is the one that can say what its entries forgave.
 */
export function unusedAcceptances(
  entries: readonly AcceptedContractBreak[],
  examined: ReadonlySet<string>,
  forgiven: readonly Finding[],
): {
  pairs: string[];
  paths: { pattern: string; record: string; paths: string[] }[];
} {
  const usedPairs = new Set<string>();
  const usedPaths = new Set<string>();
  for (const finding of forgiven) {
    if (finding.kind !== "incompatible" || finding.path === undefined) continue;
    const pair = acceptedBreakKey(finding.pattern, finding.baseline);
    usedPairs.add(pair);
    usedPaths.add(`${pair}\x00${finding.path}`);
  }
  const pairs: string[] = [];
  const paths: { pattern: string; record: string; paths: string[] }[] = [];
  for (const entry of entries) {
    if (!examined.has(entry.pattern)) continue;
    const entryPairs = entry.baselines.map((baseline) =>
      acceptedBreakKey(entry.pattern, baseline)
    );
    for (const pair of entryPairs) {
      if (!usedPairs.has(pair)) pairs.push(pair);
    }
    const unblamed = entry.paths.filter((path) =>
      !entryPairs.some((pair) => usedPaths.has(`${pair}\x00${path}`))
    );
    if (unblamed.length > 0) {
      paths.push({
        pattern: entry.pattern,
        record: entry.record,
        paths: unblamed,
      });
    }
  }
  return { pairs, paths };
}
