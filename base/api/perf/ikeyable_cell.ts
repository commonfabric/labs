import type { AsCell, Cell, IKeyable } from "../index.ts";

type Reaction = {
  type: Cell<string>;
  count: Cell<number>;
  lastUpdated: Cell<string>;
};

type CommentThread = {
  author: Cell<string>;
  text: Cell<string>;
  reactions: Cell<Array<Cell<Reaction>>>;
  replies: Cell<Array<Cell<CommentThread>>>;
};

type Profile = {
  id: Cell<string>;
  info: Cell<{
    displayName: Cell<string>;
    biography: Cell<string>;
    location: Cell<{
      city: Cell<string>;
      region: Cell<string>;
      coordinates: Cell<{ lat: Cell<number>; lng: Cell<number> }>;
    }>;
  }>;
  preferences: Cell<{
    notifications: Cell<Record<string, Cell<boolean>>>;
    shortcuts: Cell<Array<Cell<string>>>;
  }>;
};

type Post = {
  id: Cell<string>;
  content: Cell<string>;
  tags: Cell<Array<Cell<string>>>;
  comments: Cell<Array<Cell<CommentThread>>>;
  analytics: Cell<{
    impressions: Cell<number>;
    conversions: Cell<number>;
    breakdown: Cell<Record<string, Cell<number>>>;
  }>;
};

type RegistryEntry = {
  version: Cell<number>;
  notes: Cell<string>;
  author: Cell<string>;
  metadata: Cell<Record<string, Cell<string | number>>>;
};

type ComplexValue = {
  profile: Profile;
  posts: Cell<Array<Cell<Post>>>;
  analytics: Cell<{
    totals: Cell<{
      views: Cell<number>;
      visitors: Cell<number>;
      watchTime: Cell<number>;
    }>;
    trends: Cell<Array<Cell<{ label: Cell<string>; delta: Cell<number> }>>>;
    segments: Cell<
      Record<string, Cell<{ users: Cell<number>; score: Cell<number> }>>
    >;
  }>;
  registry: Cell<{
    active: Cell<Record<string, Cell<RegistryEntry>>>;
    archived: Cell<Array<Cell<RegistryEntry>>>;
    settings: Cell<{
      flags: Cell<Record<string, Cell<boolean>>>;
      categories: Cell<Array<Cell<string>>>;
    }>;
  }>;
  timeline: Cell<
    Array<
      Cell<{
        at: Cell<string>;
        state: Cell<{
          profile: Profile;
          headline: Cell<string>;
          metrics: Cell<{ score: Cell<number>; level: Cell<string> }>;
        }>;
      }>
    >
  >;
};

type ComplexKeyable = IKeyable<Cell<ComplexValue>, AsCell>;

type KeyAccess<K extends PropertyKey> = ComplexKeyable["key"] extends
  (key: K) => infer R ? R : never;

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type StressLiteral =
  | keyof ComplexValue
  | `alias_${keyof ComplexValue & string}`
  | `shadow_${Digit}${Digit}`
  | `custom_${Digit}${Digit}`;

type StressKeyMatrix = {
  [K in StressLiteral]: {
    direct: KeyAccess<K>;
    widened: KeyAccess<K | keyof ComplexValue>;
    propertyKey: KeyAccess<K | PropertyKey>;
    doubleAlias: KeyAccess<K | `${K & string}_${Digit}${Digit}`>;
    cross: {
      [P in StressLiteral]: KeyAccess<
        K | P | "profile" | "analytics" | "registry" | `${P & string}_extra`
      >;
    };
  };
};

type StressKeyUnion =
  StressKeyMatrix[keyof StressKeyMatrix]["cross"][keyof StressKeyMatrix];

type StressKeySummary = {
  entries: StressKeyUnion;
  literal: KeyAccess<"profile" | "posts" | "analytics" | "registry">;
  unionized: KeyAccess<StressLiteral>;
  fallback: KeyAccess<string | number | symbol>;
  nested: KeyAccess<`${keyof ComplexValue & string}_${Digit}${Digit}`>;
};

type StressKeyGrid = {
  [K in StressLiteral]: [
    KeyAccess<K>,
    KeyAccess<K | keyof ComplexValue>,
    KeyAccess<K | `${K & string}_${Digit}`>,
    KeyAccess<K | "timeline">,
    KeyAccess<K | "registry" | "analytics">,
  ];
};

type StressKeyExpansion = [
  StressKeyMatrix,
  StressKeyUnion,
  StressKeySummary,
  StressKeyGrid[keyof StressKeyGrid],
];
