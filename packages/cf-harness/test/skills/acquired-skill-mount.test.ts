import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type {
  HarnessAcquiredSkill,
  HarnessSkillAcquisition,
} from "../../src/contracts/skill.ts";
import type { DockerRunscSandboxConfig } from "../../src/sandbox/types.ts";
import { resolveRunscSandboxConfig } from "../../src/sandbox/runsc.ts";
import {
  acquiredSkillForHandle,
  acquiredSkillScriptSurface,
  childSandboxOptions,
} from "../../src/skills/acquired-skill-mount.ts";

const REGISTRY_ID = "zubair-trabzada/ai-finance-claude/finance-budget";
const COMMIT_SHA = "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c";
const OTHER_COMMIT_SHA = "0".repeat(40);

const acquisitionAt = (commitSha: string): HarnessSkillAcquisition => ({
  registryId: REGISTRY_ID,
  commitSha,
  sourceUrl: `https://skills.sh/${REGISTRY_ID}@${commitSha}/SKILL.md`,
  verification: "git-commit-sha",
  valueDigest: "sha256:instructions",
  receivedAt: "2026-09-14T00:00:00.000Z",
});

const acquiredAt = (commitSha: string): HarnessAcquiredSkill => ({
  registryId: REGISTRY_ID,
  commitSha,
  pin: `${REGISTRY_ID}@${commitSha}`,
  hostRoot: `/artifacts/run-1.acquired-skills/${commitSha}/finance-budget`,
  sandboxRoot: "/acquired-skill",
  scripts: [],
});

const parentSandbox: DockerRunscSandboxConfig = {
  dockerBinary: "docker",
  runtimeName: "runsc-cfc",
  image: "cf-harness:test",
  workspaceHostPath: "/tmp/workspace",
  workspaceMountPath: "/workspace",
  shellPath: "/bin/bash",
  dockerNetworkMode: "none",
  additionalMounts: [{
    kind: "host-bind",
    name: "docs",
    hostPath: "/tmp/docs",
    sandboxPath: "/docs",
    readOnly: true,
  }],
  extraDockerArgs: [],
};

describe("the acquired-skill mount a delegation gives its child", () => {
  //
  // The parent plans the acquisition and never holds its bytes; the child it
  // hands the handle to holds them, read-only, and holds no other skill's.
  //

  describe("acquiredSkillForHandle()", () => {
    it("returns the skill the handle's acquisition pins", () => {
      expect(
        acquiredSkillForHandle(
          [acquiredAt(OTHER_COMMIT_SHA), acquiredAt(COMMIT_SHA)],
          acquisitionAt(COMMIT_SHA),
        ),
      ).toEqual(acquiredAt(COMMIT_SHA));
    });

    it("returns nothing for the same skill acquired at another commit", () => {
      expect(
        acquiredSkillForHandle(
          [acquiredAt(OTHER_COMMIT_SHA)],
          acquisitionAt(COMMIT_SHA),
        ),
      ).toBeUndefined();
    });

    it("returns nothing for a handle no acquisition minted", () => {
      // An operator-seeded skill cell is handed over by handle with no
      // external source behind it, and mounts nothing.
      expect(acquiredSkillForHandle([acquiredAt(COMMIT_SHA)], undefined))
        .toBeUndefined();
    });
  });

  describe("acquiredSkillScriptSurface()", () => {
    const entryAt = (skill: string) => ({
      skill,
      path: "scripts/category-budgets.sh",
    });

    it("gives the child the operator's entries for its own pin, and the tool", () => {
      // The allowlist is the run's and the tool surface is the profile's.
      // Without both brought to the child it holds a mounted skill it cannot
      // run a script of.
      expect(
        acquiredSkillScriptSurface(
          [entryAt(`${REGISTRY_ID}@${COMMIT_SHA}`)],
          acquiredAt(COMMIT_SHA),
        ),
      ).toEqual({
        allowedSkillScripts: [entryAt(`${REGISTRY_ID}@${COMMIT_SHA}`)],
        toolIds: ["run_skill_script"],
      });
    });

    it("withholds an entry naming another skill's pin", () => {
      // The operator decided about the scripts of the skill this child was
      // given, and about no others.
      expect(
        acquiredSkillScriptSurface(
          [entryAt(`${REGISTRY_ID}@${OTHER_COMMIT_SHA}`), {
            skill: "agent-browser",
            path: "scripts/run.ts",
          }],
          acquiredAt(COMMIT_SHA),
        ),
      ).toEqual({ allowedSkillScripts: [], toolIds: [] });
    });

    it("grants the tool when the operator allows skill scripts", () => {
      // The run's one decision, brought to a child whose profile does not
      // carry the tool. No entry names anything.
      expect(acquiredSkillScriptSurface([], acquiredAt(COMMIT_SHA), true))
        .toEqual({ allowedSkillScripts: [], toolIds: ["run_skill_script"] });
    });

    it("grants nothing to a child given no acquired skill, however it reads", () => {
      expect(acquiredSkillScriptSurface([], undefined, true))
        .toEqual({ allowedSkillScripts: [], toolIds: [] });
    });

    it("grants no tool when the operator allowlisted nothing at the pin", () => {
      // An acquisition is not an authorization: mounting the bytes and being
      // allowed to run one are separate decisions, and the second is the
      // operator's.
      expect(acquiredSkillScriptSurface([], acquiredAt(COMMIT_SHA)))
        .toEqual({ allowedSkillScripts: [], toolIds: [] });
      expect(acquiredSkillScriptSurface(undefined, acquiredAt(COMMIT_SHA)))
        .toEqual({ allowedSkillScripts: [], toolIds: [] });
    });

    it("grants nothing to a child given no acquired skill", () => {
      expect(
        acquiredSkillScriptSurface(
          [entryAt(`${REGISTRY_ID}@${COMMIT_SHA}`)],
          undefined,
        ),
      ).toEqual({ allowedSkillScripts: [], toolIds: [] });
    });
  });

  describe("childSandboxOptions()", () => {
    const fakeRuntime = {
      kind: "the parent's runtime",
    } as unknown as Parameters<typeof childSandboxOptions>[0]["sandbox"];

    it("gives a child with an acquired skill a configuration and no runtime", () => {
      // A mount is a property of the container, so a runtime already built
      // against the parent's mounts would ignore anything handed beside it:
      // the child has to build its own, which it can only do from a
      // configuration.
      const options = childSandboxOptions({
        sandbox: fakeRuntime,
        ownedSandboxConfig: parentSandbox,
        configuredSandbox: parentSandbox,
      }, acquiredAt(COMMIT_SHA));

      expect(options.sandboxRuntime).toBeUndefined();
      expect(options.sandbox?.additionalMounts).toEqual([
        ...parentSandbox.additionalMounts,
        {
          kind: "host-bind",
          name: "acquired-skill",
          hostPath: acquiredAt(COMMIT_SHA).hostRoot,
          sandboxPath: "/acquired-skill",
          readOnly: true,
        },
      ]);
    });

    it("leaves every other mount of the parent's in place", () => {
      const options = childSandboxOptions({
        sandbox: fakeRuntime,
        ownedSandboxConfig: parentSandbox,
      }, acquiredAt(COMMIT_SHA));

      expect(options.sandbox?.workspaceHostPath).toBe(
        parentSandbox.workspaceHostPath,
      );
      expect(options.sandbox?.additionalMounts.length).toBe(
        parentSandbox.additionalMounts.length + 1,
      );
    });

    it("adds no second mount where the parent's configuration already backs the skill", () => {
      // A configuration that already backs this skill would otherwise gain a
      // duplicate under the same name at the same sandbox path. Asked through
      // the predicate the backing decision uses, so "already mounted" means
      // the same thing here as it does there.
      const acquired = acquiredAt(COMMIT_SHA);
      const alreadyMounted = {
        ...parentSandbox,
        additionalMounts: [
          ...parentSandbox.additionalMounts,
          {
            kind: "host-bind" as const,
            name: "acquired-skill",
            hostPath: acquired.hostRoot,
            sandboxPath: "/acquired-skill",
            readOnly: true,
          },
        ],
      };

      const options = childSandboxOptions({
        sandbox: fakeRuntime,
        ownedSandboxConfig: alreadyMounted,
      }, acquired);

      expect(options.sandbox?.additionalMounts).toEqual(
        alreadyMounted.additionalMounts,
      );
    });

    it("shares the parent's runtime with a child given no acquired skill", () => {
      const options = childSandboxOptions({
        sandbox: fakeRuntime,
        ownedSandboxConfig: parentSandbox,
        configuredSandbox: parentSandbox,
      }, undefined);

      expect(options.sandboxRuntime).toBe(fakeRuntime);
      expect(options.sandbox).toBe(parentSandbox);
    });

    it("shares the parent's runtime when that runtime was handed in", () => {
      // An injected runtime is the thing that executes; a configuration beside
      // it describes something else, so there is nothing to extend.
      const options = childSandboxOptions({
        sandbox: fakeRuntime,
        configuredSandbox: parentSandbox,
      }, acquiredAt(COMMIT_SHA));

      expect(options.sandboxRuntime).toBe(fakeRuntime);
      expect(options.sandbox).toBe(parentSandbox);
    });
  });
});

describe("childSandboxOptions() on the runsc runtime", () => {
  const sandbox = {
    describe: () => ({
      kind: "runsc-cfc",
      defaultWorkingDirectory: "/workspace",
    }),
  } as unknown as Parameters<typeof childSandboxOptions>[0]["sandbox"];
  const parentRunsc = resolveRunscSandboxConfig({
    workspaceHostPath: "/tmp/workspace",
    rootfs: "/images/kitchensink",
    cfcPolicyPath: "/policy.json",
    runscBinary: "/opt/runsc",
    networkMode: "sandbox",
    scratchDir: "/tmp/scratch",
    runId: "run-1",
    platform: "linux",
    additionalMounts: [{
      kind: "host-bind",
      name: "cabinet",
      hostPath: "/tmp/cabinet",
      sandboxPath: "/file-cabinet",
      readOnly: true,
    }],
  });

  it("gives a child that mounts an acquired skill a runsc sandbox of its own", () => {
    const options = childSandboxOptions(
      { sandbox, ownedRunscSandboxConfig: parentRunsc },
      acquiredAt(COMMIT_SHA),
    );
    expect(options.sandboxRuntime).toBeUndefined();
    expect(options.sandbox).toBeUndefined();
    expect(options.sandboxRuntimeKind).toBe("runsc");
    expect(options.sandboxRootfs).toBe("/images/kitchensink");
    expect(options.sandboxCfcPolicy).toBe("/policy.json");
    expect(options.sandboxRunscBinary).toBe("/opt/runsc");
    expect(options.sandboxRunscNetworkMode).toBe("sandbox");
    expect(options.additionalMounts?.map((m) => m.sandboxPath)).toEqual([
      "/file-cabinet",
      "/acquired-skill",
    ]);
    const skillMount = options.additionalMounts?.[1];
    expect(skillMount?.kind).toBe("host-bind");
    expect(skillMount?.readOnly).toBe(true);
    expect(skillMount?.hostPath).toBe(acquiredAt(COMMIT_SHA).hostRoot);
  });

  it("adds no second mount where the parent's runsc configuration already backs the skill", () => {
    const acquired = acquiredAt(COMMIT_SHA);
    const alreadyMounted = resolveRunscSandboxConfig({
      workspaceHostPath: "/tmp/workspace",
      rootfs: "/images/kitchensink",
      scratchDir: "/tmp/scratch",
      runId: "run-1",
      platform: "linux",
      additionalMounts: [
        ...parentRunsc.additionalMounts,
        {
          kind: "host-bind",
          name: "acquired-skill",
          hostPath: acquired.hostRoot,
          sandboxPath: "/acquired-skill",
          readOnly: true,
        },
      ],
    });
    const options = childSandboxOptions(
      { sandbox, ownedRunscSandboxConfig: alreadyMounted },
      acquired,
    );
    expect(options.sandboxRuntimeKind).toBe("runsc");
    expect(options.additionalMounts).toBe(alreadyMounted.additionalMounts);
    expect(options.additionalMounts?.map((m) => m.sandboxPath)).toEqual([
      "/file-cabinet",
      "/acquired-skill",
    ]);
  });

  it("shares the parent's runsc runtime when there is nothing to mount", () => {
    const options = childSandboxOptions(
      { sandbox, ownedRunscSandboxConfig: parentRunsc },
      undefined,
    );
    expect(options.sandboxRuntime).toBe(sandbox);
    expect(options.sandboxRuntimeKind).toBeUndefined();
  });
});
