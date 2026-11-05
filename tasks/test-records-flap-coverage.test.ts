import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { composeLocalContext } from "./test-records.ts";

describe("composeLocalContext() flap coverage", () => {
  // The arm of composeLocalContext() that records a branch runs when git named
  // one. Nothing but the ambient checkout drove it before: a working checkout
  // sits on a branch, while the detached merge commit continuous integration
  // builds a pull request from reports an empty branch, so the line ran on some
  // runs and not on others. These cases state the facts the composition is
  // given and assert what it makes of them, so each arm runs on every run and
  // under every configuration.

  it("carries the branch when git named one", () => {
    const context = composeLocalContext({
      commit: "a".repeat(40),
      branch: "probe-branch",
      status: "",
    }, () => undefined);
    expect(context.branch).toBe("probe-branch");
    expect(context.commit).toBe("a".repeat(40));
    expect(context.dirty).toBe(false);
    expect(context.env).toBe("local");
  });

  it("leaves the branch off a detached checkout", () => {
    // `git branch --show-current` prints nothing when HEAD is detached, which
    // reaches the composition as an empty string.
    const context = composeLocalContext({
      commit: "b".repeat(40),
      branch: "",
      status: "",
    }, () => undefined);
    expect(Object.hasOwn(context, "branch")).toBe(false);
    expect(context.commit).toBe("b".repeat(40));
  });

  it("records an unknown commit and a dirty tree outside git's reach", () => {
    // Every fact is absent when git could not answer, and a tree git reported
    // changes in is dirty.
    const unnamed = composeLocalContext({}, () => undefined);
    expect(unnamed.commit).toBe("unknown");
    expect(Object.hasOwn(unnamed, "branch")).toBe(false);
    expect(unnamed.dirty).toBe(false);

    const dirty = composeLocalContext({
      commit: "c".repeat(40),
      branch: "probe-branch",
      status: " M tasks/test-records.ts\n",
    }, () => undefined);
    expect(dirty.dirty).toBe(true);
    expect(dirty.branch).toBe("probe-branch");
  });

  it("carries the seed the run shuffles by, and none where it has none", () => {
    const seeded = composeLocalContext({
      commit: "e".repeat(40),
      status: "",
      shuffleSeed: 20260922,
    }, () => undefined);
    expect(seeded.shuffleSeed).toBe(20260922);

    const unseeded = composeLocalContext(
      { commit: "e".repeat(40) },
      () => undefined,
    );
    expect(Object.hasOwn(unseeded, "shuffleSeed")).toBe(false);
  });

  it("carries the agent label the environment names", () => {
    const context = composeLocalContext(
      { commit: "d".repeat(40), branch: "probe-branch", status: "" },
      (name) => name === "CF_TEST_AGENT" ? "probe-agent" : undefined,
    );
    expect(context.agent).toBe("probe-agent");
  });
});
