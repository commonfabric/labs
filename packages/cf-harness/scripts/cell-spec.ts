/**
 * What a measurement batch requires of the console it is about to spend money
 * on, and whether the console it found satisfies it.
 *
 * Every field an experiment depends on and cannot see from a transcript is
 * checkable before the first task: which tools the policy offers, which
 * subagent profiles it authorizes, which system prompt is seeded, which space
 * the runs write into, and which stores this console holds. A batch that
 * verifies those afterwards, by reading the artifacts it paid for, has already
 * spent the run that would have told it.
 *
 * A spec asserts only the fields it carries. What it leaves out is not
 * asserted and is not reported as satisfied.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import type { ConsolePolicyReport } from "../console/policy.ts";

/**
 * One cell's expected configuration, as a `--cell-spec` file holds it.
 *
 * `allowedToolIds` states the whole set; `requiredToolIds` and
 * `forbiddenToolIds` state parts of it. A file carrying both has not decided
 * which claim it is making, and {@link parseCellSpec} refuses it rather than
 * letting one silently win. The subagent profile fields work the same way.
 *
 * `systemPromptSha256` admits `null`, which asserts that this console seeds no
 * system prompt at all — a condition an experiment can depend on as readily as
 * on a particular prompt.
 */
export interface CellSpec {
  label?: string;
  systemPromptSha256?: string | null;
  allowedToolIds?: readonly string[];
  requiredToolIds?: readonly string[];
  forbiddenToolIds?: readonly string[];
  allowedSubagentProfiles?: readonly string[];
  requiredSubagentProfiles?: readonly string[];
  forbiddenSubagentProfiles?: readonly string[];
  fabricSpace?: string;
  artifactRoot?: string;
  sessionDbPath?: string | null;
}

/** One field the console disagreed with the spec on. */
export interface CellSpecMismatch {
  field: string;
  expected: string;
  actual: string;
}

/**
 * Whether the console is the cell the batch was told to measure.
 *
 * `unasked` is a batch that named no spec, and it is a distinct reading from
 * one whose every field held: the first asserted nothing, and a report that
 * called it a match would claim a check nobody ran.
 */
export type CellSpecPreflight =
  | { kind: "unasked" }
  | { kind: "matched"; spec: CellSpec; policy: ConsolePolicyReport }
  | {
    kind: "refused";
    reason: string;
    spec?: CellSpec;
    mismatches?: readonly CellSpecMismatch[];
  };

const SET_FIELDS = [
  ["allowedToolIds", "requiredToolIds", "forbiddenToolIds"],
  [
    "allowedSubagentProfiles",
    "requiredSubagentProfiles",
    "forbiddenSubagentProfiles",
  ],
] as const;

const STRING_FIELDS = ["label", "fabricSpace", "artifactRoot"] as const;

const NULLABLE_STRING_FIELDS = ["systemPromptSha256", "sessionDbPath"] as const;

/** Every field that asserts something, so a spec asserting nothing is caught. */
const ASSERTING_FIELDS: readonly string[] = [
  ...SET_FIELDS.flat(),
  ...STRING_FIELDS.filter((field) => field !== "label"),
  ...NULLABLE_STRING_FIELDS,
];

/**
 * One list field's entries, or `undefined` when the file leaves it out.
 *
 * A part-list is empty only by mistake: `requiredToolIds: []` asserts that the
 * policy offers at least nothing, which every console satisfies, and a file of
 * such lists would pass the whole-spec guard below while checking as little as
 * a file with no fields at all. `allowEmpty` is for the whole-set fields,
 * where an empty list is the strongest claim the spec can make rather than the
 * weakest — that the policy offers nothing.
 */
const stringList = (
  value: unknown,
  field: string,
  allowEmpty: boolean,
): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) || value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(`a cell spec's ${field} must be a list of strings`);
  }
  if (value.length === 0 && !allowEmpty) {
    throw new Error(
      `a cell spec's ${field} is empty, which every console satisfies; name at least one entry or leave the field out`,
    );
  }
  return value as readonly string[];
};

/**
 * Reads a cell spec's contents, or says what is wrong with it.
 *
 * A spec that asserts nothing is refused. Passing `--cell-spec` and having it
 * check nothing is the failure this pre-flight exists to remove, and it is
 * indistinguishable from a passing check in every artifact the batch writes.
 */
export const parseCellSpec = (input: unknown): CellSpec => {
  if (!isObjectNotArray(input)) {
    throw new Error("a cell spec must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const known = new Set<string>([...ASSERTING_FIELDS, "label"]);
  const unknownFields = Object.keys(raw).filter((key) => !known.has(key));
  if (unknownFields.length > 0) {
    // A misspelled field asserts nothing while looking as though it does,
    // which is the same silent pass as an empty spec.
    throw new Error(
      `a cell spec names fields nothing asserts: ${unknownFields.join(", ")}`,
    );
  }
  const spec: Record<string, unknown> = {};
  for (const field of STRING_FIELDS) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== "string" || raw[field].trim() === "") {
      throw new Error(`a cell spec's ${field} must be a non-empty string`);
    }
    spec[field] = raw[field];
  }
  for (const field of NULLABLE_STRING_FIELDS) {
    if (raw[field] === undefined) continue;
    if (raw[field] !== null && typeof raw[field] !== "string") {
      throw new Error(`a cell spec's ${field} must be a string or null`);
    }
    spec[field] = raw[field];
  }
  for (const [exact, required, forbidden] of SET_FIELDS) {
    const exactSet = stringList(raw[exact], exact, true);
    const requiredSet = stringList(raw[required], required, false);
    const forbiddenSet = stringList(raw[forbidden], forbidden, false);
    if (
      exactSet !== undefined &&
      (requiredSet !== undefined || forbiddenSet !== undefined)
    ) {
      throw new Error(
        `a cell spec states ${exact} as a whole set and also as ${required}/${forbidden}; it is one or the other`,
      );
    }
    const both = (requiredSet ?? []).filter((entry) =>
      (forbiddenSet ?? []).includes(entry)
    );
    if (both.length > 0) {
      throw new Error(
        `a cell spec names ${
          both.join(", ")
        } as both ${required} and ${forbidden}`,
      );
    }
    if (exactSet !== undefined) spec[exact] = exactSet;
    if (requiredSet !== undefined) spec[required] = requiredSet;
    if (forbiddenSet !== undefined) spec[forbidden] = forbiddenSet;
  }
  if (!ASSERTING_FIELDS.some((field) => spec[field] !== undefined)) {
    throw new Error(
      "a cell spec asserts nothing; name at least one of " +
        ASSERTING_FIELDS.join(", "),
    );
  }
  return spec as CellSpec;
};

const named = (values: readonly string[]): string =>
  values.length === 0 ? "(none)" : [...values].sort().join(", ");

/**
 * Where the console disagrees with the spec, field by field.
 *
 * A set is compared as a set: order and repetition in either the spec or the
 * console's answer say nothing about what a session can reach.
 */
export const checkCellSpec = (
  spec: CellSpec,
  policy: ConsolePolicyReport,
): readonly CellSpecMismatch[] => {
  const mismatches: CellSpecMismatch[] = [];
  const scalar = (
    field: string,
    expected: string | null | undefined,
    actual: string | null,
  ): void => {
    if (expected === undefined || expected === actual) return;
    mismatches.push({
      field,
      expected: expected ?? "(none)",
      actual: actual ?? "(none)",
    });
  };
  scalar(
    "systemPromptSha256",
    spec.systemPromptSha256,
    policy.systemPromptSha256,
  );
  scalar("fabricSpace", spec.fabricSpace, policy.fabricSpace);
  scalar("artifactRoot", spec.artifactRoot, policy.artifactRoot);
  scalar("sessionDbPath", spec.sessionDbPath, policy.sessionDbPath);
  const sets = [
    {
      exact: spec.allowedToolIds,
      required: spec.requiredToolIds,
      forbidden: spec.forbiddenToolIds,
      field: "allowedToolIds",
      actual: policy.allowedToolIds,
    },
    {
      exact: spec.allowedSubagentProfiles,
      required: spec.requiredSubagentProfiles,
      forbidden: spec.forbiddenSubagentProfiles,
      field: "allowedSubagentProfiles",
      actual: policy.allowedSubagentProfiles,
    },
  ] as const;
  for (const entry of sets) {
    const held = new Set(entry.actual);
    if (entry.exact !== undefined) {
      const expected = new Set(entry.exact);
      const missing = [...expected].filter((id) => !held.has(id));
      const extra = [...held].filter((id) => !expected.has(id));
      if (missing.length > 0 || extra.length > 0) {
        mismatches.push({
          field: entry.field,
          expected: named([...expected]),
          actual: named([...held]),
        });
      }
    }
    const missing = (entry.required ?? []).filter((id) => !held.has(id));
    if (missing.length > 0) {
      mismatches.push({
        field: `${entry.field} (must include)`,
        expected: `at least ${named(missing)}`,
        actual: named([...held]),
      });
    }
    const present = (entry.forbidden ?? []).filter((id) => held.has(id));
    if (present.length > 0) {
      mismatches.push({
        field: `${entry.field} (must exclude)`,
        expected: `none of ${named(present)}`,
        actual: named([...held]),
      });
    }
  }
  return mismatches;
};

/** What the batch refuses with when the console is not the cell. */
export const describeCellSpecMismatches = (
  mismatches: readonly CellSpecMismatch[],
): string =>
  mismatches
    .map((mismatch) =>
      `${mismatch.field}: expected ${mismatch.expected}; this console reports ${mismatch.actual}`
    )
    .join("; ");
