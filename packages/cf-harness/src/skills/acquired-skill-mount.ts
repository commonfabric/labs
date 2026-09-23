/**
 * How an acquired skill's scripts reach the one run allowed to execute them.
 *
 * Acquisition happens in a parent and execution in a child, and the whole of
 * the arrangement between them is here: which acquired skill a delegation's
 * `skillHandle` selects, and what the child's sandbox configuration becomes
 * once it has one. The parent that planned an acquisition never mounts its
 * bytes; the child it hands the handle to mounts that skill's and no other's,
 * read-only.
 */

import type {
  DockerRunscAdditionalMountConfig,
  DockerRunscSandboxConfig,
  SandboxRuntime,
  SandboxRuntimeMountDescription,
} from "../sandbox/types.ts";
import type { RunscNetworkMode, RunscSandboxConfig } from "../sandbox/runsc.ts";
import type {
  HarnessAcquiredSkill,
  HarnessAllowedSkillScript,
  HarnessSkillAcquisition,
} from "../contracts/skill.ts";

/** The mount name a child's acquired-skill directory is bound under. */
export const ACQUIRED_SKILL_MOUNT_NAME = "acquired-skill";

/**
 * Where a run that holds a skill's handle sees that skill's acquired scripts.
 *
 * One path rather than one per pin: a delegation carries a single
 * `skillHandle`, so a child has one acquired skill and needs one mount, and a
 * fixed path is what the `sandboxPath` recorded at acquisition can be written
 * against — before any child exists to be told where its mount landed.
 */
export const ACQUIRED_SKILL_MOUNT_PATH = "/acquired-skill";

/**
 * The refusal a run meets when a mount of its own sandbox covers the directory
 * its acquired scripts would be written into.
 *
 * A class rather than a message, because the caller has to tell this apart
 * from a failure to write: this one is a policy answer about who could read
 * the bytes, and the tool reports it as a refusal naming the mount, while a
 * disk that would not take the file is an error.
 */
export class AcquiredSkillDirectoryReadableError extends Error {
  static readonly code = "acquired_scripts_readable_by_acquiring_run";

  constructor(message: string) {
    super(message);
    this.name = "AcquiredSkillDirectoryReadableError";
  }
}

/**
 * The acquired skill a delegation hands its child: the one the acquisition
 * behind the delegation's `skillHandle` names, and no other.
 *
 * A run holds the scripts of the skill it was given. The pin is the match —
 * the discovery id and the commit together — because two acquisitions of one
 * skill at two commits are two different sets of bytes, and a child given the
 * handle to one must not reach the other.
 */
export const acquiredSkillForHandle = (
  acquiredSkills: readonly HarnessAcquiredSkill[] | undefined,
  acquisition: HarnessSkillAcquisition | undefined,
): HarnessAcquiredSkill | undefined =>
  acquisition === undefined
    ? undefined
    : acquiredSkills?.find((skill) =>
      skill.registryId === acquisition.registryId &&
      skill.commitSha === acquisition.commitSha
    );

/**
 * The sandbox options a child engine is built with, given the acquired skill
 * it was handed.
 *
 * A child normally shares its parent's sandbox runtime — the same container
 * configuration, and the object that executes in it. A child that mounts an
 * acquired skill cannot: the mount is a property of the container, so a
 * runtime already built against the parent's mounts would ignore any
 * configuration handed alongside it and the skill's directory would never
 * appear. Such a child is given a configuration and no runtime, and builds its
 * own from it — which also keeps the CFC transport floor, since an engine
 * checks that only for a sandbox it built.
 *
 * The parent's own configuration is what is extended, so the child differs
 * from it in exactly one mount: the acquired skill's host root, read-only,
 * because a script the child could rewrite is a script whose acquisition
 * digest says nothing about what ran. Where the parent's runtime was handed in
 * rather than built, there is no configuration to extend and the child shares,
 * acquired skill or not.
 */
export const childSandboxOptions = (
  parent: {
    sandbox: SandboxRuntime;
    ownedSandboxConfig?: DockerRunscSandboxConfig;
    /** The parent's direct-runsc configuration, when that is what it runs. */
    ownedRunscSandboxConfig?: RunscSandboxConfig;
    configuredSandbox?: DockerRunscSandboxConfig;
  },
  acquired: HarnessAcquiredSkill | undefined,
): {
  sandboxRuntime?: SandboxRuntime;
  sandbox?: DockerRunscSandboxConfig;
  sandboxRuntimeKind?: "runsc";
  sandboxRootfs?: string;
  sandboxCfcPolicy?: string;
  sandboxRunscBinary?: string;
  sandboxRunscNetworkMode?: RunscNetworkMode;
  additionalMounts?: readonly DockerRunscAdditionalMountConfig[];
} => {
  if (acquired !== undefined && parent.ownedRunscSandboxConfig !== undefined) {
    // The direct runtime: the child names the same runsc configuration in the
    // engine's own option vocabulary, plus the one mount, and the engine
    // builds it a runtime of its own with its own run id.
    const runsc = parent.ownedRunscSandboxConfig;
    return {
      sandboxRuntimeKind: "runsc",
      sandboxRootfs: runsc.rootfs,
      ...(runsc.cfcPolicyPath !== undefined
        ? { sandboxCfcPolicy: runsc.cfcPolicyPath }
        : {}),
      sandboxRunscBinary: runsc.runscBinary,
      sandboxRunscNetworkMode: runsc.networkMode,
      additionalMounts:
        acquiredSkillMountBacks(runsc.additionalMounts, acquired)
          ? runsc.additionalMounts
          : [
            ...runsc.additionalMounts,
            {
              kind: "host-bind",
              name: ACQUIRED_SKILL_MOUNT_NAME,
              hostPath: acquired.hostRoot,
              sandboxPath: acquired.sandboxRoot,
              readOnly: true,
            },
          ],
    };
  }
  if (acquired === undefined || parent.ownedSandboxConfig === undefined) {
    return {
      sandboxRuntime: parent.sandbox,
      ...(parent.configuredSandbox !== undefined
        ? { sandbox: parent.configuredSandbox }
        : {}),
    };
  }
  // A configuration that already backs this skill needs no second mount of it
  // — two binds under one name at one sandbox path, where the first already
  // answers. Asked through the predicate the rest of this decides by, so a
  // run that is backed is backed by one mount however it got there.
  if (
    acquiredSkillMountBacks(
      parent.ownedSandboxConfig.additionalMounts,
      acquired,
    )
  ) {
    return { sandbox: parent.ownedSandboxConfig };
  }
  return {
    sandbox: {
      ...parent.ownedSandboxConfig,
      additionalMounts: [
        ...parent.ownedSandboxConfig.additionalMounts,
        {
          kind: "host-bind",
          name: ACQUIRED_SKILL_MOUNT_NAME,
          hostPath: acquired.hostRoot,
          sandboxPath: acquired.sandboxRoot,
          readOnly: true,
        },
      ],
    },
  };
};

/**
 * What a child given an acquired skill may do with the scripts mounted for it.
 *
 * Two facts have to meet here and belong to different things. Whether this run
 * runs skill scripts at all is a property of the RUN — the operator's one
 * decision — while a child's tool surface is a property of its PROFILE.
 * Neither reaches the other on its own, so without this a child would hold a
 * mounted skill and no tool to run a script of it.
 *
 * `allowedSkillScripts` entries naming this skill's pin are carried too, for a
 * run whose operator wrote them; a run with the dial on needs none.
 */
export const acquiredSkillScriptSurface = (
  runAllowlist: readonly HarnessAllowedSkillScript[] | undefined,
  acquired: HarnessAcquiredSkill | undefined,
  allowSkillScripts = false,
): {
  allowedSkillScripts: readonly HarnessAllowedSkillScript[];
  toolIds: readonly "run_skill_script"[];
} => {
  if (acquired === undefined) {
    return { allowedSkillScripts: [], toolIds: [] };
  }
  const allowedSkillScripts = (runAllowlist ?? []).filter((script) =>
    script.skill === acquired.pin
  );
  return {
    allowedSkillScripts,
    toolIds: allowSkillScripts || allowedSkillScripts.length > 0
      ? ["run_skill_script"]
      : [],
  };
};

/**
 * Whether this run can execute an acquired skill's script at all: it holds one
 * and its own sandbox mounts it.
 *
 * Holding the bytes is not enough, and neither is holding the handle. The
 * script is addressed by the path the mount puts it at, so a run whose sandbox
 * does not carry that mount could be offered `run_skill_script` and still have
 * nothing to run — which is what this exists to stop.
 *
 * Two runs fail it for different reasons, and both should. The PARENT that
 * acquired the skill holds it in run state and deliberately does not mount it,
 * which is the property the hostile-skill receipt rests on. A child whose
 * parent's sandbox runtime was handed in rather than built shares that runtime
 * — there was no configuration to extend — so no mount was added for it
 * either.
 *
 * A mount answers for a skill only where it is that skill's: the host root it
 * was written to, at the sandbox root recorded with it, read-only. The name
 * alone would let an operator `--host-mount` that happened to carry it stand
 * in for the mount this made, which is a coincidence rather than a backing.
 *
 * Being backed is necessary and not sufficient. What the child may actually
 * run is what the operator allows — the run-wide switch, or an entry at the
 * pin; see {@link acquiredSkillScriptSurface} — and a run backed with
 * neither receives no tool.
 */
export const acquiredSkillScriptBacking = (
  ownedSandboxConfig:
    | Pick<DockerRunscSandboxConfig, "additionalMounts">
    | undefined,
  acquiredSkills: readonly HarnessAcquiredSkill[] | undefined,
): boolean =>
  (acquiredSkills ?? []).some((skill) =>
    acquiredSkillMountBacks(ownedSandboxConfig?.additionalMounts, skill)
  );

/**
 * Whether these mounts are the ones this skill's bytes were put behind.
 *
 * The same question {@link acquiredSkillScriptBacking} asks of a run, asked of
 * one skill against one set of mounts, so that the decision to offer the tool
 * and the decision to run a script are one predicate rather than two that
 * agree by inspection. A mount answers for a skill only where it is that
 * skill's: the host root the acquisition wrote to, at the sandbox root
 * recorded with it, read-only.
 */
export const acquiredSkillMountBacks = (
  mounts: readonly SandboxRuntimeMountDescription[] | undefined,
  skill: HarnessAcquiredSkill,
): boolean =>
  (mounts ?? []).some((mount) =>
    mount.kind === "host-bind" &&
    mount.name === ACQUIRED_SKILL_MOUNT_NAME &&
    mount.hostPath === skill.hostRoot &&
    mount.sandboxPath === skill.sandboxRoot &&
    mount.readOnly
  );
