/**
 * Language-model answers for pattern tests.
 *
 * A test states what the model answers by exporting a module-scope
 * `llmMocks: LLMMockEntry[]`. The runner installs an {@link LLMMockResponder}
 * as the process's LLM responder (`setLLMResponder()` in `@commonfabric/llm`)
 * for every test, whether or not the test exports any entries, so every
 * request a `generateText`, `generateObject`, `llm`, or `llmDialog` makes is
 * answered here and none reaches a model.
 *
 * A request is answered by the first entry, in the order the test lists them,
 * that no earlier request used up, whose kind fits the request, and whose
 * `when` conditions the request meets. An entry is used up by the request it
 * answers, unless it says `repeat`. A request no entry answers fails, and so does
 * the test.
 *
 * A multi-user test's participants run in workers of their own, each with an
 * {@link LLMForwardingResponder} that sends its requests to the orchestrator,
 * which answers them with {@link answerForwardedLLMRequest} through the
 * responder installed there. So every request of a test, from any participant
 * or from the serving loop the orchestrator hosts, draws on the same entries.
 */

import {
  type ConversationFixtureAssertions,
  extractMessageText,
  LLMClient,
  type LLMGenerateObjectRequest,
  type LLMGenerateObjectResponse,
  type LLMRequest,
  type LLMResponder,
  type LLMResponse,
  requestMismatch,
} from "@commonfabric/llm";
import { defer, type Deferred } from "@commonfabric/async/defer";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isPureJson } from "@commonfabric/json";
import { isObjectNotArray } from "@commonfabric/js-values/types";

/** A tool the model calls, in an answer to a request that offers tools. */
export interface LLMMockToolCall {
  /** The tool's name, as the request offers it. */
  name: string;

  /** The input the model calls the tool with. */
  input: Record<string, unknown>;

  /** The call's identifier; defaults to one derived from the entry. */
  id?: string;
}

/**
 * One answer a test states. It carries exactly one kind of answer:
 *
 * - `text`, `toolCalls`, or both: the reply to a text request, which is what
 *   `generateText`, `llm`, and each turn of `llmDialog` make. A streamed
 *   request receives the text as its partial result before the reply.
 * - `object`: the reply to a `generateObject` request. One given tools is sent
 *   as a text request offering a `presentResult` tool, which the reply calls
 *   with the object.
 * - `error`: the request fails with this message, whichever kind it is.
 */
export interface LLMMockEntry {
  /**
   * Conditions the request has to meet for this entry to answer it. An entry
   * without any answers the next request of its kind.
   */
  when?: ConversationFixtureAssertions;

  text?: string;
  toolCalls?: LLMMockToolCall[];
  object?: Record<string, unknown>;
  error?: string;

  /** Whether this entry answers every request it fits, rather than one. */
  repeat?: boolean;
}

type RequestKind = "text" | "object";

const ENTRY_KEYS = new Set(Object.keys(
  {
    when: true,
    text: true,
    toolCalls: true,
    object: true,
    error: true,
    repeat: true,
  } satisfies Record<keyof LLMMockEntry, true>,
));
const WHEN_KEYS = new Set(Object.keys(
  {
    messageCount: true,
    messagesContain: true,
    lastMessageContains: true,
    hasTools: true,
    systemContains: true,
  } satisfies Record<keyof ConversationFixtureAssertions, true>,
));

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** What is wrong with `when`, or `undefined` when it is well formed. */
function whenProblem(when: unknown): string | undefined {
  if (!isObjectNotArray(when)) return "`when` is not an object";
  const unknownKey = Object.keys(when).find((key) => !WHEN_KEYS.has(key));
  if (unknownKey !== undefined) {
    return `\`when\` has unknown key "${unknownKey}"`;
  }
  if (
    when.messageCount !== undefined && !Number.isInteger(when.messageCount)
  ) {
    return "`when.messageCount` is not an integer";
  }
  for (const key of ["messagesContain", "hasTools"] as const) {
    if (when[key] !== undefined && !isStringArray(when[key])) {
      return `\`when.${key}\` is not an array of strings`;
    }
  }
  for (const key of ["lastMessageContains", "systemContains"] as const) {
    if (when[key] !== undefined && typeof when[key] !== "string") {
      return `\`when.${key}\` is not a string`;
    }
  }
  return undefined;
}

/** What is wrong with a tool call, or `undefined` when it is well formed. */
function toolCallProblem(call: unknown): string | undefined {
  if (!isObjectNotArray(call)) return "is not an object";
  if (typeof call.name !== "string") return "has no string `name`";
  if (!isObjectNotArray(call.input) || !isPureJson(call.input)) {
    return "has an `input` that is not a plain JSON object";
  }
  if (call.id !== undefined && typeof call.id !== "string") {
    return "has an `id` that is not a string";
  }
  return undefined;
}

/** What is wrong with `entry`, or `undefined` when it is well formed. */
function entryProblem(entry: unknown): string | undefined {
  if (!isObjectNotArray(entry)) return "is not an object";
  const unknownKey = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
  if (unknownKey !== undefined) return `has unknown key "${unknownKey}"`;
  if (entry.when !== undefined) {
    const problem = whenProblem(entry.when);
    if (problem !== undefined) return problem;
  }
  const answers = ["text", "toolCalls", "object", "error"].filter((key) =>
    entry[key] !== undefined
  );
  if (answers.length === 0) {
    return "states no answer: give it `text`, `toolCalls`, `object`, or `error`";
  }
  if (
    answers.length > 1 &&
    !(answers.length === 2 && answers.includes("text") &&
      answers.includes("toolCalls"))
  ) {
    return `states more than one kind of answer (${answers.join(", ")})`;
  }
  if (entry.text !== undefined && typeof entry.text !== "string") {
    return "`text` is not a string";
  }
  if (entry.error !== undefined && typeof entry.error !== "string") {
    return "`error` is not a string";
  }
  if (entry.repeat !== undefined && typeof entry.repeat !== "boolean") {
    return "`repeat` is not a boolean";
  }
  if (entry.repeat && entry.toolCalls !== undefined) {
    return "repeats a tool call, which would answer every turn with another";
  }
  if (
    entry.object !== undefined &&
    (!isObjectNotArray(entry.object) || !isPureJson(entry.object))
  ) {
    return "`object` is not a plain JSON object";
  }
  if (entry.toolCalls !== undefined) {
    if (!Array.isArray(entry.toolCalls)) return "`toolCalls` is not an array";
    for (const [index, call] of entry.toolCalls.entries()) {
      const problem = toolCallProblem(call);
      if (problem !== undefined) return `tool call ${index} ${problem}`;
    }
  }
  return undefined;
}

const isLLMMockEntry = (entry: unknown): entry is LLMMockEntry =>
  entryProblem(entry) === undefined;

/**
 * The entries a test's module namespace exports as `llmMocks`, or none when it
 * exports nothing by that name. Throws, naming the entry and what is wrong
 * with it, when the export is not an array of well-formed entries, so that an
 * answer the test meant to state is never dropped.
 */
export function readLLMMocks(main: unknown): LLMMockEntry[] {
  const raw = isObjectNotArray(main) ? main.llmMocks : undefined;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error("The test's `llmMocks` export is not an array.");
  }
  return raw.map((entry, index) => {
    if (isLLMMockEntry(entry)) return entry;
    throw new Error(`llmMocks[${index}] ${entryProblem(entry)}.`);
  });
}

/** `text` cut to `length` characters, marking the cut. */
const clip = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length)}…` : text;

/** A request as a failure message describes it. */
function describeRequest(
  kind: RequestKind,
  request: LLMRequest | LLMGenerateObjectRequest,
): string {
  const lines = [
    `a ${
      kind === "text" ? "text" : "generateObject"
    } request with ${request.messages.length} message(s)`,
    `  last message: ${
      JSON.stringify(
        clip(extractMessageText(request.messages.at(-1)?.content), 200),
      )
    }`,
  ];
  if (request.system) {
    lines.push(`  system: ${JSON.stringify(clip(request.system, 120))}`);
  }
  const tools = "tools" in request ? Object.keys(request.tools ?? {}) : [];
  if (tools.length > 0) lines.push(`  tools: ${tools.join(", ")}`);
  return lines.join("\n");
}

/**
 * The conditions a request has to meet for `entry` to answer it: its `when`,
 * and, for each tool it calls, that the request offers that tool.
 */
function conditionsOf(entry: LLMMockEntry): ConversationFixtureAssertions {
  const when = entry.when ?? {};
  if (!entry.toolCalls?.length) return when;
  return {
    ...when,
    hasTools: [
      ...(when.hasTools ?? []),
      ...entry.toolCalls.map((call) => call.name),
    ],
  };
}

/** The tool through which a `generateObject` given tools returns its result. */
const PRESENT_RESULT_TOOL = "presentResult";

/**
 * Whether `entry` answers `request`, a request of `kind`. A text request
 * offering the tool a `generateObject` given tools returns its result through
 * is answered by an `object`, or by `toolCalls` the model makes on the way,
 * but not by `text` alone.
 */
function fitsKind(
  entry: LLMMockEntry,
  kind: RequestKind,
  request: LLMRequest | LLMGenerateObjectRequest,
): boolean {
  if (entry.error !== undefined) return true;
  const offersPresentResult = "tools" in request &&
    request.tools?.[PRESENT_RESULT_TOOL] !== undefined;
  if (entry.object !== undefined) {
    return kind === "object" || offersPresentResult;
  }
  return kind === "text" &&
    (entry.toolCalls !== undefined || !offersPresentResult);
}

/**
 * Answers language-model requests from a test's `llmMocks`, and records the
 * requests no entry answered.
 */
export class LLMMockResponder implements LLMResponder {
  readonly #entries: readonly LLMMockEntry[];
  readonly #used: boolean[];
  readonly #unanswered: string[] = [];

  constructor(entries: readonly LLMMockEntry[]) {
    this.#entries = entries;
    this.#used = entries.map(() => false);
  }

  /** One message for each request no entry answered. */
  get unanswered(): string[] {
    return [...this.#unanswered];
  }

  sendRequest(
    request: LLMRequest,
    callback: ((text: string) => void) | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<LLMResponse> {
    return new Promise((resolve) =>
      resolve(this.#answer("text", request, abortSignal, (entry, index) => {
        const text = entry.text ?? "";
        if (callback && text) callback(text);
        const toolCalls = entry.object === undefined
          ? entry.toolCalls ?? []
          : [{ name: PRESENT_RESULT_TOOL, input: entry.object }];
        // The content has the shape a streamed reply assembles to.
        const content = [
          ...(text.trim() ? [{ type: "text" as const, text }] : []),
          ...toolCalls.map((call: LLMMockToolCall, callIndex) => ({
            type: "tool-call" as const,
            toolCallId: call.id ?? `llm-mock-${index}-${callIndex}`,
            toolName: call.name,
            input: call.input,
          })),
        ];
        return {
          role: "assistant",
          content: content.length > 0 ? content : text,
          id: `llm-mock-${index}`,
        };
      }))
    );
  }

  generateObject(
    request: LLMGenerateObjectRequest,
    abortSignal: AbortSignal | undefined,
  ): Promise<LLMGenerateObjectResponse> {
    return new Promise((resolve) =>
      resolve(this.#answer("object", request, abortSignal, (entry, index) => ({
        object: entry.object ?? {},
        id: `llm-mock-${index}`,
      })))
    );
  }

  /**
   * Takes the entry that answers `request` and returns what `reply` makes of
   * it. Throws when there is no such entry, or when the entry states an
   * error.
   */
  #answer<Request extends LLMRequest | LLMGenerateObjectRequest, Reply>(
    kind: RequestKind,
    request: Request,
    abortSignal: AbortSignal | undefined,
    reply: (entry: LLMMockEntry, index: number) => Reply,
  ): Reply {
    abortSignal?.throwIfAborted();
    const candidates = this.#entries.flatMap((entry, index) =>
      !this.#used[index] &&
        fitsKind(entry, kind, request)
        ? [{ entry, index }]
        : []
    );
    const chosen = candidates.find(({ entry }) =>
      requestMismatch(conditionsOf(entry), request) === undefined
    );
    if (chosen === undefined) {
      const message = [
        `No llmMocks entry answers ${describeRequest(kind, request)}`,
        ...candidates.map(({ entry, index }) =>
          `  llmMocks[${index}] does not fit: ${
            requestMismatch(conditionsOf(entry), request)
          }`
        ),
      ].join("\n");
      this.#unanswered.push(message);
      throw new Error(message);
    }
    if (!chosen.entry.repeat) this.#used[chosen.index] = true;
    if (chosen.entry.error !== undefined) throw new Error(chosen.entry.error);
    return reply(chosen.entry, chosen.index);
  }
}

/**
 * The message a multi-user participant's worker posts to have the
 * orchestrator answer a language-model request.
 */
export type LLMForwardedRequest =
  & { llmRequest: number }
  & (
    | { kind: "text"; request: LLMRequest; streamed: boolean }
    | { kind: "object"; request: LLMGenerateObjectRequest }
  );

/**
 * The orchestrator's answer to an {@link LLMForwardedRequest}. A text reply
 * carries the partial results a streamed request received, in order.
 */
export type LLMForwardedAnswer =
  & { llmAnswer: number }
  & (
    | { kind: "text"; reply: LLMResponse; partials: string[] }
    | { kind: "object"; reply: LLMGenerateObjectResponse }
    | { error: string }
  );

const orchestratorClient = new LLMClient();

/**
 * Answers `message` through this process's LLM client, and so through the
 * responder installed here, as the reply or the failure the worker that sent
 * it is to give its caller.
 */
export async function answerForwardedLLMRequest(
  message: LLMForwardedRequest,
): Promise<LLMForwardedAnswer> {
  const llmAnswer = message.llmRequest;
  try {
    if (message.kind === "object") {
      const reply = await orchestratorClient.generateObject(message.request);
      return { llmAnswer, kind: "object", reply };
    }
    const partials: string[] = [];
    const reply = await orchestratorClient.sendRequest(
      message.request,
      message.streamed ? (text) => partials.push(text) : undefined,
    );
    return { llmAnswer, kind: "text", reply, partials };
  } catch (error) {
    return { llmAnswer, error: describeFailure(error) };
  }
}

/**
 * The responder a multi-user participant's worker installs: it sends each
 * request to the orchestrator with `post`, and settles it with the answer
 * handed to {@link receive}.
 */
export class LLMForwardingResponder implements LLMResponder {
  readonly #post: (message: LLMForwardedRequest) => void;
  readonly #waiting = new Map<number, Deferred<LLMForwardedAnswer>>();
  #nextRequest = 0;

  constructor(post: (message: LLMForwardedRequest) => void) {
    this.#post = post;
  }

  /** Settles the request `answer` answers. */
  receive(answer: LLMForwardedAnswer): void {
    const waiting = this.#waiting.get(answer.llmAnswer);
    this.#waiting.delete(answer.llmAnswer);
    waiting?.resolve(answer);
  }

  async sendRequest(
    request: LLMRequest,
    callback: ((text: string) => void) | undefined,
    abortSignal: AbortSignal | undefined,
  ): Promise<LLMResponse> {
    abortSignal?.throwIfAborted();
    const answer = await this.#forward((llmRequest) => ({
      llmRequest,
      kind: "text",
      request,
      streamed: callback !== undefined,
    }));
    if ("error" in answer) throw new Error(answer.error);
    if (answer.kind !== "text") {
      throw new Error("A text request was answered with an object.");
    }
    for (const partial of answer.partials) callback?.(partial);
    return answer.reply;
  }

  async generateObject(
    request: LLMGenerateObjectRequest,
    abortSignal: AbortSignal | undefined,
  ): Promise<LLMGenerateObjectResponse> {
    abortSignal?.throwIfAborted();
    const answer = await this.#forward((llmRequest) => ({
      llmRequest,
      kind: "object",
      request,
    }));
    if ("error" in answer) throw new Error(answer.error);
    if (answer.kind !== "object") {
      throw new Error("A generateObject request was answered with text.");
    }
    return answer.reply;
  }

  #forward(
    message: (llmRequest: number) => LLMForwardedRequest,
  ): Promise<LLMForwardedAnswer> {
    const llmRequest = this.#nextRequest++;
    const answer = defer<LLMForwardedAnswer>();
    this.#waiting.set(llmRequest, answer);
    try {
      this.#post(message(llmRequest));
    } catch (error) {
      this.#waiting.delete(llmRequest);
      throw error;
    }
    return answer.promise;
  }
}
