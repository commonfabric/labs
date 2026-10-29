// Pure access policy for the memory dump endpoint. Kept dependency-free (no env,
// no server) so the security matrix — opt-in and prod refusal, and the allowlist
// union — is unit-tested directly rather than only via comments.

const parseDids = (csv: string): string[] =>
  csv.split(",").map((d) => d.trim()).filter((d) => d.length > 0);

/**
 * Environments the dump endpoint may mount in. FAIL-CLOSED allowlist: `ENV` is
 * a free-form string, so denying only the literal "production" would let any
 * alias (`prod`, `Production`) or a typo slip through. An unknown ENV therefore
 * refuses to mount even with the opt-in flag set — enabling the endpoint on a
 * host requires BOTH MEMORY_DUMP_ENABLED and a recognized non-production ENV.
 */
const NON_PRODUCTION_ENVS = new Set(["development", "test", "staging"]);

/**
 * Whether the dump endpoint should be served in this environment at all.
 *
 * The REAL boundary is (a) the tailnet perimeter and (b) opt-in being off by
 * default — the endpoint only mounts when someone deliberately sets
 * MEMORY_DUMP_ENABLED on a staging host. The env allowlist is belt-and-
 * suspenders on top, with one caveat it cannot close: a production box that
 * leaves ENV unset inherits the "development" default, so the env check alone
 * can never distinguish it — which is why the flag defaults off and the
 * perimeter is the boundary. There is intentionally no override to turn raw
 * whole-space dumps on in production; a prod form is a separate mechanism.
 */
export function isDumpEnabled(cfg: {
  enabled: boolean | undefined;
  env: string;
}): boolean {
  if (!cfg.enabled) return false;
  return NON_PRODUCTION_ENVS.has(cfg.env.toLowerCase());
}

/** DIDs permitted to download dumps (MEMORY_DUMP_DIDS ∪ MEMORY_SERVICE_DIDS). */
export function dumpAllowSet(cfg: {
  dumpDids: string;
  serviceDids: string;
}): Set<string> {
  return new Set([
    ...parseDids(cfg.dumpDids),
    ...parseDids(cfg.serviceDids),
  ]);
}
