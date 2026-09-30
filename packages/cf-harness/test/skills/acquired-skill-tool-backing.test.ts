/**
 * Which backing makes `run_skill_script` a tool a run offers.
 *
 * Its two backings are independent, and the gate that reads them is the one
 * that decides whether a child holding a mounted acquired skill can execute
 * anything at all. A child's tool surface passes through
 * `withheldToolIds` a second time inside its own prompt loop, so an allowance
 * added upstream survives only if the backing agrees.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type HarnessToolBackingAvailability,
  withheldToolIds,
} from "../../src/contracts/tool-descriptor.ts";
import type { HarnessAcquiredSkill } from "../../src/contracts/skill.ts";
import type { DockerRunscSandboxConfig } from "../../src/sandbox/types.ts";
import { acquiredSkillScriptBacking } from "../../src/skills/acquired-skill-mount.ts";

const backing = (
  overrides: Partial<HarnessToolBackingAvailability> = {},
): HarnessToolBackingAvailability => ({
  fabricSessionAvailable: true,
  patternIndexAvailable: true,
  skillsShSearchAvailable: true,
  skillsShAcquisitionAvailable: true,
  skillRegistryAvailable: false,
  docsCorpusAvailable: true,
  ...overrides,
});

const acquired: HarnessAcquiredSkill = {
  registryId: "owner/repo/slug",
  commitSha: "d".repeat(40),
  pin: `owner/repo/slug@${"d".repeat(40)}`,
  hostRoot: "/artifacts/.acquired-skills/run-1/sha/slug",
  sandboxRoot: "/acquired-skill",
  scripts: [],
};

const sandboxWith = (
  additionalMounts: DockerRunscSandboxConfig["additionalMounts"],
): DockerRunscSandboxConfig => ({
  dockerBinary: "docker",
  runtimeName: "runsc-cfc",
  image: "cf-harness:test",
  workspaceHostPath: "/tmp/workspace",
  workspaceMountPath: "/workspace",
  shellPath: "/bin/bash",
  dockerNetworkMode: "none",
  additionalMounts,
  extraDockerArgs: [],
});

const acquiredMount = {
  kind: "host-bind" as const,
  name: "acquired-skill",
  hostPath: acquired.hostRoot,
  sandboxPath: "/acquired-skill",
  readOnly: true,
};

describe("acquiredSkillScriptBacking()", () => {
  //
  // Holding an acquired skill is not the same as being able to run one. The
  // script is addressed by the path its mount puts it at, so the mount is what
  // decides, and the backing composes into the tool gate below.
  //

  it("backs a run whose own sandbox mounts the acquired skill", () => {
    expect(acquiredSkillScriptBacking(sandboxWith([acquiredMount]), [acquired]))
      .toBe(true);
    expect(
      withheldToolIds(
        backing({
          acquiredSkillsAvailable: acquiredSkillScriptBacking(
            sandboxWith([acquiredMount]),
            [acquired],
          ),
        }),
      ).has("run_skill_script"),
    ).toBe(false);
  });

  it("does not back the acquiring parent, which mounts nothing", () => {
    // The parent holds the skill in run state and deliberately does not mount
    // it — the property the hostile-skill receipt rests on — so it is offered
    // no tool it could not use.
    expect(acquiredSkillScriptBacking(sandboxWith([]), [acquired])).toBe(false);
    expect(
      withheldToolIds(
        backing({
          acquiredSkillsAvailable: acquiredSkillScriptBacking(
            sandboxWith([]),
            [acquired],
          ),
        }),
      ).has("run_skill_script"),
    ).toBe(true);
  });

  it("does not back a child that shares a handed-in sandbox runtime", () => {
    // There was no configuration to extend, so no mount was added for it.
    expect(acquiredSkillScriptBacking(undefined, [acquired])).toBe(false);
  });

  it("does not back a mount that is not this skill's, whatever it is named", () => {
    // An operator `--host-mount` that happened to carry the name would be a
    // coincidence rather than the mount this acquisition made, so the host and
    // sandbox roots have to be the ones recorded with the skill, read-only.
    const wrongHost = { ...acquiredMount, hostPath: "/somewhere/else" };
    const wrongSandbox = { ...acquiredMount, sandboxPath: "/elsewhere" };
    const writable = { ...acquiredMount, readOnly: false };

    expect(acquiredSkillScriptBacking(sandboxWith([wrongHost]), [acquired]))
      .toBe(false);
    expect(acquiredSkillScriptBacking(sandboxWith([wrongSandbox]), [acquired]))
      .toBe(false);
    expect(acquiredSkillScriptBacking(sandboxWith([writable]), [acquired]))
      .toBe(false);
  });

  it("does not back a run holding no acquired skill, however it is mounted", () => {
    expect(acquiredSkillScriptBacking(sandboxWith([acquiredMount]), []))
      .toBe(false);
    expect(acquiredSkillScriptBacking(sandboxWith([acquiredMount]), undefined))
      .toBe(false);
  });

  it("leaves read_skill_resource withheld on the backed path", () => {
    expect(
      withheldToolIds(
        backing({
          acquiredSkillsAvailable: acquiredSkillScriptBacking(
            sandboxWith([acquiredMount]),
            [acquired],
          ),
        }),
      ).has("read_skill_resource"),
    ).toBe(true);
  });
});

describe("withheldToolIds() over the skill tools", () => {
  it("offers run_skill_script to a run holding an acquired skill and no registry", () => {
    // The bytes came from a pinned commit and this run mounts them. A child
    // given the skill but not the tool holds a mounted skill it cannot run.
    const withheld = withheldToolIds(
      backing({ acquiredSkillsAvailable: true }),
    );

    expect(withheld.has("run_skill_script")).toBe(false);
  });

  it("still withholds read_skill_resource, which only a registry backs", () => {
    // An acquired skill carries no resource index, so the read tool would
    // answer `skill_registry_missing` on every call.
    const withheld = withheldToolIds(
      backing({ acquiredSkillsAvailable: true }),
    );

    expect(withheld.has("read_skill_resource")).toBe(true);
  });

  it("withholds run_skill_script when neither backing is there", () => {
    expect(withheldToolIds(backing()).has("run_skill_script")).toBe(true);
    expect(
      withheldToolIds(backing({ acquiredSkillsAvailable: false })).has(
        "run_skill_script",
      ),
    ).toBe(true);
  });

  it("offers both to a run with a skills root and no acquisition", () => {
    const withheld = withheldToolIds(backing({ skillRegistryAvailable: true }));

    expect(withheld.has("run_skill_script")).toBe(false);
    expect(withheld.has("read_skill_resource")).toBe(false);
  });
});
