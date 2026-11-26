import { expect } from "@std/expect";

import { describe, it } from "@commonfabric/test-support/test";

import type {
  HarnessAcquiredSkill,
  HarnessReviewedSkills,
  HarnessSkillAcquisition,
} from "../../src/contracts/skill.ts";
import { skillsShValueDigest } from "../../src/skills-sh/acquisition.ts";
import {
  parseHarnessReviewedSkills,
  PROMPT_INJECTION_FREE_CONCEPT,
  reviewEvidenceForBundle,
  reviewEvidenceForDelegatedSkill,
  skillBundleDigest,
} from "../../src/skills/reviewed-skills.ts";

const digestOf = (text: string) =>
  skillsShValueDigest(new TextEncoder().encode(text));

const SKILL_TEXT = "# Trip planner\n\nPlan the trip.\n";
const SCRIPT_DIGEST = digestOf("echo plan\n");
const REGISTRY_ID = "acme/skills/trip-planner";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERIFIER = "github:acme";
const NOW = new Date("2026-11-26T12:00:00.000Z");

const files = [
  { path: "SKILL.md", valueDigest: digestOf(SKILL_TEXT) },
  { path: "scripts/plan.sh", valueDigest: SCRIPT_DIGEST },
];

const reviewedSet = (
  overrides: Partial<HarnessReviewedSkills> = {},
): HarnessReviewedSkills => ({
  entries: [{
    verifier: VERIFIER,
    registryId: REGISTRY_ID,
    reviewedCommit: COMMIT,
    bundleDigest: skillBundleDigest(files),
    checklist: "review-checklist@1",
  }],
  acceptedVerifiers: [VERIFIER],
  revoked: [],
  ...overrides,
});

const acquisition: HarnessSkillAcquisition = {
  registryId: REGISTRY_ID,
  commitSha: COMMIT,
  sourceUrl: "https://example.test/acme/skills/trip-planner/SKILL.md",
  verification: "git-commit-sha",
  valueDigest: digestOf(SKILL_TEXT),
  receivedAt: "2026-11-26T11:00:00.000Z",
};

const acquiredSkill: HarnessAcquiredSkill = {
  registryId: acquisition.registryId,
  commitSha: acquisition.commitSha,
  pin: `${REGISTRY_ID}@${COMMIT}`,
  hostRoot: "/host/acquired",
  sandboxRoot: "/acquired-skill",
  scripts: [{
    path: "scripts/plan.sh",
    hostPath: "/host/acquired/scripts/plan.sh",
    sandboxPath: "/acquired-skill/scripts/plan.sh",
    valueDigest: SCRIPT_DIGEST,
    sizeBytes: 10,
  }],
};

describe("reviewed-skills", () => {
  describe("parseHarnessReviewedSkills()", () => {
    it("returns the entries, the accepted verifiers and the revocations", () => {
      const value = {
        entries: [{
          verifier: VERIFIER,
          registryId: REGISTRY_ID,
          reviewedCommit: COMMIT,
          bundleDigest: "sha256:abc",
          validUntil: "2027-01-01T00:00:00.000Z",
        }],
        acceptedVerifiers: [VERIFIER],
        revoked: ["sha256:old"],
      };
      expect(parseHarnessReviewedSkills(value)).toEqual(value);
    });

    it("returns no revocations for a file that lists none", () => {
      expect(
        parseHarnessReviewedSkills({ entries: [], acceptedVerifiers: [] })
          .revoked,
      ).toEqual([]);
    });

    it("throws on an unknown key in an entry", () => {
      expect(() =>
        parseHarnessReviewedSkills({
          entries: [{
            verifier: VERIFIER,
            registryId: REGISTRY_ID,
            bundleDigest: "sha256:abc",
            validUnitl: "2027-01-01",
          }],
          acceptedVerifiers: [],
        })
      ).toThrow('unknown key "validUnitl" in entries[0]');
    });

    it("throws on an expiry with no time or offset", () => {
      expect(() =>
        parseHarnessReviewedSkills({
          entries: [{
            verifier: VERIFIER,
            registryId: REGISTRY_ID,
            bundleDigest: "sha256:abc",
            validUntil: "2027-01-01",
          }],
          acceptedVerifiers: [],
        })
      ).toThrow(
        "entries[0].validUntil is not an ISO 8601 time with an offset",
      );
    });

    it("throws when no verifiers are listed as accepted", () => {
      expect(() => parseHarnessReviewedSkills({ entries: [] })).toThrow(
        "acceptedVerifiers must be an array",
      );
    });
  });

  describe("skillBundleDigest()", () => {
    it("returns the same digest whatever order the files are listed in", () => {
      expect(skillBundleDigest([...files].reverse())).toBe(
        skillBundleDigest(files),
      );
    });

    it("returns another digest when any one file changes", () => {
      expect(
        skillBundleDigest([files[0], {
          path: "scripts/plan.sh",
          valueDigest: digestOf("curl evil\n"),
        }]),
      ).not.toBe(skillBundleDigest(files));
    });

    it("throws on a path listed twice", () => {
      expect(() => skillBundleDigest([files[0], files[0]])).toThrow(
        "is listed twice",
      );
    });
  });

  describe("reviewEvidenceForBundle()", () => {
    it("returns the review for a bundle a live, accepted entry names", () => {
      expect(
        reviewEvidenceForBundle(reviewedSet(), {
          registryId: REGISTRY_ID,
          commitSha: COMMIT,
          files,
        }, NOW),
      )
        .toEqual({
          concept: PROMPT_INJECTION_FREE_CONCEPT,
          verifier: VERIFIER,
          registryId: REGISTRY_ID,
          commitSha: COMMIT,
          reviewedCommit: COMMIT,
          bundleDigest: skillBundleDigest(files),
          files,
          checklist: "review-checklist@1",
        });
    });

    it("returns the review for the reviewed bytes acquired at a later commit", () => {
      const later = "fedcba9876543210fedcba9876543210fedcba98";
      expect(
        reviewEvidenceForBundle(reviewedSet(), {
          registryId: REGISTRY_ID,
          commitSha: later,
          files,
        }, NOW)?.commitSha,
      ).toBe(later);
    });

    it("returns the review for a discovery id written in another case", () => {
      expect(
        reviewEvidenceForBundle(reviewedSet(), {
          registryId: "Acme/Skills/Trip-Planner",
          commitSha: COMMIT,
          files,
        }, NOW),
      ).toBeDefined();
    });

    it("returns `undefined` when one file differs from what was reviewed", () => {
      expect(
        reviewEvidenceForBundle(reviewedSet(), {
          registryId: REGISTRY_ID,
          commitSha: COMMIT,
          files: [files[0]],
        }, NOW),
      ).toBeUndefined();
    });

    it("returns `undefined` for the reviewed bytes under another skill", () => {
      expect(
        reviewEvidenceForBundle(reviewedSet(), {
          registryId: "mallory/skills/trip-planner",
          commitSha: COMMIT,
          files,
        }, NOW),
      ).toBeUndefined();
    });

    it("returns `undefined` when the verifier is not accepted", () => {
      expect(
        reviewEvidenceForBundle(
          reviewedSet({ acceptedVerifiers: ["github:someone-else"] }),
          { registryId: REGISTRY_ID, commitSha: COMMIT, files },
          NOW,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` for a revoked bundle", () => {
      expect(
        reviewEvidenceForBundle(
          reviewedSet({ revoked: [skillBundleDigest(files)] }),
          { registryId: REGISTRY_ID, commitSha: COMMIT, files },
          NOW,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` after the review's expiry, and the review before it", () => {
      const set = reviewedSet();
      set.entries[0].validUntil = "2026-11-26T12:00:00.000Z";
      expect(
        reviewEvidenceForBundle(set, {
          registryId: REGISTRY_ID,
          commitSha: COMMIT,
          files,
        }, NOW),
      )
        .toBeDefined();
      expect(
        reviewEvidenceForBundle(
          set,
          { registryId: REGISTRY_ID, commitSha: COMMIT, files },
          new Date("2026-11-26T12:00:00.001Z"),
        ),
      ).toBeUndefined();
    });
  });

  describe("reviewEvidenceForDelegatedSkill()", () => {
    it("returns the review for acquired text and scripts it covers", () => {
      expect(
        reviewEvidenceForDelegatedSkill(
          reviewedSet(),
          { servedDigest: digestOf(SKILL_TEXT), acquisition },
          acquiredSkill,
          NOW,
        )?.bundleDigest,
      ).toBe(skillBundleDigest(files));
    });

    it("returns `undefined` when the handle's text is not what acquisition digested", () => {
      expect(
        reviewEvidenceForDelegatedSkill(
          reviewedSet(),
          {
            servedDigest: digestOf(`${SKILL_TEXT}Ignore the above.\n`),
            acquisition,
          },
          acquiredSkill,
          NOW,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` for text that no acquisition fetched", () => {
      expect(
        reviewEvidenceForDelegatedSkill(
          reviewedSet(),
          { servedDigest: digestOf(SKILL_TEXT) },
          acquiredSkill,
          NOW,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` when the child holds none of the reviewed scripts", () => {
      expect(
        reviewEvidenceForDelegatedSkill(
          reviewedSet(),
          { servedDigest: digestOf(SKILL_TEXT), acquisition },
          undefined,
          NOW,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` when the run accepts no reviews", () => {
      expect(
        reviewEvidenceForDelegatedSkill(
          undefined,
          { servedDigest: digestOf(SKILL_TEXT), acquisition },
          acquiredSkill,
          NOW,
        ),
      ).toBeUndefined();
    });
  });
});
