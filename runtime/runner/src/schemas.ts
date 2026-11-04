/**
 * /!\ Shared between client and runtime threads.
 * /!\ Take care in only importing lightweight types,
 * /!\ interfaces and utilities.
 */

import { internSchema } from "@commonfabric/data-model-schema";

import { NAME, type Schema, UI } from "./shared.ts";

export const rendererVDOMSchema = internSchema(
  {
    $id: "https://commonfabric.org/schemas/vdom.json",
    $defs: {
      vdomRenderNode: {
        anyOf: [
          { $ref: "#/$defs/vdomNode" },
          { $ref: "#/$defs/vdomRenderableObject" },
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "undefined" },
          {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode", asCell: ["cell"] },
          },
        ],
      },
      vdomNode: {
        type: "object",
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          props: {
            type: "object",
            properties: {
              style: { anyOf: [{ type: "object" }, { type: "string" }] },
              $value: { asCell: ["cell"], type: "unknown" },
            },
            additionalProperties: {
              anyOf: [{
                type: "string",
              }, {
                type: "number",
              }, {
                type: "boolean",
              }, {
                type: "null",
              }, {
                type: "undefined",
              }, {
                type: "object",
                properties: {}, // stop query from descending
              }, {
                type: "array",
                items: { type: "null" }, // stop query from descending
              }, {
                asCell: ["stream"],
                type: "unknown",
              }],
            },
            asCell: ["cell"],
          },
          children: {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode", asCell: ["cell"] },
            asCell: ["cell"],
          },
          [UI]: { $ref: "#/$defs/vdomNode" },
        },
        required: ["type", "name"],
      },
      vdomRenderableObject: {
        type: "object",
        properties: {
          [UI]: { $ref: "#/$defs/vdomNode" },
        },
        required: [UI],
      },
    },
    $ref: "#/$defs/vdomRenderNode",
  },
);

/**
 * Debug variant of rendererVDOMSchema.
 * Children expand inline (no asCell) so the full tree is readable in one .get().
 * Props keep asCell since prop values can be large and aren't needed for structural debugging.
 */
export const debugVDOMSchema = internSchema(
  {
    $id: "https://commonfabric.org/schemas/vdom-debug.json",
    $defs: {
      vdomRenderNode: {
        anyOf: [
          { $ref: "#/$defs/vdomNode" },
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
          { type: "undefined" },
          {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode" },
          },
        ],
      },
      vdomNode: {
        type: "object",
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          props: {
            type: "object",
            additionalProperties: { asCell: ["cell"] },
          },
          children: {
            type: "array",
            items: { $ref: "#/$defs/vdomRenderNode" },
          },
          [UI]: { $ref: "#/$defs/vdomNode" },
        },
      },
    },
    $ref: "#/$defs/vdomNode",
  },
);

export const vnodeSchema = internSchema(
  {
    $id: "https://commonfabric.org/schemas/vnode.json",
    $ref: "#/$defs/VNode",
    $defs: {
      UIRenderable: {
        type: "object",
        properties: {
          $UI: {
            $ref: "#/$defs/VNode",
          },
        },
        required: ["$UI"],
      },
      VNode: {
        type: "object",
        properties: {
          type: {
            type: "string",
            "enum": ["vnode"],
          },
          name: {
            type: "string",
          },
          props: {
            $ref: "#/$defs/Props",
          },
          children: {
            $ref: "#/$defs/RenderNode",
          },
          $UI: {
            $ref: "#/$defs/VNode",
          },
        },
        required: ["type", "name", "props"],
      },
      RenderNode: {
        anyOf: [{
          type: "string",
        }, {
          type: "number",
        }, {
          type: "boolean",
        }, {
          $ref: "#/$defs/VNode",
        }, {
          type: "object",
          properties: {},
        }, {
          $ref: "#/$defs/UIRenderable",
        }, {
          type: "object",
          properties: {},
        }, {
          type: "array",
          items: {
            $ref: "#/$defs/RenderNode",
          },
        }, {
          type: "null",
        }, {
          type: "undefined",
        }],
      },
      Props: {
        type: "object",
        properties: {
          style: { anyOf: [{ type: "object" }, { type: "string" }] },
        },
        additionalProperties: {
          anyOf: [
            {
              type: "string",
            },
            {
              type: "number",
            },
            {
              type: "boolean",
            },
            {
              type: "object",
              properties: {}, // stop query from descending
            },
            {
              type: "array",
              items: { type: "null" }, // stop query from descending
            }, // this was generated, but is a bit problematic to have
            //    both cell and stream, since both will always match.
            {
              asCell: ["cell"],
            },
            {
              asCell: ["stream"],
            },
            {
              type: "null",
            },
            {
              type: "undefined",
            },
          ],
        },
      },
    },
  },
);

export const nameSchema = internSchema(
  {
    type: "object",
    properties: { [NAME]: { type: "string" } },
    required: [NAME],
  },
);

export type NameSchema = Schema<typeof nameSchema>;

/** Piece chrome and the opaque UI tip; mounted renderers own deeper reads. */
export const viewPieceSchema = internSchema({
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    [UI]: { type: "unknown", asCell: ["cell"] },
  },
});

// The renderer schema placed under a property: its `$defs` move to the
// wrapper's root, which is where its `#/$defs/<name>` refs point once it
// sits below another root, and its `$id` stays off the wrapper, which is
// one document with the wrapper's identity.
const {
  $defs: rendererVDOMDefinitions,
  $id: _rendererVDOMId,
  ...rendererVDOMRoot
} = rendererVDOMSchema;

export const uiSchema = internSchema(
  {
    type: "object",
    properties: { [UI]: rendererVDOMRoot },
    required: [UI],
    $defs: rendererVDOMDefinitions,
  },
);

export type UISchema = Schema<typeof uiSchema>;

// We specify type unknown for the items, since we don't want to recursively
// load them
export const pieceListSchema = internSchema(
  {
    type: "array",
    items: { type: "unknown", asCell: ["cell"] },
    default: [],
  },
);

export const pieceLineageSchema = internSchema(
  {
    type: "object",
    properties: {
      piece: { type: "object", properties: {}, asCell: ["cell"] },
      relation: { type: "string" },
      timestamp: { type: "number" },
    },
    required: ["piece", "relation", "timestamp"],
  },
);
export type PieceLineage = Schema<typeof pieceLineageSchema>;

export const pieceSourceCellSchema = internSchema(
  {
    type: "object",
    properties: {
      spell: { type: "object", asCell: ["readonly"] },
      lineage: {
        type: "array",
        items: pieceLineageSchema,
        default: [],
      },
      llmRequestId: { type: "string" },
    },
  },
);

export const processSchema = internSchema(
  {
    type: "object",
    properties: {
      argument: { type: "object" },
      pattern: { type: "object", asCell: ["readonly"] },
    },
  },
);

export const processLinkSchema = internSchema(
  {
    type: "object",
    properties: {
      pattern: { type: "object", asCell: ["readonly"] },
      resultRef: { type: "object", asCell: ["cell"] },
      // phase this out in favor of pattern
      spell: { type: "object", asCell: ["readonly"] },
    },
  },
);

// Primitive schemas for UI component cell bindings
export const stringSchema = internSchema(
  { type: "string" },
);
export const booleanSchema = internSchema(
  { type: "boolean" },
);
export const numberSchema = internSchema(
  { type: "number" },
);
export const stringArraySchema = internSchema(
  {
    type: "array",
    items: { type: "string" },
  },
);
