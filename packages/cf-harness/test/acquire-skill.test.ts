/**
 * The parent-facing external-skill acquisition tool: fail-closed payload
 * refusal, durable handle creation, and pinned-fetch provenance.
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { describe, it } from "@std/testing/bdd";

import { CfHarnessEngine } from "../src/engine.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { resolveHandleToken } from "../src/handle-table.ts";
import {
  SkillsShAcquisitionClient,
  SkillsShAcquisitionError,
} from "../src/skills-sh/acquisition.ts";
import { SkillsShPinResolutionError } from "../src/skills-sh/pin.ts";
import { SkillsShSearchClient } from "../src/skills-sh/search-client.ts";
import { AcquiredSkillDirectoryReadableError } from "../src/skills/acquired-skill-mount.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";
import {
  acquireSkillTool,
  type AcquireSkillToolLoadedOutput,
  type AcquireSkillToolRefusedOutput,
} from "../src/tools/acquire-skill.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import buildgreatTree from "./skills-sh/fixtures/buildgreatproducts-plaid-002ea.tree.json" with {
  type: "json",
};
import membraneTree from "./skills-sh/fixtures/membranedev-application-skills-f484c.tree.json" with {
  type: "json",
};

const RECEIVED_AT = "2026-09-01T12:00:00.000Z";
const MEMBRANE_SHA = "f484c8265e70ec910a57342389cca5c5de7d8167";
const MEMBRANE_ID = "membranedev/application-skills/plaid";
const MEMBRANE_SKILL_URL =
  `https://raw.githubusercontent.com/membranedev/application-skills/${MEMBRANE_SHA}/skills/plaid/SKILL.md`;
const MEMBRANE_SKILL_TEXT =
  "# Pinned Plaid\n\nACQUIRED-CANARY-7db6: instructions only.\n";
const MEMBRANE_DIGEST = "sha256:W1lM6E2qMTIlfoF5sXYj7OEXHjNYJsM8sAhiYlE-wrQ";
const UNVERIFIED_REGISTRY_HASH = "sha256:registry-served-but-unverified";

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: "/workspace",
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = "/workspace"): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }

  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }

  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }

  defaultWorkingDirectory(): string {
    return "/workspace";
  }

  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

const githubFetch = (
  listing: unknown = membraneTree,
  skillText = MEMBRANE_SKILL_TEXT,
): typeof fetch =>
(input) => {
  const url = String(input);
  if (url === "https://api.github.com/repos/membranedev/application-skills") {
    return Promise.resolve(Response.json({ default_branch: "main" }));
  }
  if (
    url ===
      "https://api.github.com/repos/membranedev/application-skills/branches/main"
  ) {
    return Promise.resolve(Response.json({ commit: { sha: MEMBRANE_SHA } }));
  }
  if (
    url ===
      `https://api.github.com/repos/membranedev/application-skills/git/trees/${MEMBRANE_SHA}?recursive=1`
  ) {
    return Promise.resolve(Response.json(listing));
  }
  if (url === MEMBRANE_SKILL_URL) {
    return Promise.resolve(new Response(skillText));
  }
  return Promise.resolve(
    Response.json({ message: "Not Found" }, { status: 404 }),
  );
};

const buildgreatFetch: typeof fetch = (input) => {
  const url = String(input);
  if (url === "https://api.github.com/repos/buildgreatproducts/plaid") {
    return Promise.resolve(Response.json({ default_branch: "main" }));
  }
  if (
    url ===
      "https://api.github.com/repos/buildgreatproducts/plaid/branches/main"
  ) {
    return Promise.resolve(Response.json({
      commit: { sha: "002ea93300572480789719717852dbb7e3107057" },
    }));
  }
  if (
    url ===
      "https://api.github.com/repos/buildgreatproducts/plaid/git/trees/002ea93300572480789719717852dbb7e3107057?recursive=1"
  ) {
    return Promise.resolve(Response.json(buildgreatTree));
  }
  return Promise.resolve(
    Response.json({ message: "Not Found" }, { status: 404 }),
  );
};

const withFabric = async (
  body: (fixture: {
    pieces: PiecesController;
    storageManager: ReturnType<typeof StorageManager.emulate>;
  }) => Promise<void>,
): Promise<void> => {
  const identity = await Identity.fromPassphrase(
    `acquire-skill-${crypto.randomUUID()}`,
  );
  const storageManager = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager,
  });
  const pieces = new PiecesController(
    await createSession({
      identity,
      spaceName: `acquire-skill-${crypto.randomUUID()}`,
    }),
    runtime,
  );
  await pieces.synced();
  try {
    await body({ pieces, storageManager });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

const createEngine = (
  pieces: PiecesController,
  fetch: typeof globalThis.fetch = githubFetch(),
): CfHarnessEngine =>
  new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: `acquire-skill-${crypto.randomUUID()}`,
    now: () => RECEIVED_AT,
    fabricSessionFactory: () => Promise.resolve({ pieces }),
    skillsShSearchClientFactory: () =>
      Promise.resolve(
        new SkillsShSearchClient({
          origin: "https://registry.example",
          fetch: () =>
            Promise.resolve(Response.json({
              skills: [{
                id: MEMBRANE_ID,
                name: "plaid",
                source: "membranedev/application-skills",
                hash: UNVERIFIED_REGISTRY_HASH,
              }],
            })),
        }),
      ),
    skillsShAcquisitionClientFactory: () =>
      Promise.resolve(new SkillsShAcquisitionClient({ fetch })),
  });

const invokeWith = (
  overrides: Partial<HarnessToolContext>,
): ReturnType<typeof acquireSkillTool.invoke> =>
  acquireSkillTool.invoke({
    runId: "acquire-skill-unit",
    now: () => RECEIVED_AT,
    nextOutputId: (toolId: string) =>
      createToolOutputId("acquire-skill-unit", toolId, 1),
    ...overrides,
  } as unknown as HarnessToolContext, { id: MEMBRANE_ID });

const unitPin = {
  id: MEMBRANE_ID,
  owner: "membranedev",
  repo: "application-skills",
  slug: "plaid",
  commitSha: MEMBRANE_SHA,
  resolvedAt: RECEIVED_AT,
};

const unitAcquired = {
  pin: unitPin,
  skillRoot: "skills/plaid",
  sourceUrl: MEMBRANE_SKILL_URL,
  text: MEMBRANE_SKILL_TEXT,
  valueDigest: MEMBRANE_DIGEST,
  loadedPaths: ["SKILL.md"] as const,
};

describe("acquire-skill", () => {
  it("writes exact fetched text behind a handle with fetch provenance", async () => {
    await withFabric(async ({ pieces }) => {
      const engine = createEngine(pieces);
      expect(engine.skillsShAcquisitionClientFactory).toBeDefined();

      const searched = await engine.invokeBuiltinTool("search_skills", {
        query: "plaid",
      });
      expect(JSON.stringify(searched.output)).not.toContain(
        UNVERIFIED_REGISTRY_HASH,
      );
      const result = await engine.invokeBuiltinTool("acquire_skill", {
        id: MEMBRANE_ID,
      });
      const output = result.output as AcquireSkillToolLoadedOutput;

      expect(output).toEqual({
        outputId: output.outputId,
        status: "loaded",
        skillHandle: output.skillHandle,
        pin: {
          id: MEMBRANE_ID,
          owner: "membranedev",
          repo: "application-skills",
          slug: "plaid",
          commitSha: MEMBRANE_SHA,
          resolvedAt: RECEIVED_AT,
        },
        loaded: {
          skillRoot: "skills/plaid",
          paths: ["SKILL.md"],
          sourceUrl: MEMBRANE_SKILL_URL,
          verification: "git-commit-sha",
          valueDigest: MEMBRANE_DIGEST,
          receivedAt: RECEIVED_AT,
        },
      });

      expect(output.skillHandle).toMatch(/^cfh:a:/);
      const entry = resolveHandleToken(engine.handleTable!, output.skillHandle);
      expect(entry?.capability).toBe("skill-context");
      const cell = pieces.runtime.getCellFromLink(
        parseLLMFriendlyLink(entry!.ref, pieces.getSpace()),
      );
      await cell.sync();
      expect(cell.getRaw()).toBe(MEMBRANE_SKILL_TEXT);
      const labelView = cfcLabelViewForCell(cell);
      expect(labelView?.entries).toEqual([{
        path: [],
        label: {
          integrity: [{
            type: CFC_ATOM_TYPE.ExternalIngest,
            kind: "fetch",
            pinnedSource: {
              url: MEMBRANE_SKILL_URL,
              commitSha: MEMBRANE_SHA,
            },
            receivedAt: RECEIVED_AT,
            valueDigest: MEMBRANE_DIGEST,
          }],
        },
      }]);
      const provenance = JSON.stringify(labelView);
      expect(provenance).not.toContain("audience");
      expect(provenance).not.toContain("channel");
      expect(provenance).not.toContain(UNVERIFIED_REGISTRY_HASH);
    });
  });

  it("returns path-refusal metadata without writing a handle", async () => {
    await withFabric(async ({ pieces }) => {
      const engine = createEngine(pieces, buildgreatFetch);

      const result = await engine.invokeBuiltinTool("acquire_skill", {
        id: "buildgreatproducts/plaid/plaid",
      });
      const output = result.output as AcquireSkillToolRefusedOutput;

      expect(output.status).toBe("refused");
      expect(output.reason.code).toBe("instructions_only");
      expect(output.reason.message).toContain("refused 20 paths");
      expect(output.offendingCount).toBe(20);
      expect(output.offendingPaths).toContain("assets/vision-template.json");
      // The skill's own script is admitted now, so it is not what refused this
      // payload; the `references/` and `assets/` trees beside it are.
      expect(output.offendingPaths).not.toContain("scripts/validate-vision.js");
      expect(output).not.toHaveProperty("skillHandle");
    });
  });

  it("requires both external-skill configuration and a fabric session", async () => {
    const base = {
      sandboxRuntime: new FakeSandboxRuntime(),
    };
    const withoutEither = new CfHarnessEngine(base);
    const withoutConfig = new CfHarnessEngine({
      ...base,
      fabricSessionFactory: () => Promise.reject(new Error("unused")),
    });
    const withoutFabric = new CfHarnessEngine({
      ...base,
      skillsShAcquisitionClientFactory: () =>
        Promise.resolve(
          new SkillsShAcquisitionClient({ fetch: githubFetch() }),
        ),
    });

    for (
      const [engine, message] of [
        [
          withoutEither,
          "acquire_skill requires a skills registry; configure --skills-registry-url",
        ],
        [
          withoutConfig,
          "acquire_skill requires a skills registry; configure --skills-registry-url",
        ],
        [
          withoutFabric,
          "acquire_skill requires a configured fabric session",
        ],
      ] as const
    ) {
      const result = await engine.invokeBuiltinTool("acquire_skill", {
        id: MEMBRANE_ID,
      });
      expect(result.output).toMatchObject({ status: "error", message });
    }
  });

  it("requires the capability-typed handle mint at the write boundary", async () => {
    const output = await invokeWith({
      getSkillsShAcquisitionClient: () =>
        Promise.resolve({} as SkillsShAcquisitionClient),
      getFabricSession: () => Promise.reject(new Error("unused")),
    });

    expect(output).toMatchObject({
      status: "error",
      message: "acquire_skill requires the host skill-context handle mint",
    });
  });

  it("returns a named error when the durable write fails", async () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:unit-cell",
        space: "did:key:unit",
        scope: "space",
        path: [],
      }),
      withTx: () => ({ set: () => undefined }),
    };
    const runtime = {
      getCell: () => cell,
      editWithRetry: (write: (tx: object) => void) => {
        write({ markCfcRelevant: () => undefined });
        return Promise.resolve({ error: new Error("write failed") });
      },
    };
    const output = await invokeWith({
      getSkillsShAcquisitionClient: () =>
        Promise.resolve({
          resolvePin: () => Promise.resolve(unitPin),
          acquirePin: () => Promise.resolve(unitAcquired),
        } as unknown as SkillsShAcquisitionClient),
      getFabricSession: () =>
        Promise.resolve({
          pieces: {
            runtime,
            getSpace: () => "did:key:unit",
          },
        } as never),
      mintSkillContextHandle: () => Promise.resolve("cfh:a:unit1"),
    });

    expect(output).toMatchObject({
      status: "error",
      message: "acquire_skill could not write the skill handle: write failed",
    });
  });

  //
  // An acquired skill's scripts, held behind the mount check
  //
  // The scripts are written before the handle is minted, so a refusal here
  // leaves no handle to a skill whose scripts the acquiring run could read.
  //

  const acquiredWithScript = {
    ...unitAcquired,
    loadedPaths: ["SKILL.md", "scripts/report.sh"] as const,
    scripts: [{
      path: "scripts/report.sh",
      bytes: new TextEncoder().encode("#!/usr/bin/env bash\necho acquired\n"),
      valueDigest: "sha256:script",
    }],
  };

  const writingRuntime = () => {
    const cell = {
      getAsNormalizedFullLink: () => ({
        id: "of:unit-cell",
        space: "did:key:unit",
        scope: "space",
        path: [],
      }),
      withTx: () => ({ set: () => undefined }),
    };
    return {
      getCell: () => cell,
      editWithRetry: (write: (tx: object) => void) => {
        write({ markCfcRelevant: () => undefined });
        return Promise.resolve({});
      },
      idle: () => Promise.resolve(),
    };
  };

  const invokeAcquiringScripts = (
    materializeAcquiredSkill: HarnessToolContext["materializeAcquiredSkill"],
  ) =>
    invokeWith({
      getSkillsShAcquisitionClient: () =>
        Promise.resolve({
          resolvePin: () => Promise.resolve(unitPin),
          acquirePin: () => Promise.resolve(acquiredWithScript),
        } as unknown as SkillsShAcquisitionClient),
      getFabricSession: () =>
        Promise.resolve({
          pieces: {
            runtime: writingRuntime(),
            getSpace: () => "did:key:unit",
          },
        } as never),
      mintSkillContextHandle: () => Promise.resolve("cfh:a:unit1"),
      ...(materializeAcquiredSkill !== undefined
        ? { materializeAcquiredSkill }
        : {}),
    });

  it("holds the scripts under the pin before minting the handle", async () => {
    const held: unknown[] = [];
    const output = await invokeAcquiringScripts((options) => {
      held.push(options);
      return Promise.resolve({
        registryId: options.registryId,
        commitSha: options.commitSha,
        pin: `${options.registryId}@${options.commitSha}`,
        hostRoot: "/artifacts/.acquired-skills/run/sha/plaid",
        sandboxRoot: "/acquired-skill",
        scripts: [],
      });
    });

    expect(output.status).toBe("loaded");
    expect(held).toEqual([{
      registryId: MEMBRANE_ID,
      commitSha: MEMBRANE_SHA,
      scripts: [{
        path: "scripts/report.sh",
        bytes: new TextEncoder().encode("#!/usr/bin/env bash\necho acquired\n"),
        valueDigest: "sha256:script",
      }],
    }]);
  });

  it("refuses, naming the mount, when the acquiring run could read the scripts", async () => {
    // A policy answer about who could read the bytes, not a failure to write
    // them, so it is a refusal rather than an error — and there is no handle.
    const output = await invokeAcquiringScripts(() =>
      Promise.reject(
        new AcquiredSkillDirectoryReadableError(
          "the acquired-skills directory is inside this run's workspace mount (/host at /workspace)",
        ),
      )
    );

    expect(output).toMatchObject({
      status: "refused",
      reason: { code: "acquired_scripts_readable_by_acquiring_run" },
      pin: unitPin,
    });
    expect(JSON.stringify(output)).toContain("workspace mount");
    expect(JSON.stringify(output)).not.toContain("skillHandle");
  });

  it("reports a failure to write the scripts as an error, not a refusal", async () => {
    const output = await invokeAcquiringScripts(() =>
      Promise.reject(new Error("no space left on device"))
    );

    expect(output).toMatchObject({
      status: "error",
      message:
        "acquire_skill could not hold this skill's scripts: no space left on device",
    });
  });

  it("refuses a skill with scripts on a run that writes no artifacts", async () => {
    // Instructions without their scripts would be a different skill, so the
    // acquisition does not silently drop them.
    const output = await invokeAcquiringScripts(undefined);

    expect(output).toMatchObject({
      status: "error",
      message:
        "acquire_skill cannot hold this skill's scripts: the run writes no artifacts",
    });
  });

  it("classifies acquisition transport failures as operational errors", async () => {
    const output = await invokeWith({
      getSkillsShAcquisitionClient: () =>
        Promise.resolve({
          resolvePin: () => Promise.resolve(unitPin),
          acquirePin: () =>
            Promise.reject(
              new SkillsShAcquisitionError("http_error", "GitHub answered 503"),
            ),
        } as unknown as SkillsShAcquisitionClient),
      getFabricSession: () => Promise.reject(new Error("unused")),
      mintSkillContextHandle: () => Promise.resolve("cfh:a:unit1"),
    });

    expect(output).toMatchObject({
      status: "error",
      message: "GitHub answered 503",
    });
  });

  it("classifies pin failures without retrying around their reason", async () => {
    const cases = [
      {
        error: new SkillsShPinResolutionError(
          "request_failed",
          "GitHub could not be reached",
        ),
        expected: { status: "error", message: "GitHub could not be reached" },
      },
      {
        error: new SkillsShPinResolutionError("invalid_hit", "invalid id"),
        expected: {
          status: "refused",
          reason: { code: "invalid_hit", message: "invalid id" },
        },
      },
    ] as const;

    for (const { error, expected } of cases) {
      const output = await invokeWith({
        getSkillsShAcquisitionClient: () =>
          Promise.resolve({
            resolvePin: () => Promise.reject(error),
          } as unknown as SkillsShAcquisitionClient),
        getFabricSession: () => Promise.reject(new Error("unused")),
        mintSkillContextHandle: () => Promise.resolve("cfh:a:unit1"),
      });
      expect(output).toMatchObject(expected);
    }
  });

  it("sanitizes an unexpected acquisition failure", async () => {
    const output = await invokeWith({
      getSkillsShAcquisitionClient: () =>
        Promise.reject(new Error("unexpected\u001b]8;;bad\u0007failure")),
      getFabricSession: () => Promise.reject(new Error("unused")),
      mintSkillContextHandle: () => Promise.resolve("cfh:a:unit1"),
    });

    expect(output).toMatchObject({
      status: "error",
      message: "acquire_skill failed: unexpectedfailure",
    });
  });

  it("states the handle, refusal, and no-grant boundaries in its prompt", () => {
    expect(acquireSkillTool.descriptor.effectClass).toBe("write");
    expect(acquireSkillTool.descriptor.description).toContain(
      "parent never receives skill text",
    );
    expect(acquireSkillTool.descriptor.description).toContain(
      "expected outcome",
    );
    expect(acquireSkillTool.descriptor.description).toContain(
      "do not retry around",
    );
    expect(acquireSkillTool.descriptor.description).toContain(
      "grants no permission",
    );
    expect(acquireSkillTool.descriptor.description).toContain("delegate_task");
  });
});
