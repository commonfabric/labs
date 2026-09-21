/**
 * The agent queue: the per-user index of agent runs, held by the home
 * default pattern in its `agentQueue` field.
 *
 * Access via: wish({ query: "#agent_queue" })
 *
 * `entries` names every `AgentRun` record the user has submitted, across
 * spaces and hosts; the `agent` builtin appends one when a request commits.
 * `agentRunner` names the user's registered runner, which writes it through
 * `setAgentRunner` when it starts and on every claim. The canonical schema
 * is `AgentQueueIndexSchema` in
 * `packages/runner/src/builtins/agent-schemas.ts`.
 */
import {
  __cf_data,
  type Cell,
  type Cfc,
  computed,
  type CurrentPrincipal,
  type Default,
  handler,
  type JSONSchema,
  NAME,
  pattern,
  type PatternFactory,
  type PerUser,
  type RepresentsCurrentUser,
  type Stream,
  toSchema,
  UI,
  type VNode,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import type { AgentRun, AgentRunRecord } from "./agent-run.tsx";

/**
 * One submitted run. `host` is the origin of the toolshed serving the
 * record's space, carried beside the link because a link resolves a space
 * and not the host that serves it.
 */
export type AgentQueueEntry = {
  run: PerUser<Cell<AgentRun>>;
  host: string;
};

type MaterializedAgentQueueEntry = {
  run: AgentRunRecord;
  host: string;
};

/**
 * The user's registered runner. It holds no secret: it exists so a request
 * naming a tool the runner does not offer can fail before it is staged, and
 * so a consumer can say that no runner is registered.
 */
export type AgentRunnerEntry = {
  host: string;
  tools: string[];
  registeredAt: string;
  lastClaimAt?: string;
};

type OwnerProtectedQueueWrite<T, Binding> = RepresentsCurrentUser<
  Cfc<
    WriteAuthorizedBy<T, Binding>,
    {
      ownerPrincipal: CurrentPrincipal;
    }
  >
>;

export type SetAgentRunnerEvent = {
  runner?: AgentRunnerEntry;
};

/**
 * The single authorized writer of `agentRunner`. A runner sends its whole
 * entry when it starts and again, with `lastClaimAt` moved, on every claim;
 * an event without one clears the registration.
 */
export const setAgentRunner = handler<
  SetAgentRunnerEvent,
  { agentRunner: Writable<AgentRunnerEntry | undefined> }
>((event = {}, state) => {
  state.agentRunner.set(event.runner);
});

export type AgentQueueOutput = {
  [NAME]: string;
  [UI]: VNode;
  entries: Writable<AgentQueueEntry[] | Default<[]>>;
  agentRunner?: OwnerProtectedQueueWrite<
    AgentRunnerEntry,
    typeof setAgentRunner
  >;
  setAgentRunner: Stream<SetAgentRunnerEvent>;
};

/** Preserve the queue's durable run link in a generated result schema. */
export const withAgentQueueRunLinkSchema = (
  generated: JSONSchema,
): JSONSchema => {
  if (typeof generated === "boolean") {
    throw new Error("Agent queue output schema must be an object");
  }
  const entry = generated.$defs?.AgentQueueEntry;
  if (entry === undefined || typeof entry === "boolean") {
    throw new Error("Agent queue output schema must define AgentQueueEntry");
  }
  return {
    ...generated,
    $defs: {
      ...generated.$defs,
      AgentQueueEntry: {
        ...entry,
        properties: {
          ...entry.properties,
          // The runner removes this private marker while retaining the scoped
          // cell wrapper. It prevents this one exported link from being
          // materialized like ordinary reactive pattern results.
          run: {
            asCell: ["cell"],
            scope: "user",
            __ctPreservePatternResultCell: true,
          } as JSONSchema,
        },
      },
    },
  };
};

const agentQueueArgumentSchema = toSchema<Record<string, never>>();
const agentQueueResultSchema = __cf_data(
  withAgentQueueRunLinkSchema(toSchema<AgentQueueOutput>()),
);

const AgentQueue = pattern(
  (_: Record<string, never>): AgentQueueOutput => {
    const entries = new Writable<MaterializedAgentQueueEntry[]>([]).for(
      "entries",
    );
    // NOTE(CT-1628): the `as any` casts around `agentRunner` are required
    // because the CFC wrapper types do not yet compose with Writable and the
    // pattern factory's output type.
    const agentRunner = new Writable<
      | OwnerProtectedQueueWrite<AgentRunnerEntry, typeof setAgentRunner>
      | undefined
    >(undefined).for("agentRunner");

    const noRunner = computed(() => agentRunner.get() === undefined);

    return {
      [NAME]: "Agent runs",
      [UI]: (
        <cf-vstack gap="2" style={{ padding: "1rem" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>Agent runs</h2>
          {noRunner
            ? (
              <p style={{ color: "#888", fontStyle: "italic" }}>
                No runner is registered. Requests stay queued until one starts.
              </p>
            )
            : null}
          {entries.map((entry) => (
            <cf-hstack gap="2" align="center">
              <strong>{entry.run.state}</strong>
              <span style={{ flex: "1" }}>{entry.run.task}</span>
              <span style={{ fontSize: "12px", color: "#666" }}>
                {entry.host}
              </span>
            </cf-hstack>
          ))}
        </cf-vstack>
      ) as VNode,
      // The local view materializes run links, while the exported queue keeps
      // them as cells so clients can address each durable record.
      entries: entries as any,
      agentRunner: agentRunner as any,
      setAgentRunner: setAgentRunner({ agentRunner: agentRunner as any }),
    };
  },
  agentQueueArgumentSchema,
  agentQueueResultSchema,
) as PatternFactory<Record<string, never>, AgentQueueOutput>;

export default AgentQueue;
