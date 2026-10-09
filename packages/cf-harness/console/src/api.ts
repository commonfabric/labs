/**
 * The console server's HTTP surface, as the page calls it. The types come from
 * the server's own modules rather than being restated here, so a route that
 * changes shape is a type error in the page rather than a blank pane.
 */

import type { HarnessChatEventEnvelope } from "../../src/contracts/interactive-chat.ts";
import { consolePath, pageMount } from "./mount.ts";
import type {
  PatternIndexEvent,
  PatternIndexListEventsRequest,
  PatternIndexListEventsResponse,
  PatternIndexListPatternsResponse,
  PatternIndexPattern,
  PatternIndexSearchRequest,
  PatternIndexSearchResponse,
} from "../../src/pattern-index/client.ts";
import type {
  ConsoleListedRun,
  ConsoleRunDetail,
  ConsoleRunSource,
} from "../run-store.ts";
import type {
  ConsoleGraph,
  ConsoleGraphEdge,
  ConsoleGraphNode,
} from "../graph.ts";
import type { ConsoleFlow, ConsoleFlowCell, ConsoleFlowNode } from "../flow.ts";
import type { ConsoleRunSummary } from "../runs.ts";
import type { ConsoleSessionSummary } from "../sessions.ts";
import type {
  ConsoleChatEventEnvelope,
  ConsoleTurnResult,
} from "../turn-result.ts";

export type {
  ConsoleChatEventEnvelope,
  ConsoleFlow,
  ConsoleFlowCell,
  ConsoleFlowNode,
  ConsoleGraph,
  ConsoleGraphEdge,
  ConsoleGraphNode,
  ConsoleListedRun,
  ConsoleRunDetail,
  ConsoleRunSource,
  ConsoleRunSummary,
  ConsoleSessionSummary,
  ConsoleTurnResult,
  HarnessChatEventEnvelope,
  PatternIndexEvent,
  PatternIndexListPatternsResponse,
  PatternIndexPattern,
  PatternIndexSearchRequest,
  PatternIndexSearchResponse,
};

/**
 * A server path as THIS page addresses it: under the mount the page was
 * opened at (`./mount.ts`). Written once here so no route is fetched from
 * the origin's root by habit.
 */
const api = (path: string): string => consolePath(pageMount(), path);

/** A started turn, and the session it runs in. */
export interface StartedTask {
  sessionId: string;
  turnId: string;
}

/**
 * One JSON response, or the error it reported. A refusal is not always JSON —
 * an unbuilt page and a crashed handler both answer in plain text — so the
 * body is parsed leniently and the status stands in when it carries nothing.
 */
const json = async <Value>(response: Response): Promise<Value> => {
  const text = await response.text();
  let body: { error?: unknown } | undefined;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : text.trim() === ""
        ? response.statusText
        : text,
    );
  }
  return body as Value;
};

export const startTask = async (
  text: string,
  sessionId?: string,
): Promise<StartedTask> =>
  await json<StartedTask>(
    await fetch(api("/api/task"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        sessionId === undefined ? { text } : { text, sessionId },
      ),
    }),
  );

/**
 * Asks the server to stop a turn, recording that the console page stopped it.
 * A refusal rejects like every other route's does: a cancel the server would
 * not take leaves the turn running, and a page that read it as success would
 * say the opposite.
 */
export const cancelTurn = async (
  sessionId: string,
  turnId?: string,
): Promise<void> => {
  await json<unknown>(
    await fetch(api("/api/cancel"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId,
        turnId,
        reason: "canceled from the console page",
      }),
    }),
  );
};

export const listSessions = async (): Promise<
  readonly ConsoleSessionSummary[]
> =>
  (await json<{ sessions: readonly ConsoleSessionSummary[] }>(
    await fetch(api("/api/sessions")),
  )).sessions;

export const listRuns = async (): Promise<readonly ConsoleListedRun[]> =>
  (await json<{ runs: readonly ConsoleListedRun[] }>(
    await fetch(api("/api/runs")),
  )).runs;

/** The durable external result of one completed turn. */
export const readTurnResult = async (
  turnId: string,
): Promise<ConsoleTurnResult> =>
  await json<ConsoleTurnResult>(
    await fetch(api(`/api/turns/${encodeURIComponent(turnId)}/result`)),
  );

export const readRun = async (runId: string): Promise<ConsoleRunDetail> =>
  await json<ConsoleRunDetail>(
    await fetch(api(`/api/runs/${encodeURIComponent(runId)}`)),
  );

/**
 * The data-flow graph of a run and the children beneath it. Its own request
 * rather than a field of the run, because it reads every descendant's
 * artifacts and the timeline re-reads the run on every completed tool call.
 */
export const readRunGraph = async (runId: string): Promise<ConsoleGraph> =>
  await json<ConsoleGraph>(
    await fetch(api(`/api/runs/${encodeURIComponent(runId)}/graph`)),
  );

/** The conversation map of a run and the children beneath it. */
export const readRunFlow = async (runId: string): Promise<ConsoleFlow> =>
  await json<ConsoleFlow>(
    await fetch(api(`/api/runs/${encodeURIComponent(runId)}/flow`)),
  );

/**
 * One read of the pattern index, through the server that signs it. The page
 * names a function and the server composes the request, so the set of things
 * askable from here is the server's allowlist rather than this module's.
 */
const callIndex = async <Value>(
  fn: string,
  body?: Record<string, unknown>,
): Promise<Value> =>
  await json<Value>(
    await fetch(api("/api/index/call"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body === undefined ? { fn } : { fn, body }),
    }),
  );

export const listIndexPatterns = (): Promise<
  PatternIndexListPatternsResponse
> => callIndex<PatternIndexListPatternsResponse>("listPatterns");

export const listIndexEvents = async (
  request: PatternIndexListEventsRequest = {},
): Promise<readonly PatternIndexEvent[]> =>
  (await callIndex<PatternIndexListEventsResponse>(
    "listEvents",
    { ...request },
  )).events;

/**
 * One pattern's metadata, schemas and dependencies. The server never asks the
 * index for source, so what comes back is what this surface shows.
 */
export const readIndexPattern = (
  patternId: string,
): Promise<PatternIndexPattern> =>
  callIndex<PatternIndexPattern>("getPattern", { patternId });

export const searchIndexPatterns = (
  request: PatternIndexSearchRequest,
): Promise<PatternIndexSearchResponse> =>
  callIndex<PatternIndexSearchResponse>("searchPatterns", { ...request });

/**
 * One artifact or tool output as its own text. It is returned unparsed: the
 * point of the raw pane is to show what is on disk, including a payload that
 * is too large or too odd for the page to have an opinion about.
 */
export const readRunFile = async (
  runId: string,
  kind: "artifacts" | "tool-outputs",
  name: string,
): Promise<string> => {
  const response = await fetch(
    api(
      `/api/runs/${encodeURIComponent(runId)}/${kind}/${
        encodeURIComponent(name)
      }`,
    ),
  );
  if (!response.ok) {
    throw new Error(`${name} is not readable`);
  }
  return await response.text();
};
