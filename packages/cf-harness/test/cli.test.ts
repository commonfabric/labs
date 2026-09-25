import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { decodeBase64 } from "@std/encoding/base64";
import { expect } from "@std/expect";
import { join } from "@std/path";

import type { HarnessRunArtifacts } from "../src/artifacts.ts";
import {
  harnessFabricSessionPosture,
  renderCfcPostureReport,
} from "../src/cfc-posture.ts";
import { InMemoryHarnessCredentialStore } from "../src/auth/credential-store.ts";
import {
  buildCfHarnessBaseSystemPrompt,
  buildCfHarnessBatchSystemPrompt,
  buildCfHarnessOperatorSystemPrompt,
  cfHarnessCliInformationalControl,
  type CfHarnessCliIO,
  type CfHarnessCliSignalHandler,
  createCfHarnessBatchResult,
  createCfHarnessCliCapabilities,
  formatCfHarnessCliResult,
  formatCfHarnessCliUsage,
  formatCfHarnessTranscriptEvent,
  installCfHarnessSignalHandlers,
  parseCfHarnessCliArgs,
  resolveCfHarnessCliSystemPrompt,
  runCfHarnessCli,
} from "../src/cli.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import { REVISION_VERIFICATION_GUIDANCE } from "../src/revision-verification.ts";
import type { HarnessModelClient } from "../src/model/client.ts";
import {
  CfHarnessPromptLoop,
  type HarnessPromptLoopResult,
  type RunHarnessPromptOptions,
  type RunHarnessTranscriptOptions,
} from "../src/prompt-loop.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import {
  chatViewOfRequest,
  responsesBodyFromChatFixture,
} from "./support/responses-fixture.ts";

const ONE_PIXEL_PNG = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p94AAAAASUVORK5CYII=",
);

const syntheticTmpProjectPath = (...segments: string[]): string =>
  join(Deno.realPathSync("/tmp"), "project", ...segments);

const createIoBuffers = (): {
  io: CfHarnessCliIO;
  stdout: string[];
  stderr: string[];
} => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
};

const completedCliResult = (
  runId: string,
  finalAssistantText = "Done.",
): HarnessPromptLoopResult => ({
  model: "gpt-5.4",
  finalAssistantText,
  transcript: [
    { role: "user", content: "hello" },
    { role: "assistant", content: finalAssistantText },
  ],
  modelTurns: 1,
  runState: {
    runId,
    status: "completed",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:01.000Z",
    cfcEnforcementMode: "disabled",
    currentDir: "/workspace",
    policyEvents: [],
    toolOutputs: [],
  },
});

Deno.test("parseCfHarnessCliArgs resolves defaults from cwd and positional prompt text", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["Summarize", "this", "workspace"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.workspace, "/tmp/project");
  assertEquals(parsed.prompt, "Summarize this workspace");
  assertEquals(parsed.model, "gpt-5.6-sol");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.outputMode, "operator");
  assertEquals(parsed.streamEvents, false);
  assertEquals(parsed.promptSlotRole, "direct-command");
  assertEquals(parsed.allowedSubagentProfiles, ["default"]);
  assertEquals(parsed.skillNames, []);
  assertEquals(parsed.skillCatalogEnabled, true);
  assertEquals(parsed.artifactRoot, "/tmp/project/.cf-harness-artifacts");
  assertEquals(parsed.maxModelTurns, 8);
  assertEquals(parsed.printTranscript, false);
  assertEquals(parsed.sandboxImage, undefined);
  assertEquals(parsed.imageAttachments, []);
});

Deno.test("parseCfHarnessCliArgs collects every --docs-corpus-root", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--docs-corpus-root",
      "reference/one",
      "--docs-corpus-root",
      "reference/two",
      "Ask",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.docsCorpus, {
    type: "cf-harness.docs-corpus-record",
    source: "configured",
    roots: ["/tmp/project/reference/one", "/tmp/project/reference/two"],
  });
});

Deno.test("parseCfHarnessCliArgs lets --no-docs-corpus override a named root", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--docs-corpus-root", "reference", "--no-docs-corpus", "Ask"],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.docsCorpus, {
    type: "cf-harness.docs-corpus-record",
    source: "configured",
    roots: [],
  });
});

Deno.test("parseCfHarnessCliArgs leaves the corpus unset when no docs flag is given", async () => {
  const parsed = await parseCfHarnessCliArgs(["Ask"], {
    cwd: "/tmp/project",
    env: {},
  });

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.docsCorpus, undefined);
});

Deno.test("parseCfHarnessCliArgs resolves image attachments within the workspace", async () => {
  const workspace = await Deno.makeTempDir();
  const launcherCwd = await Deno.makeTempDir();
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--image",
      "capture.png",
      "--prompt",
      "Describe the image",
    ],
    {
      cwd: launcherCwd,
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.imageAttachments.length, 1);
  assertEquals(
    parsed.imageAttachments[0].hostPath,
    await Deno.realPath(join(workspace, "capture.png")),
  );
  assertEquals(parsed.imageAttachments[0].mediaType, "image/png");
  assertEquals(parsed.imageAttachments[0].bytes, ONE_PIXEL_PNG.byteLength);
  assertEquals(
    parsed.imageAttachments[0].digest.startsWith("sha256:"),
    true,
  );
});

Deno.test("parseCfHarnessCliArgs rejects image attachments outside the workspace", async () => {
  const workspace = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  const outsideImage = join(outside, "capture.png");
  await Deno.writeFile(outsideImage, ONE_PIXEL_PNG);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--image",
          outsideImage,
          "--prompt",
          "Describe the image",
        ],
        {
          cwd: workspace,
          env: {},
        },
      ),
    Error,
    "--image must stay within the workspace or a host mount",
  );
});

Deno.test("parseCfHarnessCliArgs accepts image attachments from a host mount", async () => {
  const workspace = await Deno.makeTempDir();
  const mounted = await Deno.makeTempDir();
  const launcherCwd = await Deno.makeTempDir();
  const imagePath = join(mounted, "capture.png");
  await Deno.writeFile(imagePath, ONE_PIXEL_PNG);

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=file-cabinet,source=${mounted},target=/file-cabinet,mode=readonly`,
      "--image",
      imagePath,
      "--prompt",
      "Describe the image",
    ],
    {
      cwd: launcherCwd,
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.hostMounts, [{
    name: "file-cabinet",
    hostPath: await Deno.realPath(mounted),
    sandboxPath: "/file-cabinet",
    mode: "readonly",
  }]);
  assertEquals(parsed.imageAttachments.length, 1);
  assertEquals(
    parsed.imageAttachments[0].hostPath,
    await Deno.realPath(imagePath),
  );
  assertEquals(parsed.imageAttachments[0].mediaType, "image/png");
});

Deno.test("parseCfHarnessCliArgs rejects image symlinks that resolve outside the workspace", async () => {
  const workspace = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  const outsideImage = join(outside, "capture.png");
  const linkedImage = join(workspace, "linked.png");
  await Deno.writeFile(outsideImage, ONE_PIXEL_PNG);
  await Deno.symlink(outsideImage, linkedImage);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--image",
          linkedImage,
          "--prompt",
          "Describe the image",
        ],
        {
          cwd: workspace,
          env: {},
        },
      ),
    Error,
    "--image must stay within the workspace or a host mount",
  );
});

Deno.test("parseCfHarnessCliArgs rejects image attachments while resuming", async () => {
  const workspace = await Deno.makeTempDir();
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--resume-run",
          "run-state.json",
          "--image",
          "capture.png",
        ],
        {
          cwd: workspace,
          env: {},
        },
      ),
    Error,
    "--image is not supported with --resume-run",
  );
});

Deno.test("parseCfHarnessCliArgs supports prompt files and mode overrides", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      "/tmp/project",
      "--prompt-file",
      "/tmp/prompt.txt",
      "--cfc-enforcement-mode",
      "observe",
      "--max-model-turns",
      "5",
    ],
    {
      env: {},
      readTextFile: (path) => {
        assertEquals(path, "/tmp/prompt.txt");
        return Promise.resolve("Prompt from file.");
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.prompt, "Prompt from file.");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.cfcEnforcementModeOverride, "observe");
  assertEquals(parsed.maxModelTurns, 5);
});

Deno.test("parseCfHarnessCliArgs accepts CFC mode from environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_CFC_ENFORCEMENT_MODE: "enforce-strict" },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.cfcEnforcementModeOverride, "enforce-strict");
});

Deno.test("parseCfHarnessCliArgs parses the three --fabric-* session flags together", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/tmp/project/keys/agent.pkcs8",
    space: "my-space",
  });

  const unset = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in unset) {
    throw new Error("expected config result");
  }
  assertEquals(unset.fabricSession, undefined);
});

Deno.test("parseCfHarnessCliArgs accepts fabric session settings from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_FABRIC_API_URL: "https://toolshed.example/",
        CF_HARNESS_FABRIC_IDENTITY: "/keys/agent.pkcs8",
        CF_HARNESS_FABRIC_SPACE: "did:key:z6MkfExample",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "did:key:z6MkfExample",
  });
});

Deno.test("parseCfHarnessCliArgs rejects a partial fabric session naming the missing flags", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--fabric-space", "my-space"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "missing --fabric-api-url, --fabric-identity",
  );
});

Deno.test("parseCfHarnessCliArgs rejects --allow-tool run_pattern without the fabric session flags", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-tool", "run_pattern"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "missing --fabric-api-url, --fabric-identity, and --fabric-space",
  );
});

Deno.test("parseCfHarnessCliArgs accepts --allow-tool run_pattern alongside the fabric session flags", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "run_pattern",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["run_pattern"]);
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/tmp/project/keys/agent.pkcs8",
    space: "my-space",
  });
});

Deno.test("parseCfHarnessCliArgs rejects a fabric API URL that does not parse", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-api-url",
          "not a url",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--fabric-api-url must be a valid URL",
  );
});

Deno.test("parseCfHarnessCliArgs carries the fabric CFC dials into the session config", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
      "--fabric-cfc-enforcement-mode",
      "enforce-strict",
      "--fabric-cfc-flow-labels",
      "persist",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/tmp/project/keys/agent.pkcs8",
    space: "my-space",
    cfcEnforcementMode: "enforce-strict",
    cfcFlowLabels: "persist",
  });
});

Deno.test("parseCfHarnessCliArgs accepts fabric CFC dials from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_FABRIC_API_URL: "https://toolshed.example/",
        CF_HARNESS_FABRIC_IDENTITY: "/keys/agent.pkcs8",
        CF_HARNESS_FABRIC_SPACE: "my-space",
        CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE: "enforce-explicit",
        CF_HARNESS_FABRIC_CFC_FLOW_LABELS: "observe",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "observe",
  });
});

Deno.test("parseCfHarnessCliArgs rejects a fabric CFC enforcement mode below the preset pin", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-api-url",
          "https://toolshed.example/",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
          "--fabric-cfc-enforcement-mode",
          "observe",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--fabric-cfc-enforcement-mode must be enforce-explicit or enforce-strict",
  );
});

Deno.test("parseCfHarnessCliArgs rejects an unknown fabric CFC flow-labels mode", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-api-url",
          "https://toolshed.example/",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
          "--fabric-cfc-flow-labels",
          "always",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--fabric-cfc-flow-labels must be off, observe, or persist",
  );
});

Deno.test("parseCfHarnessCliArgs carries the fabric CFC posture into the session config", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
      "--fabric-cfc-posture",
      "max-enforcement",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/tmp/project/keys/agent.pkcs8",
    space: "my-space",
    cfcPosture: "max-enforcement",
  });
});

Deno.test("parseCfHarnessCliArgs accepts the fabric CFC posture from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_FABRIC_API_URL: "https://toolshed.example/",
        CF_HARNESS_FABRIC_IDENTITY: "/keys/agent.pkcs8",
        CF_HARNESS_FABRIC_SPACE: "my-space",
        CF_HARNESS_FABRIC_CFC_POSTURE: "max-enforcement",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcPosture: "max-enforcement",
  });
});

Deno.test("parseCfHarnessCliArgs reads the fabric CFC posture from the process environment", async () => {
  // Through the DEFAULT env projection (no injected `deps.env`), the path a
  // real invocation takes: a key missing from that projection reads as unset
  // even when the process environment carries it.
  const names = [
    "CF_HARNESS_FABRIC_API_URL",
    "CF_HARNESS_FABRIC_IDENTITY",
    "CF_HARNESS_FABRIC_SPACE",
    "CF_HARNESS_FABRIC_CFC_POSTURE",
  ] as const;
  const previous = new Map(names.map((name) => [name, Deno.env.get(name)]));
  Deno.env.set("CF_HARNESS_FABRIC_API_URL", "https://toolshed.example/");
  Deno.env.set("CF_HARNESS_FABRIC_IDENTITY", "/keys/agent.pkcs8");
  Deno.env.set("CF_HARNESS_FABRIC_SPACE", "my-space");
  Deno.env.set("CF_HARNESS_FABRIC_CFC_POSTURE", "max-enforcement");
  try {
    const parsed = await parseCfHarnessCliArgs(
      ["--prompt", "hi"],
      { cwd: "/tmp/project" },
    );
    if ("help" in parsed) {
      throw new Error("expected config result");
    }
    assertEquals(parsed.fabricSession?.cfcPosture, "max-enforcement");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("parseCfHarnessCliArgs rejects an unknown fabric CFC posture", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-api-url",
          "https://toolshed.example/",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
          "--fabric-cfc-posture",
          "maximum",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--fabric-cfc-posture must be max-enforcement",
  );
});

Deno.test("parseCfHarnessCliArgs rejects the fabric CFC posture without a fabric session", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-cfc-posture",
          "max-enforcement",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "need --fabric-api-url, --fabric-identity, and --fabric-space",
  );
});

Deno.test("parseCfHarnessCliArgs rejects fabric CFC dials without a fabric session", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-cfc-flow-labels",
          "persist",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "need --fabric-api-url, --fabric-identity, and --fabric-space",
  );
});

const withFabricSession = (...extra: string[]) => [
  "--prompt",
  "hi",
  "--fabric-api-url",
  "https://toolshed.example/",
  "--fabric-identity",
  "keys/agent.pkcs8",
  "--fabric-space",
  "my-space",
  ...extra,
];

Deno.test("parseCfHarnessCliArgs resolves the space database against the working directory", async () => {
  const parsed = await parseCfHarnessCliArgs(
    withFabricSession("--space-db", "cache/memory/space.sqlite"),
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.spaceDbPath, "/tmp/project/cache/memory/space.sqlite");
});

Deno.test("parseCfHarnessCliArgs takes the space database from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(withFabricSession(), {
    cwd: "/tmp/project",
    env: { CF_HARNESS_SPACE_DB: "/srv/toolshed/space.sqlite" },
  });
  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.spaceDbPath, "/srv/toolshed/space.sqlite");
});

Deno.test("parseCfHarnessCliArgs leaves the space database unset when nothing names one", async () => {
  const parsed = await parseCfHarnessCliArgs(withFabricSession(), {
    cwd: "/tmp/project",
    env: {},
  });
  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.spaceDbPath, undefined);
});

Deno.test("parseCfHarnessCliArgs rejects a space database without a fabric session", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--space-db", "space.sqlite"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "needs --fabric-api-url, --fabric-identity, and --fabric-space",
  );
});

Deno.test("parseCfHarnessCliArgs rejects an empty space database value", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(withFabricSession("--space-db", "  "), {
        cwd: "/tmp/project",
        env: {},
      }),
    Error,
    "--space-db requires a non-empty value",
  );
});

Deno.test("parseCfHarnessCliArgs resolves run manifest paths", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--run-manifest", "loom-run.json"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.runManifestPath, "/tmp/project/loom-run.json");
});

Deno.test("parseCfHarnessCliArgs rejects malformed max-model-turns values", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--max-model-turns", "2.5"],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--max-model-turns must be a positive integer",
  );
});

Deno.test("parseCfHarnessCliArgs supports gateway auth mode override", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--gateway-auth-mode", "none"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayAuthMode, "none");
});

Deno.test("parseCfHarnessCliArgs accepts cache and reasoning experiment controls", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--reasoning-effort",
      "low",
      "--prompt-cache-mode",
      "explicit",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.reasoningEffort, "low");
  assertEquals(parsed.promptCacheMode, "explicit");
});

Deno.test("parseCfHarnessCliArgs reads cache and reasoning defaults from the process environment", async () => {
  const names = [
    "CF_HARNESS_REASONING_EFFORT",
    "CF_HARNESS_PROMPT_CACHE_MODE",
  ] as const;
  const previous = new Map(names.map((name) => [name, Deno.env.get(name)]));
  try {
    Deno.env.set("CF_HARNESS_REASONING_EFFORT", "medium");
    Deno.env.set("CF_HARNESS_PROMPT_CACHE_MODE", "implicit");
    const parsed = await parseCfHarnessCliArgs(
      ["--prompt", "hi", "--gateway-auth-mode", "none"],
      { cwd: "/tmp/project" },
    );

    if ("help" in parsed) throw new Error("expected config result");
    assertEquals(parsed.reasoningEffort, "medium");
    assertEquals(parsed.promptCacheMode, "implicit");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("parseCfHarnessCliArgs rejects an empty reasoning effort flag", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--reasoning-effort", "  "],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--reasoning-effort requires a non-empty value",
  );
});

Deno.test("parseCfHarnessCliArgs rejects an empty research reasoning effort flag", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--research-reasoning-effort", "  "],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--research-reasoning-effort requires a non-empty value",
  );
});

Deno.test("parseCfHarnessCliArgs resolves sandbox docker runtime from flag and environment", async () => {
  const fromFlag = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--sandbox-docker-runtime", "runc"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_DOCKER_RUNTIME: "runsc-cfc" },
    },
  );
  if ("help" in fromFlag) {
    throw new Error("expected config result");
  }
  assertEquals(fromFlag.sandboxDockerRuntime, "runc");

  const fromEnv = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_DOCKER_RUNTIME: "runc" },
    },
  );
  if ("help" in fromEnv) {
    throw new Error("expected config result");
  }
  assertEquals(fromEnv.sandboxDockerRuntime, "runc");

  const unset = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in unset) {
    throw new Error("expected config result");
  }
  assertEquals(unset.sandboxDockerRuntime, undefined);

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--sandbox-docker-runtime", "  "],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--sandbox-docker-runtime requires a non-empty runtime name",
  );
});

Deno.test("parseCfHarnessCliArgs resolves gateway config from environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "http://localhost:8080/",
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        CF_HARNESS_MODEL: "gpt-oss-120b",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayBaseUrl, "http://localhost:8080/");
  assertEquals(parsed.gatewayAuthMode, "none");
  assertEquals(parsed.model, "gpt-oss-120b");
});

Deno.test("parseCfHarnessCliArgs prefers gateway flags over environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--gateway-base-url",
      "https://llm.example.test/",
      "--gateway-auth-mode",
      "bearer",
      "--model",
      "gpt-5.5",
    ],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "http://localhost:8080/",
        CF_HARNESS_GATEWAY_AUTH_MODE: "none",
        CF_HARNESS_MODEL: "gpt-oss-120b",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayBaseUrl, "https://llm.example.test/");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.model, "gpt-5.5");
});

Deno.test("parseCfHarnessCliArgs rejects invalid gateway auth mode from environment", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(["--prompt", "hi"], {
        cwd: "/tmp/project",
        env: { CF_HARNESS_GATEWAY_AUTH_MODE: "token" },
      }),
    Error,
    "gateway auth mode must be one of bearer, none",
  );
});

Deno.test("parseCfHarnessCliArgs ignores blank gateway environment values", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_GATEWAY_BASE_URL: "  ",
        CF_HARNESS_GATEWAY_AUTH_MODE: "",
        CF_HARNESS_MODEL: " ",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.gatewayBaseUrl, "https://llm.stage.commontools.dev/");
  assertEquals(parsed.gatewayAuthMode, "bearer");
  assertEquals(parsed.model, "gpt-5.6-sol");
});

Deno.test("parseCfHarnessCliArgs supports batch output mode override", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--output-mode", "batch"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.outputMode, "batch");
});

Deno.test("parseCfHarnessCliArgs supports stream-events flag", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--stream-events"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.streamEvents, true);
});

Deno.test({
  name: "parseCfHarnessCliArgs supports skills root and skill preloads",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-cli-skills-",
    });
    try {
      await Deno.mkdir(join(workspace, "labs", "skills"), {
        recursive: true,
      });
      const parsed = await parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--prompt",
          "hi",
          "--skills-root",
          "labs/skills",
          "--skill",
          "pattern-dev",
          "--skill",
          "pattern-dev",
          "--skill",
          "cf",
          "--no-skill-catalog",
        ],
        {
          cwd: join(workspace, "packages", "cf-harness"),
          env: {},
        },
      );

      if ("help" in parsed) {
        throw new Error("expected config result");
      }
      assertEquals(
        parsed.skillsRoot,
        await Deno.realPath(join(workspace, "labs", "skills")),
      );
      assertEquals(parsed.skillsRootSandboxPath, "/workspace/labs/skills");
      assertEquals(parsed.skillNames, ["pattern-dev", "cf"]);
      assertEquals(parsed.skillCatalogEnabled, false);
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  },
});

Deno.test("parseCfHarnessCliArgs preloads a skill out of the checkout's own skills tree", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--skill", "pattern-dev"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.skillNames, ["pattern-dev"]);
  assertEquals(parsed.skillsRootRecord?.source, "checkout-default");
  assertEquals(parsed.skillsRoot, parsed.skillsRootRecord?.hostPath);
  // The default is read on the host, so it has no sandbox address; a skill
  // script, which needs one, still asks for the flag.
  assertEquals(parsed.skillsRootSandboxPath, undefined);
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--allow-skill-script",
          "pattern-dev:scripts/probe.ts",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--allow-skill-script requires --skills-root",
  );
});

Deno.test("parseCfHarnessCliArgs takes an acquired pin's script without a skills root", async () => {
  // An acquired script is keyed on the pin its bytes were read at, and those
  // bytes reach the sandbox through the acquisition's own mount. Asking for a
  // skills root would make the operator name a tree the skill never came from.
  const pin = `owner/repo/slug@${"d".repeat(40)}`;
  const config = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-skill-script",
      `${pin}:scripts/report.sh`,
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in config) {
    throw new Error("expected config result");
  }
  assertEquals(config.allowedSkillScripts, [{
    skill: pin,
    path: "scripts/report.sh",
  }]);
});

Deno.test("parseCfHarnessCliArgs still asks a registry name for its skills root, beside a pin", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--allow-skill-script",
          `owner/repo/slug@${"d".repeat(40)}:scripts/report.sh`,
          "--allow-skill-script",
          "pattern-dev:scripts/probe.ts",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--allow-skill-script requires --skills-root, except for an acquired pin",
  );
});

Deno.test("parseCfHarnessCliArgs rejects skills root outside workspace", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          "/tmp/project",
          "--prompt",
          "hi",
          "--skills-root",
          "../other/skills",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--skills-root must stay within the workspace",
  );
});

Deno.test({
  name:
    "parseCfHarnessCliArgs rejects skills root symlinks that resolve outside workspace",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-workspace-",
    });
    const outside = await Deno.makeTempDir({
      prefix: "cf-harness-outside-skills-",
    });
    try {
      await Deno.mkdir(join(outside, "pattern-dev"), { recursive: true });
      await Deno.symlink(outside, join(workspace, "skills-link"), {
        type: "dir",
      });

      await assertRejects(
        () =>
          parseCfHarnessCliArgs(
            [
              "--workspace",
              workspace,
              "--prompt",
              "hi",
              "--skills-root",
              "skills-link",
              "--skill",
              "pattern-dev",
            ],
            {
              cwd: workspace,
              env: {},
            },
          ),
        Error,
        "--skills-root must stay within the workspace",
      );
    } finally {
      await Deno.remove(workspace, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});

Deno.test("parseCfHarnessCliArgs rejects skill preloads while resuming", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          "/tmp/project",
          "--resume-run",
          "run-state.json",
          "--skills-root",
          "skills",
          "--skill",
          "pattern-dev",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--skill preloading is not supported with --resume-run",
  );
});

Deno.test("parseCfHarnessCliArgs supports allowed tools and result json path", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "read_file",
      "--allow-tool",
      "view_image",
      "--allow-tool",
      "read_skill_resource",
      "--allow-tool",
      "bash",
      "--result-json-path",
      "results/output.json",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, [
    "read_file",
    "view_image",
    "read_skill_resource",
    "bash",
  ]);
  assertEquals(parsed.allowedSubagentProfiles, []);
  assertEquals(parsed.resultJsonPath, "/tmp/project/results/output.json");
});

Deno.test({
  name:
    "parseCfHarnessCliArgs parses exact skill script allowlists with skills root",
  permissions: { read: true, write: true },
  async fn() {
    const root = await Deno.makeTempDir({
      prefix: "cf-harness-cli-skill-scripts-",
    });
    try {
      await Deno.mkdir(`${root}/skills`, { recursive: true });
      const parsed = await parseCfHarnessCliArgs(
        [
          "--workspace",
          root,
          "--prompt",
          "hi",
          "--skills-root",
          "skills",
          "--skill",
          "deno-memory-profiler",
          "--allow-tool",
          "run_skill_script",
          "--allow-skill-script",
          "deno-memory-profiler:scripts/memory.ts",
          "--allow-skill-script",
          "deno-memory-profiler:scripts/memory.ts",
          "--skill-script-execution-target",
          "host",
        ],
        {
          cwd: root,
          env: {},
        },
      );

      if ("help" in parsed) {
        throw new Error("expected config result");
      }
      assertEquals(parsed.allowedToolIds, ["run_skill_script"]);
      assertEquals(parsed.allowedSkillScripts, [{
        skill: "deno-memory-profiler",
        path: "scripts/memory.ts",
      }]);
      assertEquals(parsed.skillScriptExecutionTarget, "host");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

Deno.test("parseCfHarnessCliArgs rejects invalid skill script execution targets", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--skill-script-execution-target",
          "remote",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "skill script execution target must be one of sandbox, host",
  );
});

Deno.test("parseCfHarnessCliArgs rejects skill script allowlists without a skills root", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--allow-skill-script",
          "pattern-test:scripts/check.ts",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--allow-skill-script requires --skills-root",
  );
});

Deno.test("parseCfHarnessCliArgs supports structured result validation flags", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--structured-result-path",
      "results/capture.results.json",
      "--structured-result-schema-file",
      "schemas/capture.schema.json",
    ],
    {
      cwd: "/tmp/project",
      env: {},
      readTextFile: (path) => {
        assertEquals(path, "/tmp/project/schemas/capture.schema.json");
        return Promise.resolve(
          JSON.stringify({
            type: "object",
            properties: {
              ok: { type: "boolean" },
            },
            required: ["ok"],
            additionalProperties: false,
          }),
        );
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(
    parsed.structuredResult?.path,
    syntheticTmpProjectPath("results", "capture.results.json"),
  );
  assertEquals(
    parsed.structuredResult?.sandboxPath,
    "/workspace/results/capture.results.json",
  );
  assertEquals(parsed.structuredResult?.schema, {
    type: "object",
    properties: {
      ok: { type: "boolean" },
    },
    required: ["ok"],
    additionalProperties: false,
  });
});

Deno.test("parseCfHarnessCliArgs rejects malformed structured result validation flags", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-path",
          "../capture.results.json",
          "--structured-result-schema",
          '{"type":"object"}',
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--structured-result-path must stay within the workspace",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-path",
          "capture.results.json",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--structured-result-path requires --structured-result-schema or --structured-result-schema-file",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-schema",
          '{"type":"object"}',
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--structured-result-schema requires --structured-result-path",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--structured-result-path",
          "capture.results.json",
          "--structured-result-schema",
          '{"type":"object"}',
          "--structured-result-schema-file",
          "schema.json",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "provide only one of --structured-result-schema or --structured-result-schema-file",
  );
});

Deno.test("parseCfHarnessCliArgs rejects submit_result without a structured result target", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-tool", "submit_result"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--allow-tool submit_result requires --structured-result-path and a schema",
  );
});

Deno.test("parseCfHarnessCliArgs supports explicit subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "default",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["delegate_task"]);
  assertEquals(parsed.allowedSubagentProfiles, ["default"]);
});

Deno.test("parseCfHarnessCliArgs supports explicit browser subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "browser",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["delegate_task"]);
  assertEquals(parsed.allowedSubagentProfiles, ["browser"]);
});

Deno.test("parseCfHarnessCliArgs supports a Browser Access lease", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "browser",
      "--browser-access-lease-id",
      "pf-run-1",
      "--browser-access-cdp-url",
      "http://127.0.0.1:9363/",
      "--browser-access-owner",
      "pattern-factory",
      "--browser-access-expires-at",
      "2026-05-29T22:00:00Z",
      "--browser-access-profile-mode",
      "transient",
      "--browser-access-account-access",
      "none",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.browserAccess, {
    type: "cf-harness.chat.browser-access-lease",
    leaseId: "pf-run-1",
    cdpUrl: "http://127.0.0.1:9363",
    owner: "pattern-factory",
    expiresAt: "2026-05-29T22:00:00Z",
    profileMode: "transient",
    accountAccess: "none",
  });
});

Deno.test("parseCfHarnessCliArgs collects handle-value destination origins", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--handle-value-origin",
      "https://example.com",
      "--handle-value-origin",
      "http://localhost:8000",
      "--handle-value-origin",
      "https://example.com",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.handleValueOrigins, [
    "https://example.com",
    "http://localhost:8000",
  ]);
});

Deno.test("parseCfHarnessCliArgs allows no handle-value destination by default", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.handleValueOrigins, []);
});

Deno.test("parseCfHarnessCliArgs rejects a handle-value origin that is not one", async () => {
  for (
    const value of [
      "example.com",
      "https://example.com/login",
      "file:///etc/passwd",
    ]
  ) {
    await assertRejects(
      () =>
        parseCfHarnessCliArgs(
          ["--prompt", "hi", "--handle-value-origin", value],
          { cwd: "/tmp/project", env: {} },
        ),
      Error,
      "--handle-value-origin must be an http(s) origin",
    );
  }
});

Deno.test("parseCfHarnessCliArgs collects operator input cells", async () => {
  const cellRef = `/of:fid1:${"A".repeat(43)}/travellerName`;
  const citiesRef = `/of:fid1:${"B".repeat(43)}/cities`;
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--input-cell",
      `travellerName=${cellRef}`,
      "--input-cell",
      `cities=${citiesRef}`,
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.inputCells, [
    { name: "travellerName", ref: cellRef },
    { name: "cities", ref: citiesRef },
  ]);
});

Deno.test("parseCfHarnessCliArgs passes no input cells by default", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.inputCells, []);
});

Deno.test("parseCfHarnessCliArgs rejects an input cell that does not fit the grammar", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--input-cell", "no-reference-here"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--input-cell must be <name>=<link>",
  );
});

Deno.test("parseCfHarnessCliArgs rejects malformed Browser Access leases", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-lease-id requires a non-empty value",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-cdp-url is required",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "https://example.com:9363",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-cdp-url must be an http:// local origin with an explicit port",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-profile-mode",
          "loggedout",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-profile-mode must be one of: persistent, transient",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-profile-mode",
          "",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-profile-mode must be one of: persistent, transient",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-account-access",
          "",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-account-access must be one of: available, none",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--browser-access-lease-id",
          "pf-run-1",
          "--browser-access-cdp-url",
          "http://127.0.0.1:9363",
          "--browser-access-expires-at",
          "not-a-timestamp",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "--browser-access-expires-at must be a valid timestamp",
  );
});

Deno.test("parseCfHarnessCliArgs supports explicit web_fetch subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "web_fetch",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["delegate_task"]);
  assertEquals(parsed.allowedSubagentProfiles, ["web_fetch"]);
});

Deno.test("parseCfHarnessCliArgs supports explicit web_search subagent profile authorization", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "web_search",
    ],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.allowedToolIds, ["delegate_task"]);
  assertEquals(parsed.allowedSubagentProfiles, ["web_search"]);
});

Deno.test("parseCfHarnessCliArgs covers tool allowlist and subagent profile permutations", async () => {
  const cases = [
    {
      name: "implicit default profile when parent tools are unrestricted",
      flags: [],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "explicit default profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "default"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "explicit browser profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "browser"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["browser"],
    },
    {
      name: "explicit web_fetch profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "web_fetch"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["web_fetch"],
    },
    {
      name: "explicit web_search profile when parent tools are unrestricted",
      flags: ["--allow-subagent-profile", "web_search"],
      allowedToolIds: undefined,
      allowedSubagentProfiles: ["web_search"],
    },
    {
      name: "delegate_task alone does not imply child profile authority",
      flags: ["--allow-tool", "delegate_task"],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: [],
    },
    {
      name: "delegate_task with explicit default profile authority",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "non-delegate parent tools can still preauthorize a profile",
      flags: [
        "--allow-tool",
        "read_file",
        "--allow-tool",
        "bash",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["read_file", "bash"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "duplicate tool and profile flags are normalized",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name:
        "default, browser, web_fetch, and web_search profiles can all be preauthorized",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
        "--allow-subagent-profile",
        "browser",
        "--allow-subagent-profile",
        "web_fetch",
        "--allow-subagent-profile",
        "web_search",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: [
        "default",
        "browser",
        "web_fetch",
        "web_search",
      ],
    },
  ] as const;

  for (const testCase of cases) {
    const parsed = await parseCfHarnessCliArgs(
      ["--prompt", "hi", ...testCase.flags],
      {
        cwd: "/tmp/project",
        env: {},
      },
    );

    if ("help" in parsed) {
      throw new Error(`expected config result for ${testCase.name}`);
    }
    assertEquals(
      parsed.allowedToolIds,
      testCase.allowedToolIds,
      testCase.name,
    );
    assertEquals(
      parsed.allowedSubagentProfiles,
      testCase.allowedSubagentProfiles,
      testCase.name,
    );
  }
});

Deno.test("parseCfHarnessCliArgs rejects unknown subagent profiles", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-subagent-profile", "unknown"],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "allowed subagent profiles must be one or more of default, browser, web_fetch, web_search",
  );
});

Deno.test("parseCfHarnessCliArgs rejects browser as a parent allow-tool", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-tool", "browser"],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "allowed tools must be one or more of bash, read_file, view_image, web_fetch, read_skill_resource, run_skill_script, edit_file, write_file, delegate_task",
  );
});

Deno.test("parseCfHarnessCliArgs rejects unknown allowed tools before resolving profiles", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--allow-tool",
          "agent-browser",
          "--allow-subagent-profile",
          "default",
        ],
        {
          cwd: "/tmp/project",
          env: {},
        },
      ),
    Error,
    "allowed tools must be one or more of bash, read_file, view_image, web_fetch, read_skill_resource, run_skill_script, edit_file, write_file, delegate_task",
  );
});

Deno.test("parseCfHarnessCliArgs resolves focus-root relative to workspace", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      "/tmp/project",
      "--focus-root",
      "packages/cf-harness",
      "--prompt",
      "hi",
    ],
    {
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.focusRoot, "/tmp/project/packages/cf-harness");
});

Deno.test("parseCfHarnessCliArgs resolves an initial cwd within the workspace", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      "/tmp/project",
      "--cwd",
      ".ops",
      "--prompt",
      "hi",
    ],
    {
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.cwd, "/workspace/.ops");
});

Deno.test("parseCfHarnessCliArgs rejects an initial cwd outside the workspace", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          "/tmp/project",
          "--cwd",
          "..",
          "--prompt",
          "hi",
        ],
        {
          env: {},
        },
      ),
    Error,
    "--cwd must stay within the workspace",
  );
});

Deno.test("parseCfHarnessCliArgs supports prompt-slot-role override", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--prompt-slot-role", "context"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.promptSlotRole, "context");
});

Deno.test("parseCfHarnessCliArgs tolerates a leading task-runner separator", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--", "--prompt", "hi", "--gateway-auth-mode", "none"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.prompt, "hi");
  assertEquals(parsed.gatewayAuthMode, "none");
});

Deno.test("parseCfHarnessCliArgs prefers CF_HARNESS_API_KEY over OPENAI_API_KEY", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_API_KEY: "cf-key",
        OPENAI_API_KEY: "openai-key",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.apiKey, "cf-key");
  assertEquals(parsed.apiKeySource, "CF_HARNESS_API_KEY");
});

Deno.test("parseCfHarnessCliArgs supports resume-run inputs without a prompt", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-1"],
    {
      cwd: "/tmp/project",
      env: {},
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(
    parsed.resumeRun,
    "/tmp/project/.cf-harness-artifacts/run-1",
  );
  assertEquals(parsed.prompt, undefined);
  assertEquals(parsed.artifactRoot, "/tmp/project/.cf-harness-artifacts");
  assertEquals(parsed.model, undefined);
});

Deno.test("runCfHarnessCli prints usage for help", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(["--help"], { io });

  assertEquals(exitCode, 0);
  assertEquals(stdout, [formatCfHarnessCliUsage()]);
  assertEquals(stderr, []);
});

Deno.test("cfHarnessCliInformationalControl mirrors global control parsing", () => {
  assertEquals(cfHarnessCliInformationalControl(["--help"]), "help");
  assertEquals(cfHarnessCliInformationalControl(["-h"]), "help");
  assertEquals(
    cfHarnessCliInformationalControl(["--describe-capabilities"]),
    "describe-capabilities",
  );
  assertEquals(
    cfHarnessCliInformationalControl([
      "--describe-capabilities",
      "--help",
    ]),
    "help",
  );
  assertEquals(cfHarnessCliInformationalControl(["--", "--help"]), "help");
  assertEquals(
    cfHarnessCliInformationalControl([
      "--output-mode",
      "batch",
      "--",
      "--help",
    ]),
    undefined,
  );
  assertEquals(
    cfHarnessCliInformationalControl(["config", "inspect", "--help"]),
    undefined,
  );
});

Deno.test("runCfHarnessCli prints machine-readable capabilities", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(["--describe-capabilities"], { io });

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
  const capabilities = JSON.parse(stdout[0]);
  assertEquals(capabilities, createCfHarnessCliCapabilities());
  assertEquals(capabilities.type, "cf-harness.capabilities");
  assertEquals(capabilities.version, 1);
  assertEquals(capabilities.parentToolIds.includes("web_fetch"), true);
  assertEquals(capabilities.parentToolIds.includes("run_pattern"), true);
  assertEquals(capabilities.parentToolIds.includes("browser"), false);
  assertEquals(capabilities.builtinToolIds.includes("run_pattern"), true);
  assertEquals(capabilities.builtinToolIds.includes("search_skills"), true);
  assertEquals(capabilities.builtinToolIds.includes("acquire_skill"), true);
  assertEquals(capabilities.features.runPattern, true);
  assertEquals(capabilities.builtinToolIds.includes("browser"), true);
  assertEquals(capabilities.subagentProfiles.includes("web_search"), true);
  assertEquals(capabilities.nativeModelToolIds.includes("google_search"), true);
  assertEquals(
    capabilities.cliFlags.includes("--structured-result-path"),
    true,
  );
  assertEquals(
    capabilities.cliFlags.includes("--browser-access-cdp-url"),
    true,
  );
  assertEquals(
    capabilities.cliFlags.includes("--browser-access-profile-mode"),
    true,
  );
  assertEquals(capabilities.cliFlags.includes("--describe-capabilities"), true);
  assertEquals(capabilities.repeatableCliFlags.includes("--allow-tool"), true);
  assertEquals(capabilities.features.persistentProviderConfig, true);
  assertEquals(capabilities.features.structuredAuthControl, true);
  assertEquals(capabilities.features.credentialHealth, true);
  assertEquals(capabilities.features.loomLocalOwnerBinding, true);
});

Deno.test("installCfHarnessSignalHandlers terminalizes the active run before exiting", async () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/tmp/project",
    runId: "run-signal",
    now: (() => {
      const timestamps = [
        "2026-04-16T20:00:00.000Z",
        "2026-04-16T20:00:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-16T20:00:02.000Z";
    })(),
  });
  engine.startRun();
  let handler: CfHarnessCliSignalHandler | undefined;
  let disposed = false;
  let exitCode: number | undefined;

  const cleanup = installCfHarnessSignalHandlers(() => engine, {
    registerSignalHandler: (signals, registeredHandler) => {
      assertEquals(signals, ["SIGINT", "SIGTERM"]);
      handler = registeredHandler;
      return () => {
        disposed = true;
      };
    },
    exit: (code) => {
      exitCode = code;
      throw new Error("exit");
    },
  });

  await assertRejects(
    () => Promise.resolve(handler?.("SIGTERM")),
    Error,
    "exit",
  );
  cleanup();

  assertEquals(disposed, true);
  assertEquals(exitCode, 143);
  assertEquals(engine.getRunState().status, "failed");
  assertEquals(engine.getRunState().terminalReason, "process_interrupted");
  assertEquals(engine.getRunState().endedAt, "2026-04-16T20:00:02.000Z");
  assertEquals(
    engine.getRunState().failureRecords?.at(-1)?.detail,
    "process received SIGTERM before the prompt loop completed",
  );
});

Deno.test("runCfHarnessCli registers and disposes signal handlers around a run", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let registeredSignals: readonly string[] = [];
  let disposed = false;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--prompt",
      "hello",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      registerSignalHandler: (signals) => {
        registeredSignals = signals;
        return () => {
          disposed = true;
        };
      },
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Done.",
              transcript: [
                { role: "user", content: "hello" },
                { role: "assistant", content: "Done." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-signal-cleanup",
                status: "completed",
                createdAt: "2026-04-16T20:10:00.000Z",
                updatedAt: "2026-04-16T20:10:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(registeredSignals, ["SIGINT", "SIGTERM"]);
  assertEquals(disposed, true);
  assertEquals(stderr, []);
  assertEquals(stdout, [
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Done.",
      transcript: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "Done." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-signal-cleanup",
        status: "completed",
        createdAt: "2026-04-16T20:10:00.000Z",
        updatedAt: "2026-04-16T20:10:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
});

/** The record a max-enforcement session resolves, as the engine records it. */
const POSTURED_SESSION_RECORD = harnessFabricSessionPosture({
  apiUrl: "https://toolshed.example/",
  identityKeyPath: "/keys/agent.pkcs8",
  space: "my-space",
  cfcPosture: "max-enforcement",
});

Deno.test("runCfHarnessCli prints the fabric-session posture bundle in the operator summary", async () => {
  const { io, stdout } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--prompt",
      "hello",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Done.",
              transcript: [],
              modelTurns: 1,
              runState: {
                runId: "run-postured-summary",
                status: "completed",
                createdAt: "2026-04-16T20:10:00.000Z",
                updatedAt: "2026-04-16T20:10:01.000Z",
                cfcEnforcementMode: "enforce-explicit",
                fabricSessionCfc: {
                  enforcementMode: "enforce-explicit",
                  enforcementModeSource: "preset-pin",
                  flowLabels: "persist",
                  flowLabelsSource: "posture",
                  posture: "max-enforcement",
                  record: POSTURED_SESSION_RECORD,
                },
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  const summary = stdout.join("");
  assertEquals(
    summary.includes(
      "fabricSessionCfc: enforce-explicit (preset-pin), flow-labels persist (posture), posture max-enforcement",
    ),
    true,
  );
  // The two itemized dials say which the operator set; the record under them
  // says what every dial resolved to, which sinks release ungated, and that
  // the record is a projection. A summary carrying only the first reads as a
  // posture without showing one.
  assertEquals(
    summary.includes("provenance"),
    true,
  );
  assertEquals(summary.includes("UNGATED"), true);
  for (
    const line of renderCfcPostureReport(POSTURED_SESSION_RECORD)
  ) {
    assertEquals(summary.includes(line), true);
  }
});

Deno.test("runCfHarnessCli omits the posture record for a run that recorded none", async () => {
  // A run predating the record keeps the two itemized dials and nothing
  // invented under them.
  const { io, stdout } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--prompt",
      "hello",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Done.",
              transcript: [],
              modelTurns: 1,
              runState: {
                runId: "run-legacy-posture-summary",
                status: "completed",
                createdAt: "2026-04-16T20:10:00.000Z",
                updatedAt: "2026-04-16T20:10:01.000Z",
                cfcEnforcementMode: "enforce-explicit",
                fabricSessionCfc: {
                  enforcementMode: "enforce-explicit",
                  enforcementModeSource: "preset-pin",
                  flowLabels: "persist",
                  flowLabelsSource: "posture",
                  posture: "max-enforcement",
                },
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  const summary = stdout.join("");
  assertEquals(summary.includes("fabricSessionCfc: enforce-explicit"), true);
  assertEquals(summary.includes("provenance"), false);
});

Deno.test("runCfHarnessCli executes the prompt loop and prints result metadata", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--focus-root",
      "packages/cf-harness",
      "--prompt",
      "Inspect the workspace",
      "--model",
      "gpt-5.4",
      "--print-transcript",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: (options) => {
            runPromptOptions = options;
            return Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "Inspection complete.",
                transcript: [
                  { role: "user", content: "Inspect the workspace" },
                  { role: "assistant", content: "Inspection complete." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-cli",
                  status: "completed",
                  createdAt: "2026-04-15T22:00:00.000Z",
                  updatedAt: "2026-04-15T22:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli",
                  transcriptPath:
                    "/tmp/project/.cf-harness-artifacts/run-cli/transcript.json",
                  runReportPath:
                    "/tmp/project/.cf-harness-artifacts/run-cli/run-report.json",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            );
          },
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.workspaceHostPath, "/tmp/project");
  assertEquals(
    createdOptions?.artifactRoot,
    "/tmp/project/.cf-harness-artifacts",
  );
  assertEquals(createdOptions?.apiKey, "test-key");
  assertEquals(createdOptions?.apiKeySource, "CF_HARNESS_API_KEY");
  assertEquals(createdOptions?.allowedSubagentProfiles, ["default"]);
  assertEquals(
    runPromptOptions?.systemPrompt,
    buildCfHarnessOperatorSystemPrompt({
      workspace: "/tmp/project",
      focusRoot: "/tmp/project/packages/cf-harness",
      systemPrompt: undefined,
    }),
  );
  assertEquals(runPromptOptions?.promptSlotBinding?.role, "direct-command");
  assertEquals(
    stdout,
    [
      formatCfHarnessCliResult({
        model: "gpt-5.4",
        finalAssistantText: "Inspection complete.",
        transcript: [
          { role: "user", content: "Inspect the workspace" },
          { role: "assistant", content: "Inspection complete." },
        ],
        modelTurns: 1,
        runState: {
          runId: "run-cli",
          status: "completed",
          createdAt: "2026-04-15T22:00:00.000Z",
          updatedAt: "2026-04-15T22:00:01.000Z",
          cfcEnforcementMode: "disabled",
          currentDir: "/workspace",
          artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/run-cli/transcript.json",
          runReportPath:
            "/tmp/project/.cf-harness-artifacts/run-cli/run-report.json",
          policyEvents: [],
          toolOutputs: [],
        },
      }),
      `${
        JSON.stringify(
          [
            { role: "user", content: "Inspect the workspace" },
            { role: "assistant", content: "Inspection complete." },
          ],
          null,
          2,
        )
      }\n`,
    ],
  );
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli announces well-known grants to the model and the operator", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const registrySpace =
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const registryId = `of:fid1:${"D".repeat(43)}`;
  // The grant persists run state, so the workspace must really be writable.
  const workspace = await Deno.makeTempDir();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      workspace,
      "--prompt",
      "List the pieces",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "/keys/agent.pkcs8",
      "--fabric-space",
      "demo-space",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      fabricSessionFactory: () =>
        Promise.resolve(
          {
            pieces: {
              getSpace: () => registrySpace,
              getDefaultPattern: (_runIt: boolean) =>
                Promise.resolve({
                  getMetaRaw: () => undefined,
                  key: (segment: string) => ({
                    getAsNormalizedFullLink: () => ({
                      space: registrySpace,
                      id: registryId,
                      path: [segment],
                    }),
                  }),
                }),
            },
            // deno-lint-ignore no-explicit-any
          } as any,
        ),
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Done.",
              transcript: [],
              modelTurns: 1,
              runState: {
                runId: "run-grants",
                status: "completed",
                createdAt: "2026-04-15T22:00:00.000Z",
                updatedAt: "2026-04-15T22:00:01.000Z",
                cfcEnforcementMode: "enforce-explicit",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
                wellKnownGrants: [{
                  name: "piece-registry",
                  token: "cfh:a:granted1",
                  ref: `/${registryId}/pieceRegistry`,
                }],
              },
            }) satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  const grantMessages = (runPromptOptions?.contextMessages ?? []).filter((
    message,
  ) => message.includes("Granted references"));
  assertEquals(grantMessages.length, 1);
  assertEquals(grantMessages[0]!.includes("cfh:a:"), true);
  assertEquals(grantMessages[0]!.includes(registryId), false);
  assertEquals(
    stdout.join("").includes("fabricGrants: piece-registry cfh:a:granted1"),
    true,
  );
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli announces operator input cells to the model and the operator", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const cellSpace = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const cellId = `of:fid1:${"E".repeat(43)}`;
  const cellRef = `/${cellId}/travellerName`;
  // The input cell persists run state, so the workspace must really be writable.
  const workspace = await Deno.makeTempDir();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      workspace,
      "--prompt",
      "Plan the trip",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "/keys/agent.pkcs8",
      "--fabric-space",
      "demo-space",
      "--input-cell",
      `travellerName=${cellRef}`,
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      fabricSessionFactory: () =>
        Promise.resolve(
          {
            pieces: {
              getSpace: () => cellSpace,
              // This double names no space: the cells here are plain
              // references, which resolve without one.
              getSpaceName: () => undefined,
              getDefaultPattern: (_runIt: boolean) =>
                Promise.resolve(undefined),
            },
            // deno-lint-ignore no-explicit-any
          } as any,
        ),
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Done.",
              transcript: [],
              modelTurns: 1,
              runState: {
                runId: "run-input-cells",
                status: "completed",
                createdAt: "2026-04-15T22:00:00.000Z",
                updatedAt: "2026-04-15T22:00:01.000Z",
                cfcEnforcementMode: "enforce-explicit",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
                inputCells: [{
                  name: "travellerName",
                  token: "cfh:a:cell0001",
                  ref: cellRef,
                }],
              },
            }) satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  const cellMessages = (runPromptOptions?.contextMessages ?? []).filter((
    message,
  ) => message.includes("Input cells"));
  assertEquals(cellMessages.length, 1);
  assertEquals(cellMessages[0]!.includes("travellerName"), true);
  assertEquals(cellMessages[0]!.includes("cfh:a:"), true);
  assertEquals(cellMessages[0]!.includes(cellId), false);
  assertEquals(
    stdout.join("").includes("inputCells: travellerName cfh:a:cell0001"),
    true,
  );
  // The grants failed to resolve (no default pattern), which is said on
  // stderr; the input cells must still be established and announced.
  assertEquals(
    stderr.some((line) => line.includes("fabric grants: unavailable")),
    true,
  );
});

Deno.test("parseCfHarnessCliArgs rejects an input cell alongside --resume-run", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--resume-run",
          "/tmp/project/.cf-harness-artifacts/run-1",
          "--prompt",
          "hi",
          "--input-cell",
          `travellerName=/of:fid1:${"A".repeat(43)}/travellerName`,
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--input-cell is not supported with --resume-run",
  );
});

Deno.test("runCfHarnessCli refuses duplicate input-cell names before any run setup", async () => {
  const { io, stderr } = createIoBuffers();
  const cellRef = `/of:fid1:${"A".repeat(43)}/travellerName`;
  let startupWorkReached = false;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Plan the trip",
      "--input-cell",
      `travellerName=${cellRef}`,
      "--input-cell",
      `travellerName=${cellRef}`,
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      fabricSessionFactory: () => {
        startupWorkReached = true;
        return Promise.reject(new Error("must not be reached"));
      },
      createPromptLoop: () => {
        startupWorkReached = true;
        throw new Error("must not be reached");
      },
    },
  );

  assertEquals(exitCode, 1);
  assertEquals(startupWorkReached, false);
  assertEquals(
    stderr.some((line) =>
      line.includes("--input-cell names `travellerName` twice")
    ),
    true,
  );
});

Deno.test("runCfHarnessCli says so when the well-known grants cannot be established", async () => {
  const { io, stderr } = createIoBuffers();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "List the pieces",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "/keys/agent.pkcs8",
      "--fabric-space",
      "demo-space",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      fabricSessionFactory: () =>
        Promise.reject(new Error("space unauthorized")),
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Done.",
              transcript: [],
              modelTurns: 1,
              runState: {
                runId: "run-no-grants",
                status: "completed",
                createdAt: "2026-04-15T22:00:00.000Z",
                updatedAt: "2026-04-15T22:00:01.000Z",
                cfcEnforcementMode: "enforce-explicit",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(
    (runPromptOptions?.contextMessages ?? []).some((message) =>
      message.includes("Granted references")
    ),
    false,
  );
  assertEquals(
    stderr.some((line) =>
      line.includes("fabric grants: unavailable (space unauthorized)")
    ),
    true,
  );
});

Deno.test("runCfHarnessCli forwards --compact-threshold to a fresh run", async () => {
  // Parsing was already covered; this pins the handoff. The option was
  // forwarded on the resume path only, so a fresh run silently lost it.
  const { io } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--focus-root",
      "packages/cf-harness",
      "--prompt",
      "Inspect the workspace",
      "--model",
      "gpt-5.4",
      "--compact-threshold",
      "12000",
      "--print-transcript",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: () => {
            return Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "Inspection complete.",
                transcript: [
                  { role: "user", content: "Inspect the workspace" },
                  { role: "assistant", content: "Inspection complete." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-cli",
                  status: "completed",
                  createdAt: "2026-04-15T22:00:00.000Z",
                  updatedAt: "2026-04-15T22:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli",
                  transcriptPath:
                    "/tmp/project/.cf-harness-artifacts/run-cli/transcript.json",
                  runReportPath:
                    "/tmp/project/.cf-harness-artifacts/run-cli/run-report.json",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            );
          },
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.compactThreshold, 12_000);
});

Deno.test("runCfHarnessCli reads CF_HARNESS_COMPACT_THRESHOLD from the process environment", async () => {
  // Every other CLI test injects `env`, which bypasses the default projection
  // built from `Deno.env.get` — exactly where this variable was missing:
  // documented and parsed, but never populated in a real run.
  const projected = [
    "CF_HARNESS_COMPACT_THRESHOLD",
    "CF_HARNESS_API_KEY",
    "CF_HARNESS_MODEL",
    "CF_HARNESS_MODEL_PROVIDER",
    "CF_HARNESS_REASONING_EFFORT",
    "CF_HARNESS_PROMPT_CACHE_MODE",
    "CF_HARNESS_GATEWAY_BASE_URL",
    "CF_HARNESS_GATEWAY_AUTH_MODE",
  ];
  const saved = new Map(projected.map((name) => [name, Deno.env.get(name)]));
  for (const name of projected) Deno.env.delete(name);
  Deno.env.set("CF_HARNESS_API_KEY", "test-key");
  Deno.env.set("CF_HARNESS_COMPACT_THRESHOLD", "9000");
  // The projection is what this test is about, and provider selection reads it
  // too: without a projected selection the run is refused before the threshold
  // is ever consulted, on any machine whose harness home configured none.
  Deno.env.set("CF_HARNESS_MODEL_PROVIDER", "openai-compatible-gateway");
  try {
    const { io } = createIoBuffers();
    let createdOptions: Record<string, unknown> | undefined;
    const exitCode = await runCfHarnessCli(
      [
        "--workspace",
        "/tmp/project",
        "--focus-root",
        "packages/cf-harness",
        "--prompt",
        "Inspect the workspace",
        "--model",
        "gpt-5.4",
        "--print-transcript",
      ],
      {
        io,
        createPromptLoop: (options) => {
          createdOptions = options as Record<string, unknown>;
          return {
            runPrompt: () => {
              return Promise.resolve(
                ({
                  model: "gpt-5.4",
                  finalAssistantText: "Inspection complete.",
                  transcript: [
                    { role: "user", content: "Inspect the workspace" },
                    { role: "assistant", content: "Inspection complete." },
                  ],
                  modelTurns: 1,
                  runState: {
                    runId: "run-cli",
                    status: "completed",
                    createdAt: "2026-04-15T22:00:00.000Z",
                    updatedAt: "2026-04-15T22:00:01.000Z",
                    cfcEnforcementMode: "disabled",
                    currentDir: "/workspace",
                    artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli",
                    transcriptPath:
                      "/tmp/project/.cf-harness-artifacts/run-cli/transcript.json",
                    runReportPath:
                      "/tmp/project/.cf-harness-artifacts/run-cli/run-report.json",
                    policyEvents: [],
                    toolOutputs: [],
                  },
                }) satisfies HarnessPromptLoopResult,
              );
            },
            runTranscript: () =>
              Promise.reject(new Error("unexpected resume path")),
          };
        },
      },
    );
    assertEquals(exitCode, 0);
    assertEquals(createdOptions?.compactThreshold, 9_000);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("runCfHarnessCli passes image attachments to the prompt loop", async () => {
  const workspace = await Deno.makeTempDir();
  await Deno.writeFile(join(workspace, "capture.png"), ONE_PIXEL_PNG);
  const { io, stderr } = createIoBuffers();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      workspace,
      "--image",
      "capture.png",
      "--prompt",
      "Describe the image",
    ],
    {
      io,
      cwd: workspace,
      env: { CF_HARNESS_API_KEY: "test-key" },
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Image described.",
              transcript: [
                {
                  role: "user",
                  content: "Describe the image",
                  imageAttachments: options.imageAttachments,
                },
                { role: "assistant", content: "Image described." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-cli-image",
                status: "completed",
                createdAt: "2026-05-05T22:00:00.000Z",
                updatedAt: "2026-05-05T22:00:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(runPromptOptions?.imageAttachments?.length, 1);
  assertEquals(
    runPromptOptions?.imageAttachments?.[0].hostPath,
    await Deno.realPath(join(workspace, "capture.png")),
  );
});

Deno.test("runCfHarnessCli passes tool and subagent profile allowlists", async () => {
  const cases = [
    {
      name: "delegate_task without profile authorization",
      flags: ["--allow-tool", "delegate_task"],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: [],
    },
    {
      name: "delegate_task with explicit profile authorization",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "default",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["default"],
    },
    {
      name: "delegate_task with explicit browser profile authorization",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "browser",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["browser"],
    },
    {
      name: "delegate_task with explicit web_search profile authorization",
      flags: [
        "--allow-tool",
        "delegate_task",
        "--allow-subagent-profile",
        "web_search",
      ],
      allowedToolIds: ["delegate_task"],
      allowedSubagentProfiles: ["web_search"],
    },
  ] as const;

  for (const testCase of cases) {
    const { io, stdout, stderr } = createIoBuffers();
    let createdOptions: Record<string, unknown> | undefined;
    const exitCode = await runCfHarnessCli(
      [
        "--model-provider",
        "openai-compatible-gateway",
        "--workspace",
        "/tmp/project",
        "--prompt",
        `Delegate through ${testCase.name}.`,
        "--gateway-auth-mode",
        "none",
        ...testCase.flags,
      ],
      {
        io,
        env: {},
        createPromptLoop: (options) => {
          createdOptions = options as Record<string, unknown>;
          return {
            runPrompt: () =>
              Promise.resolve(
                {
                  model: "gpt-5.4",
                  finalAssistantText: "Delegation configured.",
                  transcript: [
                    {
                      role: "user",
                      content: `Delegate through ${testCase.name}.`,
                    },
                    { role: "assistant", content: "Delegation configured." },
                  ],
                  modelTurns: 1,
                  runState: {
                    runId: "run-cli-profile-allowlist",
                    status: "completed",
                    createdAt: "2026-04-28T23:35:00.000Z",
                    updatedAt: "2026-04-28T23:35:01.000Z",
                    cfcEnforcementMode: "disabled",
                    currentDir: "/workspace",
                    policyEvents: [],
                    toolOutputs: [],
                  },
                } satisfies HarnessPromptLoopResult,
              ),
            runTranscript: () =>
              Promise.reject(new Error("unexpected resume path")),
          };
        },
      },
    );

    assertEquals(exitCode, 0, testCase.name);
    assertEquals(
      createdOptions?.allowedToolIds,
      testCase.allowedToolIds,
      testCase.name,
    );
    assertEquals(
      createdOptions?.allowedSubagentProfiles,
      testCase.allowedSubagentProfiles,
      testCase.name,
    );
    assertEquals(stdout.length, 1, testCase.name);
    assertEquals(stderr, [], testCase.name);
  }
});

Deno.test("runCfHarnessCli passes Browser Access leases to the prompt loop", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Use browser.",
      "--gateway-auth-mode",
      "none",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "browser",
      "--browser-access-lease-id",
      "pf-run-1",
      "--browser-access-cdp-url",
      "http://localhost:9363",
    ],
    {
      io,
      env: {},
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: () =>
            Promise.resolve(
              {
                model: "gpt-5.4",
                finalAssistantText: "Browser lease configured.",
                transcript: [
                  { role: "user", content: "Use browser." },
                  {
                    role: "assistant",
                    content: "Browser lease configured.",
                  },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-browser-access",
                  status: "completed",
                  createdAt: "2026-05-29T22:00:00.000Z",
                  updatedAt: "2026-05-29T22:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              } satisfies HarnessPromptLoopResult,
            ),
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.browserAccess, {
    type: "cf-harness.chat.browser-access-lease",
    leaseId: "pf-run-1",
    cdpUrl: "http://localhost:9363",
  });
  assertEquals(stdout.length, 1);
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli can override the prompt-slot role for testing", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--prompt-slot-role",
      "context",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            {
              model: "gpt-5.4",
              finalAssistantText: "Inspection complete.",
              transcript: [
                { role: "user", content: "Inspect the workspace" },
                { role: "assistant", content: "Inspection complete." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-cli-context",
                status: "completed",
                createdAt: "2026-04-16T21:10:00.000Z",
                updatedAt: "2026-04-16T21:10:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                artifactRoot:
                  "/tmp/project/.cf-harness-artifacts/run-cli-context",
                transcriptPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-context/transcript.json",
                policyEvents: [],
                toolOutputs: [],
              },
            } satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(runPromptOptions?.promptSlotBinding?.role, "context");
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
});

Deno.test("runCfHarnessCli passes a Loom run manifest and its prompt slot", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const manifest = {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    wishId: "W-519",
    cfc: { enforcementMode: "observe" },
    promptSlot: {
      type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
      source: { type: "loom.wish", wishId: "W-519" },
      role: "context",
      kernelName: "cf-harness",
      surface: "loom",
      subject: "did:web:example.com#gideon",
      slotDigest: "sha256:slot",
    },
  } as const;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--gateway-auth-mode",
      "none",
      "--run-manifest",
      "loom-run.json",
    ],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readTextFile: (path) => {
        assertEquals(path, "/tmp/project/loom-run.json");
        return Promise.resolve(JSON.stringify(manifest));
      },
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: (options) => {
            runPromptOptions = options;
            return Promise.resolve(
              {
                model: "gpt-5.4",
                finalAssistantText: "Manifest accepted.",
                transcript: [
                  { role: "user", content: "Inspect the workspace" },
                  { role: "assistant", content: "Manifest accepted." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-manifest",
                  status: "completed",
                  createdAt: "2026-04-27T21:00:00.000Z",
                  updatedAt: "2026-04-27T21:00:01.000Z",
                  cfcEnforcementMode: "observe",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              } satisfies HarnessPromptLoopResult,
            );
          },
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  const engine = createdOptions?.engine as CfHarnessEngine | undefined;
  assertEquals(exitCode, 0);
  assertEquals(engine?.getRunState().runManifest?.wishId, "W-519");
  assertEquals(engine?.getRunState().cfcEnforcementMode, "observe");
  assertEquals(runPromptOptions?.promptSlotBinding, manifest.promptSlot);
  assertEquals(stderr, []);
  assertEquals(stdout.length, 1);
});

Deno.test("runCfHarnessCli can stream transcript events as they happen", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--stream-events",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: () => ({
        runPrompt: async (options) => {
          await options.onTranscriptEvent?.({
            message: { role: "user", content: "Inspect the workspace" },
            transcript: [{ role: "user", content: "Inspect the workspace" }],
          });
          await options.onTranscriptEvent?.({
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"README.md"}',
                },
              }],
            },
            transcript: [],
          });
          await options.onTranscriptEvent?.({
            message: {
              role: "tool",
              toolCallId: "call-1",
              toolName: "read_file",
              content: '{"outputId":"read-1","content":"hello"}',
            },
            transcript: [],
          });
          await options.onTranscriptEvent?.({
            message: { role: "assistant", content: "Inspection complete." },
            transcript: [],
          });
          return {
            model: "gpt-5.4",
            finalAssistantText: "Inspection complete.",
            transcript: [
              { role: "user", content: "Inspect the workspace" },
              { role: "assistant", content: "Inspection complete." },
            ],
            modelTurns: 1,
            runState: {
              runId: "run-cli-stream",
              status: "completed",
              createdAt: "2026-04-16T22:40:00.000Z",
              updatedAt: "2026-04-16T22:40:01.000Z",
              cfcEnforcementMode: "disabled",
              currentDir: "/workspace",
              policyEvents: [],
              toolOutputs: [],
            },
          } satisfies HarnessPromptLoopResult;
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(stdout, [
    "user: Inspect the workspace\n",
    'assistant -> tools: read_file(path="README.md")\n',
    "tool read_file: outputId=read-1\n",
    "assistant: Inspection complete.\n",
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Inspection complete.",
      transcript: [
        { role: "user", content: "Inspect the workspace" },
        { role: "assistant", content: "Inspection complete." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-cli-stream",
        status: "completed",
        createdAt: "2026-04-16T22:40:00.000Z",
        updatedAt: "2026-04-16T22:40:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
});

Deno.test("runCfHarnessCli uses plain stdout and no operator guidance in batch mode", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Execute the batch task",
      "--output-mode",
      "batch",
      "--system-prompt",
      "You are a Loom batch worker.",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            {
              model: "gpt-5.4",
              finalAssistantText: "Batch result.",
              transcript: [
                { role: "user", content: "Execute the batch task" },
                { role: "assistant", content: "Batch result." },
              ],
              modelTurns: 1,
              runState: {
                runId: "run-cli-batch",
                status: "completed",
                createdAt: "2026-04-16T22:10:00.000Z",
                updatedAt: "2026-04-16T22:10:01.000Z",
                cfcEnforcementMode: "disabled",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            } satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(
    runPromptOptions?.systemPrompt,
    buildCfHarnessBatchSystemPrompt({
      systemPrompt: "You are a Loom batch worker.",
    }),
  );
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli writes a structured batch result sidecar when requested", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const writes: Array<{ path: string; text: string }> = [];
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Execute the batch task",
      "--output-mode",
      "batch",
      "--gateway-auth-mode",
      "none",
      "--result-json-path",
      "/tmp/project/out/result.json",
    ],
    {
      io,
      env: {},
      writeTextFile: (path, text) => {
        writes.push({ path, text });
        return Promise.resolve();
      },
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Batch result.",
              transcript: [
                { role: "user", content: "Execute the batch task" },
                { role: "assistant", content: "Batch result." },
              ],
              modelTurns: 2,
              runState: {
                runId: "run-cli-batch-json",
                status: "completed",
                createdAt: "2026-04-16T23:10:00.000Z",
                updatedAt: "2026-04-16T23:10:02.000Z",
                cfcEnforcementMode: "observe",
                currentDir: "/workspace",
                artifactRoot:
                  "/tmp/project/.cf-harness-artifacts/run-cli-batch-json",
                transcriptPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/transcript.json",
                runReportPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/run-report.json",
                policyEvents: [{
                  type: "cf-harness.policy-event",
                  severity: "denied",
                  mode: "observe",
                  toolId: "write_file",
                  detail:
                    "write_file requires direct-command authorization in enforce-explicit",
                  at: "2026-04-16T23:10:01.000Z",
                }],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, []);
  assertEquals(writes.length, 1);
  assertEquals(writes[0].path, "/tmp/project/out/result.json");
  assertEquals(
    JSON.parse(writes[0].text),
    createCfHarnessBatchResult({
      model: "gpt-5.4",
      finalAssistantText: "Batch result.",
      transcript: [
        { role: "user", content: "Execute the batch task" },
        { role: "assistant", content: "Batch result." },
      ],
      modelTurns: 2,
      runState: {
        runId: "run-cli-batch-json",
        status: "completed",
        createdAt: "2026-04-16T23:10:00.000Z",
        updatedAt: "2026-04-16T23:10:02.000Z",
        cfcEnforcementMode: "observe",
        currentDir: "/workspace",
        artifactRoot: "/tmp/project/.cf-harness-artifacts/run-cli-batch-json",
        transcriptPath:
          "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/transcript.json",
        runReportPath:
          "/tmp/project/.cf-harness-artifacts/run-cli-batch-json/run-report.json",
        policyEvents: [{
          type: "cf-harness.policy-event",
          severity: "denied",
          mode: "observe",
          toolId: "write_file",
          detail:
            "write_file requires direct-command authorization in enforce-explicit",
          at: "2026-04-16T23:10:01.000Z",
        }],
        toolOutputs: [],
      },
    }, JSON.parse(writes[0].text).duration_ms),
  );
});

Deno.test("runCfHarnessCli validates a top-level structured result sidecar", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const writes: Array<{ path: string; text: string }> = [];
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Execute the batch task",
      "--output-mode",
      "batch",
      "--gateway-auth-mode",
      "none",
      "--result-json-path",
      "/tmp/project/out/result.json",
      "--structured-result-path",
      "capture.results.json",
      "--structured-result-schema",
      JSON.stringify({
        type: "object",
        properties: {
          ok: { type: "boolean" },
          status: { type: "string", enum: ["done", "blocked"] },
        },
        required: ["ok", "status"],
        additionalProperties: false,
      }),
    ],
    {
      io,
      env: {},
      readTextFile: (path) => {
        assertEquals(path, syntheticTmpProjectPath("capture.results.json"));
        return Promise.resolve(JSON.stringify({ ok: true, status: "done" }));
      },
      writeTextFile: (path, text) => {
        writes.push({ path, text });
        return Promise.resolve();
      },
      createPromptLoop: () => ({
        runPrompt: (options) => {
          runPromptOptions = options;
          return Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Batch result.",
              transcript: [
                { role: "user", content: "Execute the batch task" },
                { role: "assistant", content: "Batch result." },
              ],
              modelTurns: 2,
              runState: {
                runId: "run-cli-structured-result",
                status: "completed",
                createdAt: "2026-04-16T23:10:00.000Z",
                updatedAt: "2026-04-16T23:10:02.000Z",
                cfcEnforcementMode: "observe",
                currentDir: "/workspace",
                artifactRoot:
                  "/tmp/project/.cf-harness-artifacts/run-cli-structured-result",
                transcriptPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-structured-result/transcript.json",
                runReportPath:
                  "/tmp/project/.cf-harness-artifacts/run-cli-structured-result/run-report.json",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          );
        },
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, []);
  assertEquals(
    runPromptOptions?.systemPrompt?.includes(
      "Writing a JSON file at /workspace/capture.results.json",
    ),
    true,
  );
  assertEquals(
    runPromptOptions?.systemPrompt?.includes("call submit_result"),
    true,
  );
  assertEquals(writes.length, 1);
  assertEquals(writes[0].path, "/tmp/project/out/result.json");
  const batchResult = JSON.parse(writes[0].text);
  assertEquals(batchResult.structured_result.status, "valid");
  assertEquals(
    batchResult.structured_result.result_path,
    syntheticTmpProjectPath("capture.results.json"),
  );
  assertEquals(
    batchResult.structured_result.schema_digest.startsWith("sha256:"),
    true,
  );
});

Deno.test("runCfHarnessCli exits nonzero when top-level structured result is invalid", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const writes: Array<{ path: string; text: string }> = [];
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Execute the batch task",
      "--output-mode",
      "batch",
      "--gateway-auth-mode",
      "none",
      "--result-json-path",
      "/tmp/project/out/result.json",
      "--structured-result-path",
      "capture.results.json",
      "--structured-result-schema",
      JSON.stringify({
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      }),
    ],
    {
      io,
      env: {},
      readTextFile: () =>
        Promise.resolve(JSON.stringify({ ok: true, extra: "not allowed" })),
      writeTextFile: (path, text) => {
        writes.push({ path, text });
        return Promise.resolve();
      },
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(
            ({
              model: "gpt-5.4",
              finalAssistantText: "Batch result.",
              transcript: [
                { role: "user", content: "Execute the batch task" },
                { role: "assistant", content: "Batch result." },
              ],
              modelTurns: 2,
              runState: {
                runId: "run-cli-structured-result-invalid",
                status: "completed",
                createdAt: "2026-04-16T23:10:00.000Z",
                updatedAt: "2026-04-16T23:10:02.000Z",
                cfcEnforcementMode: "observe",
                currentDir: "/workspace",
                policyEvents: [],
                toolOutputs: [],
              },
            }) satisfies HarnessPromptLoopResult,
          ),
        runTranscript: () =>
          Promise.reject(new Error("unexpected resume path")),
      }),
    },
  );

  assertEquals(exitCode, 1);
  assertEquals(stdout, ["Batch result.\n"]);
  assertEquals(stderr, [
    "structured result validation failed: structured result did not match the schema\n",
  ]);
  assertEquals(writes.length, 1);
  const batchResult = JSON.parse(writes[0].text);
  assertEquals(batchResult.structured_result, {
    type: "cf-harness.structured-result-validation",
    status: "invalid",
    schema_digest: batchResult.structured_result.schema_digest,
    result_path: syntheticTmpProjectPath("capture.results.json"),
    validation_error: "structured result did not match the schema",
  });
  assertEquals(
    batchResult.structured_result.schema_digest.startsWith("sha256:"),
    true,
  );
});

Deno.test({
  name:
    "runCfHarnessCli preloads configured skills and persists skill artifacts",
  permissions: { read: true, write: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-cli-skills-",
    });
    try {
      const skillDir = join(workspace, "labs", "skills", "pattern-dev");
      await Deno.mkdir(skillDir, { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: pattern-dev",
          "description: Build Common Fabric patterns",
          "---",
          "",
          "# Pattern Dev",
          "",
          "Read the pattern development guide first.",
        ].join("\n"),
      );
      const { io, stdout, stderr } = createIoBuffers();
      let runPromptOptions: RunHarnessPromptOptions | undefined;
      let engine: CfHarnessEngine | undefined;

      const exitCode = await runCfHarnessCli(
        [
          "--model-provider",
          "openai-compatible-gateway",
          "--workspace",
          workspace,
          "--prompt",
          "Build a pattern",
          "--gateway-auth-mode",
          "none",
          "--skills-root",
          "labs/skills",
          "--skill",
          "pattern-dev",
        ],
        {
          io,
          env: {},
          createPromptLoop: (options) => {
            engine = options.engine;
            return {
              runPrompt: (promptOptions) => {
                runPromptOptions = promptOptions;
                return Promise.resolve(
                  ({
                    model: "gpt-5.4",
                    finalAssistantText: "Done.",
                    transcript: [
                      ...(promptOptions.contextMessages ?? []).map((
                        content,
                      ) => ({ role: "user" as const, content })),
                      { role: "user", content: promptOptions.prompt },
                      { role: "assistant", content: "Done." },
                    ],
                    modelTurns: 1,
                    runState: options.engine!.getRunState(),
                  }) satisfies HarnessPromptLoopResult,
                );
              },
              runTranscript: () =>
                Promise.reject(new Error("unexpected resume path")),
            };
          },
        },
      );

      assertEquals(exitCode, 0);
      assertEquals(stderr, []);
      assertEquals(stdout[0].includes("Done."), true);
      expect(runPromptOptions?.contextMessages).toEqual([
        expect.stringContaining('<skill_context name="pattern-dev"'),
        expect.stringContaining("No input cells are attached for this run"),
        expect.stringContaining("at most one registry read"),
        REVISION_VERIFICATION_GUIDANCE,
      ]);
      assertEquals(
        runPromptOptions?.contextMessages?.[0].includes(
          '<skill_context name="pattern-dev" source="/workspace/labs/skills/pattern-dev/SKILL.md">',
        ),
        true,
      );
      assertEquals(
        runPromptOptions?.systemPrompt?.includes(
          "Configured skills guidance:",
        ),
        true,
      );

      const runState = engine!.getRunState();
      assertEquals(runState.skillRegistry?.skills[0].name, "pattern-dev");
      assertEquals(
        runState.skillActivations?.activations[0].cfcPromptRole,
        "context",
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(runState.skillRegistryPath!)).type,
        "cf-harness.skill-registry",
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(runState.skillActivationsPath!))
          .type,
        "cf-harness.skill-activations",
      );
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "runCfHarnessCli passes host skill script execution target into run_skill_script",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const workspace = await Deno.makeTempDir({
      prefix: "cf-harness-cli-host-skill-script-",
    });
    try {
      const skillDir = join(workspace, "skills", "agent-browser");
      const scriptSource = [
        "#!/bin/bash",
        "set -euo pipefail",
        'echo "target=$CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET"',
        'echo "skill=$SKILL_NAME"',
        'echo "cdp=$AGENT_BROWSER_CDP"',
        'echo "url=$1"',
        "",
      ].join("\n");
      await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
      await Deno.writeTextFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: agent-browser",
          "description: Browser automation",
          "---",
        ].join("\n"),
      );
      await Deno.writeTextFile(
        join(skillDir, "scripts", "capture-workflow.sh"),
        scriptSource,
        { mode: 0o755 },
      );

      const { io, stdout, stderr } = createIoBuffers();
      const fetchCalls: RequestInit[] = [];
      let engine: CfHarnessEngine | undefined;
      const exitCode = await runCfHarnessCli(
        [
          "--model-provider",
          "openai-compatible-gateway",
          "--workspace",
          workspace,
          "--prompt",
          "Run the host skill script.",
          "--gateway-auth-mode",
          "none",
          "--skills-root",
          "skills",
          "--skill",
          "agent-browser",
          "--allow-tool",
          "run_skill_script",
          "--allow-skill-script",
          "agent-browser:scripts/capture-workflow.sh",
          "--skill-script-execution-target",
          "host",
          // Host skill-script execution is outside CFC mediation; this test
          // exercises target threading, not enforcement, so run with CFC off
          // rather than wiring sidecar transports it would never use.
          "--cfc-enforcement-mode",
          "disabled",
          "--browser-access-lease-id",
          "lease-1",
          "--browser-access-cdp-url",
          "http://localhost:9362",
          "--browser-access-owner",
          "test",
          "--browser-access-expires-at",
          "2099-01-01T00:00:00Z",
        ],
        {
          io,
          env: {},
          createPromptLoop: (options) => {
            engine = options.engine;
            return new CfHarnessPromptLoop({
              ...options,
              fetchFn: (_input, init) => {
                fetchCalls.push(init ?? {});
                const payload = fetchCalls.length === 1
                  ? {
                    choices: [{
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "",
                        tool_calls: [{
                          id: "call-host-skill-script",
                          type: "function",
                          function: {
                            name: "run_skill_script",
                            arguments: JSON.stringify({
                              skill: "agent-browser",
                              path: "scripts/capture-workflow.sh",
                              args: ["http://localhost:8000/piece"],
                            }),
                          },
                        }],
                      },
                    }],
                  }
                  : {
                    choices: [{
                      index: 0,
                      message: {
                        role: "assistant",
                        content: "Host skill script completed.",
                      },
                    }],
                  };
                return Promise.resolve(
                  new Response(
                    JSON.stringify(responsesBodyFromChatFixture(payload)),
                    { status: 200 },
                  ),
                );
              },
            });
          },
        },
      );

      assertEquals(exitCode, 0);
      assertEquals(stderr, []);
      assertStringIncludes(stdout[0], "Host skill script completed.");
      assertEquals(fetchCalls.length, 2);

      const secondRequest = JSON.parse(String(fetchCalls[1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const toolMessage = chatViewOfRequest(secondRequest).messages.at(-1);
      assertEquals(toolMessage?.role, "tool");
      const toolOutput = JSON.parse(toolMessage!.content) as {
        status: string;
        executionTarget?: string;
        stdout?: string;
      };
      assertEquals(toolOutput.status, "executed");
      assertEquals(toolOutput.executionTarget, "host");
      assertStringIncludes(toolOutput.stdout ?? "", "target=host\n");
      assertStringIncludes(toolOutput.stdout ?? "", "skill=agent-browser\n");
      // The script sees the lease endpoint through AGENT_BROWSER_CDP, and
      // what it echoes back reaches the model with the endpoint scrubbed.
      assertStringIncludes(
        toolOutput.stdout ?? "",
        "cdp=<lease endpoint>\n",
      );
      assertStringIncludes(
        toolOutput.stdout ?? "",
        "url=http://localhost:8000/piece\n",
      );

      const execution = engine!.getRunState().skillScriptExecutions
        ?.executions[0];
      assertEquals(execution?.executionTarget, "host");
      assertEquals(execution?.status, "executed");
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  },
});

Deno.test("buildCfHarnessOperatorSystemPrompt appends user instructions after guardrails", () => {
  assertEquals(
    buildCfHarnessOperatorSystemPrompt({
      workspace: "/tmp/project",
      focusRoot: "/tmp/project/packages/cf-harness",
      systemPrompt: "Use bash and read_file only. Do not modify files.",
    }),
    [
      buildCfHarnessBaseSystemPrompt(),
      "",
      "Operator guidance for cf-harness runs:",
      "- Prefer exploration within /workspace/packages/cf-harness.",
      "- Start from README files and the package manifest before reading source files.",
      "- Use bash only for narrow discovery; avoid broad workspace scans when a focused path is available.",
      "- Read source files only when needed to answer the prompt accurately.",
      "- Stop once you have enough evidence to answer.",
      "",
      "Additional instructions:",
      "Use bash and read_file only. Do not modify files.",
    ].join("\n"),
  );
});

Deno.test("resolveCfHarnessCliSystemPrompt bypasses operator guidance in batch mode", () => {
  assertEquals(
    resolveCfHarnessCliSystemPrompt({
      workspace: "/tmp/project",
      focusRoot: "/tmp/project/packages/cf-harness",
      systemPrompt: "You are a Loom batch worker.",
      outputMode: "batch",
    }),
    buildCfHarnessBatchSystemPrompt({
      systemPrompt: "You are a Loom batch worker.",
    }),
  );
});

Deno.test("buildCfHarnessBatchSystemPrompt omits submit_result guidance when the tool is not allowed", () => {
  const config = {
    structuredResult: {
      path: "/tmp/project/result.json",
      sandboxPath: "/workspace/result.json",
      schema: { type: "object" } as const,
    },
    allowedToolIds: ["write_file"] as const,
  };
  const prompt = buildCfHarnessBatchSystemPrompt(config);

  assertEquals(prompt.includes("call submit_result"), false);
  assertStringIncludes(
    prompt,
    "Writing a JSON file at /workspace/result.json",
  );
});

Deno.test("resolveCfHarnessCliSystemPrompt honors disabled skill catalog guidance", () => {
  const prompt = resolveCfHarnessCliSystemPrompt({
    workspace: "/tmp/project",
    focusRoot: "/tmp/project/packages/cf-harness",
    outputMode: "operator",
    skillCatalogEnabled: false,
    skillNames: ["pattern-dev"],
  });

  assertEquals(prompt?.includes("Configured skills guidance:"), false);
});

Deno.test("resolveCfHarnessCliSystemPrompt includes enabled skill guidance", () => {
  const prompt = resolveCfHarnessCliSystemPrompt({
    workspace: "/tmp/project",
    focusRoot: "/tmp/project/packages/cf-harness",
    outputMode: "operator",
    skillCatalogEnabled: true,
    skillNames: ["pattern-dev"],
  });

  assertEquals(prompt?.includes("Configured skills guidance:"), true);
});

Deno.test("formatCfHarnessTranscriptEvent formats assistant tool calls and tool results", () => {
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-acquire-1",
          type: "function",
          function: {
            name: "acquire_skill",
            arguments: '{"id":"membranedev/application-skills/plaid"}',
          },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: acquire_skill(id="membranedev/application-skills/plaid")\n',
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-acquire-2",
          type: "function",
          function: { name: "acquire_skill", arguments: '{"id":42}' },
        }],
      },
      transcript: [],
    }),
    "assistant -> tools: acquire_skill\n",
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-skills-1",
          type: "function",
          function: {
            name: "search_skills",
            arguments:
              '{"query":"react native","owner":"vercel-labs","limit":3}',
          },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: search_skills(query="react native" owner="vercel-labs" limit=3)\n',
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: { name: "bash", arguments: '{"command":"ls"}' },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: bash(command="ls")\n',
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-2",
          type: "function",
          function: {
            name: "read_file",
            arguments: '{"path":"/workspace/README.md"}',
          },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: read_file(path="/workspace/README.md")\n',
  );
  // A browser call is summarized by its action and inert selectors; a fill
  // value is what a run would disclose to the page, so it stays out of the
  // operator line.
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-browser-1",
          type: "function",
          function: {
            name: "browser",
            arguments: '{"action":"open","url":"https://example.com/checkout"}',
          },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: browser(action="open" url="https://example.com/checkout")\n',
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-browser-2",
          type: "function",
          function: {
            name: "browser",
            arguments: '{"action":"fill","ref":"@e2","value":"a secret"}',
          },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: browser(action="fill" ref="@e2")\n',
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-browser-3",
          type: "function",
          function: { name: "browser", arguments: "{}" },
        }],
      },
      transcript: [],
    }),
    "assistant -> tools: browser\n",
  );
  // A `describe_handle` call is summarized by the token it asks about, which
  // is what tells a transcript reader which reference the model checked.
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-3",
          type: "function",
          function: {
            name: "describe_handle",
            arguments: '{"token":"cfh:a:abcde"}',
          },
        }],
      },
      transcript: [],
    }),
    'assistant -> tools: describe_handle(token="cfh:a:abcde")\n',
  );
  // A call whose token is not a string has no summary to show, so the tool
  // name stands alone rather than a summary of something unread.
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-4",
          type: "function",
          function: {
            name: "describe_handle",
            arguments: '{"token":42}',
          },
        }],
      },
      transcript: [],
    }),
    "assistant -> tools: describe_handle\n",
  );
  assertEquals(
    formatCfHarnessTranscriptEvent({
      message: {
        role: "tool",
        toolCallId: "call-1",
        toolName: "bash",
        content: '{"detail":"write blocked"}',
      },
      transcript: [],
    }),
    "tool bash: write blocked\n",
  );
});

Deno.test("runCfHarnessCli reports argument errors to stderr", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--prompt", "one", "two"],
    { io, env: {} },
  );

  assertEquals(exitCode, 1);
  assertEquals(stdout, []);
  assertEquals(
    stderr,
    [
      "provide input using only one of --prompt, --prompt-file, positional text, or --resume-run\n",
    ],
  );
});

Deno.test("runCfHarnessCli fails early when no API key is configured", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--model-provider", "openai-compatible-gateway", "--prompt", "hello"],
    { io, env: {} },
  );

  assertEquals(exitCode, 1);
  assertEquals(stdout, []);
  assertEquals(stderr, [
    "no API key configured; set CF_HARNESS_API_KEY or OPENAI_API_KEY\n",
  ]);
});

Deno.test("runCfHarnessCli refuses a run that selected no model provider", async () => {
  // No store is injected, so the run reads the harness home the CLI resolves
  // for itself — the one place an operator's persisted selection would be.
  const home = await Deno.makeTempDir({ prefix: "cf-harness-no-provider-" });
  try {
    const { io, stdout, stderr } = createIoBuffers();
    const exitCode = await runCfHarnessCli(
      ["--prompt", "hello"],
      {
        io,
        env: {
          CF_HARNESS_HOME: home,
          CF_HARNESS_API_KEY: "key-for-a-gateway-nobody-asked-for",
        },
        createModelClient: () => {
          throw new Error("unselected provider must not reach a model client");
        },
      },
    );

    assertEquals(exitCode, 1);
    assertEquals(stdout, []);
    assertEquals(stderr, [
      "No model provider is selected; choose one with --model-provider, " +
      "CF_HARNESS_MODEL_PROVIDER, or `config set`\n",
    ]);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("runCfHarnessCli allows no-auth gateway mode without an API key", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--prompt",
      "hello",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: () =>
            Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "No auth path.",
                transcript: [
                  { role: "user", content: "hello" },
                  { role: "assistant", content: "No auth path." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-no-auth",
                  status: "completed",
                  createdAt: "2026-04-16T00:00:00.000Z",
                  updatedAt: "2026-04-16T00:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            ),
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.gatewayAuthMode, "none");
  assertEquals(createdOptions?.apiKey, undefined);
  assertEquals(stdout, [
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "No auth path.",
      transcript: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "No auth path." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-no-auth",
        status: "completed",
        createdAt: "2026-04-16T00:00:00.000Z",
        updatedAt: "2026-04-16T00:00:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
  assertEquals(stderr, []);
});

Deno.test("runCfHarnessCli can resume from persisted run artifacts", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runTranscriptOptions: RunHarnessTranscriptOptions | undefined;
  const promptSlotBinding = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "loom.run", runId: "run-1" },
    role: "context",
    kernelName: "cf-harness",
    surface: "loom",
    subject: "original-run",
    eventId: "event-original",
  } as const;
  const exitCode = await runCfHarnessCli(
    [
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
      "--allow-tool",
      "delegate_task",
      "--allow-subagent-profile",
      "default",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      // The resume path must forward the same session override a fresh run
      // honors; the assertion below reads it back off the resumed engine.
      fabricSessionFactory: () =>
        Promise.reject(new Error("factory is forwarded, not invoked")),
      readRunArtifacts: (path) => {
        assertEquals(
          path,
          "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
        );
        return Promise.resolve({
          runRoot: "/tmp/project/.cf-harness-artifacts/run-1",
          runStatePath:
            "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
          runState: {
            runId: "run-1",
            status: "failed",
            createdAt: "2026-04-15T22:10:00.000Z",
            updatedAt: "2026-04-15T22:10:01.000Z",
            cfcEnforcementMode: "disabled",
            promptSlotBinding,
            currentDir: "/workspace",
            model: "gpt-5.4",
            artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
            transcriptPath:
              "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
            policyEvents: [],
            toolOutputs: [],
          },
          transcript: [
            { role: "user", content: "Continue." },
          ],
        });
      },
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: () => Promise.reject(new Error("unexpected prompt path")),
          runTranscript: (options) => {
            runTranscriptOptions = options;
            const { transcript, model } = options;
            return Promise.resolve(
              ({
                model: model ?? "gpt-5.4",
                finalAssistantText: "Resumed.",
                transcript: [
                  ...transcript,
                  { role: "assistant", content: "Resumed." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-1",
                  status: "completed",
                  createdAt: "2026-04-15T22:10:00.000Z",
                  updatedAt: "2026-04-15T22:10:02.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  model: "gpt-5.4",
                  artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
                  transcriptPath:
                    "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            );
          },
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(createdOptions?.allowedToolIds, ["delegate_task"]);
  assertEquals(createdOptions?.allowedSubagentProfiles, ["default"]);
  assertEquals(
    (createdOptions?.engine as CfHarnessEngine).fabricSessionAvailable,
    true,
  );
  assertEquals(runTranscriptOptions?.promptSlotBinding, promptSlotBinding);
  assertEquals(stdout, [
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Resumed.",
      transcript: [
        { role: "user", content: "Continue." },
        { role: "assistant", content: "Resumed." },
      ],
      modelTurns: 1,
      runState: {
        runId: "run-1",
        status: "completed",
        createdAt: "2026-04-15T22:10:00.000Z",
        updatedAt: "2026-04-15T22:10:02.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        model: "gpt-5.4",
        artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
        transcriptPath:
          "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
        policyEvents: [],
        toolOutputs: [],
      },
    }),
  ]);
  assertEquals(stderr, []);
});

const resumeHandleRunState = (
  overrides: Record<string, unknown> = {},
) => ({
  runId: "run-1",
  status: "failed",
  createdAt: "2026-04-15T22:10:00.000Z",
  updatedAt: "2026-04-15T22:10:01.000Z",
  cfcEnforcementMode: "disabled",
  currentDir: "/workspace",
  model: "gpt-5.4",
  artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
  transcriptPath: "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
  policyEvents: [],
  toolOutputs: [],
  handleTable: {
    type: "cf-harness.handle-table",
    version: 1,
    salt: "run-1",
    entries: [{
      token: "cfh:a:22222",
      kind: "address",
      ref: `/of:fid1:${"A".repeat(43)}`,
      addressKey: "key-a",
    }],
  },
  ...overrides,
});

const resumeHandleRunArtifacts = (
  runStateOverrides: Record<string, unknown> = {},
) =>
(path: string) => {
  assertEquals(path, "/tmp/project/.cf-harness-artifacts/run-1/run-state.json");
  return Promise.resolve(
    {
      runRoot: "/tmp/project/.cf-harness-artifacts/run-1",
      runStatePath: "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
      transcriptPath:
        "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
      runState: resumeHandleRunState(runStateOverrides),
      transcript: [
        { role: "user", content: "Continue." },
      ],
    } as unknown as HarnessRunArtifacts,
  );
};

Deno.test("runCfHarnessCli resume rehydrates the recorded handle table", async () => {
  const { io, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
    ],
    {
      io,
      env: { CF_HARNESS_API_KEY: "test-key" },
      readRunArtifacts: resumeHandleRunArtifacts(),
      createPromptLoop: (options) => {
        createdOptions = options as unknown as Record<string, unknown>;
        return {
          runPrompt: () => Promise.reject(new Error("unexpected prompt path")),
          runTranscript: () =>
            Promise.resolve(
              {
                model: "gpt-5.4",
                finalAssistantText: "Resumed.",
                transcript: [
                  { role: "user", content: "Continue." },
                  { role: "assistant", content: "Resumed." },
                ],
                modelTurns: 1,
                runState: resumeHandleRunState({
                  status: "completed",
                }) as unknown as HarnessPromptLoopResult["runState"],
              } satisfies HarnessPromptLoopResult,
            ),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  const engine = createdOptions?.engine as CfHarnessEngine;
  assertEquals(engine.handleTable?.entries[0]?.token, "cfh:a:22222");
});

Deno.test("formatCfHarnessCliResult includes policy event summaries", () => {
  const text = formatCfHarnessCliResult({
    model: "gpt-5.4",
    finalAssistantText: "Done.",
    transcript: [],
    modelTurns: 1,
    runState: {
      runId: "run-policy",
      status: "completed",
      createdAt: "2026-04-15T22:20:00.000Z",
      updatedAt: "2026-04-15T22:20:01.000Z",
      cfcEnforcementMode: "observe",
      currentDir: "/workspace",
      policyEvents: [{
        type: "cf-harness.policy-event",
        severity: "warning",
        mode: "observe",
        toolId: "bash",
        detail:
          "bash would require direct-command authorization in enforce modes",
        at: "2026-04-15T22:20:01.000Z",
      }],
      toolOutputs: [],
    },
  });

  assertEquals(
    text,
    [
      "Done.",
      "",
      "runId: run-policy",
      "status: completed",
      "modelTurns: 1",
      "cfcMode: observe (harness)",
      "docsCorpus: none — research cannot consult local documentation",
      "skillsRoot: none — this run scanned no skills tree, so no profile preloads any skill",
      "policyEvents: 1",
      "- warning bash: bash would require direct-command authorization in enforce modes",
      "",
    ].join("\n"),
  );
});

Deno.test("formatCfHarnessCliResult names the skills tree and a docs channel that answered nothing", () => {
  const result = completedCliResult("run-docs-blind");
  result.runState.skillsRoot = {
    type: "cf-harness.skills-root-record",
    source: "checkout-default",
    hostPath: "/checkout/skills",
  };
  result.runState.docsQueryFailures = 3;

  const text = formatCfHarnessCliResult(result);

  assertEquals(
    text.includes("skillsRoot: checkout-default /checkout/skills"),
    true,
  );
  // The model read an error and carried on; the operator has no other place
  // to learn the run's documentation channel was down.
  assertEquals(text.includes("docsQueryFailures: 3"), true);
  assertEquals(text.includes("ended with no answer"), true);
});

Deno.test("formatCfHarnessCliResult summarizes cache usage and cost", () => {
  const result = completedCliResult("run-usage");
  result.usage = {
    inputTokens: 2_000,
    cachedInputTokens: 1_500,
    cacheWriteTokens: 200,
    outputTokens: 100,
    reasoningTokens: 40,
    totalTokens: 2_100,
    costUsd: 0.003456,
    estimatedCostUsd: 0.002345,
  };

  assertStringIncludes(
    formatCfHarnessCliResult(result),
    "usage: input=2000 cachedInput=1500 cacheWrite=200 output=100 " +
      "reasoning=40 total=2100 cacheRead=75.0% providerCostUsd=0.003456 " +
      "estimatedCostUsd=0.002345",
  );
  assertEquals(createCfHarnessBatchResult(result, 50).usage, result.usage);
});

Deno.test("formatCfHarnessCliResult explains why a cost estimate is absent", () => {
  const result = completedCliResult("run-usage-withheld");
  result.usage = {
    inputTokens: 2_000,
    outputTokens: 100,
    totalTokens: 2_100,
    estimateWithheldReason: "missing-cache-detail",
  };

  assertStringIncludes(
    formatCfHarnessCliResult(result),
    "estimateWithheld=missing-cache-detail",
  );
});

Deno.test("formatCfHarnessCliResult returns plain final text in batch mode", () => {
  assertEquals(
    formatCfHarnessCliResult({
      model: "gpt-5.4",
      finalAssistantText: "Batch result.",
      transcript: [],
      modelTurns: 1,
      runState: {
        runId: "run-batch",
        status: "completed",
        createdAt: "2026-04-16T22:30:00.000Z",
        updatedAt: "2026-04-16T22:30:01.000Z",
        cfcEnforcementMode: "disabled",
        currentDir: "/workspace",
        policyEvents: [],
        toolOutputs: [],
      },
    }, "batch"),
    "Batch result.\n",
  );
});

Deno.test("parseCfHarnessCliArgs resolves fabric-mount to an absolute path", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--fabric-mount", "/tmp/cf-fuse"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.fabricMount, "/tmp/cf-fuse");
});

Deno.test("parseCfHarnessCliArgs supports sandbox image flag", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--sandbox-image", "registry.example/cf:deno2"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.sandboxImage, "registry.example/cf:deno2");
});

Deno.test("parseCfHarnessCliArgs supports sandbox image environment default", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_IMAGE: "registry.example/cf:local" },
    },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.sandboxImage, "registry.example/cf:local");
});

Deno.test("parseCfHarnessCliArgs prefers sandbox image flag over environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--sandbox-image", "registry.example/cf:flag"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SANDBOX_IMAGE: "registry.example/cf:env" },
    },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.sandboxImage, "registry.example/cf:flag");
});

Deno.test("parseCfHarnessCliArgs rejects empty sandbox image value", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--sandbox-image", ""],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--sandbox-image requires a non-empty image reference",
  );
});

Deno.test("parseCfHarnessCliArgs omits fabricMount when flag is absent", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.fabricMount, undefined);
});

Deno.test("parseCfHarnessCliArgs resolves relative fabric-mount against cwd", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi", "--fabric-mount", "fuse-dir"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.fabricMount, "/tmp/project/fuse-dir");
});

Deno.test("parseCfHarnessCliArgs rejects empty fabric-mount value", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--fabric-mount", ""],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--fabric-mount requires a non-empty path",
  );
});

Deno.test("parseCfHarnessCliArgs parses explicit host mounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=file-cabinet,source=${mountRoot},target=/file-cabinet,mode=writable`,
      "--cwd",
      mountRoot,
      "--prompt",
      "hi",
    ],
    { cwd: workspace, env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.hostMounts, [{
    name: "file-cabinet",
    hostPath: await Deno.realPath(mountRoot),
    sandboxPath: "/file-cabinet",
    mode: "writable",
  }]);
  assertEquals(parsed.cwd, "/file-cabinet");
});

Deno.test("parseCfHarnessCliArgs rejects structured result paths in readonly host mounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--host-mount",
          `name=docs,source=${mountRoot},target=/docs,mode=readonly`,
          "--structured-result-path",
          join(mountRoot, "result.json"),
          "--structured-result-schema",
          '{"type":"object"}',
          "--prompt",
          "hi",
        ],
        { cwd: workspace, env: {} },
      ),
    Error,
    "--structured-result-path must be inside a writable host mount",
  );
});

Deno.test("parseCfHarnessCliArgs allows structured result paths in writable host mounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=file-cabinet,source=${mountRoot},target=/file-cabinet,mode=writable`,
      "--structured-result-path",
      join(mountRoot, "result.json"),
      "--structured-result-schema",
      '{"type":"object"}',
      "--prompt",
      "hi",
    ],
    { cwd: workspace, env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(
    parsed.structuredResult?.path,
    join(await Deno.realPath(mountRoot), "result.json"),
  );
  assertEquals(
    parsed.structuredResult?.sandboxPath,
    "/file-cabinet/result.json",
  );
});

Deno.test("parseCfHarnessCliArgs uses the most specific overlapping host mount", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();
  const nestedRoot = join(mountRoot, "nested");
  await Deno.mkdir(nestedRoot);

  const parsed = await parseCfHarnessCliArgs(
    [
      "--workspace",
      workspace,
      "--host-mount",
      `name=outer,source=${mountRoot},target=/outer,mode=readonly`,
      "--host-mount",
      `name=inner,source=${nestedRoot},target=/inner,mode=writable`,
      "--structured-result-path",
      join(nestedRoot, "result.json"),
      "--structured-result-schema",
      '{"type":"object"}',
      "--prompt",
      "hi",
    ],
    { cwd: workspace, env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(
    parsed.structuredResult?.path,
    join(await Deno.realPath(nestedRoot), "result.json"),
  );
  assertEquals(parsed.structuredResult?.sandboxPath, "/inner/result.json");
});

Deno.test("parseCfHarnessCliArgs rejects missing paths under symlink parents outside allowed roots", async () => {
  const workspace = await Deno.makeTempDir();
  const outside = await Deno.makeTempDir();
  const linkedOutside = join(workspace, "linked-outside");
  await Deno.symlink(outside, linkedOutside, { type: "dir" });

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--structured-result-path",
          join(linkedOutside, "missing-result.json"),
          "--structured-result-schema",
          '{"type":"object"}',
          "--prompt",
          "hi",
        ],
        { cwd: workspace, env: {} },
      ),
    Error,
    "--structured-result-path must stay within the workspace or a host mount",
  );
});

Deno.test("parseCfHarnessCliArgs rejects invalid host mount specs", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();

  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--workspace",
          workspace,
          "--host-mount",
          `name=bad name,source=${mountRoot},target=/data`,
          "--prompt",
          "hi",
        ],
        { cwd: workspace, env: {} },
      ),
    Error,
    "--host-mount name must start",
  );
});

Deno.test("buildCfHarnessOperatorSystemPrompt includes fabric mount guidance", () => {
  const prompt = buildCfHarnessOperatorSystemPrompt({
    workspace: "/tmp/project",
    systemPrompt: undefined,
    fabricMountPath: "/fabric",
  });
  assertEquals(
    prompt.includes(
      "A Common Fabric space is mounted at /fabric. You may browse its contents for context.",
    ),
    true,
  );
});

Deno.test("buildCfHarnessOperatorSystemPrompt omits fabric guidance without mount", () => {
  const prompt = buildCfHarnessOperatorSystemPrompt({
    workspace: "/tmp/project",
    systemPrompt: undefined,
  });
  assertEquals(prompt.includes("mounted at"), false);
});

Deno.test("buildCfHarnessOperatorSystemPrompt includes host mount guidance", () => {
  const prompt = buildCfHarnessOperatorSystemPrompt({
    workspace: "/tmp/project",
    systemPrompt: undefined,
    hostMounts: [{
      name: "file-cabinet",
      hostPath: "/host/File Cabinet",
      sandboxPath: "/file-cabinet",
      mode: "writable",
    }],
  });

  assertEquals(
    prompt.includes("/file-cabinet: writable (file-cabinet)"),
    true,
  );
});

Deno.test("runCfHarnessCli threads fabric-mount into engine additionalMounts", async () => {
  const { io, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Browse fabric",
      "--fabric-mount",
      "/tmp/cf-fuse",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: (options) => {
            runPromptOptions = options;
            return Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "Done.",
                transcript: [
                  { role: "user", content: "Browse fabric" },
                  { role: "assistant", content: "Done." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-fabric",
                  status: "completed",
                  createdAt: "2026-04-30T00:00:00.000Z",
                  updatedAt: "2026-04-30T00:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            );
          },
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  const engine = createdOptions?.engine as CfHarnessEngine | undefined;
  const mounts = engine?.sandbox.describe().cfc?.mounts;
  assertEquals(mounts?.length, 2);
  assertEquals(mounts?.[1]?.kind, "fabric-fuse");
  assertEquals(mounts?.[1]?.sandboxPath, "/fabric");
  assertEquals(
    runPromptOptions?.systemPrompt?.includes(
      "A Common Fabric space is mounted at /fabric",
    ),
    true,
  );
});

Deno.test("runCfHarnessCli threads host-mount into engine additionalMounts", async () => {
  const workspace = await Deno.makeTempDir();
  const mountRoot = await Deno.makeTempDir();
  const { io, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  let runPromptOptions: RunHarnessPromptOptions | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      workspace,
      "--prompt",
      "Browse mounted files",
      "--host-mount",
      `name=file-cabinet,source=${mountRoot},target=/file-cabinet,mode=writable`,
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: (options) => {
            runPromptOptions = options;
            return Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "Done.",
                transcript: [
                  { role: "user", content: "Browse mounted files" },
                  { role: "assistant", content: "Done." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-host-mount",
                  status: "completed",
                  createdAt: "2026-04-30T00:00:00.000Z",
                  updatedAt: "2026-04-30T00:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            );
          },
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  const engine = createdOptions?.engine as CfHarnessEngine | undefined;
  const mounts = engine?.sandbox.describe().cfc?.mounts;
  assertEquals(mounts?.[1], {
    kind: "host-bind",
    name: "file-cabinet",
    hostPath: await Deno.realPath(mountRoot),
    sandboxPath: "/file-cabinet",
    readOnly: false,
    mode: "writable",
  });
  assertEquals(
    runPromptOptions?.systemPrompt?.includes(
      "/file-cabinet: writable (file-cabinet)",
    ),
    true,
  );
});

Deno.test("runCfHarnessCli threads sandbox-image into engine sandbox config", async () => {
  const { io, stderr } = createIoBuffers();
  let createdOptions: Record<string, unknown> | undefined;
  const exitCode = await runCfHarnessCli(
    [
      "--model-provider",
      "openai-compatible-gateway",
      "--workspace",
      "/tmp/project",
      "--prompt",
      "Inspect the workspace",
      "--sandbox-image",
      "registry.example/cf:deno2",
      "--gateway-auth-mode",
      "none",
    ],
    {
      io,
      env: {},
      createPromptLoop: (options) => {
        createdOptions = options as Record<string, unknown>;
        return {
          runPrompt: () =>
            Promise.resolve(
              ({
                model: "gpt-5.4",
                finalAssistantText: "Done.",
                transcript: [
                  { role: "user", content: "Inspect the workspace" },
                  { role: "assistant", content: "Done." },
                ],
                modelTurns: 1,
                runState: {
                  runId: "run-sandbox-image",
                  status: "completed",
                  createdAt: "2026-05-01T00:00:00.000Z",
                  updatedAt: "2026-05-01T00:00:01.000Z",
                  cfcEnforcementMode: "disabled",
                  currentDir: "/workspace",
                  policyEvents: [],
                  toolOutputs: [],
                },
              }) satisfies HarnessPromptLoopResult,
            ),
          runTranscript: () =>
            Promise.reject(new Error("unexpected resume path")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  const engine = createdOptions?.engine as CfHarnessEngine | undefined;
  assertEquals(
    engine?.sandbox.describe().cfc?.image,
    "registry.example/cf:deno2",
  );
});

Deno.test("runCfHarnessCli routes skills.sh discovery through its injected fetch", async () => {
  const originalFetch = globalThis.fetch;
  let defaultFetchCalls = 0;
  const injectedUrls: string[] = [];
  let toolStatus: string | undefined;
  globalThis.fetch = (() => {
    defaultFetchCalls += 1;
    return Promise.resolve(Response.json({ skills: [] }));
  }) as typeof globalThis.fetch;

  let exitCode: number;
  try {
    exitCode = await runCfHarnessCli(
      [
        "--model-provider",
        "openai-compatible-gateway",
        "--gateway-auth-mode",
        "none",
        "--cfc-enforcement-mode",
        "disabled",
        "--workspace",
        "/tmp/project",
        "--skills-registry-url",
        "https://registry.example",
        "--prompt",
        "Find a skill",
      ],
      {
        env: {},
        fetchFn: (input) => {
          injectedUrls.push(String(input));
          return Promise.resolve(Response.json({ skills: [] }));
        },
        createPromptLoop: (options) => {
          if (options.engine === undefined) {
            throw new Error("expected CLI-created engine");
          }
          const engine = options.engine;
          return {
            runPrompt: async () => {
              const result = await engine.invokeBuiltinTool(
                "search_skills",
                { query: "react native" },
              );
              toolStatus = (result.output as { status?: string }).status;
              return completedCliResult("run-skills-sh-fetch");
            },
            runTranscript: () =>
              Promise.reject(new Error("unexpected resume path")),
          };
        },
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(exitCode, 0);
  assertEquals(defaultFetchCalls, 0);
  assertEquals(injectedUrls, [
    "https://registry.example/api/search?q=react+native&limit=20",
  ]);
  assertEquals(toolStatus, "ok");
});

Deno.test("parseCfHarnessCliArgs selects openai-codex without an API key", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--model-provider", "openai-codex", "--prompt", "hello"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.modelProvider, "openai-codex");
  assertEquals(parsed.apiKey, undefined);
});

Deno.test("parseCfHarnessCliArgs applies explicit provider before environment validation", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--model-provider", "openai-codex", "--prompt", "hello"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_MODEL_PROVIDER: "not-a-provider" },
    },
  );
  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.modelProvider, "openai-codex");
});

Deno.test("parseCfHarnessCliArgs rejects gateway configuration for openai-codex", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--model-provider",
          "openai-codex",
          "--gateway-base-url",
          "https://example.invalid",
          "--prompt",
          "hello",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "gateway URL/auth options cannot be used",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--model-provider", "openai-codex", "--prompt", "hello"],
        {
          cwd: "/tmp/project",
          env: { CF_HARNESS_GATEWAY_AUTH_MODE: "none" },
        },
      ),
    Error,
    "gateway URL/auth options cannot be used",
  );
});

Deno.test("runCfHarnessCli injects the Codex model client into the shared loop", async () => {
  const { io, stderr } = createIoBuffers();
  const client: HarnessModelClient = {
    providerId: "openai-codex",
    complete: () => Promise.reject(new Error("unused fake model client")),
  };
  let loopModelClient: HarnessModelClient | undefined;
  const exitCode = await runCfHarnessCli(
    ["--model-provider", "openai-codex", "--prompt", "hello"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      createModelClient: (options) => {
        assertEquals(options, {
          provider: "openai-codex",
          credentialOwnerKey: "local",
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "local",
          },
          loom: false,
        });
        return client;
      },
      createPromptLoop: (options) => {
        loopModelClient = options.modelClient;
        return {
          runPrompt: () => Promise.resolve(completedCliResult("run-codex")),
          runTranscript: () => Promise.reject(new Error("unexpected resume")),
        };
      },
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(loopModelClient, client);
});

Deno.test("Loom Codex invocation requires an authenticated owner reference", async () => {
  const { io, stderr } = createIoBuffers();
  let modelClients = 0;
  const exitCode = await runCfHarnessCli(
    [
      "--run-manifest",
      "/tmp/loom.json",
      "--prompt",
      "hello",
    ],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-codex",
        })),
      createModelClient: () => {
        modelClients += 1;
        throw new Error("must not resolve credentials");
      },
    },
  );

  assertEquals(exitCode, 1);
  assertEquals(modelClients, 0);
  assertEquals(stderr, [
    "Loom openai-codex runs require an authenticated credential owner reference\n",
  ]);
});

Deno.test("Loom Codex invocation requires an injected owner-bound resolver", async () => {
  const { io, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--run-manifest", "/tmp/loom-owner.json", "--prompt", "hello"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-codex",
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "local",
          },
        })),
    },
  );
  assertEquals(exitCode, 1);
  assertEquals(stderr, [
    "Loom openai-codex runs require an injected owner-bound credential resolver\n",
  ]);
});

Deno.test("Loom Codex invocation preserves two users' owner bindings", async () => {
  const owners: string[] = [];
  for (const ownerKey of ["loom:user-a", "loom:user-b"]) {
    const { io, stderr } = createIoBuffers();
    const exitCode = await runCfHarnessCli(
      ["--run-manifest", `/tmp/${ownerKey}.json`, "--prompt", "hello"],
      {
        io,
        cwd: "/tmp/project",
        env: {},
        readTextFile: () =>
          Promise.resolve(JSON.stringify({
            type: "cf-harness.loom-run-manifest",
            version: 1,
            source: "loom",
            modelProvider: "openai-codex",
            credentialOwner: {
              type: "cf-harness.credential-owner-ref",
              version: 1,
              ownerKey,
            },
          })),
        createModelClient: (options) => {
          assertEquals(options.loom, true);
          owners.push(options.credentialOwnerKey);
          return {
            providerId: "openai-codex",
            credentialOwner: options.credentialOwner,
            complete: () => Promise.reject(new Error("unused")),
          };
        },
        createPromptLoop: () => ({
          runPrompt: () =>
            Promise.resolve(completedCliResult(`run-${ownerKey}`)),
          runTranscript: () => Promise.reject(new Error("unexpected resume")),
        }),
      },
    );
    assertEquals(exitCode, 0);
    assertEquals(stderr, []);
  }
  assertEquals(owners, ["loom:user-a", "loom:user-b"]);
});

Deno.test("Loom Codex client injection preserves the authenticated tenant binding", async () => {
  const { io, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(
    ["--run-manifest", "/tmp/loom-tenant.json", "--prompt", "hello"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-codex",
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "shared-user-key",
            tenantKey: "tenant-a",
          },
        })),
      createModelClient: (options) => {
        assertEquals(options.credentialOwner, {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "shared-user-key",
          tenantKey: "tenant-a",
        });
        return {
          providerId: "openai-codex",
          credentialOwner: options.credentialOwner,
          complete: () => Promise.reject(new Error("unused")),
        };
      },
      createPromptLoop: () => ({
        runPrompt: () => Promise.resolve(completedCliResult("run-tenant")),
        runTranscript: () => Promise.reject(new Error("unexpected resume")),
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
});

Deno.test("local auth status and logout are provider-scoped and secret-free", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access-do-not-print",
    refreshToken: "refresh-do-not-print",
    expiresAt: 4_000_000_000_000,
    accountId: "account-do-not-print",
  });
  const statusIo = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["auth", "status", "openai-codex"], {
      io: statusIo.io,
      env: {},
      credentialStore: store,
    }),
    0,
  );
  assertEquals(statusIo.stdout, ["openai-codex: connected (ready)\n"]);
  assertEquals(JSON.stringify(statusIo).includes("do-not-print"), false);

  const logoutIo = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["auth", "logout", "openai-codex"], {
      io: logoutIo.io,
      env: {},
      credentialStore: store,
    }),
    0,
  );
  assertEquals(await store.get("local", "openai-codex"), undefined);
});

Deno.test("structured config commands expose stable success and failure envelopes", async () => {
  const home = await Deno.makeTempDir();
  const env = { CF_HARNESS_HOME: home };

  const missing = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["config", "inspect", "--json"], {
      io: missing.io,
      env,
    }),
    0,
  );
  assertEquals(JSON.parse(missing.stdout[0]), {
    type: "cf-harness.control-result",
    version: 1,
    ok: true,
    command: "config.inspect",
    result: { state: "missing" },
  });

  const initialized = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(
      ["config", "init", "openai-compatible-gateway", "--json"],
      { io: initialized.io, env },
    ),
    0,
  );
  assertEquals(JSON.parse(initialized.stdout[0]).result, {
    settings: {
      version: 1,
      modelProvider: "openai-compatible-gateway",
    },
    changed: true,
  });
  if (Deno.build.os !== "windows") {
    assertEquals(
      (await Deno.stat(join(home, "config.json"))).mode! & 0o777,
      0o600,
    );
  }

  const persisted = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["config", "inspect", "--json"], {
      io: persisted.io,
      env,
    }),
    0,
  );
  assertEquals(JSON.parse(persisted.stdout[0]).result, {
    state: "configured",
    configuredProvider: "openai-compatible-gateway",
    effectiveProvider: "openai-compatible-gateway",
    effectiveSource: "persistent",
  });

  await Deno.writeTextFile(join(home, "config.json"), "{secret-corruption", {
    mode: 0o600,
  });
  const failed = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(
      ["config", "set", "openai-codex", "--json"],
      { io: failed.io, env },
    ),
    1,
  );
  assertEquals(JSON.parse(failed.stdout[0]), {
    type: "cf-harness.control-result",
    version: 1,
    ok: false,
    command: "config.set",
    error: {
      code: "provider-configuration-required",
      message: "Provider settings are invalid",
    },
  });
  assertEquals(failed.stdout[0].includes("secret-corruption"), false);
});

Deno.test("config inspect reports environment precedence and rejects invalid environment", async () => {
  const home = await Deno.makeTempDir();
  const overridden = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["config", "inspect", "--json"], {
      io: overridden.io,
      env: {
        CF_HARNESS_HOME: home,
        CF_HARNESS_MODEL_PROVIDER: "openai-codex",
      },
    }),
    0,
  );
  assertEquals(JSON.parse(overridden.stdout[0]).result, {
    state: "missing",
    effectiveProvider: "openai-codex",
    effectiveSource: "environment",
  });

  const invalid = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["config", "inspect", "--json"], {
      io: invalid.io,
      env: {
        CF_HARNESS_HOME: home,
        CF_HARNESS_MODEL_PROVIDER: "not-a-provider",
      },
    }),
    1,
  );
  assertEquals(JSON.parse(invalid.stdout[0]).error.code, "invalid-request");
});

Deno.test("structured control usage failures always return one bounded envelope", async () => {
  const cases = [
    ["config", "bogus", "--json"],
    ["config", "inspect", "extra", "--json"],
    ["auth", "status", "bad-provider", "--json"],
    ["auth", "status", "openai-codex", "--unexpected", "--json"],
    ["auth", "logout", "openai-codex", "--device", "--json"],
    ["auth", "login", "openai-codex", "--unexpected", "--json"],
  ];
  for (const argv of cases) {
    const buffers = createIoBuffers();
    assertEquals(
      await runCfHarnessCli(argv, {
        io: buffers.io,
        env: {},
        credentialStore: new InMemoryHarnessCredentialStore(),
      }),
      1,
    );
    assertEquals(buffers.stdout.length, 1);
    const envelope = JSON.parse(buffers.stdout[0]);
    assertEquals(envelope.ok, false);
    assertEquals(envelope.error.code, "invalid-request");
    assertEquals(buffers.stderr, []);
  }
});

Deno.test("config provider validation is structured only when requested", async () => {
  const structured = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["config", "set", "invalid", "--json"], {
      io: structured.io,
      env: {},
    }),
    1,
  );
  assertEquals(
    JSON.parse(structured.stdout[0]).error.code,
    "provider-configuration-required",
  );

  const human = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["config", "set", "invalid"], {
      io: human.io,
      env: {},
    }),
    1,
  );
  assertEquals(human.stdout, []);
  assertStringIncludes(human.stderr[0], "Model provider must be");
});

Deno.test("structured logout success and control failures stay bounded", async () => {
  const successStore = new InMemoryHarnessCredentialStore();
  const success = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(
      ["auth", "logout", "openai-codex", "--json"],
      { io: success.io, env: {}, credentialStore: successStore },
    ),
    0,
  );
  assertEquals(JSON.parse(success.stdout[0]).result.status, "disconnected");

  const failingStore = new InMemoryHarnessCredentialStore();
  failingStore.delete = () => Promise.reject(new Error("secret-delete"));
  const failedLogout = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(
      ["auth", "logout", "openai-codex", "--json"],
      { io: failedLogout.io, env: {}, credentialStore: failingStore },
    ),
    1,
  );
  assertEquals(
    JSON.parse(failedLogout.stdout[0]).error.code,
    "provider-unavailable",
  );
  assertEquals(failedLogout.stdout[0].includes("secret-delete"), false);

  const failedHuman = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["auth", "logout", "openai-codex"], {
      io: failedHuman.io,
      env: {},
      credentialStore: failingStore,
    }),
    1,
  );
  assertStringIncludes(failedHuman.stderr[0], "secret-delete");
});

Deno.test("structured config output redacts corrupt values and unreadable details", async () => {
  const sentinel = "refresh-secret-sentinel";
  for (
    const state of [
      { state: "unsupported-version" as const, version: null },
      { state: "unreadable" as const, detail: sentinel },
    ]
  ) {
    const store = {
      inspect: () => Promise.resolve(state),
      initialize: () => Promise.reject(new Error("unused")),
      set: () => Promise.reject(new Error("unused")),
    };
    const inspect = createIoBuffers();
    assertEquals(
      await runCfHarnessCli(["config", "inspect", "--json"], {
        io: inspect.io,
        env: { CF_HARNESS_MODEL_PROVIDER: "openai-codex" },
        providerSettingsStore: store,
      }),
      1,
    );
    assertEquals(inspect.stdout[0].includes(sentinel), false);
    const inspectResult = JSON.parse(inspect.stdout[0]).result;
    assertEquals(inspectResult.effectiveProvider, "openai-codex");
    assertEquals(inspectResult.effectiveSource, "environment");

    const mutate = createIoBuffers();
    const rejectingStore = {
      ...store,
      set: () =>
        Promise.reject(
          new HarnessControlError(
            "provider-configuration-required",
            state.state === "unreadable"
              ? "Provider settings are unreadable"
              : "Provider settings use an unsupported version",
          ),
        ),
    };
    assertEquals(
      await runCfHarnessCli(
        ["config", "set", "openai-codex", "--json"],
        { io: mutate.io, env: {}, providerSettingsStore: rejectingStore },
      ),
      1,
    );
    assertEquals(mutate.stdout[0].includes(sentinel), false);
  }
});

Deno.test("structured config cancellation is typed and preserves missing state", async () => {
  const home = await Deno.makeTempDir();
  const controller = new AbortController();
  controller.abort(new Error("cancel-secret-sentinel"));
  const buffers = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(
      ["config", "set", "openai-codex", "--json"],
      {
        io: buffers.io,
        env: { CF_HARNESS_HOME: home },
        controlSignal: controller.signal,
      },
    ),
    1,
  );
  assertEquals(JSON.parse(buffers.stdout[0]).error.code, "operation-canceled");
  assertEquals(buffers.stdout[0].includes("cancel-secret-sentinel"), false);
  await assertRejects(
    () => Deno.stat(join(home, "config.json")),
    Deno.errors.NotFound,
  );
});

Deno.test("persisted provider preference selects the direct-run model client", async () => {
  const providerSettingsStore = {
    inspect: () =>
      Promise.resolve({
        state: "configured" as const,
        settings: {
          version: 1 as const,
          modelProvider: "openai-codex" as const,
        },
      }),
    initialize: () => Promise.reject(new Error("unused")),
    set: () => Promise.reject(new Error("unused")),
  };
  let selectedProvider: string | undefined;
  const buffers = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["--prompt", "hello"], {
      io: buffers.io,
      cwd: "/tmp/project",
      env: {},
      providerSettingsStore,
      createModelClient: (options) => {
        selectedProvider = options.provider;
        return {
          providerId: "openai-codex",
          complete: () => Promise.reject(new Error("unused")),
        };
      },
      createPromptLoop: () => ({
        runPrompt: () =>
          Promise.resolve(completedCliResult("persisted-provider")),
        runTranscript: () => Promise.reject(new Error("unexpected resume")),
      }),
    }),
    0,
  );
  assertEquals(selectedProvider, "openai-codex");
});

Deno.test("human config and auth controls preserve operator output", async () => {
  const providerSettingsStore = {
    inspect: () => Promise.resolve({ state: "missing" as const }),
    initialize: () =>
      Promise.resolve({
        settings: {
          version: 1 as const,
          modelProvider: "openai-compatible-gateway" as const,
        },
        changed: true,
      }),
    set: () =>
      Promise.resolve({
        settings: {
          version: 1 as const,
          modelProvider: "openai-codex" as const,
        },
        changed: false,
      }),
  };
  for (
    const [argv, expected] of [
      [["config", "inspect"], '"state": "missing"'],
      [["config", "init", "openai-compatible-gateway"], "(saved)"],
      [["config", "set", "openai-codex"], "(unchanged)"],
    ] as const
  ) {
    const buffers = createIoBuffers();
    assertEquals(
      await runCfHarnessCli(argv, {
        io: buffers.io,
        env: {},
        providerSettingsStore,
      }),
      0,
    );
    assertStringIncludes(buffers.stdout[0], expected);
  }

  const store = new InMemoryHarnessCredentialStore();
  await store.set("local", "openai-codex", {
    type: "oauth",
    providerId: "openai-codex",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 0,
    accountId: "account",
  });
  const expired = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["auth", "status", "openai-codex"], {
      io: expired.io,
      env: {},
      credentialStore: store,
    }),
    0,
  );
  assertEquals(expired.stdout, [
    "openai-codex: connected (refresh required)\n",
  ]);
  const logout = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["auth", "logout", "openai-codex"], {
      io: logout.io,
      env: {},
      credentialStore: store,
    }),
    0,
  );
  assertEquals(logout.stdout, ["openai-codex: disconnected\n"]);
});

Deno.test("structured auth status exposes bounded health without credential fields", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.updateRecord("local", "openai-codex", () => ({
    credential: {
      type: "oauth",
      providerId: "openai-codex",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 0,
      accountId: "account-secret",
    },
    health: { status: "reconnect-required", reason: "invalid-grant" },
  }));
  const { io, stdout } = createIoBuffers();

  assertEquals(
    await runCfHarnessCli(["auth", "status", "openai-codex", "--json"], {
      io,
      env: {},
      credentialStore: store,
    }),
    1,
  );
  assertEquals(JSON.parse(stdout[0]), {
    type: "cf-harness.control-result",
    version: 1,
    ok: true,
    command: "auth.status",
    result: {
      providerId: "openai-codex",
      status: "reconnect-required",
      refreshHealth: "reconnect-required",
      reason: "invalid-grant",
    },
  });
  assertEquals(stdout[0].includes("secret"), false);
  assertEquals(stdout[0].includes("expiresAt"), false);
});

Deno.test("structured browser login emits JSON events and a bounded result", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const { io, stdout } = createIoBuffers();

  assertEquals(
    await runCfHarnessCli(["auth", "login", "openai-codex", "--json"], {
      io,
      env: {},
      credentialStore: store,
      openUrl: () => {},
      loginOpenAICodex: async (options) => {
        await options.onAuthorizationUrl("https://auth.example/authorize");
        const credential = {
          type: "oauth" as const,
          providerId: "openai-codex" as const,
          accessToken: "access-secret",
          refreshToken: "refresh-secret",
          expiresAt: 4_000_000_000_000,
          accountId: "account-secret",
        };
        await options.authService.save(credential);
        return credential;
      },
    }),
    0,
  );
  assertEquals(JSON.parse(stdout[0]), {
    type: "cf-harness.control-event",
    version: 1,
    command: "auth.login",
    event: "authorization-required",
    data: {
      method: "browser",
      url: "https://auth.example/authorize",
    },
  });
  assertEquals(JSON.parse(stdout[1]), {
    type: "cf-harness.control-result",
    version: 1,
    ok: true,
    command: "auth.login",
    result: {
      providerId: "openai-codex",
      status: "connected",
      refreshHealth: "ready",
    },
  });
  assertEquals(JSON.stringify(stdout).includes("secret"), false);
});

Deno.test("structured login cancellation preserves prior auth and provider state", async () => {
  const store = new InMemoryHarnessCredentialStore();
  const previous = {
    type: "oauth" as const,
    providerId: "openai-codex" as const,
    accessToken: "previous-access",
    refreshToken: "previous-refresh",
    expiresAt: 4_000_000_000_000,
    accountId: "previous-account",
  };
  await store.set("local", "openai-codex", previous);
  const controller = new AbortController();
  controller.abort(new DOMException("cancel-secret", "AbortError"));
  const { io, stdout } = createIoBuffers();

  assertEquals(
    await runCfHarnessCli(["auth", "login", "openai-codex", "--json"], {
      io,
      env: {},
      credentialStore: store,
      controlSignal: controller.signal,
    }),
    1,
  );
  assertEquals(JSON.parse(stdout[0]), {
    type: "cf-harness.control-result",
    version: 1,
    ok: false,
    command: "auth.login",
    error: {
      code: "operation-canceled",
      message: "The cf-harness control operation was canceled",
    },
  });
  assertEquals(await store.get("local", "openai-codex"), previous);
  assertEquals(stdout[0].includes("cancel-secret"), false);
});

Deno.test("structured auth failures discard secret-bearing cause graphs", async () => {
  const store = new InMemoryHarnessCredentialStore();
  store.getRecord = () => Promise.reject(new Error("storage-secret-sentinel"));
  const { io, stdout } = createIoBuffers();

  assertEquals(
    await runCfHarnessCli(["auth", "status", "openai-codex", "--json"], {
      io,
      env: {},
      credentialStore: store,
    }),
    1,
  );
  const result = JSON.parse(stdout[0]);
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "provider-unavailable");
  assertEquals(stdout[0].includes("storage-secret-sentinel"), false);
});

Deno.test("models openai-codex reports live provider order", async () => {
  const { io, stdout, stderr } = createIoBuffers();
  const exitCode = await runCfHarnessCli(["models", "openai-codex"], {
    io,
    cwd: "/tmp/project",
    env: {},
    createModelClient: () => ({
      providerId: "openai-codex",
      complete: () => Promise.reject(new Error("unused")),
      listModels: () =>
        Promise.resolve([{
          id: "model-b",
          displayName: "Model B",
          inputModalities: ["text"],
          supportedReasoningEfforts: ["high"],
          supportsParallelToolCalls: true,
        }, {
          id: "model-a",
          displayName: "Model A",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
          supportsParallelToolCalls: false,
        }]),
    }),
  });

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(JSON.parse(stdout[0]).map((model: { id: string }) => model.id), [
    "model-b",
    "model-a",
  ]);
});

Deno.test("resume preserves the recorded Codex provider and continuation", async () => {
  const transcript = [{ role: "user" as const, content: "Continue" }, {
    role: "assistant" as const,
    content: "Working",
    providerContinuation: {
      providerId: "openai-codex",
      // Legacy artifact shape: `responseId` is no longer recorded, and this
      // keeps a run persisted before that change resumable.
      state: { responseId: "resp-retained", output: [] },
    },
  }];
  const readRunArtifacts = () =>
    Promise.resolve({
      runRoot: "/tmp/project/.cf-harness-artifacts/run-codex-resume",
      runStatePath:
        "/tmp/project/.cf-harness-artifacts/run-codex-resume/run-state.json",
      transcriptPath:
        "/tmp/project/.cf-harness-artifacts/run-codex-resume/transcript.json",
      runState: {
        runId: "run-codex-resume",
        status: "failed" as const,
        createdAt: "2026-07-22T12:00:00.000Z",
        updatedAt: "2026-07-22T12:00:01.000Z",
        cfcEnforcementMode: "disabled" as const,
        currentDir: "/workspace",
        model: "gpt-5.4",
        modelProvider: "openai-codex" as const,
        credentialOwnerKey: "local",
        policyEvents: [],
        toolOutputs: [],
      },
      transcript,
    });
  const { io, stderr } = createIoBuffers();
  let resumedTranscript: readonly unknown[] | undefined;
  const exitCode = await runCfHarnessCli(
    ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-codex-resume"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readRunArtifacts,
      createModelClient: (options) => {
        assertEquals(options.provider, "openai-codex");
        assertEquals(options.credentialOwnerKey, "local");
        return {
          providerId: "openai-codex",
          complete: () => Promise.reject(new Error("unused")),
        };
      },
      createPromptLoop: () => ({
        runPrompt: () => Promise.reject(new Error("unexpected prompt")),
        runTranscript: (options) => {
          resumedTranscript = options.transcript;
          return Promise.resolve(completedCliResult("run-codex-resume"));
        },
      }),
    },
  );

  assertEquals(exitCode, 0);
  assertEquals(stderr, []);
  assertEquals(resumedTranscript, transcript);

  const mismatchIo = createIoBuffers();
  assertEquals(
    await runCfHarnessCli([
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-codex-resume",
      "--model-provider",
      "openai-compatible-gateway",
    ], {
      io: mismatchIo.io,
      cwd: "/tmp/project",
      env: { CF_HARNESS_API_KEY: "gateway-key" },
      readRunArtifacts,
    }),
    1,
  );
  assertEquals(mismatchIo.stderr, [
    "resume provider mismatch: run uses openai-codex, requested openai-compatible-gateway\n",
  ]);
});

Deno.test("CLI resume keeps the corpus the run recorded and refuses a differing one", async () => {
  const transcript = [{ role: "user" as const, content: "Ask" }];
  const readRunArtifacts = () =>
    Promise.resolve({
      runRoot: "/tmp/project/.cf-harness-artifacts/run-docs-resume",
      runStatePath:
        "/tmp/project/.cf-harness-artifacts/run-docs-resume/run-state.json",
      transcriptPath:
        "/tmp/project/.cf-harness-artifacts/run-docs-resume/transcript.json",
      runState: {
        runId: "run-docs-resume",
        status: "failed" as const,
        createdAt: "2026-09-04T12:00:00.000Z",
        updatedAt: "2026-09-04T12:00:01.000Z",
        cfcEnforcementMode: "disabled" as const,
        currentDir: "/workspace",
        model: "gpt-5.4",
        modelProvider: "openai-compatible-gateway" as const,
        docsCorpus: {
          type: "cf-harness.docs-corpus-record" as const,
          source: "configured" as const,
          roots: ["/tmp/project/recorded-reference"],
        },
        policyEvents: [],
        toolOutputs: [],
      },
      transcript,
    });

  const { io, stderr } = createIoBuffers();
  let resumedCorpus: unknown;
  assertEquals(
    await runCfHarnessCli(
      ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-docs-resume"],
      {
        io,
        cwd: "/tmp/project",
        env: { CF_HARNESS_API_KEY: "gateway-key" },
        readRunArtifacts,
        createPromptLoop: (options) => {
          resumedCorpus = options.engine?.docsCorpus;
          return {
            runPrompt: () => Promise.reject(new Error("unexpected prompt")),
            runTranscript: () =>
              Promise.resolve(completedCliResult("run-docs-resume")),
          };
        },
      },
    ),
    0,
  );
  assertEquals(stderr, []);
  assertEquals(resumedCorpus, {
    type: "cf-harness.docs-corpus-record",
    source: "configured",
    roots: ["/tmp/project/recorded-reference"],
  });

  const mismatchIo = createIoBuffers();
  assertEquals(
    await runCfHarnessCli([
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-docs-resume",
      "--docs-corpus-root",
      "other-reference",
    ], {
      io: mismatchIo.io,
      cwd: "/tmp/project",
      env: { CF_HARNESS_API_KEY: "gateway-key" },
      readRunArtifacts,
    }),
    1,
  );
  assertEquals(mismatchIo.stderr, [
    "resume docs corpus mismatch: run uses configured /tmp/project/recorded-reference, requested configured /tmp/project/other-reference\n",
  ]);
});

Deno.test("CLI resume keeps the CFC enforcement mode the run recorded and refuses a differing one", async () => {
  const transcript = [{ role: "user" as const, content: "Ask" }];
  const readRunArtifacts = () =>
    Promise.resolve({
      runRoot: "/tmp/project/.cf-harness-artifacts/run-cfc-resume",
      runStatePath:
        "/tmp/project/.cf-harness-artifacts/run-cfc-resume/run-state.json",
      transcriptPath:
        "/tmp/project/.cf-harness-artifacts/run-cfc-resume/transcript.json",
      runState: {
        runId: "run-cfc-resume",
        status: "failed" as const,
        createdAt: "2026-09-04T12:00:00.000Z",
        updatedAt: "2026-09-04T12:00:01.000Z",
        cfcEnforcementMode: "observe" as const,
        currentDir: "/workspace",
        model: "gpt-5.4",
        modelProvider: "openai-compatible-gateway" as const,
        policyEvents: [],
        toolOutputs: [],
      },
      transcript,
    });

  // A resume that states no dial runs at the mode the run recorded, rather
  // than at the harness default the flag would otherwise fall to.
  const { io, stderr } = createIoBuffers();
  let resumedMode: unknown;
  let resumedModeSource: unknown;
  assertEquals(
    await runCfHarnessCli(
      ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-cfc-resume"],
      {
        io,
        cwd: "/tmp/project",
        env: { CF_HARNESS_API_KEY: "gateway-key" },
        readRunArtifacts,
        createPromptLoop: (options) => {
          resumedMode = options.engine?.config.cfcEnforcementMode;
          resumedModeSource = options.engine?.config.cfcEnforcementModeSource;
          return {
            runPrompt: () => Promise.reject(new Error("unexpected prompt")),
            runTranscript: () =>
              Promise.resolve(completedCliResult("run-cfc-resume")),
          };
        },
      },
    ),
    0,
  );
  assertEquals(stderr, []);
  assertEquals(resumedMode, "observe");
  assertEquals(resumedModeSource, "inherited");

  // A fleet's environment pin names the posture for the runs it starts, not a
  // decision about this one, so a resume ignores it and runs at the recorded
  // mode — the reading `CF_HARNESS_MODEL` already gets.
  const pinnedIo = createIoBuffers();
  let pinnedMode: unknown;
  assertEquals(
    await runCfHarnessCli(
      ["--resume-run", "/tmp/project/.cf-harness-artifacts/run-cfc-resume"],
      {
        io: pinnedIo.io,
        cwd: "/tmp/project",
        env: {
          CF_HARNESS_API_KEY: "gateway-key",
          CF_CFC_MODE: "enforce-strict",
        },
        readRunArtifacts,
        createPromptLoop: (options) => {
          pinnedMode = options.engine?.config.cfcEnforcementMode;
          return {
            runPrompt: () => Promise.reject(new Error("unexpected prompt")),
            runTranscript: () =>
              Promise.resolve(completedCliResult("run-cfc-resume")),
          };
        },
      },
    ),
    0,
  );
  assertEquals(pinnedIo.stderr, []);
  assertEquals(pinnedMode, "observe");

  // A dial the run cannot move to is refused, naming both modes, and refused
  // before the run reaches a model client.
  const mismatchIo = createIoBuffers();
  let modelClientsCreated = 0;
  assertEquals(
    await runCfHarnessCli([
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-cfc-resume",
      "--cfc-enforcement-mode",
      "disabled",
    ], {
      io: mismatchIo.io,
      cwd: "/tmp/project",
      env: { CF_HARNESS_API_KEY: "gateway-key" },
      readRunArtifacts,
      createModelClient: () => {
        modelClientsCreated += 1;
        return {
          providerId: "openai-compatible-gateway",
          complete: () => Promise.reject(new Error("must not run")),
        };
      },
      createPromptLoop: () => ({
        runPrompt: () => Promise.reject(new Error("must not run")),
        runTranscript: () => Promise.reject(new Error("must not run")),
      }),
    }),
    1,
  );
  assertEquals(modelClientsCreated, 0);
  assertEquals(mismatchIo.stderr, [
    "resumed run CFC enforcement mode observe does not match requested CFC enforcement mode disabled\n",
  ]);
});

Deno.test("top-level CLI resume rejects subagent lineage before creating a model client", async () => {
  const { io, stderr } = createIoBuffers();
  let modelClientsCreated = 0;
  const exitCode = await runCfHarnessCli(
    ["--resume-run", "/tmp/project/.cf-harness-artifacts/root.subagent.1"],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readRunArtifacts: () =>
        Promise.resolve({
          runRoot: "/tmp/project/.cf-harness-artifacts/root.subagent.1",
          runStatePath:
            "/tmp/project/.cf-harness-artifacts/root.subagent.1/run-state.json",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/root.subagent.1/transcript.json",
          runState: {
            runId: "root.subagent.1",
            status: "failed" as const,
            createdAt: "2026-07-23T20:00:00.000Z",
            updatedAt: "2026-07-23T20:00:01.000Z",
            cfcEnforcementMode: "disabled" as const,
            currentDir: "/workspace",
            model: "gpt-5.4",
            modelProvider: "openai-codex" as const,
            credentialOwnerKey: "local",
            lineage: {
              role: "subagent" as const,
              rootRunId: "root",
              parentRunId: "root",
              parentToolCallId: "call-child",
              depth: 1,
            },
            policyEvents: [],
            toolOutputs: [],
          },
          transcript: [{ role: "user" as const, content: "Continue" }],
        }),
      createModelClient: () => {
        modelClientsCreated += 1;
        return {
          providerId: "openai-codex",
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "local",
          },
          complete: () => Promise.reject(new Error("must not run")),
        };
      },
    },
  );

  assertEquals(exitCode, 1);
  assertEquals(modelClientsCreated, 0);
  assertEquals(stderr, [
    "Cannot resume subagent run root.subagent.1 as a top-level run; resume root run root instead.\n",
  ]);
});

Deno.test("Codex cross-model resume fails before creating a model client", async () => {
  const { io, stderr } = createIoBuffers();
  let modelClientsCreated = 0;
  const exitCode = await runCfHarnessCli(
    [
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-codex-model",
      "--model",
      "gpt-different",
    ],
    {
      io,
      cwd: "/tmp/project",
      env: {},
      readRunArtifacts: () =>
        Promise.resolve({
          runRoot: "/tmp/project/.cf-harness-artifacts/run-codex-model",
          runStatePath:
            "/tmp/project/.cf-harness-artifacts/run-codex-model/run-state.json",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/run-codex-model/transcript.json",
          runState: {
            runId: "run-codex-model",
            status: "failed" as const,
            createdAt: "2026-07-23T20:00:00.000Z",
            updatedAt: "2026-07-23T20:00:01.000Z",
            cfcEnforcementMode: "disabled" as const,
            currentDir: "/workspace",
            model: "gpt-recorded",
            modelProvider: "openai-codex" as const,
            credentialOwnerKey: "local",
            policyEvents: [],
            toolOutputs: [],
          },
          transcript: [{ role: "user" as const, content: "Continue" }],
        }),
      createModelClient: () => {
        modelClientsCreated += 1;
        return {
          providerId: "openai-codex",
          credentialOwner: {
            type: "cf-harness.credential-owner-ref",
            version: 1,
            ownerKey: "local",
          },
          complete: () => Promise.reject(new Error("must not run")),
        };
      },
    },
  );

  assertEquals(exitCode, 1);
  assertEquals(modelClientsCreated, 0);
  assertEquals(stderr, [
    "resumed openai-codex run model gpt-recorded does not match requested model gpt-different\n",
  ]);
});

Deno.test("a refused resume names the setting, whichever tier refused it", async () => {
  // The CLI checks the argv and the run manifest against the recorded run,
  // and the engine constructor checks the settings the CLI hands it. A host
  // that reports structured failures reads both tiers through one mapping, so
  // a refusal from either arrives carrying the setting that was refused. The
  // provider case is the anchor: it already refused this way, and the rest
  // report as it does.

  const baseRunState = {
    status: "failed" as const,
    createdAt: "2026-07-23T20:00:00.000Z",
    updatedAt: "2026-07-23T20:00:01.000Z",
    cfcEnforcementMode: "disabled" as const,
    currentDir: "/workspace",
    model: "gpt-recorded",
    credentialOwnerKey: "local",
    policyEvents: [],
    toolOutputs: [],
  };
  const refuse = async (
    argv: readonly string[],
    runState: Partial<HarnessRunState> & { runId: string },
    manifest?: Record<string, unknown>,
  ): Promise<{ code: string; message: string }> => {
    const buffers = createIoBuffers();
    let modelClientsCreated = 0;
    let promptLoopsCreated = 0;
    let providerRequests = 0;
    const exitCode = await runCfHarnessCli(argv, {
      io: buffers.io,
      cwd: "/tmp/project",
      env: { CF_HARNESS_API_KEY: "test-key" },
      structuredHostFailures: true,
      readRunArtifacts: () =>
        Promise.resolve({
          runRoot: "/tmp/run",
          runStatePath: "/tmp/run/run-state.json",
          transcriptPath: "/tmp/run/transcript.json",
          runState: { ...baseRunState, ...runState },
          transcript: [{ role: "user" as const, content: "Continue" }],
        }),
      ...(manifest !== undefined
        ? { readTextFile: () => Promise.resolve(JSON.stringify(manifest)) }
        : {}),
      createModelClient: () => {
        modelClientsCreated += 1;
        throw new Error("must not create a model client");
      },
      createPromptLoop: () => {
        promptLoopsCreated += 1;
        throw new Error("must not construct a prompt loop");
      },
      fetchFn: () => {
        providerRequests += 1;
        return Promise.reject(new Error("must not request a provider"));
      },
    });
    assertEquals(exitCode, 1);
    // The refusal is settled against the recorded run alone, so nothing has
    // reached a credential store or a provider by the time it is reported.
    assertEquals(modelClientsCreated, 0);
    assertEquals(promptLoopsCreated, 0);
    assertEquals(providerRequests, 0);
    assertEquals(buffers.stdout, []);
    assertEquals(buffers.stderr.length, 1);
    const failure = JSON.parse(buffers.stderr[0]);
    assertEquals(failure.type, "cf-harness.host-failure");
    assertEquals(failure.version, 1);
    assertEquals(failure.ok, false);
    return failure.error;
  };

  // The CLI's own checks: the provider the argv asks for, and a run whose
  // lineage makes it somebody else's child.
  const provider = await refuse(
    ["--resume-run", "/tmp/run", "--model-provider", "openai-codex"],
    { runId: "run-gateway", modelProvider: "openai-compatible-gateway" },
  );
  assertEquals(provider.code, "provider-mismatch");
  assertStringIncludes(provider.message, "openai-compatible-gateway");
  assertStringIncludes(provider.message, "openai-codex");

  const subagent = await refuse(["--resume-run", "/tmp/run"], {
    runId: "root.subagent.1",
    modelProvider: "openai-codex",
    lineage: {
      role: "subagent",
      rootRunId: "root",
      parentRunId: "root",
      parentToolCallId: "call-child",
      depth: 1,
    },
  });
  assertEquals(subagent.code, "provider-mismatch");
  assertStringIncludes(subagent.message, "root.subagent.1");
  assertStringIncludes(subagent.message, "resume root run root");

  // The engine constructor's checks: a Codex run asked for another model, and
  // a run asked to answer out of another credential home.
  const model = await refuse(
    ["--resume-run", "/tmp/run", "--model", "gpt-different"],
    { runId: "run-codex", modelProvider: "openai-codex" },
  );
  assertEquals(model.code, "provider-mismatch");
  assertStringIncludes(model.message, "gpt-recorded");
  assertStringIncludes(model.message, "gpt-different");

  const home = await refuse(
    ["--resume-run", "/tmp/run", "--run-manifest", "/tmp/resume.json"],
    {
      runId: "run-home",
      modelProvider: "openai-compatible-gateway",
      harnessHomeIdentity: "sha256:recorded-home",
    },
    {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      harnessHomeIdentity: "sha256:requested-home",
    },
  );
  assertEquals(home.code, "provider-mismatch");
  assertStringIncludes(home.message, "harness home");

  // Gateway options against a run that recorded Codex contradict the record
  // rather than the rest of the argv, which the message says.
  const gateway = await refuse(
    [
      "--resume-run",
      "/tmp/run",
      "--gateway-base-url",
      "https://gateway.example/",
    ],
    { runId: "run-codex-gateway", modelProvider: "openai-codex" },
  );
  assertEquals(gateway.code, "provider-mismatch");
  assertStringIncludes(gateway.message, "gateway URL/auth options");
  assertStringIncludes(gateway.message, "this run recorded");
});

Deno.test("resume rejects manifest provider and credential-owner switches", async () => {
  const recordedOwner = {
    type: "cf-harness.credential-owner-ref" as const,
    version: 1 as const,
    ownerKey: "shared-user-key",
    tenantKey: "tenant-a",
  };
  const readRunArtifacts = () =>
    Promise.resolve({
      runRoot: "/tmp/run",
      runStatePath: "/tmp/run/run-state.json",
      transcriptPath: "/tmp/run/transcript.json",
      runState: {
        runId: "run-loom-resume",
        status: "failed" as const,
        createdAt: "2026-07-22T12:00:00.000Z",
        updatedAt: "2026-07-22T12:00:01.000Z",
        cfcEnforcementMode: "disabled" as const,
        currentDir: "/workspace",
        model: "gpt-5.4",
        modelProvider: "openai-codex" as const,
        credentialOwnerKey: recordedOwner.ownerKey,
        runManifest: {
          type: "cf-harness.loom-run-manifest" as const,
          version: 1 as const,
          source: "loom" as const,
          modelProvider: "openai-codex" as const,
          credentialOwner: recordedOwner,
        },
        policyEvents: [],
        toolOutputs: [],
      },
      transcript: [{ role: "user" as const, content: "Continue" }],
    });
  const run = async (manifest: Record<string, unknown>) => {
    const buffers = createIoBuffers();
    const exitCode = await runCfHarnessCli(
      ["--resume-run", "/tmp/run", "--run-manifest", "/tmp/resume.json"],
      {
        io: buffers.io,
        cwd: "/tmp/project",
        env: {},
        readRunArtifacts,
        readTextFile: () => Promise.resolve(JSON.stringify(manifest)),
      },
    );
    return { exitCode, stderr: buffers.stderr };
  };

  const providerSwitch = await run({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    modelProvider: "openai-compatible-gateway",
    credentialOwner: recordedOwner,
  });
  assertEquals(providerSwitch.exitCode, 1);
  assertEquals(providerSwitch.stderr, [
    "resume provider mismatch: run uses openai-codex, requested openai-compatible-gateway\n",
  ]);

  const ownerSwitch = await run({
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    modelProvider: "openai-codex",
    credentialOwner: { ...recordedOwner, tenantKey: "tenant-b" },
  });
  assertEquals(ownerSwitch.exitCode, 1);
  assertEquals(ownerSwitch.stderr, [
    "resume credential owner mismatch: requested owner does not match the recorded run\n",
  ]);
});

Deno.test("parseCfHarnessCliArgs validates --compact-threshold", async () => {
  const parse = (args: string[], env: Record<string, string> = {}) =>
    parseCfHarnessCliArgs(args, { cwd: "/tmp/project", env });

  const ok = await parse(["--compact-threshold", "12000", "hi"]);
  if ("help" in ok) throw new Error("expected config result");
  assertEquals(ok.compactThreshold, 12_000);

  // 0 is meaningful — it disables compaction — so it must not read as absent.
  const zero = await parse(["--compact-threshold", "0", "hi"]);
  if ("help" in zero) throw new Error("expected config result");
  assertEquals(zero.compactThreshold, 0);

  const omitted = await parse(["hi"]);
  if ("help" in omitted) throw new Error("expected config result");
  assertEquals(omitted.compactThreshold, undefined);

  const fromEnv = await parse(["hi"], { CF_HARNESS_COMPACT_THRESHOLD: "9000" });
  if ("help" in fromEnv) throw new Error("expected config result");
  assertEquals(fromEnv.compactThreshold, 9_000);

  // Every rejection names the requirement. `--compact-threshold -5` is the
  // subtle one: the parser reads `-5` as a separate flag, so the option
  // arrives with no string value and must not report merely "non-empty".
  for (
    const args of [
      ["--compact-threshold", "abc", "hi"],
      ["--compact-threshold", "1.5", "hi"],
      ["--compact-threshold=-5", "hi"],
      ["--compact-threshold", "-5", "hi"],
      ["--compact-threshold", "hi"],
    ]
  ) {
    await assertRejects(
      () => parse(args),
      Error,
      "--compact-threshold requires a non-negative integer token count",
    );
  }
});

Deno.test("local Loom binding conflicts become structured provider mismatches before execution", async () => {
  const buffers = createIoBuffers();
  let promptLoopsCreated = 0;
  let providerRequests = 0;
  const exitCode = await runCfHarnessCli(
    ["--run-manifest", "/tmp/loom-run-manifest.json", "hello"],
    {
      cwd: "/tmp/project",
      env: {},
      io: buffers.io,
      structuredHostFailures: true,
      loomLocalHostBinding: {
        source: "loom",
        modelProvider: "openai-codex",
        modelAuthSource: "cf-harness-local-store",
        credentialOwner: {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "local",
        },
        harnessHomeIdentity: "sha256:local-home",
      },
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          modelProvider: "openai-compatible-gateway",
        })),
      createPromptLoop: () => {
        promptLoopsCreated += 1;
        throw new Error("must not construct a prompt loop");
      },
      fetchFn: () => {
        providerRequests += 1;
        return Promise.reject(new Error("must not request a provider"));
      },
    },
  );

  assertEquals(exitCode, 1);
  assertEquals(promptLoopsCreated, 0);
  assertEquals(providerRequests, 0);
  assertEquals(buffers.stdout, []);
  assertEquals(buffers.stderr.length, 1);
  const failure = JSON.parse(buffers.stderr[0]);
  assertEquals(failure.type, "cf-harness.host-failure");
  assertEquals(failure.error.code, "provider-mismatch");
  assertStringIncludes(failure.error.message, "provider");
});

Deno.test("a startup fault is internal, and only bad argv is an invalid request", async () => {
  const workspace = await Deno.makeTempDir();

  const rejected = createIoBuffers();
  assertEquals(
    await runCfHarnessCli(["--model-provider", "unsupported", "hello"], {
      cwd: workspace,
      env: {},
      io: rejected.io,
      structuredHostFailures: true,
    }),
    1,
  );
  assertEquals(JSON.parse(rejected.stderr[0]).error.code, "invalid-request");

  // The argv is well-formed and the binding holds; only building the run
  // fails. A host that retries on `internal-error` and gives up on
  // `invalid-request` needs this one classified as the transient it is.
  const startup = createIoBuffers();
  let promptLoopsCreated = 0;
  assertEquals(
    await runCfHarnessCli(
      [
        "--workspace",
        workspace,
        "--model-provider",
        "openai-codex",
        "--cfc-enforcement-mode",
        "disabled",
        "hello",
      ],
      {
        cwd: workspace,
        env: {},
        io: startup.io,
        structuredHostFailures: true,
        createModelClient: () =>
          Promise.reject(new Error("artifact store unavailable")),
        createPromptLoop: () => {
          promptLoopsCreated += 1;
          throw new Error("must not construct a prompt loop");
        },
      },
    ),
    1,
  );
  assertEquals(promptLoopsCreated, 0);
  assertEquals(startup.stdout, []);
  const failure = JSON.parse(startup.stderr[0]);
  assertEquals(failure.error.code, "internal-error");
  assertEquals(JSON.stringify(failure).includes("artifact store"), false);
});

Deno.test("a resume reads a missing run as bad argv and an unreadable one as internal", async () => {
  const workspace = await Deno.makeTempDir();
  const run = async (
    error: Error,
  ): Promise<{ code: string; message: string }> => {
    const buffers = createIoBuffers();
    assertEquals(
      await runCfHarnessCli(["--resume-run", "/runs/one"], {
        cwd: workspace,
        env: {},
        io: buffers.io,
        structuredHostFailures: true,
        readRunArtifacts: () => Promise.reject(error),
      }),
      1,
    );
    return JSON.parse(buffers.stderr[0]).error;
  };

  // Naming a run that was never written is the caller's mistake, and no retry
  // will change it. A run that exists and will not read is the host's problem,
  // and the argv that asked for it was fine.
  assertEquals(
    (await run(new Deno.errors.NotFound("no such run"))).code,
    "invalid-request",
  );
  const unreadable = await run(new Deno.errors.PermissionDenied("run-state"));
  assertEquals(unreadable.code, "internal-error");
  assertEquals(unreadable.message.includes("run-state"), false);
});

Deno.test("parseCfHarnessCliArgs parses --pattern-index-url alongside the fabric session flags", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
      "--pattern-index-url",
      "https://index.example/api",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.patternIndex, { baseUrl: "https://index.example/api" });
});

Deno.test("parseCfHarnessCliArgs parses --skills-registry-url", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--skills-registry-url",
      "https://registry.example",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.skillsSh, { baseUrl: "https://registry.example" });
});

Deno.test("parseCfHarnessCliArgs reads the skills registry URL from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_SKILLS_REGISTRY_URL: "https://registry.example" },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.skillsSh, { baseUrl: "https://registry.example" });
});

Deno.test("parseCfHarnessCliArgs rejects a skills registry URL that does not parse", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--skills-registry-url", "not a url"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--skills-registry-url must be a valid URL",
  );
});

Deno.test("parseCfHarnessCliArgs rejects an empty skills registry flag", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--skills-registry-url", "   "],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--skills-registry-url requires a non-empty value",
  );
});

Deno.test("parseCfHarnessCliArgs rejects --allow-tool search_skills without a skills registry", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-tool", "search_skills"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "missing --skills-registry-url",
  );
});

Deno.test("parseCfHarnessCliArgs reads the Loom retrieval configuration from the flag or the environment", async () => {
  const retrieval = {
    cliPath: "/trusted/loom",
    transport: { kind: "broker" as const, queuePath: "/trusted/queue" },
  };
  const readTextFile = (path: string) => {
    assertEquals(path, "/trusted/retrieval.json");
    return Promise.resolve(JSON.stringify(retrieval));
  };
  const flagged = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--loom-retrieval-config",
      "/trusted/retrieval.json",
      "--allow-tool",
      "loom_search",
    ],
    { cwd: "/tmp/project", env: {}, readTextFile },
  );
  if ("help" in flagged) throw new Error("expected config result");
  assertEquals(flagged.loomRetrieval, retrieval);
  const fromEnvironment = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_LOOM_RETRIEVAL_CONFIG: "/trusted/retrieval.json" },
      readTextFile,
    },
  );
  if ("help" in fromEnvironment) throw new Error("expected config result");
  assertEquals(fromEnvironment.loomRetrieval, retrieval);
  const absent = await parseCfHarnessCliArgs(
    ["--prompt", "hi"],
    { cwd: "/tmp/project", env: {} },
  );
  if ("help" in absent) throw new Error("expected config result");
  assertEquals(absent.loomRetrieval, undefined);
});

Deno.test("parseCfHarnessCliArgs rejects --allow-tool for a Loom retrieval tool without its configuration", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-tool", "loom_people"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--allow-tool loom_people requires a Loom retrieval configuration",
  );
});

Deno.test("parseCfHarnessCliArgs rejects --allow-tool acquire_skill without both backings", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--allow-tool", "acquire_skill"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "requires a fabric session",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--allow-tool",
          "acquire_skill",
          "--fabric-api-url",
          "https://toolshed.example/",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "missing --skills-registry-url",
  );
});

Deno.test("parseCfHarnessCliArgs accepts --allow-tool acquire_skill with both backings", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--allow-tool",
      "acquire_skill",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
      "--skills-registry-url",
      "https://registry.example",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) throw new Error("expected config result");
  assertEquals(parsed.allowedToolIds, ["acquire_skill"]);
});

Deno.test("parseCfHarnessCliArgs reads the pattern index URL from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
    ],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_PATTERN_INDEX_URL: "https://index.example/api" },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.patternIndex, { baseUrl: "https://index.example/api" });
});

Deno.test("parseCfHarnessCliArgs rejects --pattern-index-url without the fabric session flags", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--pattern-index-url",
          "https://index.example/api",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--pattern-index-url needs a fabric session",
  );
});

Deno.test("parseCfHarnessCliArgs rejects a pattern index URL that does not parse", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-api-url",
          "https://toolshed.example/",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
          "--pattern-index-url",
          "not a url",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--pattern-index-url must be a valid URL",
  );
});

Deno.test("parseCfHarnessCliArgs rejects --allow-tool search_patterns without a pattern index", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-api-url",
          "https://toolshed.example/",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
          "--allow-tool",
          "search_patterns",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "missing --pattern-index-url",
  );
});

Deno.test("parseCfHarnessCliArgs records the publish opt-out from --no-pattern-index-publish", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
      "--pattern-index-url",
      "https://index.example/api",
      "--no-pattern-index-publish",
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.patternIndex, {
    baseUrl: "https://index.example/api",
    publish: false,
  });
});

Deno.test("parseCfHarnessCliArgs reads the pattern index publish opt-out from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
    ],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_PATTERN_INDEX_URL: "https://index.example/api",
        CF_HARNESS_PATTERN_INDEX_PUBLISH: "0",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.patternIndex, {
    baseUrl: "https://index.example/api",
    publish: false,
  });
});

Deno.test("parseCfHarnessCliArgs reads deliberate discoverable publishing from the environment", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
    ],
    {
      cwd: "/tmp/project",
      env: {
        CF_HARNESS_PATTERN_INDEX_URL: "https://index.example/api",
        CF_HARNESS_PATTERN_INDEX_PUBLISH_DISCOVERABLE: "1",
      },
    },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.patternIndex, {
    baseUrl: "https://index.example/api",
    publishDiscoverable: true,
  });
});

Deno.test("parseCfHarnessCliArgs rejects --allow-tool record_feedback without a pattern index", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [
          "--prompt",
          "hi",
          "--fabric-api-url",
          "https://toolshed.example/",
          "--fabric-identity",
          "keys/agent.pkcs8",
          "--fabric-space",
          "my-space",
          "--allow-tool",
          "record_feedback",
        ],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "missing --pattern-index-url",
  );
});

Deno.test("parseCfHarnessCliArgs carries --max-confidentiality into the fabric session as its read ceiling", async () => {
  const parsed = await parseCfHarnessCliArgs(
    [
      "--prompt",
      "hi",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
      "--max-confidentiality",
      JSON.stringify([
        "did:key:zOwner",
        { type: "Facet", owner: "did:key:zOwner", id: "work" },
      ]),
    ],
    { cwd: "/tmp/project", env: {} },
  );

  if ("help" in parsed) {
    throw new Error("expected config result");
  }
  assertEquals(parsed.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/tmp/project/keys/agent.pkcs8",
    space: "my-space",
    cfcReadMaxConfidentiality: [
      "did:key:zOwner",
      { type: "Facet", owner: "did:key:zOwner", id: "work" },
    ],
  });
});

Deno.test("parseCfHarnessCliArgs refuses a --max-confidentiality that is not a ceiling", async () => {
  const fabric = [
    "--prompt",
    "hi",
    "--fabric-api-url",
    "https://toolshed.example/",
    "--fabric-identity",
    "keys/agent.pkcs8",
    "--fabric-space",
    "my-space",
  ];
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [...fabric, "--max-confidentiality", "did:key:zOwner"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--max-confidentiality must be JSON",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [...fabric, "--max-confidentiality", "[]"],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--max-confidentiality: an empty ceiling admits",
  );
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        [...fabric, "--max-confidentiality", '{"anyOf":["did:key:zOwner"]}'],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--max-confidentiality: expected an array of clauses",
  );
});

Deno.test("parseCfHarnessCliArgs refuses --max-confidentiality without a fabric session", async () => {
  await assertRejects(
    () =>
      parseCfHarnessCliArgs(
        ["--prompt", "hi", "--max-confidentiality", '["did:key:zOwner"]'],
        { cwd: "/tmp/project", env: {} },
      ),
    Error,
    "--max-confidentiality bounds the fabric session's reads and needs --fabric-api-url, --fabric-identity, and --fabric-space",
  );
});

Deno.test("a resume whose manifest declares another read ceiling is refused as a structured mismatch", async () => {
  const buffers = createIoBuffers();
  let promptLoopsCreated = 0;
  const recordedManifest = {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    cfc: { maxConfidentiality: ["did:key:zOwner", "did:key:zFacet"] },
  } as const;
  const exitCode = await runCfHarnessCli(
    [
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
      "--run-manifest",
      "/tmp/loom-run-manifest.json",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
    ],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_API_KEY: "test-key" },
      io: buffers.io,
      structuredHostFailures: true,
      fabricSessionFactory: () =>
        Promise.reject(new Error("factory is forwarded, not invoked")),
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          ...recordedManifest,
          cfc: { maxConfidentiality: ["did:key:zOwner"] },
        })),
      readRunArtifacts: () =>
        Promise.resolve({
          runRoot: "/tmp/project/.cf-harness-artifacts/run-1",
          runStatePath:
            "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
          runState: {
            runId: "run-1",
            status: "failed",
            createdAt: "2026-04-15T22:10:00.000Z",
            updatedAt: "2026-04-15T22:10:01.000Z",
            cfcEnforcementMode: "disabled",
            currentDir: "/workspace",
            model: "gpt-5.4",
            artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
            transcriptPath:
              "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
            policyEvents: [],
            toolOutputs: [],
            runManifest: recordedManifest,
          },
          transcript: [{ role: "user", content: "Continue." }],
        }),
      createPromptLoop: () => {
        promptLoopsCreated += 1;
        throw new Error("must not construct a prompt loop");
      },
    },
  );
  assertEquals(exitCode, 1);
  assertEquals(promptLoopsCreated, 0);
  const failure = JSON.parse(buffers.stderr[0]);
  assertEquals(failure.type, "cf-harness.host-failure");
  assertEquals(failure.error.code, "provider-mismatch");
  assertStringIncludes(failure.error.message, "resume read ceiling mismatch");
});

Deno.test("a resume whose manifest respells the recorded ceiling (anyOf reordered) is not a mismatch", async () => {
  const buffers = createIoBuffers();
  let promptLoopsCreated = 0;
  const recordedManifest = {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    cfc: {
      maxConfidentiality: [{ anyOf: ["did:key:zOwner", "did:key:zFacet"] }],
    },
  } as const;
  const exitCode = await runCfHarnessCli(
    [
      "--resume-run",
      "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
      "--run-manifest",
      "/tmp/loom-run-manifest.json",
      "--fabric-api-url",
      "https://toolshed.example/",
      "--fabric-identity",
      "keys/agent.pkcs8",
      "--fabric-space",
      "my-space",
    ],
    {
      cwd: "/tmp/project",
      env: { CF_HARNESS_API_KEY: "test-key" },
      io: buffers.io,
      structuredHostFailures: true,
      fabricSessionFactory: () =>
        Promise.reject(new Error("factory is forwarded, not invoked")),
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          ...recordedManifest,
          cfc: {
            maxConfidentiality: [{
              anyOf: ["did:key:zFacet", "did:key:zOwner"],
            }],
          },
        })),
      readRunArtifacts: () =>
        Promise.resolve({
          runRoot: "/tmp/project/.cf-harness-artifacts/run-1",
          runStatePath:
            "/tmp/project/.cf-harness-artifacts/run-1/run-state.json",
          transcriptPath:
            "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
          runState: {
            runId: "run-1",
            status: "failed",
            createdAt: "2026-04-15T22:10:00.000Z",
            updatedAt: "2026-04-15T22:10:01.000Z",
            cfcEnforcementMode: "disabled",
            currentDir: "/workspace",
            model: "gpt-5.4",
            artifactRoot: "/tmp/project/.cf-harness-artifacts/run-1",
            transcriptPath:
              "/tmp/project/.cf-harness-artifacts/run-1/transcript.json",
            policyEvents: [],
            toolOutputs: [],
            runManifest: recordedManifest,
          },
          transcript: [{ role: "user", content: "Continue." }],
        }),
      createPromptLoop: () => {
        promptLoopsCreated += 1;
        throw new Error("must not construct a prompt loop");
      },
    },
  );
  // The mismatch guard let it through, so the resume reached the prompt
  // loop the fixture refuses to build; that refusal, not the ceiling, is
  // what failed the run.
  assertEquals(promptLoopsCreated, 1);
  assertEquals(exitCode, 1);
  const failure = JSON.parse(buffers.stderr[0]);
  assertEquals(
    String(failure.error?.message ?? failure.error).includes(
      "resume read ceiling mismatch",
    ),
    false,
  );
});

Deno.test("parseCfHarnessCliArgs refuses a present --max-confidentiality with no value rather than running unbounded", async () => {
  const fabric = [
    "--prompt",
    "hi",
    "--fabric-api-url",
    "https://toolshed.example/",
    "--fabric-identity",
    "keys/agent.pkcs8",
    "--fabric-space",
    "my-space",
  ];
  // Bare at the end of the line, bare before another flag, and with an
  // empty value: each is a ceiling the operator meant to state and did not,
  // never a run with no ceiling.
  for (
    const args of [
      [...fabric, "--max-confidentiality"],
      [...fabric, "--max-confidentiality", "--print-transcript"],
      [...fabric, "--max-confidentiality="],
      [...fabric, "--max-confidentiality", "   "],
    ]
  ) {
    // Two refusals cover the shapes: the parser reads a bare flag as an
    // empty string, which the JSON step refuses; a non-string value is
    // refused before it. Either way the run never starts unbounded.
    const err = await assertRejects(
      () => parseCfHarnessCliArgs(args, { cwd: "/tmp/project", env: {} }),
      Error,
    );
    assertMatch(
      err.message,
      /--max-confidentiality (requires a JSON array|must be JSON)/,
    );
  }
});
