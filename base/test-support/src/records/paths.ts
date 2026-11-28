/**
 * Where recording happens on disk. Producers append fragments to the
 * directory named by CF_TEST_RECORDS_DIR; when the variable is unset,
 * recording is disabled and producers do nothing. Run owners create their
 * spool directories under a fixed per-user root that survives reboots, so a
 * killed run's records are still there for a later run's sweep to ship.
 */

import { dirname, join, relative, resolve } from "@std/path";

/** Environment accessor, injectable for tests. */
export type Environment = (name: string) => string | undefined;

/**
 * The entry a repository's root directory holds, which every climb here
 * looks for. A climb reads nothing else, so a process permitted to read
 * this one path finds its repository all the same.
 */
export function repositoryMarker(dir: string): string {
  return join(dir, ".git");
}

/**
 * The repository-root-relative, forward-slashed form of a test file path —
 * the identity form for file-named tests — found by climbing from the file
 * to the enclosing .git. Undefined for a file inside no repository, such as
 * a fixture a test writes to a temporary directory: it is no test of a
 * repository, so it has no identity to record under.
 */
export function repositoryRelativePath(filePath: string): string | undefined {
  const absolute = resolve(filePath);
  const root = repositoryRoot(dirname(absolute));
  return root === undefined
    ? undefined
    : relative(root, absolute).replaceAll("\\", "/");
}

/**
 * The enclosing repository's root directory, found by climbing from the
 * given directory — the working directory by default — to the directory
 * holding .git. Undefined outside any repository.
 */
export function repositoryRoot(from: string = Deno.cwd()): string | undefined {
  let dir = resolve(from);
  for (;;) {
    try {
      Deno.statSync(repositoryMarker(dir));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

/**
 * Reads an environment variable, treating a denied permission as unset. A
 * producer inside a test process whose --allow-env list does not include the
 * recording variables is simply not recording; it must never throw.
 */
export function readEnv(
  name: string,
  env: Environment = Deno.env.get,
): string | undefined {
  try {
    return env(name);
  } catch {
    return undefined;
  }
}

/** Variable naming the active run's spool directory. */
export const RECORDS_DIR_VARIABLE = "CF_TEST_RECORDS_DIR";

/** Variable naming the per-person service-account key file. */
export const RECORDS_KEY_FILE_VARIABLE = "CF_TEST_RECORDS_KEY_FILE";

/** Variable carrying the opaque operating-agent label. */
export const AGENT_VARIABLE = "CF_TEST_AGENT";

/** Variable overriding the per-user spool root. */
export const SPOOL_ROOT_VARIABLE = "CF_TEST_RECORDS_SPOOL_ROOT";

/**
 * The active run's spool directory, or undefined when recording is off.
 */
export function recordsDir(
  env: Environment = Deno.env.get,
): string | undefined {
  const dir = readEnv(RECORDS_DIR_VARIABLE, env);
  return dir !== undefined && dir.length > 0 ? dir : undefined;
}

/**
 * Whether this process may write into the spool. Querying a permission
 * needs no permission, so this answers before anything is attempted and
 * without a warning for a process that was never going to record.
 */
export function writableSpool(spool: string | undefined): boolean {
  if (spool === undefined) return false;
  return Deno.permissions.querySync({ name: "write", path: spool }).state ===
    "granted";
}

/**
 * The fixed per-user spool root. Overridable with
 * CF_TEST_RECORDS_SPOOL_ROOT; otherwise under the user's cache directory,
 * which survives reboots — the temporary directory does not, and a rebooted
 * workstation's spooled records must survive to be swept.
 */
export function defaultSpoolRoot(
  env: Environment = Deno.env.get,
): string | undefined {
  const override = readEnv(SPOOL_ROOT_VARIABLE, env);
  if (override !== undefined && override.length > 0) return override;
  const cacheDir = commonFabricCacheDir(env);
  return cacheDir === undefined ? undefined : join(cacheDir, "test-records");
}

/**
 * The per-user directory Common Fabric's tools keep caches in:
 * `common-fabric` under `$XDG_CACHE_HOME`, or under `.cache` in the home
 * directory (`$HOME`, else `$USERPROFILE`) where that is unset. A variable
 * set to the empty string counts as unset. `undefined` where the
 * environment names no home directory.
 */
export function commonFabricCacheDir(
  env: Environment = Deno.env.get,
): string | undefined {
  const named = (name: string) => {
    const value = readEnv(name, env);
    return value === "" ? undefined : value;
  };
  const cacheHome = named("XDG_CACHE_HOME");
  if (cacheHome !== undefined) return join(cacheHome, "common-fabric");
  const home = named("HOME") ?? named("USERPROFILE");
  return home === undefined ? undefined : join(home, ".cache", "common-fabric");
}

/**
 * Harnesses that drive an agent, and the name each is recorded under.
 * A harness announces itself in the environment it hands the commands
 * it runs, and the first of these that is present names the run's
 * operator. The names are stable strings rather than anything the
 * harness reports about itself, so a version bump does not split an
 * agent's history in two.
 */
const AGENT_MARKERS: readonly { variable: string; label: string }[] = [
  { variable: "CLAUDECODE", label: "claude-code" },
  { variable: "CURSOR_AGENT", label: "cursor" },
  { variable: "CODEX_SANDBOX", label: "codex" },
  { variable: "AI_AGENT", label: "agent" },
];

/**
 * The opaque agent label. CF_TEST_AGENT is what a person or a fleet
 * sets deliberately, and nothing else overrides it. Without one, a run
 * an agent started is labeled by the harness that started it, so an
 * agent's runs are told apart from a person's without a variable having
 * to be set in every checkout a fleet works in. A person's own terminal
 * carries none of these and their runs stay unlabeled.
 */
export function agentLabel(
  env: Environment = Deno.env.get,
): string | undefined {
  const agent = readEnv(AGENT_VARIABLE, env);
  if (agent !== undefined && agent.length > 0) return agent;
  for (const marker of AGENT_MARKERS) {
    const value = readEnv(marker.variable, env);
    if (value !== undefined && value.length > 0) return marker.label;
  }
  return undefined;
}
