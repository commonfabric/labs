import type { IframeInputData, SimulationAction } from "./contract.ts";

export interface RendererFailureAlarm {
  description: string;
  source: string;
  lineno: number;
  colno: number;
  stacktrace: string;
}

/** Reports renderer construction failures through the pre-bridge guest alarm. */
export function reportRendererFailure(
  cause: unknown,
  report: (alarm: RendererFailureAlarm) => void,
): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  report({
    description: error.message,
    source: "iframe-firebreak-commons",
    lineno: 0,
    colno: 0,
    stacktrace: error.stack ?? error.message,
  });
}

/** Surfaces a renderer bootstrap failure before preserving the thrown cause. */
export function initializeRenderer<T>(
  create: () => T,
  onFailure: (cause: unknown) => void,
): T {
  try {
    return create();
  } catch (cause) {
    onFailure(cause);
    throw cause;
  }
}

export type Terrain = "water" | "grass" | "forest" | "settlement";

export type FireIntensity = 0 | 1 | 2 | 3;

export type SimulationStatus = "active" | "contained" | "overrun";

export interface TileState {
  id: string;
  x: number;
  y: number;
  terrain: Terrain;
  fire: FireIntensity;
  firebreak: boolean;
  wetUntilTurn: number;
  residents: number;
  evacuatedResidents: number;
  lostResidents: number;
  burned: boolean;
}

export interface SimulationSnapshot {
  turn: number;
  status: SimulationStatus;
  tiles: TileState[];
  activeFireCount: number;
  burnedTileCount: number;
  evacuatedResidentCount: number;
  lostResidentCount: number;
  acceptedActionIds: string[];
  rejectedActionIds: string[];
}

const ACTION_ORDER: Record<SimulationAction["type"], number> = {
  water: 0,
  firebreak: 1,
  evacuate: 2,
  "advance-turn": 3,
};

const MIN_COLUMNS = 5;
const MAX_COLUMNS = 12;
const MIN_ROWS = 4;
const MAX_ROWS = 10;

export interface BoardDimensions {
  columns: number;
  rows: number;
}

export type ActionDisposition = "accepted" | "rejected" | "pending";

function clampInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/** Returns the board dimensions supported by both simulation and rendering. */
export function normalizedBoardDimensions(
  input: Pick<IframeInputData, "columns" | "rows">,
): BoardDimensions {
  return {
    columns: clampInteger(input.columns, MIN_COLUMNS, MAX_COLUMNS),
    rows: clampInteger(input.rows, MIN_ROWS, MAX_ROWS),
  };
}

/** Returns the turn limit used by both the reducer and renderer. */
export function normalizedMaximumTurns(maximumTurns: number): number {
  return clampInteger(maximumTurns, 1, 50);
}

/** Classifies an intent against the reducer's authoritative result. */
export function actionDisposition(
  snapshot: Pick<
    SimulationSnapshot,
    "acceptedActionIds" | "rejectedActionIds"
  >,
  actionId: string,
): ActionDisposition {
  if (snapshot.acceptedActionIds.includes(actionId)) return "accepted";
  if (snapshot.rejectedActionIds.includes(actionId)) return "rejected";
  return "pending";
}

function hashUnit(seed: number, label: string): number {
  let hash = (seed ^ 0x811c_9dc5) >>> 0;
  for (let index = 0; index < label.length; index++) {
    hash ^= label.charCodeAt(index);
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
    hash ^= hash >>> 13;
  }
  return hash / 0x1_0000_0000;
}

function terrainFor(seed: number, x: number, y: number): Terrain {
  const value = hashUnit(seed, `terrain:${x}:${y}`);
  if (value < 0.1) return "water";
  if (value < 0.22) return "settlement";
  if (value < 0.62) return "forest";
  return "grass";
}

function residentsFor(seed: number, id: string, terrain: Terrain): number {
  if (terrain !== "settlement") return 0;
  return 4 + Math.floor(hashUnit(seed, `residents:${id}`) * 6);
}

function initialTiles(input: IframeInputData): TileState[] {
  const { columns, rows } = normalizedBoardDimensions(input);
  const tiles: TileState[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const id = `tile-${x}-${y}`;
      const terrain = terrainFor(input.seed, x, y);
      tiles.push({
        id,
        x,
        y,
        terrain,
        fire: 0,
        firebreak: false,
        wetUntilTurn: 0,
        residents: residentsFor(input.seed, id, terrain),
        evacuatedResidents: 0,
        lostResidents: 0,
        burned: false,
      });
    }
  }

  const ignitionCandidates = tiles
    .filter((tile) => tile.terrain === "forest" || tile.terrain === "grass")
    .sort((left, right) =>
      hashUnit(input.seed, `ignition:${left.id}`) -
        hashUnit(input.seed, `ignition:${right.id}`) ||
      left.id.localeCompare(right.id)
    );
  const ignitionCount = clampInteger(
    input.initialFireCount,
    1,
    Math.max(1, ignitionCandidates.length),
  );
  for (const tile of ignitionCandidates.slice(0, ignitionCount)) {
    tile.fire = 2;
  }
  return tiles;
}

function canonicalActionValue(action: SimulationAction): string {
  return action.type === "advance-turn"
    ? `${action.type}:${action.turn}:${action.actorId}`
    : `${action.type}:${action.turn}:${action.actorId}:${action.tileId}`;
}

/**
 * Returns one deterministic payload for every stable action ID, independent of
 * the order in which concurrent append operations arrive.
 */
export function canonicalActions(
  actions: readonly SimulationAction[],
): SimulationAction[] {
  const sorted = [...actions].filter((action) =>
    action.id.length > 0 && action.actorId.length > 0 &&
    Number.isSafeInteger(action.turn) && action.turn > 0
  ).sort((left, right) =>
    left.id.localeCompare(right.id) ||
    canonicalActionValue(left).localeCompare(canonicalActionValue(right))
  );
  const unique: SimulationAction[] = [];
  let previousId: string | undefined;
  for (const action of sorted) {
    if (action.id === previousId) continue;
    previousId = action.id;
    unique.push(action);
  }
  return unique.sort((left, right) =>
    left.turn - right.turn ||
    ACTION_ORDER[left.type] - ACTION_ORDER[right.type] ||
    left.id.localeCompare(right.id)
  );
}

function adjacentTiles(
  tile: TileState,
  tiles: readonly TileState[],
): TileState[] {
  return tiles.filter((candidate) =>
    Math.abs(candidate.x - tile.x) + Math.abs(candidate.y - tile.y) === 1
  ).sort((left, right) => left.id.localeCompare(right.id));
}

function applyCrewAction(
  action: Exclude<SimulationAction, { type: "advance-turn" }>,
  turn: number,
  tiles: TileState[],
): boolean {
  const tile = tiles.find((candidate) => candidate.id === action.tileId);
  if (!tile) return false;

  switch (action.type) {
    case "water": {
      if (tile.terrain === "water" || tile.fire === 0) return false;
      tile.fire = Math.max(0, tile.fire - 2) as FireIntensity;
      tile.wetUntilTurn = Math.max(tile.wetUntilTurn, turn + 1);
      return true;
    }
    case "firebreak": {
      if (
        tile.terrain === "water" || tile.terrain === "settlement" ||
        tile.fire > 0 || tile.firebreak
      ) return false;
      tile.firebreak = true;
      return true;
    }
    case "evacuate": {
      if (
        tile.terrain !== "settlement" || tile.fire === 3 ||
        tile.evacuatedResidents + tile.lostResidents >= tile.residents
      ) return false;
      tile.evacuatedResidents = tile.residents - tile.lostResidents;
      return true;
    }
  }
}

/** Advances the mutable tile projection by one deterministic wildfire turn. */
export function advanceFire(
  input: IframeInputData,
  turn: number,
  tiles: TileState[],
): void {
  const burning = tiles.filter((tile) => tile.fire > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  const ignitions = new Set<string>();

  for (const source of burning) {
    if (source.wetUntilTurn >= turn) {
      source.fire = Math.max(0, source.fire - 1) as FireIntensity;
    } else {
      source.fire = Math.min(3, source.fire + 1) as FireIntensity;
    }
    if (source.fire === 0) continue;
    if (source.fire === 3) {
      source.burned = true;
      source.lostResidents = Math.max(
        source.lostResidents,
        source.residents - source.evacuatedResidents,
      );
    }

    for (const target of adjacentTiles(source, tiles)) {
      if (
        target.terrain === "water" || target.fire > 0 || target.firebreak ||
        target.wetUntilTurn >= turn
      ) continue;
      const terrainChance = target.terrain === "forest"
        ? 0.68
        : target.terrain === "settlement"
        ? 0.52
        : 0.4;
      const intensityBonus = source.fire === 3 ? 0.12 : 0;
      if (
        hashUnit(
          input.seed,
          `spread:${turn}:${source.id}:${target.id}`,
        ) <
          terrainChance + intensityBonus
      ) {
        ignitions.add(target.id);
      }
    }
  }

  for (const id of [...ignitions].sort()) {
    const tile = tiles.find((candidate) => candidate.id === id);
    if (tile && tile.fire === 0) tile.fire = 1;
  }
}

function summarize(
  turn: number,
  maximumTurns: number,
  tiles: TileState[],
  acceptedActionIds: string[],
  rejectedActionIds: string[],
): SimulationSnapshot {
  const activeFireCount = tiles.filter((tile) => tile.fire > 0).length;
  const status: SimulationStatus = activeFireCount === 0
    ? "contained"
    : turn > maximumTurns
    ? "overrun"
    : "active";
  return {
    turn,
    status,
    tiles,
    activeFireCount,
    burnedTileCount: tiles.filter((tile) => tile.burned).length,
    evacuatedResidentCount: tiles.reduce(
      (total, tile) => total + tile.evacuatedResidents,
      0,
    ),
    lostResidentCount: tiles.reduce(
      (total, tile) => total + tile.lostResidents,
      0,
    ),
    acceptedActionIds,
    rejectedActionIds,
  };
}

export function reduceSimulation(
  input: IframeInputData,
  actions: readonly SimulationAction[],
): SimulationSnapshot {
  const maximumTurns = normalizedMaximumTurns(input.maximumTurns);
  const tiles = initialTiles(input);
  const acceptedActionIds: string[] = [];
  const rejectedActionIds: string[] = [];
  const canonical = canonicalActions(actions);
  const grouped = new Map<number, SimulationAction[]>();
  for (const action of canonical) {
    const turnActions = grouped.get(action.turn);
    if (turnActions) turnActions.push(action);
    else grouped.set(action.turn, [action]);
  }
  let turn = 1;

  while (turn <= maximumTurns) {
    const turnActions = grouped.get(turn) ?? [];
    const actors = new Set<string>();
    for (const action of turnActions) {
      if (action.type === "advance-turn") continue;
      if (actors.has(action.actorId)) {
        rejectedActionIds.push(action.id);
        continue;
      }
      if (applyCrewAction(action, turn, tiles)) {
        actors.add(action.actorId);
        acceptedActionIds.push(action.id);
      } else {
        rejectedActionIds.push(action.id);
      }
    }

    const advances = turnActions.filter((action) =>
      action.type === "advance-turn"
    );
    const advance = advances.at(0);
    if (!advance) break;
    acceptedActionIds.push(advance.id);
    for (const action of advances.slice(1)) rejectedActionIds.push(action.id);
    advanceFire(input, turn, tiles);
    turn += 1;
    if (tiles.every((tile) => tile.fire === 0)) break;
  }

  for (const action of canonical) {
    if (
      action.turn >= turn && !acceptedActionIds.includes(action.id) &&
      !rejectedActionIds.includes(action.id)
    ) rejectedActionIds.push(action.id);
  }

  acceptedActionIds.sort();
  rejectedActionIds.sort();
  return summarize(
    turn,
    maximumTurns,
    tiles,
    acceptedActionIds,
    rejectedActionIds,
  );
}

export function describeTile(tile: TileState, currentTurn: number): string {
  const details: string[] = [tile.terrain];
  if (tile.fire > 0) details.push(`fire intensity ${tile.fire}`);
  if (tile.firebreak) details.push("firebreak protected");
  if (tile.wetUntilTurn >= currentTurn) details.push("recently watered");
  if (tile.residents > 0) {
    const remaining = Math.max(
      0,
      tile.residents - tile.evacuatedResidents - tile.lostResidents,
    );
    details.push(`${tile.evacuatedResidents} residents evacuated`);
    if (tile.lostResidents > 0) {
      details.push(`${tile.lostResidents} residents lost`);
    }
    details.push(
      remaining === 0
        ? "no residents awaiting evacuation"
        : `${remaining} residents awaiting evacuation`,
    );
  }
  return `Column ${tile.x + 1}, row ${tile.y + 1}: ${details.join(", ")}`;
}
