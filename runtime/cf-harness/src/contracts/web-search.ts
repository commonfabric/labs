import type { JSONSchema } from "@commonfabric/api";

export const WEB_SEARCH_STRUCTURED_RESULT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank: { type: "number" },
          title: { type: "string" },
          url: { type: "string" },
          snippet: { type: "string" },
          publishedAt: { type: "string" },
          source: { type: "string" },
        },
        required: ["rank", "title", "url", "snippet"],
        additionalProperties: false,
      },
    },
    answerSummary: { type: "string" },
    limitations: { type: "string" },
  },
  required: ["query", "results"],
  additionalProperties: false,
} as const satisfies JSONSchema;
