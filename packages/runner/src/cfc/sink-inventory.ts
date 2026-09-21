import type { CfcConfClause } from "./clause.ts";
export type InitialSinkName =
  | "fetchBinary"
  | "fetchText"
  | "fetchJson"
  | "fetchJsonUnchecked"
  | "fetchProgram"
  | "streamData"
  | "llm"
  | "llmDialog"
  | "generateText"
  | "generateObject"
  | "agent";

/**
 * Every sink a deployment has to decide about, by hand.
 *
 * The `satisfies` clause rejects entries that are not sink names, and
 * {@link _unregisteredSinks} below rejects sink names missing from here.
 * Together they force a new sink through this registry — and through the
 * total governance record a posture declares over it
 * (`MAX_ENFORCEMENT_SINK_GOVERNANCE` in `runtime-presets.ts`) — before it can
 * ship. The point is not the list: it is that a sink cannot reach a
 * deployment without someone deciding whether it carries a confidentiality
 * ceiling or releases ungated, and saying why.
 *
 * `agent` is the sink whose request is handed to an agent runner through an
 * `AgentRun` record, on whichever host serves the requesting space: the
 * request holds the task text and links to the cells the run may read, and
 * the runner observes those cells under the run's own ceiling rather than
 * receiving their values. {@link SINK_CLASSES} records that difference in
 * what a release exposes as the class the egress gate mints for it.
 */
export const KNOWN_SINKS = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "streamData",
  "llm",
  "llmDialog",
  "generateText",
  "generateObject",
  "agent",
] as const satisfies readonly InitialSinkName[];

/** A sink the registry classifies. */
export type KnownSinkName = (typeof KNOWN_SINKS)[number];

/**
 * The boundary class of a sink, minted as the `sinkClass` boundary-context
 * atom at the egress gate so an exchange rule can scope itself to one class
 * of release site (spec §8.10.5.2). `network` is a request leaving the
 * runtime for a host on the network — a fetch, a stream, a model call.
 * `agent` is a request handed to an agent runner acting as the requester,
 * whose model observes the fabric through handles rather than receiving the
 * request's values.
 */
export type SinkClass = "network" | "agent";

/**
 * Every known sink's class. Total over {@link KNOWN_SINKS}, the same way the
 * governance registry is: a sink added to the inventory without a class here
 * is a compile error.
 */
export const SINK_CLASSES: Readonly<Record<KnownSinkName, SinkClass>> = Object
  .freeze({
    fetchBinary: "network",
    fetchText: "network",
    fetchJson: "network",
    fetchJsonUnchecked: "network",
    fetchProgram: "network",
    streamData: "network",
    llm: "network",
    llmDialog: "network",
    generateText: "network",
    generateObject: "network",
    agent: "agent",
  });

/**
 * The class the egress gate mints for `sink`. A sink outside the inventory
 * is classed `network`: the gate reads sink names off recorded policy inputs,
 * and a name nobody registered is a request leaving the runtime for
 * somewhere no rule has been scoped to.
 */
export const sinkClassOf = (sink: string): SinkClass =>
  Object.hasOwn(SINK_CLASSES, sink)
    ? SINK_CLASSES[sink as KnownSinkName]
    : "network";

type UnregisteredSink = Exclude<InitialSinkName, KnownSinkName>;
// If the next line errors, a sink name exists that the registry has not
// classified: add it to KNOWN_SINKS and give it a row in every posture's
// governance record. The type error names the missing sink(s).
const _unregisteredSinks: never[] = [] as UnregisteredSink[];

/**
 * Why a sink releases without a confidentiality ceiling, with the two things
 * that make an ungated sink a published deviation rather than an oversight:
 * who carries it, and what would retire it (AH-CFC-15).
 */
export interface SinkUngatedRationale {
  /** Why no ceiling governs this sink, in one sentence. */
  readonly reason: string;

  /** Who owns the gap. */
  readonly owner: string;

  /** The condition under which the sink stops being ungated. */
  readonly retirement: string;
}

/**
 * How one posture governs one sink: a confidentiality ceiling its requests
 * must fit, or an explicit ungated release carrying its rationale.
 *
 * The two arms are not symmetric in what they cost to state. A ceiling is a
 * value the gate reads; an ungated sink is a hole in the gate, so it costs a
 * reason, an owner, and a retirement condition — the same three things
 * AH-CFC-15 asks of any deviation from an enforcing posture.
 */
export type SinkGovernance =
  | { readonly ceiling: readonly CfcConfClause[] }
  | { readonly ungated: SinkUngatedRationale };

/**
 * The gap the llm-class sinks (`llm`, `llmDialog`, `generateText`,
 * `generateObject`) carry: they release with no ceiling, so any
 * confidentiality — a secret as much as a risk caveat — reaches them without
 * a policy evaluation running for them.
 *
 * Ungated rather than public-only because ceiling membership is exact clause
 * subsumption (`atomsOutsideCeiling`) — a ceiling entry cannot admit "any
 * material-risk caveat regardless of `source`" — while risk-caveated ingested
 * content is exactly what an llm sink exists to process, so a public-only
 * ceiling would refuse the flows the sink is for.
 *
 * Building the mechanism the retirement condition names is planned in
 * `docs/plans/cfc-llm-sink-admission.md`.
 */
const LLM_SINK_UNGATED: SinkUngatedRationale = Object.freeze({
  reason:
    "ceiling membership is exact clause subsumption, so a public-only ceiling would refuse the risk-caveated ingested content an llm sink exists to process",
  owner: "CFC runtime (Epic B, sink governance)",
  retirement:
    "a boundary-scoped admission mechanism exists — a public-only ceiling paired with an exchange rule admitting the material-risk family at llm-class boundaries",
});

/** One posture's decision about every known sink. */
export type SinkGovernanceRegistry = Readonly<
  Record<KnownSinkName, SinkGovernance>
>;

/**
 * The ceilings a governance registry declares, in the open-map shape
 * `Runtime` takes: an ungated sink is ABSENT from the result, which is what
 * "no ceiling, therefore no gate" is in `SinkMaxConfidentiality`.
 */
export const sinkCeilingsOf = (
  registry: SinkGovernanceRegistry,
): SinkMaxConfidentiality =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(registry)
        .filter((
          entry,
        ): entry is [string, { ceiling: readonly CfcConfClause[] }] =>
          "ceiling" in entry[1]
        )
        .map((
          [sink, governance],
        ) => [sink, Object.freeze([...governance.ceiling])]),
    ),
  );

/** Each sink's rationale, by sink; the exported view below carries the why. */
const SINK_UNGATED_RATIONALE_TABLE = {
  llm: LLM_SINK_UNGATED,
  llmDialog: LLM_SINK_UNGATED,
  generateText: LLM_SINK_UNGATED,
  generateObject: LLM_SINK_UNGATED,
} as const satisfies Partial<Record<KnownSinkName, SinkUngatedRationale>>;

/** A sink the inventory records a deliberate ungated rationale for. */
export type UngatedSinkName = keyof typeof SINK_UNGATED_RATIONALE_TABLE;

/**
 * Why each sink that knowingly releases without a ceiling does so.
 *
 * A sink absent from here and absent from a deployment's ceilings is simply
 * unconfigured — a deployment that has not reached it yet. A sink named here
 * is a decision: the gap is understood, someone carries it, and something
 * would close it. That is the difference between an oversight and a published
 * deviation (AH-CFC-15), and it is why the rationale sits beside the sink
 * inventory rather than inside any one posture — the reason is a fact about
 * the sink, not about which bundle a deployment opted into.
 */
export const SINK_UNGATED_RATIONALES: Readonly<
  Partial<Record<KnownSinkName, SinkUngatedRationale>>
> = Object.freeze(SINK_UNGATED_RATIONALE_TABLE);

/** The rationale for `sink`, as a governance entry a posture can declare. */
export const ungatedSink = (sink: UngatedSinkName): SinkGovernance => ({
  ungated: SINK_UNGATED_RATIONALE_TABLE[sink],
});

export const INITIAL_SINK_INVENTORY: readonly InitialSinkName[] = Object.freeze(
  [...KNOWN_SINKS],
);

export const isInitialSinkInventoryName = (
  name: string,
): name is InitialSinkName =>
  (INITIAL_SINK_INVENTORY as readonly string[]).includes(name);

/**
 * Per-sink confidentiality ceiling: the confidentiality atoms a sink's request
 * may carry. A sink ABSENT from the map has no ceiling (its requests are not
 * gated on confidentiality). A sink mapped to an array is gated — every
 * confidentiality atom reachable from the request must be a member; an empty
 * array is therefore "public only" (no confidential atom may flow to the sink).
 *
 * §5.2.1 / §7.3-7.5: a sink is an information-flow egress, so its request must
 * not carry confidentiality the sink isn't cleared for. This is the policy
 * surface for that check; `prepareBoundaryCommit` consults it for every
 * recorded `sink-request` write-policy input.
 */
export type SinkMaxConfidentiality = Readonly<
  Record<string, readonly CfcConfClause[]>
>;

/**
 * Default ceilings: NONE declared, so the check is live but inert until a
 * deployment supplies ceilings via `Runtime({ cfcSinkMaxConfidentiality })`.
 *
 * Why empty rather than e.g. public-only on the HTTP sinks: until the default
 * label transition closes value-copy laundering (audit S16), most confidential
 * data reaches a sink as an unlabeled value and would slip a strict default
 * anyway, while the few correctly-labeled flows would be the only ones gated.
 * The honest posture is an opt-in ceiling a deployment rolls out per the
 * standard observe→enforce path (the observe diagnostic names each offending
 * (sink, atom) pair).
 */
export const DEFAULT_SINK_MAX_CONFIDENTIALITY: SinkMaxConfidentiality = Object
  .freeze({});
