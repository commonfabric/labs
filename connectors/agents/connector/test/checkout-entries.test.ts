import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { checkoutEntries } from "../src/fabric.ts";
import type { GitContext } from "../src/git-context.ts";

function observation(overrides: Partial<GitContext> = {}): GitContext {
  return {
    gitRepo: "git@example.test:acme/project.git",
    gitBranch: "feature",
    gitWorktreeRoot: "/workspace/project-copy",
    gitHeadSha: "old-head",
    gitRemotes: [{
      name: "upstream",
      urls: ["git@example.test:acme/project.git"],
    }],
    gitObservedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("checkoutEntries", () => {
  it("keeps the newest Git observation for each checkout", () => {
    const entries = checkoutEntries([
      observation(),
      observation({
        gitHeadSha: "new-head",
        gitObservedAt: "2026-08-21T00:00:00.000Z",
      }),
    ]);

    expect(entries).toEqual([{
      root: "/workspace/project-copy",
      gitRepo: "git@example.test:acme/project.git",
      gitBranch: "feature",
      gitHeadSha: "new-head",
      gitRemotes: [{
        name: "upstream",
        urls: ["git@example.test:acme/project.git"],
      }],
      observedAt: "2026-08-21T00:00:00.000Z",
    }]);
  });

  it("lets a fresh checkout scan replace stale session metadata", () => {
    const entries = checkoutEntries(
      [observation()],
      [observation({
        gitHeadSha: "scanned-head",
        gitObservedAt: "2026-08-22T00:00:00.000Z",
      })],
    );

    expect(entries[0].gitHeadSha).toBe("scanned-head");
    expect(entries[0].observedAt).toBe("2026-08-22T00:00:00.000Z");
  });
});
