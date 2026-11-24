/**
 * Reaches Google Cloud over REST, and runs the one small BigQuery query the
 * spend tiles need, without the bq or gcloud command-line tools.
 *
 * Access tokens come from one of two sources, in this order:
 *   - GCP_SA_KEY: a service-account key, the whole JSON file as the value of
 *     the environment variable. Its private key signs a JWT that is exchanged
 *     for a short-lived access token. This is the local-development path.
 *   - the metadata server on GCE and GKE, which returns an access token for
 *     the workload's own service account. This is the in-cluster path,
 *     Workload Identity, where no key is stored anywhere.
 *
 * BigQuery has no API-key authentication: a key does not identify a principal,
 * and every query runs as some service account. So this is the closest
 * analog to the bearer token the GitHub tiles use — a token obtained without
 * a command-line tool.
 */

import {
  saAssertion as signAssertion,
  type ServiceAccountKey,
  tokenFromKey,
  tokenFromMetadata,
} from "@commonfabric/test-support/records";

export { METADATA_TOKEN_URL } from "@commonfabric/test-support/records";

export type SaKey = ServiceAccountKey;

// Running a query is jobs.query, which does not accept the bigquery.readonly
// scope; cloud-platform.read-only is the narrowest scope it does accept, and
// being read-only the token cannot mutate anything. IAM on the service account
// (Data Viewer + Job User) is the real limit on what it can reach.
const BQ_SCOPE = "https://www.googleapis.com/auth/cloud-platform.read-only";

// The signed service-account assertion: a JWT claiming the read-only scope,
// signed with the key's private key. `nowSec` is the current time in whole
// seconds. Exported for tests (its signature can be verified with the public key).
export function saAssertion(key: SaKey, nowSec: number): Promise<string> {
  return signAssertion(key, nowSec, BQ_SCOPE);
}

async function accessToken(env: (k: string) => string | undefined): Promise<string> {
  const raw = env("GCP_SA_KEY");
  return raw ? await tokenFromKey(JSON.parse(raw) as SaKey, BQ_SCOPE) : await tokenFromMetadata();
}

// Flatten a jobs.query response to a grid of string cells (BigQuery returns every
// scalar as a string). Exported for tests.
export function bqRows(json: unknown): string[][] {
  const j = json as { jobComplete?: boolean; rows?: { f?: { v?: unknown }[] }[] };
  if (j.jobComplete === false) throw new Error("bigquery job did not complete in time");
  return (j.rows ?? []).map((r) => (r.f ?? []).map((c) => (c.v == null ? "" : String(c.v))));
}

// Run one standard-SQL query in `project` and return its rows. Uses the
// synchronous jobs.query endpoint with a server-side wait, so there is no client
// polling loop; a query that outlives the wait surfaces as an error and the
// caller retries on its next refresh.
export async function bigQuery(
  project: string,
  sql: string,
  env: (k: string) => string | undefined,
): Promise<string[][]> {
  const token = await accessToken(env);
  const res = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(project)}/queries`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 25_000 }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!res.ok) throw new Error(`bigquery query failed: HTTP ${res.status}`);
  return bqRows(await res.json());
}
