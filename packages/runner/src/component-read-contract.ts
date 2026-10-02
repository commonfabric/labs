/** Data-only read contracts shared by components and server view traversal. */

import type { JSONSchema } from "@commonfabric/api";

import {
  booleanSchema,
  numberSchema,
  pieceListSchema,
  stringArraySchema,
  stringSchema,
} from "./schemas.ts";
import { NAME } from "./shared.ts";

/** Read schema shared by cf-chat and its server view traversal. */
export const BuiltInLLMMessagesArraySchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      role: { type: "string" },
      content: {
        anyOf: [{
          type: "array",
          items: {
            anyOf: [{
              type: "object",
              properties: {
                type: { type: "string" },
                text: { type: "string" },
                image: { type: "string" },
                toolCallId: { type: "string" },
                toolName: { type: "string" },
                input: { type: "object" },
                output: {},
              },
              required: ["type"],
            }, { type: "string" }],
          },
        }, { type: "string" }],
      },
    },
    required: ["role", "content"],
  },
} as const satisfies JSONSchema;

/** Read schema shared by cf-message-beads and its server view traversal. */
export const MessagesSchema = {
  type: "array",
  items: { type: "object" },
} as const satisfies JSONSchema;

/** Read schema shared by cf-location and its server view traversal. */
export const LocationDataSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    latitude: { type: "number" },
    longitude: { type: "number" },
    accuracy: { type: "number" },
    altitude: { type: "number" },
    altitudeAccuracy: { type: "number" },
    heading: { type: "number" },
    speed: { type: "number" },
    timestamp: { type: "number" },
  },
  required: ["id", "latitude", "longitude", "accuracy", "timestamp"],
} as const satisfies JSONSchema;

/** Read schema shared by cf-voice-input and its server view traversal. */
export const TranscriptionDataSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    chunks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: {
            type: "array",
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
          },
          text: { type: "string" },
        },
        required: ["timestamp", "text"],
      },
    },
    audioData: { type: "string" },
    duration: { type: "number" },
    timestamp: { type: "number" },
  },
  required: ["id", "text", "duration", "timestamp"],
} as const satisfies JSONSchema;

/** Read schema shared by cf-autocomplete and its server view traversal. */
export const AutocompleteItemArraySchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      value: { type: "string" },
      label: { type: "string" },
      group: { type: "string" },
      searchAliases: { type: "array", items: { type: "string" } },
      data: {},
    },
    required: ["value"],
  },
} as const satisfies JSONSchema;

/** Read schema shared by cf-tools-chip and its server view traversal. */
export const ToolsArraySchema = {
  anyOf: [
    {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          schema: {
            type: "object",
            properties: { "description": { type: "string" } },
          },
        },
        required: ["name"],
      },
    },
    {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          description: { type: "string" },
          handler: {
            type: "object",
            properties: {
              "description": { type: "string" },
              "argumentSchema": {
                type: "object",
                properties: { "description": { type: "string" } },
              },
            },
          },
          pattern: {
            type: "object",
            properties: {
              "description": { type: "string" },
              "argumentSchema": {
                type: "object",
                properties: { "description": { type: "string" } },
              },
            },
          },
        },
      },
    },
  ],
} as const satisfies JSONSchema;

/** Read schema shared by cf-map and its server view traversal. */
export const latLngSchema: JSONSchema = {
  type: "object",
  properties: {
    lat: { type: "number" },
    lng: { type: "number" },
  },
};

/** Read schema shared by cf-map and its server view traversal. */
export const boundsSchema: JSONSchema = {
  type: "object",
  properties: {
    north: { type: "number" },
    south: { type: "number" },
    east: { type: "number" },
    west: { type: "number" },
  },
};

/** Read schema shared by cf-map and its server view traversal. */
export const mapValueSchema: JSONSchema = {
  type: "object",
  properties: {
    markers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          position: latLngSchema,
          title: { type: "string" },
          description: { type: "string" },
          icon: { type: "string" },
          draggable: { type: "boolean" },
          // popup is Reactive, left unspecified to preserve as-is
        },
      },
    },
    circles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          center: latLngSchema,
          radius: { type: "number" },
          color: { type: "string" },
          fillOpacity: { type: "number" },
          strokeWidth: { type: "number" },
          title: { type: "string" },
          description: { type: "string" },
          // popup is Reactive, left unspecified to preserve as-is
        },
      },
    },
    polylines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          points: {
            type: "array",
            items: latLngSchema,
          },
          color: { type: "string" },
          strokeWidth: { type: "number" },
          dashArray: { type: "string" },
        },
      },
    },
  },
};

/** The title and opaque destination used by the editor mention picker. */
export const MentionableSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    // The `MentionRef.destination` shape: an opaque cell boundary. The value
    // at this position never carries a usable handle — an `asCell` position
    // crosses the client boundary as an empty object — so a reader reaches
    // the piece by ADDRESS and never reads through it under this schema.
    piece: { type: "object", properties: {}, asCell: ["cell"] },
    // A universe row's copy of what its collection calls the member, which
    // the editor's `#42` query and a mention's pill both read. The read
    // reaches no further than the string.
    shortName: { type: "string" },
  },
  required: [NAME],
} as const satisfies JSONSchema;

/** The editor mention picker list without destination contents. */
export const MentionableArraySchema = {
  type: "array",
  items: MentionableSchema,
} as const satisfies JSONSchema;

/** An editor reference destination and its title override marker. */
export const MentionRefSchema = {
  type: "object",
  properties: {
    destination: { type: "object", properties: {}, asCell: ["cell"] },
    modifiedTitle: { type: "boolean", default: false },
  },
  required: ["destination"],
} as const satisfies JSONSchema;

/** The reference map persisted alongside an editor document. */
export const MentionRefMapSchema = {
  type: "object",
  additionalProperties: MentionRefSchema,
} as const satisfies JSONSchema;

/** Profile fields rendered by cf-profile-badge, including its tooltip. */
export const ProfileBadgeSchema = {
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    name: { type: "string" },
    avatar: { type: "string" },
    bio: { type: "string" },
    elements: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" } },
      },
    },
  },
} as const satisfies JSONSchema;

/**
 * How a component that shows a cell only through a render mounted from its
 * reference reads that reference: as a cell, which names the document the
 * reference lands on and reads none of its contents.
 */
export const NestedRenderReferenceSchema = {
  asCell: ["cell"],
} as const satisfies JSONSchema;

/**
 * A path from a bound value to a reference its component mounts a render
 * from: each step a property name, or `"*"` for every element of an array.
 * The empty path names the binding itself.
 */
export type NestedRenderPath = readonly string[];

/**
 * How a component reads a bound property: with `schema`, as
 * {@link componentReadSchema} resolves it against the schema the bound handle
 * carries, and, for a nested render root, the paths of the references it
 * mounts a render from, each read as `NestedRenderReferenceSchema` reads one.
 * A component's entry is reviewed like the component itself: what it reads
 * through the handle beyond `schema`, or shows from beyond a reference other
 * than through a render mounted from it, the entry does not cover.
 */
export type ComponentPropRead = {
  readonly schema: JSONSchema;
  readonly renders?: readonly NestedRenderPath[];
};

/** Version exchanged when a renderer registers its component read contract. */
export const COMPONENT_READ_CONTRACT_VERSION = "1";

/** Known component reads; undeclared dynamic reads keep their explicit watches. */
export const componentReadContracts: Readonly<
  Record<string, Readonly<Record<string, ComponentPropRead>>>
> = {
  "cf-input": { value: { schema: stringSchema } },
  "cf-textarea": { value: { schema: stringSchema } },
  "cf-checkbox": { checked: { schema: booleanSchema } },
  "cf-switch": { checked: { schema: booleanSchema } },
  "cf-tabs": { value: { schema: stringSchema } },
  "cf-tab-bar": { value: { schema: stringSchema } },
  "cf-render": {
    cell: { schema: NestedRenderReferenceSchema, renders: [[]] },
  },
  // `cf-picker` hands each item's reference to a `cf-render` of its own.
  "cf-picker": {
    selectedIndex: { schema: numberSchema },
    items: { schema: pieceListSchema, renders: [["*"]] },
  },
  "cf-autocomplete": {
    value: { schema: { anyOf: [stringSchema, stringArraySchema] } },
    items: { schema: AutocompleteItemArraySchema },
  },
  "cf-chat": { messages: { schema: BuiltInLLMMessagesArraySchema } },
  "cf-message-beads": { messages: { schema: MessagesSchema } },
  "cf-location": { location: { schema: LocationDataSchema } },
  "cf-voice-input": { transcription: { schema: TranscriptionDataSchema } },
  "cf-tools-chip": { tools: { schema: ToolsArraySchema } },
  "cf-map": {
    // Each marker's and circle's `popup` goes to a `cf-render` of its own.
    value: {
      schema: mapValueSchema,
      renders: [["markers", "*", "popup"], ["circles", "*", "popup"]],
    },
    center: { schema: latLngSchema },
    bounds: { schema: boundsSchema },
    zoom: { schema: true },
  },
  "cf-code-editor": {
    value: { schema: stringSchema },
    mentionable: { schema: MentionableArraySchema },
    mentioned: { schema: MentionableArraySchema },
    references: { schema: MentionRefMapSchema },
  },
  "cf-profile-badge": { profile: { schema: ProfileBadgeSchema } },
  "cf-markdown": { content: { schema: true } },
  "cf-fab": { previewMessage: { schema: stringSchema } },
  "cf-theme": { theme: { schema: true } },
  "cf-calendar": { value: { schema: true }, markedDates: { schema: true } },
  "cf-select": { value: { schema: true } },
  "cf-radio-group": { value: { schema: true } },
  "cf-modal": { open: { schema: true } },
  "cf-file-download": { data: { schema: true }, filename: { schema: true } },
  "cf-prompt-input": { model: { schema: true } },
  "cf-chart": { marks: { schema: true } },
};

/** Schema choice shared with cf-autocomplete's single/multiple value binding. */
export function autocompleteValueSchema(multiple: boolean): JSONSchema {
  return multiple ? stringArraySchema : stringSchema;
}

/**
 * Resolves explicit projections and controller defaults for a bound property:
 * the schema the component reads it with, given `supplied`, the schema the
 * bound handle carries. `props` are the element's props, which only
 * `cf-autocomplete`'s `value` consults.
 */
export function componentReadSchema(
  component: string,
  property: string,
  supplied: JSONSchema | undefined,
  props: Record<string, unknown> = {},
): JSONSchema | undefined {
  const declared = componentReadContracts[component]?.[property]?.schema;
  if (declared === undefined) return undefined;
  if (
    (component === "cf-render" && property === "cell") ||
    (component === "cf-picker" && property === "items") ||
    component === "cf-profile-badge" || component === "cf-fab" ||
    (component === "cf-code-editor" && property !== "value")
  ) return declared;
  const schema = component === "cf-autocomplete" && property === "value"
    ? autocompleteValueSchema(props.multiple === true)
    : declared;
  return schema === true ? supplied ?? true : supplied || schema;
}
