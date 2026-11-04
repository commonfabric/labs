import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { classifyPullRequestStatus } from "../src/status.ts";

const ready = {
  isDraft: false,
  mergeable: "MERGEABLE" as const,
  mergeState: "CLEAN" as const,
  reviewDecision: "APPROVED" as const,
  checkState: "SUCCESS" as const,
};

describe("status", () => {
  describe("classifyPullRequestStatus()", () => {
    it("returns `draft` for a draft", () => {
      expect(classifyPullRequestStatus({ ...ready, isDraft: true })).toBe(
        "draft",
      );
    });

    it("returns `merge-conflicts` before reporting failed checks", () => {
      expect(classifyPullRequestStatus({
        ...ready,
        mergeable: "CONFLICTING",
        checkState: "FAILURE",
      })).toBe("merge-conflicts");
    });

    it("returns `tests-failed` for a failed check rollup", () => {
      expect(classifyPullRequestStatus({
        ...ready,
        checkState: "FAILURE",
      })).toBe("tests-failed");
    });

    it("returns `tests-running` for a pending check rollup", () => {
      expect(classifyPullRequestStatus({
        ...ready,
        checkState: "PENDING",
      })).toBe("tests-running");
    });

    it("returns `green-and-can-land` for a clean successful pull request", () => {
      expect(classifyPullRequestStatus(ready)).toBe("green-and-can-land");
    });

    it("does not call an unresolved mergeability state green", () => {
      expect(classifyPullRequestStatus({
        ...ready,
        mergeable: "UNKNOWN",
      })).toBe("merge-blocked");
    });

    it("returns `merge-blocked` for requested review changes", () => {
      expect(classifyPullRequestStatus({
        ...ready,
        reviewDecision: "CHANGES_REQUESTED",
      })).toBe("merge-blocked");
    });

    it("returns `merge-blocked` when a review is required", () => {
      expect(classifyPullRequestStatus({
        ...ready,
        reviewDecision: "REVIEW_REQUIRED",
      })).toBe("merge-blocked");
    });
  });
});
