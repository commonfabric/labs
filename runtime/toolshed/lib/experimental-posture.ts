/**
 * The experimental-flag posture this server runs at, published on `/api/meta`
 * so a client that is not built alongside it can adopt the deployment's flags
 * instead of being configured to match by hand
 * (`docs/development/EXPERIMENTAL_OPTIONS.md`, "Clients that are not built
 * alongside their server").
 *
 * Held here rather than read off the Runtime at request time because the meta
 * route is part of the app and the Runtime is constructed by the process that
 * serves it: reaching for the instance would make the route import the
 * server's entry point. The startup path publishes resolved runtime defaults
 * and the deployment's client policies. The webhook runtime keeps its own
 * session storage synchronized while clients can opt into local storage.
 *
 * Two halves, because a serving process runs two kinds of runtime: the
 * generic one this toolshed constructs for webhook pattern execution, whose
 * resolved defaults and deployment client flags are the base, and the
 * per-space SERVING runtimes the executor host builds under server execution,
 * which force a posture of their own on top. The base alone would tell a
 * client the deployment runs flags it does not.
 *
 * Module state, and one process serves one deployment; the tests that publish
 * a posture reset it, because nothing else would.
 */

import type { ExperimentalOptions } from "@commonfabric/runner";

let posture: Record<string, boolean> | null = null;
let servingOverrides: Record<string, boolean> | null = null;

/**
 * By flag name, so the meta document reads the same across restarts and a
 * diff of it means a changed posture rather than a changed iteration order.
 */
function sortedByFlag(
  entries: [string, boolean][],
): Record<string, boolean> {
  return Object.fromEntries(
    entries.sort(([left], [right]) => left < right ? -1 : 1),
  );
}

/** Every boolean entry of a flag set, with unresolved flags dropped. */
function booleanFlags(
  experimental: ExperimentalOptions,
): Record<string, boolean> {
  return sortedByFlag(
    Object.entries(experimental).filter((entry): entry is [string, boolean] =>
      typeof entry[1] === "boolean"
    ),
  );
}

/**
 * Record the resolved deployment flags, including client policies the webhook
 * runtime overrides for its own storage. Flags the runtime left
 * unresolved are omitted rather than published as `false`: a client reads an
 * absent flag as "this server said nothing", and keeps its own default.
 *
 * Pass `null` to publish nothing, which is also the state before any Runtime
 * exists — a client then sees `experimental: null` and keeps its defaults.
 */
export function publishExperimentalPosture(
  experimental: ExperimentalOptions | null,
): void {
  posture = experimental === null ? null : booleanFlags(experimental);
}

/**
 * Record the flags the SERVING loop forces on top of that base, when this
 * process serves (`lib/server-execution.ts`). Under the ON arm the per-space
 * serving runtimes are the ones doing the deployment's work, and they run a
 * posture the generic webhook runtime does not: a client told only the base
 * would adopt a value this deployment is not using. Every other flag reaches
 * the base from the deployment environment, including client-only policies.
 *
 * Pass `null` when the serving loop is not running, which is also the state
 * before it starts and after it stops.
 */
export function publishServingExperimentalOverrides(
  overrides: ExperimentalOptions | null,
): void {
  servingOverrides = overrides === null ? null : booleanFlags(overrides);
}

/**
 * What `/api/meta` reports: the deployment's posture, serving overrides
 * applied. `null` until a Runtime has been constructed — a client reads that
 * as "this deployment said nothing" and keeps its own defaults.
 */
export function experimentalPosture(): Record<string, boolean> | null {
  if (posture === null) return null;
  if (servingOverrides === null) return posture;
  return sortedByFlag(Object.entries({ ...posture, ...servingOverrides }));
}
