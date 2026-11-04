/** Runtime schema shared by search results and inspected research records. */

import type { JSONSchema } from "@commonfabric/api";

/** Fields of the canonical trusted pattern record. */
export const TRUSTED_PATTERN_PROPERTIES = {
  patternId: { type: "string" },
  description: { type: "string" },
  hashtags: { type: "array", items: { type: "string" } },
  signals: {
    type: "object",
    properties: {
      uses: { type: "number" },
      score: { type: "number" },
      inherited: {
        type: "object",
        properties: {
          priorPatternId: { type: "string" },
          asOf: { type: "string" },
          events: { type: "object", additionalProperties: { type: "number" } },
          score: { type: "number" },
        },
        required: ["priorPatternId", "asOf", "events", "score"],
        additionalProperties: false,
        description:
          "Predecessor evidence included through publication; it does not describe runs of this exact generation.",
      },
    },
    required: ["uses", "score"],
    additionalProperties: false,
  },
  kind: {
    type: "string",
    enum: ["part", "app"],
    description:
      "Whether the published argument schema classifies the pattern as a reusable part or whole app.",
  },
  quality: {
    type: "string",
    enum: ["penalized", "unproven", "proven"],
    description:
      "Evidence tier from own and eligible inherited outcomes: penalized is net-negative, unproven has no recorded success, and proven has at least one recorded success or positive rating without a net-negative score. Proven can come entirely from predecessor evidence.",
  },
  matchedTerms: { type: "number" },
  queryTerms: { type: "number" },
  importHint: { type: "string" },
  argumentType: { type: "string" },
  resultType: { type: "string" },
  ownerDid: { type: "string" },
  createdAt: { type: "string" },
} satisfies Record<string, JSONSchema>;

/** Fields established by every trusted-record producer. */
export const TRUSTED_PATTERN_REQUIRED_FIELDS = [
  "patternId",
  "description",
  "hashtags",
  "importHint",
];
