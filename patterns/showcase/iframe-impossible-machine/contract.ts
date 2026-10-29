export type MachineNodeKind =
  | "sensor"
  | "gate"
  | "delay"
  | "transformer"
  | "actuator";

export type GateOperator = "and" | "or" | "xor";

export interface MachinePosition {
  x: number;
  y: number;
}

export interface MachineParameters {
  active: boolean;
  strength: number;
  operator: GateOperator;
  delaySteps: number;
  gain: number;
  offset: number;
  threshold: number;
}

export interface MachineNode {
  id: string;
  kind: MachineNodeKind;
  label: string;
  position: MachinePosition;
  parameters: MachineParameters;
}

export interface MachineEdge {
  id: string;
  source: string;
  target: string;
}

/** Returns the stable logical identity for one directed machine wire. */
export function machineEdgeId(source: string, target: string): string {
  return `edge:${source.length}:${source}:${target.length}:${target}`;
}

export interface IframeInputData {
  title: string;
  subtitle: string;
}

export interface IframeStateData {
  nodes: MachineNode[];
  edges: MachineEdge[];
  disabledEdges: Record<string, boolean>;
}

export interface IframeOutputData {
  selectedNodeId: string | null;
  simulationTick: number;
  showSignals: boolean;
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Collaborative Impossible Machine",
  subtitle: "Wire strange ideas together and watch the signal travel.",
};

const DEFAULT_PARAMETERS: MachineParameters = {
  active: false,
  strength: 1,
  operator: "and",
  delaySteps: 1,
  gain: 1,
  offset: 0,
  threshold: 0.6,
};

export const DEFAULT_STATE: IframeStateData = {
  nodes: [
    {
      id: "sensor-moonlight",
      kind: "sensor",
      label: "Moonlight sensor",
      position: { x: 70, y: 70 },
      parameters: {
        ...DEFAULT_PARAMETERS,
        active: true,
        strength: 0.85,
      },
    },
    {
      id: "sensor-contradiction",
      kind: "sensor",
      label: "Contradiction detector",
      position: { x: 70, y: 300 },
      parameters: {
        ...DEFAULT_PARAMETERS,
        active: false,
      },
    },
    {
      id: "gate-paradox",
      kind: "gate",
      label: "Paradox gate",
      position: { x: 380, y: 180 },
      parameters: {
        ...DEFAULT_PARAMETERS,
        operator: "xor",
      },
    },
    {
      id: "delay-tomorrow",
      kind: "delay",
      label: "Tomorrow loop",
      position: { x: 680, y: 65 },
      parameters: {
        ...DEFAULT_PARAMETERS,
        delaySteps: 2,
      },
    },
    {
      id: "transformer-optimism",
      kind: "transformer",
      label: "Optimism amplifier",
      position: { x: 680, y: 305 },
      parameters: {
        ...DEFAULT_PARAMETERS,
        gain: 1.2,
        offset: 0.05,
      },
    },
    {
      id: "actuator-teacup",
      kind: "actuator",
      label: "Teacup launcher",
      position: { x: 990, y: 180 },
      parameters: {
        ...DEFAULT_PARAMETERS,
        threshold: 0.65,
      },
    },
  ],
  edges: [
    {
      id: machineEdgeId("sensor-moonlight", "gate-paradox"),
      source: "sensor-moonlight",
      target: "gate-paradox",
    },
    {
      id: machineEdgeId("sensor-contradiction", "gate-paradox"),
      source: "sensor-contradiction",
      target: "gate-paradox",
    },
    {
      id: machineEdgeId("gate-paradox", "delay-tomorrow"),
      source: "gate-paradox",
      target: "delay-tomorrow",
    },
    {
      id: machineEdgeId("gate-paradox", "transformer-optimism"),
      source: "gate-paradox",
      target: "transformer-optimism",
    },
    {
      id: machineEdgeId("delay-tomorrow", "actuator-teacup"),
      source: "delay-tomorrow",
      target: "actuator-teacup",
    },
    {
      id: machineEdgeId("transformer-optimism", "actuator-teacup"),
      source: "transformer-optimism",
      target: "actuator-teacup",
    },
  ],
  disabledEdges: {},
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  selectedNodeId: null,
  simulationTick: 3,
  showSignals: true,
};

export const IFRAME_PATTERN = {
  name: "IframeImpossibleMachine",
  displayName: "Collaborative Impossible Machine",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "100vh",
  databases: {},
} as const;
