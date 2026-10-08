/**
 * An expected-posture spec: the posture a deployment is supposed to be at,
 * written down so a check can compare rather than describe.
 *
 * A spec asserts only the fields it carries, and a spec that asserts nothing
 * is refused — passing `--expected-posture` and having it check nothing is
 * indistinguishable, in every line the audit prints, from a deployment whose
 * every field held. That is the same discipline `scripts/cell-spec.ts` holds
 * its pre-flight to, and for the same reason: the failure a pre-flight exists
 * to remove must not be reachable by writing an emptier file.
 */

import {
  CFC_DIAL_LADDERS,
  type CfcPostureReport,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** What a spec may assert about a posture record. */
export interface ExpectedPosture {
  /** A name for the profile, which asserts nothing. */
  label?: string;

  /**
   * The rung fields, each a floor: a record satisfies one by being at the
   * rung named or at a stricter one. A deployment stricter than its spec is
   * conformant, and a spec naming the rung its deployment sits at today goes
   * on holding when that rung is raised under it.
   */
  enforcementMode?: string;
  flowLabels?: string;
  writeFloor?: string;
  policyEvaluation?: string;
  labelMetadataProtection?: string;
  declaredMonotonicity?: string;
  triggerReadGating?: boolean;
  decomposedEnvelopes?: boolean;
  contentAddressedLabels?: boolean;

  /** The policy-snapshot digest, or `null` asserting that none is configured. */
  policyDigest?: string | null;

  /** Sinks that must carry a confidentiality ceiling. */
  ceilingedSinks?: readonly string[];

  /**
   * The WHOLE set of sinks permitted to release with no ceiling. Empty is the
   * strongest claim this field can make — no sink releases ungated — so an
   * empty list is admitted here where a part-list's would be refused.
   */
  ungatedSinks?: readonly string[];

  /**
   * Whether every ungated sink the record names must appear in the record's
   * published deviations. Only `true` asserts anything; `false` is the
   * absence of the claim, and is refused as a field that looks like one.
   */
  requireDeviationsPublished?: boolean;
}

const RUNG_FIELDS = [
  "enforcementMode",
  "flowLabels",
  "writeFloor",
  "policyEvaluation",
  "labelMetadataProtection",
  "declaredMonotonicity",
] as const;

/** The runtime dial each of those fields reports. */
const RUNG_FIELD_DIALS = {
  enforcementMode: "cfcEnforcementMode",
  flowLabels: "cfcFlowLabels",
  writeFloor: "cfcWriteFloor",
  policyEvaluation: "cfcPolicyEvaluation",
  labelMetadataProtection: "cfcLabelMetadataProtection",
  declaredMonotonicity: "cfcDeclaredMonotonicity",
} as const satisfies Record<
  typeof RUNG_FIELDS[number],
  keyof typeof CFC_DIAL_LADDERS
>;

/** The rungs a field's dial admits, weakest first. */
const rungLadder = (field: typeof RUNG_FIELDS[number]): readonly string[] =>
  Object.keys(CFC_DIAL_LADDERS[RUNG_FIELD_DIALS[field]]);

const BOOLEAN_FIELDS = [
  "triggerReadGating",
  "decomposedEnvelopes",
  "contentAddressedLabels",
] as const;

/** Every field that asserts something, so a spec asserting nothing is caught. */
const ASSERTING_FIELDS: readonly string[] = [
  ...RUNG_FIELDS,
  ...BOOLEAN_FIELDS,
  "policyDigest",
  "ceilingedSinks",
  "ungatedSinks",
  "requireDeviationsPublished",
];

const stringList = (
  value: unknown,
  field: string,
  allowEmpty: boolean,
): readonly string[] => {
  if (
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `an expected-posture spec's ${field} must be a list of strings`,
    );
  }
  if (value.length === 0 && !allowEmpty) {
    throw new Error(
      `an expected-posture spec's ${field} is empty, which every deployment satisfies; name at least one sink or leave the field out`,
    );
  }
  return value as readonly string[];
};

/**
 * Reads a spec's contents, or says what is wrong with it.
 *
 * @throws Error naming the problem, for a caller to print.
 */
export const parseExpectedPosture = (input: unknown): ExpectedPosture => {
  if (!isObjectNotArray(input)) {
    throw new Error("an expected-posture spec must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const known = new Set<string>([...ASSERTING_FIELDS, "label"]);
  const unknownFields = Object.keys(raw).filter((key) => !known.has(key));
  if (unknownFields.length > 0) {
    // A misspelled field asserts nothing while looking as though it does,
    // which is the same silent pass as an empty spec.
    throw new Error(
      `an expected-posture spec names fields nothing asserts: ${
        unknownFields.join(", ")
      }`,
    );
  }
  const spec: Record<string, unknown> = {};
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || raw.label.trim() === "") {
      throw new Error(
        "an expected-posture spec's label must be a non-empty string",
      );
    }
    spec.label = raw.label;
  }
  for (const field of RUNG_FIELDS) {
    const stated = raw[field];
    if (stated === undefined) continue;
    if (typeof stated !== "string" || stated.trim() === "") {
      throw new Error(
        `an expected-posture spec's ${field} must be a non-empty string`,
      );
    }
    const rungs = rungLadder(field);
    if (!rungs.includes(stated)) {
      // A rung off the ladder satisfies no record and is satisfied by none,
      // so it would read as a deployment permanently at fault or permanently
      // conformant depending on which way the comparison fell.
      throw new Error(
        `an expected-posture spec's ${field} is ${
          JSON.stringify(stated)
        }, not one of ${rungs.join(", ")}`,
      );
    }
    spec[field] = stated;
  }
  for (const field of BOOLEAN_FIELDS) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "boolean") {
      throw new Error(
        `an expected-posture spec's ${field} must be true or false`,
      );
    }
    spec[field] = raw[field];
  }
  if (raw.policyDigest !== undefined) {
    if (raw.policyDigest !== null && typeof raw.policyDigest !== "string") {
      throw new Error(
        "an expected-posture spec's policyDigest must be a string or null",
      );
    }
    spec.policyDigest = raw.policyDigest;
  }
  if (raw.ceilingedSinks !== undefined) {
    spec.ceilingedSinks = stringList(
      raw.ceilingedSinks,
      "ceilingedSinks",
      false,
    );
  }
  if (raw.ungatedSinks !== undefined) {
    spec.ungatedSinks = stringList(raw.ungatedSinks, "ungatedSinks", true);
  }
  if (raw.requireDeviationsPublished !== undefined) {
    if (raw.requireDeviationsPublished !== true) {
      throw new Error(
        "an expected-posture spec's requireDeviationsPublished asserts something only as true; leave it out to assert nothing",
      );
    }
    spec.requireDeviationsPublished = true;
  }
  if (!ASSERTING_FIELDS.some((field) => spec[field] !== undefined)) {
    throw new Error(
      "an expected-posture spec asserts nothing; name at least one of " +
        ASSERTING_FIELDS.join(", "),
    );
  }
  return spec as ExpectedPosture;
};

/** Reads a spec file. */
export const loadExpectedPosture = async (
  path: string,
): Promise<ExpectedPosture> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(
      `expected-posture spec \`${path}\` could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `expected-posture spec \`${path}\` is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseExpectedPosture(parsed);
};

/** One field of a spec the record did not satisfy. */
export interface PostureMismatch {
  field: string;
  expected: string;
  found: string;
}

/** Every field of `spec` that `record` does not satisfy. */
export const postureMismatches = (
  spec: ExpectedPosture,
  record: CfcPostureReport,
): readonly PostureMismatch[] => {
  const mismatches: PostureMismatch[] = [];
  for (const field of RUNG_FIELDS) {
    const expected = spec[field];
    if (expected === undefined) continue;
    const rungs = rungLadder(field);
    const found = record[field].rung;
    if (rungs.indexOf(found) < rungs.indexOf(expected)) {
      mismatches.push({ field, expected: `${expected} or stricter`, found });
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    const expected = spec[field];
    if (expected === undefined) continue;
    if (record[field] !== expected) {
      mismatches.push({
        field,
        expected: String(expected),
        found: String(record[field]),
      });
    }
  }
  if (spec.policyDigest !== undefined) {
    const expected = spec.policyDigest;
    if (record.policyDigest !== expected) {
      mismatches.push({
        field: "policyDigest",
        expected: expected === null ? "null" : expected,
        found: record.policyDigest ?? "null",
      });
    }
  }
  const ungated = record.sinks.flatMap((sink) =>
    "ungated" in sink ? [sink.sink] : []
  );
  const ceilinged = record.sinks.flatMap((sink) =>
    "ceiling" in sink ? [sink.sink] : []
  );
  for (const sink of spec.ceilingedSinks ?? []) {
    if (!ceilinged.includes(sink)) {
      mismatches.push({
        field: `ceilingedSinks[${sink}]`,
        expected: "a confidentiality ceiling",
        found: ungated.includes(sink) ? "ungated" : "not a known sink",
      });
    }
  }
  if (spec.ungatedSinks !== undefined) {
    const permitted = new Set(spec.ungatedSinks);
    for (const sink of ungated) {
      if (!permitted.has(sink)) {
        mismatches.push({
          field: `ungatedSinks[${sink}]`,
          expected: "a confidentiality ceiling",
          found: "ungated, and not among the sinks the spec permits ungated",
        });
      }
    }
  }
  if (spec.requireDeviationsPublished === true) {
    const published = record.deviations.map((deviation) => deviation.what);
    for (const sink of ungated) {
      if (!published.some((what) => what.includes(`\`${sink}\``))) {
        mismatches.push({
          field: `deviations[${sink}]`,
          expected: "a published deviation naming this ungated sink",
          found: "no deviation names it",
        });
      }
    }
  }
  return mismatches;
};
