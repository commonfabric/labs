import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  declaredTier,
  hasMarkerLine,
  stripMarker,
  tableTierOf,
  TIER_DIRECTORIES,
  TIER_FILES,
  TIER_MARKERS,
  tierOf,
  UNTIERED_FILES,
  withMarker,
} from "./pattern-tiers.ts";
import {
  isWritable,
  main,
  problemWith,
  runTierCheck,
  staleTableEntries,
} from "./check-pattern-tiers.ts";

/**
 * A temporary patterns tree holding one source for every table entry, so a run
 * over it reports no stale entry and every table row is exercised as written.
 */
async function completeTierTree(): Promise<string> {
  const dir = await Deno.makeTempDir();
  const write = async (rel: string, body: string) => {
    const path = `${dir}/${rel}`;
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(path, body);
  };
  for (const [prefix, tier] of Object.entries(TIER_DIRECTORIES)) {
    await write(`${prefix}main.tsx`, `${TIER_MARKERS[tier]}\ncode;\n`);
  }
  for (const [file, tier] of Object.entries(TIER_FILES)) {
    await write(file, `${TIER_MARKERS[tier]}\ncode;\n`);
  }
  for (const file of Object.keys(UNTIERED_FILES)) {
    await write(file, "code;\n");
  }
  await write("counter/counter.tsx", "code;\n");
  return dir;
}

const LEGACY = TIER_MARKERS.legacy;
const FIXTURE = TIER_MARKERS.fixture;

describe("tierOf", () => {
  it("tiers a file by the directory holding it", () => {
    expect(tierOf("factory-outputs/lot-watch/main.tsx")).toBe("legacy");
    expect(tierOf("gideon-tests/test-cell-equals.tsx")).toBe("fixture");
    expect(tierOf("test/non-idempotent/shuffle.tsx")).toBe("fixture");
  });

  it("tiers a loose file by name", () => {
    expect(tierOf("vehicles.ts")).toBe("legacy");
    expect(tierOf("render-test.tsx")).toBe("fixture");
  });

  it("leaves the copyable tiers unmarked", () => {
    expect(tierOf("counter/counter.tsx")).toBe(undefined);
    expect(tierOf("system/home.tsx")).toBe(undefined);
    expect(tierOf("notes/note.tsx")).toBe(undefined);
  });

  it("exempts the shared helper inside a tiered directory", () => {
    // Marking the helper pattern tests are meant to call "do not copy" would
    // say the opposite of what it is for.
    expect(tierOf("test/vnode-helpers.ts")).toBe(undefined);
  });

  it("reports through tableTierOf what the exemption is hiding", () => {
    // `tierOf` alone cannot check an exemption: it honours it, so every
    // exempted file looks untiered and there is nothing left to test against.
    expect(tableTierOf("test/vnode-helpers.ts")).toBe("fixture");
    expect(tableTierOf("counter/counter.tsx")).toBe(undefined);
  });

  it("does not let a directory prefix spill into a sibling", () => {
    // "test/" must not tier "test-import.tsx" or a "tests-support/" sibling.
    expect(tierOf("test-import.tsx")).toBe(undefined);
    expect(tierOf("tests-support/helper.ts")).toBe(undefined);
  });
});

describe("declaredTier", () => {
  it("reads the tier a file's opening lines declare", () => {
    expect(declaredTier(`${LEGACY}\nimport x from "y";\n`)).toBe("legacy");
    expect(declaredTier(`${FIXTURE}\nimport x from "y";\n`)).toBe("fixture");
  });

  it("declares nothing for a file that opens with ordinary code", () => {
    expect(declaredTier('import x from "y";\n')).toBe(undefined);
    expect(declaredTier("/** A pattern. */\n")).toBe(undefined);
  });

  it("declares nothing for a marker whose wording has drifted", () => {
    const drifted = "// PATTERN TIER: fixture — do not copy\n";
    expect(declaredTier(drifted)).toBe(undefined);
    expect(hasMarkerLine(drifted)).toBe(true);
  });

  it("declares nothing for a marker that is not at the very top", () => {
    // A marker below the imports is one a reader scrolls past, so it does not
    // count as declared.
    expect(declaredTier(`import x from "y";\n${FIXTURE}\n`)).toBe(undefined);
  });
});

describe("withMarker", () => {
  it("puts the marker ahead of everything else in the file", () => {
    const source = '/** A fixture. */\nimport x from "y";\n';
    expect(withMarker(source, "fixture")).toBe(`${FIXTURE}\n${source}`);
  });

  it("replaces a marker of the other tier rather than stacking one on it", () => {
    const source = `${LEGACY}\nimport x from "y";\n`;
    expect(withMarker(source, "fixture")).toBe(
      `${FIXTURE}\nimport x from "y";\n`,
    );
  });

  it("is idempotent, so a re-run does not double the marker", () => {
    const once = withMarker('import x from "y";\n', "legacy");
    expect(withMarker(once, "legacy")).toBe(once);
  });
});

describe("stripMarker", () => {
  it("removes a marker it recognizes, by its own line count", () => {
    expect(stripMarker(`${FIXTURE}\nimport x from "y";\n`)).toBe(
      'import x from "y";\n',
    );
  });

  it("leaves a mangled marker in place rather than guessing its extent", () => {
    // Guessing how far a broken marker runs is how a rewrite eats the comment
    // underneath it.
    const mangled = "// PATTERN TIER: fixture\n// A real comment.\ncode;\n";
    expect(stripMarker(mangled)).toBe(mangled);
  });

  it("leaves an unmarked file alone", () => {
    expect(stripMarker("code;\n")).toBe("code;\n");
  });
});

describe("problemWith", () => {
  it("passes a marked file whose marker matches its tier", () => {
    expect(problemWith(`${LEGACY}\ncode;\n`, "legacy")).toBe(undefined);
    expect(problemWith(`${FIXTURE}\ncode;\n`, "fixture")).toBe(undefined);
  });

  it("passes an unmarked file in a copyable tier", () => {
    expect(problemWith("code;\n", undefined)).toBe(undefined);
  });

  it("reports a file that should be marked and is not", () => {
    expect(problemWith("code;\n", "fixture")).toContain(
      "should open with the fixture marker",
    );
  });

  it("reports a marker naming the wrong tier", () => {
    expect(problemWith(`${LEGACY}\ncode;\n`, "fixture")).toContain(
      "is marked legacy but the tables place it in fixture",
    );
  });

  it("reports a marker on a file no table places", () => {
    expect(problemWith(`${FIXTURE}\ncode;\n`, undefined)).toContain(
      "no table places it in a marked tier",
    );
  });

  it("reports marker-shaped text nothing would maintain", () => {
    const drifted = "// PATTERN TIER: whatever\ncode;\n";
    expect(problemWith(drifted, undefined)).toContain(
      "a tier marker the tables do not place",
    );
    expect(problemWith(drifted, "legacy")).toContain(
      "its opening lines are not it",
    );
  });
});

describe("isWritable", () => {
  it("writes a marker onto a file that has none", () => {
    expect(isWritable("code;\n", "fixture")).toBe(true);
  });

  it("corrects a recognized marker naming the other tier", () => {
    // Moving a directory between tiers in the tables is a mechanical edit,
    // because the marker being replaced has a known line count.
    expect(isWritable(`${LEGACY}\ncode;\n`, "fixture")).toBe(true);
  });

  it("refuses a file whose marker text matches nothing", () => {
    // Where the mangled text ends and the file's own comments begin is not
    // knowable, so a person fixes it rather than a rewrite guessing.
    expect(isWritable("// PATTERN TIER: bogus\n// A real comment.\n", "legacy"))
      .toBe(false);
  });

  it("never writes to a file no table places in a marked tier", () => {
    expect(isWritable("code;\n", undefined)).toBe(false);
    expect(isWritable(`${FIXTURE}\ncode;\n`, undefined)).toBe(false);
  });
});

describe("staleTableEntries", () => {
  it("accepts tables whose every entry matches something", () => {
    expect(
      staleTableEntries(
        ["fixtures/nested/main.tsx", "fixtures/helper.ts", "legacy.tsx"],
        {
          directories: { "fixtures/": "fixture" },
          files: { "legacy.tsx": "legacy" },
          untiered: { "fixtures/helper.ts": "Shared test helper." },
        },
      ),
    ).toEqual([]);
  });

  it("reports a directory entry that matches no pattern source", () => {
    // What catches a tiered directory renamed out from under the tables.
    const stale = staleTableEntries(["counter/counter.tsx"]);
    expect(stale.some((entry) => entry.includes("gideon-tests/"))).toBe(true);
  });

  it("reports a file entry that is no longer a pattern source", () => {
    const stale = staleTableEntries(["counter/counter.tsx"]);
    expect(stale.some((entry) => entry.includes("vehicles.ts"))).toBe(true);
  });

  it("reports an exemption whose file is gone", () => {
    const stale = staleTableEntries(["counter/counter.tsx"]);
    expect(
      stale.some((entry) =>
        entry.includes('exempts "test/vnode-helpers.ts"') &&
        entry.includes("not a pattern source")
      ),
    ).toBe(true);
  });
});

describe("runTierCheck", () => {
  it("passes a tree whose every marker matches the tables", async () => {
    const dir = await completeTierTree();
    try {
      const report = await runTierCheck(dir, false);
      expect(report.problems).toEqual([]);
      expect(report.stale).toEqual([]);
      expect(report.written).toEqual([]);
      // The untiered helper and the copyable pattern are examined and unmarked.
      expect(report.examined).toBe(report.marked + 2);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reports a pattern that arrived in a tiered directory unmarked", async () => {
    const dir = await completeTierTree();
    try {
      await Deno.writeTextFile(`${dir}/gideon-tests/tempting.tsx`, "code;\n");
      const report = await runTierCheck(dir, false);
      expect(report.problems.length).toBe(1);
      expect(report.problems[0].key).toBe("gideon-tests/tempting.tsx");
      expect(report.problems[0].detail).toContain("should open with the");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("writes the marker for such a pattern, ahead of its own text", async () => {
    const dir = await completeTierTree();
    try {
      const path = `${dir}/gideon-tests/tempting.tsx`;
      await Deno.writeTextFile(path, "/** A tempting example. */\ncode;\n");
      const report = await runTierCheck(dir, true);
      expect(report.written).toEqual(["gideon-tests/tempting.tsx"]);
      expect(report.problems).toEqual([]);
      expect(await Deno.readTextFile(path)).toBe(
        `${FIXTURE}\n/** A tempting example. */\ncode;\n`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("corrects a marker naming the tier the tables no longer give", async () => {
    const dir = await completeTierTree();
    try {
      const path = `${dir}/gideon-tests/main.tsx`;
      await Deno.writeTextFile(path, `${LEGACY}\ncode;\n`);
      const report = await runTierCheck(dir, true);
      expect(report.written).toEqual(["gideon-tests/main.tsx"]);
      expect(await Deno.readTextFile(path)).toBe(`${FIXTURE}\ncode;\n`);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("refuses to rewrite marker-shaped text it does not recognize", async () => {
    const dir = await completeTierTree();
    try {
      const path = `${dir}/gideon-tests/main.tsx`;
      const mangled = "// PATTERN TIER: fixture\n// A real comment.\ncode;\n";
      await Deno.writeTextFile(path, mangled);
      const report = await runTierCheck(dir, true);
      expect(report.written).toEqual([]);
      expect(report.problems[0].detail).toContain(
        "its opening lines are not it",
      );
      // The file is left exactly as it was, comment and all.
      expect(await Deno.readTextFile(path)).toBe(mangled);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reports a marker on a file no table places", async () => {
    const dir = await completeTierTree();
    try {
      await Deno.writeTextFile(
        `${dir}/counter/counter.tsx`,
        `${FIXTURE}\ncode;\n`,
      );
      const report = await runTierCheck(dir, false);
      expect(report.problems.length).toBe(1);
      expect(report.problems[0].detail).toContain("no table places it");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reports a table entry that matches nothing in the tree", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${dir}/counter.tsx`, "code;\n");
      const report = await runTierCheck(dir, false);
      expect(report.stale.length).toBeGreaterThan(0);
      expect(report.marked).toBe(0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("skips an entry that is neither a file nor a directory", async () => {
    const dir = await completeTierTree();
    try {
      // A symlink is not a pattern source, so the walk passes over it rather
      // than reading through it and demanding a marker.
      await Deno.symlink(
        `${dir}/gideon-tests/main.tsx`,
        `${dir}/gideon-tests/alias.tsx`,
      );
      const report = await runTierCheck(dir, false);
      expect(report.problems).toEqual([]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("skips test files and the excluded trees while walking", async () => {
    const dir = await completeTierTree();
    try {
      // Neither is a pattern source, so neither needs a marker.
      await Deno.writeTextFile(`${dir}/gideon-tests/a.test.tsx`, "code;\n");
      await Deno.mkdir(`${dir}/integration`, { recursive: true });
      await Deno.writeTextFile(`${dir}/integration/driver.ts`, "code;\n");
      const report = await runTierCheck(dir, false);
      expect(report.problems).toEqual([]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

/** Collects what a body writes to the console, restoring it afterwards. */
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

describe("main", () => {
  it("returns 0 and counts what it examined for an agreeing tree", async () => {
    const dir = await completeTierTree();
    try {
      let code = 1;
      const { out } = await captureConsole(async () => {
        code = await main(dir, false);
      });
      expect(code).toBe(0);
      expect(out).toContain("agree with the tables");
      expect(out).toContain("pattern sources");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("returns 1 and names the file and the remedy for an unmarked one", async () => {
    const dir = await completeTierTree();
    try {
      await Deno.writeTextFile(`${dir}/gideon-tests/tempting.tsx`, "code;\n");
      let code = 0;
      const { err } = await captureConsole(async () => {
        code = await main(dir, false);
      });
      expect(code).toBe(1);
      expect(err).toContain("gideon-tests/tempting.tsx");
      expect(err).toContain("deno task fix-pattern-tiers");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("returns 0 after writing the markers it was asked to apply", async () => {
    const dir = await completeTierTree();
    try {
      await Deno.writeTextFile(`${dir}/gideon-tests/tempting.tsx`, "code;\n");
      let code = 1;
      const { out } = await captureConsole(async () => {
        code = await main(dir, true);
      });
      expect(code).toBe(0);
      expect(out).toContain("Marked 1 pattern source(s):");
      expect(out).toContain("gideon-tests/tempting.tsx");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("returns 1 and reports a stale table entry", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${dir}/counter.tsx`, "code;\n");
      let code = 0;
      const { err } = await captureConsole(async () => {
        code = await main(dir, false);
      });
      expect(code).toBe(1);
      expect(err).toContain("matches no pattern source");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

describe("staleTableEntries table guards", () => {
  it("reports a directory entry written without its trailing slash", () => {
    // Without the slash the prefix match spills into any sibling whose name
    // merely starts the same way, tiering files silently.
    const stale = staleTableEntries(["test-import.tsx"], {
      directories: { "test": "fixture" },
      files: {},
      untiered: {},
    });
    expect(stale).toEqual(['TIER_DIRECTORIES["test"] needs a trailing slash.']);
  });

  it("reports an exemption for a file no table would have tiered", () => {
    // An exemption that exempts nothing is a typo or a file that moved.
    const stale = staleTableEntries(["counter/counter.tsx"], {
      directories: {},
      files: {},
      untiered: { "counter/counter.tsx": "why" },
    });
    expect(stale).toEqual([
      'UNTIERED_FILES exempts "counter/counter.tsx", which no table would tier.',
    ]);
  });

  it("accepts an exemption for a file a directory entry does tier", () => {
    expect(
      staleTableEntries(["test/helper.ts"], {
        directories: { "test/": "fixture" },
        files: {},
        untiered: { "test/helper.ts": "the shared helper" },
      }),
    ).toEqual([]);
  });
});
