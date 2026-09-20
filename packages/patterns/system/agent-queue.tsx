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
  type Cfc,
  computed,
  type CurrentPrincipal,
  type Default,
  handler,
  NAME,
  pattern,
  type RepresentsCurrentUser,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import AgentRunView, { type AgentRunRecord } from "./agent-run.tsx";

/**
 * One submitted run. `host` is the origin of the toolshed serving the
 * record's space, carried beside the link because a link resolves a space
 * and not the host that serves it.
 */
export type AgentQueueEntry = {
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
>((event, state) => {
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

export default pattern<Record<string, never>, AgentQueueOutput>((_) => {
  const entries = new Writable<AgentQueueEntry[]>([]).for("entries");
  // NOTE(CT-1628): the `as any` casts around `agentRunner` are required
  // because the CFC wrapper types do not yet compose with Writable and the
  // pattern factory's output type.
  const agentRunner = new Writable<
    | OwnerProtectedQueueWrite<AgentRunnerEntry, typeof setAgentRunner>
    | undefined
  >(undefined).for("agentRunner");

  const noRunner = computed(() => agentRunner.get() === undefined);
  const empty = computed(() => entries.get().length === 0);
  const now = wish<number>({ query: "#now/60" });

  return {
    [NAME]: "Agent runs",
    [UI]: (
      <cf-theme theme={{ density: "compact", borderRadius: "8px" }}>
        <cf-vstack gap="3" padding="4">
          <h2 style={{ margin: 0 }}>Agent runs</h2>
          {noRunner
            ? (
              <p>
                No runner is registered. Requests stay queued until one starts.
              </p>
            )
            : null}
          {empty ? <p>No agent runs yet.</p> : null}
          {entries.map((entry) => (
            <cf-card data-agent-run={entry.run.requestHash}>
              <cf-vstack gap="2">
                {AgentRunView({ run: entry.run, nowMs: now.result })}
                <small>{entry.host}</small>
              </cf-vstack>
            </cf-card>
          ))}
        </cf-vstack>
      </cf-theme>
    ),
    entries,
    agentRunner: agentRunner as any,
    setAgentRunner: setAgentRunner({ agentRunner: agentRunner as any }),
  };
});
