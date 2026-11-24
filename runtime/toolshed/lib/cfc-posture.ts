/**
 * The CFC posture this server runs at, published on `/api/meta` beside the
 * experimental-flag posture (`experimental-posture.ts`, whose module-state
 * rationale this mirrors): a deployment whose enforcement dials cannot be
 * read off it is indistinguishable from a default one, so an operator has no
 * way to confirm what a runtime is actually enforcing (CT-2075's posture
 * visibility finding).
 *
 * The record itself is the runner's (`@commonfabric/runner/cfc`
 * `cfcPostureReport`), which every surface that publishes a posture
 * publishes: what is here is the module state a route can read, and nothing
 * about the record's shape. Reporting only — the values come from the
 * constructed Runtime's resolved fields, never from a second reading of
 * configuration that could disagree with the first.
 *
 * The base webhook Runtime is the one reported. The per-space serving
 * runtimes the executor host builds hand-roll their options deliberately and
 * carry the same CFC dials from the same code path, so a separate override
 * channel would report nothing the base does not.
 */

import {
  type CfcPostureReport,
  cfcPostureReport,
  type CfcPostureSource,
} from "@commonfabric/runner/cfc";

export type { CfcPostureReport };

let posture: CfcPostureReport | null = null;

/**
 * Record a constructed Runtime's resolved CFC dials. Pass `null` to publish
 * nothing, which is also the state before any Runtime exists — a client then
 * reads `cfc: null` as "this deployment said nothing".
 */
export function publishCfcPosture(runtime: CfcPostureSource | null): void {
  posture = runtime === null ? null : cfcPostureReport(runtime);
}

/** What `/api/meta` reports; `null` until a Runtime has been constructed. */
export function cfcPosture(): CfcPostureReport | null {
  return posture;
}
