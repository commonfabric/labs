import type { AnyCellWrapping, Cell } from "../index.ts";

type Contacts = {
  primaryEmail: string;
  secondaryEmails: string[];
  phones: Array<{ label: string; value: string }>;
};

type Address = {
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  location: {
    lat: number;
    lng: number;
  };
};

type Preference = {
  marketing: boolean;
  notifications: {
    email: boolean;
    sms: boolean;
    push: boolean;
  };
};

type AuditEntry = {
  id: string;
  actor: string;
  summary: string;
  changes: Array<{
    field: string;
    from: string | number | boolean | null;
    to: string | number | boolean | null;
  }>;
};

type Profile = {
  displayName: string;
  contacts: Contacts;
  address: Address;
  preference: Cell<Preference>;
};

type InventoryItem = {
  sku: string;
  quantity: number;
  supplier: Cell<{
    id: string;
    rating: number;
    contact: Contacts;
  }>;
  history: Array<Cell<AuditEntry>>;
};

type DomainModel = {
  profile: Cell<Profile>;
  inventory: Array<InventoryItem>;
  metadata: {
    flags: Record<string, boolean>;
    contributors: Array<string>;
    version: number;
  };
  logs: Array<
    Cell<{
      timestamp: string;
      scope: "profile" | "inventory" | "system";
      payload: {
        before: Cell<Profile>;
        after: Cell<Profile>;
        diff: Array<AuditEntry>;
      };
    }>
  >;
} & { [key: string]: unknown };

type PrimaryWritePaths = AnyCellWrapping<DomainModel>;

type HistoryWritePaths = AnyCellWrapping<
  Array<
    Cell<{
      id: string;
      snapshot: DomainModel;
      related: Array<Cell<InventoryItem>>;
    }>
  >
>;

type ParallelWritePaths = [
  AnyCellWrapping<Profile>,
  AnyCellWrapping<InventoryItem>,
  AnyCellWrapping<AuditEntry>,
];

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type SegmentKey = `segment_${Digit}${Digit}`;

type MassiveDomain = {
  [K in SegmentKey]: {
    base: DomainModel;
    variants: Array<DomainModel>;
    timeline: Array<{
      before: DomainModel;
      after: DomainModel;
      delta: Array<AuditEntry>;
    }>;
  };
};

type StressWriteMatrix = {
  [K in SegmentKey]: AnyCellWrapping<{
    key: K;
    target: DomainModel;
    history: MassiveDomain[K];
    neighborhood: {
      [P in SegmentKey]: MassiveDomain[P];
    };
    layers: Array<
      [
        AnyCellWrapping<DomainModel>,
        AnyCellWrapping<MassiveDomain[K]>,
        AnyCellWrapping<MassiveDomain[keyof MassiveDomain]>,
      ]
    >;
  }>;
};

type StressWriteUnion = AnyCellWrapping<{
  seed: DomainModel;
  mirror: MassiveDomain;
  replicas: Array<MassiveDomain[keyof MassiveDomain]>;
  matrix: StressWriteMatrix;
  ledger: Array<{
    id: string;
    current: StressWriteMatrix[keyof StressWriteMatrix];
    previous: StressWriteMatrix[keyof StressWriteMatrix];
  }>;
}>;

type StressWriteGrid = {
  [K in SegmentKey]: {
    [P in SegmentKey]: AnyCellWrapping<{
      source: MassiveDomain[K];
      target: MassiveDomain[P];
      pair: [DomainModel, DomainModel];
      diff: Array<{
        before: MassiveDomain[K];
        after: MassiveDomain[P];
        audit: Array<AuditEntry>;
      }>;
    }>;
  };
};

type StressWriteCross =
  StressWriteGrid[keyof StressWriteGrid][keyof StressWriteGrid];

type StressWriteExpansion = AnyCellWrapping<{
  grid: StressWriteGrid;
  cross: StressWriteCross;
  matrix: StressWriteMatrix;
  mirror: MassiveDomain;
  registry: Record<SegmentKey, StressWriteMatrix[keyof StressWriteMatrix]>;
}>;
