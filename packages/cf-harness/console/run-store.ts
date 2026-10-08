/**
 * Reading the run artifacts a turn left behind. The harness writes each run to
 * `<artifact-root>/<run-id>/`, and this is the only thing that opens that tree
 * for the page: a run id and a tool-output name both arrive from a URL, so
 * both are checked against a path segment here rather than trusted into a
 * `join`.
 *
 * The console's own turns are not the only runs the harness makes on this
 * machine: the agent runner runs `/ask` jobs and `agent()` built-ins, each
 * under an artifact root of its own. {@link consoleArtifactRoots} names every
 * root, and the per-run readers below each read the one root a run was found
 * in.
 */

import { join } from "@std/path";
import { clauseAlternatives, type IFCLabel } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { HarnessRunState } from "../src/run-state.ts";
import type {
  HarnessHandleReferent,
  HarnessHandleTable,
} from "../src/contracts/handle-table.ts";
import {
  type ConsoleDisplayFit,
  publicConsoleDisplay,
} from "./display-ceiling.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import {
  isHarnessTranscriptOmissions,
} from "../src/contracts/transcript-omissions.ts";
import {
  type ConsoleRunLens,
  consoleRunLens,
  type ConsoleRunSummary,
  sortConsoleRuns,
  summarizeConsoleRun,
} from "./runs.ts";
import {
  type ConsoleHandle,
  consoleRunHandles,
  consoleRunSteps,
  type ConsoleStep,
  type ConsoleToolOutputArtifact,
  type ConsoleTranscriptOmissionsState,
} from "./steps.ts";
import {
  type ConsoleGraph,
  type ConsoleGraphRunInput,
  consoleRunFamilyGraph,
} from "./graph.ts";
import { type ConsoleFlow, consoleRunFlow } from "./flow.ts";
import {
  cellLabelsSummaryOf,
  type ConsoleCellLabelIndex,
  consoleCellLabelIndex,
  type ConsoleCellLabels,
  consoleCellLabels,
  type ConsoleCellLabelsStatus,
  type ConsoleCellLabelsSummary,
  consoleCellLabelsSummary,
  foldCellLabels,
} from "./cell-labels.ts";
import type { HarnessCellLabels } from "../src/contracts/cell-labels.ts";

/**
 * A single path segment of the characters the artifact store itself writes.
 * Anything else — a separator, a dot segment, an empty string — names
 * something outside the run tree and is refused rather than resolved.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

const isSafeSegment = (segment: string): boolean =>
  SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..";

/** The run directory, or `undefined` for a name that is not one. */
const runRoot = (
  artifactRoot: string,
  runId: string,
): string | undefined =>
  isSafeSegment(runId) ? join(artifactRoot, runId) : undefined;

const readJson = async <Value>(path: string): Promise<Value | undefined> => {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as Value;
  } catch {
    // A run still being written, or one whose optional artifact was never
    // produced, is a run to describe from what it does have.
    return undefined;
  }
};

/** Reads omission evidence without confusing a bad record with no record. */
const readTranscriptOmissions = async (
  path: string,
): Promise<ConsoleTranscriptOmissionsState> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound
      ? { status: "absent" }
      : { status: "unreadable" };
  }
  try {
    const value: unknown = JSON.parse(text);
    return isHarnessTranscriptOmissions(value)
      ? { status: "present", value }
      : { status: "unreadable" };
  } catch {
    return { status: "unreadable" };
  }
};

/**
 * The per-cell labels a run recorded, indexed by the addresses its cells go
 * by. A run that wrote no snapshot indexes as `absent`, which is not the same
 * reading as a space that had nothing to say.
 */
const cellLabelIndex = async (
  root: string,
): Promise<ConsoleCellLabelIndex> =>
  consoleCellLabelIndex(
    await readJson<HarnessCellLabels>(join(root, "cell-labels.json")),
  );

/** Everything `/api/runs/<run-id>` answers with. */
export interface ConsoleRunDetail {
  summary: ConsoleRunSummary;

  /**
   * The run's state, without the values its return referents stand for, which
   * reach the owner only through `revealed`.
   */
  runState: HarnessRunState;
  transcript: readonly HarnessTranscriptMessage[];
  lens: ConsoleRunLens;

  /** The run as a timeline, which is what the step scrubber reads. */
  steps: readonly ConsoleStep[];

  /**
   * Every handle the run introduced, resolved against its own table first and
   * against its neighbours' tables after — a token minted in an earlier turn
   * resolves to nothing in this run's own salted table, and an argument naming
   * that cell would otherwise read as coming from nowhere.
   */
  handles: readonly ConsoleHandle[];

  /**
   * The values another agent found that this run holds as return referents,
   * by token, for showing to the owner and never to a model. A value is here
   * when it is a string whose label fits what the console may show.
   */
  revealed: Readonly<Record<string, string>>;

  /**
   * The sites each value in `revealed` came from, by token, as the hosts of
   * the web pages its label says it was read from.
   */
  sites: Readonly<Record<string, readonly string[]>>;

  /** The tokens of the run's return referents the console may not show. */
  hidden: readonly string[];

  /**
   * Whether the run's space was read for per-cell labels, and what it said.
   * The run states this once because the per-cell fact cannot: a cell with no
   * labels means the space holds none for it under a snapshot that was taken,
   * and means nobody asked under a run whose space could not be read.
   */
  cellLabels: ConsoleCellLabelsSummary;

  /** The artifacts this run wrote, by name, for the raw pane to fetch. */
  artifactNames: readonly string[];

  /** The files under `tool-outputs/`, newest call last. */
  toolOutputNames: readonly string[];
}

/**
 * The named artifacts a run root holds, other than its tool outputs. Each is
 * optional: a run that failed before it wrote one is still a run to read.
 */
const RUN_ARTIFACT_NAMES = [
  "run-state.json",
  "transcript.json",
  "transcript-omissions.json",
  "run-report.json",
  "run-manifest.json",
  "policy-snapshot.json",
  "policy-trace.json",
  "capabilities.json",
  "skill-registry.json",
  "skill-activations.json",
  "skill-resource-reads.json",
  "skill-script-executions.json",
  "cell-labels.json",
] as const;

const namesPresent = async (
  root: string,
  candidates: readonly string[],
): Promise<string[]> => {
  const present: string[] = [];
  for (const name of candidates) {
    try {
      const info = await Deno.stat(join(root, name));
      if (info.isFile) {
        present.push(name);
      }
    } catch {
      // Absent, which is the ordinary case for most of them.
    }
  }
  return present;
};

/**
 * The call this output belongs to. The artifact store names a file for its
 * output id and the tool that wrote it, `<run-id>_<tool>_<sequence>-<tool>`,
 * with the id's separators rewritten — so the sequence is the digits before
 * the trailing tool name, and the leading run id may carry digits and hyphens
 * of its own. The last such group is therefore the one that counts. A name of
 * some other shape sorts after every call rather than in among them.
 */
const toolOutputSequence = (name: string): number => {
  let sequence: number | undefined;
  for (const match of name.matchAll(/_(\d+)-/g)) {
    sequence = Number(match[1]);
  }
  return sequence ?? Number.MAX_SAFE_INTEGER;
};

const toolOutputNames = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(join(root, "tool-outputs"))) {
      if (entry.isFile && entry.name.endsWith(".json")) {
        names.push(entry.name);
      }
    }
  } catch {
    // A run that called no tool wrote no directory.
  }
  // The sequence a name carries counts every call the run made, whichever tool
  // made it, so it is the run's own order and the only thing worth sorting on:
  // the name leads with the tool, and sorting on that groups a mixed run by
  // tool instead of laying it out as it happened.
  return names.sort((left, right) => {
    const bySequence = toolOutputSequence(left) - toolOutputSequence(right);
    return bySequence !== 0
      ? bySequence
      : left.localeCompare(right, undefined, { numeric: true });
  });
};

/**
 * Who made a run. `console` is a turn this console ran; `ask` is a job the
 * agent runner's local-jobs lane ran for `/ask`; `agent` is an `agent()`
 * built-in's run that the runner's Fabric lane executed.
 */
export type ConsoleRunSource = "console" | "ask" | "agent";

/** One row of the run list, with where the run came from. */
export interface ConsoleListedRun extends ConsoleRunSummary {
  source: ConsoleRunSource;
}

/**
 * Where the console reads runs from: its own artifact root, and the agent
 * runner's work root when there is one to read.
 */
export interface ConsoleRunRoots {
  /** `<artifact-root>/<run-id>/`, which this console's own turns write. */
  console: string;

  /**
   * The agent runner's work root, `$CF_HARNESS_HOME/agent-runs` unless the
   * runner was told otherwise. Each job it runs writes its runs a level or two
   * down: `<root>/local/<job-id>/artifacts/<run-id>/` for the local-jobs lane
   * that `/ask` uses, `<root>/<run-key>/artifacts/<run-id>/` for the Fabric
   * lane that executes `agent()`.
   */
  agentRuns?: string;
}

/** One artifact root to read, and who wrote the runs in it. */
export interface ConsoleArtifactRoot {
  source: ConsoleRunSource;
  artifactRoot: string;
}

/** The directories directly under `root` that are safe to name, sorted. */
const safeSubdirectories = async (root: string): Promise<string[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (entry.isDirectory && isSafeSegment(entry.name)) {
        names.push(entry.name);
      }
    }
  } catch {
    // A root nothing has run under yet is a root with no runs.
  }
  return names.sort();
};

/**
 * The name of the agent runner's local-jobs lane under its work root. The
 * runner puts that lane one level below the work root it shares with the
 * Fabric lane (`packages/cli/commands/agent.ts`), so a Fabric run key can never
 * be this name: the runner derives those keys from a hash.
 */
const LOCAL_JOBS_LANE = "local";

/**
 * Every artifact root the console reads, in precedence order: its own first,
 * then each `/ask` job's, then each `agent()` run's, each group by directory
 * name. A run id found in more than one is the first one's — run ids are
 * random UUIDs, so this is a tie-break for an accident rather than a rule
 * anyone relies on, and the list and the detail routes both apply it.
 *
 * Shortcut: this walks the runner's whole work root on every request, which is
 * cheap at the hundreds of jobs a developer's machine holds. A runner that
 * prunes nothing will make it slow; an index of run id to job, kept by the
 * runner or cached here by the work root's mtime, is the way out.
 */
export const consoleArtifactRoots = async (
  roots: ConsoleRunRoots,
): Promise<readonly ConsoleArtifactRoot[]> => {
  const found: ConsoleArtifactRoot[] = [
    { source: "console", artifactRoot: roots.console },
  ];
  if (roots.agentRuns === undefined) {
    return found;
  }
  const lanes = await safeSubdirectories(roots.agentRuns);
  if (lanes.includes(LOCAL_JOBS_LANE)) {
    const local = join(roots.agentRuns, LOCAL_JOBS_LANE);
    for (const job of await safeSubdirectories(local)) {
      found.push({
        source: "ask",
        artifactRoot: join(local, job, "artifacts"),
      });
    }
  }
  for (const lane of lanes) {
    if (lane === LOCAL_JOBS_LANE) continue;
    found.push({
      source: "agent",
      artifactRoot: join(roots.agentRuns, lane, "artifacts"),
    });
  }
  return found;
};

/**
 * Every run the console can read, from every root, most recently touched
 * first. A run id that more than one root holds is listed once, from the root
 * {@link consoleArtifactRoots} puts first.
 */
export const listAllConsoleRuns = async (
  roots: ConsoleRunRoots,
): Promise<readonly ConsoleListedRun[]> => {
  const byId = new Map<string, ConsoleListedRun>();
  for (const { source, artifactRoot } of await consoleArtifactRoots(roots)) {
    for (const run of await listConsoleRuns(artifactRoot, source)) {
      if (!byId.has(run.runId)) {
        byId.set(run.runId, run);
      }
    }
  }
  return sortConsoleRuns([...byId.values()]);
};

/**
 * The artifact root that holds `runId`, or `undefined` for a run no root holds
 * or a name that is not a run id. Every per-run route resolves through this
 * and then reads that one root, so a run's `delegate_task` children and the
 * neighbours its handles resolve against are the ones its own job wrote.
 *
 * The first root whose run has a readable state wins, which is the root
 * {@link listAllConsoleRuns} lists it from. A run directory with no state yet
 * — one still being written, or a child whose tool outputs a route names
 * directly — is still a run to read files from, so failing that the first
 * root holding the directory at all answers.
 */
export const findConsoleRunRoot = async (
  roots: ConsoleRunRoots,
  runId: string,
): Promise<ConsoleArtifactRoot | undefined> => {
  if (!isSafeSegment(runId)) {
    return undefined;
  }
  let holdsDirectory: ConsoleArtifactRoot | undefined;
  for (const candidate of await consoleArtifactRoots(roots)) {
    const runDir = join(candidate.artifactRoot, runId);
    const runState = await readJson<HarnessRunState>(
      join(runDir, "run-state.json"),
    );
    if (runState !== undefined) {
      return candidate;
    }
    if (holdsDirectory === undefined && await isDirectory(runDir)) {
      holdsDirectory = candidate;
    }
  }
  return holdsDirectory;
};

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
};

/**
 * Every run under one artifact root, most recently touched first, each tagged
 * with `source`.
 */
export const listConsoleRuns = async (
  artifactRoot: string,
  source: ConsoleRunSource = "console",
): Promise<readonly ConsoleListedRun[]> => {
  const summaries: ConsoleListedRun[] = [];
  try {
    // `Deno.readDir` reports a missing directory on its first step rather than
    // at the call, so an artifact root that no run has been written to yet is
    // caught around the walk rather than around the call.
    for await (const entry of Deno.readDir(artifactRoot)) {
      if (!entry.isDirectory || !isSafeSegment(entry.name)) {
        continue;
      }
      const root = join(artifactRoot, entry.name);
      const runState = await readJson<HarnessRunState>(
        join(root, "run-state.json"),
      );
      if (runState === undefined) {
        continue;
      }
      const transcript = await readJson<HarnessTranscriptMessage[]>(
        join(root, "transcript.json"),
      ) ??
        [];
      summaries.push({ ...summarizeConsoleRun(runState, transcript), source });
    }
  } catch {
    // No run has been made yet, so there is no tree to list.
    return [];
  }
  return sortConsoleRuns(summaries);
};

/** `runState` with its handle table holding no return referents. */
const withoutReferents = (runState: HarnessRunState): HarnessRunState =>
  runState.handleTable === undefined ? runState : {
    ...runState,
    handleTable: {
      ...runState.handleTable,
      referents: runState.handleTable.referents?.filter((referent) =>
        referent.kind !== "return"
      ),
    },
  };

/**
 * The hosts of the web pages `label` says its value was read from: the
 * sources of the caveats a page's content carries.
 */
const labelSites = (label: IFCLabel): readonly string[] => {
  const sites = new Set<string>();
  const atoms = (label.confidentiality ?? []).flatMap(clauseAlternatives);
  for (const atom of atoms) {
    if (!isObjectNotArray(atom) || !isObjectNotArray(atom.source)) continue;
    const { class: kind, subject } = atom.source;
    if (kind !== "WebPage" || typeof subject !== "string") continue;
    try {
      sites.add(new URL(subject).host);
    } catch {
      // A page whose origin could not be read names no site.
    }
  }
  return [...sites];
};

/**
 * The return referents of a run as the console may show them: each string
 * whose label fits `display` by its token, with the sites it came from, and
 * the token of every other.
 */
const referentDisplay = (
  referents: readonly HarnessHandleReferent[],
  display: ConsoleDisplayFit,
): Pick<ConsoleRunDetail, "revealed" | "sites" | "hidden"> => {
  const revealed: Record<string, string> = {};
  const sites: Record<string, readonly string[]> = {};
  const hidden: string[] = [];
  for (const referent of referents) {
    if (referent.kind !== "return") continue;
    if (typeof referent.value === "string" && display(referent.label)) {
      revealed[referent.token] = referent.value;
      sites[referent.token] = labelSites(referent.label);
    } else {
      hidden.push(referent.token);
    }
  }
  return { revealed, sites, hidden };
};

/** One run read whole, or `undefined` when the artifact root holds no such run. */
export const readConsoleRun = async (
  artifactRoot: string,
  runId: string,
  display: ConsoleDisplayFit = publicConsoleDisplay,
): Promise<ConsoleRunDetail | undefined> => {
  const root = runRoot(artifactRoot, runId);
  if (root === undefined) {
    return undefined;
  }
  const runState = await readJson<HarnessRunState>(
    join(root, "run-state.json"),
  );
  if (runState === undefined) {
    return undefined;
  }
  const transcript =
    await readJson<HarnessTranscriptMessage[]>(join(root, "transcript.json")) ??
      [];
  const omissions = await readTranscriptOmissions(
    join(root, "transcript-omissions.json"),
  );
  const outputNames = await toolOutputNames(root);
  const toolOutputs: ConsoleToolOutputArtifact[] = [];
  for (const name of outputNames) {
    const artifactPath = join(root, "tool-outputs", name);
    const value = await readJson<unknown>(artifactPath);
    if (value !== undefined) {
      toolOutputs.push({ artifactPath, value });
    }
  }
  const steps = consoleRunSteps(
    transcript,
    runState.policyDecisions ?? [],
    runState.policyEvents,
    runState.cfcInvocationContexts ?? [],
    omissions,
    toolOutputs,
  );
  // A token minted in an earlier turn resolves to nothing in this run's own
  // table, and an argument naming that cell by link would then read as coming
  // from nowhere. The neighbours' tables are what give it an address, and so a
  // name and an origin.
  const neighbours = await neighbouringHandles(artifactRoot);
  // The index is the run's own, and it is applied to every handle the run
  // introduced — so a cell whose address only a neighbour's entry supplies is
  // labelled here all the same, while the neighbour's own handles stay bare.
  const labels = await cellLabelIndex(root);
  const table: HarnessHandleTable = {
    type: "cf-harness.handle-table",
    version: 1,
    salt: runState.handleTable?.salt ?? runId,
    entries: [
      ...neighbours.flatMap((handle) =>
        handle.ref === undefined || handle.addressKey === undefined ? [] : [{
          token: handle.token,
          kind: "address" as const,
          ref: handle.ref,
          addressKey: handle.addressKey,
        }]
      ),
      ...(runState.handleTable?.entries ?? []),
    ],
  };
  return {
    summary: summarizeConsoleRun(runState, transcript),
    runState: withoutReferents(runState),
    transcript,
    lens: consoleRunLens(transcript),
    steps,
    handles: consoleRunHandles(steps, table, labels),
    ...referentDisplay(runState.handleTable?.referents ?? [], display),
    cellLabels: consoleCellLabelsSummary(labels),
    artifactNames: await namesPresent(root, RUN_ARTIFACT_NAMES),
    toolOutputNames: outputNames,
  };
};

/**
 * The data-flow graph of a run and the `delegate_task` children beneath it.
 *
 * The family rather than the run alone, because that is where the routing
 * lives: a parent commonly names a cell its child produced, and a graph drawn
 * per run shows that cell arriving from nowhere. A subagent run asked for
 * directly graphs its own subtree, which is what someone who opened a child
 * asked to see.
 *
 * Descendants are found by name — the harness ids a child `<parent>.subagent.N`
 * — so this reads one directory listing rather than every run's state.
 */
export const readConsoleRunFamilyGraph = async (
  artifactRoot: string,
  runId: string,
): Promise<ConsoleGraph | undefined> => {
  const family = await readConsoleRunFamily(artifactRoot, runId);
  return family === undefined
    ? undefined
    : consoleRunFamilyGraph(family.root, family.descendants);
};

/** The conversation map of a run and the children beneath it. */
export const readConsoleRunFlow = async (
  artifactRoot: string,
  runId: string,
): Promise<ConsoleFlow | undefined> => {
  const family = await readConsoleRunFamily(artifactRoot, runId);
  if (family === undefined) {
    return undefined;
  }
  const posture = family.runState.fabricSessionCfc;
  return consoleRunFlow(
    family.root,
    family.descendants,
    posture === undefined ? undefined : {
      enforcementMode: posture.enforcementMode,
      flowLabels: posture.flowLabels,
      ...(posture.posture !== undefined ? { posture: posture.posture } : {}),
    },
    family.cellLabels,
  );
};

/**
 * A run and its `delegate_task` descendants, each reading its handles against
 * the neighbours' tables as well as its own, and each against its own label
 * snapshot — a child writes its own, so a cell a child produced carries the
 * space's labels in the family graph and in the map. Both are built from this,
 * and neither wants to know how a family is found on disk.
 */
const readConsoleRunFamily = async (
  artifactRoot: string,
  runId: string,
): Promise<
  | {
    root: ConsoleGraphRunInput;
    descendants: ConsoleGraphRunInput[];
    runState: HarnessRunState;
    cellLabels: ConsoleCellLabelsSummary;
  }
  | undefined
> => {
  const root = await readConsoleRun(artifactRoot, runId);
  if (root === undefined) {
    return undefined;
  }
  const members: FamilyLabelReading[] = [{
    runState: root.runState,
    labels: await cellLabelIndex(join(artifactRoot, runId)),
  }];
  const descendants: ConsoleGraphRunInput[] = [];
  try {
    for await (const entry of Deno.readDir(artifactRoot)) {
      if (!entry.isDirectory || !entry.name.startsWith(`${runId}.`)) {
        continue;
      }
      const child = await readConsoleRun(artifactRoot, entry.name);
      if (child !== undefined) {
        descendants.push({
          runId: entry.name,
          steps: child.steps,
          handles: child.handles,
        });
        members.push({
          runState: child.runState,
          labels: await cellLabelIndex(join(artifactRoot, entry.name)),
        });
      }
    }
  } catch {
    // A run with no siblings on disk is a family of one.
  }
  const neighbours = await neighbouringHandles(artifactRoot);
  // A run's own table wins, so it is appended last.
  const withNeighbours = (run: ConsoleGraphRunInput): ConsoleGraphRunInput => ({
    ...run,
    handles: [...neighbours, ...run.handles],
  });
  return {
    root: withNeighbours({ runId, steps: root.steps, handles: root.handles }),
    descendants: descendants.map(withNeighbours),
    runState: root.runState,
    cellLabels: familyCellLabels(members),
  };
};

/** One member of a family, as the family's own reading is folded from. */
interface FamilyLabelReading {
  runState: HarnessRunState;
  labels: ConsoleCellLabelIndex;
}

/** The members that each status was read for, in the words a header uses. */
const statusTally = (
  statuses: readonly ConsoleCellLabelsStatus[],
): string =>
  (["read", "unavailable", "absent"] as const)
    .flatMap((status) => {
      const count = statuses.filter((each) => each === status).length;
      return count === 0 ? [] : [`${count} ${status}`];
    })
    .join(", ");

/**
 * What the whole family read of the space, folded from what each member read.
 *
 * The status is the sentence every bare cell on the map is read under: no
 * labels means the space holds none where the snapshot was taken, and means
 * nobody asked where it was not. So a family whose members disagree cannot be
 * reported as any one member's status — the root's `read` would speak for a
 * child's cells that nothing was read for, and the root's `absent` would deny
 * a child's cells the labels its own snapshot holds. A disagreement is stated
 * as one instead: `unavailable`, with the split in its detail, which claims
 * nothing about any member's cells.
 *
 * A member that minted no handle had no cell to snapshot, and its missing
 * snapshot is that rather than a gap, so it is left out of the reckoning.
 * The cells themselves are merged by address, so a cell a parent and its
 * child both hold is one cell of the family rather than two — and merged by
 * {@link foldCellLabels}, so that a cell one member did not finish reading is
 * counted as partial however whole another member's reading of it was.
 */
const familyCellLabels = (
  members: readonly FamilyLabelReading[],
): ConsoleCellLabelsSummary => {
  const byAddress = new Map<string, ConsoleCellLabels>();
  for (const member of members) {
    for (const [address, record] of member.labels.byAddress) {
      const held = byAddress.get(address);
      const reading = consoleCellLabels(record);
      byAddress.set(
        address,
        held === undefined ? reading : foldCellLabels(held, reading),
      );
    }
  }
  const speaking = members.filter((member) =>
    (member.runState.handleTable?.entries ?? []).length > 0
  );
  const statuses = speaking.map((member) => member.labels.status);
  const agreed = speaking[0] ?? members[0];
  if (new Set(statuses).size > 1) {
    const space = members.find((member) => member.labels.space !== undefined)
      ?.labels.space;
    return cellLabelsSummaryOf({
      status: "unavailable",
      detail: `the runs in this family disagree: ${statusTally(statuses)}`,
      ...(space !== undefined ? { space } : {}),
    }, byAddress.values());
  }
  return cellLabelsSummaryOf(agreed.labels, byAddress.values());
};

/**
 * Every handle any run on disk minted, by token.
 *
 * A handle table is salted per run, so a token minted in one turn resolves to
 * nothing in the next turn's table — and a later turn that wires the earlier
 * turn's cell by link would draw two nodes for the one cell. Reading the
 * neighbours' tables lets the token resolve to the address it always stood
 * for, which is what merges them.
 *
 * The salt makes a token effectively unique to the run that minted it, so a
 * token meaning two addresses across runs would be a coincidence rather than
 * the ordinary case; a run's own table is consulted first regardless.
 */
const neighbouringHandles = async (
  artifactRoot: string,
): Promise<ConsoleHandle[]> => {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(artifactRoot)) {
      if (entry.isDirectory && isSafeSegment(entry.name)) {
        names.push(entry.name);
      }
    }
  } catch {
    return [];
  }
  // The index is keyed by which runs exist AND by when each was last written,
  // because a run mints handles as it goes: keying on the set of names alone
  // would hold a running turn's first snapshot and report every cell it minted
  // after that as unresolved. A stat per run is still far cheaper than parsing
  // every run's state on a timeline that re-reads whenever a tool completes.
  const stamps: string[] = [];
  for (const name of names.sort()) {
    let stamp = "absent";
    try {
      const info = await Deno.stat(join(artifactRoot, name, "run-state.json"));
      // Size as well as time: two writes inside one millisecond share an
      // mtime, and a run that mints a handle grows its table.
      stamp = `${info.mtime?.getTime() ?? 0}:${info.size}`;
    } catch {
      // A run whose state cannot be read contributes no entries either way.
    }
    stamps.push(`${name}@${stamp}`);
  }
  const key = `${artifactRoot}\n${stamps.join("\n")}`;
  const cached = neighbourIndex.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const handles = await readNeighbouringHandles(artifactRoot, names);
  neighbourIndex.clear();
  neighbourIndex.set(key, handles);
  return handles;
};

/**
 * The last neighbour index built, by the set of runs it was built from. One
 * entry: an index built from a different set is one this server will not ask
 * for again.
 */
const neighbourIndex = new Map<string, ConsoleHandle[]>();

const readNeighbouringHandles = async (
  artifactRoot: string,
  names: readonly string[],
): Promise<ConsoleHandle[]> => {
  const handles: ConsoleHandle[] = [];
  try {
    for (const name of names) {
      const entry = { name };
      const runState = await readJson<HarnessRunState>(
        join(artifactRoot, entry.name, "run-state.json"),
      );
      for (const entryHandle of runState?.handleTable?.entries ?? []) {
        handles.push({
          token: entryHandle.token,
          ref: entryHandle.ref,
          addressKey: entryHandle.addressKey,
          introducedAtStep: 0,
          // A neighbour's entry resolves an address and nothing more; what the
          // handle was used for, and what its cell is labelled, belong to the
          // run that used it and are left absent rather than invented here.
          uses: [],
          confidentiality: [],
        });
      }
    }
  } catch {
    // No neighbours to read is simply no extra resolution.
  }
  return handles;
};

/**
 * One artifact of a run, as its own text, for the pane that shows a run's raw
 * JSON. Only the names a run is known to write are readable — an arbitrary
 * name is refused rather than resolved, so this route reads run artifacts and
 * nothing else on the host.
 */
export const readConsoleRunArtifact = async (
  artifactRoot: string,
  runId: string,
  name: string,
): Promise<string | undefined> => {
  const root = runRoot(artifactRoot, runId);
  if (
    root === undefined || !isSafeSegment(name) ||
    !(RUN_ARTIFACT_NAMES as readonly string[]).includes(name)
  ) {
    return undefined;
  }
  try {
    return await Deno.readTextFile(join(root, name));
  } catch {
    return undefined;
  }
};

/**
 * One tool output, untruncated. This is the payload the feed shows elided and
 * the model itself read in full, which is the whole reason the inspector
 * exists.
 */
export const readConsoleToolOutput = async (
  artifactRoot: string,
  runId: string,
  name: string,
): Promise<string | undefined> => {
  const root = runRoot(artifactRoot, runId);
  if (root === undefined || !isSafeSegment(name) || !name.endsWith(".json")) {
    return undefined;
  }
  try {
    return await Deno.readTextFile(join(root, "tool-outputs", name));
  } catch {
    return undefined;
  }
};
