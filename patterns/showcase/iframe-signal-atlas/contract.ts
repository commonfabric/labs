export type SignalBand = "pulse" | "drift" | "echo";

export interface SignalObservation {
  id: string;
  label: string;
  x: number;
  y: number;
  observedAt: number;
  strength: number;
  band: SignalBand;
}

export interface SignalRoute {
  id: string;
  fromObservationId: string;
  toObservationId: string;
  departedAt: number;
  duration: number;
  band: SignalBand;
}

export interface IframeInputData {
  title: string;
  subtitle: string;
  fieldSeed: number;
  timeStart: number;
  timeEnd: number;
}

export interface IframeStateData {
  observations: SignalObservation[];
  routes: SignalRoute[];
}

export interface AtlasLayers {
  terrain: boolean;
  propagation: boolean;
  routes: boolean;
}

export interface AtlasViewport {
  x: number;
  y: number;
  scale: number;
}

export interface IframeOutputData {
  timeCursor: number;
  band: SignalBand | "all";
  selectedObservationId: string | null;
  layers: AtlasLayers;
  viewport: AtlasViewport;
}

export const DEFAULT_INPUT: IframeInputData = {
  title: "Signal Propagation Atlas",
  subtitle: "A shared temporal field study of the fictional Pelagic Reach",
  fieldSeed: 7391,
  timeStart: 0,
  timeEnd: 100,
};

export const DEFAULT_STATE: IframeStateData = {
  observations: [
    {
      id: "obs-aurora-12",
      label: "Aurora Shelf",
      x: 24,
      y: 31,
      observedAt: 12,
      strength: 0.78,
      band: "pulse",
    },
    {
      id: "obs-cinder-27",
      label: "Cinder Cay",
      x: 42,
      y: 58,
      observedAt: 27,
      strength: 0.62,
      band: "drift",
    },
    {
      id: "obs-verdant-41",
      label: "Verdant Shoal",
      x: 64,
      y: 34,
      observedAt: 41,
      strength: 0.91,
      band: "pulse",
    },
    {
      id: "obs-orison-55",
      label: "Orison Atoll",
      x: 77,
      y: 67,
      observedAt: 55,
      strength: 0.7,
      band: "echo",
    },
    {
      id: "obs-lantern-68",
      label: "Lantern Bank",
      x: 50,
      y: 71,
      observedAt: 68,
      strength: 0.84,
      band: "drift",
    },
    {
      id: "obs-meridian-82",
      label: "Meridian Spire",
      x: 86,
      y: 23,
      observedAt: 82,
      strength: 0.73,
      band: "echo",
    },
  ],
  routes: [
    {
      id: "route-aurora-cinder",
      fromObservationId: "obs-aurora-12",
      toObservationId: "obs-cinder-27",
      departedAt: 15,
      duration: 18,
      band: "pulse",
    },
    {
      id: "route-cinder-verdant",
      fromObservationId: "obs-cinder-27",
      toObservationId: "obs-verdant-41",
      departedAt: 31,
      duration: 16,
      band: "drift",
    },
    {
      id: "route-verdant-orison",
      fromObservationId: "obs-verdant-41",
      toObservationId: "obs-orison-55",
      departedAt: 45,
      duration: 17,
      band: "pulse",
    },
    {
      id: "route-orison-lantern",
      fromObservationId: "obs-orison-55",
      toObservationId: "obs-lantern-68",
      departedAt: 58,
      duration: 15,
      band: "echo",
    },
    {
      id: "route-lantern-meridian",
      fromObservationId: "obs-lantern-68",
      toObservationId: "obs-meridian-82",
      departedAt: 72,
      duration: 16,
      band: "drift",
    },
  ],
};

export const DEFAULT_OUTPUT: IframeOutputData = {
  timeCursor: 72,
  band: "all",
  selectedObservationId: null,
  layers: {
    terrain: true,
    propagation: true,
    routes: true,
  },
  viewport: {
    x: 0,
    y: 0,
    scale: 1,
  },
};

export const IFRAME_PATTERN = {
  name: "SignalPropagationAtlas",
  displayName: "Signal Propagation Atlas",
  stateScope: "space",
  outputScope: "session",
  frameHeight: "100vh",
  databases: {
    personalAtlas: {
      scope: "user",
      tables: {
        atlas_bookmarks: {
          id: "text primary key",
          observation_id: "text not null",
          note: "text not null",
          created_at: "integer not null",
        },
        atlas_hypotheses: {
          id: "text primary key",
          title: "text not null",
          narrative: "text not null",
          status: "text not null",
          created_at: "integer not null",
        },
      },
    },
  },
} as const;
