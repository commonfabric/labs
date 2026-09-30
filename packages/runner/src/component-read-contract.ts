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

/** Version exchanged when a renderer registers its component read contract. */
export const COMPONENT_READ_CONTRACT_VERSION = "1";

/** Known component reads; undeclared dynamic reads keep their explicit watches. */
export const componentReadContracts: Readonly<
  Record<string, Readonly<Record<string, JSONSchema>>>
> = {
  "cf-input": { value: stringSchema },
  "cf-textarea": { value: stringSchema },
  "cf-checkbox": { checked: booleanSchema },
  "cf-switch": { checked: booleanSchema },
  "cf-tabs": { value: stringSchema },
  "cf-tab-bar": { value: stringSchema },
  "cf-picker": { selectedIndex: numberSchema, items: pieceListSchema },
  "cf-autocomplete": {
    value: { anyOf: [stringSchema, stringArraySchema] },
    items: AutocompleteItemArraySchema,
  },
  "cf-chat": { messages: BuiltInLLMMessagesArraySchema },
  "cf-message-beads": { messages: MessagesSchema },
  "cf-location": { location: LocationDataSchema },
  "cf-voice-input": { transcription: TranscriptionDataSchema },
  "cf-tools-chip": { tools: ToolsArraySchema },
  "cf-map": {
    value: mapValueSchema,
    center: latLngSchema,
    bounds: boundsSchema,
    zoom: true,
  },
  "cf-code-editor": {
    value: stringSchema,
    mentionable: MentionableArraySchema,
    mentioned: MentionableArraySchema,
    references: MentionRefMapSchema,
  },
  "cf-profile-badge": { profile: ProfileBadgeSchema },
  "cf-markdown": { content: true },
  "cf-fab": { previewMessage: stringSchema },
  "cf-theme": { theme: true },
  "cf-calendar": { value: true, markedDates: true },
  "cf-select": { value: true },
  "cf-radio-group": { value: true },
  "cf-modal": { open: true },
  "cf-file-download": { data: true, filename: true },
  "cf-prompt-input": { model: true },
  "cf-chart": { marks: true },
};

/** Schema choice shared with cf-autocomplete's single/multiple value binding. */
export function autocompleteValueSchema(multiple: boolean): JSONSchema {
  return multiple ? stringArraySchema : stringSchema;
}

/** Resolves explicit projections and controller defaults for a bound property. */
export function componentReadSchema(
  component: string,
  property: string,
  supplied: JSONSchema | undefined,
  props: Record<string, unknown>,
): JSONSchema | undefined {
  const declared = componentReadContracts[component]?.[property];
  if (declared === undefined) return undefined;
  if (
    (component === "cf-picker" && property === "items") ||
    component === "cf-profile-badge" || component === "cf-fab" ||
    (component === "cf-code-editor" && property !== "value")
  ) return declared;
  const schema = component === "cf-autocomplete" && property === "value"
    ? autocompleteValueSchema(props.multiple === true)
    : declared;
  return schema === true ? supplied ?? true : supplied || schema;
}
