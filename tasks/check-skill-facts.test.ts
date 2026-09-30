import { assert, assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  citedPath,
  collectDrift,
  isRooted,
  main,
  readSkillDocs,
  readTree,
  readWorkspaceExports,
  resolvesInTree,
  skillDirOf,
  Tree,
} from "./check-skill-facts.ts";

/** Runs git under `root`, throwing on a non-zero exit. */
async function git(root: string, args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args: ["-C", root, ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

/**
 * Writes `files` into a fresh temp git repo and returns its root. `git init`
 * plus `git add` is enough — the check reads the index for entry modes and the
 * working tree for everything else, so nothing needs committing. The caller
 * removes the tree.
 */
async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-skill-facts-" });
  for (const [path, contents] of Object.entries(files)) {
    await Deno.mkdir(join(root, dirname(path)), { recursive: true });
    await Deno.writeTextFile(join(root, path), contents);
  }
  await git(root, ["init", "-q"]);
  await git(root, ["add", "-A"]);
  return root;
}

/** A minimal repo whose one skill carries `skillBody`. */
function fixtureFiles(skillBody: string): Record<string, string> {
  return {
    "deno.jsonc": '{ "workspace": ["./packages/ui"] }',
    "packages/ui/deno.jsonc":
      '{ "name": "@commonfabric/ui", "exports": { ".": "./src/index.ts" } }',
    "packages/ui/src/index.ts": "",
    "skills/demo/SKILL.md": skillBody,
  };
}

/** Runs `body` with console output captured, returning what each stream got. */
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

// A stand-in tree with both citation conventions represented: a repo-root
// scripts/ directory, and a skill that carries its own scripts/ and references/.
const TREE = new Tree([
  "deno.jsonc",
  "docs/development/skill-audit.md",
  "packages/runner/src/cell.ts",
  "scripts/check-local-dev.sh",
  "skills/agent-browser/SKILL.md",
  "skills/agent-browser/scripts/form-automation.sh",
  "skills/lit-component/SKILL.md",
  "skills/lit-component/references/theme-system.md",
  // A symlinked directory: git records it as one entry, so nothing below it
  // appears in the tree. The real repo has 40-odd of these under .claude/skills
  // and .agents/skills.
  ".claude/skills/lit-component",
  // An ordinary file that sits where a directory once did.
  "docs/common/concepts/computed",
], [".claude/skills/lit-component"]);

Deno.test("Tree knows files, directories, and their ancestors", () => {
  assert(TREE.has("packages/runner/src/cell.ts"));
  assert(TREE.has("packages/runner/src"));
  assert(TREE.has("packages"));
  assert(TREE.isDir("packages/runner"));
  assertEquals(TREE.isDir("packages/runner/src/cell.ts"), false);
  assertEquals(TREE.has("packages/runner/src/nope.ts"), false);
});

Deno.test("Tree.has resolves a path below a symlinked directory", () => {
  // git cannot say what is under .claude/skills/lit-component, so a citation
  // through it must not be reported as missing when it reads fine on disk.

  assert(TREE.has(".claude/skills/lit-component/SKILL.md"));
  assert(TREE.has(".claude/skills/lit-component/references/theme-system.md"));
  // A sibling that is not below a symlink is still judged normally.
  assertEquals(TREE.has(".claude/skills/nonesuch/SKILL.md"), false);
});

Deno.test("Tree.has rejects a path below an ordinary file", () => {
  // The exception above is for symlinks only. Where a directory has since been
  // collapsed into a file, a citation that still points inside it is stale, and
  // git can say so — `docs/common/concepts/computed` is a file, not a symlink.

  assert(TREE.has("docs/common/concepts/computed"));
  assertEquals(TREE.has("docs/common/concepts/computed/computed.md"), false);
  assertEquals(TREE.has("packages/runner/src/cell.ts/nested.ts"), false);
});

Deno.test("Tree.filesMatching selects and sorts", () => {
  assertEquals(TREE.filesMatching(/^skills\/.*\.md$/), [
    "skills/agent-browser/SKILL.md",
    "skills/lit-component/SKILL.md",
    "skills/lit-component/references/theme-system.md",
  ]);
});

Deno.test("citedPath accepts a plain path", () => {
  assertEquals(
    citedPath("packages/runner/src/cell.ts"),
    "packages/runner/src/cell.ts",
  );
});

Deno.test("citedPath strips a leading ./ or /, a #fragment, and trailing slashes", () => {
  assertEquals(
    citedPath("./scripts/check-local-dev.sh"),
    "scripts/check-local-dev.sh",
  );
  // skills/README.md writes the skill mirrors this way.
  assertEquals(citedPath("/.claude/skills/"), ".claude/skills");
  assertEquals(
    citedPath("docs/common/COMPONENTS.md#identity-components"),
    "docs/common/COMPONENTS.md",
  );
  assertEquals(citedPath("docs/history/"), "docs/history");
});

Deno.test("citedPath rejects command lines", () => {
  // Skills backtick whole commands; the path inside one is not the citation.

  assertEquals(citedPath("./scripts/restart-local-dev.sh --force"), null);
  assertEquals(citedPath("deno run -A packages/cli/mod.ts"), null);
  assertEquals(citedPath("cat ~/code/labs/packages/patterns/index.md"), null);
});

Deno.test("citedPath rejects globs and stand-ins", () => {
  assertEquals(citedPath("packages/**"), null);
  assertEquals(citedPath("packages/ui/src/v2/components/cf-*/cf-*.ts"), null);
  assertEquals(
    citedPath("packages/ui/src/v2/components/cf-{name}/cf-{name}.figma.ts"),
    null,
  );
  assertEquals(citedPath("~/.cache/cf-inspect/<host>/"), null);
  assertEquals(citedPath("scripts/..."), null);
  assertEquals(citedPath("path/to/thing.ts"), null);
});

Deno.test("citedPath rejects tokens with no directory separator", () => {
  assertEquals(citedPath("SKILL.md"), null);
  assertEquals(citedPath("waitFor"), null);
});

Deno.test("citedPath rejects a token that is only slashes", () => {
  assertEquals(citedPath("/"), null);
});

Deno.test("isRooted accepts a repo-root directory", () => {
  assert(isRooted("packages/runner/src/cell.ts", "skills/cf-review", TREE));
  assert(isRooted("scripts/check-local-dev.sh", "skills/cf", TREE));
});

Deno.test("isRooted accepts a directory inside the citing skill", () => {
  assert(isRooted("references/theme-system.md", "skills/lit-component", TREE));
});

Deno.test("isRooted rejects prose, flags, specifiers, and mount paths", () => {
  // The conservative half of the heuristic: none of these start with a real
  // directory, so none are treated as repo paths.

  assertEquals(isRooted("async/await", "skills/cf-review", TREE), false);
  assertEquals(isRooted("-s/--space", "skills/cf", TREE), false);
  assertEquals(
    isRooted("lit/directives/class-map.js", "skills/lit-component", TREE),
    false,
  );
  assertEquals(
    isRooted("input/contacts.json", "skills/fuse-workflow", TREE),
    false,
  );
  assertEquals(isRooted("/interface", "skills/cf-review", TREE), false);
  // Ignored build output is not part of the tree, so it never roots a citation.
  assertEquals(isRooted("dist/cf", "skills/cf", TREE), false);
});

Deno.test("resolvesInTree accepts a repo-root-relative citation", () => {
  assert(resolvesInTree("scripts/check-local-dev.sh", "skills/cf", TREE));
});

Deno.test("resolvesInTree accepts a skill-relative citation", () => {
  // skills/agent-browser names scripts/form-automation.sh, which lives in the
  // skill, not in the repo-root scripts/ directory.

  assert(
    resolvesInTree("scripts/form-automation.sh", "skills/agent-browser", TREE),
  );
  assert(
    resolvesInTree("references/theme-system.md", "skills/lit-component", TREE),
  );
});

Deno.test("resolvesInTree rejects a path under neither base", () => {
  assertEquals(
    resolvesInTree("scripts/gone.sh", "skills/agent-browser", TREE),
    false,
  );
});

Deno.test("skillDirOf finds the skill a doc belongs to", () => {
  assertEquals(skillDirOf("skills/cf-review/SKILL.md"), "skills/cf-review");
  assertEquals(
    skillDirOf("skills/lit-component/references/theme-system.md"),
    "skills/lit-component",
  );
  assertEquals(skillDirOf("skills/README.md"), "skills");
});

const EXPORTS = new Map<string, unknown>([
  ["@commonfabric/ui", { ".": "./src/index.ts" }],
  ["@commonfabric/data-model", { "./value-hash": "./value-hash.ts" }],
  ["@commonfabric/runner", "./mod.ts"],
]);

Deno.test("collectDrift is silent on a doc whose citations all resolve", () => {
  const docs = [{
    path: "skills/agent-browser/SKILL.md",
    text: [
      "Run `scripts/form-automation.sh` to drive a form.",
      "The cell lives in `packages/runner/src/cell.ts`.",
      'Import from "@commonfabric/runner" and "@commonfabric/data-model/value-hash".',
    ].join("\n"),
  }];
  assertEquals(collectDrift(docs, TREE, EXPORTS), []);
});

Deno.test("collectDrift reports a vanished path with its line", () => {
  const docs = [{
    path: "skills/cf-review/SKILL.md",
    text: "Line one.\nThe helper is in `packages/runner/src/gone.ts`.\n",
  }];
  assertEquals(collectDrift(docs, TREE, EXPORTS), [{
    file: "skills/cf-review/SKILL.md",
    line: 2,
    message: "path does not exist: packages/runner/src/gone.ts",
  }]);
});

Deno.test("collectDrift reports a subpath specifier a package does not export", () => {
  const docs = [{
    path: "skills/lit-component/SKILL.md",
    text: "Components are exported from `@commonfabric/ui/v2`.\n",
  }];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assertEquals(drift[0].line, 1);
  assert(drift[0].message.includes('has no export "./v2"'));
});

Deno.test("collectDrift reports a bare specifier for a subpath-only package", () => {
  const docs = [{
    path: "skills/cf-review/SKILL.md",
    text: 'Hashing lives in "@commonfabric/data-model".\n',
  }];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assert(drift[0].message.includes("has no root export"));
});

Deno.test("collectDrift reports a package that left the workspace", () => {
  const docs = [{
    path: "skills/cf-review/SKILL.md",
    text: 'Import "@commonfabric/nonesuch".\n',
  }];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assert(drift[0].message.includes("package not in workspace"));
});

Deno.test("collectDrift resolves each doc against its own skill", () => {
  // The same token, cited by two skills, resolves for the one that carries the
  // script and fails for the one that does not.

  const docs = [
    {
      path: "skills/agent-browser/SKILL.md",
      text: "`scripts/form-automation.sh`\n",
    },
    { path: "skills/cf/SKILL.md", text: "`scripts/form-automation.sh`\n" },
  ];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assertEquals(drift[0].file, "skills/cf/SKILL.md");
});

Deno.test("collectDrift reports a package that declares no exports", () => {
  // A workspace member with no `exports` key: nothing resolves against it, not
  // even the root.

  const docs = [{
    path: "skills/cf-review/SKILL.md",
    text: 'Import "@commonfabric/bare".\n',
  }];
  const drift = collectDrift(
    docs,
    TREE,
    new Map<string, unknown>([["@commonfabric/bare", undefined]]),
  );
  assertEquals(drift.length, 1);
  assert(drift[0].message.includes("has no root export"));
});

//
// The entry point over temp git fixtures
//
// These drive the command over fixtures, so they cover the clean and drift
// paths without depending on the real tree.
//

Deno.test("main reports success and returns 0 on a clean repo", async () => {
  const root = await fixtureRepo(fixtureFiles(
    'Read `packages/ui/src/index.ts`, exported from "@commonfabric/ui".\n',
  ));
  try {
    let code = -1;
    const { out } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 0);
    assert(out.includes("Agent-facing facts OK (1 documents)"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main reports the drift and returns 1 on a stale citation", async () => {
  const root = await fixtureRepo(fixtureFiles(
    "Line one.\nRead `packages/ui/src/gone.ts`.\n",
  ));
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes("skills/demo/SKILL.md:2"));
    assert(err.includes("path does not exist: packages/ui/src/gone.ts"));
    // The report tells the author what to do about it.
    assert(err.includes("placeholder"));
    assert(err.includes("docs/development/skill-audit.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main reports an unresolvable specifier", async () => {
  const root = await fixtureRepo(fixtureFiles(
    'Import from "@commonfabric/ui/v2".\n',
  ));
  try {
    let code = -1;
    const { err } = await captureConsole(async () => {
      code = await main(root);
    });
    assertEquals(code, 1);
    assert(err.includes('has no export "./v2"'));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

//
// Reading the tree and the workspace exports
//
// The two readers on their own, over fixtures: what each drops, marks, and
// surfaces when the input is not what it expects.
//

Deno.test("readTree drops a file the working tree has lost", async () => {
  const root = await fixtureRepo(
    fixtureFiles("Read `packages/ui/src/index.ts`.\n"),
  );
  try {
    assert((await readTree(root)).has("packages/ui/src/index.ts"));
    // Moved aside without staging the deletion: git still holds it in the index,
    // but the citation should break now rather than when the deletion lands.
    await Deno.remove(join(root, "packages/ui/src/index.ts"));
    assertEquals((await readTree(root)).has("packages/ui/src/index.ts"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readTree marks a symlink so paths below it resolve", async () => {
  const root = await fixtureRepo(
    fixtureFiles("Read `packages/ui/src/index.ts`.\n"),
  );
  try {
    await Deno.symlink("../packages/ui", join(root, "skills/ui-link"));
    await git(root, ["add", "-A"]);
    const tree = await readTree(root);
    // git records the symlink as one entry and says nothing about what is under
    // it, so a path below it resolves; a path below an ordinary file does not.
    assert(tree.has("skills/ui-link/src/index.ts"));
    assertEquals(tree.has("packages/ui/deno.jsonc/nested.ts"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readTree surfaces a git failure", async () => {
  const root = await Deno.makeTempDir({ prefix: "check-skill-facts-nogit-" });
  try {
    await assertRejects(() => readTree(root), Error, "`git ls-files` failed");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readWorkspaceExports skips a member with no deno.jsonc", async () => {
  const root = await fixtureRepo({
    "deno.jsonc": '{ "workspace": ["./packages/ui", "./packages/ghost"] }',
    "packages/ui/deno.jsonc": '{ "name": "@commonfabric/ui" }',
    "packages/ghost/README.md": "no deno.jsonc here\n",
  });
  try {
    const exports = await readWorkspaceExports(root);
    assertEquals([...exports.keys()], ["@commonfabric/ui"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readWorkspaceExports rejects invalid JSONC", async () => {
  const root = await fixtureRepo({
    "deno.jsonc": '{ "workspace": ["./packages/ui"] }',
    "packages/ui/deno.jsonc": "{ this is not json",
  });
  try {
    await assertRejects(
      () => readWorkspaceExports(root),
      Error,
      "invalid JSONC in packages/ui/deno.jsonc",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readWorkspaceExports surfaces an unreadable member config", async () => {
  // A deno.jsonc that is a directory: not NotFound, so it is config breakage
  // rather than an absent member, and must not be skipped silently.

  const root = await fixtureRepo({
    "deno.jsonc": '{ "workspace": ["./packages/ui"] }',
    "packages/ui/deno.jsonc/placeholder": "",
  });
  try {
    await assertRejects(() => readWorkspaceExports(root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

//
// The real repository
//
// The two runs that read this tree rather than a fixture, which is what makes
// the gate answer for the repository as it stands.
//

/**
 * Runs the script as `deno task check-skill-facts` does. This is what exercises
 * the entry point, and the only thing that proves the permissions the shebang
 * and the task line grant are the ones the script needs — importing it can never
 * show that.
 *
 * The child gets a throwaway lockfile, since a nested Deno command does not
 * inherit the test runner's lock flags and resolving its imports must not write
 * to the real deno.lock.
 */
Deno.test("the script runs as a command over the real repo", async () => {
  const root = fromFileUrl(new URL("..", import.meta.url));
  const output = await runDenoCommandWithTemporaryLock({
    root,
    args: (lockPath) => [
      "run",
      "--config",
      join(root, "deno.jsonc"),
      "--lock",
      lockPath,
      // The permissions the shebang and the deno.jsonc task grant, and no more.
      "--allow-read",
      "--allow-run=git",
      join(root, "tasks/check-skill-facts.ts"),
    ],
  });
  const stderr = new TextDecoder().decode(output.stderr);
  assertEquals(output.code, 0, `check-skill-facts exited non-zero:\n${stderr}`);
  assert(
    new TextDecoder().decode(output.stdout).includes("Agent-facing facts OK"),
  );
});

Deno.test("every cited path and specifier resolves", async () => {
  // Runs against the real repository: every fact every covered document cites
  // must resolve.

  const root = fromFileUrl(new URL("..", import.meta.url));
  const tree = await readTree(root);
  const docs = await readSkillDocs(root, tree);
  assert(docs.length > 0, "found no covered files");
  const drift = collectDrift(docs, tree, await readWorkspaceExports(root));
  assertEquals(
    drift.map((d) => `${d.file}:${d.line} ${d.message}`),
    [],
    "A skill, an AGENTS.md, a rule, or a hook script cites a path or " +
      "specifier that no longer resolves. These are live documentation: fix " +
      "the document to name the current location.",
  );
});

//
// The four kinds of file the scan reaches
//
// They are named by different conventions,
// so each is pinned: a rename that drops one from the scan would otherwise be
// invisible.
//

Deno.test("the scan covers skills, AGENTS.md guides, rules, and hooks", async () => {
  const root = fromFileUrl(new URL("..", import.meta.url));
  const tree = await readTree(root);
  const paths = new Set((await readSkillDocs(root, tree)).map((d) => d.path));
  assert(paths.has("skills/README.md"), "skills/ not scanned");
  assert(paths.has("AGENTS.md"), "the root AGENTS.md is not scanned");
  assert(
    paths.has("packages/ts-transformers/AGENTS.md"),
    "a package AGENTS.md is not scanned",
  );
  assert(
    paths.has(".claude/rules/tests.md"),
    ".claude/rules/ is not scanned",
  );
  assert(
    paths.has(".claude/scripts/post-edit-ts.ts"),
    ".claude/scripts/ is not scanned",
  );
  // A CLAUDE.md is one `@AGENTS.md` import, with nothing backticked to check.
  assert(!paths.has("CLAUDE.md"), "CLAUDE.md should not be scanned");
});

Deno.test("a rule resolves its citations against the repo root", async () => {
  // A rule lives in .claude/rules/, which holds no code, so every path it names
  // is repo-relative. Both cases are pinned here because skillDirOf hands the
  // resolver ".claude/rules" as the doc's own directory.

  const root = await fixtureRepo({
    "deno.jsonc": '{ "workspace": [] }',
    "packages/ui/src/index.ts": "",
    ".claude/rules/demo.md": "Read `packages/ui/src/index.ts`.\n",
  });
  try {
    const tree = await readTree(root);
    const docs = await readSkillDocs(root, tree);
    assertEquals(docs.map((d) => d.path), [".claude/rules/demo.md"]);
    assertEquals(collectDrift(docs, tree, new Map()), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a package AGENTS.md resolves paths inside its own package", async () => {
  // packages/shell/AGENTS.md cites `shared/app/state.ts`, meaning the file in
  // that package. The same token cited by a package that has a `shared/` of its
  // own, without that file in it, is drift.

  const root = await fixtureRepo({
    "deno.jsonc": '{ "workspace": [] }',
    "packages/shell/shared/app/state.ts": "",
    "packages/shell/AGENTS.md": "State is `shared/app/state.ts`.\n",
    "packages/other/shared/mod.ts": "",
    "packages/other/AGENTS.md": "State is `shared/app/state.ts`.\n",
  });
  try {
    const tree = await readTree(root);
    const drift = collectDrift(
      await readSkillDocs(root, tree),
      tree,
      new Map(),
    );
    assertEquals(drift.map((d) => d.file), ["packages/other/AGENTS.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

//
// The conservative half of the heuristic
//

Deno.test("a relative citation with no matching directory is left alone", async () => {
  // The conservative half of the heuristic, which the widened scan leans on
  // more than the skills-only one did: a backticked token whose first segment
  // names no real directory is prose or a shell fragment, not a path, so it is
  // skipped rather than reported. Without this, every `src/index.ts` written as
  // an illustration would fail the build.

  const root = await fixtureRepo({
    "deno.jsonc": '{ "workspace": [] }',
    "packages/other/mod.ts": "",
    "packages/other/AGENTS.md": "Entry point is `src/index.ts`.\n",
  });
  try {
    const tree = await readTree(root);
    const docs = await readSkillDocs(root, tree);
    assertEquals(collectDrift(docs, tree, new Map()), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
