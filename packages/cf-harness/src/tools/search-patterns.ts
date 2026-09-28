/**
 * The `search_patterns` tool: what the model asks to find a pattern someone
 * already published rather than write one.
 *
 * A hit is metadata and shapes — a description, its hashtags, what the index
 * has seen it used for, the argument and result types to wire against, and
 * the `cf:pattern:` specifier that composes it. Never source. That is the
 * whole boundary this tool keeps: a model composes a published pattern by
 * naming it, and runs it by handing its id to `run_pattern`, so it needs to
 * know what a pattern is for and what it takes, and never what it says.
 */

import type { JSONSchema } from "@commonfabric/api";
import { TRUSTED_PATTERN_PROPERTIES } from "../contracts/trusted-pattern-schema.ts";
import { schemaToTypeString } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { TrustedPatternRecord } from "../contracts/trusted-pattern.ts";
import type {
  PatternIndexClient,
  PatternIndexPatternKind,
  PatternIndexQuality,
} from "../pattern-index/client.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface SearchPatternsToolInput {
  tags?: readonly string[];
  text?: string;
}

/** Hits reported to the model. Beyond this the model narrows its query. */
export const SEARCH_PATTERNS_MAX_RESULTS = 10;

/**
 * Hits whose declared shapes are fetched. Each costs one `getPattern` round
 * trip, and the shapes are what the model needs to decide between the leading
 * candidates rather than to skim the tail.
 */
export const SEARCH_PATTERNS_MAX_DETAILED_RESULTS = 5;

export interface SearchPatternsToolResult extends TrustedPatternRecord {
  /** Whether its published argument schema classifies it as a part or app. */
  kind: PatternIndexPatternKind;

  /** Evidence tier the index computed from recorded run outcomes. */
  quality: PatternIndexQuality;

  /**
   * With a text query: how many stopword-free terms this hit carries, out of
   * `queryTerms`. Matching is disjunctive and ranked — a hit with a low ratio
   * is a distant cousin, not an answer.
   */
  matchedTerms?: number;

  queryTerms?: number;

  /**
   * The import specifier this pattern is composed through, written out so it
   * can be copied into pattern source as it stands.
   */
  importHint: string;
}

export type { TrustedPatternRecord } from "../contracts/trusted-pattern.ts";

export interface SearchPatternsToolSuccessOutput {
  outputId: string;
  status: "ok";
  results: readonly SearchPatternsToolResult[];
}

export interface SearchPatternsToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type SearchPatternsToolOutput =
  | SearchPatternsToolSuccessOutput
  | SearchPatternsToolErrorOutput;

const isSearchPatternsToolResult = (
  result: unknown,
): result is SearchPatternsToolResult => {
  if (!isObjectNotArray(result)) {
    return false;
  }
  const record = result as Record<string, unknown>;
  const signals = record.signals;
  return typeof record.patternId === "string" &&
    typeof record.description === "string" &&
    Array.isArray(record.hashtags) &&
    record.hashtags.every((hashtag) => typeof hashtag === "string") &&
    (signals === undefined ||
      (isObjectNotArray(signals) && "uses" in signals &&
        typeof signals.uses === "number" && "score" in signals &&
        typeof signals.score === "number")) &&
    (record.kind === "part" || record.kind === "app") &&
    (record.quality === "penalized" || record.quality === "unproven" ||
      record.quality === "proven") &&
    (record.matchedTerms === undefined ||
      typeof record.matchedTerms === "number") &&
    (record.queryTerms === undefined ||
      typeof record.queryTerms === "number") &&
    typeof record.importHint === "string" &&
    (record.argumentType === undefined ||
      typeof record.argumentType === "string") &&
    (record.resultType === undefined || typeof record.resultType === "string");
};

/** Narrows a raw tool result to a successful search response. */
export const isSearchPatternsToolSuccessOutput = (
  output: unknown,
): output is SearchPatternsToolSuccessOutput => {
  if (!isObjectNotArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  return typeof record.outputId === "string" && record.status === "ok" &&
    Array.isArray(record.results) &&
    record.results.every(isSearchPatternsToolResult);
};

export const searchPatternsToolDescriptor: HarnessToolDescriptor = {
  toolId: "search_patterns",
  title: "Search Patterns",
  description:
    "Search the pattern index for published Common Fabric patterns by hashtag or free text. Answers with each pattern's id, kind, evidence quality, description, import specifier, and stopword-free match ratio; the leading results also carry declared argument and result shapes — never source. Run one with run_pattern's patternId argument.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "Hashtags to match. Any supplied hashtag can surface a result. Omit to search on text alone.",
      },
      text: {
        type: "string",
        description:
          "A short set of distinctive capability words. English stopwords are removed, then whole words are matched with light suffix handling against pattern descriptions, keywords, and hashtags. One content term can surface a result; adding generic words adds distant OR matches. Results carry matchedTerms out of the stopword-free queryTerms. Omit to search on tags alone.",
      },
    },
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    oneOf: [{
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["ok"] },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: TRUSTED_PATTERN_PROPERTIES,
            required: [
              "patternId",
              "description",
              "hashtags",
              "kind",
              "quality",
              "importHint",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["outputId", "status", "results"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        outputId: { type: "string" },
        status: { type: "string", enum: ["error"] },
        message: { type: "string" },
      },
      required: ["outputId", "status", "message"],
      additionalProperties: false,
    }],
  } satisfies JSONSchema,
  tags: ["fabric", "pattern", "search"],
};

/**
 * The specifier that composes a published pattern into pattern source. The
 * `cf:pattern:` scheme addresses the index entry, so a composing pattern
 * names what it depends on rather than copying it.
 */
export const patternIndexImportHint = (patternId: string): string =>
  `import X from "cf:pattern:${patternId}"`;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Renders a declared schema as a TypeScript type, or `undefined` when the
 * pattern declares none. A schema that cannot be rendered is reported as
 * absent: the search answers with what is known, and a shape it cannot write
 * down is not known.
 *
 * A definition the rendering refers to by name — the formatter names any
 * definition too long to inline, `rows: LedgerTransaction[]` — is written out
 * after it as `type Name = …`, and so is every definition those refer to, so
 * the fields a composing author needs are in the type rather than behind a
 * name nothing here defines.
 */
export const patternIndexDeclaredType = (
  schema: JSONSchema | undefined,
): string | undefined => {
  if (schema === undefined) {
    return undefined;
  }
  try {
    const defs = declaredDefinitions(schema);
    const rendered = [{ schema, text: schemaToTypeString(schema, { defs }) }];
    const written = new Set<string>();
    for (let index = 0; index < rendered.length; index++) {
      const { schema: from, text } = rendered[index];
      // Only a `$ref` the schema actually holds can name a definition, and
      // only a name the text prints was left uninlined by the formatter.
      for (const name of referencedDefinitions(from)) {
        if (
          written.has(name) || !Object.hasOwn(defs, name) ||
          !namesType(text, name)
        ) {
          continue;
        }
        written.add(name);
        rendered.push({
          schema: defs[name],
          text: `type ${name} = ${schemaToTypeString(defs[name], { defs })}`,
        });
      }
    }
    return rendered.map((entry) => entry.text).join("\n");
  } catch {
    return undefined;
  }
};

/** The `$defs` a schema declares, empty when it declares none. */
const declaredDefinitions = (
  schema: JSONSchema,
): Record<string, JSONSchema> => {
  const defs = typeof schema === "object" && schema !== null
    ? (schema as { $defs?: unknown }).$defs
    : undefined;
  return typeof defs === "object" && defs !== null && !Array.isArray(defs)
    ? defs as Record<string, JSONSchema>
    : {};
};

/** The definition names `schema`'s own `$ref`s point at, its `$defs` aside. */
const referencedDefinitions = (schema: JSONSchema): string[] => {
  const { $defs: _defs, ...body } = typeof schema === "object" &&
      schema !== null
    ? schema as Record<string, unknown>
    : {};
  return [
    ...JSON.stringify(body).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g),
  ].map((match) => match[1]);
};

/** Whether `rendered` uses `name` as a whole identifier. */
const namesType = (rendered: string, name: string): boolean =>
  new RegExp(
    `(^|[^A-Za-z0-9_$])${
      name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }(?![A-Za-z0-9_$])`,
  ).test(rendered);

export const searchPatternsTool: HarnessToolDefinition<
  SearchPatternsToolInput,
  SearchPatternsToolOutput
> = {
  descriptor: searchPatternsToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("search_patterns");
    const errorOutput = (message: string): SearchPatternsToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getPatternIndexClient === undefined) {
      return errorOutput(
        "search_patterns requires a pattern index; configure --pattern-index-url",
      );
    }
    if (input.tags === undefined && input.text === undefined) {
      return errorOutput("search_patterns requires tags, text, or both");
    }
    let client: PatternIndexClient;
    try {
      client = await context.getPatternIndexClient();
    } catch (error) {
      return errorOutput(`pattern index unavailable: ${errorMessage(error)}`);
    }
    let response;
    try {
      response = await client.searchPatterns({
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.text !== undefined ? { text: input.text } : {}),
        limit: SEARCH_PATTERNS_MAX_RESULTS,
      });
    } catch (error) {
      return errorOutput(errorMessage(error));
    }
    const hits = response.results.slice(0, SEARCH_PATTERNS_MAX_RESULTS);
    // The declared shapes ride on the pattern record rather than on a search
    // hit, so the leading candidates are read back individually. Source is
    // deliberately not requested: what a pattern is FOR and what it takes and
    // returns is what a composing model needs, and its source is neither.
    const detailed = await Promise.all(
      hits.slice(0, SEARCH_PATTERNS_MAX_DETAILED_RESULTS).map(async (hit) => {
        try {
          return await client.getPattern({
            patternId: hit.patternId,
            includeSource: false,
          });
        } catch {
          // A shape that could not be read leaves the hit reported without
          // one; the search itself succeeded.
          return undefined;
        }
      }),
    );
    const results = hits.map((hit, index): SearchPatternsToolResult => {
      const pattern = detailed[index];
      const argumentType = patternIndexDeclaredType(pattern?.argumentSchema);
      const resultType = patternIndexDeclaredType(pattern?.resultSchema);
      return {
        patternId: hit.patternId,
        description: hit.description,
        hashtags: hit.hashtags,
        ...(hit.signals !== undefined ? { signals: hit.signals } : {}),
        kind: hit.kind,
        quality: hit.quality,
        ...(hit.matchedTerms !== undefined && hit.queryTerms !== undefined
          ? { matchedTerms: hit.matchedTerms, queryTerms: hit.queryTerms }
          : {}),
        importHint: patternIndexImportHint(hit.patternId),
        ...(argumentType !== undefined ? { argumentType } : {}),
        ...(resultType !== undefined ? { resultType } : {}),
      };
    });
    return { outputId, status: "ok", results };
  },
};
