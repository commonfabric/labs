/** Readiness of the runner's independent lanes and its local API. */

/** Lifecycle state and the reason a lane is not serving. */
export interface LaneReadiness {
  state: "up" | "down" | "starting" | "refused";
  since: string;
  reason: string | null;
}

/** Lane transition before its timestamp is assigned by the service. */
export type LaneTransition = Pick<LaneReadiness, "state" | "reason">;

/** The authenticated health response; `lanes` retains its boolean contract. */
export interface RunnerHealth {
  ok: true;
  lanes: { local: boolean; fabric: boolean };
  readiness: { local: LaneReadiness; fabric: LaneReadiness };
  routes: readonly { method: string; path: string }[];
  features: readonly string[];
  profileFile: string;
  storePath: string;
  labsCommit: string | null;
}

/** Local routes, with path parameters introduced by `:`. */
export const LOCAL_JOB_ROUTES = [
  { method: "GET", path: "/health" },
  { method: "GET", path: "/jobs" },
  { method: "POST", path: "/jobs" },
  { method: "GET", path: "/jobs/:id" },
  { method: "POST", path: "/jobs/:id/cancel" },
  { method: "GET", path: "/jobs/:id/events" },
  { method: "GET", path: "/jobs/:id/browser/stream" },
  { method: "POST", path: "/jobs/:id/browser/result" },
];

/**
 * A feature names a request field or behaviour a caller must not assume from
 * the routes alone. `continues`: `POST /jobs` takes `continues`, and a runner
 * without it would drop the field and start a plain job.
 */
export const LOCAL_JOB_FEATURES = ["continues"];

/** Keeps the timestamp stable until a lane's state or reason changes. */
export function transitionLane(
  previous: LaneReadiness,
  next: LaneTransition,
  now = new Date(),
): LaneReadiness {
  return previous.state === next.state && previous.reason === next.reason
    ? previous
    : { ...next, since: now.toISOString() };
}
