import { assertEquals } from "@std/assert";

import type { CfcLabelView } from "@commonfabric/runner/cfc";

import {
  CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
  createHarnessCfcInvocationContext,
  summarizeCfcInvocationRunManifest,
  summarizeCfcInvocationSequence,
  summarizeCfcInvocationText,
} from "../src/contracts/cfc-invocation-context.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";

Deno.test("createHarnessCfcInvocationContext summarizes measured invocation inputs without raw values", async () => {
  // Spec: specs/cfc/18-runtime-implementation-profiles.md §18.2.4.1
  // requires measured execution bundles to bind argv/env/cwd facts. The
  // cf-harness sidecar is provenance transport for those facts; it carries
  // redacted summaries so raw command/input bytes are not copied into the
  // sidecar itself.
  const command = "printf '%s' \"$SECRET_TOKEN\"";
  const argv = ["/bin/printf", "%s", "secret-argv"];
  const args = ["/workspace/secret.txt", "append"];
  const stdinText = "secret stdin payload";
  const env = {
    SECRET_TOKEN: "secret env payload",
    PUBLIC_MODE: "observe",
  };
  const cfcInputLabels: CfcLabelView = {
    version: 1,
    entries: [
      {
        path: ["argv"],
        label: {
          confidentiality: [
            { type: "test.cfc/User", subject: "did:key:argv-reader" },
          ],
        },
      },
      {
        path: ["cwd"],
        label: {
          confidentiality: [
            { type: "test.cfc/Workspace", subject: "workspace-secret" },
          ],
        },
      },
      {
        path: ["env", "SECRET_TOKEN"],
        label: {
          confidentiality: [
            { type: "test.cfc/User", subject: "did:key:env-reader" },
          ],
        },
      },
    ],
  };

  const context = await createHarnessCfcInvocationContext({
    sequence: 7,
    runId: "run-1",
    createdAt: "2026-05-11T16:00:00.000Z",
    toolId: "bash",
    operation: "shell",
    cfcEnforcementMode: "enforce-explicit",
    cwd: "/workspace/project",
    promptSlot: {
      type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
      source: { type: "cf-harness.test-input", surface: "cli" },
      role: "direct-command",
      kernelName: "cli",
      surface: "cli",
    },
    runManifest: {
      present: true,
      source: "loom",
      wishId: "W-519",
      cfcEnforcementMode: "enforce-explicit",
      promptSlotPresent: true,
    },
    command,
    argv,
    args,
    stdinText,
    env,
    cfcInputLabels,
  });

  assertEquals(
    context.inputs.command,
    await summarizeCfcInvocationText(command),
  );
  assertEquals(context.inputs.argv, await summarizeCfcInvocationSequence(argv));
  assertEquals(context.inputs.args, await summarizeCfcInvocationSequence(args));
  assertEquals(
    context.inputs.stdin,
    await summarizeCfcInvocationText(stdinText),
  );
  assertEquals(context.inputs.env, {
    type: "cf-harness.env-summary",
    count: 2,
    names: ["PUBLIC_MODE", "SECRET_TOKEN"],
  });
  assertEquals(context.cwd, "/workspace/project");
  assertEquals(context.promptSlot?.type, CFC_PROMPT_SLOT_BOUND_ATOM_TYPE);
  assertEquals(context.cfcInputLabels, cfcInputLabels);

  const serialized = JSON.stringify(context);
  for (
    const rawValue of [
      command,
      "secret-argv",
      stdinText,
      "secret env payload",
    ]
  ) {
    assertEquals(
      serialized.includes(rawValue),
      false,
      `sidecar leaked raw invocation input ${rawValue}`,
    );
  }
});

Deno.test("createHarnessCfcInvocationContext derives integrity prompt-slot influence labels for selected invocation inputs", async () => {
  const promptSlot = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "cf-harness.test-input", surface: "cli" },
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "cli",
    subject: "did:key:user",
    eventId: "evt-1",
    valueDigest: "sha256:value",
    slotDigest: "sha256:slot",
    snapshotDigest: "sha256:snapshot",
    targetPath: "/workspace/request.md",
  } as const;

  const context = await createHarnessCfcInvocationContext({
    sequence: 1,
    runId: "run-labels",
    createdAt: "2026-05-14T17:00:00.000Z",
    toolId: "bash",
    operation: "shell",
    cfcEnforcementMode: "enforce-explicit",
    cwd: "/workspace",
    promptSlot,
    runManifest: {
      present: true,
      source: "loom",
      wishId: "W-534",
      dispatchClass: "gtd-ops",
      promptSlotPresent: true,
    },
    command: "printf hello",
    stdinText: "model-authored stdin",
    cfcInputLabelPaths: [["command"], ["stdin"]],
  });

  const expectedAtom = {
    type: CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
    version: 1,
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "cli",
    subject: "did:key:user",
    eventId: "evt-1",
    valueDigest: "sha256:value",
    slotDigest: "sha256:slot",
    snapshotDigest: "sha256:snapshot",
    targetPath: "/workspace/request.md",
    runManifest: {
      source: "loom",
      wishId: "W-534",
      dispatchClass: "gtd-ops",
    },
  };

  assertEquals(context.promptSlotInfluenceLabels, {
    version: 1,
    entries: [
      {
        path: ["command"],
        label: { integrity: [expectedAtom] },
      },
      {
        path: ["stdin"],
        label: { integrity: [expectedAtom] },
      },
    ],
  });
  // The sandbox reads `cfcInputLabels` as startup taint and refuses integrity
  // claims there, so the influence labels must not reach it.
  assertEquals(context.cfcInputLabels, undefined);
});

Deno.test("createHarnessCfcInvocationContext can label prompt-slot and model-context inputs separately", async () => {
  const promptSlot = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "cf-harness.test-input", surface: "cli" },
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "cli",
  } as const;
  const observedSecret = {
    type: "test.cfc/ObservedOutput",
    subject: "did:key:observed-secret",
  };

  const context = await createHarnessCfcInvocationContext({
    sequence: 3,
    runId: "run-split-label-paths",
    createdAt: "2026-05-18T22:01:00.000Z",
    toolId: "read_file",
    operation: "shell",
    cfcEnforcementMode: "enforce-explicit",
    cwd: "/workspace",
    promptSlot,
    runManifest: { present: false },
    command: 'cat "$1"',
    args: ["/workspace/notes/public.txt"],
    cfcPromptSlotInputLabelPaths: [["command"]],
    cfcModelContextInputLabelPaths: [["args"]],
    cfcModelContext: {
      type: "cf-harness.cfc-model-context",
      version: 1,
      updatedAt: "2026-05-18T22:00:00.000Z",
      label: {
        confidentiality: [observedSecret],
        integrity: [{ type: "test.cfc/ShouldNotFlow" }],
      },
      observations: [],
    },
  });

  assertEquals(context.cfcInputLabels, {
    version: 1,
    entries: [{
      path: ["args"],
      label: { confidentiality: [observedSecret] },
    }],
  });
  assertEquals(context.promptSlotInfluenceLabels, {
    version: 1,
    entries: [{
      path: ["command"],
      label: {
        integrity: [{
          type: CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
          version: 1,
          role: "direct-command",
          kernelName: "cf-harness",
          surface: "cli",
        }],
      },
    }],
  });
});

Deno.test("createHarnessCfcInvocationContext drops a confidentiality-position prompt-slot influence atom from a saved model context", async () => {
  // A model context saved by a run that minted the atom as confidentiality
  // still holds it there when that run resumes.
  const savedInfluence = {
    type: CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
    version: 1,
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "cli",
  };
  const observedSecret = {
    type: "test.cfc/ObservedOutput",
    subject: "did:key:observed-secret",
  };

  const context = await createHarnessCfcInvocationContext({
    sequence: 4,
    runId: "run-resumed-model-context",
    createdAt: "2026-09-21T10:00:00.000Z",
    toolId: "bash",
    operation: "shell",
    cfcEnforcementMode: "enforce-strict",
    cwd: "/workspace",
    runManifest: { present: false },
    command: "printf hello",
    cfcInputLabelPaths: [["command"]],
    cfcModelContext: {
      type: "cf-harness.cfc-model-context",
      version: 1,
      updatedAt: "2026-09-20T10:00:00.000Z",
      label: { confidentiality: [savedInfluence, observedSecret] },
      observations: [],
    },
  });

  assertEquals(context.cfcInputLabels, {
    version: 1,
    entries: [{
      path: ["command"],
      label: { confidentiality: [observedSecret] },
    }],
  });
});

Deno.test("createHarnessCfcInvocationContext keeps explicit trusted labels apart from derived prompt-slot labels", async () => {
  const explicitAtom = {
    type: "test.cfc/ExplicitTrustedInput",
    subject: "trusted-sidecar",
  };
  const promptSlot = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "cf-harness.test-input", surface: "cli" },
    role: "context",
    kernelName: "cf-harness",
    surface: "cli",
  } as const;

  const context = await createHarnessCfcInvocationContext({
    sequence: 2,
    runId: "run-merged-labels",
    createdAt: "2026-05-14T17:01:00.000Z",
    toolId: "read_file",
    operation: "shell",
    cfcEnforcementMode: "observe",
    cwd: "/workspace",
    promptSlot,
    runManifest: { present: false },
    args: ["/workspace/notes.md"],
    cfcInputLabels: {
      version: 1,
      entries: [{
        path: ["args"],
        label: { confidentiality: [explicitAtom] },
      }],
    },
    cfcInputLabelPaths: [["args"]],
  });

  assertEquals(context.cfcInputLabels, {
    version: 1,
    entries: [{
      path: ["args"],
      label: { confidentiality: [explicitAtom] },
    }],
  });
  assertEquals(context.promptSlotInfluenceLabels, {
    version: 1,
    entries: [{
      path: ["args"],
      label: {
        integrity: [{
          type: CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
          version: 1,
          role: "context",
          kernelName: "cf-harness",
          surface: "cli",
        }],
      },
    }],
  });
});

Deno.test("summarizeCfcInvocationRunManifest carries the manifest's read ceiling", () => {
  assertEquals(
    summarizeCfcInvocationRunManifest(
      {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        wishId: "W-2201",
        cfc: {
          maxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
          onExceed: "skip",
        },
      },
      "/runs/W-2201/manifest.json",
    ),
    {
      present: true,
      path: "/runs/W-2201/manifest.json",
      source: "loom",
      wishId: "W-2201",
      cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
      cfcReadOnExceed: "skip",
      promptSlotPresent: false,
    },
  );
});
