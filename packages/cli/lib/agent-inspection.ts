/** Reads agent-run metadata through the home queue and requests cancellation. */

import { cloneIfNecessary, type FabricValue } from "@commonfabric/data-model";
import type { Runtime } from "@commonfabric/runner";
import {
  AGENT_RUN_TERMINAL_STATES,
  type AgentQueueIndex,
  AgentQueueIndexSchema,
  type AgentRunRecord,
  AgentRunRecordSchema,
} from "@commonfabric/runner/agent-run";
import { renderCellReference } from "@commonfabric/runner/shared";

import { loadIdentity } from "./identity.ts";
import { openAgentStorageHost } from "./agent-connections.ts";
import { loadPieces, type SpaceConfig } from "./piece.ts";
import { resolveWish, type WishRuntimeHost } from "./wish.ts";

/** The home connection used for inspecting one identity's agent requests. */
export interface AgentInspectionConfig {
  identity: string;
  apiUrl: string;
}

/** Connections and clock shared by inspection commands and their tests. */
export interface AgentInspectionDeps {
  loadIdentity: (path: string) => Promise<{ did(): `did:key:${string}` }>;
  loadPieces: (config: SpaceConfig) => Promise<WishRuntimeHost>;
  openHost: typeof openAgentStorageHost;
  now: () => Date;
}

const defaultDeps: AgentInspectionDeps = {
  loadIdentity,
  loadPieces,
  openHost: openAgentStorageHost,
  now: () => new Date(),
};

/** Metadata a command can render without following a run's result payload. */
export interface AgentRunInspection {
  id: string;
  address: string;
  host: string;
  space: string;
  requestHash: string;
  task: string;
  state: AgentRunRecord["state"];
  submittedAt: string;
  stateSince: string;
  attempts?: number;
  claim?: AgentRunRecord["claim"];
  cancelRequestedAt?: string;
  outcome?: AgentRunRecord["outcome"];
  errorCode?: AgentRunRecord["errorCode"];
  startedAt?: string;
  finishedAt?: string;
  modelTurns?: number;
  toolCalls?: number;
  usage?: AgentRunRecord["usage"];
  usageCoverage?: AgentRunRecord["usageCoverage"];
  runRef?: string;
  result?: string;
}

/** Selects one exact record id, request hash, or canonical address. */
export function selectAgentRun(
  runs: readonly AgentRunInspection[],
  identifier: string,
): AgentRunInspection {
  const matches = runs.filter((run) =>
    run.id === identifier || run.requestHash === identifier ||
    run.address === identifier
  );
  if (matches.length === 0) {
    throw new Error(`No agent run matches ${identifier}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous agent run ${identifier}; use its exact address.`,
    );
  }
  return matches[0];
}

/** Reads all available records, or requests cancellation of one exact match. */
async function inspect(
  config: AgentInspectionConfig,
  deps: AgentInspectionDeps,
  cancel?: string,
): Promise<AgentRunInspection[]> {
  const home = (await deps.loadIdentity(config.identity)).did();
  const homeHost = new URL(config.apiUrl).origin;
  const connections = new Map<string, Runtime>();
  const connect = async (origin: string): Promise<Runtime> => {
    let runtime = connections.get(origin);
    if (!runtime) {
      runtime = origin === homeHost
        ? (await deps.loadPieces({
          apiUrl: origin,
          identity: config.identity,
          space: home,
          jsonOutput: true,
        })).runtime
        : await deps.openHost(config.identity, origin);
      connections.set(origin, runtime);
    }
    return runtime;
  };
  try {
    const runtime = await connect(homeHost);
    const wish = await resolveWish(runtime, home, {
      query: "#agent_queue",
      schema: AgentQueueIndexSchema,
    });
    if (wish.error) throw new Error(wish.error);
    const queue = wish.result as AgentQueueIndex | null;
    const runs: AgentRunInspection[] = [];
    const cells = new Map<
      string,
      { runtime: Runtime; record: ReturnType<Runtime["getCell"]> }
    >();
    const seen = new Set<string>();
    for (const entry of queue?.entries ?? []) {
      const link = entry.run.getAsNormalizedFullLink();
      const address = renderCellReference(link);
      const host = new URL(entry.host).origin;
      const key = `${host}/${address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hostRuntime = await connect(host);
      const record = hostRuntime.getCellFromLink(link, AgentRunRecordSchema);
      await record.sync();
      const value = record.get() as AgentRunRecord | undefined;
      if (!value) {
        throw new Error(`Agent run ${address} is unavailable on ${host}.`);
      }
      runs.push({
        id: link.id,
        address,
        host,
        space: link.space,
        requestHash: value.requestHash,
        task: value.task,
        state: value.state,
        submittedAt: value.submittedAt,
        stateSince: value.stateSince,
        attempts: value.attempts,
        claim: value.claim && cloneIfNecessary(value.claim, { frozen: false }),
        cancelRequestedAt: value.cancelRequestedAt,
        outcome: value.outcome,
        errorCode: value.errorCode,
        startedAt: value.startedAt,
        finishedAt: value.finishedAt,
        modelTurns: value.modelTurns,
        toolCalls: value.toolCalls,
        usage: value.usage &&
          cloneIfNecessary(value.usage as FabricValue, {
            frozen: false,
          }) as AgentRunRecord["usage"],
        usageCoverage: value.usageCoverage,
        runRef: value.runRef,
        result: value.result &&
          renderCellReference(value.result.getAsNormalizedFullLink()),
      });
      cells.set(key, { runtime: hostRuntime, record });
    }
    if (cancel !== undefined) {
      const selected = selectAgentRun(runs, cancel);
      const held = cells.get(`${selected.host}/${selected.address}`)!;
      const committed = await held.runtime.editWithRetry((tx) => {
        const record = held.record.withTx(tx);
        const current = record.get() as AgentRunRecord;
        if (AGENT_RUN_TERMINAL_STATES.has(current.state)) return;
        if (current.cancelRequestedAt !== undefined) return;
        record.key("cancelRequestedAt").set(deps.now().toISOString());
      });
      if (committed.error) throw committed.error;
      const current = held.record.get() as AgentRunRecord;
      selected.state = current.state;
      selected.outcome = current.outcome;
      selected.cancelRequestedAt = current.cancelRequestedAt;
      return [selected];
    }
    return runs;
  } finally {
    for (const connection of connections.values()) {
      await connection.dispose();
    }
  }
}

/** Lists the identity's agent-run metadata across the queue's toolsheds. */
export function readAgentRuns(
  config: AgentInspectionConfig,
  deps: AgentInspectionDeps = defaultDeps,
): Promise<AgentRunInspection[]> {
  return inspect(config, deps);
}

/** Writes `cancelRequestedAt` once for a nonterminal run, returning its metadata. */
export async function cancelAgentRun(
  config: AgentInspectionConfig,
  identifier: string,
  deps: AgentInspectionDeps = defaultDeps,
): Promise<AgentRunInspection> {
  return (await inspect(config, deps, identifier))[0];
}
