/**
 * The deployment a process is connected to, held so that a connection to a
 * second one fails by name instead of silently taking the first one's place.
 *
 * Opening a connection writes settings that belong to the deployment into
 * state that belongs to the process: the endpoint an LLM call reaches, the
 * base URL a pattern's relative `fetch` resolves against, and the ambient
 * experimental flags a runtime applies. None of it is scoped to the
 * connection that wrote it, so a connection to a different deployment
 * rewrites all of it while the first connection carries on — against the
 * second deployment's settings, and reporting nothing.
 *
 * So a process holds one deployment, and a connection to a second is refused
 * here. What a caller holding a connection across many commands has to hold
 * to is tighter than that, because a second connection to the *same*
 * deployment shares this state too and is indistinguishable from the several
 * an ordinary verb opens. `docs/plans/shuttle/runtime-integration.md` records
 * the whole of that, what it costs such a caller, and where the scoping work
 * belongs when one connection stops being enough.
 */

import { normalizeApiUrl } from "./api-url.ts";

/**
 * The deployment claimed, normalized for comparison, or `null` while this
 * process has claimed none.
 */
let claimed: string | null = null;

/**
 * Helper for {@link claimProcessDeployment}, which returns the deployment
 * `apiUrl` names, or `null` for one no connection can be opened over.
 *
 * Every consumer of an API URL resolves a path against it, so that is the
 * test for the second case: `localhost:8000` parses as a URL and still fails
 * it, its `8000` being an opaque path that no path can be resolved against.
 * What passes is keyed through `normalizeApiUrl`, the spelling the whole CLI
 * reads an API URL by, so two spellings of one deployment claim one
 * deployment.
 */
function deploymentKey(apiUrl: string): string | null {
  return URL.canParse("/", apiUrl) ? normalizeApiUrl(apiUrl) : null;
}

/**
 * Claims the deployment at `apiUrl` as this process's, and throws when a
 * different one is already claimed. Claiming the deployment already held is
 * what every connection after the first does, and passes.
 *
 * A claim stands whether or not the connection it was made for opens, since
 * a connection that fails on the way up has written those settings already:
 * a well-formed host that answers nothing holds the claim until the process
 * restarts, which is what the refusal names. One case cannot have written
 * them: an API URL no connection can be opened over fails before the first
 * of them is set, so it claims nothing and the corrected URL after it still
 * connects.
 *
 * What it catches is a second deployment, not a second connection: two
 * connections to one deployment write the same settings and go unremarked,
 * as does everything else one process's connections share.
 */
export function claimProcessDeployment(apiUrl: string): void {
  const key = deploymentKey(apiUrl);
  if (key === null) return;
  if (claimed === null) {
    claimed = key;
    return;
  }
  if (claimed === key) return;
  throw new Error(
    `This process is connected to \`${claimed}\`, so a connection to ` +
      `\`${key}\` is refused: the settings a connection writes are the ` +
      `process's rather than the connection's, which is one deployment ` +
      `per process. Reach \`${key}\` from a separate process — ` +
      `restarting is the deployment switch.`,
  );
}

/** Forgets the claimed deployment. For tests that drive several claims. */
export function resetProcessDeployment(): void {
  claimed = null;
}
