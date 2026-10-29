import type { AsCell, Cell, IKeyable, JSONSchema } from "../index.ts";
import type { Schema } from "../schema.ts";

type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type OverrideKey = `override_${Digit}${Digit}`;
type VariantKey = `variant_${Digit}${Digit}`;
type ConfigKey = `config_${Digit}${Digit}`;

type OverrideProperties = {
  readonly [K in OverrideKey]: { readonly $ref: "#/$defs/config" };
};

type ModuleProperties = {
  readonly id: { readonly type: "string" };
  readonly config: {
    readonly anyOf: readonly [
      { readonly $ref: "#/$defs/config" },
      { readonly $ref: "#/$defs/advancedConfig" },
      {
        readonly type: "object";
        readonly properties: {
          readonly fallback: { readonly type: "boolean" };
          readonly ref: { readonly $ref: "#/$defs/config" };
        };
        readonly additionalProperties: false;
      },
    ];
  };
  readonly overrides: {
    readonly type: "object";
    readonly properties: OverrideProperties;
  };
};

type ModulesSchema = {
  readonly type: "array";
  readonly minItems: 1;
  readonly items: {
    readonly type: "object";
    readonly required: readonly ["id", "config"];
    readonly properties: ModuleProperties;
  };
};

type RegistryPattern = Readonly<
  Record<`^mod-${Digit}${Digit}$`, { readonly $ref: "#/$defs/advancedConfig" }>
>;

type RegistrySchema = {
  readonly type: "object";
  readonly properties: {
    readonly latest: { readonly $ref: "#/$defs/config" };
    readonly archived: {
      readonly type: "array";
      readonly items: { readonly $ref: "#/$defs/history" };
    };
  };
  readonly additionalProperties: { readonly $ref: "#/$defs/config" };
  readonly patternProperties: RegistryPattern;
};

type StressDefs =
  & {
    readonly config: {
      readonly type: "object";
      readonly properties: {
        readonly mode: { readonly type: "string" };
        readonly retries: { readonly type: "number" };
        readonly enabled: { readonly type: "boolean" };
      };
      readonly required: readonly ["mode"];
    };
    readonly advancedConfig: {
      readonly allOf: readonly [
        { readonly $ref: "#/$defs/config" },
        {
          readonly type: "object";
          readonly properties: {
            readonly timeout: { readonly type: "number" };
            readonly tags: {
              readonly type: "array";
              readonly items: { readonly type: "string" };
            };
          };
        },
      ];
    };
    readonly history: {
      readonly type: "array";
      readonly items: {
        readonly type: "object";
        readonly properties: {
          readonly version: { readonly type: "number" };
          readonly snapshot: { readonly $ref: "#/$defs/config" };
        };
      };
    };
  }
  & {
    readonly [K in ConfigKey]: {
      readonly type: "object";
      readonly properties: {
        readonly ref: { readonly $ref: "#/properties/registry" };
        readonly next: { readonly $ref: "#/$defs/config" };
        readonly extended: {
          readonly anyOf: readonly [
            { readonly $ref: "#/$defs/config" },
            { readonly $ref: "#/$defs/advancedConfig" },
          ];
        };
      };
    };
  };

type StressSchema = {
  readonly type: "object";
  readonly required: readonly ["modules", "registry"];
  readonly properties: {
    readonly modules: ModulesSchema;
    readonly registry: RegistrySchema;
    readonly states: {
      readonly type: "array";
      readonly items: { readonly $ref: "#/$defs/history" };
    };
    readonly variants: {
      readonly type: "object";
      readonly properties: {
        readonly [K in VariantKey]: {
          readonly $ref: "#/$defs/config";
        };
      };
    };
  };
  readonly additionalProperties: {
    readonly anyOf: readonly [
      { readonly type: "null" },
      { readonly $ref: "#/$defs/config" },
    ];
  };
  readonly allOf: readonly [
    {
      readonly if: {
        readonly properties: {
          readonly registry: {
            readonly properties: {
              readonly latest: { readonly const: "legacy" };
            };
          };
        };
      };
      readonly then: {
        readonly properties: {
          readonly modules: { readonly maxItems: 1 };
        };
      };
    },
    {
      readonly anyOf: readonly [
        { readonly required: readonly ["modules"] },
        { readonly required: readonly ["registry"] },
      ];
    },
  ];
  readonly $defs: StressDefs;
} & JSONSchema;

type SchemaValue = Schema<StressSchema>;
type SchemaCell = Cell<SchemaValue>;
type SchemaKeyable = IKeyable<SchemaCell, AsCell>;

type SchemaKeyAccess<K extends PropertyKey> = SchemaKeyable["key"] extends
  (key: K) => infer R ? R : never;

type SchemaDirectKeys = keyof SchemaValue & string;

type SchemaStressLiteral =
  | SchemaDirectKeys
  | OverrideKey
  | VariantKey
  | ConfigKey
  | `dynamic_${Digit}${Digit}`;

type VariantSchemas = {
  [K in VariantKey]: Schema<StressSchema & { readonly title: K }>;
};

type VariantKeyables = {
  [K in VariantKey]: IKeyable<Cell<VariantSchemas[K]>, AsCell>;
};

type SchemaStressMatrix = {
  [K in SchemaStressLiteral]: {
    direct: SchemaKeyAccess<K>;
    widened: SchemaKeyAccess<K | SchemaDirectKeys>;
    propertyKey: SchemaKeyAccess<K | PropertyKey>;
    composed: SchemaKeyAccess<K | `${K & string}_${Digit}${Digit}`>;
    variant: {
      [P in keyof VariantKeyables]: VariantKeyables[P]["key"] extends (
        key: K | P,
      ) => infer R ? R
        : never;
    };
    cascade: {
      [P in SchemaStressLiteral]: SchemaKeyAccess<
        K | P | "modules" | "registry" | "states"
      >;
    };
  };
};

type SchemaStressUnion =
  SchemaStressMatrix[keyof SchemaStressMatrix]["cascade"][
    keyof SchemaStressMatrix
  ];

type SchemaStressSummary = {
  entries: SchemaStressUnion;
  literal: SchemaKeyAccess<"modules" | "registry" | "states" | "variants">;
  variantUnion: VariantKeyables[keyof VariantKeyables]["key"] extends (
    key: infer K,
  ) => infer R ? (K extends PropertyKey ? R : never)
    : never;
  fallback: SchemaKeyAccess<string | number | symbol>;
  dynamic: SchemaKeyAccess<SchemaStressLiteral>;
};

type SchemaStressGrid = {
  [K in SchemaStressLiteral]: [
    SchemaKeyAccess<K>,
    SchemaKeyAccess<K | SchemaDirectKeys>,
    SchemaKeyAccess<K | `branch_${Digit}${Digit}`>,
    SchemaKeyAccess<K | "variants">,
    SchemaKeyAccess<K | `${SchemaStressLiteral & string}_${Digit}${Digit}`>,
  ];
};

type SchemaStressExpansion = [
  SchemaStressMatrix,
  SchemaStressUnion,
  SchemaStressSummary,
  SchemaStressGrid[keyof SchemaStressGrid],
];
