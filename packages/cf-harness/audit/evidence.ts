/**
 * Loading a run family off disk for the checks to read.
 *
 * The trees this reads are historic. A run written before an artifact existed
 * has no file for it, a run interrupted mid-write can have one that does not
 * parse, and a run from an older generation can have one whose shape has since
 * moved on. None of those is a reason to stop: an audit that crashes on the
 * first odd tree reports nothing about the rest, and an audit that treats a
 * missing file as a clean one reports compliance it never checked. Every
 * artifact therefore loads to a state that says which of the three it was,
 * and the checks turn absence into `inconclusive` rather than into `pass`.
 *
 * Reading only. Nothing here writes into an artifact tree.
 */

import { basename, join, resolve } from "@std/path";
import { isObjectNotArray } from "@commonfabric/utils/types";

import type { HarnessCellLabels } from "../src/contracts/cell-labels.ts";
import type { HarnessCfcPolicySnapshot } from "../src/contracts/cfc-policy-snapshot.ts";
import type { HarnessPolicyTrace } from "../src/contracts/policy-trace.ts";
import type { HarnessRunReport } from "../src/contracts/run-report.ts";
import type { HarnessTranscriptMessage } from "../src/contracts/transcript.ts";
import {
  type HarnessTranscriptOmissions,
  isHarnessTranscriptOmissions,
} from "../src/contracts/transcript-omissions.ts";
import type { HarnessRunState } from "../src/run-state.ts";

/**
 * One artifact, as this host found it.
 *
 * `unparseable` carries what went wrong rather than only that something did,
 * because the two causes want different answers: a file of invalid JSON is a
 * truncated write, and a file whose top level is not the shape the contract
 * declares is a generation this reader does not know.
 */
export type ArtifactState<T> =
  | { status: "present"; path: string; value: T }
  | { status: "absent"; path: string }
  | { status: "unparseable"; path: string; detail: string };

/** One file under a run's `tool-outputs/` directory. */
export interface ToolOutputArtifact {
  /** The file's name, which is the only part of its path a moved tree keeps. */
  fileName: string;

  path: string;

  /**
   * The parsed contents, absent when the file did not parse. A reader that
   * needs to say a tool output exists does not need to read it, so an
   * unreadable one is still reported as an output rather than dropped.
   */
  value?: unknown;
}

/** The `tool-outputs/` directory of one run. */
export type ToolOutputsState =
  | { status: "present"; path: string; entries: readonly ToolOutputArtifact[] }
  | { status: "absent"; path: string }
  | { status: "unparseable"; path: string; detail: string };

/** Every artifact one run wrote, as this host found them. */
export interface RunEvidence {
  /** The directory read, resolved. */
  runDir: string;

  /**
   * The run's id. Taken from `run-state.json` where that parsed, and from the
   * directory name otherwise, so an unreadable run is still nameable in a
   * finding.
   */
  runId: string;

  /** Set when this run is a `delegate_task` child of another in the family. */
  parentRunId?: string;

  runState: ArtifactState<HarnessRunState>;
  transcript: ArtifactState<readonly HarnessTranscriptMessage[]>;
  transcriptOmissions: ArtifactState<HarnessTranscriptOmissions>;
  runReport: ArtifactState<HarnessRunReport>;
  policyTrace: ArtifactState<HarnessPolicyTrace>;
  policySnapshot: ArtifactState<HarnessCfcPolicySnapshot>;
  cellLabels: ArtifactState<HarnessCellLabels>;
  toolOutputs: ToolOutputsState;
}

/**
 * A run and every `delegate_task` child written beside it.
 *
 * A child's artifacts sit in a sibling directory named for the parent, not
 * inside it, so the family is a directory listing rather than a walk. Reading
 * it as one family is what lets a check about the delegation boundary see
 * both sides of that boundary at once.
 */
export interface RunFamily {
  root: RunEvidence;
  children: readonly RunEvidence[];
}

/** Every run of a family, the root first. */
export const familyRuns = (family: RunFamily): readonly RunEvidence[] => [
  family.root,
  ...family.children,
];

type JsonRead =
  | { status: "read"; value: unknown }
  | { status: "absent" }
  | { status: "unparseable"; detail: string };

const readJsonFile = async (path: string): Promise<JsonRead> => {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { status: "absent" };
    }
    return {
      status: "unparseable",
      detail: `could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  try {
    return { status: "read", value: JSON.parse(text) };
  } catch (error) {
    return {
      status: "unparseable",
      detail: `is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  isObjectNotArray(value);

/**
 * Loads one artifact, admitting its contents only where `accept` recognizes
 * the top-level shape. A file whose top level is something else is
 * `unparseable` rather than `present`: a check reading it as the contract
 * declares it would otherwise report on fields nothing wrote.
 */
const loadArtifact = async <T>(
  path: string,
  accept: (value: unknown) => boolean,
  shape: string,
): Promise<ArtifactState<T>> => {
  const read = await readJsonFile(path);
  switch (read.status) {
    case "absent":
      return { status: "absent", path };
    case "unparseable":
      return { status: "unparseable", path, detail: read.detail };
    case "read":
      return accept(read.value)
        ? { status: "present", path, value: read.value as T }
        : { status: "unparseable", path, detail: `is not ${shape}` };
  }
};

const loadToolOutputs = async (runDir: string): Promise<ToolOutputsState> => {
  const path = join(runDir, "tool-outputs");
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isFile) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { status: "absent", path };
    }
    return {
      status: "unparseable",
      path,
      detail: `could not be listed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const entries: ToolOutputArtifact[] = [];
  for (const fileName of names.sort()) {
    const filePath = join(path, fileName);
    const read = await readJsonFile(filePath);
    entries.push({
      fileName,
      path: filePath,
      ...(read.status === "read" ? { value: read.value } : {}),
    });
  }
  return { status: "present", path, entries };
};

/** Loads every artifact of one run directory. */
export const loadRunEvidence = async (input: string): Promise<RunEvidence> => {
  const runDir = resolve(input);
  const runState = await loadArtifact<HarnessRunState>(
    join(runDir, "run-state.json"),
    isRecord,
    "a run-state object",
  );
  const stateRunId = runState.status === "present"
    ? (runState.value as { runId?: unknown }).runId
    : undefined;
  return {
    runDir,
    runId: typeof stateRunId === "string" && stateRunId.length > 0
      ? stateRunId
      : basename(runDir),
    runState,
    transcript: await loadArtifact<readonly HarnessTranscriptMessage[]>(
      join(runDir, "transcript.json"),
      Array.isArray,
      "an array of transcript messages",
    ),
    transcriptOmissions: await loadArtifact<HarnessTranscriptOmissions>(
      join(runDir, "transcript-omissions.json"),
      isHarnessTranscriptOmissions,
      "a transcript-omissions artifact",
    ),
    runReport: await loadArtifact<HarnessRunReport>(
      join(runDir, "run-report.json"),
      isRecord,
      "a run-report object",
    ),
    policyTrace: await loadArtifact<HarnessPolicyTrace>(
      join(runDir, "policy-trace.json"),
      isRecord,
      "a policy-trace object",
    ),
    policySnapshot: await loadArtifact<HarnessCfcPolicySnapshot>(
      join(runDir, "policy-snapshot.json"),
      isRecord,
      "a policy-snapshot object",
    ),
    cellLabels: await loadArtifact<HarnessCellLabels>(
      join(runDir, "cell-labels.json"),
      isRecord,
      "a cell-labels object",
    ),
    toolOutputs: await loadToolOutputs(runDir),
  };
};

/** The infix a child run's directory name carries under its parent's. */
const SUBAGENT_DIR_INFIX = ".subagent.";

const isRunDir = async (path: string): Promise<boolean> => {
  try {
    return (await Deno.stat(join(path, "run-state.json"))).isFile;
  } catch {
    return false;
  }
};

const holdsRunDir = async (path: string): Promise<boolean> => {
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isDirectory && await isRunDir(join(path, entry.name))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
};

/**
 * Loads a run and the `delegate_task` children written beside it.
 *
 * A grandchild's directory name carries its whole ancestry, so matching on
 * the prefix collects a delegation of any depth into the one family.
 */
export const loadRunFamily = async (input: string): Promise<RunFamily> => {
  const runDir = resolve(input);
  const root = await loadRunEvidence(runDir);
  const parentDir = resolve(runDir, "..");
  const prefix = `${basename(runDir)}${SUBAGENT_DIR_INFIX}`;
  const childNames: string[] = [];
  try {
    for await (const entry of Deno.readDir(parentDir)) {
      if (entry.isDirectory && entry.name.startsWith(prefix)) {
        childNames.push(entry.name);
      }
    }
  } catch {
    // A run directory whose parent cannot be listed has no discoverable
    // siblings. The root's own artifacts are still the audit's subject, and a
    // family of one is what the checks then see.
  }
  const children: RunEvidence[] = [];
  for (const name of childNames.sort()) {
    const child = await loadRunEvidence(join(parentDir, name));
    children.push({ ...child, parentRunId: root.runId });
  }
  return { root, children };
};

/**
 * Every run family under `input`.
 *
 * `input` is a run directory, an artifact root holding a `runs/` directory, or
 * a directory of run directories — the generations a console keeps beside its
 * current `runs/` are directories of the third kind. A child run directory is
 * not a family of its own: it is loaded as part of its parent's family, where
 * the checks about the delegation boundary can see both sides.
 */
export const discoverRunFamilies = async (
  input: string,
): Promise<readonly RunFamily[]> => {
  const root = resolve(input);
  if (await isRunDir(root)) {
    return [await loadRunFamily(root)];
  }
  const nested = join(root, "runs");
  const runsDir = await holdsRunDir(nested) ? nested : root;
  const names: string[] = [];
  for await (const entry of Deno.readDir(runsDir)) {
    if (
      entry.isDirectory && !entry.name.includes(SUBAGENT_DIR_INFIX) &&
      await isRunDir(join(runsDir, entry.name))
    ) {
      names.push(entry.name);
    }
  }
  const families: RunFamily[] = [];
  for (const name of names.sort()) {
    families.push(await loadRunFamily(join(runsDir, name)));
  }
  return families;
};
