import { expect } from "@std/expect";

import { repositoryCommittedAt } from "./testing.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

describe("testing", () => {
  describe("repositoryCommittedAt()", () => {
    let parent: string;

    beforeEach(async () => {
      parent = await Deno.makeTempDir({ prefix: "committed-at-parent-" });
    });

    afterEach(async () => {
      await Deno.remove(parent, { recursive: true });
    });

    it("makes the repository under the directory it is given", async () => {
      const root = await repositoryCommittedAt(
        "2026-09-01T10:41:59-07:00",
        parent,
      );
      expect([...Deno.readDirSync(parent)].map(({ name }) => name)).toEqual([
        root.slice(parent.length + 1),
      ]);
    });

    it("throws where git refuses the commit, having removed the directory", async () => {
      // Git's own words depend on its version and locale, so only the step
      // it refused is pinned.
      await expect(repositoryCommittedAt("not a date", parent)).rejects
        .toThrow("git -c commit.gpgsign=false commit -q -m one failed: ");
      expect([...Deno.readDirSync(parent)]).toEqual([]);
    });
  });
});
