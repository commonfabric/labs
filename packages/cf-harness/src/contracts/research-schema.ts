/** Runtime shapes shared by research synthesis and its public result contract. */

import type { JSONSchema } from "@commonfabric/api";
import {
  TRUSTED_PATTERN_PROPERTIES,
  TRUSTED_PATTERN_REQUIRED_FIELDS,
} from "./trusted-pattern-schema.ts";

const strings = {
  type: "array",
  items: { type: "string" },
} satisfies JSONSchema;
const label = {
  type: "object",
  properties: {
    confidentiality: { type: "array", items: {} },
    integrity: { type: "array", items: {} },
  },
  additionalProperties: false,
} satisfies JSONSchema;

/** Successful external handle bindings; empty is correct for self-contained recipes. */
export const RESEARCH_INPUTS_SCHEMA: JSONSchema = {
  type: "array",
  maxItems: 16,
  description:
    "Existing external data handles only. Every token must come from the authoritative inventory and must have a successful describe_handle result. Use [] when the recipe needs no external data; types, defaults, and new local state belong in the example instead.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200 },
      token: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description:
          "Exact opaque cfh token from a successful describe_handle result, never a type, default, literal, or raw Fabric reference.",
      },
      purpose: { type: "string", minLength: 1, maxLength: 1_000 },
    },
    required: ["name", "token", "purpose"],
    additionalProperties: false,
  },
};

/** API rules supported by exact read identities. */
export const RESEARCH_RULES_SCHEMA = {
  type: "array",
  maxItems: 24,
  items: {
    type: "object",
    properties: {
      rule: { type: "string", maxLength: 2_000 },
      sourceIds: {
        type: "array",
        maxItems: 12,
        items: { type: "string", maxLength: 500 },
      },
    },
    required: ["rule", "sourceIds"],
    additionalProperties: false,
  },
} satisfies JSONSchema;

/** Source availability and confidentiality are independent from kit completeness. */
export const RESEARCH_CFC_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    version: { type: "integer", enum: [1] },
    sourceLabel: label,
    outputLabel: label,
    coverage: { type: "string", enum: ["complete", "incomplete"] },
    missingLabels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source: {
            type: "string",
            enum: [
              "pattern-index-metadata",
              "pattern-index-source",
              "handle-description",
              "prior-research",
            ],
          },
          detail: { type: "string" },
        },
        required: ["source", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "version",
    "sourceLabel",
    "outputLabel",
    "coverage",
    "missingLabels",
  ],
  additionalProperties: false,
};

const syntax: JSONSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["valid", "invalid", "unavailable"] },
    scope: { type: "string", enum: ["syntax-only"] },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "number" },
          message: { type: "string" },
          line: { type: "number" },
          column: { type: "number" },
        },
        required: ["code", "message"],
        additionalProperties: false,
      },
    },
    detail: { type: "string" },
  },
  required: ["status", "scope", "diagnostics"],
  additionalProperties: false,
};
const rawSchema: JSONSchema = {
  anyOf: [{ type: "boolean" }, { type: "object", additionalProperties: true }],
};
const pattern: JSONSchema = {
  type: "object",
  properties: {
    ...TRUSTED_PATTERN_PROPERTIES,
    argumentSchema: rawSchema,
    resultSchema: rawSchema,
    main: { type: "string" },
    mainExport: { type: "string" },
    files: strings,
    sourceRoots: strings,
    dataFiles: strings,
    dependencies: strings,
    sourceIdentityVerified: { type: "boolean", enum: [true] },
    identityVerification: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["verified", "deferred"] },
        method: {
          type: "string",
          enum: ["light-entry-identity", "full-fabric-compiler"],
        },
        detail: { type: "string" },
      },
      required: ["status", "method"],
      additionalProperties: false,
    },
  },
  required: TRUSTED_PATTERN_REQUIRED_FIELDS,
  additionalProperties: false,
};
const source: JSONSchema = {
  type: "object",
  properties: {
    sourceId: { type: "string" },
    kind: {
      type: "string",
      enum: ["documentation", "pattern-metadata", "pattern-source"],
    },
    location: { type: "string" },
    documentTitle: { type: "string" },
    headingPath: strings,
    offset: { type: "number" },
    end: { type: "number" },
    totalChars: { type: "number" },
    digest: { type: "string" },
    integrity: strings,
    cfcLabel: label,
  },
  required: [
    "sourceId",
    "kind",
    "location",
    "offset",
    "end",
    "totalChars",
    "digest",
  ],
  additionalProperties: false,
};

const example: JSONSchema = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["run-pattern-input"] },
        content: { type: "string" },
        sourceIds: strings,
      },
      required: ["kind", "content", "sourceIds"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["pattern-source"] },
        content: { type: "string" },
        sourceIds: strings,
        syntax,
      },
      required: ["kind", "content", "sourceIds", "syntax"],
      additionalProperties: false,
    },
  ],
};

const legacyRecipe = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["complete", "incomplete"] },
    task: { type: "string" },
    summary: { type: "string" },
    recommendation: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["direct-run", "compose", "author", "focused-api"],
        },
        rationale: { type: "string" },
      },
      required: ["kind", "rationale"],
      additionalProperties: false,
    },
    inputs: RESEARCH_INPUTS_SCHEMA,
    patterns: { type: "array", items: pattern },
    steps: strings,
    example,
    rules: RESEARCH_RULES_SCHEMA,
    verification: strings,
    sources: { type: "array", items: source },
    missing: strings,
  },
  required: [
    "status",
    "task",
    "summary",
    "recommendation",
    "inputs",
    "patterns",
    "steps",
    "rules",
    "verification",
    "sources",
    "missing",
  ],
  additionalProperties: false,
} satisfies JSONSchema;

/** Findings share evidence contracts with saved implementation kits. */
const findings = {
  status: { type: "string", enum: ["complete", "incomplete"] },
  task: { type: "string" },
  summary: { type: "string", maxLength: 4_000 },
  inputs: RESEARCH_INPUTS_SCHEMA,
  patterns: { type: "array", items: pattern },
  rules: RESEARCH_RULES_SCHEMA,
  sources: { type: "array", items: source },
  missing: strings,
} satisfies Record<string, JSONSchema>;

/** Orientation candidates remain separate from inspected pattern records. */
const lead: JSONSchema = {
  type: "object",
  properties: {
    pattern,
    question: { type: "string", maxLength: 500 },
  },
  required: ["pattern", "question"],
  additionalProperties: false,
};

/** Public result variants; saved recipe kits may omit their purpose. */
export const RESEARCH_KIT_SCHEMA: JSONSchema = {
  oneOf: [legacyRecipe, {
    type: "object",
    properties: {
      ...findings,
      example,
      purpose: { type: "string", enum: ["answer"] },
    },
    required: [...Object.keys(findings), "purpose"],
    additionalProperties: false,
  }, {
    type: "object",
    properties: {
      ...findings,
      example,
      purpose: { type: "string", enum: ["orient"] },
      availableHandleTokens: strings,
      leads: { type: "array", maxItems: 3, items: lead },
      questions: {
        type: "array",
        maxItems: 3,
        items: { type: "string", maxLength: 500 },
      },
      refinedTask: { type: "string", maxLength: 2_000 },
    },
    required: [
      ...Object.keys(findings),
      "purpose",
      "leads",
      "questions",
      "availableHandleTokens",
    ],
    additionalProperties: false,
  }],
};
