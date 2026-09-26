/**
 * Says which version of the dashboard is being served, so a page left open
 * notices that the code behind it has changed and reloads onto the new one. A
 * deployment names its commit in DASHBOARD_GIT_COMMIT, and anything else
 * reports the moment the process started.
 */

type Environment = (name: string) => string | undefined;
type Clock = () => Date;

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

function validCommit(value: string): string {
  if (!COMMIT_PATTERN.test(value)) {
    throw new Error(
      "Dashboard deployment commit must be a full 40-character lowercase hash.",
    );
  }
  return value;
}

/**
 * The version a server started from a checkout reports, for a server whose code
 * changes under it between starts. Two starts are further apart than the
 * millisecond this records, so a page held open across a restart sees a version
 * it did not load with and reloads onto the code now being served. The time is
 * readable in the page source, which says when the server serving it started.
 */
export function processStartVersion(startedAt: Date): string {
  return `local-${startedAt.toISOString()}`;
}

export function dashboardVersion(
  env: Environment = Deno.env.get,
  now: Clock = () => new Date(),
): string {
  const deployedCommit = env("DASHBOARD_GIT_COMMIT");
  if (deployedCommit !== undefined) return validCommit(deployedCommit);
  return processStartVersion(now());
}

/** The version this process serves, fixed when it starts. */
export const SERVING_VERSION = dashboardVersion();
