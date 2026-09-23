/**
 * Admits model-proposed implementation kits against exact host evidence.
 * Syntax and citation checks live here independently of research execution.
 */

import type { JSONSchema } from "@commonfabric/api";
import {
  RESEARCH_INPUTS_SCHEMA,
  RESEARCH_RULES_SCHEMA,
} from "../contracts/research-schema.ts";
import { ensureCompilerStack } from "@commonfabric/runner";

import type {
  HarnessResearchExample,
  HarnessResearchHandleRecord,
  HarnessResearchInputBinding,
  HarnessResearchKit,
  HarnessResearchPatternRecord,
  HarnessResearchPurpose,
  HarnessResearchRecommendationKind,
  HarnessResearchResult,
  HarnessResearchRule,
  HarnessResearchSourceRead,
  HarnessResearchStatus,
  HarnessResearchSyntaxCheck,
} from "../contracts/research.ts";
import { errorMessage } from "../error-message.ts";
import { RUN_PATTERN_INPUT_SCHEMA } from "../contracts/run-pattern.ts";
import { validateStructuredResultValue } from "../structured-result.ts";
import { objectValue, stringList, stringValue, unique } from "./model-value.ts";

/** Largest complete code or invocation example admitted to a kit. */
export const MAX_RESEARCH_EXAMPLE_CHARS = 24_000;

/** Untrusted fields proposed by a research model at the JSON boundary. */
export interface RawResearchResult {
  status?: unknown;
  summary?: unknown;
  recommendation?: unknown;
  inputs?: unknown;
  selectedPatternIds?: unknown;
  steps?: unknown;
  example?: unknown;
  rules?: unknown;
  verification?: unknown;
  sourceIds?: unknown;
  missing?: unknown;
  leads?: unknown;
  questions?: unknown;
}

/** Host observations against which a proposed kit is admitted. */
export interface ResearchAdmissionEvidence {
  /** Exact reads completed in this research call. */
  sourceReads: readonly HarnessResearchSourceRead[];

  /** Current general handles, including those not described by this call. */
  handleTokens?: readonly string[];

  /** Pattern identities confirmed by indexed inspection. */
  confirmedPatterns: ReadonlyMap<string, HarnessResearchPatternRecord>;

  /** Successful descriptions of the available general handles. */
  describedHandles: ReadonlyMap<string, HarnessResearchHandleRecord>;

  /** Uninspected metadata returned by the index search. */
  searchedPatterns?: ReadonlyMap<string, HarnessResearchPatternRecord>;
}

/** JSON result requested from the private research model. */
export const RESEARCH_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["complete", "incomplete"] },
    summary: { type: "string", maxLength: 2_000 },
    recommendation: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["direct-run", "compose", "author", "focused-api"],
        },
        rationale: { type: "string", maxLength: 2_000 },
      },
      required: ["kind", "rationale"],
      additionalProperties: false,
    },
    inputs: RESEARCH_INPUTS_SCHEMA,
    selectedPatternIds: {
      description:
        "Inspected patterns selected as reusable building blocks for this goal. The author must import each selection or give a one-line reason for omitting it. Do not select a pattern only as a specification to rewrite; explain a capability mismatch in the findings instead.",
      type: "array",
      maxItems: 8,
      items: { type: "string", maxLength: 200 },
    },
    steps: {
      type: "array",
      maxItems: 24,
      items: { type: "string", maxLength: 2_000 },
    },
    example: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["run-pattern-input", "pattern-source"],
        },
        content: { type: "string", maxLength: MAX_RESEARCH_EXAMPLE_CHARS },
        sourceIds: {
          type: "array",
          maxItems: 16,
          description:
            "Exact opened reads supporting every API shown in the example, including APIs mentioned in comments.",
          items: { type: "string", maxLength: 500 },
        },
      },
      required: ["kind", "content", "sourceIds"],
      additionalProperties: false,
    },
    rules: RESEARCH_RULES_SCHEMA,
    verification: {
      type: "array",
      maxItems: 24,
      items: { type: "string", maxLength: 2_000 },
    },
    sourceIds: {
      type: "array",
      maxItems: 32,
      items: { type: "string", maxLength: 500 },
    },
    missing: {
      type: "array",
      maxItems: 24,
      description:
        "Actual blockers only. Make routine reversible assumptions in the smallest complete recipe instead of listing optional product choices as missing.",
      items: { type: "string", maxLength: 2_000 },
    },
  },
  required: [
    "status",
    "summary",
    "recommendation",
    "inputs",
    "selectedPatternIds",
    "steps",
    "rules",
    "verification",
    "sourceIds",
    "missing",
  ],
  additionalProperties: false,
} satisfies JSONSchema;

/** Requests only the fields needed for the caller's chosen scope. */
export const researchResultSchema = (
  purpose: HarnessResearchPurpose | undefined,
): JSONSchema => {
  if (purpose === undefined) return RESEARCH_RESULT_SCHEMA;
  const schema = RESEARCH_RESULT_SCHEMA;
  const fields = [
    "status",
    "summary",
    "inputs",
    "rules",
    "sourceIds",
    "missing",
  ] as const;
  const properties: Record<string, JSONSchema> = Object.fromEntries(
    fields.map((key) => [key, schema.properties[key]]),
  );
  properties.rules = {
    ...RESEARCH_RULES_SCHEMA,
    maxItems: 12,
  };
  properties.missing = {
    type: "array",
    maxItems: 4,
    items: { type: "string", maxLength: 500 },
  };
  properties.selectedPatternIds = schema.properties.selectedPatternIds;
  properties.summary = { type: "string", maxLength: 4_000 };
  properties.example = {
    oneOf: [{
      type: "object",
      properties: {
        kind: { type: "string", enum: ["run-pattern-input"] },
        invocation: RUN_PATTERN_INPUT_SCHEMA,
        sourceIds: schema.properties.example.properties.sourceIds,
      },
      required: ["kind", "invocation", "sourceIds"],
      additionalProperties: false,
    }, {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["pattern-source"] },
        content: {
          type: "string",
          maxLength: MAX_RESEARCH_EXAMPLE_CHARS,
        },
        sourceIds: schema.properties.example.properties.sourceIds,
      },
      required: ["kind", "content", "sourceIds"],
      additionalProperties: false,
    }],
  };
  if (purpose === "orient") {
    properties.leads = {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          patternId: { type: "string" },
          question: { type: "string", maxLength: 500 },
        },
        required: ["patternId", "question"],
        additionalProperties: false,
      },
    };
    properties.questions = {
      type: "array",
      maxItems: 3,
      items: { type: "string", maxLength: 500 },
    };
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties).filter((key) => key !== "example"),
    additionalProperties: false,
  };
};

const citedSourceIds = (raw: RawResearchResult): string[] =>
  unique([
    ...stringList(raw.sourceIds, 32, 500),
    ...stringList(objectValue(raw.example).sourceIds, 16, 500),
    ...(Array.isArray(raw.rules) ? raw.rules : []).flatMap((rule) =>
      stringList(objectValue(rule).sourceIds, 12, 500)
    ),
  ]);

/** Returns claimed citations absent from the current call's exact reads. */
export const unreadSourceIds = (
  raw: RawResearchResult,
  state: ResearchAdmissionEvidence,
): string[] => {
  const opened = new Set(state.sourceReads.map((read) => read.sourceId));
  return citedSourceIds(raw).filter((id) => !opened.has(id));
};

const parseInputs = (
  value: unknown,
  described: ReadonlyMap<string, HarnessResearchHandleRecord>,
  missing: string[],
): HarnessResearchInputBinding[] => {
  const result: HarnessResearchInputBinding[] = [];
  for (const entry of Array.isArray(value) ? value.slice(0, 16) : []) {
    const record = objectValue(entry);
    const token = stringValue(record.token, 200);
    if (token.length === 0) {
      missing.push("an input binding has no nonempty handle token");
      continue;
    }
    if (!described.has(token)) {
      missing.push(`handle ${token} was not described`);
      continue;
    }
    const name = stringValue(record.name, 200).trim();
    if (name.length === 0) {
      missing.push(`handle ${token} has no nonempty input name`);
      continue;
    }
    const purpose = stringValue(record.purpose, 1_000).trim();
    if (purpose.length === 0) {
      missing.push(`handle ${token} has no nonempty binding purpose`);
      continue;
    }
    result.push({
      name,
      token,
      purpose,
    });
  }
  return result;
};

const parseRules = (
  value: unknown,
  sources: ReadonlyMap<string, HarnessResearchSourceRead>,
  missing: string[],
): HarnessResearchRule[] => {
  const rules: HarnessResearchRule[] = [];
  for (const entry of Array.isArray(value) ? value.slice(0, 24) : []) {
    const record = objectValue(entry);
    const cited = unique(stringList(record.sourceIds, 12, 500));
    const admitted = cited.filter((id) => sources.has(id));
    if (admitted.length !== cited.length) {
      missing.push("one or more API rules cited an unread source");
    }
    if (admitted.length === 0) continue;
    rules.push({ rule: stringValue(record.rule), sourceIds: admitted });
  }
  return rules;
};

/** Checks TypeScript/TSX grammar without resolving, checking, or executing it. */
const checkPatternSourceSyntax = async (
  content: string,
): Promise<HarnessResearchSyntaxCheck> => {
  try {
    const { ts } = await ensureCompilerStack();
    const result = ts.transpileModule(content, {
      fileName: "/research-example.tsx",
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
      },
    });
    const diagnostics = (result.diagnostics ?? [])
      .filter((diagnostic) =>
        diagnostic.category === ts.DiagnosticCategory.Error
      )
      .map((diagnostic) => {
        const location = diagnostic.file !== undefined &&
            diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : undefined;
        return {
          code: diagnostic.code,
          message: ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            "\n",
          ),
          ...(location !== undefined
            ? { line: location.line + 1, column: location.character + 1 }
            : {}),
        };
      });
    return {
      status: diagnostics.length === 0 ? "valid" : "invalid",
      scope: "syntax-only",
      diagnostics,
    };
  } catch (error) {
    return {
      status: "unavailable",
      scope: "syntax-only",
      diagnostics: [],
      detail: errorMessage(error),
    };
  }
};

const syntaxDiagnosticText = (
  diagnostic: HarnessResearchSyntaxCheck["diagnostics"][number],
): string => {
  const location = diagnostic.line === undefined ||
      diagnostic.column === undefined
    ? ""
    : ` at ${diagnostic.line}:${diagnostic.column}`;
  return `TS${diagnostic.code}${location}: ${diagnostic.message}`;
};

const parseExample = async (
  value: unknown,
  sources: ReadonlyMap<string, HarnessResearchSourceRead>,
  missing: string[],
  patterns: readonly HarnessResearchPatternRecord[],
): Promise<HarnessResearchExample | undefined> => {
  const record = objectValue(value);
  const kind = record.kind;
  const content =
    kind === "run-pattern-input" && record.invocation !== undefined
      ? JSON.stringify(record.invocation)
      : typeof record.content === "string"
      ? record.content
      : "";
  if (
    (kind !== "run-pattern-input" && kind !== "pattern-source") ||
    content.length === 0
  ) return undefined;
  if (content.length > MAX_RESEARCH_EXAMPLE_CHARS) {
    missing.push(
      `complete example exceeds ${MAX_RESEARCH_EXAMPLE_CHARS} characters`,
    );
    return undefined;
  }
  const cited = unique(stringList(record.sourceIds, 16, 500));
  const admitted = cited.filter((id) => sources.has(id));
  if (admitted.length !== cited.length) {
    missing.push("the example cited one or more unread sources");
  }
  if (admitted.length === 0) {
    missing.push("the example has no exact opened source supporting its APIs");
  }
  if (kind === "run-pattern-input") {
    try {
      const invocation: unknown = JSON.parse(content);
      validateStructuredResultValue({
        schema: RUN_PATTERN_INPUT_SCHEMA,
        value: invocation,
      });
      const fields = objectValue(invocation);
      if (
        fields.sourceText !== undefined ||
        !patterns.some((pattern) => pattern.patternId === fields.patternId)
      ) {
        throw new Error(
          "the invocation must name one selected patternId and omit sourceText",
        );
      }
    } catch (error) {
      missing.push(
        `run-pattern-input example is invalid: ${errorMessage(error)}`,
      );
    }
    return { kind, content, sourceIds: admitted };
  }
  const syntax = await checkPatternSourceSyntax(content);
  if (syntax.status === "invalid") {
    for (const diagnostic of syntax.diagnostics) {
      missing.push(
        `pattern-source example has a syntax error: ${
          syntaxDiagnosticText(diagnostic)
        }`,
      );
    }
  } else if (syntax.status === "unavailable") {
    missing.push(
      `pattern-source syntax check was unavailable: ${
        syntax.detail ?? "unknown error"
      }`,
    );
  }
  return { kind, content, sourceIds: admitted, syntax };
};

/** Closes the source catalog and admits only observed patterns and bindings. */
const admitEvidence = (
  raw: RawResearchResult,
  state: ResearchAdmissionEvidence,
  selectPatterns = true,
) => {
  const missing = stringList(raw.missing);
  const sourceMap = new Map(
    state.sourceReads.map((read) => [read.sourceId, read]),
  );
  const citedIds = citedSourceIds(raw);
  const sources = citedIds.flatMap((id) => {
    const read = sourceMap.get(id);
    if (read === undefined) {
      missing.push(`source ${id} was not read`);
      return [];
    }
    return [structuredClone(read)];
  });
  const selectedIds = selectPatterns
    ? unique(stringList(raw.selectedPatternIds, 8, 500))
    : [];
  const patterns = selectedIds.flatMap((id) => {
    const pattern = state.confirmedPatterns.get(id);
    if (pattern === undefined) {
      missing.push(`pattern ${id} was not inspected successfully`);
      return [];
    }
    return [structuredClone(pattern)];
  });
  const inputs = parseInputs(raw.inputs, state.describedHandles, missing);
  const rules = parseRules(raw.rules, sourceMap, missing);
  return { missing, sourceMap, sources, patterns, inputs, rules };
};

/** Returns an admitted kit with explicit blockers for unsupported claims. */
export const admitResearchKit = async (
  task: string,
  raw: RawResearchResult,
  state: ResearchAdmissionEvidence,
): Promise<HarnessResearchKit> => {
  const { missing, sourceMap, sources, patterns, inputs, rules } =
    admitEvidence(raw, state);
  const recommendationRecord = objectValue(raw.recommendation);
  const kindValue = recommendationRecord.kind;
  const kind: HarnessResearchRecommendationKind =
    kindValue === "direct-run" || kindValue === "compose" ||
      kindValue === "author" || kindValue === "focused-api"
      ? kindValue
      : "author";
  const example = await parseExample(raw.example, sourceMap, missing, patterns);
  if ((kind === "direct-run" || kind === "compose") && patterns.length === 0) {
    missing.push(`${kind} requires an inspected published pattern`);
  }
  if (
    (kind === "direct-run" || kind === "compose") &&
    patterns.some((pattern) => pattern.sourceIdentityVerified !== true)
  ) {
    missing.push(`${kind} requires verified published source identities`);
  }
  if (kind === "direct-run" && example?.kind !== "run-pattern-input") {
    missing.push("direct-run requires a complete run_pattern input example");
  }
  if (
    (kind === "compose" || kind === "author") &&
    example?.kind !== "pattern-source"
  ) {
    missing.push(`${kind} requires a complete pattern-source example`);
  }
  if (kind === "focused-api" && rules.length === 0) {
    missing.push("focused-api requires at least one cited rule");
  }
  if (sources.length === 0) {
    missing.push(
      "no exact documentation or indexed-source read supports the kit",
    );
  }
  const dedupedMissing = unique(missing.filter((entry) => entry.length > 0));
  const requestedStatus: HarnessResearchStatus = raw.status === "complete"
    ? "complete"
    : "incomplete";
  const status: HarnessResearchStatus =
    requestedStatus === "complete" && dedupedMissing.length === 0
      ? "complete"
      : "incomplete";
  return {
    status,
    task,
    summary: stringValue(raw.summary),
    recommendation: {
      kind,
      rationale: stringValue(recommendationRecord.rationale),
    },
    inputs,
    patterns,
    steps: stringList(raw.steps),
    ...(example !== undefined ? { example } : {}),
    rules,
    verification: stringList(raw.verification),
    sources,
    missing: dedupedMissing,
  };
};

/** Admits a scoped result through the same exact evidence and binding checks. */
export const admitResearchResult = async (
  task: string,
  raw: RawResearchResult,
  state: ResearchAdmissionEvidence,
  purpose?: HarnessResearchPurpose,
): Promise<HarnessResearchResult> => {
  if (purpose !== undefined) {
    validateStructuredResultValue({
      schema: researchResultSchema(purpose),
      value: raw,
    });
  }
  if (purpose === undefined) return await admitResearchKit(task, raw, state);
  const { missing, sourceMap, sources, inputs, rules, patterns } =
    admitEvidence(raw, state);
  const example = await parseExample(raw.example, sourceMap, missing, patterns);
  if (patterns.some((pattern) => pattern.sourceIdentityVerified !== true)) {
    missing.push(
      "selected patterns require verified published source identities",
    );
  }
  if (
    purpose === "answer" && rules.length === 0 && inputs.length === 0 &&
    example === undefined
  ) {
    missing.push(
      "an answer requires a cited fact or a successfully described input",
    );
  }
  const leads = purpose === "orient"
    ? (Array.isArray(raw.leads) ? raw.leads : []).slice(0, 3).flatMap(
      (entry) => {
        const candidate = objectValue(entry);
        const id = stringValue(candidate.patternId, 500);
        const record = state.searchedPatterns?.get(id);
        if (record === undefined) {
          missing.push(
            `candidate ${id} was not returned by index search or task attachments`,
          );
          return [];
        }
        return [{
          pattern: structuredClone(record),
          question: stringValue(candidate.question, 500),
        }];
      },
    )
    : [];
  const findings = {
    status: raw.status === "complete" && missing.length === 0
      ? "complete" as const
      : "incomplete" as const,
    task,
    summary: stringValue(raw.summary, 4_000),
    ...(example === undefined ? {} : { example }),
    inputs,
    patterns,
    rules,
    sources,
    missing: unique(missing),
  };
  return purpose === "answer" ? { ...findings, purpose } : {
    ...findings,
    purpose,
    leads,
    availableHandleTokens: [...(state.handleTokens ?? [])],
    questions: stringList(raw.questions, 3, 500),
  };
};
