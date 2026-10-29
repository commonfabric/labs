// Build metadata baked into the cf binary at compile time.
//
// `tasks/build-binaries.ts` writes `runtime/cli/COMPILED` and includes it in
// the binary via `deno compile --include`, mirroring the toolshed binary's
// marker. Compiled binaries report the commit they were built from; source
// runs (`bin/cf`, `deno task cf`) instead ask git for the HEAD of the
// checkout the running module actually lives in — which is what matters when
// multiple checkouts are involved. `Deno.build.standalone` is the
// discriminator: the marker file also exists on disk in a checkout while a
// binary build is in flight (or after an interrupted one), so its presence
// says nothing about how this invocation is running.

import { dirname, fromFileUrl, join } from "@std/path";

import {
  type BuildInfo,
  readBuildInfoFrom,
} from "@commonfabric/utils/build-info";

const COMPILED_PATH = new URL("../COMPILED", import.meta.url);

export const buildInfo: BuildInfo = Deno.build.standalone
  ? readBuildInfoFrom(COMPILED_PATH)
  : { commitSha: null, builtAt: null };

/**
 * HEAD of the labs checkout whose `runtime/cli/lib` directory is `dir`, or
 * null when that cannot be determined (git unavailable, no repository, no
 * run permission). Never throws.
 *
 * The toplevel guard matters for vendored layouts: a `<host>/vendor/labs`
 * tree with no git directory of its own would otherwise resolve to the HOST
 * repository's HEAD — an unrelated commit that would falsely mismatch every
 * labs server. Only a toplevel that actually contains the running module at
 * its expected location is trusted; anything else reports unknown.
 */
export async function gitShaForCliLibDir(dir: string): Promise<string | null> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD", "--show-toplevel"],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!success) return null;
    const [sha, toplevel] = new TextDecoder().decode(stdout).trim().split(
      "\n",
    );
    if (!sha || !toplevel) return null;
    const expected = Deno.realPathSync(
      join(toplevel, "runtime", "cli", "lib"),
    );
    if (expected !== Deno.realPathSync(dir)) return null;
    return sha;
  } catch {
    return null;
  }
}

/** What this cf invocation knows about its own version: its commit, and —
 * for source runs — the checkout directory whose git history can order that
 * commit against a server's (compiled binaries carry no history, so their
 * mismatches cannot be ordered). */
export interface CliVersion {
  sha: string | null;
  checkoutDir: string | null;
}

/**
 * The commit this cf invocation is running: the baked build marker for
 * compiled binaries, the checkout's HEAD for source runs, else null. A
 * compiled binary built without COMMIT_SHA stays unknown rather than
 * guessing from the build machine's checkout.
 */
export async function resolveCliVersion(): Promise<CliVersion> {
  if (Deno.build.standalone) {
    return { sha: buildInfo.commitSha, checkoutDir: null };
  }
  if (!import.meta.url.startsWith("file://")) {
    return { sha: null, checkoutDir: null };
  }
  const dir = dirname(fromFileUrl(import.meta.url));
  const sha = await gitShaForCliLibDir(dir);
  return { sha, checkoutDir: sha === null ? null : dir };
}

/** One attribution snapshot shared by this process's runtime connections. */
let clientGitSha: Promise<string | null> | undefined;

/**
 * Captures the build SHA on first use and shares it across later runtime opens.
 * Source runs sample HEAD at that first call, which can be after code loads.
 * Later commits leave this snapshot unchanged; uncommitted edits are omitted.
 */
export function resolveCliGitSha(): Promise<string | null> {
  return clientGitSha ??= resolveCliVersion().then(({ sha }) => sha);
}

/** How two differing commits relate in a checkout's history. `cli-ahead` and
 * `cli-behind` are proven by ancestry; `diverged` means both commits are
 * known but neither contains the other; `unknown` means the history cannot
 * order them (server commit never fetched, shallow clone, git failure). */
export type ShaRelation =
  | { kind: "cli-ahead"; serverBehindBy: number | null }
  | { kind: "cli-behind" }
  | { kind: "diverged" }
  | { kind: "unknown" };

/** git merge-base --is-ancestor: true/false when git can answer, null when
 * it cannot (unknown commit, no repository, no run permission). */
async function isAncestor(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  try {
    const { code } = await new Deno.Command("git", {
      args: ["merge-base", "--is-ancestor", ancestor, descendant],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    if (code === 0) return true;
    if (code === 1) return false;
    return null;
  } catch {
    return null;
  }
}

/** Commits reachable from `descendant` but not `ancestor`, or null when git
 * cannot count them. */
async function countBehind(
  dir: string,
  ancestor: string,
  descendant: string,
): Promise<number | null> {
  try {
    const { success, stdout } = await new Deno.Command("git", {
      args: ["rev-list", "--count", `${ancestor}..${descendant}`],
      cwd: dir,
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!success) return null;
    const count = Number(new TextDecoder().decode(stdout).trim());
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/** Whether the visible graph proves a common base for two commits. False
 * ancestry probes alone cannot distinguish true siblings from a history
 * whose connecting commits were never fetched (shallow clones, disjoint
 * shallow roots) — only a successful merge-base does. */
async function haveCommonBase(
  dir: string,
  a: string,
  b: string,
): Promise<boolean> {
  try {
    const { code } = await new Deno.Command("git", {
      args: ["merge-base", a, b],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    }).output();
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Order a (cf, server) commit pair using `dir`'s git history. Only called on
 * a proven mismatch, so at most a handful of local git invocations, and only
 * for source runs — the callers of a compiled binary pass no checkout and
 * get `unknown`. `diverged` is only reported when the graph proves a common
 * base; an unprovable pair degrades to `unknown` rather than asserting a
 * divergence the history cannot show.
 */
export async function relateShasIn(
  dir: string,
  cliSha: string,
  serverSha: string,
): Promise<ShaRelation> {
  const serverIsAncestor = await isAncestor(dir, serverSha, cliSha);
  if (serverIsAncestor === null) return { kind: "unknown" };
  if (serverIsAncestor) {
    return {
      kind: "cli-ahead",
      serverBehindBy: await countBehind(dir, serverSha, cliSha),
    };
  }
  const cliIsAncestor = await isAncestor(dir, cliSha, serverSha);
  if (cliIsAncestor === null) return { kind: "unknown" };
  if (cliIsAncestor) return { kind: "cli-behind" };
  return await haveCommonBase(dir, cliSha, serverSha)
    ? { kind: "diverged" }
    : { kind: "unknown" };
}
