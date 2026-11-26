import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path/from-file-url";
import { join } from "@std/path/join";
import {
  collectAllPatternFiles,
  collectBaselineKeys,
  collectPatternFiles,
  isIframeGuestBundle,
  isPatternSource,
  matchesPatternFilter,
  normalizePatternPath,
  PATTERN_TREES,
  patternKey,
  patternPath,
  patternRoot,
  PATTERNS_DIR,
} from "./pattern-files.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("isPatternSource", () => {
  it("accepts authored .ts and .tsx entries", () => {
    expect(isPatternSource("patterns/system/notes/note.tsx")).toBe(true);
    expect(isPatternSource("patterns/system/home/home.tsx")).toBe(true);
    expect(isPatternSource("patterns/dev/factory-outputs/vehicles.ts")).toBe(
      true,
    );
  });

  it("rejects test files, which are never update targets themselves", () => {
    expect(isPatternSource("patterns/system/notes/note.test.tsx")).toBe(
      false,
    );
    expect(isPatternSource("patterns/dev/factory-outputs/vehicles.test.ts"))
      .toBe(false);
  });

  it("rejects non-source files, including the baselines this gate writes", () => {
    expect(isPatternSource("patterns/README.md")).toBe(false);
    expect(
      isPatternSource(
        "patterns/baselines/a.tsx/20260101T000000Z-x.json",
      ),
    ).toBe(false);
  });

  it("rejects the excluded trees and files", () => {
    expect(isPatternSource("patterns/integration/foo.ts")).toBe(false);
    expect(isPatternSource("patterns/tools/foo.ts")).toBe(false);
    expect(isPatternSource("patterns/apps/topics/tools/topics.ts")).toBe(
      false,
    );
    expect(isPatternSource("patterns/apps/topics/tools.tsx")).toBe(true);
    expect(isPatternSource("patterns/system/notes/tools/note.tsx")).toBe(
      true,
    );
    expect(isPatternSource("patterns/mod.ts")).toBe(false);
  });

  it("rejects authored iframe support modules", () => {
    expect(
      isPatternSource("patterns/iframe-notes/contract.ts"),
    ).toBe(false);
    expect(isPatternSource("patterns/iframe-notes/guest.ts")).toBe(
      false,
    );
    expect(isPatternSource("patterns/iframe-notes/guest.tsx")).toBe(
      false,
    );
    expect(isPatternSource("patterns/iframe-notes/main.tsx")).toBe(
      true,
    );
  });

  it("does not reserve iframe support basenames outside iframe patterns", () => {
    expect(isPatternSource("patterns/notebook/contract.ts")).toBe(
      true,
    );
    expect(isPatternSource("patterns/notebook/guest.ts")).toBe(true);
    expect(
      isPatternSource("connectors/example/pattern/guest.ts", "."),
    ).toBe(true);
  });
});

describe("isIframeGuestBundle", () => {
  it("returns true for a guest.js anywhere in an iframe pattern's tree", () => {
    expect(
      isIframeGuestBundle(
        "patterns/showcase/iframe-board/guest.js",
        "patterns",
      ),
    )
      .toBe(true);
    expect(
      isIframeGuestBundle(
        "patterns/showcase/iframe-board/editor/guest.js",
        "patterns",
      ),
    ).toBe(true);
  });

  it("returns false for a guest's source, and for a guest.js outside an iframe pattern", () => {
    expect(
      isIframeGuestBundle(
        "patterns/showcase/iframe-board/guest.ts",
        "patterns",
      ),
    )
      .toBe(false);
    expect(isIframeGuestBundle("patterns/showcase/board/guest.js", "patterns"))
      .toBe(false);
  });
});

describe("patternKey", () => {
  it("strips the patterns root, leaving the toolshed route suffix", () => {
    // The key is also the path the updater resolves `?identity` against, so it
    // has to be exactly the route suffix — not a basename, not an absolute path.
    expect(patternKey("patterns/system/home/home.tsx")).toBe(
      "system/home/home.tsx",
    );
    expect(patternKey("patterns/top.tsx")).toBe("top.tsx");
  });

  it("leaves a path that is not under the patterns root alone", () => {
    expect(patternKey("elsewhere/home.tsx")).toBe("elsewhere/home.tsx");
  });

  it("preserves the deployed keys of connector-owned patterns", () => {
    expect(
      patternKey("connectors/agents/debug-view/main.tsx"),
    ).toBe("agent-sessions-debug/main.tsx");
    expect(
      patternKey("connectors/github/activity-view/main.tsx"),
    ).toBe("github-activity/main.tsx");
  });

  it("normalizes Windows paths before deriving a deployed key", () => {
    expect(
      patternKey("connectors\\agents\\debug-view\\main.tsx"),
    ).toBe("agent-sessions-debug/main.tsx");
    expect(
      patternKey(
        "C:\\repo\\patterns\\system\\home\\home.tsx",
        "C:\\repo\\patterns",
      ),
    ).toBe("system/home/home.tsx");
  });
});

describe("normalizePatternPath", () => {
  it("uses repository separators on every platform", () => {
    expect(normalizePatternPath("patterns\\main.tsx")).toBe(
      "patterns/main.tsx",
    );
  });
});

describe("patternPath", () => {
  it("returns the source path for central and connector-owned patterns", () => {
    expect(patternPath("system/home/home.tsx")).toBe(
      "patterns/system/home/home.tsx",
    );
    expect(patternPath("agent-sessions-debug/main.tsx")).toBe(
      "connectors/agents/debug-view/main.tsx",
    );
  });
});

describe("matchesPatternFilter", () => {
  it("matches both source paths and preserved deployed keys", () => {
    const path = "connectors/agents/debug-view/main.tsx";
    expect(matchesPatternFilter(path, "debug-view")).toBe(true);
    expect(matchesPatternFilter(path, "agent-sessions-debug")).toBe(true);
    expect(matchesPatternFilter(path, "github-activity")).toBe(false);
  });

  it("matches a preserved key for a Windows source path", () => {
    expect(
      matchesPatternFilter(
        "connectors\\agents\\debug-view\\main.tsx",
        "agent-sessions-debug",
      ),
    ).toBe(true);
  });

  it("normalizes a Windows path filter", () => {
    expect(
      matchesPatternFilter(
        "connectors\\agents\\debug-view\\main.tsx",
        "connectors\\agents\\debug-view",
      ),
    ).toBe(true);
  });
});

describe("patternRoot", () => {
  it("returns the source root containing a pattern", () => {
    expect(patternRoot("patterns/system/home/home.tsx")).toBe(
      "patterns",
    );
    expect(patternRoot("connectors/agents/debug-view/main.tsx"))
      .toBe(".");
    expect(patternRoot("connectors\\agents\\debug-view\\main.tsx"))
      .toBe(".");
  });
});

describe("collectPatternFiles", () => {
  // `PATTERNS_DIR` is repo-root-relative, which is right for the task (always
  // run via `deno task` from the root) but wrong for a test: the workspace
  // runner invokes tests from the package directory. Resolve from this file
  // instead so the test does not depend on the working directory.
  const patternsDir = fromFileUrl(
    new URL("../patterns", import.meta.url),
  );

  it("returns a sorted set of real pattern sources and no baselines", async () => {
    const files = await collectPatternFiles(patternsDir);

    expect(files.length).toBeGreaterThan(100);
    expect([...files].sort()).toEqual(files);
    expect(files.includes(`${patternsDir}/system/home/home.tsx`)).toBe(true);
    expect(files.some((f) => f.includes("/baselines/"))).toBe(false);
    expect(files.some((f) => f.endsWith(".test.tsx"))).toBe(false);
    expect(files.some((f) => f.startsWith(`${patternsDir}/integration/`)))
      .toBe(false);
  });

  it("excludes by path relative to the root it was given, not the repo root", () => {
    // Exclusions anchored to `patterns/...` would silently stop
    // matching the moment a caller passed an absolute directory.
    const abs = "/tmp/somewhere/patterns";
    expect(isPatternSource(`${abs}/integration/foo.ts`, abs)).toBe(false);
    expect(isPatternSource(`${abs}/mod.ts`, abs)).toBe(false);
    expect(isPatternSource(`${abs}/system/home/home.tsx`, abs)).toBe(true);
  });

  it("is repo-root-relative by default, which is what the task relies on", () => {
    expect(PATTERNS_DIR).toBe("patterns");
  });

  it("returns files alone, leaving out an entry that is a link", async () => {
    const dir = await Deno.makeTempDir({ prefix: "pattern-files-" });
    try {
      await Deno.writeTextFile(`${dir}/a.tsx`, "");
      await Deno.symlink(`${dir}/a.tsx`, `${dir}/b.tsx`);

      expect(await collectPatternFiles(dir)).toEqual([`${dir}/a.tsx`]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

describe("collectAllPatternFiles", () => {
  it("returns every tree's sources relative to the root it was given, sorted", async () => {
    const root = await Deno.makeTempDir({ prefix: "pattern-files-all-" });
    try {
      for (const tree of PATTERN_TREES) {
        await Deno.mkdir(join(root, tree.directory, "z"), { recursive: true });
        await Deno.writeTextFile(join(root, tree.directory, "z/z.tsx"), "");
        await Deno.writeTextFile(
          join(root, tree.directory, "z/z.test.tsx"),
          "",
        );
      }
      await Deno.mkdir(join(root, "patterns/a"));
      await Deno.writeTextFile(join(root, "patterns/a/a.tsx"), "");

      expect(await collectAllPatternFiles(root)).toEqual(
        [
          "patterns/a/a.tsx",
          ...PATTERN_TREES.map((tree) => `${tree.directory}/z/z.tsx`),
        ].sort(),
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("collectBaselineKeys", () => {
  it("returns no keys for an absent tree, and throws for one it cannot read", async () => {
    const dir = await Deno.makeTempDir({ prefix: "pattern-files-" });
    try {
      await Deno.writeTextFile(`${dir}/file`, "");

      expect(await collectBaselineKeys(`${dir}/absent`)).toEqual([]);
      await expect(collectBaselineKeys(`${dir}/file`)).rejects
        .toThrow(Deno.errors.NotADirectory);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
