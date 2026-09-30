import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import {
  ALLOWLIST,
  gitTrackedFiles,
  importsAlias,
  main,
  owningMember,
  parseImportMap,
  parseWorkspaceMembers,
  scan,
} from "./check-unused-deps.ts";

//
// importsAlias: the specifier shapes that count as an import
//

Deno.test("importsAlias matches a static import", () => {
  assert(importsAlias('import { x } from "zod";', "zod"));
});

Deno.test("importsAlias matches a type-only import", () => {
  assert(importsAlias('import type { X } from "pino";', "pino"));
});

Deno.test("importsAlias matches a re-export", () => {
  assert(importsAlias('export { x } from "zod";', "zod"));
  assert(importsAlias('export * from "zod";', "zod"));
});

Deno.test("importsAlias matches a side-effect import", () => {
  assert(importsAlias('import "ses";', "ses"));
});

Deno.test("importsAlias matches a dynamic import", () => {
  assert(importsAlias('await import("dagre");', "dagre"));
});

//
// The specifier shapes the lead must keep matching
//
// Dropping the `\s*` or an alternative from the lead would reintroduce a false
// positive on ordinary code, yet leave the happy-path tests above green.
//

Deno.test("importsAlias matches an import broken across lines", () => {
  const source = [
    "import {",
    "  scaleBand,",
    "  scaleLinear,",
    '} from "d3-scale";',
  ].join("\n");
  assert(importsAlias(source, "d3-scale"));
});

Deno.test("importsAlias matches a dynamic import with surrounding whitespace", () => {
  assert(importsAlias('await import(\n  "dagre",\n);', "dagre"));
});

Deno.test("importsAlias matches a require call", () => {
  assert(importsAlias('const x = require("left-pad");', "left-pad"));
});

Deno.test("importsAlias matches an export * as namespace", () => {
  assert(importsAlias('export * as z from "zod";', "zod"));
});

Deno.test("importsAlias matches an import with an import attribute", () => {
  assert(
    importsAlias(
      'import ports from "@commonfabric/ports" with { type: "json" };',
      "@commonfabric/ports",
    ),
  );
});

Deno.test("importsAlias matches @deno-types in single quotes", () => {
  assert(importsAlias("// @deno-types='@types/leaflet'", "@types/leaflet"));
});

Deno.test("importsAlias matches @deno-types with spaces around the equals", () => {
  assert(
    importsAlias('// @deno-types = "@types/d3-scale"', "@types/d3-scale"),
  );
});

Deno.test("importsAlias matches a @deno-types companion comment", () => {
  const source = [
    '// @deno-types="@types/d3-scale"',
    'import { scaleBand } from "d3-scale";',
  ].join("\n");
  assert(importsAlias(source, "@types/d3-scale"));
});

//
// The current `@ts-types` spelling of the companion-type comment
//
// `@ts-types` is Deno's current spelling of the companion-type comment; the
// older `@deno-types` above still works and both must be recognized, or an
// `@types/*` alias reached through the current form would be reported unused.
//

Deno.test("importsAlias matches a @ts-types companion comment", () => {
  const source = [
    '// @ts-types="@types/d3-scale"',
    'import { scaleBand } from "d3-scale";',
  ].join("\n");
  assert(importsAlias(source, "@types/d3-scale"));
});

Deno.test("importsAlias matches @ts-types with single quotes and spaces", () => {
  assert(importsAlias("// @ts-types = '@types/leaflet'", "@types/leaflet"));
});

//
// What an alias reaches, and what it does not
//
// Subpaths and slash-terminated forms, against the near misses: a longer
// sibling, a bare identifier, a substring of another specifier — and the
// deliberate over-match, where an occurrence inside a comment counts.
//

Deno.test("importsAlias matches a subpath import of a bare alias", () => {
  assert(
    importsAlias(
      'import { serveDir } from "@std/http/file-server";',
      "@std/http",
    ),
  );
});

Deno.test("importsAlias does not treat a longer alias as importing a shorter sibling by name only", () => {
  // "@std/http-extras" is not "@std/http": the slash boundary in the subpath
  // rule is what separates them, so a bare "@std/http" must not match here.

  assertEquals(
    importsAlias('import x from "@std/http-extras";', "@std/http"),
    false,
  );
});

Deno.test("importsAlias matches any specifier under a slash-terminated alias", () => {
  assert(importsAlias('import env from "@/env.ts";', "@/"));
  assert(importsAlias('import app from "@/app.ts";', "@/"));
});

Deno.test("importsAlias ignores a slash-terminated alias with nothing after it", () => {
  // "@/" maps a prefix; a specifier that is only the prefix imports no module.

  assertEquals(importsAlias('const s = "@/";', "@/"), false);
});

Deno.test("importsAlias ignores a bare identifier that is not an import", () => {
  assertEquals(importsAlias("const zod = 1; zod.parse();", "zod"), false);
});

Deno.test("importsAlias ignores a substring of a different specifier", () => {
  // "notesEntry" contains "sentry" but imports nothing named sentry.

  assertEquals(
    importsAlias('import { notesEntry } from "./notes.ts";', "sentry"),
    false,
  );
});

Deno.test("importsAlias counts a commented-out import as used", () => {
  // The loose matching is deliberate: an occurrence inside a comment or string
  // counts as used. That can only ever hide a dead alias, never flag a live
  // one, so the check does not misfire on a real dependency.

  assert(importsAlias('// import { x } from "zod";', "zod"));
});

//
// owningMember: longest-prefix attribution, including nesting
//

Deno.test("owningMember attributes a file to its member", () => {
  const members = ["packages/memory", "packages/runner"];
  assertEquals(
    owningMember("packages/memory/interface.ts", members),
    "packages/memory",
  );
});

Deno.test("owningMember prefers the nested member over its container", () => {
  const members = ["packages/patterns", "packages/patterns/nested"];
  assertEquals(
    owningMember("packages/patterns/nested/mod.ts", members),
    "packages/patterns/nested",
  );
  assertEquals(
    owningMember("packages/patterns/other.ts", members),
    "packages/patterns",
  );
});

Deno.test("owningMember returns undefined for a file under no member", () => {
  assertEquals(owningMember("tasks/check.ts", ["packages/memory"]), undefined);
});

Deno.test("owningMember does not match a member that is only a path-segment prefix", () => {
  // "packages/mem" must not own a file under "packages/memory".

  assertEquals(
    owningMember("packages/memory/interface.ts", ["packages/mem"]),
    undefined,
  );
});

//
// Parsing the config files
//

Deno.test("parseImportMap returns the imports block", () => {
  const text = `{
    // a comment
    "imports": { "zod": "npm:zod@^3", "ses": "npm:ses@^1" }
  }`;
  assertEquals(parseImportMap(text), {
    zod: "npm:zod@^3",
    ses: "npm:ses@^1",
  });
});

Deno.test("parseImportMap tolerates a missing imports block", () => {
  assertEquals(parseImportMap(`{ "name": "x" }`), {});
});

Deno.test("parseWorkspaceMembers normalizes leading ./ and trailing /", () => {
  const text = `{ "workspace": ["./packages/a", "packages/b/"] }`;
  assertEquals(parseWorkspaceMembers(text), ["packages/a", "packages/b"]);
});

Deno.test("parseWorkspaceMembers returns empty when there is no workspace array", () => {
  assertEquals(parseWorkspaceMembers(`{ "name": "x" }`), []);
});

//
// The entry point, and the git fallback
//
// The entry point over the real tree, and what the git helper answers when
// the `git` binary is not there to run.
//

Deno.test("runs as a command-line program against the repository", async () => {
  // Exercises the module's command-line entry point (the import.meta.main
  // guard). It runs against the real repository, which the "no unused import
  // map entries" test asserts is clean, so the check prints success and exits 0.

  const script = fromFileUrl(
    new URL("./check-unused-deps.ts", import.meta.url),
  );
  const { code, stdout } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-read", "--allow-run=git", script],
    stdout: "piped",
    stderr: "null",
  }).output();
  assertEquals(code, 0);
  assert(
    new TextDecoder().decode(stdout).includes("No unused import map entries"),
  );
});

Deno.test("gitTrackedFiles returns null when git is not available", async () => {
  // A missing git binary makes Deno.Command throw; the scan falls back to a
  // filesystem walk rather than failing.

  assertEquals(
    await gitTrackedFiles(".", "git-binary-that-does-not-exist-xyz"),
    null,
  );
});

//
// scan over the real repository tree
//

Deno.test("no unused import map entries in the repository", async () => {
  const { unused } = await scan();
  assertEquals(
    unused,
    [],
    "Import map entries with no in-scope import were found. Remove the alias " +
      "from its `imports` block (and run `deno install`), or, for a deliberate " +
      "exception, add it to ALLOWLIST in tasks/check-unused-deps.ts.",
  );
});

Deno.test("the unused-import-map ALLOWLIST has no stale entries", async () => {
  const { allowlisted } = await scan();
  const live = new Set(
    allowlisted.map((entry) => `${entry.config}\t${entry.alias}`),
  );
  const stale = [...ALLOWLIST.keys()].filter((key) => !live.has(key)).sort();
  assertEquals(
    stale,
    [],
    "ALLOWLIST entries in tasks/check-unused-deps.ts no longer name an unused " +
      "import map entry (the alias is now imported, or no longer declared). " +
      "Remove them from the allowlist.",
  );
});

//
// main over a temp fixture tree
//

// Builds a minimal workspace under a fresh temp dir: a root deno.jsonc naming
// one member, that member's deno.jsonc with the given imports, and one source
// file. Returns the root; the caller removes it.
async function fixtureTree(
  memberImports: Record<string, string>,
  sourceContent: string,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  await Deno.writeTextFile(
    join(root, "deno.jsonc"),
    JSON.stringify({ workspace: ["./packages/foo"], imports: {} }, null, 2),
  );
  const member = join(root, "packages", "foo");
  await Deno.mkdir(member, { recursive: true });
  await Deno.writeTextFile(
    join(member, "deno.jsonc"),
    JSON.stringify({ imports: memberImports }, null, 2),
  );
  await Deno.writeTextFile(join(member, "mod.ts"), sourceContent);
  return root;
}

// Runs a git command under `root`, throwing if it fails. Used to turn a fixture
// tree into a real git working tree so the tracked-files path is exercised.
async function runGit(root: string, ...args: string[]): Promise<void> {
  const { success } = await new Deno.Command("git", {
    args: ["-C", root, ...args],
    stdout: "null",
    stderr: "null",
  }).output();
  if (!success) throw new Error(`git ${args.join(" ")} failed in ${root}`);
}

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

Deno.test("main returns 0 and reports success on a clean tree", async () => {
  const root = await fixtureTree(
    { zod: "npm:zod@^3" },
    'import { z } from "zod";\n',
  );
  try {
    let code = -1;
    const { out } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
    assert(out.includes("No unused import map entries"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main returns 1 and names the offender on an unused entry", async () => {
  const root = await fixtureTree(
    { zod: "npm:zod@^3", "left-pad": "npm:left-pad@^1" },
    'import { z } from "zod";\n',
  );
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("packages/foo/deno.jsonc: left-pad"));
    assert(!err.includes(": zod"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main checks a member whose config is deno.json", async () => {
  // Deno accepts deno.json as well as deno.jsonc for a member. An unused entry
  // in a deno.json member must still be found, and reported at its real path.

  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify({ workspace: ["./packages/foo"], imports: {} }, null, 2),
    );
    const member = join(root, "packages", "foo");
    await Deno.mkdir(member, { recursive: true });
    await Deno.writeTextFile(
      join(member, "deno.json"),
      JSON.stringify({ imports: { "left-pad": "npm:left-pad@^1" } }, null, 2),
    );
    await Deno.writeTextFile(join(member, "mod.ts"), "export const x = 1;\n");

    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("packages/foo/deno.json: left-pad"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main reads a deno.json root's own import map", async () => {
  // The root itself may be deno.json. An unused alias in its import map must be
  // reported at deno.json, which happens only if the root deno.json is read at
  // all. With deno.json support absent the root goes unread, no entries are
  // collected, and the check passes — so this fails unless the path works.

  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.json"),
      JSON.stringify(
        {
          workspace: ["./packages/foo"],
          imports: { "left-pad": "npm:left-pad@^1" },
        },
        null,
        2,
      ),
    );
    const member = join(root, "packages", "foo");
    await Deno.mkdir(member, { recursive: true });
    await Deno.writeTextFile(
      join(member, "deno.jsonc"),
      JSON.stringify({ imports: { zod: "npm:zod@^3" } }, null, 2),
    );
    await Deno.writeTextFile(
      join(member, "mod.ts"),
      'import { z } from "zod";\n',
    );

    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("deno.json: left-pad"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main flags a member alias imported only by another member", async () => {
  // The alias is imported, but under a different member, so the declaring
  // member's entry is still unused: its own files never reach it.

  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify(
        { workspace: ["./packages/a", "./packages/b"], imports: {} },
        null,
        2,
      ),
    );
    const a = join(root, "packages", "a");
    const b = join(root, "packages", "b");
    await Deno.mkdir(a, { recursive: true });
    await Deno.mkdir(b, { recursive: true });
    // Member "a" declares the alias but never imports it.
    await Deno.writeTextFile(
      join(a, "deno.jsonc"),
      JSON.stringify({ imports: { shared: "npm:shared@^1" } }, null, 2),
    );
    await Deno.writeTextFile(join(a, "mod.ts"), "export const x = 1;\n");
    // Member "b" imports it, but has no declaration of its own.
    await Deno.writeTextFile(
      join(b, "deno.jsonc"),
      JSON.stringify({ imports: {} }, null, 2),
    );
    await Deno.writeTextFile(join(b, "mod.ts"), 'import "shared";\n');

    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("packages/a/deno.jsonc: shared"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main counts an importer under an output-named directory", async () => {
  // A file under a directory named `build` is authored source, not generated
  // output: the scan must read it, or its imports' aliases look unused.

  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify({ workspace: ["./packages/foo"], imports: {} }, null, 2),
    );
    const member = join(root, "packages", "foo");
    await Deno.mkdir(join(member, "build"), { recursive: true });
    await Deno.writeTextFile(
      join(member, "deno.jsonc"),
      JSON.stringify({ imports: { zod: "npm:zod@^3" } }, null, 2),
    );
    await Deno.writeTextFile(
      join(member, "build", "gen.ts"),
      'import { z } from "zod";\n',
    );

    let code = -1;
    await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main tolerates a workspace member with no config file", async () => {
  // A directory listed as a member but carrying neither deno.jsonc nor
  // deno.json contributes no entries; collecting from it must not fail.

  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify(
        { workspace: ["./packages/foo", "./packages/nocfg"], imports: {} },
        null,
        2,
      ),
    );
    const foo = join(root, "packages", "foo");
    await Deno.mkdir(foo, { recursive: true });
    await Deno.writeTextFile(
      join(foo, "deno.jsonc"),
      JSON.stringify({ imports: { zod: "npm:zod@^3" } }, null, 2),
    );
    await Deno.writeTextFile(join(foo, "mod.ts"), 'import { z } from "zod";\n');
    const nocfg = join(root, "packages", "nocfg");
    await Deno.mkdir(nocfg, { recursive: true });
    await Deno.writeTextFile(join(nocfg, "mod.ts"), "export const x = 1;\n");

    let code = -1;
    await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main skips a tracked file missing from the working tree", async () => {
  // In a real git tree, git may list a file the working tree no longer holds.
  // Reading it fails, and the scan must skip it rather than throw.

  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify({ workspace: ["./packages/foo"], imports: {} }, null, 2),
    );
    const member = join(root, "packages", "foo");
    await Deno.mkdir(member, { recursive: true });
    await Deno.writeTextFile(
      join(member, "deno.jsonc"),
      JSON.stringify({ imports: { zod: "npm:zod@^3" } }, null, 2),
    );
    await Deno.writeTextFile(
      join(member, "mod.ts"),
      'import { z } from "zod";\n',
    );
    const gone = join(member, "gone.ts");
    await Deno.writeTextFile(gone, "export const g = 1;\n");
    // Stage the files so git tracks them, then remove one from disk.
    await runGit(root, "init");
    await runGit(root, "add", "-A");
    await Deno.remove(gone);

    let code = -1;
    await captureConsole(async () => {
      code = await main(root);
    });
    // zod is still imported by the surviving file; gone.ts is skipped, not fatal.
    assertEquals(code, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main treats a root alias as used when any member imports it", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-unused-deps-" });
  try {
    await Deno.writeTextFile(
      join(root, "deno.jsonc"),
      JSON.stringify(
        { workspace: ["./packages/a"], imports: { shared: "npm:shared@^1" } },
        null,
        2,
      ),
    );
    const a = join(root, "packages", "a");
    await Deno.mkdir(a, { recursive: true });
    await Deno.writeTextFile(
      join(a, "deno.jsonc"),
      JSON.stringify({ imports: {} }, null, 2),
    );
    await Deno.writeTextFile(join(a, "mod.ts"), 'import "shared";\n');

    let code = -1;
    await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
