/**
 * Watches every repository of the organization for references into the
 * offcuts organization, where code that is no longer part of the product goes.
 * Nothing the product runs may come from there, so a repository whose default
 * branch names a repository of the offcuts organization in any file is failing,
 * whatever its own continuous integration says. The scan runs here rather than
 * in each repository's workflows, so no change to a repository can turn it off.
 *
 * A reference is either a path into the offcuts organization, as in a URL, a
 * Git remote, an Actions `uses:` line, or an npm `owner/name` dependency, or a
 * path to a repository of this organization under the name of a repository
 * that is now in the offcuts organization and not in this one, or under a name
 * `repository-names.ts` says it had before it was renamed. GitHub redirects
 * such a path to the repository wherever it went, so it fetches from the
 * offcuts organization all the same. The scan sees only the repositories of
 * the offcuts organization its credential can see, which is all of them when
 * they are public. Lockfiles are scanned like every other file, so a
 * dependency reached through another package is found once its lockfile names
 * it.
 *
 * Each repository is kept as a shallow bare Git repository in the dashboard's
 * cache directory, holding the commit its default branch, its `HEAD`, is at. It
 * is fetched again when the GitHub webhook relay delivers a push to that
 * branch, and then every OFFCUTS_CATCH_UP_MS at most, for
 * OFFCUTS_CATCH_UP_FOR_MS, until it has read the commit the push named; once
 * its last scan is OFFCUTS_SWEEP_MS old; and OFFCUTS_RETRY_MS after a scan that
 * failed. A fetch reads only what changed since the last one.
 */

import { dirname, join } from "@std/path";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import type { GitHubCredential } from "./github-auth.ts";
import { type Job, shortName } from "./ci-jobs-page.ts";
import { type GitHubWebhooks, pushOf } from "./github-webhooks.ts";
import { CacheFile, dashboardCacheFile } from "./history-files.ts";
import {
  friendlyError,
  GITHUB_ORGANIZATION,
  GitHubAnswers,
  type GitHubRequestOptions,
} from "./lib.ts";
import { repositoryNames } from "./organization-repos.ts";
import { formerRepoNames } from "./repository-names.ts";

/** The organization nothing in the product may reference. */
export const OFFCUTS_ORGANIZATION = "commonfabric-offcuts";

/** The name of the ci tile's job for each repository's scan. */
export const OFFCUTS_JOB = "offcuts references";

/**
 * How long a repository's scan stands before it is scanned again, which bounds
 * how long a push the GitHub webhook relay did not deliver goes unscanned.
 */
export const OFFCUTS_SWEEP_MS = 4 * 3_600_000;

/** How long after a scan of a repository fails it is scanned again. */
export const OFFCUTS_RETRY_MS = 300_000;

/**
 * How long after a delivered push a repository is scanned again while no scan
 * has read the commit the push named.
 */
export const OFFCUTS_CATCH_UP_FOR_MS = 300_000;

/**
 * How long apart those scans are, at least: less than the ci tile's interval
 * between collections, so that each collection can start one.
 */
export const OFFCUTS_CATCH_UP_MS = 15_000;

/** The branch each local repository holds the scanned commit on. */
const SCANNED = "refs/heads/scanned";

// The characters of a GitHub repository name, as a bracket expression's body.
// The hyphen is last so that it stands for itself.
const NAME_CHARACTERS = "A-Za-z0-9_.-";

/** A repository to scan. */
export interface ScanTarget {
  /** The repository, as "owner/name". */
  readonly repo: string;
}

/** A line that references the offcuts organization. */
interface OffcutsReference {
  /** The file, relative to the repository's root. */
  readonly path: string;

  /** The line the reference is on, counting from 1. */
  readonly line: number;
}

/** What the latest scan of one repository found. */
interface Scan {
  /**
   * The commit scanned, or `undefined` for a default branch with no commits.
   */
  readonly commit: string | undefined;

  /** Every line in it that references the offcuts organization. */
  readonly references: readonly OffcutsReference[];

  /** When the scan started, and how long it took, in milliseconds. */
  readonly at: number;
  readonly ms: number;

  /**
   * When the earliest scan of the run of scans that found references up to
   * this one started, or `undefined` when this one found none.
   */
  readonly failingSince: number | undefined;
}

/** What is known of one repository. */
interface Standing {
  /** The latest scan that succeeded. */
  readonly scan: Scan | undefined;

  /** Why the latest scan failed, when it did. */
  readonly error: string | undefined;

  /** When the latest scan started. */
  readonly attemptedAt: number;
}

/** How an `OffcutsScan` reaches the repositories it scans. */
export interface OffcutsScanOptions {
  /** Where deliveries of pushes come from. */
  readonly webhooks: GitHubWebhooks;

  /**
   * The directory the local repositories are kept in. `offcuts-scan` in the
   * dashboard's cache directory when not given.
   */
  readonly directory?: string;

  /** The address to fetch `repo` from. GitHub's by default. */
  readonly remote?: (repo: string) => string;

  /**
   * The names of an organization's repositories, archived ones included.
   * GitHub's listing by default.
   */
  readonly repositoryNames?: (
    organization: string,
    credential: GitHubCredential,
    options: GitHubRequestOptions,
  ) => Promise<string[]>;
}

/** The scans of every repository, and the ci tile's rows for them. */
export class OffcutsScan {
  #webhooks: GitHubWebhooks;
  #directory: string;
  #remote: (repo: string) => string;
  #repositoryNames: (
    organization: string,
    credential: GitHubCredential,
    options: GitHubRequestOptions,
  ) => Promise<string[]>;
  #failingSince: CacheFile<Record<string, number>>;
  #answers = new GitHubAnswers();
  #standings = new Map<string, Standing>();
  #wanted = new Set<string>();
  #pushed = new Map<string, { commit: string; at: number }>();
  #offcuts: readonly string[] | undefined;
  #pass: Promise<void> | undefined;
  #next:
    | {
      targets: readonly ScanTarget[];
      credential: GitHubCredential;
      scanned: () => void;
    }
    | undefined;

  /** Constructs an instance which reaches GitHub as `options` says. */
  constructor(options: OffcutsScanOptions) {
    this.#webhooks = options.webhooks;
    this.#directory = options.directory ?? dashboardCacheFile("offcuts-scan");
    this.#failingSince = new CacheFile(
      join(this.#directory, "failing-since.json"),
    );
    this.#remote = options.remote ??
      ((repo) => `https://github.com/${repo}.git`);
    this.#repositoryNames = options.repositoryNames ?? repositoryNames;
    options.webhooks.listen((delivery) => {
      const push = pushOf(delivery);
      if (
        push === undefined || push.ref !== `refs/heads/${push.defaultBranch}`
      ) return;
      const key = push.repo.toLowerCase();
      this.#wanted.add(key);
      if (!/^0+$/.test(push.after)) {
        this.#pushed.set(key, { commit: push.after, at: Date.now() });
      }
      this.#start(false);
    });
  }

  /**
   * Scans each of `targets` that is due, unless a scan is already under way,
   * calling `scanned` once the scans end if any row changed. A repository is
   * due when it has not been scanned; when a push to its default branch has
   * been delivered since its last scan; when the latest such push was delivered
   * less than OFFCUTS_CATCH_UP_FOR_MS ago, no scan has yet read the commit it
   * named, and the last scan is OFFCUTS_CATCH_UP_MS old; when its last scan is
   * OFFCUTS_SWEEP_MS old; or when its last scan failed and is OFFCUTS_RETRY_MS
   * old. Once any is due, the offcuts organization's repositories are listed,
   * and every repository is scanned when they have changed. A later push starts
   * a scan with the latest of these arguments.
   */
  scan(
    targets: readonly ScanTarget[],
    credential: GitHubCredential,
    scanned: () => void,
  ): void {
    this.#next = { targets, credential, scanned };
    this.#start(true);
  }

  /** Resolves once the scan under way, if any, has ended. */
  scanning(): Promise<void> {
    return this.#pass ?? Promise.resolve();
  }

  /**
   * One row for each of `targets`: red when its default branch references
   * the offcuts organization, dated from the first scan that found the
   * references; orange when it could not be scanned; gray until its first
   * scan; and green otherwise. A failed scan leaves a found reference red.
   */
  jobs(targets: readonly ScanTarget[]): Job[] {
    return targets.map(({ repo }) => {
      const standing = this.#standings.get(repo.toLowerCase());
      const scan = standing?.scan;
      const row = {
        repo: shortName(repo),
        workflow: OFFCUTS_JOB,
        path: "",
        pinned: false,
        startedAt: scan?.at,
        ranMs: scan?.ms,
        href: scan?.commit === undefined
          ? `https://github.com/${repo}`
          : `https://github.com/${repo}/tree/${scan.commit}`,
      };
      if (scan !== undefined && scan.references.length > 0) {
        const [first] = scan.references;
        const count = scan.references.length;
        return {
          ...row,
          status: "bad",
          failing: true,
          result: `${count} reference${count === 1 ? "" : "s"}`,
          startedAt: scan.failingSince,
          href: `https://github.com/${repo}/blob/${scan.commit}/${
            first.path.split("/").map(encodeURIComponent).join("/")
          }#L${first.line}`,
        };
      }
      if (standing?.error !== undefined) {
        return {
          ...row,
          status: "warn",
          failing: false,
          result: friendlyError(standing.error),
        };
      }
      return scan === undefined
        ? {
          ...row,
          status: "unknown",
          failing: false,
          result: "not scanned yet",
        }
        : { ...row, status: "good", failing: false, result: "none" };
    });
  }

  /**
   * Starts a scan when one is due. With `catchUp`, a repository no scan of
   * which has read the commit the latest push delivered for it named, as GitHub
   * can show the commit before it for a moment, is due as well, once its last
   * scan is OFFCUTS_CATCH_UP_MS old, for OFFCUTS_CATCH_UP_FOR_MS after the
   * push. `scan()` passes `catchUp`, and a delivery and the end of a scan do
   * not, so a scan that catches up waits for the next collection.
   */
  #start(catchUp: boolean): void {
    const next = this.#next;
    if (this.#pass !== undefined || next === undefined) return;
    const wanted = this.#wanted;
    const now = Date.now();
    const due = next.targets.filter(({ repo }) => {
      const key = repo.toLowerCase();
      const standing = this.#standings.get(key);
      if (wanted.has(key) || standing === undefined) return true;
      const pushed = this.#pushed.get(key);
      const age = now - standing.attemptedAt;
      return standing.error !== undefined
        ? age >= OFFCUTS_RETRY_MS
        : age >= OFFCUTS_SWEEP_MS ||
          catchUp && pushed !== undefined &&
            now - pushed.at < OFFCUTS_CATCH_UP_FOR_MS &&
            age >= OFFCUTS_CATCH_UP_MS;
    });
    if (due.length === 0) return;
    this.#wanted = new Set();
    this.#pass = this.#scanDue(next.targets, due, next.credential).then(
      (altered) => {
        this.#pass = undefined;
        this.#start(false);
        if (!altered) return;
        try {
          next.scanned();
        } catch (error) {
          console.error(
            "offcuts: telling the tile about a scan failed:",
            describeFailure(error),
          );
        }
      },
    );
  }

  /**
   * Helper for `#start()`, which lists the offcuts organization's repositories
   * and scans `due`, or every one of `targets` when those repositories have
   * changed, one at a time. A failure to list them, or to use the directory,
   * fails every scan not yet made. Holds the lock on the record of when each
   * failing repository started failing throughout, so that two processes
   * sharing the directory never fetch into one repository at once. Returns
   * whether any repository's row changed.
   */
  async #scanDue(
    targets: readonly ScanTarget[],
    due: readonly ScanTarget[],
    credential: GitHubCredential,
  ): Promise<boolean> {
    let problem: string | undefined;
    let offcuts: string[] = [];
    try {
      const options = { answers: this.#answers };
      const [theirs, ours] = await Promise.all([
        this.#repositoryNames(OFFCUTS_ORGANIZATION, credential, options),
        this.#repositoryNames(GITHUB_ORGANIZATION.name, credential, options),
      ]);
      const mine = new Set(ours.map((name) => name.toLowerCase()));
      offcuts = [
        ...new Set(theirs.flatMap((name) => [
          name,
          ...formerRepoNames(`${GITHUB_ORGANIZATION.name}/${name}`)
            .map(shortName),
        ])),
      ].filter((name) => !mine.has(name.toLowerCase())).sort();
    } catch (error) {
      problem = `could not list the repositories of ${OFFCUTS_ORGANIZATION} ` +
        `and ${GITHUB_ORGANIZATION.name}: ${describeFailure(error)}`;
      console.error(`offcuts: ${problem}`);
    }
    const changed = problem === undefined &&
      offcuts.join("\n") !== this.#offcuts?.join("\n");
    if (changed) this.#offcuts = offcuts;
    const toScan = changed ? targets : due;
    const done = new Set<string>();
    let altered = false;
    const record = (target: ScanTarget, standing: Standing) => {
      const key = target.repo.toLowerCase();
      altered ||= shown(this.#standings.get(key)) !== shown(standing);
      this.#standings.set(key, standing);
      done.add(key);
    };
    const fail = (target: ScanTarget, attemptedAt: number, error: string) => {
      record(target, {
        scan: this.#standings.get(target.repo.toLowerCase())?.scan,
        error,
        attemptedAt,
      });
    };
    try {
      await privateDirectory(this.#directory);
      await this.#failingSince.locked(async () => {
        let held: Record<string, number> | undefined;
        try {
          held = await this.#failingSince.read(decodeFailingSince);
        } catch (error) {
          console.error(
            "offcuts: starting a new record of failing repositories:",
            describeFailure(error),
          );
        }
        const since = new Map(Object.entries(held ?? {}));
        if (changed) await this.#forgetAllBut(targets, since);
        for (const target of toScan) {
          const key = target.repo.toLowerCase();
          const attemptedAt = Date.now();
          if (problem !== undefined) {
            fail(target, attemptedAt, problem);
            continue;
          }
          try {
            const scan = await this.#scanOne(target, credential, offcuts);
            if (scan.references.length === 0) since.delete(key);
            else since.set(key, since.get(key) ?? attemptedAt);
            if (scan.commit === this.#pushed.get(key)?.commit) {
              this.#pushed.delete(key);
            }
            record(target, {
              scan: { ...scan, failingSince: since.get(key) },
              error: undefined,
              attemptedAt,
            });
          } catch (error) {
            const message = describeFailure(error);
            console.error(`offcuts: could not scan ${target.repo}:`, message);
            fail(target, attemptedAt, message);
          }
        }
        await this.#failingSince.write(
          JSON.stringify(Object.fromEntries(since)),
        );
      });
    } catch (error) {
      const message = describeFailure(error);
      console.error(`offcuts: could not use ${this.#directory}:`, message);
      for (const target of toScan) {
        if (!done.has(target.repo.toLowerCase())) {
          fail(target, Date.now(), message);
        }
      }
    }
    return altered;
  }

  /**
   * Helper for `#scanDue()`, which fetches the commit `target`'s default
   * branch is at, unless the copy holds it already, and searches it for
   * references. A repository whose default branch has no commits holds none.
   * A failure after the copy was touched removes the copy, which the failed
   * or interrupted command may have left locked or half written, so that it is
   * fetched afresh next time.
   */
  async #scanOne(
    { repo }: ScanTarget,
    credential: GitHubCredential,
    offcuts: readonly string[],
  ): Promise<Omit<Scan, "failingSince">> {
    const at = Date.now();
    const local = join(this.#directory, `${repo.toLowerCase()}.git`);
    const env = gitEnvironment(await credential.token(), this.#directory);
    const remote = this.#remote(repo);
    // `HEAD` names the default branch whatever it is called, and `ls-remote`
    // lists nothing for it when it has no commits.
    const head =
      (await git(env, this.#directory, ["ls-remote", remote, "HEAD"])).split(
        "\n",
      ).map((line) => line.split("\t"))
        .find(([, ref]) => ref === "HEAD")?.[0];
    if (head === undefined) {
      return { commit: undefined, references: [], at, ms: Date.now() - at };
    }
    await Deno.mkdir(local, { recursive: true });
    try {
      await git(env, local, ["init", "--quiet", "--bare"]);
      const held = (await git(
        env,
        local,
        ["rev-parse", "--verify", "--quiet", `${SCANNED}^{commit}`],
        [0, 1],
      )).trim();
      if (held !== head) {
        await git(env, local, [
          "fetch",
          "--quiet",
          "--depth=1",
          "--no-tags",
          remote,
          `+HEAD:${SCANNED}`,
        ]);
      }
      const commit = (await git(env, local, [
        "rev-parse",
        "--verify",
        `${SCANNED}^{commit}`,
      ])).trim();
      const grep = await git(
        env,
        local,
        [
          "grep",
          // Binary files are searched as text, and only the matching text is
          // printed, so a long line costs nothing.
          "--text",
          "--only-matching",
          "--line-number",
          "--ignore-case",
          "--null",
          "--extended-regexp",
          ...referencePatterns(offcuts).flatMap((pattern) => ["-e", pattern]),
          SCANNED,
          "--",
        ],
        [0, 1],
      );
      return {
        commit,
        references: parseGrep(grep),
        at,
        ms: Date.now() - at,
      };
    } catch (error) {
      await Deno.remove(local, { recursive: true }).catch((removal) =>
        console.error(
          `offcuts: could not remove ${local}:`,
          describeFailure(removal),
        )
      );
      throw error;
    }
  }

  /**
   * Helper for `#scanDue()`, which forgets, and removes the copy of, every
   * repository not among `targets`.
   */
  async #forgetAllBut(
    targets: readonly ScanTarget[],
    since: Map<string, number>,
  ): Promise<void> {
    const kept = new Set(targets.map(({ repo }) => repo.toLowerCase()));
    for (const held of [since, this.#standings, this.#pushed]) {
      for (const key of held.keys()) {
        if (!kept.has(key)) held.delete(key);
      }
    }
    const copies: string[] = [];
    for await (const owner of Deno.readDir(this.#directory)) {
      if (!owner.isDirectory) continue;
      const directory = join(this.#directory, owner.name);
      for await (const copy of Deno.readDir(directory)) {
        if (!kept.has(`${owner.name}/${copy.name.replace(/\.git$/, "")}`)) {
          copies.push(join(directory, copy.name));
        }
      }
    }
    for (const copy of copies) {
      await Deno.remove(copy, { recursive: true }).catch((error) =>
        console.error(
          `offcuts: could not remove ${copy}:`,
          describeFailure(error),
        )
      );
    }
  }
}

/**
 * The environment Git runs in for a scan of a copy kept in `directory`: no
 * prompts; no configuration of the system's, the user's, or a repository's
 * that `directory` sits in; `token` sent to GitHub and nowhere else without
 * appearing on a command line; one thread for unpacking a fetch; and
 * automatic garbage collection that runs within the command that starts it
 * and, once it runs, removes every unreachable object, which is what each
 * fetch leaves of the commit before it.
 */
export function gitEnvironment(
  token: string,
  directory: string,
): Record<string, string> {
  const config: [string, string][] = [
    [
      "http.https://github.com/.extraHeader",
      `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
    ],
    ["pack.threads", "1"],
    ["gc.autoDetach", "false"],
    ["gc.pruneExpire", "now"],
  ];
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: dirname(directory),
    GIT_CONFIG_COUNT: String(config.length),
    ...Object.fromEntries(config.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${index}`, key],
      [`GIT_CONFIG_VALUE_${index}`, value],
    ])),
  };
}

/**
 * The extended regular expressions a line referencing the offcuts
 * organization matches: a path to a repository of the organization, and a
 * path under this organization's name to each of `offcuts`, the names of the
 * offcuts organization's repositories. A name is matched whole, so a longer name
 * beginning with it, or a scoped package such as `@org/name`, does not match.
 */
function referencePatterns(offcuts: readonly string[]): string[] {
  const end = `(\\.wiki)?(\\.git)?` +
    `([^${NAME_CHARACTERS}]|\\.([^${NAME_CHARACTERS}]|$)|$)`;
  return [
    `(^|[^${NAME_CHARACTERS}])${OFFCUTS_ORGANIZATION}/[${NAME_CHARACTERS}]`,
    ...offcuts.map((name) =>
      `(^|[^@${NAME_CHARACTERS}])${GITHUB_ORGANIZATION.name}/` +
      `${name.replaceAll(".", "\\.")}${end}`
    ),
  ];
}

/**
 * Reads the references out of what `git grep --only-matching --line-number
 * --null` printed for the tree of SCANNED: for each match, the tree's name and
 * the path joined by a colon, a NUL, the line number, a NUL, and the matching
 * text, which holds no newline, and then a newline. A path may hold a newline
 * of its own. Each line is read once, however many matches it holds. Throws on
 * output of any other shape.
 */
function parseGrep(output: string): OffcutsReference[] {
  const prefix = `${SCANNED}:`;
  const references: OffcutsReference[] = [];
  for (let at = 0; at < output.length;) {
    const pathEnd = output.indexOf("\0", at);
    const lineEnd = output.indexOf("\0", pathEnd + 1);
    const matchEnd = output.indexOf("\n", lineEnd + 1);
    const line = Number(output.slice(pathEnd + 1, lineEnd));
    if (
      pathEnd < 0 || lineEnd < 0 || matchEnd < 0 ||
      !output.startsWith(prefix, at) || !Number.isSafeInteger(line)
    ) {
      throw new Error(
        `Unexpected \`git grep\` output: ${JSON.stringify(output.slice(at))}`,
      );
    }
    const path = output.slice(at + prefix.length, pathEnd);
    const last = references.at(-1);
    if (last?.path !== path || last.line !== line) {
      references.push({ path, line });
    }
    at = matchEnd + 1;
  }
  return references;
}

/**
 * `parseGrep`, for tests of output that `git grep` does not print and so a
 * scan cannot produce.
 */
export const parseGrepForTest = parseGrep;

/**
 * Runs Git with `env`, in `directory`, with `args`, the first of which names
 * the command, and returns what it printed. Throws, with what it printed as
 * errors, when it exits with a status not in `ok`.
 */
async function git(
  env: Record<string, string>,
  directory: string,
  args: readonly string[],
  ok: readonly number[] = [0],
): Promise<string> {
  const { code, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", directory, ...args],
    // Git is given what it needs of the dashboard's environment, and none of
    // its credentials.
    clearEnv: true,
    env: {
      ...Object.fromEntries(
        ["PATH", "HOME", "SSL_CERT_FILE", "SSL_CERT_DIR"].flatMap((key) => {
          const value = Deno.env.get(key);
          return value === undefined ? [] : [[key, value]];
        }),
      ),
      ...env,
    },
    stdin: "null",
  }).output();
  if (ok.includes(code)) return new TextDecoder().decode(stdout);
  throw new Error(
    `\`git ${args[0]}\` exited with status ${code}: ${
      new TextDecoder().decode(stderr).trim()
    }`,
  );
}

/**
 * Reads the record of when each failing repository started failing: the time
 * in milliseconds, by repository in lower case. Throws on any other shape.
 */
function decodeFailingSince(text: string): Record<string, number> {
  const record: unknown = JSON.parse(text);
  const unexpected = new Error(
    `Unexpected record of failing repositories: ${text}`,
  );
  if (!isObjectNotArray(record)) throw unexpected;
  const since: Record<string, number> = {};
  for (const [repo, at] of Object.entries(record)) {
    if (typeof at !== "number" || !Number.isFinite(at)) throw unexpected;
    since[repo] = at;
  }
  return since;
}

/**
 * What a row shows of `standing`, as a string that differs whenever the row
 * would, apart from the age of a green row.
 */
function shown(standing: Standing | undefined): string {
  const scan = standing?.scan;
  return JSON.stringify([
    scan?.commit,
    scan?.references.length,
    scan?.references[0],
    scan?.failingSince,
    standing?.error,
  ]);
}

/**
 * Makes `directory`, and any directory above it that is missing, and makes
 * `directory` readable by its owner alone, since the copies it holds can be of
 * private repositories. Throws when `directory` is a symbolic link or not a
 * directory.
 */
async function privateDirectory(directory: string): Promise<void> {
  await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await Deno.lstat(directory);
  if (!info.isDirectory) {
    throw new Error(`\`${directory}\` is not a directory`);
  }
  await Deno.chmod(directory, 0o700);
}
