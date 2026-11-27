/**
 * Builds Git repositories on disk for the tests of the offcuts scan, which
 * fetches from them over `file:` URLs. Each command runs with the system and
 * global Git configuration left out, so the developer's own settings change
 * nothing.
 */

import { join } from "@std/path";

const ENCODER = new TextEncoder();

/** Runs Git in `directory`, and returns what it printed, trimmed. */
export async function git(directory: string, args: string[]): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: [
      "-C",
      directory,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).output();
  if (code !== 0) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout).trim();
}

/**
 * Makes a repository in `directory` whose branch `main` has no commits yet,
 * unless there is one there already.
 */
export async function makeRepository(directory: string): Promise<void> {
  await Deno.mkdir(directory, { recursive: true });
  await git(directory, ["init", "--quiet", "--initial-branch=main"]);
}

/**
 * Commits `files`, by path, to the `main` branch of the repository in
 * `directory`, making the repository first when there is none, and returns
 * the commit.
 */
export async function commitFiles(
  directory: string,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  await makeRepository(directory);
  for (const [path, content] of Object.entries(files)) {
    const file = join(directory, path);
    await Deno.mkdir(join(file, ".."), { recursive: true });
    await Deno.writeFile(
      file,
      typeof content === "string" ? ENCODER.encode(content) : content,
    );
  }
  await git(directory, ["add", "--all"]);
  await git(directory, ["commit", "--quiet", "--allow-empty", "-m", "commit"]);
  return await git(directory, ["rev-parse", "HEAD"]);
}
