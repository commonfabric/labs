/**
 * The one session assembly, checked from both surfaces at once.
 *
 * The point of these tests is parity: an operator who describes the same
 * session to the batch CLI and to the console server must get the same
 * session. Every capability the console lagged the CLI on — external skill
 * acquisition, host mounts, discoverable publishing, the well-known grants —
 * was a difference these comparisons would have shown as a failing assertion
 * the day it appeared, so they are written as comparisons of what the two
 * surfaces produce rather than as assertions about either one's fields.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolveConsoleConfig } from "../console/server.ts";
import { parseCfHarnessCliArgs } from "../src/cli.ts";
import {
  harnessSessionChatPolicy,
  type HarnessSessionConfig,
  harnessSessionEngineOptions,
} from "../src/session-assembly.ts";

const IDENTITY = "/console/key.pkcs8";
const SPACE = "parity-space";
const API_URL = "http://localhost:8000";
const INDEX_URL = "https://index.test/api";
const REGISTRY_URL = "https://registry.test";

/** The session both surfaces are asked for, spelled each surface's way. */
const parityArguments = (
  workspace: string,
  hostMountSource: string,
  skillsRoot: string,
) => ({
  cli: [
    "--workspace",
    workspace,
    "--artifact-root",
    "/console/runs",
    "--model",
    "gpt-parity",
    "--max-model-turns",
    "32",
    "--reasoning-effort",
    "high",
    "--skills-root",
    skillsRoot,
    "--fabric-api-url",
    API_URL,
    "--fabric-identity",
    IDENTITY,
    "--fabric-space",
    SPACE,
    "--fabric-cfc-posture",
    "max-enforcement",
    "--pattern-index-url",
    INDEX_URL,
    "--skills-registry-url",
    REGISTRY_URL,
    "--host-mount",
    `name=reference,source=${hostMountSource},target=/reference`,
    // The console sites the sandbox's two CFC sidecar transports under its own
    // data directory; the CLI is told where they are. Named on both so the
    // comparison is of one session rather than of two defaults.
    "--cfc-result-dir",
    "/console/.cf-harness-console/cfc/results",
    "--cfc-invocation-context-dir",
    "/console/.cf-harness-console/cfc/invocation-context",
    "--space-db",
    "/serving/cache/memory/space.sqlite",
    "--allow-subagent-profile",
    "default",
    "--allow-subagent-profile",
    "pattern-author",
    "prompt text",
  ],
  console: [
    "--workspace",
    workspace,
    "--artifact-root",
    "/console/runs",
    "--model",
    "gpt-parity",
    "--max-model-turns",
    "32",
    "--reasoning-effort",
    "high",
    "--skills-root",
    skillsRoot,
    "--fabric-api-url",
    API_URL,
    "--fabric-identity",
    IDENTITY,
    "--fabric-space",
    SPACE,
    "--fabric-cfc-posture",
    "max-enforcement",
    "--pattern-index-url",
    INDEX_URL,
    "--skills-registry-url",
    REGISTRY_URL,
    "--host-mount",
    `name=reference,source=${hostMountSource},target=/reference`,
    "--session-db",
    "none",
    "--space-db",
    "/serving/cache/memory/space.sqlite",
  ],
});

/**
 * The CLI's own resolution, with the environment emptied so a developer's
 * shell cannot make one surface's answer differ from the other's.
 */
const cliSession = async (
  args: readonly string[],
): Promise<HarnessSessionConfig> => {
  const parsed = await parseCfHarnessCliArgs(args, {
    cwd: "/console",
    env: {},
  });
  if ("help" in parsed) {
    throw new Error("parity arguments asked for help");
  }
  return parsed;
};

/**
 * A workspace holding a skills tree and a directory to bind-mount. Both have
 * to exist on disk: a mount source is resolved through its real path, and the
 * CLI holds a skills root to the workspace and the run's host mounts.
 */
const parityDirectories = async (): Promise<
  {
    workspace: string;
    hostMountSource: string;
    skillsRoot: string;
    cleanup: () => Promise<void>;
  }
> => {
  const root = await Deno.makeTempDir({ prefix: "cf-harness-parity-" });
  await Deno.mkdir(`${root}/reference`);
  await Deno.mkdir(`${root}/skills`);
  return {
    // A temporary directory on macOS is reached through a symlink, so both
    // surfaces are given the resolved path rather than what `makeTempDir`
    // returned — otherwise only one of them resolves it and they differ over
    // a fact about this host rather than about the session.
    workspace: await Deno.realPath(root),
    hostMountSource: await Deno.realPath(`${root}/reference`),
    skillsRoot: await Deno.realPath(`${root}/skills`),
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
};

describe("session-assembly", () => {
  describe("the CLI and the console assembling one session", () => {
    it("build the same engine options from the same configuration", async () => {
      const { workspace, hostMountSource, skillsRoot, cleanup } =
        await parityDirectories();
      try {
        const args = parityArguments(workspace, hostMountSource, skillsRoot);
        const cli = await cliSession(args.cli);
        const server = await resolveConsoleConfig(args.console, {}, "/console");

        expect(harnessSessionEngineOptions(server)).toEqual(
          harnessSessionEngineOptions(cli),
        );
      } finally {
        await cleanup();
      }
    });

    it("offer the same tools and subagent profiles", async () => {
      const { workspace, hostMountSource, skillsRoot, cleanup } =
        await parityDirectories();
      try {
        const args = parityArguments(workspace, hostMountSource, skillsRoot);
        const cli = await cliSession(args.cli);
        const server = await resolveConsoleConfig(args.console, {}, "/console");

        expect(harnessSessionChatPolicy(server)).toEqual(
          harnessSessionChatPolicy(cli),
        );
        // Named rather than left to the comparison: these are the four the
        // console could not reach, and a parity test that passed because both
        // surfaces lost a tool would say nothing about them.
        const { allowedToolIds } = harnessSessionChatPolicy(server);
        expect(allowedToolIds).toContain("run_pattern");
        expect(allowedToolIds).toContain("search_patterns");
        expect(allowedToolIds).toContain("search_skills");
        expect(allowedToolIds).toContain("acquire_skill");
      } finally {
        await cleanup();
      }
    });

    it("read labels from the same space database", async () => {
      const { workspace, hostMountSource, skillsRoot, cleanup } =
        await parityDirectories();
      try {
        const args = parityArguments(workspace, hostMountSource, skillsRoot);
        const cli = await cliSession(args.cli);
        const server = await resolveConsoleConfig(args.console, {}, "/console");

        // Named rather than left to the comparison above: a parity that held
        // because neither surface carried the path would say nothing.
        expect(harnessSessionEngineOptions(cli).spaceDbPath).toBe(
          "/serving/cache/memory/space.sqlite",
        );
        expect(harnessSessionEngineOptions(server).spaceDbPath).toBe(
          "/serving/cache/memory/space.sqlite",
        );
      } finally {
        await cleanup();
      }
    });

    it("provision the same host bind mount", async () => {
      const { workspace, hostMountSource, skillsRoot, cleanup } =
        await parityDirectories();
      try {
        const args = parityArguments(workspace, hostMountSource, skillsRoot);
        const server = await resolveConsoleConfig(args.console, {}, "/console");

        expect(harnessSessionEngineOptions(server).additionalMounts).toEqual([
          {
            kind: "host-bind",
            name: "reference",
            hostPath: hostMountSource,
            sandboxPath: "/reference",
            readOnly: true,
          },
        ]);
      } finally {
        await cleanup();
      }
    });

    it("publish discoverably on the same operator instruction", async () => {
      const cli = await cliSession([
        "--fabric-api-url",
        API_URL,
        "--fabric-identity",
        IDENTITY,
        "--fabric-space",
        SPACE,
        "--pattern-index-url",
        INDEX_URL,
        "prompt text",
      ]);
      const server = await resolveConsoleConfig(
        [
          "--fabric-identity",
          IDENTITY,
          "--fabric-space",
          SPACE,
          "--pattern-index-url",
          INDEX_URL,
          "--session-db",
          "none",
          "--pattern-index-publish-discoverable",
        ],
        { CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE: "1" },
        "/console",
      );

      expect(cli.patternIndex).toEqual({ baseUrl: INDEX_URL });
      expect(server.patternIndex).toEqual({
        baseUrl: INDEX_URL,
        publishDiscoverable: true,
      });
      expect(
        (await cliSession([
          "--fabric-api-url",
          API_URL,
          "--fabric-identity",
          IDENTITY,
          "--fabric-space",
          SPACE,
          "--pattern-index-url",
          INDEX_URL,
          "prompt text",
        ])).patternIndex,
      ).toEqual({ baseUrl: INDEX_URL });
    });
  });

  describe("the tool surface a session's backing supports", () => {
    const backing = async (
      args: readonly string[],
    ): Promise<readonly string[]> =>
      harnessSessionChatPolicy(
        await resolveConsoleConfig(
          [
            "--fabric-identity",
            IDENTITY,
            "--fabric-space",
            SPACE,
            "--session-db",
            "none",
            ...args,
          ],
          {},
          "/console",
        ),
      ).allowedToolIds;

    it("withholds the index tools from a session with no index", async () => {
      const allowed = await backing([]);
      expect(allowed).not.toContain("search_patterns");
      expect(allowed).not.toContain("record_feedback");
    });

    it("withholds the skill tools from a session with no registry", async () => {
      const allowed = await backing([]);
      expect(allowed).not.toContain("search_skills");
      expect(allowed).not.toContain("acquire_skill");
    });

    it("offers the fabric tools a configured session always backs", async () => {
      const allowed = await backing([]);
      expect(allowed).toContain("run_pattern");
      expect(allowed).toContain("assign_slug");
    });
  });
});

Deno.test("harnessSessionChatPolicy offers run_skill_script for an exact entry", () => {
  // An entry is as much the operator allowing a script as the switch is, so
  // it offers the tool too; which script may run is decided at the call.
  const base = {
    workspace: "/workspace",
    artifactRoot: "/artifacts",
    maxModelTurns: 8,
    skillsRoot: "/workspace/skills",
    skillNames: [],
    allowedSkillScripts: [],
    skillScriptExecutionTarget: "sandbox",
    handleValueOrigins: [],
    inputCells: [],
    connectorGrants: [],
    patternRefs: [],
    allowedSubagentProfiles: [],
  } as unknown as HarnessSessionConfig;

  expect(harnessSessionChatPolicy(base).allowedToolIds).not.toContain(
    "run_skill_script",
  );
  expect(
    harnessSessionChatPolicy({
      ...base,
      allowedSkillScripts: [{ skill: "cf-tidy", path: "scripts/tidy.sh" }],
    }).allowedToolIds,
  ).toContain("run_skill_script");
  expect(
    harnessSessionChatPolicy({ ...base, allowSkillScripts: true })
      .allowedToolIds,
  ).toContain("run_skill_script");
});
