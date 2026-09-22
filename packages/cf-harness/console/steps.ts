/**
 * A run as a timeline you can scrub. The feed says what happened next; this
 * says what the run looked like at step N — the call that was made, the whole
 * of what went into it and came back, and which handles were in scope by then.
 *
 * Handle scope is reconstructed rather than recorded. `run-state.json` carries
 * one handle table, the run's last, so "in scope at step N" is derived by
 * walking the transcript forward and taking a handle to be in scope from the
 * step its token first appears in. That is the same order the model saw them
 * in, which is the order that matters for reading a run back.
 */

import type { CfcLabelViewEntry } from "@commonfabric/runner/cfc";
import { matchLLMFriendlyLink } from "@commonfabric/runner/shared";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { parseConsoleReference } from "./reference.ts";
import {
  HANDLE_TOKEN_PATTERN,
  type HarnessHandleEntry,
  type HarnessHandleTable,
} from "../src/contracts/handle-table.ts";
import type {
  HarnessToolCall,
  HarnessTranscriptMessage,
} from "../src/contracts/transcript.ts";
import type { ToolResultRef } from "../src/contracts/tool-result.ts";
import type { HarnessPolicyEvent } from "../src/contracts/policy.ts";
import type { HarnessPolicyDecisionRecord } from "../src/contracts/policy-trace.ts";
import type { HarnessToolPolicyDecision } from "../src/contracts/run-report.ts";
import {
  HARNESS_RELEASE_BOUNDARIES,
  HARNESS_RELEASE_DECISION_REASON_CODES,
  harnessReleaseDecisionOutcome,
} from "../src/contracts/policy-refusal.ts";
import type { HarnessCfcInvocationContext } from "../src/contracts/cfc-invocation-context.ts";
import type {
  HarnessTranscriptOmissionRule,
  HarnessTranscriptOmissions,
} from "../src/contracts/transcript-omissions.ts";
import {
  scrubBareFabricIdentifiersDeep,
} from "../src/fabric-identifier-scrub.ts";
import {
  cellLabelsAt,
  type ConsoleCellLabelIndex,
  type ConsoleCellLabels,
} from "./cell-labels.ts";

/** One place a handle was passed into a call. */
export interface ConsoleHandleUse {
  /** The step that passed it. */
  step: number;

  /** The tool it was passed to. */
  toolName: string;

  /**
   * How it was passed: the `inputs` key that carried it into a pattern, or the
   * argument name for a tool that takes a handle directly.
   */
  as: string;
}

/**
 * A handle, and everything the run knows about what it stands for. This is
 * what answers the questions asked of a reference in a call: what is it, where
 * did it come from, what rides on it, and where else was it used.
 */
export interface ConsoleHandle {
  token: string;

  /** The address the handle stands for, when the run's table still holds it. */
  ref?: string;

  addressKey?: string;

  /** The step whose text first carried this token. */
  introducedAtStep: number;

  /**
   * The step whose `run_pattern` result minted this handle — where the value
   * came from. Absent for a handle that arrived from an earlier turn or from
   * a child's result rather than being made here.
   */
  producedByStep?: number;

  /** The name `assign_slug` gave it, once it has one. */
  slug?: string;

  /** The address a person can open, once the handle has been named. */
  url?: string;

  /**
   * The shape of the value behind it, as the pattern that made it declared.
   * Absent means no mint knew the shape, not that the referent has none.
   */
  schema?: unknown;

  /** Every call this handle was passed into. */
  uses: readonly ConsoleHandleUse[];

  /**
   * Confidentiality atoms the sandbox invocation context put on the arguments
   * this handle was passed as. A fact about the calls that spent it: what the
   * runtime labelled a position with at the moment a call went through it.
   */
  confidentiality: readonly string[];

  /**
   * The labels the space holds for the cell this handle names. A fact about
   * the cell, which is why it stands beside `confidentiality` rather than
   * replacing it: a cell the space labels may be passed to a call that carries
   * no atom, and a call may carry one on a cell the space labels with nothing.
   */
  labels?: ConsoleCellLabels;
}

/**
 * One argument of a call, read as what it actually is: a reference to a cell,
 * or a plain value.
 *
 * A reference reaches a call written either way — as a `cfh:a:` handle token,
 * or as the whole LLM-friendly link the token stands for — and both name the
 * same cell. Reading them as one is what lets an input be traced back to the
 * call that produced it whichever spelling the model used.
 */
export interface ConsoleArgumentRef {
  /** The argument name that carried it. */
  key: string;

  /** Whether this argument names a cell at all. */
  isReference: boolean;

  /** The handle token, when the argument was written as one. */
  token?: string;

  /** The address it stands for, from the token or from the link itself. */
  ref?: string;

  /** The name the cell carries, once something has named it. */
  slug?: string;

  /** The step whose result minted it — where this value came from. */
  producedByStep?: number;

  /** The shape the pattern that made it declared. */
  schema?: unknown;

  /** Confidentiality atoms the invocation context put on this argument. */
  confidentiality: readonly string[];

  /**
   * Integrity atoms the invocation context recorded on this argument — the
   * prompt slot's influence on what the model wrote there.
   */
  integrity: readonly string[];

  /** The labels the space holds for the cell this argument names. */
  labels?: ConsoleCellLabels;

  /** The argument as written, for one that names nothing. */
  value?: unknown;
}

/** What kind of step this is, which decides what the detail pane shows. */
export type ConsoleStepKind = "system" | "user" | "assistant" | "tool";

/** How a step turned out, at a glance. */
export type ConsoleStepStatus = "ok" | "error" | "denied" | "none";

/**
 * What a tool result let across as a value, beside what it sealed behind a
 * reference. The harness seals a string the schema does not pin to an enum or
 * a const, but a number is never sealed and neither is an array of them — so
 * the size of what crossed as plain data is worth stating rather than leaving
 * to be read out of a JSON block.
 */
export interface ConsoleDisclosure {
  /** Bytes of JSON the result carried as value. */
  valueBytes: number;

  /** Positions the sanitizer replaced with an opaque link. */
  sealedPositions: number;

  /**
   * The longest run of numbers the value carries. An array of integers is an
   * array of values none of which is sealed, so a long one is a channel wide
   * enough for arbitrary content and is worth looking at.
   */
  longestNumericRun: number;
}

/** One full tool-output artifact available to the retrospective reader. */
export interface ConsoleToolOutputArtifact {
  artifactPath: string;
  value: unknown;
}

/** One artifact position withheld from a model-facing tool result. */
export interface ConsoleWithheldLocation {
  rule: HarnessTranscriptOmissionRule;
  artifactPath: string;
  jsonPointer: string;

  /** Full operator value, absent where CFC requires a redaction marker. */
  value?: unknown;

  /** Fixed marker shown instead of a value CFC withheld. */
  redaction?: string;

  /** Whether the recorded artifact and pointer were available to this read. */
  available: boolean;
}

/** What the omission record says about one tool result. */
export interface ConsoleWithheldResult {
  status:
    | "recorded"
    | "unrecorded"
    | "record-unreadable"
    | "record-entry-missing";
  locations: readonly ConsoleWithheldLocation[];
}

/** What the console could establish about the run's omission artifact. */
export type ConsoleTranscriptOmissionsState =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "present"; value: HarnessTranscriptOmissions };

/** One step of a run. */
export interface ConsoleStep {
  index: number;
  kind: ConsoleStepKind;

  /** Assistant or user prose, and the system prompt for step zero. */
  text?: string;

  toolName?: string;
  toolCallId?: string;

  /**
   * The call's arguments, parsed. Arguments arrive as a JSON string the model
   * produced, so one it malformed is reported as `inputText` instead.
   */
  input?: unknown;

  inputText?: string;

  /** The call's source was replaced by the superseded-source marker. */
  sourceReplacedByLaterAttempt?: true;

  /** The result the model read, parsed on the same terms as the input. */
  output?: unknown;

  outputText?: string;

  /** Where the untruncated result was persisted, when the run recorded it. */
  resultRef?: ToolResultRef;

  /** The `delegate_task` child this step started, whose run has its own timeline. */
  childRunId?: string;

  /** Tokens whose first appearance in the run is this step. */
  handlesIntroduced: readonly string[];

  /** Every token in scope by the end of this step, in the order introduced. */
  handlesInScope: readonly string[];

  /** How the step turned out, from its own result and from CFC's verdict. */
  status: ConsoleStepStatus;

  /** The CFC decision for this call, when the run recorded one. */
  policy?: {
    decision: string;
    effectClass?: string;
    reasonCodes: readonly string[];
  };

  /** Policy events raised against this call — a denial names its reason. */
  policyEvents: readonly HarnessPolicyEvent[];

  /** What the result let across as value, for a step whose result carries one. */
  disclosure?: ConsoleDisclosure;

  /** Retrospective join from the model-facing result to withheld positions. */
  withheld: ConsoleWithheldResult;

  /**
   * The CFC invocation context recorded for this call. Under a posture that
   * propagates flow labels, its `cfcInputLabels` are the confidentiality
   * labels the runtime computed for each input position.
   */
  invocation?: HarnessCfcInvocationContext;
}

const textEncoder = new TextEncoder();

const parseJson = (text: string): { value?: unknown; ok: boolean } => {
  try {
    return { value: JSON.parse(text), ok: true };
  } catch {
    return { ok: false };
  }
};

/** Every handle token in a piece of text, in the order it carries them. */
const tokensInText = (text: string): string[] =>
  text.match(new RegExp(HANDLE_TOKEN_PATTERN)) ?? [];

/**
 * Every handle token in a value, wherever it sits inside it. A token reaches a
 * call as a bare string as often as nested in an object, so the value is read
 * whole rather than only when it is a string.
 */
export const handleTokensIn = (value: unknown): string[] =>
  tokensInText(
    typeof value === "string" ? value : JSON.stringify(value) ?? "",
  );

const asRecord = (value: unknown): Record<string, unknown> =>
  isObjectNotArray(value) ? value as Record<string, unknown> : {};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const sourceWasReplaced = (value: unknown): boolean => {
  const sourceText = asRecord(value).sourceText;
  return typeof sourceText === "string" && sourceText.startsWith(
    "[cf-harness: superseded run_pattern source collapsed",
  );
};

/** The tool calls an assistant made, by call id. */
const toolCallsById = (
  transcript: readonly HarnessTranscriptMessage[],
): Map<string, HarnessToolCall> => {
  const calls = new Map<string, HarnessToolCall>();
  for (const message of transcript) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        calls.set(call.id, call);
      }
    }
  }
  return calls;
};

/**
 * The longest run of consecutive numbers anywhere in a value. Walks arrays and
 * object values alike, because a channel does not have to sit at the root.
 */
const longestNumericRun = (value: unknown): number => {
  if (Array.isArray(value)) {
    let best = 0;
    let current = 0;
    for (const item of value) {
      if (typeof item === "number") {
        current += 1;
        best = Math.max(best, current);
      } else {
        current = 0;
        best = Math.max(best, longestNumericRun(item));
      }
    }
    return best;
  }
  if (isObjectOrArray(value)) {
    let best = 0;
    for (const item of Object.values(value)) {
      best = Math.max(best, longestNumericRun(item));
    }
    return best;
  }
  return 0;
};

/** Positions a sanitizer replaced with an opaque link, counted in a value. */
const sealedPositions = (value: unknown): number => {
  if (typeof value === "string") {
    return value.startsWith("opaque:") ? 1 : 0;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, item) => total + sealedPositions(item),
      0,
    );
  }
  if (isObjectOrArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record["@link"] === "string") {
      return String(record["@link"]).startsWith("opaque:") ? 1 : 0;
    }
    return Object.values(record).reduce<number>(
      (total, item) => total + sealedPositions(item),
      0,
    );
  }
  return 0;
};

/**
 * What a result let across as a value. Absent for a result carrying none,
 * which is most of them: the question only arises where a schema admitted
 * something.
 */
const disclosureOf = (output: unknown): ConsoleDisclosure | undefined => {
  const record = isObjectOrArray(output)
    ? output as Record<string, unknown>
    : undefined;
  if (record === undefined || !Object.hasOwn(record, "value")) {
    return undefined;
  }
  const value = record.value;
  return {
    // The pane reports bytes, so the JSON is measured encoded: a code unit is
    // not a byte, and the characters a channel would be widest in are exactly
    // the ones that take more than one.
    valueBytes:
      textEncoder.encode(JSON.stringify(value ?? null) ?? "null").byteLength,
    sealedPositions: sealedPositions(output),
    longestNumericRun: longestNumericRun(value),
  };
};

/**
 * What a tool answers with when it did the thing it was asked to do. Most
 * answer `ok`; the two skill tools answer with the act itself, and reading
 * either of those as a failure would paint a whole run red. A status this does
 * not name is a failure, so a tool that grows a new success status belongs
 * here.
 */
const TOOL_SUCCESS_STATUSES = new Map<string, readonly string[]>([
  ["read_skill_resource", ["read", "binary"]],
  ["run_skill_script", ["executed"]],
]);

/** What a tool this does not name is taken to report success with. */
const DEFAULT_SUCCESS_STATUSES: readonly string[] = ["ok", "completed"];

/**
 * What a decision decided, taken from the boundary's own reason code wherever
 * a boundary decided it.
 *
 * The outcome word a run persisted is the word its build could spell, and a
 * run recorded before a word existed carries the one it had. The reason code
 * on the `release` record is the fact, and it does not move: a decision
 * naming `cfc_release_withheld` is a withheld release whatever the trace says
 * beside it. Reading it this way is what AUD-16 does, so the console and the
 * audit answer alike over one corpus.
 *
 * `denied` is left to a decision with no release record — a call authority
 * refused, which never ran — and to `cfc_commit_refused`, a write the runner
 * refused, which landed no result.
 */
const outcomeOf = (
  decision: HarnessPolicyDecisionRecord | undefined,
): HarnessToolPolicyDecision | undefined => {
  if (decision === undefined) return undefined;
  const release = decision.release as
    | { reasonCode?: unknown; boundary?: unknown }
    | null
    | undefined;
  // `null` as well as absent: a decision persisted with an empty release is a
  // record this cannot read, and dereferencing it would throw before the step
  // could be given a status at all.
  if (release === null || release === undefined) return decision.decision;
  // Both discriminants are checked against the sets the contract exports for
  // the purpose, rather than against literals repeated here: a closed union
  // that gains a member should widen what this reads, not silently stop
  // matching a record the contract calls valid. A trace is read back through
  // JSON, so a record answering neither set is a release record this cannot
  // read — not evidence to rewrite a persisted outcome with, so the persisted
  // word stands.
  const boundary = HARNESS_RELEASE_BOUNDARIES.find((known) =>
    known === release.boundary
  );
  if (boundary === undefined) return decision.decision;
  const reasonCode = HARNESS_RELEASE_DECISION_REASON_CODES.find((known) =>
    known === release.reasonCode
  );
  return reasonCode === undefined
    ? decision.decision
    : harnessReleaseDecisionOutcome(reasonCode);
};

/** How a tool step turned out, read from its own result and CFC's verdict. */
const statusOf = (
  toolName: string,
  output: unknown,
  outputText: string | undefined,
  decision: HarnessPolicyDecisionRecord | undefined,
  events: readonly HarnessPolicyEvent[],
): ConsoleStepStatus => {
  const outcome = outcomeOf(decision);
  if (
    outcome === "denied" ||
    events.some((event) => event.severity === "denied")
  ) {
    return "denied";
  }
  // A call rejected for its arguments ran nothing, and its answer carries no
  // status field of its own to read that from. It is an error rather than a
  // denial: policy refused it nothing.
  if (outcome === "invalid") {
    return "error";
  }
  // A `withheld` outcome is deliberately not read here. The call ran and
  // answered with the reference to the result whose values the boundary held
  // back, so the step's outcome is the one its own answer states, below; the
  // boundary shows as the withheld marker beside the CFC line instead.
  const record = isObjectOrArray(output)
    ? output as Record<string, unknown>
    : undefined;
  const status = record?.status;
  if (typeof status === "string") {
    const successes = TOOL_SUCCESS_STATUSES.get(toolName) ??
      DEFAULT_SUCCESS_STATUSES;
    return successes.includes(status) ? "ok" : "error";
  }
  if (record?.error !== undefined) {
    return "error";
  }
  return outputText === undefined && record === undefined ? "none" : "ok";
};

/** The child run a `delegate_task` result names, when it names one. */
const childRunIdOf = (output: unknown): string | undefined => {
  const record = isObjectOrArray(output)
    ? output as { subagent?: { childRunId?: unknown } }
    : undefined;
  const childRunId = record?.subagent?.childRunId;
  return typeof childRunId === "string" ? childRunId : undefined;
};

const artifactName = (path: string): string =>
  path.split(/[\\/]/).at(-1) ?? path;

const valueAtJsonPointer = (
  value: unknown,
  pointer: string,
): { available: boolean; value?: unknown } => {
  if (pointer === "") {
    return { available: true, value };
  }
  if (!pointer.startsWith("/")) {
    return { available: false };
  }
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment) || Number(segment) >= current.length) {
        return { available: false };
      }
      current = current[Number(segment)];
      continue;
    }
    if (
      !isObjectOrArray(current) ||
      !Object.hasOwn(current, segment)
    ) {
      return { available: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { available: true, value: current };
};

const withheldFor = (
  message: HarnessTranscriptMessage & { role: "tool" },
  transcriptIndex: number,
  omissionState:
    | ConsoleTranscriptOmissionsState
    | HarnessTranscriptOmissions
    | undefined,
  toolOutputs: readonly ConsoleToolOutputArtifact[],
): ConsoleWithheldResult => {
  const omissions = omissionState === undefined
    ? undefined
    : "status" in omissionState
    ? omissionState.status === "present" ? omissionState.value : undefined
    : omissionState;
  if (omissionState !== undefined && "status" in omissionState) {
    if (omissionState.status === "unreadable") {
      return { status: "record-unreadable", locations: [] };
    }
  }
  const outputId = message.resultRef?.outputId;
  const result = outputId === undefined
    ? undefined
    : omissions?.results.find((entry) =>
      entry.outputId === String(outputId) &&
      entry.transcriptIndex === transcriptIndex &&
      entry.toolCallId === message.toolCallId &&
      entry.toolId === message.toolName
    );
  if (result === undefined) {
    return {
      status: omissions === undefined ? "unrecorded" : "record-entry-missing",
      locations: [],
    };
  }
  const rulesAtLocation = new Map<string, Set<HarnessTranscriptOmissionRule>>();
  for (const rule of result.rules) {
    for (const location of rule.locations) {
      const key = `${location.artifactPath}\u0000${location.jsonPointer}`;
      const rules = rulesAtLocation.get(key) ?? new Set();
      rules.add(rule.rule);
      rulesAtLocation.set(key, rules);
    }
  }
  const locations = result.rules.flatMap((rule) =>
    rule.locations.map((location): ConsoleWithheldLocation => {
      const artifact = toolOutputs.find((candidate) =>
        candidate.artifactPath === location.artifactPath ||
        artifactName(candidate.artifactPath) === artifactName(
            location.artifactPath,
          )
      );
      const held = artifact === undefined
        ? { available: false as const }
        : valueAtJsonPointer(artifact.value, location.jsonPointer);
      const locationRules = rulesAtLocation.get(
        `${location.artifactPath}\u0000${location.jsonPointer}`,
      );
      const bareIdentifierScrub = locationRules?.has(
        "bare-fabric-identifier-scrub",
      ) === true;
      const scrubbed = held.available && bareIdentifierScrub
        ? scrubBareFabricIdentifiersDeep(held.value)
        : held.value;
      const redaction = locationRules?.has("observation-denied") === true
        ? "[redacted by CFC]"
        : bareIdentifierScrub && !held.available
        ? "[fabric-id]"
        : bareIdentifierScrub && typeof scrubbed === "string"
        ? scrubbed
        : undefined;
      return {
        rule: rule.rule,
        artifactPath: location.artifactPath,
        jsonPointer: location.jsonPointer,
        available: held.available,
        ...(redaction !== undefined
          ? { redaction }
          : held.available
          ? { value: scrubbed }
          : {}),
      };
    })
  );
  return { status: "recorded", locations };
};

/**
 * The steps of a run. A tool call and the result answering it are one step
 * rather than two: what went in and what came back are the pair a person reads
 * together, and the assistant message that carried only the call has nothing
 * else to say.
 */
export const consoleRunSteps = (
  transcript: readonly HarnessTranscriptMessage[],
  policyDecisions: readonly HarnessPolicyDecisionRecord[] = [],
  policyEvents: readonly HarnessPolicyEvent[] = [],
  invocationContexts: readonly HarnessCfcInvocationContext[] = [],
  omissions?: ConsoleTranscriptOmissionsState | HarnessTranscriptOmissions,
  toolOutputs: readonly ConsoleToolOutputArtifact[] = [],
): readonly ConsoleStep[] => {
  // An invocation context names the output it was recorded for, which is the
  // same id the transcript's tool message carries as its result reference.
  // A tool that mints its output id only once the call has run — `read_file`
  // among them — records none, so those are held by the tool they name and
  // handed to that tool's steps in turn: both sequences are the run's own
  // order, so the nth context a tool recorded belongs to its nth step.
  const invocationsByOutput = new Map<string, HarnessCfcInvocationContext>();
  const unnamedInvocationsByTool = new Map<
    string,
    HarnessCfcInvocationContext[]
  >();
  for (const context of invocationContexts) {
    if (context.toolOutputId !== undefined) {
      invocationsByOutput.set(String(context.toolOutputId), context);
      continue;
    }
    const held = unnamedInvocationsByTool.get(context.toolId);
    if (held === undefined) {
      unnamedInvocationsByTool.set(context.toolId, [context]);
    } else {
      held.push(context);
    }
  }

  /** The context recorded for a step, by the id it named or by its turn. */
  const invocationFor = (
    toolName: string,
    resultRef: ToolResultRef | undefined,
  ): HarnessCfcInvocationContext | undefined => {
    const named = resultRef === undefined
      ? undefined
      : invocationsByOutput.get(String(resultRef.outputId));
    return named ?? unnamedInvocationsByTool.get(toolName)?.shift();
  };

  const calls = toolCallsById(transcript);
  const decisionsByCall = new Map(
    policyDecisions.map((decision) => [decision.toolCallId, decision]),
  );
  const eventsByCall = new Map<string, HarnessPolicyEvent[]>();
  for (const event of policyEvents) {
    if (event.toolCallId === undefined) {
      continue;
    }
    const held = eventsByCall.get(event.toolCallId);
    if (held === undefined) {
      eventsByCall.set(event.toolCallId, [event]);
    } else {
      held.push(event);
    }
  }
  const steps: ConsoleStep[] = [];
  const inScope: string[] = [];

  const admit = (texts: readonly string[]): string[] => {
    const introduced: string[] = [];
    for (const text of texts) {
      for (const token of handleTokensIn(text)) {
        if (!inScope.includes(token) && !introduced.includes(token)) {
          introduced.push(token);
        }
      }
    }
    inScope.push(...introduced);
    return introduced;
  };

  for (const [transcriptIndex, message] of transcript.entries()) {
    // An assistant message that only carries tool calls is the call's own
    // step, folded into the tool result below.
    if (
      message.role === "assistant" && message.content.trim() === "" &&
      (message.toolCalls?.length ?? 0) > 0
    ) {
      continue;
    }
    const index = steps.length;
    if (message.role === "tool") {
      const call = calls.get(message.toolCallId);
      const parsedInput = call === undefined
        ? { ok: false as const }
        : parseJson(call.function.arguments);
      const parsedOutput = parseJson(message.content);
      const handlesIntroduced = admit([
        call?.function.arguments ?? "",
        message.content,
      ]);
      const childRunId = childRunIdOf(parsedOutput.value);
      const decision = decisionsByCall.get(message.toolCallId);
      const events = eventsByCall.get(message.toolCallId) ?? [];
      const disclosure = disclosureOf(parsedOutput.value);
      steps.push({
        index,
        kind: "tool",
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        ...(parsedInput.ok
          ? { input: parsedInput.value }
          : call !== undefined
          ? { inputText: call.function.arguments }
          : {}),
        ...(message.toolName === "run_pattern" && parsedInput.ok &&
            sourceWasReplaced(parsedInput.value)
          ? { sourceReplacedByLaterAttempt: true as const }
          : {}),
        ...(parsedOutput.ok
          ? { output: parsedOutput.value }
          : { outputText: message.content }),
        ...(message.resultRef !== undefined
          ? { resultRef: message.resultRef }
          : {}),
        ...(childRunId !== undefined ? { childRunId } : {}),
        handlesIntroduced,
        handlesInScope: [...inScope],
        status: statusOf(
          message.toolName,
          parsedOutput.value,
          parsedOutput.ok ? undefined : message.content,
          decision,
          events,
        ),
        ...(decision !== undefined
          ? {
            policy: {
              // The badge and the marker beside it read this word, so the
              // rule lives here once rather than again at the view.
              decision: outcomeOf(decision) ?? decision.decision,
              ...(decision.effectClass !== undefined
                ? { effectClass: decision.effectClass }
                : {}),
              reasonCodes: decision.reasonCodes,
            },
          }
          : {}),
        policyEvents: events,
        ...(disclosure !== undefined ? { disclosure } : {}),
        withheld: withheldFor(
          message,
          transcriptIndex,
          omissions,
          toolOutputs,
        ),
        ...(() => {
          const invocation = invocationFor(
            message.toolName,
            message.resultRef,
          );
          return invocation === undefined ? {} : { invocation };
        })(),
      });
      continue;
    }
    const handlesIntroduced = admit([message.content]);
    steps.push({
      index,
      kind: message.role,
      text: message.content,
      handlesIntroduced,
      handlesInScope: [...inScope],
      status: "none",
      policyEvents: [],
      withheld: { status: "recorded", locations: [] },
    });
  }
  return steps;
};

/**
 * The handles a run introduced, each resolved against the run's own table and
 * against the labels the run's space holds for what it names. A token the
 * table no longer holds is still reported: that the run passed a handle is the
 * fact, and an address it did not keep is not a reason to hide it.
 */
export const consoleRunHandles = (
  steps: readonly ConsoleStep[],
  handleTable?: HarnessHandleTable,
  labels?: ConsoleCellLabelIndex,
): readonly ConsoleHandle[] => {
  const entries = new Map<string, HarnessHandleEntry>(
    (handleTable?.entries ?? []).map((entry) => [entry.token, entry]),
  );
  const provenance = handleProvenance(steps);
  const handles: ConsoleHandle[] = [];
  for (const step of steps) {
    for (const token of step.handlesIntroduced) {
      const entry = entries.get(token);
      const known = provenance.get(token);
      const cellLabels = labels === undefined
        ? undefined
        : cellLabelsAt(labels, entry?.ref);
      handles.push({
        token,
        ...(entry?.ref !== undefined ? { ref: entry.ref } : {}),
        ...(entry?.addressKey !== undefined
          ? { addressKey: entry.addressKey }
          : {}),
        introducedAtStep: step.index,
        ...(known?.producedByStep !== undefined
          ? { producedByStep: known.producedByStep }
          : {}),
        ...(known?.slug !== undefined ? { slug: known.slug } : {}),
        ...(known?.url !== undefined ? { url: known.url } : {}),
        ...(entry?.schema !== undefined ? { schema: entry.schema } : {}),
        uses: known?.uses ?? [],
        confidentiality: known?.confidentiality ?? [],
        ...(cellLabels !== undefined ? { labels: cellLabels } : {}),
      });
    }
  }
  return handles;
};

/** What each token is answerable for, read off the steps that touched it. */
interface HandleProvenance {
  producedByStep?: number;
  slug?: string;
  url?: string;
  uses: ConsoleHandleUse[];
  confidentiality: string[];
}

/**
 * Where each handle came from, where it went, and what rode on it.
 *
 * A `run_pattern` result mints one; `assign_slug` names one; an `inputs` entry
 * or a handle-taking argument spends one. Reading those three off the steps is
 * what lets a reference in a call be traced back to the call that made it.
 */
const handleProvenance = (
  steps: readonly ConsoleStep[],
): Map<string, HandleProvenance> => {
  const known = new Map<string, HandleProvenance>();
  const at = (token: string): HandleProvenance => {
    const held = known.get(token);
    if (held !== undefined) {
      return held;
    }
    const fresh: HandleProvenance = { uses: [], confidentiality: [] };
    known.set(token, fresh);
    return fresh;
  };

  for (const step of steps) {
    if (step.kind !== "tool") {
      continue;
    }
    const args = asRecord(step.input);
    const output = asRecord(step.output);
    if (step.toolName === "run_pattern") {
      for (const token of handleTokensIn(output.resultRef)) {
        at(token).producedByStep = step.index;
      }
      const patternKeys = Object.keys(asRecord(args.inputs));
      for (const [key, value] of Object.entries(asRecord(args.inputs))) {
        for (const token of handleTokensIn(value)) {
          const record = at(token);
          record.uses.push({
            step: step.index,
            toolName: "run_pattern",
            as: key,
          });
          for (const name of argumentAtomNames(step, key, patternKeys)) {
            if (!record.confidentiality.includes(name)) {
              record.confidentiality.push(name);
            }
          }
        }
      }
      continue;
    }
    // Every other tool that takes a handle takes it as a named argument, so
    // the argument's own name is how the handle was spent.
    const toolKeys = Object.keys(args);
    for (const [key, value] of Object.entries(args)) {
      for (const token of handleTokensIn(value)) {
        const record = at(token);
        record.uses.push({
          step: step.index,
          toolName: step.toolName ?? "tool",
          as: key,
        });
        // A handle spent on any tool carries whatever the runtime labelled
        // that argument with, not only one spent on `run_pattern`.
        for (const name of argumentAtomNames(step, key, toolKeys)) {
          if (!record.confidentiality.includes(name)) {
            record.confidentiality.push(name);
          }
        }
      }
    }
    if (step.toolName === "assign_slug" && step.status !== "error") {
      const slug = asString(output.slug) ?? asString(args.slug);
      const url = asString(output.url);
      for (const token of handleTokensIn(args.token)) {
        const record = at(token);
        if (slug !== undefined) {
          record.slug = slug;
        }
        if (url !== undefined) {
          record.url = url;
        }
      }
    }
  }
  return known;
};

/**
 * The cell an argument written as a link names, and the handle for it where the
 * run holds one.
 *
 * What counts as a link is the runner's own `matchLLMFriendlyLink`, so a
 * cross-space link and any entity prefix are recognised, not the `/of:` form
 * alone — a spelling this failed to recognise would read as a plain value and
 * lose the reference entirely.
 *
 * Addresses are compared after parsing, so aliases and explicit base scopes
 * match the same held cell. The deepest matching path wins. A link matching no
 * handle is still a reference — the run simply holds no handle for it.
 */
const linkTarget = (
  value: unknown,
  handles: readonly ConsoleHandle[],
): { ref: string; handle?: ConsoleHandle } | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trimStart();
  const address = parseConsoleReference(text);
  if (!matchLLMFriendlyLink.test(text) || address === undefined) {
    return undefined;
  }
  let best: ConsoleHandle | undefined;
  let bestDepth = -1;
  for (const handle of handles) {
    const candidate = handle.ref === undefined
      ? undefined
      : parseConsoleReference(handle.ref);
    if (
      candidate !== undefined && candidate.space === address.space &&
      candidate.id === address.id && candidate.scope === address.scope &&
      candidate.path.length > bestDepth &&
      candidate.path.length <= address.path.length &&
      candidate.path.every((key, index) => key === address.path[index])
    ) {
      best = handle;
      bestDepth = candidate.path.length;
    }
  }
  return best?.ref === undefined
    ? { ref: text }
    : { ref: best.ref, handle: best };
};

/**
 * A call's arguments, each read as a reference to a cell or as a plain value.
 *
 * `run_pattern` carries its references under `inputs`, and every other tool
 * that takes one takes it as a named argument, so both are read here. A
 * reference resolves against the run's handles whichever way it was written:
 * by token directly, and by link through the address the token stands for.
 *
 * The label index is what gives an argument the cell's own labels when the
 * link names a cell no handle stands for.
 */
export const consoleStepArguments = (
  step: ConsoleStep,
  handles: readonly ConsoleHandle[] = [],
  labels?: ConsoleCellLabelIndex,
): readonly ConsoleArgumentRef[] => {
  if (step.kind !== "tool") {
    return [];
  }
  const byToken = new Map(handles.map((handle) => [handle.token, handle]));
  const args = asRecord(step.input);
  const source = step.toolName === "run_pattern" ? asRecord(args.inputs) : args;
  const argumentKeys = Object.keys(source);
  return Object.entries(source).map(([key, value]): ConsoleArgumentRef => {
    const token = handleTokensIn(value)[0];
    const link = token === undefined ? linkTarget(value, handles) : undefined;
    const handle = token !== undefined ? byToken.get(token) : link?.handle;
    const ref = handle?.ref ?? link?.ref;
    const named = token ?? handle?.token;
    if (named === undefined && ref === undefined) {
      // A label belongs to the argument the runtime computed it for, whether
      // or not that argument names a cell — a shell command carries one and
      // names nothing.
      return {
        key,
        isReference: false,
        confidentiality: argumentAtomNames(step, key, argumentKeys),
        integrity: argumentInfluenceNames(step, key, argumentKeys),
        value,
      };
    }
    // The handle carries the cell's labels already; an argument written as a
    // whole link the run holds no handle for is looked up by the address the
    // link itself names, so both spellings reach the same labels.
    const cellLabels = handle?.labels ??
      (labels === undefined ? undefined : cellLabelsAt(labels, ref));
    return {
      key,
      isReference: true,
      ...(named !== undefined ? { token: named } : {}),
      ...(ref !== undefined ? { ref } : {}),
      ...(handle?.slug !== undefined ? { slug: handle.slug } : {}),
      ...(handle?.producedByStep !== undefined
        ? { producedByStep: handle.producedByStep }
        : {}),
      ...(handle?.schema !== undefined ? { schema: handle.schema } : {}),
      confidentiality: argumentAtomNames(step, key, argumentKeys),
      integrity: argumentInfluenceNames(step, key, argumentKeys),
      ...(cellLabels !== undefined ? { labels: cellLabels } : {}),
    };
  });
};

/**
 * The confidentiality atoms a step's labels put on one argument.
 *
 * A label entry names the input path the runtime computed it for, so a call
 * with labels on two arguments has two entries and neither governs the other.
 * Attaching every atom to every argument would report confidentiality on cells
 * that never carried it, which is worse than reporting none. An empty path is
 * the whole input and governs everything under it.
 *
 * Worth knowing while reading a run: an invocation context is recorded for a
 * sandbox operation, and its label paths are rooted at that operation's own
 * arguments — `command`, `argv`, `env` and the rest. A `run_pattern` result
 * carries no invocation context at all, so a cell minted by a pattern shows no
 * atoms however the run's flow labels are set.
 */
const argumentAtomNames = (
  step: ConsoleStep,
  key: string,
  argumentKeys: readonly string[] = [],
): string[] =>
  atomNamesAtArgument(
    step.invocation?.cfcInputLabels?.entries ?? [],
    "confidentiality",
    key,
    argumentKeys,
  );

/**
 * The integrity atoms the prompt slot's influence put on one argument, read
 * from `promptSlotInfluenceLabels` by the same path rule as
 * `argumentAtomNames()`.
 */
const argumentInfluenceNames = (
  step: ConsoleStep,
  key: string,
  argumentKeys: readonly string[] = [],
): string[] =>
  atomNamesAtArgument(
    step.invocation?.promptSlotInfluenceLabels?.entries ?? [],
    "integrity",
    key,
    argumentKeys,
  );

/** The names of the atoms on one axis of `entries` that govern `key`. */
const atomNamesAtArgument = (
  entries: readonly CfcLabelViewEntry[],
  axis: "confidentiality" | "integrity",
  key: string,
  argumentKeys: readonly string[],
): string[] => {
  // A label path is rooted at the operation's own argument, which is not
  // always what the model called it: a tool taking `path` and `content` may be
  // mediated as `args` and `stdin`. When no root names any argument of this
  // call, no mapping exists to apply and every entry governs the call rather
  // than being dropped — losing an observed atom is worse than spreading it.
  const rootsNameArguments = entries.some((entry) => {
    const root = String(entry.path[0] ?? "");
    return root !== "" && argumentKeys.includes(root);
  });
  const names: string[] = [];
  for (const entry of entries) {
    const path = entry.path.map(String);
    const governs = !rootsNameArguments || path.length === 0 ||
      path[0] === key;
    if (!governs) {
      continue;
    }
    for (const clause of entry.label?.[axis] ?? []) {
      const type = isObjectOrArray(clause)
        ? (clause as { type?: unknown }).type
        : undefined;
      if (typeof type === "string") {
        const name = type.split("/").pop() ?? type;
        if (!names.includes(name)) {
          names.push(name);
        }
      }
    }
  }
  return names;
};
