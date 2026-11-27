/**
 * Reviewed skills: which acquired skill bundles a trusted party has read and
 * vouched for, and whether a given bundle is one of them.
 *
 * A review is a trust statement (spec §4.8.2): its verifier asserts that one
 * exact bundle implements `prompt-injection-free` (§4.8.1). An operator
 * accepts a verifier's statements with a delegation (§4.8.3), and the answer
 * comes from the same closure that trusts a connector
 * (`createTrustResolver`). A review vouches for the bundle's own bytes and
 * for nothing the skill later reads, and it raises no prompt role: the skill
 * stays `quote`. What it changes is in `prompt-loop.ts`, where a delegated
 * child whose skill a review fully covers keeps the delegating run's binding.
 *
 * `docs/plans/reviewed-skills.md` has the design, and its "CFC debt" section
 * records where this departs from principled CFC.
 */

import {
  buildCfcTrustConfig,
  type CfcTrustStatement,
  type CfcVerifierDelegation,
  createTrustResolver,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type {
  HarnessAcquiredSkill,
  HarnessReviewedSkillEntry,
  HarnessReviewedSkillEvidence,
  HarnessReviewedSkills,
  HarnessSkillAcquisition,
  HarnessSkillBundleFile,
} from "../contracts/skill.ts";
import { skillsShValueDigest } from "../skills-sh/acquisition.ts";

/** The concept a review statement implements (spec §4.8.1). */
export const PROMPT_INJECTION_FREE_CONCEPT =
  "https://commonfabric.org/cfc/concepts/prompt-injection-free";

/**
 * The type of the atom a review statement's `concrete` names: one skill
 * bundle, by discovery id and bundle digest.
 *
 * CFC debt: no registered atom type names "the digest of a text" (`CodeHash`
 * is defined for code), so the harness builds this atom for the closure to
 * match and nothing carries it on a label. The principled form is an atom
 * that source entry mints on the fetched bytes, of a type the specification
 * names.
 */
export const SKILL_BUNDLE_ATOM_TYPE =
  "https://commonfabric.org/cf-harness/atom/SkillBundle";

const FILE_KEYS = new Set(["entries", "acceptedVerifiers", "revoked"]);
const ENTRY_KEYS = new Set([
  "verifier",
  "registryId",
  "reviewedCommit",
  "bundleDigest",
  "checklist",
  "validUntil",
]);

// A date alone, or a time with no offset, would be read in whatever zone the
// host runs in, so a review's expiry names its zone.
const ISO_TIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/**
 * Whether `text` is an ISO 8601 time with an offset whose every field is in
 * range. `Date.parse` alone rolls an out-of-range day over into the next
 * month, which would keep a mistyped review live past the date its author
 * wrote.
 */
const isIsoTimeWithOffset = (text: string): boolean => {
  const match = ISO_TIME_WITH_OFFSET.exec(text);
  if (match === null) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] =
    match.slice(1).map((field) => field === undefined ? 0 : Number(field));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth &&
    hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 &&
    offsetMinute <= 59;
};

const fail = (message: string): never => {
  throw new Error(`reviewed skills: ${message}`);
};

const requireString = (value: unknown, where: string): string =>
  typeof value === "string" && value.length > 0
    ? value
    : fail(`${where} must be a non-empty string`);

const requireStrings = (value: unknown, where: string): string[] =>
  Array.isArray(value)
    ? value.map((item, index) => requireString(item, `${where}[${index}]`))
    : fail(`${where} must be an array`);

const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  where: string,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`unknown key "${key}" in ${where}`);
  }
};

/**
 * Validates a reviewed-skills file that `JSON.parse()` produced.
 *
 * Throws on any malformation, naming the entry: a mistyped key or an
 * unreadable expiry would otherwise widen or narrow trust without a word.
 */
export const parseHarnessReviewedSkills = (
  value: unknown,
): HarnessReviewedSkills => {
  if (!isObjectNotArray(value)) return fail("the file must hold an object");
  rejectUnknownKeys(value, FILE_KEYS, "the file");
  const entries = Array.isArray(value.entries)
    ? value.entries.map((raw, index): HarnessReviewedSkillEntry => {
      const where = `entries[${index}]`;
      if (!isObjectNotArray(raw)) return fail(`${where} must be an object`);
      rejectUnknownKeys(raw, ENTRY_KEYS, where);
      const validUntil = raw.validUntil === undefined
        ? undefined
        : requireString(raw.validUntil, `${where}.validUntil`);
      if (
        validUntil !== undefined &&
        (!isIsoTimeWithOffset(validUntil) ||
          Number.isNaN(Date.parse(validUntil)))
      ) {
        fail(`${where}.validUntil is not an ISO 8601 time with an offset`);
      }
      return {
        verifier: requireString(raw.verifier, `${where}.verifier`),
        registryId: requireString(raw.registryId, `${where}.registryId`),
        ...(raw.reviewedCommit !== undefined
          ? {
            reviewedCommit: requireString(
              raw.reviewedCommit,
              `${where}.reviewedCommit`,
            ),
          }
          : {}),
        bundleDigest: requireString(raw.bundleDigest, `${where}.bundleDigest`),
        ...(raw.checklist !== undefined
          ? { checklist: requireString(raw.checklist, `${where}.checklist`) }
          : {}),
        ...(validUntil !== undefined ? { validUntil } : {}),
      };
    })
    : fail("entries must be an array");
  return {
    entries,
    acceptedVerifiers: requireStrings(
      value.acceptedVerifiers,
      "acceptedVerifiers",
    ),
    revoked: value.revoked === undefined
      ? []
      : requireStrings(value.revoked, "revoked"),
  };
};

/**
 * The digest that names a whole bundle: one line of `<path>\t<digest>\n` per
 * file, sorted by path, digested the way acquisition digests a file.
 *
 * One digest over every file means a review covers the bundle as a whole, so
 * an old `SKILL.md` cannot be paired with a new script. Throws on a path that
 * would make the line encoding ambiguous, or on a path listed twice.
 */
export const skillBundleDigest = (
  files: readonly HarnessSkillBundleFile[],
): string => {
  const sorted = sortedByPath(files);
  for (const [index, file] of sorted.entries()) {
    if (/[\t\n]/.test(file.path)) {
      fail(`bundle path ${JSON.stringify(file.path)} holds a tab or newline`);
    }
    if (index > 0 && sorted[index - 1].path === file.path) {
      fail(`bundle path ${JSON.stringify(file.path)} is listed twice`);
    }
  }
  return skillsShValueDigest(
    new TextEncoder().encode(
      sorted.map((file) => `${file.path}\t${file.valueDigest}\n`).join(""),
    ),
  );
};

const bundleAtom = (registryId: string, bundleDigest: string) => ({
  type: SKILL_BUNDLE_ATOM_TYPE,
  registryId: registryId.toLowerCase(),
  bundleDigest,
});

const isLive = (
  entry: HarnessReviewedSkillEntry,
  revoked: ReadonlySet<string>,
  now: Date,
): boolean =>
  !revoked.has(entry.bundleDigest) &&
  (entry.validUntil === undefined ||
    now.getTime() <= Date.parse(entry.validUntil));

const sortedByPath = (files: readonly HarnessSkillBundleFile[]) =>
  [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The review that covers the bundle of skill `registryId` made of `files`,
 * acquired at `commitSha`, or `undefined` when none does: no entry names that
 * skill and digest, the entry is expired or revoked, or its verifier is not
 * accepted.
 */
export const reviewEvidenceForBundle = (
  reviewed: HarnessReviewedSkills,
  bundle: {
    registryId: string;
    commitSha: string;
    files: readonly HarnessSkillBundleFile[];
  },
  now: Date,
): HarnessReviewedSkillEvidence | undefined => {
  const bundleDigest = skillBundleDigest(bundle.files);
  const atom = bundleAtom(bundle.registryId, bundleDigest);
  const revoked = new Set(reviewed.revoked);
  // CFC debt: the operator who supplies the file accepts its verifiers for
  // everyone the run acts for, as a deployment-root delegation. The
  // principled form is a delegation each person makes in their profile.
  const delegations: CfcVerifierDelegation[] = reviewed.acceptedVerifiers.map(
    (verifier) => ({
      delegator: "*",
      verifier,
      concepts: [PROMPT_INJECTION_FREE_CONCEPT],
    }),
  );
  // One statement at a time, so the entry recorded is the one the closure
  // accepted.
  const entry = reviewed.entries.find((candidate) => {
    if (!isLive(candidate, revoked, now)) return false;
    const statement: CfcTrustStatement = {
      concrete: bundleAtom(candidate.registryId, candidate.bundleDigest),
      implements: PROMPT_INJECTION_FREE_CONCEPT,
      verifier: candidate.verifier,
    };
    return createTrustResolver(
      buildCfcTrustConfig({ statements: [statement], delegations }),
    ).conceptSatisfied(PROMPT_INJECTION_FREE_CONCEPT, [atom], undefined);
  });
  if (entry === undefined) return undefined;
  return {
    concept: PROMPT_INJECTION_FREE_CONCEPT,
    verifier: entry.verifier,
    registryId: entry.registryId,
    commitSha: bundle.commitSha,
    ...(entry.reviewedCommit !== undefined
      ? { reviewedCommit: entry.reviewedCommit }
      : {}),
    bundleDigest,
    files: sortedByPath(bundle.files),
    ...(entry.checklist !== undefined ? { checklist: entry.checklist } : {}),
    ...(entry.validUntil !== undefined ? { validUntil: entry.validUntil } : {}),
  };
};

/**
 * The review that covers the skill a delegation hands its child, or
 * `undefined` when none does.
 *
 * The bundle is every file the child can load: `SKILL.md` and the scripts
 * acquired beside it. `servedDigest` is the digest of the text the handle
 * resolved to, and it must equal the digest acquisition recorded, so what the
 * child reads is the text that was reviewed. Text that reached the child some
 * other way than an acquisition names no skill, and no review covers it.
 */
export const reviewEvidenceForDelegatedSkill = (
  reviewed: HarnessReviewedSkills | undefined,
  skill: {
    servedDigest: string;
    acquisition?: HarnessSkillAcquisition;
  },
  acquiredSkill: HarnessAcquiredSkill | undefined,
  now: Date,
): HarnessReviewedSkillEvidence | undefined => {
  const acquisition = skill.acquisition;
  if (reviewed === undefined || acquisition === undefined) return undefined;
  if (skill.servedDigest !== acquisition.valueDigest) return undefined;
  return reviewEvidenceForBundle(reviewed, {
    registryId: acquisition.registryId,
    commitSha: acquisition.commitSha,
    files: [
      { path: "SKILL.md", valueDigest: acquisition.valueDigest },
      ...(acquiredSkill?.scripts ?? []).map((script) => ({
        path: script.path,
        valueDigest: script.valueDigest,
      })),
    ],
  }, now);
};
