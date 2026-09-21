/**
 * Runtime schemas for the `agent` builtin: its parameters, its result cell,
 * the `AgentRun` record a request becomes, and the home-space index that
 * names every record a user has submitted. The record and index shapes are
 * the canonical definition of the queue a runner process reads. They live
 * here because `packages/runner` sits below `packages/patterns` in the layer
 * stack and cannot import from it: `packages/patterns/system/agent-run.tsx`
 * and `agent-queue.tsx` state the same shapes as pattern-facing types, and
 * `packages/runner/test/agent-schemas-parity.test.ts` holds the two
 * together.
 */

import type { JSONSchema } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model-schema";

import { AGENT_RUN_ERROR_CODES } from "../agent-error-codes.ts";
import { LLM_DERIVED_RESULT_STAMP_SCHEMA } from "./llm-schemas.ts";

/**
 * The tool names a request may select from. A deployment publishes this
 * list; the requester's registered runner offers a subset of it, and a
 * request naming a tool outside that subset fails before it is staged. The
 * `loom_*` names are the read-only Loom retrieval tools; the rest are the
 * harness tools a run over handles observes the fabric and the web through.
 */
export const AGENT_TOOL_NAMES = [
  "loom_search",
  "loom_page_discover",
  "loom_page_inspect",
  "loom_page_read",
  "loom_people",
  "loom_calendar_list",
  "loom_context",
  "loom_profile",
  "describe_handle",
  "run_pattern",
  "web_fetch",
  "research",
] as const;

/** One of {@link AGENT_TOOL_NAMES}. */
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

/**
 * The states an `AgentRun` record passes through, from creation to one of
 * the four terminal states.
 */
export const AGENT_RUN_STATES = [
  "queued",
  "claimed",
  "running",
  "completed",
  "failed",
  "refused",
  "cancelled",
] as const;

/** One of {@link AGENT_RUN_STATES}. */
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

/** The states no later write moves a record out of. */
export const AGENT_RUN_TERMINAL_STATES: ReadonlySet<AgentRunState> = new Set(
  ["completed", "failed", "refused", "cancelled"] as const,
);

/**
 * The stamp the result document a run's harness writes carries: the same
 * runtime-minted `LlmDerived` integrity family the llm builtins stamp their
 * model output with, merged into the result schema at the write and admitted
 * by the persist-time gate only from a builtin author.
 */
export const AGENT_RESULT_STAMP_SCHEMA = LLM_DERIVED_RESULT_STAMP_SCHEMA;

const JSONSchemaValueSchema = {
  anyOf: [
    { type: "object", additionalProperties: true },
    { type: "boolean" },
  ],
} as const;

const ToolNamesSchema = {
  type: "array",
  items: { type: "string", enum: [...AGENT_TOOL_NAMES] },
} as const;

/**
 * Runtime schema for {@link BuiltInAgentParams} (packages/api/index.ts).
 * Every `inputs` entry is a cell: the builtin passes its link and never its
 * value, so no input reaches the request as a value the sink gate measures.
 */
export const AgentParamsSchema = internSchema(
  {
    type: "object",
    properties: {
      task: { type: "string" },
      inputs: {
        type: "object",
        additionalProperties: { asCell: ["cell"] },
        default: {},
      },
      resultSchema: JSONSchemaValueSchema,
      maxConfidentiality: { type: "array", items: {} },
      tools: ToolNamesSchema,
    },
    required: ["task", "inputs", "resultSchema"],
  } as const satisfies JSONSchema,
);

/**
 * Runtime schema for {@link BuiltInAgentState} (packages/api/index.ts).
 * `result` and `run` hold links: to the result document the run's harness
 * wrote, and to the run's record; `host` is the origin of the toolshed
 * serving the record's space, carried beside `run` because a link resolves
 * a space and not the host that serves it. The cell never holds a copy of
 * the result or the record.
 */
export const AgentResultSchema = internSchema(
  {
    type: "object",
    properties: {
      pending: { type: "boolean", default: false },
      result: {},
      error: { type: "string" },
      requestHash: { type: "string" },
      run: {},
      host: { type: "string" },
    },
    required: ["pending"],
  } as const satisfies JSONSchema,
);

/**
 * The `AgentRun` record: one agent request as a durable document in the
 * requesting space, held per user, from `queued` to its terminal state.
 *
 * Two writers share it and never overlap. The builtin's post-commit effect
 * writes the request fields once, at creation: `requestHash`, `request`,
 * `piece`, `space`, `task`, `inputs`, `resultSchema`, `maxConfidentiality`,
 * `tools`, `submittedAt`, `state`, and `stateSince`. A runner writes
 * everything from `claim` on as an authored client — `claim`, `attempts`,
 * the terminal fields — and moves `state` and `stateSince` as it goes. The
 * builtin never writes the record again; it reads it, which is what lets a
 * derived creation and later authored writes share one document.
 *
 * `cancelRequestedAt` is the one field a client other than the runner
 * writes: the `cancel` stream of `agent-run.tsx` sets it, and a runner that
 * sees it on a record it is running aborts the run and ends the record
 * `cancelled`. A stream event reaches only the runtime that runs the handler,
 * so the durable field is what carries a cancel to a runner in another
 * process.
 */
export const AgentRunRecordSchema = internSchema(
  {
    type: "object",
    properties: {
      requestHash: { type: "string" },
      request: { asCell: ["cell"] },
      piece: { asCell: ["cell"] },
      space: { asCell: ["cell"] },
      task: { type: "string" },
      inputs: {
        type: "object",
        additionalProperties: { asCell: ["cell"] },
      },
      resultSchema: JSONSchemaValueSchema,
      maxConfidentiality: { type: "array", items: {} },
      tools: ToolNamesSchema,
      submittedAt: { type: "string" },
      state: { type: "string", enum: [...AGENT_RUN_STATES] },
      stateSince: { type: "string" },
      claim: {
        type: "object",
        properties: {
          runner: { type: "string" },
          leaseUntil: { type: "string" },
        },
        required: ["runner", "leaseUntil"],
      },
      attempts: { type: "number" },
      cancelRequestedAt: { type: "string" },
      result: { asCell: ["cell"] },
      outcome: {
        type: "string",
        enum: ["completed", "failed", "refused", "cancelled"],
      },
      errorCode: { type: "string", enum: [...AGENT_RUN_ERROR_CODES] },
      startedAt: { type: "string" },
      finishedAt: { type: "string" },
      modelTurns: { type: "number" },
      toolCalls: { type: "number" },
      usage: { type: "object", additionalProperties: true },
      usageCoverage: {
        type: "string",
        enum: ["direct", "including-descendants"],
      },
      runRef: { type: "string" },
    },
    required: [
      "requestHash",
      "request",
      "piece",
      "space",
      "task",
      "inputs",
      "resultSchema",
      "submittedAt",
      "state",
      "stateSince",
    ],
  } as const satisfies JSONSchema,
);

/**
 * The per-user index in the home space: one `{run, host, address}` entry per record
 * the user has submitted, across spaces and hosts, and the `agentRunner`
 * entry the user's runner writes when it starts and refreshes on every
 * claim. `host` is the origin of the toolshed serving the record's space,
 * carried beside the link because a link resolves a space and not the host
 * that serves it. `address` lets the home pattern resolve the link through
 * that host before reading or writing it. The `agentRunner` entry is public on purpose: it holds no
 * secret, and it exists so a request naming a tool the runner does not offer
 * can fail before it is staged, and so a consumer can say "no runner is
 * registered" rather than showing a request that queues forever.
 */
export const AgentQueueIndexSchema = internSchema(
  {
    type: "object",
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            run: { asCell: ["cell"], scope: "user" },
            host: { type: "string" },
            address: { type: "string" },
          },
          required: ["run", "host"],
        },
        default: [],
      },
      agentRunner: {
        type: "object",
        properties: {
          host: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
          registeredAt: { type: "string" },
          lastClaimAt: { type: "string" },
        },
        required: ["host", "tools", "registeredAt"],
      },
    },
  } as const satisfies JSONSchema,
);
