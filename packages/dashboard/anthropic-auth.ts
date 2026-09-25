/**
 * Authenticates the dashboard to Anthropic's Admin API, which the model-spend
 * tile reads for the organization's daily cost report.
 *
 * Two routes, in this order:
 *   - Workload Identity Federation, when ANTHROPIC_FEDERATION_RULE_ID,
 *     ANTHROPIC_ORGANIZATION_ID, and ANTHROPIC_SERVICE_ACCOUNT_ID are all set.
 *     The GKE metadata server signs a Google identity token for the pod's own
 *     service account, and Anthropic exchanges it for a short-lived
 *     `sk-ant-oat01-` bearer token. No Anthropic credential is stored anywhere,
 *     and a token copied out of the pod expires with the federation rule's
 *     lifetime. This is the in-cluster path.
 *   - ANTHROPIC_ADMIN_KEY, a long-lived `sk-ant-admin01-` key sent as
 *     `x-api-key`. This is the local-development path.
 *
 * Federation wins when both are configured, so a key left behind in the
 * environment cannot quietly keep the tile working after the move to
 * federation, and a broken federation setup shows up as a gray tile.
 *
 * The Admin API offers no read-only scope: a federated token for the cost
 * report carries `org:admin`, the same reach as an Admin key. What federation
 * limits is where the credential can come from and how long a copy of it
 * stays usable.
 *
 * https://platform.claude.com/docs/en/manage-claude/wif-providers/gcp
 */

/**
 * The audience the identity token is requested for. The federation rule pins
 * the same value, so a token the pod mints for another consumer (Tailscale,
 * say) cannot be exchanged here.
 */
export const ANTHROPIC_AUDIENCE = "https://api.anthropic.com";

/**
 * The metadata server's identity-token route for the workload's own service
 * account. `format=full` adds the `email` claim, which the federation rule
 * matches alongside the numeric `sub`; without it every exchange is denied.
 */
export const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity" +
  `?audience=${encodeURIComponent(ANTHROPIC_AUDIENCE)}&format=full`;

export const ANTHROPIC_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

const ANTHROPIC_VERSION = "2023-06-01";

type Env = (k: string) => string | undefined;

interface Federation {
  federation_rule_id: string;
  organization_id: string;
  service_account_id: string;
  workspace_id?: string;
}

// The federation settings, or null unless all three required ones are set. A
// partial set is treated as absent, not as an error, so the tile names what to
// set rather than failing on a half-configured deployment.
function federation(env: Env): Federation | null {
  const rule = env("ANTHROPIC_FEDERATION_RULE_ID");
  const org = env("ANTHROPIC_ORGANIZATION_ID");
  const account = env("ANTHROPIC_SERVICE_ACCOUNT_ID");
  if (!rule || !org || !account) return null;
  const workspace = env("ANTHROPIC_WORKSPACE_ID");
  return {
    federation_rule_id: rule,
    organization_id: org,
    service_account_id: account,
    // Only needed when the rule is enabled in more than one workspace; the
    // Admin API itself ignores the workspace binding.
    ...(workspace ? { workspace_id: workspace } : {}),
  };
}

/** Whether either Anthropic Admin API credential route is configured. */
export function anthropicAdminConfigured(env: Env): boolean {
  return federation(env) !== null || !!env("ANTHROPIC_ADMIN_KEY");
}

async function identityToken(): Promise<string> {
  const res = await fetch(METADATA_IDENTITY_URL, {
    headers: { "metadata-flavor": "Google" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`metadata identity token failed: HTTP ${res.status}`);
  const jwt = (await res.text()).trim();
  if (!jwt) throw new Error("metadata server returned an empty identity token");
  return jwt;
}

// Exchanges a fresh identity token for an Anthropic access token. Each call
// asks the metadata server again rather than holding a token: Anthropic caps
// the minted token at twice the identity token's remaining lifetime, so a
// stale identity token would shorten it. Every denial is the same opaque 401;
// the reason is on the Console's workload identity authentication history page.
async function exchange(fed: Federation): Promise<string> {
  const assertion = await identityToken();
  const res = await fetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
      ...fed,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Anthropic token exchange HTTP ${res.status}`);
  const json = await res.json() as { access_token?: unknown };
  if (typeof json.access_token !== "string" || json.access_token.length === 0) {
    throw new Error("Anthropic token exchange returned no access_token string");
  }
  return json.access_token;
}

/**
 * The headers for one round of Admin API calls. The tile asks once per
 * collection, which runs hourly, so the federated token is not cached: it is
 * short-lived by design and a fresh exchange each hour costs one extra
 * request. The token must outlast the collection's paging. The worst case is
 * twelve pages at the tile's 30-second timeout, about six minutes, which the
 * 600-second rule lifetime covers; a token that expires first grays the tile
 * until the next collection.
 */
export async function anthropicAdminHeaders(env: Env): Promise<Record<string, string>> {
  const fed = federation(env);
  if (fed) {
    return { authorization: `Bearer ${await exchange(fed)}`, "anthropic-version": ANTHROPIC_VERSION };
  }
  const key = env("ANTHROPIC_ADMIN_KEY");
  if (key) return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
  throw new Error("no Anthropic Admin API credential configured");
}
