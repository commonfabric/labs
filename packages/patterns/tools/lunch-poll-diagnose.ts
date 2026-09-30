/**
 * Headless lunch-poll scaling probe.
 *
 * Use `--production` for the current 14-option single-viewer shape, `--quick`
 * for a smoke check, or `--cases=<options>x<users>,...` for an explicit
 * matrix. Diagnostics go to stderr and the machine-readable result is the one
 * JSON document written to stdout.
 *
 * The probe runs the server-execution OFF arm unless
 * `EXPERIMENTAL_SERVER_EXECUTION` is set explicitly: it is a headless
 * measurement of the pattern's own graph, not of a deployed topology.
 */

import { parseLink } from "@commonfabric/runner";
import { isObjectNotArray } from "@commonfabric/utils/types";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type RuntimeDiagnosticsSnapshot,
} from "../integration/multi-runtime-harness.ts";

interface PollOutputSummary {
  users: readonly { name?: string }[];
  options: readonly { id?: string; title?: string }[];
  votes: readonly {
    /** What names the voter — see `voterIdentity`. */
    voter: readonly unknown[];
    optionId?: string;
    voteType?: string;
  }[];
  hostName: string;
  myName: string;
  todayDate: string;
  joinMessage: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  isJoined: boolean;
  isAdmin: boolean;
}

interface TraceAddressSummary {
  space?: string;
  entityId?: string;
  path?: readonly string[];
}

interface ActionRunTraceSummary {
  actionId: string;
  site: string;
  actionType: string;
  durationMs: number;
  declaredWrites: readonly TraceAddressSummary[];
  actualWrites: readonly TraceAddressSummary[];
}

interface DiagnosticsSummary {
  label: string;
  graph: {
    nodes: number;
    edges: number;
    byType: Record<string, number>;
    dirty: number;
    pending: number;
    demanded: number;
    liveEffects: number;
    pullDemandRoots: number;
    topReadNodes: readonly { site: string; type: string; readCount: number }[];
  };
  settle: {
    totalHistoryEntries: number;
    recent: readonly {
      iterations: number;
      totalDurationMs: number;
      initialSeedCount: number;
      maxWorkSetSize: number;
      maxOrderSize: number;
      actionsRun: number;
      settledEarly: boolean;
    }[];
  };
  actions: {
    totalTraceEntries: number;
    newTraceEntries: number;
    slowestNew: readonly ActionRunTraceSummary[];
    newWritesByPath: Record<string, number>;
  };
}

export interface MatrixConfig {
  program: string;
  optionCounts: readonly number[];
  /** Sessions per case: every user opens the poll and joins it. */
  userCounts: readonly number[];
  voteRounds: number;
  /**
   * How many of a case's users cast in each vote round, counted from the
   * host; the rest only observe. `undefined` has every user cast. A case
   * with fewer users than this is refused rather than reported as casting
   * from sessions it does not have.
   */
  voters?: number;
}

export interface CaseConfig {
  optionCount: number;
  /** Sessions in the case: every user opens the poll and joins it. */
  userCount: number;
  voteRounds: number;
  /**
   * How many of the users cast, counted from the host; `undefined` is all
   * of them. Never more than `userCount`.
   */
  voters?: number;
}

interface CompactSessionSample {
  label: string;
  poll: {
    myName: string;
    hostName: string;
    isJoined: boolean;
    isAdmin: boolean;
    /** Why this session's last join was refused, or "". */
    joinMessage: string;
    /** The day votes are filtered to, or "" until the `#now/300` wish lands. */
    todayDate: string;
    users: number;
    options: number;
    votes: number;
  };
  graph: {
    nodes: number;
    edges: number;
    computations: number;
    inputs: number;
    dirty: number;
    pending: number;
    demanded: number;
  };
  settle: {
    totalHistoryEntries: number;
    maxRecentSettleMs: number;
    maxRecentWorkSet: number;
    recentActionsRun: number;
  };
  actions: {
    totalTraceEntries: number;
    newTraceEntries: number;
    slowestNew: {
      site: string;
      durationMs: number;
      actualWrites: number;
    } | null;
  };
  topReadSites: readonly { site: string; readCount: number; type: string }[];
}

interface PhaseSample {
  phase: string;
  elapsedMs: number;
  aggregate: {
    maxNodes: number;
    maxEdges: number;
    maxDirty: number;
    maxPending: number;
    maxDemanded: number;
    maxRecentSettleMs: number;
    maxRecentWorkSet: number;
    totalRecentActionsRun: number;
    totalNewTraceEntries: number;
    topReadSites: readonly { site: string; readCount: number; type: string }[];
  };
  sessions: readonly CompactSessionSample[];
}

interface ChurnCounts {
  commitConflicts: number;
  commitPreempted: number;
  commitReverts: number;
  commitRejected: number;
}

interface SessionChurn extends ChurnCounts {
  label: string;
  /** Whether this session cast in the vote rounds or only observed. */
  voter: boolean;
}

interface ChurnTotals extends ChurnCounts {
  sessions: SessionChurn[];
}

export interface CaseResult {
  case: {
    users: number;
    options: number;
    voteRounds: number;
    voters: number;
  };
  churn: ChurnTotals;
  convergence: ConvergenceResult;
  phases: PhaseSample[];
}

async function collectChurn(
  sessions: readonly MultiRuntimeSession[],
  voters: readonly MultiRuntimeSession[],
): Promise<ChurnTotals> {
  const totals: ChurnTotals = {
    commitConflicts: 0,
    commitPreempted: 0,
    commitReverts: 0,
    commitRejected: 0,
    sessions: [],
  };
  for (const session of sessions) {
    const counts = await session.loggerCounts();
    const storage = counts["storage.v2"] ?? {};
    const churn: SessionChurn = {
      label: session.label,
      voter: voters.includes(session),
      commitConflicts: storage["commit-conflict"]?.total ?? 0,
      commitPreempted: storage["commit-preempted"]?.total ?? 0,
      commitReverts: storage["commit-revert"]?.total ?? 0,
      commitRejected: storage["commit-rejected"]?.total ?? 0,
    };
    totals.sessions.push(churn);
    totals.commitConflicts += churn.commitConflicts;
    totals.commitPreempted += churn.commitPreempted;
    totals.commitReverts += churn.commitReverts;
    totals.commitRejected += churn.commitRejected;
  }
  return totals;
}

const formatChurn = (churn: ChurnCounts): string =>
  `conflicts=${churn.commitConflicts} preempted=${churn.commitPreempted} ` +
  `reverts=${churn.commitReverts} rejected=${churn.commitRejected}`;

export interface ConvergenceResult {
  converged: boolean;
  voteCounts: number[];
  optionCounts: number[];
  userCounts: number[];
  fingerprints: string[];
}

// After heavy conflict churn, every session must agree on the shared poll
// state. A canonical fingerprint of the (PerSpace) vote set that differs across
// sessions is a correctness/convergence bug, not just contention.
async function collectConvergence(
  sessions: readonly MultiRuntimeSession[],
): Promise<ConvergenceResult> {
  const states = await Promise.all(sessions.map(async (session) => {
    const poll = pollSummary(await session.read());
    // Each vote renders as JSON of its own, so no option id carrying the
    // delimiter can run two votes together, and sorting orders values that
    // are equal exactly when the votes are.
    const fingerprint = poll.votes
      .map((vote) =>
        JSON.stringify([vote.voter, vote.optionId ?? "", vote.voteType ?? ""])
      )
      .sort()
      .join("\n");
    return {
      votes: poll.voteCount,
      options: poll.optionCount,
      users: poll.userCount,
      fingerprint,
    };
  }));
  const ref = states[0];
  const converged = states.every((state) =>
    state.votes === ref.votes &&
    state.options === ref.options &&
    state.users === ref.users &&
    state.fingerprint === ref.fingerprint
  );
  return {
    converged,
    voteCounts: states.map((state) => state.votes),
    optionCounts: states.map((state) => state.options),
    userCounts: states.map((state) => state.users),
    fingerprints: states.map((state) => state.fingerprint),
  };
}

const traceCursors = new Map<string, number>();
const VOTE_COLORS = ["green", "yellow", "red"] as const;
let matrixProgram = "main.tsx";
const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LUNCH_POLL_DIR = new URL("../lunch-poll/", import.meta.url).pathname
  .replace(/\/$/, "");

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const asBoolean = (value: unknown): boolean => value === true;

const asRecordArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isObjectNotArray) : [];

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * What names a vote's voter, for the convergence fingerprint below.
 *
 * A vote's voter is a profile cell, and a read of the poll output can hand it
 * back either way round: resolved to the profile's contents, whose name tells
 * one voter from another and which this tool gives every session a distinct
 * one of, or — where the result schema declares the location a cell — as the
 * link that reaches it, which names the same profile just as well. A vote with
 * no voter at all is a vote stored by the poll's name-keyed predecessor, which
 * tallies anonymously.
 *
 * Anything else refuses. A voter this cannot name flattens every vote's key to
 * the same empty string, in every session at once, which leaves the votes
 * comparing equal and the run reporting a convergence it never checked.
 *
 * What comes back is a tagged tuple, which the fingerprint compares whole, so
 * two voters are equal exactly when they are the same voter. A link's entire
 * address goes in — a cell's scope names the partition it is stored under, so
 * one id under two scopes is two cells — and its path stays the array it is,
 * which no delimiter can run together.
 */
export function voterIdentity(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  const link = parseLink(value);
  if (link) return ["link", link.space, link.id, link.scope, link.path];
  if (isObjectNotArray(value)) {
    const name = asString(value.name);
    if (name !== "") return ["name", name];
  }
  throw new Error(
    `a vote names a voter this tool cannot identify: ${JSON.stringify(value)}`,
  );
}

function pollSummary(value: unknown): PollOutputSummary {
  if (!isObjectNotArray(value)) {
    throw new Error(
      `poll output is not an object: ${JSON.stringify(value)}`,
    );
  }
  return {
    users: asRecordArray(value.users),
    options: asRecordArray(value.options),
    votes: asRecordArray(value.votes).map((vote) => ({
      voter: voterIdentity(vote.voter),
      optionId: asString(vote.optionId),
      voteType: asString(vote.voteType),
    })),
    hostName: asString(value.hostName),
    myName: asString(value.myName),
    todayDate: asString(value.todayDate),
    joinMessage: asString(value.joinMessage),
    userCount: asNumber(value.userCount),
    optionCount: asNumber(value.optionCount),
    voteCount: asNumber(value.voteCount),
    isJoined: asBoolean(value.isJoined),
    isAdmin: asBoolean(value.isAdmin),
  };
}

function pathKey(address: TraceAddressSummary): string {
  return `${address.space ?? "?"}/${address.entityId ?? "?"}/$$trel/${
    (address.path ?? []).join(".")
  }`;
}

function traceAddressSummary(value: unknown): TraceAddressSummary {
  if (!isObjectNotArray(value)) return {};
  return {
    space: asString(value.space),
    entityId: asString(value.entityId),
    path: asStringArray(value.path),
  };
}

function traceEntrySummary(
  value: unknown,
  siteOf: (actionId: string) => string,
): ActionRunTraceSummary {
  if (!isObjectNotArray(value)) {
    return {
      actionId: "",
      site: "",
      actionType: "",
      durationMs: 0,
      declaredWrites: [],
      actualWrites: [],
    };
  }
  const actionId = asString(value.actionId);
  return {
    actionId,
    site: siteOf(actionId),
    actionType: asString(value.actionType),
    durationMs: asNumber(value.durationMs),
    declaredWrites: Array.isArray(value.declaredWrites)
      ? value.declaredWrites.map(traceAddressSummary)
      : [],
    actualWrites: Array.isArray(value.actualWrites)
      ? value.actualWrites.map(traceAddressSummary)
      : [],
  };
}

function summarizeSettleEntry(value: unknown) {
  const stats = isObjectNotArray(value) && isObjectNotArray(value.stats)
    ? value.stats
    : {};
  const iterations = Array.isArray(stats.iterations) ? stats.iterations : [];
  let maxWorkSetSize = 0;
  let maxOrderSize = 0;
  let actionsRun = 0;
  for (const iteration of iterations) {
    if (!isObjectNotArray(iteration)) continue;
    maxWorkSetSize = Math.max(maxWorkSetSize, asNumber(iteration.workSetSize));
    maxOrderSize = Math.max(maxOrderSize, asNumber(iteration.orderSize));
    actionsRun += asNumber(iteration.actionsRun);
  }
  return {
    iterations: iterations.length,
    totalDurationMs: asNumber(stats.totalDurationMs),
    initialSeedCount: asNumber(stats.initialSeedCount),
    maxWorkSetSize,
    maxOrderSize,
    actionsRun,
    settledEarly: asBoolean(stats.settledEarly),
  };
}

function diagnosticsSummary(
  label: string,
  diagnostics: RuntimeDiagnosticsSnapshot,
): DiagnosticsSummary {
  const byType: Record<string, number> = {};
  let dirty = 0;
  let pending = 0;
  let demanded = 0;
  let liveEffects = 0;
  let pullDemandRoots = 0;

  // Where each action was authored, for the ids that carry it. A handler's id
  // holds its own authored site; a lift's is content-addressed, so its site
  // reaches this probe only through the graph.
  const authoredSites = new Map<string, string>();
  for (const node of diagnostics.graph.nodes) {
    if (node.src !== undefined) authoredSites.set(node.id, node.src);
  }
  const siteOf = (actionId: string): string =>
    compactActionSite(authoredSites.get(actionId) ?? actionId);

  const topReadNodes = diagnostics.graph.nodes
    .map((node) => ({
      site: siteOf(node.id),
      type: node.type,
      readCount: (node.reads?.length ?? 0) + (node.shallowReads?.length ?? 0),
    }))
    .filter((node) => node.readCount > 0)
    .sort((a, b) => b.readCount - a.readCount)
    .slice(0, 8);

  for (const node of diagnostics.graph.nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    if (node.isDirty) dirty++;
    if (node.isPending) pending++;
    if (node.isDemanded) demanded++;
    if (node.isLiveEffect) liveEffects++;
    if (node.isPullDemandRoot) pullDemandRoots++;
  }

  const previousTraceLength = traceCursors.get(label) ?? 0;
  traceCursors.set(label, diagnostics.actionRunTrace.length);
  const newTrace = diagnostics.actionRunTrace.slice(previousTraceLength)
    .map((entry) => traceEntrySummary(entry, siteOf));
  const newWritesByPath: Record<string, number> = {};
  for (const entry of newTrace) {
    for (const write of entry.actualWrites) {
      const key = pathKey(write);
      newWritesByPath[key] = (newWritesByPath[key] ?? 0) + 1;
    }
  }

  return {
    label,
    graph: {
      nodes: diagnostics.graph.nodes.length,
      edges: diagnostics.graph.edges.length,
      byType,
      dirty,
      pending,
      demanded,
      liveEffects,
      pullDemandRoots,
      topReadNodes,
    },
    settle: {
      totalHistoryEntries: diagnostics.settleStatsHistory.length,
      recent: diagnostics.settleStatsHistory.slice(-5).map(
        summarizeSettleEntry,
      ),
    },
    actions: {
      totalTraceEntries: diagnostics.actionRunTrace.length,
      newTraceEntries: newTrace.length,
      slowestNew: [...newTrace].sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 8),
      newWritesByPath,
    },
  };
}

const maxOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

/**
 * An authored source location, as the module identity carries it:
 * `cf:module/<identity>/<path>:<line>:<col>`. A handler's action id ends in
 * one; so does the `src` the graph reports for a computation.
 */
const AUTHORED_SITE = /cf:module\/[^/]+\/(.+:\d+:\d+)$/;

/** The same identity with no authored site: `cf:module/<identity>:<symbol>`. */
const ADDRESSED_MODULE = /^cf:module\/[^:]+:(.+)$/;

/**
 * The readable site of an action, from its id or from the authored source the
 * graph reports for it.
 */
export function compactActionSite(actionId: string): string {
  const authored = AUTHORED_SITE.exec(actionId);
  if (authored) return authored[1];
  if (actionId.startsWith("raw:")) {
    return actionId.split(":").slice(0, 3).join(":");
  }
  if (actionId.startsWith("pull:")) return "pull:result";
  if (actionId.startsWith("sink:")) return "sink:result";
  const addressed = ADDRESSED_MODULE.exec(actionId);
  if (addressed) return addressed[1];
  return actionId.slice(0, 80);
}

function compactTopReadSites(
  diagnostics: DiagnosticsSummary,
): readonly { site: string; readCount: number; type: string }[] {
  const bySite = new Map<
    string,
    { site: string; readCount: number; type: string }
  >();
  for (const node of diagnostics.graph.topReadNodes) {
    const previous = bySite.get(node.site);
    bySite.set(node.site, {
      site: node.site,
      readCount: (previous?.readCount ?? 0) + node.readCount,
      type: previous?.type ?? node.type,
    });
  }
  return [...bySite.values()]
    .sort((a, b) => b.readCount - a.readCount)
    .slice(0, 6);
}

function compactSessionSample(
  label: string,
  poll: PollOutputSummary,
  diagnostics: DiagnosticsSummary,
): CompactSessionSample {
  const recent = diagnostics.settle.recent;
  const slowest = diagnostics.actions.slowestNew[0];
  return {
    label,
    poll: {
      myName: poll.myName,
      hostName: poll.hostName,
      isJoined: poll.isJoined,
      isAdmin: poll.isAdmin,
      joinMessage: poll.joinMessage,
      todayDate: poll.todayDate,
      users: poll.userCount,
      options: poll.optionCount,
      votes: poll.voteCount,
    },
    graph: {
      nodes: diagnostics.graph.nodes,
      edges: diagnostics.graph.edges,
      computations: diagnostics.graph.byType.computation ?? 0,
      inputs: diagnostics.graph.byType.input ?? 0,
      dirty: diagnostics.graph.dirty,
      pending: diagnostics.graph.pending,
      demanded: diagnostics.graph.demanded,
    },
    settle: {
      totalHistoryEntries: diagnostics.settle.totalHistoryEntries,
      maxRecentSettleMs: maxOf(recent.map((entry) => entry.totalDurationMs)),
      maxRecentWorkSet: maxOf(recent.map((entry) => entry.maxWorkSetSize)),
      recentActionsRun: recent.reduce(
        (sum, entry) => sum + entry.actionsRun,
        0,
      ),
    },
    actions: {
      totalTraceEntries: diagnostics.actions.totalTraceEntries,
      newTraceEntries: diagnostics.actions.newTraceEntries,
      slowestNew: slowest
        ? {
          site: slowest.site,
          durationMs: slowest.durationMs,
          actualWrites: slowest.actualWrites.length,
        }
        : null,
    },
    topReadSites: compactTopReadSites(diagnostics),
  };
}

function aggregateSessions(
  sessions: readonly CompactSessionSample[],
): PhaseSample["aggregate"] {
  const topBySite = new Map<
    string,
    { site: string; readCount: number; type: string }
  >();
  for (const session of sessions) {
    for (const site of session.topReadSites) {
      const previous = topBySite.get(site.site);
      if (!previous || site.readCount > previous.readCount) {
        topBySite.set(site.site, site);
      }
    }
  }
  return {
    maxNodes: maxOf(sessions.map((session) => session.graph.nodes)),
    maxEdges: maxOf(sessions.map((session) => session.graph.edges)),
    maxDirty: maxOf(sessions.map((session) => session.graph.dirty)),
    maxPending: maxOf(sessions.map((session) => session.graph.pending)),
    maxDemanded: maxOf(sessions.map((session) => session.graph.demanded)),
    maxRecentSettleMs: maxOf(
      sessions.map((session) => session.settle.maxRecentSettleMs),
    ),
    maxRecentWorkSet: maxOf(
      sessions.map((session) => session.settle.maxRecentWorkSet),
    ),
    totalRecentActionsRun: sessions.reduce(
      (sum, session) => sum + session.settle.recentActionsRun,
      0,
    ),
    totalNewTraceEntries: sessions.reduce(
      (sum, session) => sum + session.actions.newTraceEntries,
      0,
    ),
    topReadSites: [...topBySite.values()]
      .sort((a, b) => b.readCount - a.readCount)
      .slice(0, 8),
  };
}

async function samplePhase(
  phase: string,
  harness: MultiRuntimeHarness,
  runActions: () => Promise<void>,
): Promise<PhaseSample> {
  const startedAt = performance.now();
  await runActions();
  await harness.settle(3);
  const sessions = await Promise.all(harness.sessions.map(async (session) => {
    const poll = pollSummary(await session.read());
    const diagnostics = diagnosticsSummary(
      session.label,
      await session.diagnostics(),
    );
    return compactSessionSample(session.label, poll, diagnostics);
  }));
  const sample = {
    phase,
    elapsedMs: performance.now() - startedAt,
    aggregate: aggregateSessions(sessions),
    sessions,
  } satisfies PhaseSample;
  console.error(
    `[lunch-poll diagnose] ${phase}: maxNodes=${sample.aggregate.maxNodes} ` +
      `maxEdges=${sample.aggregate.maxEdges} maxSettleMs=${
        sample.aggregate.maxRecentSettleMs.toFixed(1)
      } totalNewTrace=${sample.aggregate.totalNewTraceEntries}`,
  );
  return sample;
}

/**
 * Claim each session's viewer identity through the poll's `overrideViewer`
 * seam.
 *
 * Identity in this poll is a profile cell. A browser viewer gets one from the
 * `#profile` wish, which has nothing to resolve it in a headless runtime, so
 * each session mints its own profile cell and claims that. The handler runs in
 * the sending session's runtime, so every claim lands in that session's own
 * per-user slot and the sessions stay distinct people on one shared poll.
 */
async function claimIdentities(
  sessions: readonly MultiRuntimeSession[],
): Promise<void> {
  await Promise.all(sessions.map(async (session, index) => {
    const name = `User ${index + 1}`;
    const profile = await session.createCell(
      `lunch-poll-diagnose profile ${session.label}`,
      { name },
    );
    await session.send("overrideViewer", { profile, name });
  }));
}

/**
 * Check that a phase's setup took, naming the sessions it did not reach.
 *
 * Every step these phases drive is gated in the pattern — joining needs a
 * resolved profile, adding an option needs the host, casting a vote needs a
 * roster entry and a resolved clock — and a gate that refuses writes nothing
 * and reports nothing, leaving the samples that follow reading as an idle
 * poll. The check asks whether a gate was passed at all, not whether every
 * write survived: a vote lost to commit contention is what the churn and
 * convergence sections report.
 */
function checkPhase(
  phase: PhaseSample,
  requirement: string,
  reached: (poll: CompactSessionSample["poll"]) => boolean,
): void {
  const failures = phase.sessions.filter((session) => !reached(session.poll));
  if (failures.length === 0) return;
  throw new Error(
    `after phase "${phase.phase}", ${failures.length} of ` +
      `${phase.sessions.length} sessions did not ${requirement}: ` +
      failures
        .map((session) => `${session.label} ${JSON.stringify(session.poll)}`)
        .join("; "),
  );
}

async function optionIds(session: MultiRuntimeSession): Promise<string[]> {
  const poll = pollSummary(await session.read());
  return poll.options.map((option) => option.id).filter((id): id is string =>
    typeof id === "string" && id !== ""
  );
}

function createHarness(config: CaseConfig): Promise<MultiRuntimeHarness> {
  return MultiRuntimeHarness.create({
    programPath: `${LUNCH_POLL_DIR}/${matrixProgram}`,
    rootPath: ROOT_PATH,
    diagnostics: true,
    sessions: Array.from(
      { length: config.userCount },
      (_entry, index) => `user-${index + 1}`,
    ),
  });
}

/**
 * Run one case end to end: open the poll across a runtime per user, give each
 * user an identity, join them, add the options, and have the voting subset
 * cast. Exported so a test can drive the probe's own setup rather than a copy
 * of it. A `voters` above `userCount` is refused here as on the command line.
 */
export async function runCase(config: CaseConfig): Promise<CaseResult> {
  validateVoters(
    config.voters,
    config.userCount,
    `${config.optionCount}x${config.userCount}`,
  );
  traceCursors.clear();
  const harness = await createHarness(config);
  const phases: PhaseSample[] = [];
  const labels = Array.from(
    { length: config.userCount },
    (_entry, index) => `user-${index + 1}`,
  );
  const sessions = labels.map((label) => harness.session(label));
  const host = sessions[0];
  const voters = sessions.slice(0, config.voters ?? sessions.length);

  try {
    // Standing in for the `#profile` wish, which is what a browser viewer
    // loads with, so the baseline below is a poll whose viewers have an
    // identity and have not joined yet.
    await claimIdentities(sessions);
    phases.push(await samplePhase("baseline-open", harness, async () => {}));

    // The host joins alone and first: the first joiner takes the host role,
    // and the phases below need a settled answer to who that is.
    const joinPhase = await samplePhase("all-users-join", harness, async () => {
      await host.send("joinAs", {});
      await Promise.all(
        sessions.slice(1).map((session) => session.send("joinAs", {})),
      );
    });
    phases.push(joinPhase);
    checkPhase(joinPhase, "join the poll", (poll) => poll.isJoined);

    const optionsPhase = await samplePhase(
      "host-adds-options",
      harness,
      async () => {
        for (let index = 0; index < config.optionCount; index++) {
          await host.send("addOption", { title: `Restaurant ${index + 1}` });
        }
      },
    );
    phases.push(optionsPhase);
    checkPhase(
      optionsPhase,
      "see the host's options",
      (poll) => poll.options > 0,
    );

    for (let round = 0; round < config.voteRounds; round++) {
      const votePhase = await samplePhase(
        `concurrent-vote-round-${round + 1}`,
        harness,
        async () => {
          const ids = await optionIds(host);
          if (ids.length === 0) return;
          await Promise.all(
            voters.map((session, index) =>
              session.send("castVote", {
                optionId: ids[(round + index) % ids.length],
                voteType: VOTE_COLORS[(round + index) % VOTE_COLORS.length],
              })
            ),
          );
        },
      );
      phases.push(votePhase);
      // Only the first round is checked: a vote recast in the same color on
      // the same option and the same day toggles off, so a later round can
      // empty the poll again.
      if (round === 0) {
        checkPhase(votePhase, "see any vote", (poll) => poll.votes > 0);
      }
    }

    const churn = await collectChurn(sessions, voters);
    console.error(
      `[lunch-poll diagnose] churn ${config.optionCount}x${config.userCount} ` +
        `admission=${Deno.env.get("CF_CONFLICT_ADMISSION") ?? "0"}: ` +
        formatChurn(churn),
    );
    for (const session of churn.sessions) {
      console.error(
        `[lunch-poll diagnose]   ${session.label} ` +
          `(${session.voter ? "voter" : "observer"}): ${formatChurn(session)}`,
      );
    }

    // Settle once more, then assert all sessions converged on the shared state.
    await harness.settle(5);
    const convergence = await collectConvergence(sessions);
    console.error(
      `[lunch-poll diagnose] convergence ${config.optionCount}x${config.userCount}: ` +
        `converged=${convergence.converged} ` +
        `votes=[${convergence.voteCounts.join(",")}] ` +
        `options=[${convergence.optionCounts.join(",")}] ` +
        `users=[${convergence.userCounts.join(",")}]` +
        (convergence.converged
          ? ""
          : ` DIVERGED fingerprints=${
            JSON.stringify(convergence.fingerprints)
          }`),
    );

    return {
      case: {
        users: config.userCount,
        options: config.optionCount,
        voteRounds: config.voteRounds,
        voters: voters.length,
      },
      churn,
      convergence,
      phases,
    };
  } finally {
    await harness.dispose();
  }
}

function numberArg(
  name: string,
  fallback: number,
  args: readonly string[] = Deno.args,
): number {
  const prefix = `--${name}=`;
  const arg = args.find((entry) => entry.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function numberListArg(
  name: string,
  fallback: readonly number[],
  minimum = 0,
  args: readonly string[] = Deno.args,
): number[] {
  const prefix = `--${name}=`;
  const arg = args.find((entry) => entry.startsWith(prefix));
  if (!arg) return [...fallback];
  const values = arg.slice(prefix.length).split(",")
    .map((entry) => Number(entry.trim()));
  const invalid = values.find((entry) =>
    !Number.isInteger(entry) || entry < minimum
  );
  if (invalid !== undefined) {
    throw new Error(
      `--${name} must be comma-separated integers >= ${minimum}; got ${arg}`,
    );
  }
  return values;
}

function stringArg(
  name: string,
  fallback: string,
  args: readonly string[] = Deno.args,
): string {
  const prefix = `--${name}=`;
  const arg = args.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function explicitCasesArg(
  config: MatrixConfig,
  args: readonly string[],
): CaseConfig[] | undefined {
  const prefix = "--cases=";
  const arg = args.find((entry) => entry.startsWith(prefix));
  if (!arg) return undefined;
  const cases = arg.slice(prefix.length).split(",").flatMap((entry) => {
    const match = entry.trim().match(/^(\d+)x(\d+)$/);
    if (!match) return [];
    const optionCount = Number(match[1]);
    const userCount = Number(match[2]);
    validateUserCount(userCount, entry.trim());
    validateVoters(config.voters, userCount, entry.trim());
    return [{
      optionCount,
      userCount,
      voteRounds: config.voteRounds,
      voters: config.voters,
    }];
  });
  return cases.length > 0 ? cases : undefined;
}

function validateUserCount(userCount: number, source: string): void {
  if (!Number.isInteger(userCount) || userCount < 1) {
    throw new Error(
      `lunch-poll diagnostics require at least 1 user for ${source}; ` +
        `got ${userCount}`,
    );
  }
}

function validateVoters(
  voters: number | undefined,
  userCount: number,
  source: string,
): void {
  if (voters === undefined) return;
  if (!Number.isInteger(voters) || voters < 1) {
    throw new Error(`--voters must be an integer >= 1; got ${voters}`);
  }
  if (voters > userCount) {
    throw new Error(
      `--voters=${voters} exceeds the ${userCount} users of ${source}`,
    );
  }
}

export function matrixConfigFromArgs(
  args: readonly string[] = Deno.args,
): MatrixConfig {
  const quick = args.includes("--quick");
  const production = args.includes("--production");
  if (quick && production) {
    throw new Error("--quick and --production cannot be combined");
  }
  return {
    program: stringArg("program", "main.tsx", args),
    optionCounts: numberListArg(
      "options",
      production ? [14] : quick ? [1, 3] : [1, 3, 10],
      0,
      args,
    ),
    userCounts: numberListArg(
      "users",
      production ? [1] : quick ? [2] : [2, 5],
      1,
      args,
    ),
    voteRounds: numberArg("rounds", quick ? 1 : 3, args),
    voters: votersArg(args),
  };
}

/**
 * `--voters=N` has only the first `N` users cast in each vote round, the host
 * among them, while the rest only observe. Absent, every user casts.
 */
function votersArg(args: readonly string[]): number | undefined {
  const prefix = "--voters=";
  const arg = args.find((entry) => entry.startsWith(prefix));
  if (!arg) return undefined;
  const parsed = Number(arg.slice(prefix.length));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--voters must be an integer >= 1; got ${arg}`);
  }
  return parsed;
}

/** One line naming a case the way the probe announces it. */
export function describeCase(config: CaseConfig): string {
  return `${config.optionCount} options x ${config.userCount} users, ` +
    `rounds=${config.voteRounds}` +
    (config.voters === undefined ? "" : `, voters=${config.voters}`);
}

export function casesFromConfig(
  config: MatrixConfig,
  args: readonly string[] = Deno.args,
): CaseConfig[] {
  const explicit = explicitCasesArg(config, args);
  if (explicit) return explicit;
  const cases: CaseConfig[] = [];
  for (const optionCount of config.optionCounts) {
    for (const userCount of config.userCounts) {
      validateUserCount(userCount, `${optionCount}x${userCount}`);
      validateVoters(config.voters, userCount, `${optionCount}x${userCount}`);
      cases.push({
        optionCount,
        userCount,
        voteRounds: config.voteRounds,
        voters: config.voters,
      });
    }
  }
  return cases;
}

async function run(): Promise<void> {
  // A headless probe measures the derive-and-commit graph of the pattern and
  // hosts its own in-process memory server, which has no serving loop. Under
  // the ON posture the harness instead targets the integration environment's
  // toolshed (`env.API_URL`) and, with none running, waits on it forever. So
  // when the caller has not chosen a posture, pin the OFF arm for this
  // process; an explicit `EXPERIMENTAL_SERVER_EXECUTION` still wins.
  if (Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION") === undefined) {
    Deno.env.set("EXPERIMENTAL_SERVER_EXECUTION", "false");
  }
  const config = matrixConfigFromArgs(Deno.args);
  matrixProgram = config.program;
  const cases = casesFromConfig(config, Deno.args);
  const startedAt = performance.now();
  const results: ({ ok: true; result: CaseResult } | {
    ok: false;
    case: CaseConfig;
    error: string;
  })[] = [];

  for (const caseConfig of cases) {
    console.error(`[lunch-poll diagnose] case ${describeCase(caseConfig)}`);
    try {
      results.push({ ok: true, result: await runCase(caseConfig) });
    } catch (error) {
      results.push({
        ok: false,
        case: caseConfig,
        error: error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
      });
    }
  }

  console.log(JSON.stringify(
    {
      kind: "lunch-poll-scaling-diagnostics",
      config,
      elapsedMs: performance.now() - startedAt,
      results,
    },
    null,
    2,
  ));
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
