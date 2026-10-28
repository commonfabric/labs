import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  agentLabel,
  defaultSpoolRoot,
  recordsDir,
  repositoryRelativePath,
  repositoryRoot,
} from "./paths.ts";

describe("paths", () => {
  let outside: string;

  beforeEach(async () => {
    outside = await Deno.makeTempDir({ prefix: "test-records-paths-" });
  });

  afterEach(async () => {
    await Deno.remove(outside, { recursive: true }).catch(() => {});
  });

  describe("repositoryRoot()", () => {
    it("returns the directory holding .git when run inside a repository", () => {
      const root = repositoryRoot();
      expect(root).toBeDefined();
      expect(Deno.cwd().startsWith(root!)).toBe(true);

      // `.git` is a directory in an ordinary clone and a file holding a
      // `gitdir:` pointer in a worktree. The climb keys on the entry
      // existing, which `statSync()` answers for either shape, so asserting
      // which shape it is would fail wherever the checkout is a worktree --
      // and continuous integration, which uses a clone, would never see that.
      const stat = Deno.statSync(join(root!, ".git"));
      expect(stat.isDirectory || stat.isFile).toBe(true);
    });

    it("returns undefined outside any repository", () => {
      expect(repositoryRoot(outside)).toBeUndefined();
    });

    it("climbs from a nested directory to the same root", async () => {
      const nested = join(outside, "a", "b");
      await Deno.mkdir(join(outside, ".git"), { recursive: true });
      await Deno.mkdir(nested, { recursive: true });
      expect(repositoryRoot(nested)).toBe(outside);
    });
  });

  describe("repositoryRelativePath()", () => {
    it("returns the path from the repository root, forward-slashed", () => {
      expect(repositoryRelativePath(import.meta.filename!)).toBe(
        "packages/test-support/src/records/paths.test.ts",
      );
    });

    it("returns the path from the nearest .git above the file", async () => {
      await Deno.mkdir(join(outside, ".git"));
      expect(repositoryRelativePath(join(outside, "x", "file.ts")))
        .toBe("x/file.ts");
    });

    it("returns undefined outside any repository", () => {
      // The temporary tree has no .git above it on the runners this suite
      // uses.
      expect(repositoryRelativePath(join(outside, "x", "file.ts")))
        .toBeUndefined();
    });
  });

  describe("defaultSpoolRoot()", () => {
    it("prefers the explicit override", () => {
      const env = (name: string) =>
        name === "CF_TEST_RECORDS_SPOOL_ROOT" ? "/spool" : undefined;
      expect(defaultSpoolRoot(env)).toBe("/spool");
    });

    it("falls back from XDG_CACHE_HOME to HOME to USERPROFILE", () => {
      expect(
        defaultSpoolRoot((name) =>
          name === "XDG_CACHE_HOME" ? "/xdg" : undefined
        ),
      ).toBe(join("/xdg", "common-fabric", "test-records"));
      expect(
        defaultSpoolRoot((name) => name === "HOME" ? "/home/u" : undefined),
      ).toBe(join("/home/u", ".cache", "common-fabric", "test-records"));
      expect(
        defaultSpoolRoot((name) =>
          name === "USERPROFILE" ? "/Users/u" : undefined
        ),
      ).toBe(join("/Users/u", ".cache", "common-fabric", "test-records"));
      expect(defaultSpoolRoot(() => undefined)).toBeUndefined();
    });
  });

  describe("recordsDir()", () => {
    it("treats an empty variable as recording off", () => {
      expect(recordsDir(() => "")).toBeUndefined();
    });
  });

  describe("agentLabel()", () => {
    it("returns the label only when the variable is non-empty", () => {
      expect(agentLabel(() => "probe")).toBe("probe");
      expect(agentLabel(() => "")).toBeUndefined();
    });

    it("names the harness an agent runs under", () => {
      expect(agentLabel((name) => name === "CLAUDECODE" ? "1" : undefined))
        .toBe("claude-code");
      expect(agentLabel((name) => name === "CURSOR_AGENT" ? "1" : undefined))
        .toBe("cursor");
      expect(
        agentLabel((name) => name === "CODEX_SANDBOX" ? "seatbelt" : undefined),
      )
        .toBe("codex");
      expect(
        agentLabel((name) =>
          name === "AI_AGENT" ? "claude-code_2-1-237_agent" : undefined
        ),
      ).toBe("agent");
    });

    it("keeps the deliberate label over the harness it runs under", () => {
      expect(
        agentLabel((name) =>
          name === "CF_TEST_AGENT"
            ? "labs-B"
            : name === "CLAUDECODE"
            ? "1"
            : undefined
        ),
      ).toBe("labs-B");
    });

    it("returns undefined for a shell with no agent in it", () => {
      expect(agentLabel((name) => name === "HOME" ? "/h" : undefined))
        .toBeUndefined();
    });
  });
});
