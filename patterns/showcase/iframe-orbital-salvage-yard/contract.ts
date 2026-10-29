export type Vector3Tuple = [number, number, number];

export type ModuleKind =
  | "hub"
  | "habitat"
  | "cargo"
  | "solar"
  | "relay";

export type YardTool = "inspect" | "move";

export interface ModuleConnector {
  id: string;
  label: string;
  offset: Vector3Tuple;
  normal: Vector3Tuple;
}

export interface ModuleTransform {
  position: Vector3Tuple;
  rotationQuarterTurns: number;
}

export interface ModuleSnapClaim {
  id: string;
  movingConnectorId: string;
  targetModuleId: string;
  targetConnectorId: string;
  rotationQuarterTurns: number;
}

export interface StationModule {
  id: string;
  label: string;
  kind: ModuleKind;
  color: Vector3Tuple;
  transform: ModuleTransform;
  connectors: ModuleConnector[];
}

export interface IframeInputData {
  title: string;
  subtitle: string;
}

export interface IframeStateData {
  modules: StationModule[];
  moduleTransforms: Record<string, ModuleTransform>;
  moduleTransformIds: Record<string, string>;
  snapClaims: Record<string, ModuleSnapClaim | null>;
  snapTargets: Record<string, string | null>;
  releasedSnapClaims?: Record<string, boolean>;
}

export interface IframeOutputData {
  preferredTool: YardTool;
  accentColor: string;
  bookmarks: Record<string, boolean>;
}

const CONNECTOR_DEFINITIONS: Record<ModuleKind, ModuleConnector[]> = {
  hub: [
    {
      id: "east-lock",
      label: "East lock",
      offset: [2.4, 0, 0],
      normal: [1, 0, 0],
    },
    {
      id: "west-lock",
      label: "West lock",
      offset: [-2.4, 0, 0],
      normal: [-1, 0, 0],
    },
    {
      id: "north-lock",
      label: "North lock",
      offset: [0, 0, 2.4],
      normal: [0, 0, 1],
    },
    {
      id: "south-lock",
      label: "South lock",
      offset: [0, 0, -2.4],
      normal: [0, 0, -1],
    },
  ],
  habitat: [
    {
      id: "aft-lock",
      label: "Aft lock",
      offset: [0, 0, -2.6],
      normal: [0, 0, -1],
    },
    {
      id: "fore-lock",
      label: "Fore lock",
      offset: [0, 0, 2.6],
      normal: [0, 0, 1],
    },
  ],
  cargo: [
    {
      id: "port-lock",
      label: "Port lock",
      offset: [-2.6, 0, 0],
      normal: [-1, 0, 0],
    },
    {
      id: "starboard-lock",
      label: "Starboard lock",
      offset: [2.6, 0, 0],
      normal: [1, 0, 0],
    },
  ],
  solar: [
    {
      id: "truss-lock",
      label: "Truss lock",
      offset: [2.6, 0, 0],
      normal: [1, 0, 0],
    },
  ],
  relay: [
    {
      id: "base-lock",
      label: "Base lock",
      offset: [0, 0, -1.8],
      normal: [0, 0, -1],
    },
  ],
};

export function moduleConnectors(kind: ModuleKind): ModuleConnector[] {
  return CONNECTOR_DEFINITIONS[kind].map((connector) => ({
    ...connector,
    offset: [...connector.offset],
    normal: [...connector.normal],
  }));
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Orbital Salvage Yard",
  subtitle:
    "Recover drifting hardware and assemble a station that every operator can shape.",
};

export const DEFAULT_STATE: IframeStateData = {
  moduleTransforms: {},
  moduleTransformIds: {},
  snapClaims: {},
  snapTargets: {},
  releasedSnapClaims: {},
  modules: [
    {
      id: "module-junction-nine",
      label: "Junction Nine",
      kind: "hub",
      color: [0.27, 0.43, 0.52],
      transform: { position: [0, 1.2, 0], rotationQuarterTurns: 0 },
      connectors: moduleConnectors("hub"),
    },
    {
      id: "module-cargo-kestrel",
      label: "Kestrel Cargo Spine",
      kind: "cargo",
      color: [0.64, 0.36, 0.17],
      transform: { position: [5, 1.2, 0], rotationQuarterTurns: 0 },
      connectors: moduleConnectors("cargo"),
    },
    {
      id: "module-habitat-morrow",
      label: "Morrow Habitat",
      kind: "habitat",
      color: [0.29, 0.53, 0.42],
      transform: { position: [0, 1.2, 5], rotationQuarterTurns: 0 },
      connectors: moduleConnectors("habitat"),
    },
    {
      id: "module-solar-rig-amber",
      label: "Amber Solar Rig",
      kind: "solar",
      color: [0.32, 0.39, 0.66],
      transform: { position: [-5, 1.2, 0], rotationQuarterTurns: 0 },
      connectors: moduleConnectors("solar"),
    },
  ],
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  preferredTool: "move",
  accentColor: "#f4b860",
  bookmarks: {},
};

export const IFRAME_PATTERN = {
  name: "IframeOrbitalSalvageYard",
  displayName: "Orbital Salvage Yard",
  stateScope: "space",
  outputScope: "user",
  frameHeight: "100vh",
  databases: {},
} as const;
