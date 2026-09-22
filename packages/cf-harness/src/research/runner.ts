/**
 * Runs bounded private Common Fabric research and admits implementation kits
 * against exact host observations. The full derivation is returned separately
 * so callers can keep private evidence out of model context.
 */

import { encodeHex } from "@std/encoding/hex";
import { sha256 } from "@commonfabric/content-hash";
import {
  computeEntryIdentity,
  ensureCompilerStack,
} from "@commonfabric/runner";
import type { IFCLabel } from "@commonfabric/runner/cfc";
import { mergeLabel } from "@commonfabric/runner/cfc/label-view-core";

import type {
  HarnessResearchCfcProjection,
  HarnessResearchHandleRecord,
  HarnessResearchMissingLabel,
  HarnessResearchMissingLabelSource,
  HarnessResearchPatternRecord,
  HarnessResearchPurpose,
  HarnessResearchResult,
  HarnessResearchRunSummary,
  HarnessResearchSourceRead,
} from "../contracts/research.ts";
import {
  cloneIfcLabel,
  confidentialityOnlyIfcLabel,
} from "../contracts/cfc-model-context.ts";
import type { TrustedPatternRecord } from "../contracts/trusted-pattern.ts";
import type { HarnessInputCell } from "../contracts/input-cells.ts";
import type { HarnessModelToolDescriptor } from "../contracts/tool-descriptor.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessTranscriptMessage,
} from "../contracts/transcript.ts";
import {
  type HarnessDocsCorpusSection,
  isOperatorProvisionedReferenceAtom,
} from "../contracts/docs-corpus.ts";
import type { HarnessDocsCorpus } from "../docs-corpus/corpus.ts";
import { findSectionPassage, rankSections } from "../docs-corpus/sections.ts";
import { errorMessage } from "../error-message.ts";
import { inputCellsContextMessage } from "../input-cells.ts";
import { ORIENTATION_GUIDANCE } from "../orientation.ts";
import {
  PATTERN_AUTHORING_GUIDANCE,
  PATTERN_COMPOSITION_GUIDANCE,
} from "../pattern-authoring.ts";
import { PIECE_TARGETING_GUIDANCE } from "../piece-targeting.ts";
import type {
  HarnessModelAttemptDiagnostic,
  HarnessModelClient,
  HarnessModelUsage,
} from "../model/client.ts";
import type {
  PatternIndexPattern,
  PatternIndexProgram,
  PatternIndexSearchRequest,
  PatternIndexSearchResponse,
} from "../pattern-index/client.ts";
import { patternIndexDependencies } from "../pattern-index/composition.ts";
import type { DescribeHandleResearchResult } from "../tools/describe-handle.ts";
import {
  patternIndexDeclaredType,
  patternIndexImportHint,
} from "../tools/search-patterns.ts";
import { parseStructuredResultJson } from "../structured-result.ts";
import {
  admitResearchResult,
  type RawResearchResult,
  researchResultSchema,
  unreadSourceIds,
} from "./admission.ts";
import { objectValue, stringValue, unique } from "./model-value.ts";
import { researchStartingContext, selectResearchContext } from "./context.ts";

/** Cheap gateway model used by the bounded research loop. */
export const RESEARCH_MODEL = "gemini-3.5-flash" as const;

/** Cheap model available on the owner-authenticated Codex transport. */
export const RESEARCH_CODEX_MODEL = "gpt-5.6-luna" as const;

/** Most model turns one research call may spend. */
export const MAX_RESEARCH_MODEL_TURNS = 8;

/** Most private tool calls one research call may execute. */
export const MAX_RESEARCH_TOOL_CALLS = 24;

/** Largest exact document or source window returned by one private read. */
export const MAX_RESEARCH_READ_CHARS = 32_000;

/** Total exact document and source characters one research call may read. */
export const MAX_RESEARCH_TOTAL_READ_CHARS = 96_000;

/** Work limits selected by the host for each research purpose. */
export const RESEARCH_BUDGETS = {
  orient: {
    modelTurns: MAX_RESEARCH_MODEL_TURNS,
    toolCalls: MAX_RESEARCH_TOOL_CALLS,
    readChars: MAX_RESEARCH_TOTAL_READ_CHARS,
  },
  answer: {
    modelTurns: MAX_RESEARCH_MODEL_TURNS,
    toolCalls: MAX_RESEARCH_TOOL_CALLS,
    readChars: MAX_RESEARCH_TOTAL_READ_CHARS,
  },
} as const;

export { MAX_RESEARCH_EXAMPLE_CHARS } from "./admission.ts";

/** Narrow index surface required by research. */
export interface HarnessResearchPatternIndex {
  /** Searches public pattern metadata. */
  searchPatterns(
    request: PatternIndexSearchRequest,
  ): Promise<PatternIndexSearchResponse>;

  /** Reads one published pattern, optionally with its program. */
  getPattern(request: {
    patternId: string;
    includeSource?: boolean;
  }): Promise<PatternIndexPattern>;
}

/** Dependencies the host gives one bounded research run. */
export interface HarnessResearchRequest {
  /** Whole implementation task or focused follow-up to investigate. */
  task: string;

  /** Current user goal, supplied by the host independently of the local question. */
  goal?: string;

  /** Scope chosen by the caller; absent for unscoped host integrations. */
  purpose?: HarnessResearchPurpose;

  /** Explicit prior result whose unresolved decision this call investigates. */
  followUpTo?: string;

  /** Unique id used for internal model affinity and provenance. */
  researchRunId: string;

  /** Operator-provisioned documentation, when configured. */
  corpus?: HarnessDocsCorpus;

  /** Lazy pattern-index client, when configured. */
  getPatternIndex?: () => Promise<HarnessResearchPatternIndex>;

  /** General handles visible to the calling run. */
  handleTokens: readonly string[];

  /** Explicit attachments; only their operator names and tokens reach the model. */
  inputCells?: readonly HarnessInputCell[];

  /** Safe shape-only description of one general handle. */
  describeHandle?: (token: string) => Promise<DescribeHandleResearchResult>;

  /** Existing CFC label on the task and accumulated model context. */
  taskCfcLabel?: IFCLabel;

  /** Prior research retained by this run, newest last. */
  priorResearchRuns?: readonly HarnessResearchRunSummary[];

  /** Index-resolved pattern attachments supplied with the root task. */
  attachedPatterns?: readonly TrustedPatternRecord[];

  /** Run-level cancellation signal. */
  signal?: AbortSignal;
}

/** Full artifact-only evidence for one research loop. */
export interface HarnessResearchRecord {
  /** Research artifact discriminator. */
  type: "cf-harness.research-record";

  /** Unique research run id. */
  researchRunId: string;

  /** Cheap model that performed the bounded exploration. */
  model: string;

  /** Task supplied to the loop. */
  task: string;

  /** User goal retained alongside the narrower research task. */
  goal?: string;

  /** Scope and parent result recorded independently of the model synthesis. */
  purpose?: HarnessResearchPurpose;

  /** Earlier admitted result selected by the caller. */
  followUpTo?: string;

  /** Complete private model/tool transcript, including exact read windows. */
  messages: readonly HarnessTranscriptMessage[];

  /** Exact trusted reads admitted during the loop. */
  sourceReads: readonly HarnessResearchSourceRead[];

  /** Pattern records independently confirmed by the host. */
  confirmedPatterns: readonly HarnessResearchPatternRecord[];

  /** Handles safely described by the host. */
  describedHandles: readonly HarnessResearchHandleRecord[];

  /** Known CFC labels and explicit metadata gaps across all observations. */
  cfc: HarnessResearchCfcProjection;

  /** Resource use at the end of the loop. */
  budgets: {
    /** Model turns spent. */
    modelTurns: number;

    /** Private tool calls executed. */
    toolCalls: number;

    /** Exact source characters read. */
    readChars: number;
  };
}

/** Admitted kit plus the artifact-only derivation that produced it. */
export interface HarnessResearchReply {
  /** Structured result safe to give the caller. */
  kit: HarnessResearchResult;

  /** Full research trace retained only in the tool artifact. */
  record: HarnessResearchRecord;
}

/** Failure that carries every private observation made before it occurred. */
export class HarnessResearchError extends Error {
  readonly #record: HarnessResearchRecord;

  /** Constructs an instance carrying the partial research record. */
  constructor(message: string, record: HarnessResearchRecord) {
    super(message);
    this.#record = record;
  }

  /** Stable error class name. */
  override get name(): string {
    return "HarnessResearchError";
  }

  /** Partial artifact record preserved on the failed builtin output. */
  get record(): HarnessResearchRecord {
    return this.#record;
  }
}

/** Host-side research function installed into the builtin tool context. */
export type HarnessResearchRunner = (
  request: HarnessResearchRequest,
) => Promise<HarnessResearchReply>;

interface ResearchState {
  readLimit: number;
  handleTokens: readonly string[];
  sourceReads: HarnessResearchSourceRead[];
  confirmedPatterns: Map<string, HarnessResearchPatternRecord>;
  searchedPatterns: Map<string, HarnessResearchPatternRecord>;
  programs: Map<string, PatternIndexProgram>;
  describedHandles: Map<string, HarnessResearchHandleRecord>;
  sourceLabel: IFCLabel;
  missingLabels: Map<string, HarnessResearchMissingLabel>;
  readChars: number;
  toolCalls: number;
}

const SEARCH_DOCS_TOOL: HarnessModelToolDescriptor = {
  toolId: "search_docs",
  title: "Search CF Docs",
  description:
    "Search the full Common Fabric docs and skills corpus, optionally within a path. Results include exact matching passages, citable sourceIds, heading context, and offsets. Open relevant sections for more context or complete examples.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 2 },
      pathPrefix: {
        type: "string",
        maxLength: 1_000,
        description:
          "Optional corpus-relative document or directory. Matches that exact path and slash-delimited descendants; empty selects the whole corpus.",
      },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const OPEN_DOC_TOOL: HarnessModelToolDescriptor = {
  toolId: "open_doc_section",
  title: "Open Exact CF Doc Section",
  description:
    "Read one exact section or several selected sections together. Use sectionId for one, or sectionIds for a batch. Reads can include up to 32,000 characters per section; complete=false and nextOffset identify remaining text. Use search_docs offsets to jump to a passage.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      sectionId: { type: "string" },
      sectionIds: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: { type: "string" },
      },
      offset: { type: "integer", minimum: 0 },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESEARCH_READ_CHARS,
      },
    },
    oneOf: [{ required: ["sectionId"] }, { required: ["sectionIds"] }],
    additionalProperties: false,
  },
};

const LIST_DOC_SECTIONS_TOOL: HarnessModelToolDescriptor = {
  toolId: "list_doc_sections",
  title: "List CF Doc Sections",
  description:
    "List a document or directory's section outline with exact ids, heading ancestry, and sizes. Use a pathPrefix from search results or a known guide. Pagination exposes the whole outline without reading all its text.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      pathPrefix: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["pathPrefix"],
    additionalProperties: false,
  },
};

const SEARCH_PATTERNS_TOOL: HarnessModelToolDescriptor = {
  toolId: "search_pattern_index",
  title: "Search Published Patterns",
  description:
    "Search published Common Fabric pattern metadata. Inspect promising ids before selecting them so source identity, files, dependencies, and contracts are host-confirmed.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    additionalProperties: false,
  },
};

const INSPECT_PATTERN_TOOL: HarnessModelToolDescriptor = {
  toolId: "inspect_pattern",
  title: "Inspect Published Pattern",
  description:
    "Fetch one indexed pattern with its complete multi-file program, verify its content identity when supported, and return metadata, contracts, dependency ids, and exact file paths without source text. Use open_pattern_file for source.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: { patternId: { type: "string", minLength: 1 } },
    required: ["patternId"],
    additionalProperties: false,
  },
};

const OPEN_PATTERN_FILE_TOOL: HarnessModelToolDescriptor = {
  toolId: "open_pattern_file",
  title: "Open Published Pattern File",
  description:
    "Read a bounded exact range of a file from a pattern already inspected. Continue with nextOffset until complete when the needed contract or example lies later in the file.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      patternId: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
      offset: { type: "integer", minimum: 0 },
      maxChars: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RESEARCH_READ_CHARS,
      },
    },
    required: ["patternId", "path"],
    additionalProperties: false,
  },
};

const LIST_HANDLES_TOOL: HarnessModelToolDescriptor = {
  toolId: "list_handles",
  title: "List Available Handles",
  description:
    "List the caller's general handle tokens. This reveals no values or shapes; call describe_handle before binding a token in the kit.",
  effectClass: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

const DESCRIBE_HANDLE_TOOL: HarnessModelToolDescriptor = {
  toolId: "describe_handle",
  title: "Describe Available Handle",
  description:
    "Read the safe shape-only handle description. Never reads row or cell values. Only described general tokens can become kit inputs.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: { token: { type: "string", minLength: 1 } },
    required: ["token"],
    additionalProperties: false,
  },
};

const RESEARCH_TOOLS = [
  SEARCH_DOCS_TOOL,
  LIST_DOC_SECTIONS_TOOL,
  OPEN_DOC_TOOL,
  SEARCH_PATTERNS_TOOL,
  INSPECT_PATTERN_TOOL,
  OPEN_PATTERN_FILE_TOOL,
  LIST_HANDLES_TOOL,
  DESCRIBE_HANDLE_TOOL,
] as const;

const integerValue = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) ? value : fallback;

const runWasAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

const abortError = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException("Aborted", "AbortError");

const digestText = (text: string): string =>
  `sha256:${encodeHex(sha256(new TextEncoder().encode(text)))}`;

const sourceId = (
  kind: string,
  location: string,
  offset: number,
  end: number,
  contentDigest: string,
) =>
  `${kind}:${
    digestText(`${location}\n${offset}\n${end}\n${contentDigest}`).slice(7, 23)
  }`;

/** Builds the research CFC projection without inventing missing source labels. */
export const createHarnessResearchCfcProjection = (
  labels: readonly (IFCLabel | undefined)[],
  missingLabels: readonly HarnessResearchMissingLabel[] = [],
): HarnessResearchCfcProjection => {
  const sourceLabel = labels.reduce<IFCLabel>(
    (merged, label) => label === undefined ? merged : mergeLabel(merged, label),
    {},
  );
  return {
    version: 1,
    sourceLabel: cloneIfcLabel(sourceLabel),
    outputLabel: confidentialityOnlyIfcLabel(sourceLabel) ?? {},
    coverage: missingLabels.length === 0 ? "complete" : "incomplete",
    missingLabels: missingLabels.map((missing) => ({ ...missing })),
  };
};

const addSourceLabel = (
  state: ResearchState,
  label: IFCLabel | undefined,
): void => {
  if (label !== undefined) {
    state.sourceLabel = mergeLabel(state.sourceLabel, label);
  }
};

const addMissingLabel = (
  state: ResearchState,
  source: HarnessResearchMissingLabelSource,
  detail: string,
): void => {
  const key = `${source}\u0000${detail}`;
  if (!state.missingLabels.has(key)) {
    state.missingLabels.set(key, { source, detail });
  }
};

const researchCfcProjection = (
  state: ResearchState,
): HarnessResearchCfcProjection =>
  createHarnessResearchCfcProjection(
    [state.sourceLabel],
    [...state.missingLabels.values()],
  );

const sourceCatalog = (state: ResearchState): string =>
  [
    "Current citable source catalog. Copy only these sourceId field values, exactly as returned:",
    ...(state.sourceReads.length === 0
      ? ["No exact source reads are currently citable."]
      : state.sourceReads.map((read) =>
        JSON.stringify({
          sourceId: read.sourceId,
          kind: read.kind,
          location: read.location,
        })
      )),
    "A documentation source location includes its section-N reopen argument. Pass that sectionId to open_doc_section; never pass a documentation:* sourceId as sectionId.",
  ].join("\n");

const researchModel = (providerId: string): string =>
  providerId === "openai-codex" ? RESEARCH_CODEX_MODEL : RESEARCH_MODEL;

const systemPrompt = (purpose?: HarnessResearchPurpose): string =>
  [
    "You are the private Common Fabric research loop inside the harness.",
    purpose === "orient"
      ? "Orient the parent to achieving the user goal. Inspect the relevant data and indexed pieces, establish how they fit together, and supply the practical contracts or examples needed to proceed. Identify a small reusable piece to author when something is missing. Stop when the parent has a useful approach; a full application is not required."
      : purpose === "answer"
      ? "Answer the question in the context of the user goal and prior findings. Read enough to be accurate, then return the explanation, code, or invocation that resolves it. Let the question determine the scope."
      : "Produce the smallest complete recipe for the requested implementation using only the supplied tools.",
    "This is CF documentation, skills, pattern-index, source, dependency, and handle research; it is not web research.",
    PIECE_TARGETING_GUIDANCE,
    PATTERN_AUTHORING_GUIDANCE,
    PATTERN_COMPOSITION_GUIDANCE,
    ...(purpose === "orient" ? [ORIENTATION_GUIDANCE] : []),
    "Search for the next unresolved fact. Search results are leads, not proof of applicability. Read exact evidence only when it changes the decision; do not keep searching after the question is answered.",
    "A long section or source file is never represented by its first chunk alone. Follow nextOffset with another exact read whenever the needed answer could continue later.",
    "Use the pattern index and available data to find a short path to the goal. Prefer composing suitable existing pieces; describe the smallest missing reusable capability when authoring is needed. If the approach becomes large or tangled, reconsider the component boundaries and data contracts before expanding it. One source file per component does not mean one component for the entire goal.",
    "Only inspected records may be selected as confirmed patterns. Read source and dependencies where applicability or composition depends on them. Uninspected candidates belong under leads, not selectedPatternIds.",
    "A handle binding is supported only after you call describe_handle for that exact token and receive a successful description. Never infer a binding from task prose alone.",
    "Only an exact value returned in a field named sourceId is citable in the final sourceIds arrays. Copy it exactly; never abbreviate, reconstruct, or transpose it.",
    "The outputId returned by describe_handle records binding provenance only. It is not a sourceId and must never be cited.",
    "For documentation, sectionId is the section-N selector accepted by open_doc_section, while sourceId is the documentation:* citation returned by that read. Never use one in place of the other.",
    "The final inputs array is only for existing described external handles. Use [] when the task needs no external data; put types, defaults, literals, and new local state in the recipe.",
    "Never invent a pattern id, import, handle, grant, API rule, source id, or missing input. If the tools do not establish one, return incomplete and name it under missing.",
    ...[
      "Prefer direct-run when one verified pattern solves the task, composition when verified parts fit, and author only when reuse does not. Implementation direction is separate from the scope of this call.",
      "A run-pattern-input example has an invocation OBJECT conforming to run_pattern, with a selected patternId and no sourceText; the host serializes it into copyable JSON. A pattern-source example has complete TypeScript/TSX in content. Never put TSX into an invocation or return a clipped code prefix.",
      "Every API illustrated in an example, including an API mentioned only in a comment, must be supported by an exact opened read cited in example.sourceIds.",
      purpose === undefined
        ? "An implementation kit needs a complete example: a run-pattern-input invocation for direct-run, or pattern-source for author/compose. Without it, report incomplete and name the missing example. A focused-api fact needs a cited rule, not application code."
        : "Examples are optional. Include one when it makes the answer usable; it may be a small idiom or a composable piece. Do not expand a factual question into a whole app. State routine assumptions and reserve missing for actual blockers to this answer, not everything left for the author to do.",
    ],
    "Distinguish available inputs, the requirements of one candidate, and missing user data. A candidate's SQLite or connector contract is specific to that candidate, not a universal task prerequisite. No current mailbox handle means mail is not yet given, not that permitted discovery cannot find it; local-only apps need no external handle.",
    "Check documentTitle and headingPath before applying a snippet. Iframe React guest code and ordinary commonfabric patterns use different execution environments. A React JSX pragma or React import belongs to an iframe guest, never add it to an ordinary compiled CF pattern. Use the relevant canonical guide sections for the execution environment. Search matching passages or list an outline to choose what to read; read larger sections when their context matters.",
    "On your final turn, make no tool calls and return only JSON matching this schema:",
    JSON.stringify(researchResultSchema(purpose)),
  ].join("\n");

const canonicalGuideSections = (request: HarnessResearchRequest) => {
  const canonicalPaths = new Set<string>();
  return (request.corpus?.sections ?? []).flatMap(
    (section, index) => {
      if (
        !section.integrity.some(isOperatorProvisionedReferenceAtom) ||
        canonicalPaths.has(section.path) ||
        !(section.path.endsWith("/pattern-dev/SKILL.md") ||
          section.path.endsWith("/pattern-development-guide.md"))
      ) return [];
      canonicalPaths.add(section.path);
      return [{ section, index }];
    },
  );
};

const userPrompt = (
  request: HarnessResearchRequest,
): string => {
  const retained = request.priorResearchRuns ?? [];
  const prior = request.followUpTo === undefined
    ? selectResearchContext(retained)
    : retained.filter((run) =>
      run.researchRunId === request.followUpTo ||
      run.outputId === request.followUpTo
    );
  const attachedPatterns = request.attachedPatterns ?? [];
  const canonicalGuides = canonicalGuideSections(request).map((
    { section },
  ) => ({
    path: section.path,
    documentTitle: section.documentTitle,
    headingPath: section.headingPath,
  }));
  return [
    ...(request.goal === undefined
      ? []
      : ["Current user goal:", request.goal, ""]),
    "Research question or orientation task:",
    request.task,
    "",
    "Authoritative general handle inventory for this research call:",
    request.handleTokens.length > 0
      ? request.handleTokens.join("\n")
      : "No general handles are available.",
    ...(request.inputCells === undefined ? [] : [
      "",
      "Explicit input-cell attachment context for the calling run:",
      inputCellsContextMessage(request.inputCells),
      "An attached piece's token can be passed directly to read_piece_source by the pattern-author; a result-shaped schema does not require finding another identity through the registry.",
    ]),
    ...(canonicalGuides.length > 0
      ? [
        "Canonical authoring references (use list_doc_sections or search_docs to select useful passages):",
        JSON.stringify(canonicalGuides),
      ]
      : []),
    "Keep these opaque cfh tokens unchanged. Call describe_handle for every token you recommend binding; a failed or skipped description cannot support an input binding.",
    ...(attachedPatterns.length > 0
      ? [
        "",
        "Authoritative index-resolved pattern attachments for this task:",
        JSON.stringify(attachedPatterns),
        "These records are trusted search leads, not source inspection. Call inspect_pattern before selecting one, then open every source file the current answer relies on.",
      ]
      : []),
    ...(prior.length > 0
      ? [
        "",
        "Selected prior findings and reopenable sources:",
        JSON.stringify(prior.map(researchStartingContext)),
        "These findings omit old recipes and handle bindings. Only the current inventory above is authoritative. Treat these as starting context and research only unresolved items. Their sourceIds are not citations for this fresh research call: reopen every source the current answer relies on, using a section-N value from a documentation source location as open_doc_section.sectionId, and cite only the newly returned sourceId.",
      ]
      : []),
  ].join("\n");
};

const toolResultMessage = (
  callId: string,
  toolName: string,
  output: unknown,
): HarnessTranscriptMessage => ({
  role: "tool",
  toolCallId: callId,
  toolName,
  content: JSON.stringify(output),
});

const checkedReadRange = (
  text: string,
  offsetValue: unknown,
  maxCharsValue: unknown,
): { offset: number; end: number; content: string } => {
  const offset = Math.max(0, integerValue(offsetValue, 0));
  if (offset > text.length) {
    throw new Error(`offset ${offset} exceeds ${text.length} characters`);
  }
  const maxChars = Math.max(
    1,
    Math.min(
      MAX_RESEARCH_READ_CHARS,
      integerValue(maxCharsValue, MAX_RESEARCH_READ_CHARS),
    ),
  );
  const end = Math.min(text.length, offset + maxChars);
  return { offset, end, content: text.slice(offset, end) };
};

const addRead = (
  state: ResearchState,
  read: Omit<HarnessResearchSourceRead, "sourceId" | "digest">,
  content: string,
): HarnessResearchSourceRead => {
  checkReadBudget(state, content.length);
  state.readChars += content.length;
  const digest = digestText(content);
  const admitted: HarnessResearchSourceRead = {
    ...read,
    sourceId: sourceId(
      read.kind,
      read.location,
      read.offset,
      read.end,
      digest,
    ),
    digest,
  };
  const prior = state.sourceReads.find((candidate) =>
    candidate.sourceId === admitted.sourceId
  );
  if (prior === undefined) {
    state.sourceReads.push(admitted);
  }
  return prior ?? admitted;
};

const searchedPatternRecord = (
  hit: PatternIndexSearchResponse["results"][number],
): HarnessResearchPatternRecord => ({
  patternId: hit.patternId,
  description: hit.description,
  hashtags: [...hit.hashtags],
  ...(hit.signals !== undefined ? { signals: { ...hit.signals } } : {}),
  kind: hit.kind,
  quality: hit.quality,
  ...(hit.matchedTerms !== undefined ? { matchedTerms: hit.matchedTerms } : {}),
  ...(hit.queryTerms !== undefined ? { queryTerms: hit.queryTerms } : {}),
  importHint: patternIndexImportHint(hit.patternId),
  ownerDid: hit.ownerDid,
  createdAt: hit.createdAt,
  dependencies: [...hit.dependencies],
});

const inspectPattern = async (
  state: ResearchState,
  index: HarnessResearchPatternIndex,
  patternId: string,
): Promise<Record<string, unknown>> => {
  const pattern = await index.getPattern({ patternId, includeSource: true });
  addMissingLabel(
    state,
    "pattern-index-metadata",
    `pattern ${pattern.patternId} metadata returned by inspect_pattern`,
  );
  if (pattern.patternId !== patternId) {
    throw new Error(
      `pattern index returned ${pattern.patternId} for ${patternId}`,
    );
  }
  if (pattern.program === undefined) {
    throw new Error(`pattern ${patternId} has no indexed source program`);
  }
  addMissingLabel(
    state,
    "pattern-index-source",
    `pattern ${patternId} source returned by inspect_pattern`,
  );
  const program = pattern.program;
  let identityVerified: true | undefined;
  let identityNote: string | undefined;
  let computedIdentity: string | undefined;
  try {
    await ensureCompilerStack();
    computedIdentity = computeEntryIdentity(program.main, program.files, {
      ...(program.sourceRoots !== undefined
        ? { sourceRoots: program.sourceRoots }
        : {}),
      ...(program.dataFiles !== undefined
        ? { dataFiles: program.dataFiles }
        : {}),
    });
  } catch (error) {
    const message = errorMessage(error);
    if (!message.includes("is not supported by the light identity path")) {
      throw error;
    }
    identityNote = message;
  }
  if (computedIdentity !== undefined) {
    if (computedIdentity !== patternId) {
      throw new Error(
        `pattern ${patternId} source computes to identity ${computedIdentity}`,
      );
    }
    identityVerified = true;
  }
  const searched = state.searchedPatterns.get(patternId);
  const dependencies = unique([
    ...pattern.dependencies,
    ...patternIndexDependencies(program.files),
  ]);
  const confirmed: HarnessResearchPatternRecord = {
    patternId,
    description: pattern.description,
    hashtags: [...pattern.hashtags],
    ...(searched?.signals !== undefined
      ? { signals: { ...searched.signals } }
      : {}),
    ...(searched?.kind !== undefined ? { kind: searched.kind } : {}),
    ...(searched?.quality !== undefined ? { quality: searched.quality } : {}),
    ...(searched?.matchedTerms !== undefined
      ? { matchedTerms: searched.matchedTerms }
      : {}),
    ...(searched?.queryTerms !== undefined
      ? { queryTerms: searched.queryTerms }
      : {}),
    importHint: patternIndexImportHint(patternId),
    ...(patternIndexDeclaredType(pattern.argumentSchema) !== undefined
      ? { argumentType: patternIndexDeclaredType(pattern.argumentSchema) }
      : {}),
    ...(patternIndexDeclaredType(pattern.resultSchema) !== undefined
      ? { resultType: patternIndexDeclaredType(pattern.resultSchema) }
      : {}),
    ...(pattern.argumentSchema !== undefined
      ? { argumentSchema: structuredClone(pattern.argumentSchema) }
      : {}),
    ...(pattern.resultSchema !== undefined
      ? { resultSchema: structuredClone(pattern.resultSchema) }
      : {}),
    ownerDid: pattern.ownerDid,
    createdAt: pattern.createdAt,
    main: program.main,
    ...(program.mainExport !== undefined
      ? { mainExport: program.mainExport }
      : {}),
    files: program.files.map((file) => file.name),
    ...(program.sourceRoots !== undefined
      ? { sourceRoots: [...program.sourceRoots] }
      : {}),
    ...(program.dataFiles !== undefined
      ? { dataFiles: [...program.dataFiles] }
      : {}),
    dependencies,
    ...(identityVerified === true ? { sourceIdentityVerified: true } : {}),
    identityVerification: identityVerified === true
      ? { status: "verified", method: "light-entry-identity" }
      : {
        status: "deferred",
        method: "full-fabric-compiler",
        detail: identityNote!,
      },
  };
  // `evidence` is the exact object serialized for this read's digest and the
  // exact object returned to the private model. The source id is its citation
  // address and therefore sits beside it rather than recursively inside it.
  // Rendered types carry the contracts; raw schemas stay on the retained record
  // without consuming a second copy of the private model's read budget.
  const {
    argumentSchema: _argumentSchema,
    resultSchema: _resultSchema,
    ...evidence
  } = structuredClone(confirmed);
  const metadata = JSON.stringify(evidence);
  if (metadata.length > MAX_RESEARCH_READ_CHARS) {
    throw new Error(
      `pattern metadata exceeds the ${MAX_RESEARCH_READ_CHARS}-character read budget`,
    );
  }
  const read = addRead(state, {
    kind: "pattern-metadata",
    location: `cf:pattern:${patternId}`,
    offset: 0,
    end: metadata.length,
    totalChars: metadata.length,
  }, metadata);
  state.programs.set(patternId, structuredClone(program));
  state.confirmedPatterns.set(patternId, confirmed);
  return {
    sourceId: read.sourceId,
    evidence,
  };
};

/** Metadata shared by section outlines, passages, and full reads. */
const docSectionMetadata = (
  request: HarnessResearchRequest,
  section: HarnessDocsCorpusSection,
) => ({
  sectionId: "section-" + request.corpus!.sections.indexOf(section),
  path: section.path,
  heading: section.heading,
  documentTitle: section.documentTitle,
  headingPath: section.headingPath,
  chars: section.text.length,
});

/** Records and returns the exact section text observed through search or read. */
const readDocSection = (
  request: HarnessResearchRequest,
  state: ResearchState,
  section: HarnessDocsCorpusSection,
  range: { offset: number; end: number; content: string },
) => {
  const metadata = docSectionMetadata(request, section);
  const cfcLabel: IFCLabel = {
    integrity: structuredClone([...section.integrity]),
  };
  addSourceLabel(state, cfcLabel);
  const read = addRead(state, {
    kind: "documentation",
    location: section.path + "#" +
      (section.headingPath?.join(" > ") ?? section.heading) + " (" +
      metadata.sectionId + ")",
    offset: range.offset,
    end: range.end,
    totalChars: section.text.length,
    ...(section.documentTitle === undefined
      ? {}
      : { documentTitle: section.documentTitle }),
    ...(section.headingPath === undefined
      ? {}
      : { headingPath: section.headingPath }),
    integrity: section.integrity.map((atom) => atom.class),
    cfcLabel,
  }, range.content);
  return {
    ...metadata,
    sourceId: read.sourceId,
    ...range,
    totalChars: section.text.length,
    complete: range.end === section.text.length,
    ...(range.end < section.text.length ? { nextOffset: range.end } : {}),
  };
};

/** Refuses a read batch before any of its windows enter the evidence record. */
const checkReadBudget = (state: ResearchState, chars: number): void => {
  if (state.readChars + chars > state.readLimit) {
    throw new Error(
      "research read budget of " + state.readLimit + " characters is exhausted",
    );
  }
};

const invokeResearchTool = async (
  request: HarnessResearchRequest,
  state: ResearchState,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> => {
  switch (name) {
    case "list_doc_sections":
    case "search_docs": {
      const prefix = typeof input.pathPrefix === "string"
        ? input.pathPrefix
        : "";
      const eligible = (request.corpus?.sections ?? []).filter((section) =>
        section.integrity.some(isOperatorProvisionedReferenceAtom) &&
        (prefix === "" || section.path === prefix ||
          section.path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"))
      );
      for (const section of eligible) {
        addSourceLabel(state, {
          integrity: structuredClone([...section.integrity]),
        });
      }
      if (name === "list_doc_sections") {
        const offset = Math.max(0, integerValue(input.offset, 0));
        const limit = Math.max(1, Math.min(100, integerValue(input.limit, 40)));
        return {
          totalSections: eligible.length,
          sections: eligible.slice(offset, offset + limit).map((section) =>
            docSectionMetadata(request, section)
          ),
          ...(offset + limit < eligible.length
            ? { nextOffset: offset + limit }
            : {}),
        };
      }
      const query = stringValue(input.query, 2_000);
      if (query.length < 2) {
        throw new Error("query must be at least 2 characters");
      }
      const limit = Math.max(1, Math.min(10, integerValue(input.limit, 5)));
      const matches = rankSections(eligible, query).slice(0, limit).map((
        { section, score },
      ) => ({
        section,
        score,
        range: findSectionPassage(section, query),
      }));
      checkReadBudget(
        state,
        matches.reduce((size, entry) => size + entry.range.content.length, 0),
      );
      return {
        corpusSections: eligible.length,
        results: matches.map(({ section, score, range }) => ({
          ...readDocSection(request, state, section, range),
          score,
        })),
      };
    }
    case "open_doc_section": {
      if (
        (input.sectionId === undefined) === (input.sectionIds === undefined)
      ) {
        throw new Error("provide exactly one of sectionId or sectionIds");
      }
      const ids = input.sectionId !== undefined
        ? [input.sectionId]
        : input.sectionIds;
      if (
        !Array.isArray(ids) || ids.length === 0 || ids.length > 8 ||
        ids.some((id) => typeof id !== "string")
      ) {
        throw new Error("provide between one and eight section ids");
      }
      const reads = ids.map((id) => {
        const match = /^section-(\d+)$/.exec(id);
        const section = match === null
          ? undefined
          : request.corpus?.sections[Number(match[1])];
        if (
          section === undefined ||
          !section.integrity.some(isOperatorProvisionedReferenceAtom)
        ) {
          throw new Error("unknown documentation section " + id);
        }
        return {
          section,
          range: checkedReadRange(section.text, input.offset, input.maxChars),
        };
      });
      checkReadBudget(
        state,
        reads.reduce((size, read) => size + read.range.content.length, 0),
      );
      const sections = reads.map(({ section, range }) =>
        readDocSection(request, state, section, range)
      );
      return input.sectionId !== undefined ? sections[0] : { sections };
    }
    case "search_pattern_index": {
      if (request.getPatternIndex === undefined) {
        throw new Error("this run has no configured pattern index");
      }
      const text = typeof input.text === "string" ? input.text : undefined;
      const tags = Array.isArray(input.tags)
        ? input.tags.filter((tag): tag is string => typeof tag === "string")
        : undefined;
      if (text === undefined && (tags === undefined || tags.length === 0)) {
        throw new Error("pattern search requires text, tags, or both");
      }
      const index = await request.getPatternIndex();
      const limit = Math.max(
        1,
        Math.min(
          10,
          integerValue(input.limit, 10),
        ),
      );
      const response = await index.searchPatterns({
        ...(text !== undefined ? { text } : {}),
        ...(tags !== undefined ? { tags } : {}),
        limit,
      });
      const results = response.results.slice(0, limit).map(
        searchedPatternRecord,
      );
      if (results.length === 0) {
        addMissingLabel(
          state,
          "pattern-index-metadata",
          "empty search_pattern_index response",
        );
      }
      for (const result of results) {
        state.searchedPatterns.set(result.patternId, result);
        addMissingLabel(
          state,
          "pattern-index-metadata",
          `pattern ${result.patternId} metadata returned by search_pattern_index`,
        );
      }
      return { results };
    }
    case "inspect_pattern": {
      if (request.getPatternIndex === undefined) {
        throw new Error("this run has no configured pattern index");
      }
      const patternId = stringValue(input.patternId, 500);
      if (patternId.length === 0) throw new Error("patternId is required");
      return await inspectPattern(
        state,
        await request.getPatternIndex(),
        patternId,
      );
    }
    case "open_pattern_file": {
      const patternId = stringValue(input.patternId, 500);
      const path = stringValue(input.path, 2_000);
      const program = state.programs.get(patternId);
      if (program === undefined) {
        throw new Error(
          `inspect pattern ${patternId} before opening its files`,
        );
      }
      const file = program.files.find((candidate) => candidate.name === path);
      if (file === undefined) {
        throw new Error(`pattern ${patternId} has no file ${path}`);
      }
      const range = checkedReadRange(
        file.contents,
        input.offset,
        input.maxChars,
      );
      const location = `cf:pattern:${patternId}:${path}`;
      const read = addRead(state, {
        kind: "pattern-source",
        location,
        offset: range.offset,
        end: range.end,
        totalChars: file.contents.length,
      }, range.content);
      return {
        sourceId: read.sourceId,
        patternId,
        path,
        offset: range.offset,
        end: range.end,
        totalChars: file.contents.length,
        content: range.content,
        complete: range.end === file.contents.length,
        ...(range.end < file.contents.length ? { nextOffset: range.end } : {}),
      };
    }
    case "list_handles":
      return { tokens: [...request.handleTokens] };
    case "describe_handle": {
      const token = stringValue(input.token, 500);
      if (!request.handleTokens.includes(token)) {
        throw new Error(`unknown or restricted handle ${token}`);
      }
      if (request.describeHandle === undefined) {
        throw new Error("handle description is unavailable");
      }
      const described = await request.describeHandle(token);
      addSourceLabel(state, described.cfcLabel ?? {});
      if (!described.cfcLabelAvailable) {
        addMissingLabel(
          state,
          "handle-description",
          `handle ${token} metadata returned by describe_handle`,
        );
      }
      const description = described.output;
      if (!description.known || description.error !== undefined) {
        return description;
      }
      const record = { token, description };
      state.describedHandles.set(token, record);
      return description;
    }
    default:
      throw new Error(`unknown research tool ${name}`);
  }
};

/**
 * Creates the bounded host-side research loop. Its private tools can read only
 * the configured corpus, index records, indexed source, and safe handle shape;
 * they cannot delegate, execute commands, write files, or touch Fabric state.
 */
export const createResearchRunner = (options: {
  /** Model transport used for the cheap loop. */
  modelClient: HarnessModelClient;

  /** Records each provider attempt in the parent run report. */
  onAttempt?: (attempt: HarnessModelAttemptDiagnostic) => void | Promise<void>;

  /** Reports every completed private model call before the next one starts. */
  onUsage?: (usage: HarnessModelUsage | undefined) => void | Promise<void>;
}): HarnessResearchRunner =>
async (request) => {
  const model = researchModel(options.modelClient.providerId);
  const budget = RESEARCH_BUDGETS[request.purpose ?? "orient"];
  const tools = RESEARCH_TOOLS;
  const transcript: HarnessTranscriptMessage[] = [
    { role: "system", content: systemPrompt(request.purpose) },
    { role: "user", content: userPrompt(request) },
  ];
  const state: ResearchState = {
    readLimit: budget.readChars,
    handleTokens: request.handleTokens,
    sourceReads: [],
    confirmedPatterns: new Map(),
    searchedPatterns: new Map(
      (request.attachedPatterns ?? []).map((
        record,
      ) => [record.patternId, record]),
    ),
    programs: new Map(),
    describedHandles: new Map(),
    sourceLabel: {},
    missingLabels: new Map(),
    readChars: 0,
    toolCalls: 0,
  };
  addSourceLabel(state, request.taskCfcLabel);
  for (const { section } of canonicalGuideSections(request)) {
    addSourceLabel(state, {
      integrity: structuredClone([...section.integrity]),
    });
  }
  for (const prior of request.priorResearchRuns ?? []) {
    if (prior.cfc === undefined) {
      addMissingLabel(
        state,
        "prior-research",
        `prior research run ${prior.researchRunId} summary did not retain CFC metadata`,
      );
      continue;
    }
    addSourceLabel(state, prior.cfc.outputLabel);
    for (const missing of prior.cfc.missingLabels) {
      addMissingLabel(state, missing.source, missing.detail);
    }
  }
  for (const pattern of request.attachedPatterns ?? []) {
    addMissingLabel(
      state,
      "pattern-index-metadata",
      `pattern ${pattern.patternId} metadata supplied as a task attachment`,
    );
  }
  let finalAssistant: HarnessAssistantTranscriptMessage | undefined;
  let modelTurns = 0;
  const record = (): HarnessResearchRecord => ({
    type: "cf-harness.research-record",
    researchRunId: request.researchRunId,
    model,
    task: request.task,
    ...(request.goal === undefined ? {} : { goal: request.goal }),
    ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    ...(request.followUpTo === undefined
      ? {}
      : { followUpTo: request.followUpTo }),
    messages: transcript,
    sourceReads: state.sourceReads.map((read) => structuredClone(read)),
    confirmedPatterns: [...state.confirmedPatterns.values()].map((record) =>
      structuredClone(record)
    ),
    describedHandles: [...state.describedHandles.values()].map((record) =>
      structuredClone(record)
    ),
    cfc: researchCfcProjection(state),
    budgets: {
      modelTurns,
      toolCalls: state.toolCalls,
      readChars: state.readChars,
    },
  });
  let synthesisOnly = false;
  let synthesisPromptAdded = false;
  try {
    while (modelTurns < budget.modelTurns) {
      if (runWasAborted(request.signal)) {
        throw abortError(request.signal);
      }
      const reservedFinalTurn = modelTurns === budget.modelTurns - 1;
      const withholdTools = synthesisOnly || reservedFinalTurn;
      if (withholdTools && !synthesisPromptAdded) {
        transcript.push({
          role: "user",
          content: [
            "Synthesis turn: private tools are now withheld.",
            `You used ${modelTurns} of ${budget.modelTurns} model turns, ${state.toolCalls} of ${budget.toolCalls} tool calls, and ${state.readChars} of ${budget.readChars} read characters.`,
            sourceCatalog(state),
            "Return the final schema now. If evidence is missing, return status incomplete and name it rather than calling another tool.",
          ].join("\n"),
        });
        synthesisPromptAdded = true;
      }
      const result = await options.modelClient.complete({
        model,
        transcript: [...transcript],
        tools: withholdTools ? [] : tools,
        nativeModelToolIds: [],
        runId: request.researchRunId,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        ...(options.onAttempt !== undefined
          ? { onAttempt: options.onAttempt }
          : {}),
      });
      modelTurns += 1;
      await options.onUsage?.(result.usage);
      transcript.push(result.assistant);
      const calls = result.assistant.toolCalls ?? [];
      if (calls.length === 0) {
        if (runWasAborted(request.signal)) {
          throw abortError(request.signal);
        }
        finalAssistant = result.assistant;
        break;
      }
      if (withholdTools) synthesisOnly = true;
      for (const [callIndex, call] of calls.entries()) {
        if (runWasAborted(request.signal)) {
          for (const pending of calls.slice(callIndex)) {
            transcript.push(toolResultMessage(
              pending.id,
              pending.function.name,
              { error: "research cancelled before this call executed" },
            ));
          }
          throw abortError(request.signal);
        }
        if (withholdTools || state.toolCalls >= budget.toolCalls) {
          synthesisOnly = true;
          transcript.push(toolResultMessage(call.id, call.function.name, {
            error: withholdTools
              ? "private tools are withheld on the synthesis turn"
              : `research tool-call budget of ${budget.toolCalls} is exhausted`,
          }));
          continue;
        }
        state.toolCalls += 1;
        let output: unknown;
        try {
          const parsed = parseStructuredResultJson(call.function.arguments, {
            emptyMessage: `${call.function.name} arguments were empty`,
            invalidMessage:
              `${call.function.name} arguments were not valid JSON`,
          });
          output = await invokeResearchTool(
            request,
            state,
            call.function.name,
            objectValue(parsed),
          );
        } catch (error) {
          if (runWasAborted(request.signal)) {
            transcript.push(toolResultMessage(call.id, call.function.name, {
              error: "research cancelled during this call",
            }));
            for (const pending of calls.slice(callIndex + 1)) {
              transcript.push(toolResultMessage(
                pending.id,
                pending.function.name,
                { error: "research cancelled before this call executed" },
              ));
            }
            throw error;
          }
          output = { error: errorMessage(error) };
        }
        transcript.push(toolResultMessage(call.id, call.function.name, output));
      }
    }
    if (finalAssistant === undefined) {
      throw new Error(
        `research exceeded ${budget.modelTurns} model turns without a final kit`,
      );
    }
    const parsed = parseStructuredResultJson(finalAssistant.content, {
      emptyMessage: "research result was empty",
      invalidMessage: "research result was not valid JSON",
    });
    let raw = objectValue(parsed) as RawResearchResult;
    const invalidSourceIds = unreadSourceIds(raw, state);
    if (
      raw.status === "complete" && invalidSourceIds.length > 0 &&
      modelTurns < budget.modelTurns
    ) {
      if (runWasAborted(request.signal)) {
        throw abortError(request.signal);
      }
      transcript.push({
        role: "user",
        content: [
          "Citation repair turn: private tools are withheld. Correct sourceIds only and return the entire final JSON schema again.",
          `These cited ids were not returned by an exact read in this research call: ${
            JSON.stringify(invalidSourceIds)
          }`,
          sourceCatalog(state),
          "Use no other source ids. Remove a claim whose support is absent or return status incomplete; do not invent, approximate, or reuse an id from a prior research call.",
          `This is model turn ${
            modelTurns + 1
          } of ${budget.modelTurns}; no further repair turn is available.`,
        ].join("\n"),
      });
      const repaired = await options.modelClient.complete({
        model,
        transcript: [...transcript],
        tools: [],
        nativeModelToolIds: [],
        runId: request.researchRunId,
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
        ...(options.onAttempt !== undefined
          ? { onAttempt: options.onAttempt }
          : {}),
      });
      modelTurns += 1;
      await options.onUsage?.(repaired.usage);
      transcript.push(repaired.assistant);
      const repairCalls = repaired.assistant.toolCalls ?? [];
      for (const call of repairCalls) {
        transcript.push(toolResultMessage(call.id, call.function.name, {
          error: "private tools are withheld on the citation repair turn",
        }));
      }
      if (runWasAborted(request.signal)) {
        throw abortError(request.signal);
      }
      if (repairCalls.length === 0) {
        try {
          raw = objectValue(parseStructuredResultJson(
            repaired.assistant.content,
            {
              emptyMessage: "citation repair result was empty",
              invalidMessage: "citation repair result was not valid JSON",
            },
          )) as RawResearchResult;
        } catch {
          // The original candidate remains available for strict admission.
        }
      }
    }
    const kit = await admitResearchResult(
      request.task,
      raw,
      state,
      request.purpose,
    );
    return { kit, record: record() };
  } catch (error) {
    if (error instanceof HarnessResearchError) throw error;
    throw new HarnessResearchError(errorMessage(error), record());
  }
};
