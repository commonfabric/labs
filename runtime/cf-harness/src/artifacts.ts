import { ensureDir } from "@std/fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "@std/path";
import type { HarnessRunState } from "./run-state.ts";
import type { HarnessCellLabels } from "./contracts/cell-labels.ts";
import type { HarnessCfcPolicySnapshot } from "./contracts/cfc-policy-snapshot.ts";
import type { HarnessPolicyTrace } from "./contracts/policy-trace.ts";
import { createHarnessPolicyEvent } from "./contracts/policy.ts";
import type { HarnessRunManifest } from "./contracts/run-manifest.ts";
import type { HarnessRunReport } from "./contracts/run-report.ts";
import type {
  HarnessAcquiredSkills,
  HarnessSkillActivations,
  HarnessSkillRegistry,
  HarnessSkillResourceReads,
  HarnessSkillScriptExecutions,
} from "./contracts/skill.ts";
import {
  createHarnessTranscriptOmissions,
  type HarnessTranscriptOmissions,
  isHarnessTranscriptOmissions,
} from "./contracts/transcript-omissions.ts";
import type { HarnessTranscriptMessage } from "./contracts/transcript.ts";
import type { ToolOutputId } from "./contracts/tool-result.ts";
import type { HarnessCapabilitySnapshot } from "./diagnostics.ts";

const sanitizeArtifactName = (input: string): string =>
  input.replace(/[^A-Za-z0-9._-]+/g, "_");

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * The one directory under an artifact root that is not a run's.
 *
 * Acquired scripts sit under it, one subdirectory per run, so that they are
 * inside no run root at all — the property `acquiredSkillsDir` rests on. A run
 * may not be named this, or its own artifacts would be that directory.
 */
const ACQUIRED_SKILLS_SEGMENT = ".acquired-skills";

const assertValidRunId = (runId: string): string => {
  if (!RUN_ID_PATTERN.test(runId) || runId === "." || runId === "..") {
    throw new Error(
      "runId must be a simple path segment containing only letters, numbers, dots, underscores, or hyphens",
    );
  }
  if (runId === ACQUIRED_SKILLS_SEGMENT) {
    throw new Error(
      `runId must not be ${ACQUIRED_SKILLS_SEGMENT}, which names the artifact root's acquired-scripts directory`,
    );
  }
  return runId;
};

const isPathWithinRoot = (path: string, root: string): boolean => {
  const relativePath = relative(root, path);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && relativePath !== ".." &&
      !isAbsolute(relativePath));
};

const resolveTranscriptPathWithinRunRoot = (
  runRoot: string,
  transcriptPath: string | undefined,
  fallbackPath: string,
): string => {
  if (transcriptPath === undefined) {
    return fallbackPath;
  }
  const resolvedRunRoot = resolve(runRoot);
  const resolvedTranscriptPath = resolve(transcriptPath);
  return isPathWithinRoot(resolvedTranscriptPath, resolvedRunRoot)
    ? resolvedTranscriptPath
    : fallbackPath;
};

// Artifacts such as run-state.json are the canonical audit and resume record and
// are rewritten on every tool call. A crash partway through a plain truncating
// write would leave a half-written file that breaks resume and corrupts the CFC
// audit trail. Write to a sibling temp file and rename, which is atomic on the
// same filesystem, so readers only ever observe a complete prior or new version.
const writeJsonFile = async (path: string, value: unknown): Promise<void> => {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tempPath, contents);
    await Deno.rename(tempPath, path);
  } catch (error) {
    await Deno.remove(tempPath).catch(() => {});
    throw error;
  }
};

export interface HarnessArtifactStore {
  readonly artifactRoot: string;
  readonly runRoot: string;

  /**
   * Host directory where image-attachment snapshots may be written, for
   * stores backed by a writable filesystem. Stores without a writable
   * location omit it; view_image attachments then stay locked to their
   * source file's bytes instead of snapshotting.
   */
  readonly imageAttachmentSnapshotDir?: string;

  /**
   * Host directory holding the scripts this run acquired, under the artifact
   * root's one non-run directory rather than inside any run root.
   *
   * Held apart from the run root BECAUSE of CT-2117, not despite it: the
   * artifact tree is not a confidentiality boundary — `bash` does not reserve
   * it the way the file tools do — and `acquire_skill` runs in the PARENT, so
   * a script written under the parent's run root is a script the planner can
   * read wherever that tree is reachable. That is the one property the
   * hostile-skill receipt rests on.
   *
   * Sitting outside the run roots buys the lifecycle and not the boundary: it
   * is created with the run and removed with it, and what keeps the parent out
   * is that no mount of the parent's sandbox covers it. The acquisition checks
   * that rather than assuming it, and refuses where it does not hold.
   */
  readonly acquiredSkillsDir?: string;

  persistRunState(state: HarnessRunState): Promise<string>;
  persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string>;
  persistCapabilitySnapshot(
    snapshot: HarnessCapabilitySnapshot,
  ): Promise<string>;
  persistCfcPolicySnapshot(
    snapshot: HarnessCfcPolicySnapshot,
  ): Promise<string>;
  persistPolicyTrace?(
    trace: HarnessPolicyTrace,
  ): Promise<string>;

  /**
   * Records what the run's space holds for the cells the run touched. A
   * store that cannot answer omits it, and the run keeps its labels in state
   * without a file beside them.
   */
  persistCellLabels?(
    labels: HarnessCellLabels,
  ): Promise<string>;

  persistRunReport(
    report: HarnessRunReport,
  ): Promise<string>;
  persistRunManifest?(manifest: HarnessRunManifest): Promise<string>;
  persistSkillRegistry?(
    registry: HarnessSkillRegistry,
  ): Promise<string>;
  persistSkillActivations?(
    activations: HarnessSkillActivations,
  ): Promise<string>;
  persistSkillResourceReads?(
    reads: HarnessSkillResourceReads,
  ): Promise<string>;
  persistSkillScriptExecutions?(
    executions: HarnessSkillScriptExecutions,
  ): Promise<string>;

  /**
   * Records which skills this run acquired scripts for, and where their bytes
   * sit. A store that cannot write it omits it, and the run acquires no
   * script rather than acquiring one it cannot say the location of.
   */
  persistAcquiredSkills?(
    skills: HarnessAcquiredSkills,
  ): Promise<string>;

  /**
   * Writes one acquired script into {@link acquiredSkillsDir} under
   * `relativeDir`, and returns the host path it landed at.
   *
   * Takes bytes, since what lands here is re-read and compared against the
   * digest the acquisition took over the bytes the pinned commit served.
   */
  writeAcquiredSkillScript?(
    relativeDir: string,
    path: string,
    bytes: Uint8Array,
  ): Promise<string>;

  persistToolOutput(
    toolId: string,
    outputId: ToolOutputId,
    output: unknown,
  ): Promise<string>;
}

export interface FileSystemHarnessArtifactStoreOptions {
  artifactRoot: string;
  runId: string;
}

export class FileSystemHarnessArtifactStore implements HarnessArtifactStore {
  readonly artifactRoot: string;
  readonly runRoot: string;
  readonly imageAttachmentSnapshotDir: string;
  readonly acquiredSkillsDir: string;

  constructor(options: FileSystemHarnessArtifactStoreOptions) {
    this.artifactRoot = resolve(options.artifactRoot);
    const runId = assertValidRunId(options.runId);
    this.runRoot = join(this.artifactRoot, runId);
    this.imageAttachmentSnapshotDir = join(this.runRoot, "image-attachments");
    // Under the artifact root's one non-run directory rather than under the
    // run root: same lifecycle, and inside no run's artifacts — not this
    // run's, and not another run's, which a `<runId>.acquired-skills` sibling
    // would be for a run named `<runId>.acquired-skills`.
    this.acquiredSkillsDir = join(
      this.artifactRoot,
      ACQUIRED_SKILLS_SEGMENT,
      runId,
    );
  }

  async persistRunState(state: HarnessRunState): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "run-state.json");
    await writeJsonFile(path, state);
    return path;
  }

  async persistTranscript(
    transcript: readonly HarnessTranscriptMessage[],
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "transcript.json");
    const omissionsPath = join(this.runRoot, "transcript-omissions.json");
    let previous: HarnessTranscriptOmissions | undefined;
    try {
      const parsed: unknown = JSON.parse(
        await Deno.readTextFile(omissionsPath),
      );
      if (!isHarnessTranscriptOmissions(parsed)) {
        throw new TypeError(
          `unsupported transcript omission artifact: ${omissionsPath}`,
        );
      }
      previous = parsed;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    const omissions = createHarnessTranscriptOmissions(transcript, previous);
    const hasResultProvenance = transcript.some((message) =>
      message.role === "tool" ||
      (message.role === "user" &&
        message.toolResultProvenance !== undefined)
    );
    if (
      previous !== undefined || omissions.results.length > 0 ||
      !hasResultProvenance
    ) {
      await writeJsonFile(omissionsPath, omissions);
    }
    await writeJsonFile(path, transcript);
    return path;
  }

  async persistCapabilitySnapshot(
    snapshot: HarnessCapabilitySnapshot,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "capabilities.json");
    await writeJsonFile(path, snapshot);
    return path;
  }

  async persistCfcPolicySnapshot(
    snapshot: HarnessCfcPolicySnapshot,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "policy-snapshot.json");
    await writeJsonFile(path, snapshot);
    return path;
  }

  async persistPolicyTrace(
    trace: HarnessPolicyTrace,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "policy-trace.json");
    await writeJsonFile(path, trace);
    return path;
  }

  async persistCellLabels(
    labels: HarnessCellLabels,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "cell-labels.json");
    await writeJsonFile(path, labels);
    return path;
  }

  async persistAcquiredSkills(
    skills: HarnessAcquiredSkills,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "acquired-skills.json");
    await writeJsonFile(path, skills);
    return path;
  }

  async writeAcquiredSkillScript(
    relativeDir: string,
    scriptPath: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const target = join(this.acquiredSkillsDir, relativeDir, scriptPath);
    if (!isPathWithinRoot(resolve(target), resolve(this.acquiredSkillsDir))) {
      throw new Error(
        `acquired script path escapes the acquired-skills directory: ${scriptPath}`,
      );
    }
    await ensureDir(dirname(target));
    await Deno.writeFile(target, bytes);
    return target;
  }

  async persistRunReport(
    report: HarnessRunReport,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "run-report.json");
    await writeJsonFile(path, report);
    return path;
  }

  async persistRunManifest(manifest: HarnessRunManifest): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "run-manifest.json");
    await writeJsonFile(path, manifest);
    return path;
  }

  async persistSkillRegistry(
    registry: HarnessSkillRegistry,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "skill-registry.json");
    await writeJsonFile(path, registry);
    return path;
  }

  async persistSkillActivations(
    activations: HarnessSkillActivations,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "skill-activations.json");
    await writeJsonFile(path, activations);
    return path;
  }

  async persistSkillResourceReads(
    reads: HarnessSkillResourceReads,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "skill-resource-reads.json");
    await writeJsonFile(path, reads);
    return path;
  }

  async persistSkillScriptExecutions(
    executions: HarnessSkillScriptExecutions,
  ): Promise<string> {
    await ensureDir(this.runRoot);
    const path = join(this.runRoot, "skill-script-executions.json");
    await writeJsonFile(path, executions);
    return path;
  }

  async persistToolOutput(
    toolId: string,
    outputId: ToolOutputId,
    output: unknown,
  ): Promise<string> {
    const directory = join(this.runRoot, "tool-outputs");
    await ensureDir(directory);
    const path = join(
      directory,
      `${sanitizeArtifactName(`${String(outputId)}-${toolId}`)}.json`,
    );
    await writeJsonFile(path, output);
    return path;
  }
}

export const createFileSystemHarnessArtifactStore = (
  options: FileSystemHarnessArtifactStoreOptions,
): FileSystemHarnessArtifactStore =>
  new FileSystemHarnessArtifactStore(options);

const normalizeHarnessRunState = (
  state: HarnessRunState,
): HarnessRunState => ({
  ...state,
  policyEvents: (state.policyEvents ?? []).map((event) =>
    event.type === "cf-harness.policy-event"
      ? event
      : createHarnessPolicyEvent(event)
  ),
  toolOutputs: [...(state.toolOutputs ?? [])],
  ...(state.policyDecisions !== undefined
    ? { policyDecisions: [...state.policyDecisions] }
    : {}),
  ...(state.subagentRuns !== undefined
    ? { subagentRuns: [...state.subagentRuns] }
    : {}),
  failureRecords: [...(state.failureRecords ?? [])],
});

export const readHarnessRunState = async (
  path: string,
): Promise<HarnessRunState> =>
  normalizeHarnessRunState(
    JSON.parse(await Deno.readTextFile(path)) as HarnessRunState,
  );

export const readHarnessTranscript = async (
  path: string,
): Promise<HarnessTranscriptMessage[]> =>
  JSON.parse(await Deno.readTextFile(path)) as HarnessTranscriptMessage[];

export const readHarnessRunReport = async (
  path: string,
): Promise<HarnessRunReport> =>
  JSON.parse(await Deno.readTextFile(path)) as HarnessRunReport;

export interface HarnessRunArtifacts {
  runRoot: string;
  runStatePath: string;
  transcriptPath?: string;
  runState: HarnessRunState;
  transcript?: HarnessTranscriptMessage[];
}

export const resolveHarnessRunPaths = (
  input: string,
): {
  runRoot: string;
  runStatePath: string;
  transcriptPath: string;
} => {
  const runStatePath = basename(input) === "run-state.json"
    ? input
    : join(input, "run-state.json");
  const runRoot = dirname(runStatePath);
  return {
    runRoot,
    runStatePath,
    transcriptPath: join(runRoot, "transcript.json"),
  };
};

export const readHarnessRunArtifacts = async (
  input: string,
): Promise<HarnessRunArtifacts> => {
  const paths = resolveHarnessRunPaths(input);
  const runState = await readHarnessRunState(paths.runStatePath);
  const transcriptPath = resolveTranscriptPathWithinRunRoot(
    paths.runRoot,
    runState.transcriptPath,
    paths.transcriptPath,
  );
  let transcript: HarnessTranscriptMessage[] | undefined;
  try {
    transcript = await readHarnessTranscript(transcriptPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return {
    runRoot: paths.runRoot,
    runStatePath: paths.runStatePath,
    ...(transcript !== undefined ? { transcriptPath } : {}),
    runState,
    ...(transcript !== undefined ? { transcript } : {}),
  };
};
