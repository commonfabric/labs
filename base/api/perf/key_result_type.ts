import type { AsCell, Cell, KeyResultType } from "../index.ts";

type ReactionCell = Cell<{
  type: Cell<string>;
  count: Cell<number>;
}>;

type PostCell = Cell<{
  id: Cell<string>;
  content: Cell<string>;
  metadata: Cell<{
    createdAt: Cell<string>;
    reactions: Cell<Array<ReactionCell>>;
    history: Cell<
      Array<
        Cell<{
          version: Cell<number>;
          summary: Cell<string>;
        }>
      >
    >;
  }>;
}>;

type AddressCell = Cell<{
  street: Cell<string>;
  city: Cell<string>;
  coordinates: Cell<{
    lat: Cell<number>;
    lng: Cell<number>;
  }>;
}>;

type ProfileCell = Cell<{
  displayName: Cell<string>;
  biography: Cell<string>;
  addresses: Cell<Array<AddressCell>>;
  preferences: Cell<{
    notifications: Cell<{
      email: Cell<boolean>;
      push: Cell<boolean>;
      sms: Cell<boolean>;
    }>;
    theme: Cell<string>;
  }>;
}>;

type ComplexCellValue = {
  profile: ProfileCell;
  posts: Cell<Array<PostCell>>;
  stats: Cell<{
    followers: Cell<number>;
    following: Cell<number>;
    tags: Cell<Array<Cell<string>>>;
  }>;
  misc: Cell<{
    flags: Cell<Record<string, Cell<boolean>>>;
    lastUpdated: Cell<string>;
  }>;
};

type ComplexCell = Cell<ComplexCellValue>;

type LiteralKeys = {
  profile: KeyResultType<ComplexCell, ["profile"], AsCell>;
  posts: KeyResultType<ComplexCell, ["posts"], AsCell>;
  stats: KeyResultType<ComplexCell, ["stats"], AsCell>;
  miscFlags: KeyResultType<
    Cell<{ misc: ComplexCellValue["misc"] }>,
    ["misc"],
    AsCell
  >;
};

type UnionKeys = KeyResultType<ComplexCell, ["profile" | "posts"], AsCell>;

type FallbackKeys = KeyResultType<ComplexCell, [string], AsCell>;

type SymbolKeys = KeyResultType<ComplexCell, [symbol], AsCell>;

type PropertyKeyAccess = KeyResultType<ComplexCell, [PropertyKey], AsCell>;

type NestedProfiles = KeyResultType<
  Cell<{
    users: Cell<
      Array<
        Cell<{
          profile: ProfileCell;
          posts: Cell<Array<PostCell>>;
        }>
      >
    >;
  }>,
  ["users"],
  AsCell
>;

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

type StressLiteral =
  | keyof ComplexCellValue
  | `alias_${keyof ComplexCellValue & string}`
  | `shadow_${Digit}${Digit}`
  | `custom_${Digit}${Digit}`;

type StressRecordCell = Cell<{ [K in StressLiteral]: ComplexCellValue }>;

type StressMatrix = {
  [K in StressLiteral]: {
    direct: KeyResultType<StressRecordCell, [K], AsCell>;
    spread: KeyResultType<
      StressRecordCell,
      [K | keyof ComplexCellValue],
      AsCell
    >;
    cross: {
      [P in StressLiteral]: KeyResultType<
        Cell<{
          primary: ComplexCellValue;
          secondary: ComplexCellValue;
          registry: Record<StressLiteral, ComplexCellValue>;
        }>,
        [K | P | "primary" | "secondary" | "registry"],
        AsCell
      >;
    };
  };
};

type StressCrossUnion =
  StressMatrix[keyof StressMatrix]["cross"][keyof StressMatrix];

type StressSummary = {
  entries: StressCrossUnion;
  mapped: {
    [K in StressLiteral]: KeyResultType<
      Cell<Record<StressLiteral, ComplexCellValue>>,
      [K],
      AsCell
    >;
  };
  fallback: KeyResultType<
    ComplexCell,
    [StressLiteral | `${StressLiteral & string}_fallback`],
    AsCell
  >;
};
