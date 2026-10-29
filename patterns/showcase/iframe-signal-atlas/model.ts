import type { SignalBand, SignalObservation, SignalRoute } from "./contract.ts";

export type SignalBandFilter = SignalBand | "all";

export const FIELD_WIDTH = 120;
export const FIELD_HEIGHT = 75;

export function clampTimeCursor(
  timeCursor: number,
  timeStart: number,
  timeEnd: number,
): number {
  const low = Math.min(timeStart, timeEnd);
  const high = Math.max(timeStart, timeEnd);
  return Math.min(high, Math.max(low, timeCursor));
}

export function capturedAction<Value, Result>(
  value: Value,
  action: (value: Value) => Promise<Result>,
): () => Promise<Result> {
  return () => action(value);
}

/** Clamps the latest stored cursor after earlier queued writes have settled. */
export async function reconcileTimeCursor(
  readCurrent: () => Promise<number>,
  writeCurrent: (value: number) => Promise<void>,
  timeStart: number,
  timeEnd: number,
): Promise<number> {
  const current = await readCurrent();
  const clamped = clampTimeCursor(current, timeStart, timeEnd);
  if (clamped !== current) await writeCurrent(clamped);
  return clamped;
}

/** Repeats cursor reconciliation until no input window changed during it. */
export async function reconcileTimeCursorUntilInputStable(
  readInputGeneration: () => number,
  readCurrent: () => Promise<number>,
  writeCurrent: (value: number) => Promise<void>,
  readWindow: () => { timeStart: number; timeEnd: number },
): Promise<number> {
  while (true) {
    const generation = readInputGeneration();
    const { timeStart, timeEnd } = readWindow();
    const reconciled = await reconcileTimeCursor(
      readCurrent,
      writeCurrent,
      timeStart,
      timeEnd,
    );
    if (generation === readInputGeneration()) return reconciled;
  }
}

/** Clears a submitted field only when it has not been edited since capture. */
export function canClearSubmittedDraft(
  submittedGeneration: number,
  currentGeneration: number,
): boolean {
  return submittedGeneration === currentGeneration;
}

export function visibleObservations(
  observations: readonly SignalObservation[],
  timeCursor: number,
  band: SignalBandFilter,
): SignalObservation[] {
  return observations.filter((observation) =>
    observation.observedAt <= timeCursor &&
    (band === "all" || observation.band === band)
  );
}

export function visibleRoutes(
  routes: readonly SignalRoute[],
  observations: readonly SignalObservation[],
  timeCursor: number,
  band: SignalBandFilter,
): SignalRoute[] {
  const visibleObservationIds = new Set(
    observations.filter((observation) => observation.observedAt <= timeCursor)
      .map((observation) => observation.id),
  );
  return routes.filter((route) =>
    route.departedAt <= timeCursor &&
    (band === "all" || route.band === band) &&
    visibleObservationIds.has(route.fromObservationId) &&
    visibleObservationIds.has(route.toObservationId)
  );
}

export function recentVisibleObservations(
  observations: readonly SignalObservation[],
  timeCursor: number,
  band: SignalBandFilter,
): SignalObservation[] {
  return visibleObservations(observations, timeCursor, band)
    .toSorted((left, right) => left.observedAt - right.observedAt)
    .slice(-2);
}

export interface RecentRouteSelection {
  observations: SignalObservation[];
  timeCursor: number;
}

/** Selects recent route endpoints against the current reactive time window. */
export function recentRouteSelection(
  observations: readonly SignalObservation[],
  capturedTimeCursor: number,
  band: SignalBandFilter,
  timeStart: number,
  timeEnd: number,
): RecentRouteSelection {
  const timeCursor = clampTimeCursor(
    capturedTimeCursor,
    timeStart,
    timeEnd,
  );
  return {
    observations: recentVisibleObservations(observations, timeCursor, band),
    timeCursor,
  };
}

export function propagationValues(
  observations: readonly SignalObservation[],
  timeCursor: number,
  width: number,
  height: number,
): number[] {
  const values: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let field = 0;
      for (const observation of observations) {
        const dx = x - observation.x;
        const dy = y - observation.y;
        const distanceSquared = dx * dx + dy * dy;
        const age = Math.max(0, timeCursor - observation.observedAt);
        const ageFalloff = Math.exp(-age / 42);
        field += observation.strength * ageFalloff *
          Math.exp(-distanceSquared / 185);
      }
      values.push(Math.min(1, Math.max(0, field)));
    }
  }
  return values;
}

export function routePoints(
  from: readonly [number, number],
  to: readonly [number, number],
): [number, number][] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(72, length * 0.25);
  const midpoint: [number, number] = [
    (from[0] + to[0]) / 2 - dy / length * bend,
    (from[1] + to[1]) / 2 + dx / length * bend,
  ];
  return [[...from], midpoint, [...to]];
}
