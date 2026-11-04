import type { JSONSchema } from "../index.ts";
import type { Schema, SchemaWithoutCell } from "../schema.ts";

type ComplexSchema = {
  readonly $id: "Root";
  readonly type: "object";
  readonly required: readonly ["profile", "items", "status"];
  readonly properties: {
    readonly profile: {
      readonly type: "object";
      readonly required: readonly ["name", "address"];
      readonly properties: {
        readonly name: {
          readonly type: "string";
          readonly default: "Anonymous";
        };
        readonly address: { readonly $ref: "#/$defs/address" };
        readonly preferences: {
          readonly $ref: "#/$defs/preferences";
          readonly asCell: ["cell"];
        };
      };
    };
    readonly items: {
      readonly type: "array";
      readonly items: { readonly $ref: "#/$defs/item" };
    };
    readonly status: {
      readonly enum: readonly ["active", "inactive", "pending"];
    };
    readonly timeline: {
      readonly anyOf: readonly [
        {
          readonly type: "array";
          readonly items: { readonly $ref: "#/$defs/event" };
        },
        { readonly type: "null" },
      ];
    };
  };
  readonly additionalProperties: { readonly type: "string" };
  readonly $defs: {
    readonly address: {
      readonly type: "object";
      readonly required: readonly ["street", "city", "coordinates"];
      readonly properties: {
        readonly street: { readonly type: "string" };
        readonly city: { readonly type: "string" };
        readonly coordinates: { readonly $ref: "#/$defs/coordinates" };
      };
    };
    readonly coordinates: {
      readonly type: "object";
      readonly properties: {
        readonly lat: { readonly type: "number" };
        readonly lng: { readonly type: "number" };
      };
    };
    readonly preferences: {
      readonly type: "object";
      readonly properties: {
        readonly notifications: {
          readonly type: "object";
          readonly required: readonly ["email", "sms", "push"];
          readonly properties: {
            readonly email: {
              readonly type: "boolean";
              readonly default: false;
            };
            readonly sms: { readonly type: "boolean"; readonly default: false };
            readonly push: { readonly type: "boolean"; readonly default: true };
          };
        };
        readonly tags: {
          readonly type: "array";
          readonly items: { readonly type: "string" };
        };
      };
      readonly asCell: ["stream"];
    };
    readonly item: {
      readonly type: "object";
      readonly required: readonly ["id", "quantity", "metadata"];
      readonly properties: {
        readonly id: { readonly type: "string" };
        readonly quantity: { readonly type: "number" };
        readonly metadata: {
          readonly anyOf: readonly [
            { readonly $ref: "#/$defs/itemMetadata" },
            { readonly type: "null" },
          ];
        };
      };
    };
    readonly event: {
      readonly type: "object";
      readonly properties: {
        readonly kind: {
          readonly enum: readonly ["created", "updated", "deleted"];
        };
        readonly at: { readonly type: "string" };
        readonly payload: {
          readonly type: "object";
          readonly properties: {
            readonly summary: { readonly type: "string" };
            readonly actor: { readonly type: "string" };
          };
        };
      };
    };
    readonly itemMetadata: {
      readonly type: "object";
      readonly properties: {
        readonly manufacturer: { readonly type: "string" };
        readonly warrantyMonths: { readonly type: "number" };
        readonly extras: {
          readonly type: "array";
          readonly items: {
            readonly type: "object";
            readonly properties: {
              readonly code: { readonly type: "string" };
              readonly expires: { readonly type: "string" };
            };
          };
        };
      };
    };
  };
} & JSONSchema;

type ReactiveResult = Schema<ComplexSchema>;

type PlainResult = SchemaWithoutCell<ComplexSchema>;

type NestedRefResult = Schema<
  {
    readonly type: "object";
    readonly properties: {
      readonly root: { readonly $ref: "#/$defs/root" };
    };
    readonly $defs: {
      readonly root: {
        readonly $ref: "#/$defs/node";
      };
      readonly node: {
        readonly type: "object";
        readonly properties: {
          readonly value: { readonly type: "string" };
          readonly children: {
            readonly type: "array";
            readonly items: { readonly $ref: "#/$defs/node" };
          };
        };
      };
    };
  } & JSONSchema
>;

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

type StressSchemaResult = Schema<StressSchema>;
type StressSchemaVariants = { [K in VariantKey]: Schema<StressSchema> };
type StressSchemaUnion = StressSchemaVariants[keyof StressSchemaVariants];
type StressSchemaWithoutCells = SchemaWithoutCell<StressSchema>;
type StressSchemaCombined = [
  StressSchemaResult,
  StressSchemaUnion,
  StressSchemaWithoutCells,
];

type ParameterizedSchema<L extends string> = Schema<
  StressSchema & { readonly title: L }
>;

type StressSchemaMatrix = {
  [K in VariantKey]: {
    [P in VariantKey]: ParameterizedSchema<`${K}-${P}`>;
  };
};

type StressSchemaCross =
  StressSchemaMatrix[keyof StressSchemaMatrix][keyof StressSchemaMatrix];
