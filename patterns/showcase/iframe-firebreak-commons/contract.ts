export type CrewTool = "water" | "firebreak" | "evacuate";

export type CrewColor = "amber" | "blue" | "mint" | "violet";

interface ActionBase {
  id: string;
  actorId: string;
  turn: number;
}

export interface WaterAction extends ActionBase {
  type: "water";
  tileId: string;
}

export interface FirebreakAction extends ActionBase {
  type: "firebreak";
  tileId: string;
}

export interface EvacuateAction extends ActionBase {
  type: "evacuate";
  tileId: string;
}

export interface AdvanceTurnAction extends ActionBase {
  type: "advance-turn";
}

export type SimulationAction =
  | WaterAction
  | FirebreakAction
  | EvacuateAction
  | AdvanceTurnAction;

export interface IframeInputData {
  title: string;
  briefing: string;
  seed: number;
  columns: number;
  rows: number;
  initialFireCount: number;
  maximumTurns: number;
}

export interface IframeStateData {
  actions: SimulationAction[];
}

export interface IframeOutputData {
  crew: {
    name: string;
    color: CrewColor;
    preferredTool: CrewTool;
  };
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Firebreak Commons",
  briefing:
    "Coordinate water drops, firebreaks, and evacuations before advancing the shared wildfire.",
  seed: 0x5f37_59df,
  columns: 9,
  rows: 7,
  initialFireCount: 3,
  maximumTurns: 12,
};

export const DEFAULT_STATE: IframeStateData = {
  actions: [],
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  crew: {
    name: "Commons crew",
    color: "amber",
    preferredTool: "water",
  },
};

export const IFRAME_PATTERN = {
  name: "IframeFirebreakCommons",
  displayName: "Firebreak Commons",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "100vh",
  databases: {},
} as const;
