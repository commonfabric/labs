import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { comparePeerBuilds } from "../src/peer-build.ts";

describe("peer build diagnostics", () => {
  it("captures the loaded build once instead of following a later global override", async () => {
    const previous = globalThis.$COMMIT_SHA;
    try {
      globalThis.$COMMIT_SHA = "a".repeat(40);
      // deno-lint-ignore cf-imports/no-inline-module-import -- Fresh module captures the build only after the fixture sets it.
      const captured = await import("../src/peer-build.ts?capture-test");
      globalThis.$COMMIT_SHA = "b".repeat(40);
      expect(captured.bundledBuild).toBe("a".repeat(40));
    } finally {
      if (previous === undefined) delete globalThis.$COMMIT_SHA;
      else globalThis.$COMMIT_SHA = previous;
    }
  });

  it("distinguishes equal and different commits without implying compatibility", () => {
    const local = "a".repeat(40);
    expect(comparePeerBuilds(local, local).relation).toBe("same");
    expect(comparePeerBuilds(local, "b".repeat(40)).relation).toBe("different");
  });

  it("keeps missing and malformed provenance unknown", () => {
    for (
      const peer of [undefined, null, "", "production", "malformed\nmarker"]
    ) {
      expect(comparePeerBuilds("a".repeat(40), peer)).toEqual({
        local: "a".repeat(40),
        peer: undefined,
        relation: "unknown",
      });
    }
    expect(comparePeerBuilds(undefined, "a".repeat(40)).relation).toBe(
      "unknown",
    );
  });
});
