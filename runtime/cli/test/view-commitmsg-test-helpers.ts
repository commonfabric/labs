import { assert } from "@std/assert";

export const SHOW = [
  "commit 0123456789abcdef0123456789abcdef01234567",
  "Author: A B <a@b.example>",
  "Date:   Wed Jul 1 12:00:00 2026 -0700",
  "",
  "    Subject line",
  "    ",
  "    Body paragraph.",
  "",
  "diff --git a/f b/f",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n").split("\n");

export async function git(
  root: string,
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
): Promise<string> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: root,
    env,
    stdin: stdin !== undefined ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  const p = cmd.spawn();
  if (stdin !== undefined) {
    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const o = await p.output();
  return new TextDecoder().decode(o.stdout);
}

export async function installHook(
  root: string,
  name: string,
  script: string,
) {
  const path = `${root}/.git/hooks/${name}`;
  await Deno.writeTextFile(path, `#!/bin/sh\n${script}\n`);
  await Deno.chmod(path, 0o755);
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export async function initReftable(root: string): Promise<boolean> {
  const initialized = await new Deno.Command("git", {
    args: ["init", "-q", "--ref-format=reftable"],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).output();
  return initialized.success;
}

/** Whether this machine's Git can create a repository with reftable ref
 * storage. */
export async function supportsReftable(): Promise<boolean> {
  const root = await Deno.makeTempDir();
  try {
    return await initReftable(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

export async function withGitShim<T>(
  body: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  const lookup = await new Deno.Command("which", {
    args: ["git"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(lookup.success, "the real Git executable is available");
  const realGitPath = new TextDecoder().decode(lookup.stdout).trim();
  const shimDir = await Deno.makeTempDir();
  const shim = `${shimDir}/git`;
  await Deno.writeTextFile(
    shim,
    `#!/bin/sh
${body}
exec ${shellQuote(realGitPath)} "$@"
`,
  );
  await Deno.chmod(shim, 0o755);
  const originalPath = Deno.env.get("PATH");
  Deno.env.set("PATH", `${shimDir}:${originalPath ?? ""}`);
  try {
    return await callback();
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(shimDir, { recursive: true });
  }
}

/** Initialize a repository at `root` on branch `main` whose one commit holds
 * `f.txt`. Returns false when Git cannot create the requested ref storage. */
export async function initRepository(
  root: string,
  storage: "files" | "reftable" = "files",
): Promise<boolean> {
  if (storage === "reftable") {
    if (!await initReftable(root)) return false;
  } else {
    await git(root, ["init", "-q"]);
  }
  await git(root, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["config", "user.email", "t@t.test"]);
  await git(root, ["config", "user.name", "Test"]);
  await Deno.writeTextFile(`${root}/f.txt`, "one\ntwo\nthree\n");
  await git(root, ["add", "f.txt"]);
  await git(root, ["commit", "-q", "-m", "original"]);
  return true;
}

/** The object id `name` resolves to in the repository at `root`. */
export async function revParse(root: string, name: string): Promise<string> {
  return (await git(root, ["rev-parse", name])).trim();
}

/** A new commit on top of HEAD that no ref names. */
export async function unreferencedCommit(root: string): Promise<string> {
  return (await git(root, [
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "other",
  ])).trim();
}
