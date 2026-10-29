import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { realWorkspace } from "../lib/view/diffdoc.ts";

//
// realWorkspace.resolve: the file-vs-directory check
//
// resolve() walks each base and, for a candidate that bounded() accepts, checks
// Deno.statSync(abs).isFile. bounded() already canonicalized abs through
// realPathSync, so the stat resolves; the separate try/catch it once carried was
// removed (read() guards the file contents). These tests pin resolve()'s data
// paths — a bounded regular file, a directory, an out-of-bounds path — the ones
// a real `cf view` invocation drives.
//

Deno.test("realWorkspace.resolve: a bounded regular file resolves to its absolute path", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.writeTextFileSync(join(root, "m.ts"), "export const a = 1;\n");
    const ws = realWorkspace(root);
    // statSync(abs).isFile is true, so resolve returns on the first base before
    // the catch is ever consulted.
    const resolved = ws.resolve("m.ts");
    assert(resolved?.endsWith("m.ts"), `resolved a real file: ${resolved}`);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realWorkspace.resolve: a symlink to a bounded file resolves through realpath", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.writeTextFileSync(join(root, "target.ts"), "export const a = 1;\n");
    // A symlink whose target is inside the repo: bounded() follows it via
    // realPathSync, and statSync follows it to the same regular file, so resolve
    // returns the symlink's own path. The two syscalls agree — exactly why the
    // catch cannot fire for a stable filesystem.
    Deno.symlinkSync(join(root, "target.ts"), join(root, "link.ts"));
    const ws = realWorkspace(root);
    const resolved = ws.resolve("link.ts");
    assert(resolved?.endsWith("link.ts"), `resolved a symlink: ${resolved}`);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realWorkspace.resolve: a directory is bounded but not a file, so resolve falls through", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.mkdirSync(join(root, "adir"));
    const ws = realWorkspace(root);
    // statSync succeeds on a directory and isFile is false, so the if-body never
    // returns and the catch never runs; resolve falls through every base to
    // null. This is the closest reachable neighbor of the catch: statSync
    // returns rather than throws.
    assertEquals(ws.resolve("adir"), null, "a directory is not a file");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realWorkspace.resolve: an absent bounded path is filtered before statSync", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    const ws = realWorkspace(root);
    // The obvious way to make statSync throw is a missing file — but a missing
    // file fails bounded() first (its realPathSync throws ENOENT), so the loop
    // `continue`s before the try. resolve returns null without ever reaching the
    // catch, which is precisely why the catch is race-only.
    assertEquals(
      ws.resolve("missing.ts"),
      null,
      "absent path resolves to null",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realWorkspace.resolve: an absolute diff path resolves to null before the loop", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    Deno.writeTextFileSync(join(root, "m.ts"), "export const a = 1;\n");
    const ws = realWorkspace(root);
    // isAbsolute short-circuits to null without entering the base loop at all.
    assertEquals(
      ws.resolve(join(root, "m.ts")),
      null,
      "absolute paths are rejected up front",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realWorkspace.resolve: a `..` escape above the workspace is blocked", () => {
  const root = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(root, ".git"));
    const ws = realWorkspace(root);
    // The joined candidate is outside the bound, so bounded() returns false and
    // the loop skips it; resolve returns null. statSync is never reached for an
    // out-of-bounds candidate either.
    assertEquals(
      ws.resolve("../../../etc/hosts"),
      null,
      "a traversal above the workspace resolves to null",
    );
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("realWorkspace.resolve: with a repo root above cwd, the second base resolves a file", () => {
  const repo = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(join(repo, ".git"));
    // A nested invocation directory under the repo root. git emits repo-relative
    // paths, so `bases` is [repoRoot, cwd]; resolve tries the repo root first,
    // then the cwd. A file that only exists relative to the cwd is found on the
    // second base — exercising the multi-base loop the catch's comment ("try the
    // next base") refers to.
    const cwd = join(repo, "runtime", "cli");
    Deno.mkdirSync(cwd, { recursive: true });
    Deno.writeTextFileSync(join(cwd, "only-here.ts"), "export const a = 1;\n");
    const ws = realWorkspace(cwd);
    const resolved = ws.resolve("only-here.ts");
    assert(
      resolved?.endsWith(join("runtime", "cli", "only-here.ts")),
      `resolved on the cwd base: ${resolved}`,
    );
    // A file that exists at the repo root resolves on the first base.
    Deno.writeTextFileSync(join(repo, "at-root.ts"), "export const b = 2;\n");
    const atRoot = ws.resolve("at-root.ts");
    assert(
      atRoot?.endsWith("at-root.ts") &&
        !atRoot.includes(join("runtime", "cli")),
      `resolved on the repo-root base: ${atRoot}`,
    );
  } finally {
    Deno.removeSync(repo, { recursive: true });
  }
});
