import { checkoutDocsCorpusRoots } from "../src/docs-corpus/corpus.ts";
import { resolveHarnessSkillsRoot } from "../src/skills/root.ts";
import {
  assertEquals,
  assertExists,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { normalize } from "@std/path/posix";
import type { HarnessArtifactStore } from "../src/artifacts.ts";
import { harnessFabricSessionPosture } from "../src/cfc-posture.ts";
import { CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE } from "../src/contracts/cfc-invocation-context.ts";
import { createHarnessCfcPolicySnapshot } from "../src/contracts/cfc-policy-snapshot.ts";
import { createHarnessPolicyEvent } from "../src/contracts/policy.ts";
import { CFC_PROMPT_SLOT_BOUND_ATOM_TYPE } from "../src/contracts/prompt-slot.ts";
import type { HarnessSkillResourceReads } from "../src/contracts/skill.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import { HarnessControlError } from "../src/control-errors.ts";
import { CAPABILITY_PROBE_SENTINEL } from "../src/diagnostics.ts";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import type { HarnessRunState } from "../src/run-state.ts";
import { RESERVED_ARTIFACT_PATH_DETAIL } from "../src/tools/reserved-artifacts.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";
import type {
  ProcessRunner,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/sandbox/process-runner.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

class FakeSandboxRuntime implements SandboxRuntime {
  readonly shellRequests: SandboxShellRequest[] = [];

  readonly #shellResults: SandboxCommandResult[];
  readonly #shellError?: Error;

  constructor(
    shellResults: SandboxCommandResult[] = [],
    shellError?: Error,
  ) {
    this.#shellResults = shellResults;
    this.#shellError = shellError;
  }

  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }

  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
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

  runShell(request: SandboxShellRequest): Promise<SandboxCommandResult> {
    this.shellRequests.push(request);
    if (request.command.includes(CAPABILITY_PROBE_SENTINEL)) {
      return Promise.resolve({
        stdout: [
          "bash\tpresent\t/bin/bash\tGNU bash, version 5.2.26(1)-release",
          "sh\tpresent\t/bin/sh\tBusyBox v1.36.1",
          "node\tmissing\t\t",
          "deno\tpresent\t/usr/local/bin/deno\tdeno 2.2.0",
          "python\tmissing\t\t",
          "python3\tpresent\t/usr/bin/python3\tPython 3.11.9",
          "git\tpresent\t/usr/bin/git\tgit version 2.45.1",
        ].join("\n"),
        stderr: "",
        exitCode: 0,
      });
    }
    if (this.#shellError) {
      return Promise.reject(this.#shellError);
    }
    return Promise.resolve(
      this.#shellResults.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

class FakeProcessRunner implements ProcessRunner {
  readonly calls: ProcessRunRequest[] = [];

  readonly #results: ProcessRunResult[];

  constructor(
    results: ProcessRunResult[] = [{
      stdout: "",
      stderr: "",
      exitCode: 0,
    }],
  ) {
    this.#results = results;
  }

  run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    this.calls.push(request);
    return Promise.resolve(
      this.#results.shift() ?? { stdout: "", stderr: "", exitCode: 0 },
    );
  }
}

Deno.test("CfHarnessEngine numbers CFC invocation contexts prepared at once apart", async () => {
  const sandbox = new FakeSandboxRuntime([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    sandboxRuntime: sandbox,
    runId: "run-contexts-at-once",
  });

  await Promise.all([
    engine.invokeBuiltinTool("bash", { command: "printf one" }),
    engine.invokeBuiltinTool("bash", { command: "printf two" }),
  ]);

  assertEquals(
    engine.getRunState().cfcInvocationContexts?.map((context) =>
      context.sequence
    ).toSorted(),
    [1, 2],
  );
});

Deno.test("CfHarnessEngine numbers a resumed run's next CFC invocation context past the highest recorded", async () => {
  const first = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([
      { stdout: "", stderr: "", exitCode: 0 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]),
    runId: "run-context-gap",
  });
  await first.invokeBuiltinTool("bash", { command: "printf one" });
  await first.invokeBuiltinTool("bash", { command: "printf two" });
  // A number reserved for a context that was never recorded leaves a gap:
  // the run resumes holding only the context numbered 2.
  const recorded = first.getRunState();
  const resumed = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([
      { stdout: "", stderr: "", exitCode: 0 },
    ]),
    runId: "run-context-gap",
    runState: {
      ...recorded,
      cfcInvocationContexts: recorded.cfcInvocationContexts?.slice(1),
    },
  });

  await resumed.invokeBuiltinTool("bash", { command: "printf three" });

  assertEquals(
    resumed.getRunState().cfcInvocationContexts?.map((context) =>
      context.sequence
    ),
    [2, 3],
  );
});

Deno.test("CfHarnessEngine keeps the handles of two mints recorded at once", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-mints-at-once",
  });

  const tokens = await Promise.all([
    engine.mintReferentHandle({
      source: "loom:rows",
      value: "first row",
      label: { confidentiality: ["https://cfc.test/atom/facet/work"] },
      labelSource: "row",
    }),
    engine.mintReferentHandle({
      source: "loom:rows",
      value: "second row",
      label: { confidentiality: ["https://cfc.test/atom/facet/work"] },
      labelSource: "row",
    }),
  ]);

  assertEquals(
    engine.handleTable?.referents?.map((referent) => referent.token)
      .toSorted(),
    tokens.toSorted(),
  );
});

Deno.test("CfHarnessEngine refuses to record a table where two addresses drew one token", async () => {
  const constant = () => Promise.resolve(new Uint8Array(32));
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-token-collision",
  });
  const base = createHarnessHandleTable("run-token-collision");
  const first = await mintAddressHandle(base, `of:fid1:${"A".repeat(43)}`, {
    hasher: constant,
  });
  const second = await mintAddressHandle(base, `of:fid1:${"B".repeat(43)}`, {
    hasher: constant,
  });
  await engine.recordHandleTable(first.table);

  await assertRejects(
    () => engine.recordHandleTable(second.table),
    Error,
    "two different addresses",
  );
  assertEquals(engine.handleTable?.entries.length, 1);
});

Deno.test("CfHarnessEngine lands the newest run state last when two writes overlap", async () => {
  // The first write is held until the second has been asked for, so the
  // store would finish the second first; the state it is left holding must
  // still be the newer one.
  const completed: HarnessRunState[] = [];
  let hold: PromiseWithResolvers<void> | undefined;
  const runRoot = "/tmp/cf-harness-artifacts/run-write-order";
  const artifactStore: HarnessArtifactStore = {
    artifactRoot: "/tmp/cf-harness-artifacts",
    runRoot,
    async persistRunState(state) {
      const snapshot = structuredClone(state);
      const held = hold;
      hold = undefined;
      await held?.promise;
      completed.push(snapshot);
      return `${runRoot}/run-state.json`;
    },
    persistTranscript: () => Promise.resolve(`${runRoot}/transcript.json`),
    persistCapabilitySnapshot: () =>
      Promise.resolve(`${runRoot}/capabilities.json`),
    persistCfcPolicySnapshot: () =>
      Promise.resolve(`${runRoot}/policy-snapshot.json`),
    persistPolicyTrace: () => Promise.resolve(`${runRoot}/policy-trace.json`),
    persistRunReport: () => Promise.resolve(`${runRoot}/run-report.json`),
    persistToolOutput: () => Promise.resolve(`${runRoot}/tool-output.json`),
  };
  const engine = new CfHarnessEngine({
    artifactStore,
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-write-order",
  });

  const released = Promise.withResolvers<void>();
  hold = released;
  const first = engine.persistRunState();
  const second = engine.recordPolicyEvent({
    severity: "warning",
    mode: "observe",
    toolId: "bash",
    detail: "the newer state",
  });
  released.resolve();
  await Promise.all([first, second]);

  assertEquals(
    completed.at(-1)?.policyEvents.map((event) => event.detail),
    ["the newer state"],
  );
});

Deno.test("CfHarnessEngine builds a default docker-runsc sandbox when given a workspace path", () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    now: () => "2026-04-15T19:00:00.000Z",
    // The rung the run-state comparison below reads back.
    cfcEnforcementMode: "enforce-explicit",
  });

  assertEquals(engine.config.sandbox, undefined);
  assertEquals(engine.sandbox.describe().kind, "docker-runsc-cfc");
  assertEquals(engine.getRunState(), {
    runId: engine.getRunState().runId,
    status: "pending",
    createdAt: "2026-04-15T19:00:00.000Z",
    updatedAt: "2026-04-15T19:00:00.000Z",
    cfcEnforcementMode: "enforce-explicit",
    currentDir: "/workspace",
    docsCorpus: {
      type: "cf-harness.docs-corpus-record",
      source: "checkout-default",
      roots: checkoutDocsCorpusRoots(),
    },
    skillsRoot: resolveHarnessSkillsRoot(),
    modelProvider: "openai-compatible-gateway",
    modelAuthSource: "api-key",
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [],
  });
});

Deno.test("CfHarnessEngine accepts a default sandbox image override", () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    sandboxImage: "registry.example/cf:deno2",
  });

  assertEquals(
    engine.sandbox.describe().cfc?.image,
    "registry.example/cf:deno2",
  );
});

Deno.test("CfHarnessEngine constructs in enforce mode without CFC transports", () => {
  // Construction must stay cheap and inspectable; the transport floor is only
  // enforced once the run starts — at diagnostics init (capability probes) or
  // the first tool call, whichever comes first (see the run-start tests below).
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-strict",
  });
  assertEquals(engine.getRunState().cfcEnforcementMode, "enforce-strict");
});

/**
 * The posture record a session config resolves to. Built the way the engine
 * builds it rather than written out here: the record's own shape is pinned in
 * the runner's parity suite, and restating it in this file would make these
 * cases assert the restatement.
 */
const recordFor = (
  session: Parameters<typeof harnessFabricSessionPosture>[0],
) => harnessFabricSessionPosture(session);

Deno.test("CfHarnessEngine records the fabric session's resolved CFC posture in run state", () => {
  // The assertion below reads both session dials back off the run state,
  // each marked as configured.
  const configured = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    },
  });
  assertEquals(configured.getRunState().fabricSessionCfc, {
    enforcementMode: "enforce-strict",
    enforcementModeSource: "configured",
    flowLabels: "persist",
    flowLabelsSource: "configured",
    record: recordFor({
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    }),
  });

  // A session stating no dial of its own runs at the rung the session preset
  // pins. The itemized rung is read off the record beside it: the two are one
  // answer, and a run state naming a rung its own record contradicts is what
  // this reads for.
  const unstatedSession = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
  };
  const unstatedRecord = recordFor(unstatedSession);
  const pinnedCfc = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: unstatedSession,
  }).getRunState().fabricSessionCfc;
  assertEquals(pinnedCfc?.enforcementMode, unstatedRecord.enforcementMode.rung);
  assertEquals(pinnedCfc?.enforcementModeSource, "preset-pin");
  assertEquals(pinnedCfc?.flowLabelsSource, "default");
  assertEquals(pinnedCfc?.record, unstatedRecord);

  // The named bundle supplies persist when the operator selects the posture
  // and leaves the flow-labels dial unset; a configured dial would still win.
  const posturedSession = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcPosture: "max-enforcement",
  } as const;
  const posturedRecord = recordFor(posturedSession);
  const posturedCfc = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: posturedSession,
  }).getRunState().fabricSessionCfc;
  // The bundle names no enforcement rung, so this one is still the preset's
  // pin, read off the record as above.
  assertEquals(
    posturedCfc?.enforcementMode,
    posturedRecord.enforcementMode.rung,
  );
  assertEquals(posturedCfc?.enforcementModeSource, "preset-pin");
  assertEquals(posturedCfc?.flowLabels, "persist");
  assertEquals(posturedCfc?.flowLabelsSource, "posture");
  assertEquals(posturedCfc?.posture, "max-enforcement");
  assertEquals(posturedCfc?.record, posturedRecord);

  const sessionless = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
  });
  assertEquals(sessionless.getRunState().fabricSessionCfc, undefined);
});

Deno.test("CfHarnessEngine publishes no posture record when a session factory overrides the config", () => {
  // The factory decides which runtime executes, and the config no longer
  // describes it — so a record projected from the config would assert a
  // posture nothing honors. The two itemized dials stand alone: they still
  // truthfully say what was asked for.
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
      cfcPosture: "max-enforcement",
      // The dial the comparison below reads back.
      cfcEnforcementMode: "enforce-strict",
    },
    fabricSessionFactory: () =>
      Promise.reject(new Error("never built in this test")),
  });
  assertEquals(engine.getRunState().fabricSessionCfc, {
    enforcementMode: "enforce-strict",
    enforcementModeSource: "configured",
    flowLabels: "persist",
    flowLabelsSource: "posture",
    posture: "max-enforcement",
  });
});

Deno.test("CfHarnessEngine records an inherited posture record when the injected session is one it was given the record for", () => {
  // The delegating parent's shape: the child runs on the session its parent
  // built, so its posture is that session's rather than unknown, and the
  // record says where it came from.
  const posturedSession = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcPosture: "max-enforcement",
    // The dial the comparison below reads back off the child's run state.
    cfcEnforcementMode: "enforce-strict",
  } as const;
  const parentRecord = recordFor(posturedSession);
  const child = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: posturedSession,
    fabricSessionFactory: () =>
      Promise.reject(new Error("never built in this test")),
    inheritedFabricSessionPosture: parentRecord,
  });

  assertEquals(child.getRunState().fabricSessionCfc, {
    enforcementMode: "enforce-strict",
    enforcementModeSource: "configured",
    flowLabels: "persist",
    flowLabelsSource: "posture",
    posture: "max-enforcement",
    record: { ...parentRecord, provenance: "inherited" },
  });
});

Deno.test("CfHarnessEngine refuses to resume a recorded record under an overriding session factory", () => {
  // The recorded record describes a runtime this resume is not building, so
  // carrying it forward would publish a posture the executing session may not
  // be at — the mismatch this guard exists to refuse.
  const posturedSession = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcPosture: "max-enforcement",
  } as const;
  const runState = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: posturedSession,
  }).getRunState();

  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: posturedSession,
        fabricSessionFactory: () =>
          Promise.reject(new Error("never built in this test")),
        runState,
      }),
    Error,
    "fabric session CFC posture mismatch on resume",
  );
});

Deno.test("CfHarnessEngine refuses to resume under a fabric-session posture that contradicts the recorded one", () => {
  const posturedSession = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcPosture: "max-enforcement",
    // The dial the clean-resume comparison below reads back. Every session
    // this case builds carries it, so the posture is the only thing the
    // refused resumes differ on.
    cfcEnforcementMode: "enforce-strict",
  } as const;
  const runState = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: posturedSession,
  }).getRunState();

  // The contradiction: the artifacts claim max-enforcement while the session
  // the resumed engine would actually build runs the default posture.
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: {
          apiUrl: posturedSession.apiUrl,
          identityKeyPath: posturedSession.identityKeyPath,
          space: posturedSession.space,
          cfcEnforcementMode: posturedSession.cfcEnforcementMode,
        },
        runState,
      }),
    Error,
    "fabric session CFC posture mismatch on resume",
  );

  // The same session configuration resumes cleanly, record unchanged.
  const resumed = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: posturedSession,
    runState,
  });
  assertEquals(resumed.getRunState().fabricSessionCfc, {
    enforcementMode: "enforce-strict",
    enforcementModeSource: "configured",
    flowLabels: "persist",
    flowLabelsSource: "posture",
    posture: "max-enforcement",
    record: recordFor(posturedSession),
  });

  // A dial neither itemized field names, moved under the run: the recorded
  // record no longer describes what the resumed session would run, so the
  // resume is refused rather than attesting a posture the runtime is not at.
  const drifted = structuredClone(runState) as {
    fabricSessionCfc?: {
      record?: { writeFloor: { rung: string } };
    };
  } & typeof runState;
  drifted.fabricSessionCfc!.record!.writeFloor.rung = "off";
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: posturedSession,
        runState: drifted,
      }),
    Error,
    "fabric session CFC posture mismatch on resume",
  );

  // A run recorded before the record existed is compared on the dials alone,
  // and resumes: backfilling one would attest this checkout's resolution
  // rather than the run's.
  const legacy = structuredClone(runState);
  delete legacy.fabricSessionCfc!.record;
  assertEquals(
    new CfHarnessEngine({
      workspaceHostPath: "/host/project",
      fabricSession: posturedSession,
      runState: legacy,
    }).getRunState().fabricSessionCfc?.record,
    undefined,
  );

  // A resume with no session at all keeps the record as history: no runtime
  // exists for it to contradict.
  const detached = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    runState,
  });
  assertEquals(
    detached.getRunState().fabricSessionCfc?.posture,
    "max-enforcement",
  );

  // A legacy record (no posture ever captured) stays frozen as history:
  // plain session dials may restate the original invocation, but the named
  // bundle cannot have been what the run ran, so a posture resume is refused.
  // Recorded at the mode the strict dial below resolves, so the session's
  // raise leaves the harness mode where the run recorded it and the posture
  // record is the only thing under test here.
  const legacyState = {
    ...runState,
    cfcEnforcementMode: "enforce-strict" as const,
    fabricSessionCfc: undefined,
  } as typeof runState;
  const legacyWithDials = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: {
      apiUrl: posturedSession.apiUrl,
      identityKeyPath: posturedSession.identityKeyPath,
      space: posturedSession.space,
      cfcEnforcementMode: "enforce-strict",
    },
    runState: legacyState,
  });
  assertEquals(legacyWithDials.getRunState().fabricSessionCfc, undefined);
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: posturedSession,
        runState: legacyState,
      }),
    Error,
    "records no fabric-session posture",
  );
});

Deno.test("CfHarnessEngine refuses to resume under a harness CFC enforcement dial that contradicts the recorded mode", () => {
  // `runState.cfcEnforcementMode` is the mode the run enforces at: the
  // sandbox transport floor and the tool policy both read it. A resume that
  // states a different one cannot move it, so the run would go on enforcing
  // the recorded mode while the policy snapshot credited the operator's dial
  // for it.
  const runState = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    cfcEnforcementModeOverride: "observe",
  }).getRunState();
  assertEquals(runState.cfcEnforcementMode, "observe");

  const stated = assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        runState,
        cfcEnforcementModeOverride: "disabled",
      }),
    HarnessControlError,
    "resumed run CFC enforcement mode observe does not match requested CFC enforcement mode disabled",
  );
  assertEquals(stated.code, "provider-mismatch");

  // The configured dial the override stands in front of, refused the same
  // way: what the resume states is what it asked the run to enforce at.
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        runState,
        cfcEnforcementMode: "enforce-strict",
      }),
    Error,
    "resumed run CFC enforcement mode observe does not match requested CFC enforcement mode enforce-strict",
  );

  // Restating the recorded mode asks for nothing the run is not already
  // doing, so it resumes, and the snapshot names the operator's dial.
  const restated = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    runState,
    cfcEnforcementModeOverride: "observe",
  });
  assertEquals(restated.config.cfcEnforcementMode, "observe");
  assertEquals(restated.config.cfcEnforcementModeSource, "override");

  // A resume that states nothing inherits the recorded mode rather than
  // falling to this invocation's default, which would resolve
  // enforce-explicit and label it a default the run never took.
  const quiet = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    runState,
  });
  assertEquals(quiet.config.cfcEnforcementMode, "observe");
  assertEquals(quiet.config.cfcEnforcementModeSource, "inherited");

  // A run manifest is outranked by the record, so a manifest whose mode
  // moved under the run cannot move the resumed run either.
  const manifested = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    runState,
    runManifest: {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      cfc: { enforcementMode: "enforce-strict" },
    },
  });
  assertEquals(manifested.config.cfcEnforcementMode, "observe");
  assertEquals(manifested.config.cfcEnforcementModeSource, "inherited");
});

Deno.test("CfHarnessEngine refuses to resume under a fabric session raised above the recorded CFC enforcement mode", () => {
  // A session at enforce-strict raises the harness loop to meet it, which on
  // a resume is a mode the loop cannot move to. The recorded-posture guard
  // does not reach this pair: the run recorded no fabric session, and the new
  // session names no posture bundle.
  const runState = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    cfcEnforcementModeOverride: "observe",
  }).getRunState();
  assertEquals(runState.fabricSessionCfc, undefined);

  const strictSession = {
    apiUrl: "https://fabric.test",
    identityKeyPath: "/keys/identity.pkcs8",
    space: "demo",
    cfcEnforcementMode: "enforce-strict",
  } as const;
  // The message names the session dial, because that is the one to lower:
  // every value of the harness dial is refused here, the weaker ones by the
  // resolver and `enforce-strict` by the recorded mode.
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        runState,
        fabricSession: strictSession,
        fabricSessionFactory: () =>
          Promise.reject(new Error("never built in this test")),
      }),
    Error,
    "resumed run CFC enforcement mode observe does not match the enforce-strict its fabric session raises the harness dial to; lower --fabric-cfc-enforcement-mode to resume this run",
  );

  // The same session over a run that already enforces strictly raises
  // nothing, so the recorded mode stands and the resume is credited to the
  // record rather than to the session.
  const strictRunState = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    cfcEnforcementModeOverride: "enforce-strict",
  }).getRunState();
  assertEquals(strictRunState.cfcEnforcementMode, "enforce-strict");
  const resumed = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    runState: strictRunState,
    fabricSession: strictSession,
    fabricSessionFactory: () =>
      Promise.reject(new Error("never built in this test")),
  });
  assertEquals(resumed.config.cfcEnforcementMode, "enforce-strict");
  assertEquals(resumed.config.cfcEnforcementModeSource, "inherited");
});

Deno.test("CfHarnessEngine refuses a run state recorded before the CFC enforcement mode was", () => {
  // The resume reads the recorded mode to resolve against, so a run state too
  // old to carry one is refused for what it is, rather than reported as a
  // mismatch against a mode it never named.
  const legacy = assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: {
          runId: "run-legacy-cfc",
          status: "completed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:01.000Z",
          currentDir: "/workspace",
          policyEvents: [],
          toolOutputs: [],
          failureRecords: [],
        } as unknown as HarnessRunState,
      }),
    HarnessControlError,
    "run state is missing cfcEnforcementMode; older cf-harness runs cannot be resumed",
  );
  assertEquals(legacy.code, "provider-mismatch");
});

Deno.test("a refused resume names the dials without publishing the posture record", () => {
  // The refusal message leaves the harness — a host that asks for structured
  // failures puts it on stderr and in an HTTP response body — while the
  // posture record lists every sink the runtime governs and every deviation
  // it publishes, and a read ceiling's clauses name spaces. So the message
  // names those without printing them, and names outright the dials an
  // operator can move. Every session dial pinned below is read back by the
  // assertion on the message it produces.

  const posturedSession = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcPosture: "max-enforcement",
  } as const;
  const runState = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: posturedSession,
  }).getRunState();

  const dials = assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: {
          apiUrl: posturedSession.apiUrl,
          identityKeyPath: posturedSession.identityKeyPath,
          space: posturedSession.space,
        },
        runState,
      }),
    HarnessControlError,
    "posture bundle (max-enforcement against none)",
  );
  assertEquals(dials.code, "provider-mismatch");
  assertEquals(dials.message.includes("policyDigest"), false);

  const drifted = structuredClone(runState) as {
    fabricSessionCfc?: { record?: { writeFloor: { rung: string } } };
  } & typeof runState;
  drifted.fabricSessionCfc!.record!.writeFloor.rung = "off";
  const record = assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: posturedSession,
        runState: drifted,
      }),
    HarnessControlError,
    "the runtime posture record the dials resolve to",
  );
  assertEquals(record.code, "provider-mismatch");
  assertEquals(record.message.includes("writeFloor"), false);

  const ceilinged = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: {
      ...posturedSession,
      cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
    },
  }).getRunState();
  const ceiling = assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: {
          ...posturedSession,
          cfcReadMaxConfidentiality: ["did:key:zOwner"],
        },
        runState: ceilinged,
      }),
    HarnessControlError,
    "read ceiling (2 clauses against 1 clause)",
  );
  assertEquals(ceiling.code, "provider-mismatch");
  assertEquals(ceiling.message.includes("did:key:"), false);
});

Deno.test("a run recorded without a working directory is refused, not reported as a fault", () => {
  // The refusal is deliberate — such a run predates what a resume needs — so
  // the operator is told that, rather than that the harness broke.

  const runState = new CfHarnessEngine({ workspaceHostPath: "/host/project" })
    .getRunState();
  const legacy = structuredClone(runState) as
    & Omit<HarnessRunState, "currentDir">
    & { currentDir?: string };
  delete legacy.currentDir;

  const refusal = assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        runState: legacy as HarnessRunState,
      }),
    HarnessControlError,
    "run state is missing currentDir",
  );
  assertEquals(refusal.code, "provider-mismatch");
});

Deno.test("CfHarnessEngine grants no well-known handles without a fabric session", async () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
  });
  assertEquals(await engine.establishWellKnownGrants(), []);
  assertEquals(engine.getRunState().wellKnownGrants, undefined);
  assertEquals(engine.handleTable, undefined);
});

Deno.test("CfHarnessEngine seeds the piece-registry grant once and replays the record", async () => {
  const registrySpace =
    "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const registryId = `of:fid1:${"C".repeat(43)}`;
  let registryReads = 0;
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSessionFactory: () =>
      Promise.resolve(
        {
          pieces: {
            getSpace: () => registrySpace,
            getDefaultPattern: (_runIt: boolean) => {
              registryReads += 1;
              return Promise.resolve({
                getMetaRaw: () => undefined,
                key: (segment: string) => ({
                  getAsNormalizedFullLink: () => ({
                    space: registrySpace,
                    id: registryId,
                    path: [segment],
                  }),
                }),
              });
            },
          },
          // deno-lint-ignore no-explicit-any
        } as any,
      ),
  });

  const granted = await engine.establishWellKnownGrants();
  assertEquals(granted.length, 1);
  assertEquals(granted[0]!.name, "piece-registry");
  assertEquals(granted[0]!.ref, `/${registryId}/pieceRegistry`);
  assertEquals(engine.getRunState().wellKnownGrants, granted);
  assertEquals(engine.handleTable?.entries.length, 1);

  // A second establishment answers from the record without another resolve.
  assertEquals(await engine.establishWellKnownGrants(), granted);
  assertEquals(registryReads, 1);
});

Deno.test("CfHarnessEngine mints operator input cells once and replays the record", async () => {
  const cellSpace = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
  const cellRef = `/of:fid1:${"D".repeat(43)}/travellerName`;
  let spaceReads = 0;
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    inputCells: [{
      name: "travellerName",
      ref: cellRef,
    }],
    fabricSessionFactory: () =>
      Promise.resolve(
        {
          pieces: {
            getSpace: () => {
              spaceReads += 1;
              return cellSpace;
            },
            // This double names no space: the cells here are plain
            // references, which resolve without one.
            getSpaceName: () => undefined,
          },
          // deno-lint-ignore no-explicit-any
        } as any,
      ),
  });

  const inputCells = await engine.establishInputCells();
  assertEquals(inputCells.length, 1);
  assertEquals(inputCells[0]!.name, "travellerName");
  assertEquals(inputCells[0]!.ref, cellRef);
  assertEquals(engine.getRunState().inputCells, inputCells);
  const entry = engine.handleTable?.entries.find(
    (candidate) => candidate.token === inputCells[0]!.token,
  );
  assertEquals(entry?.schema, undefined);
  assertEquals(entry?.schemaSource, undefined);

  // A second establishment answers from the record without another session.
  assertEquals(await engine.establishInputCells(), inputCells);
  assertEquals(spaceReads, 1);
});

Deno.test("CfHarnessEngine refuses operator input cells without a fabric session", async () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    inputCells: [{
      name: "travellerName",
      ref: `/of:fid1:${"D".repeat(43)}/travellerName`,
    }],
  });
  await assertRejects(
    () => engine.establishInputCells(),
    Error,
    "requires a fabric session",
  );
  assertEquals(engine.getRunState().inputCells, undefined);
});

Deno.test("CfHarnessEngine refuses an operator input cell into another space, recording nothing", async () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    inputCells: [{
      name: "foreign",
      ref: `/@did:key:z6MkforeignSpaceForEngineSeedTest/of:fid1:${
        "E".repeat(43)
      }/x`,
    }],
    fabricSessionFactory: () =>
      Promise.resolve(
        {
          pieces: {
            getSpace: () =>
              "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
            getSpaceName: () => undefined,
          },
          // deno-lint-ignore no-explicit-any
        } as any,
      ),
  });
  await assertRejects(
    () => engine.establishInputCells(),
    Error,
    "targets another space",
  );
  assertEquals(engine.getRunState().inputCells, undefined);
  assertEquals(engine.handleTable, undefined);
});

Deno.test("CfHarnessEngine resolves a named piece address through the session's own space", async () => {
  // The engine hands the mint the LIVE session's space name and the live
  // session's resolver. Both are read here: a slug is resolved against
  // this session and nothing else, so the resolution the engine wires up
  // is the one whose space the name was checked against.
  const asked: string[] = [];
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    inputCells: [{ name: "pattern_1", ref: "pattern:demo-space/reading-list" }],
    fabricSessionFactory: () =>
      Promise.resolve(
        {
          pieces: {
            getSpace: () =>
              "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
            getSpaceName: () => "demo-space",
            // What `resolvePieceAddress` reaches for first. A runtime this
            // double does not have is a slug this space cannot resolve,
            // which is the failure the run has to report as its own.
            get runtime(): never {
              asked.push("reading-list");
              throw new Error("no runtime in this session");
            },
          },
          // deno-lint-ignore no-explicit-any
        } as any,
      ),
  });
  await assertRejects(
    () => engine.establishInputCells(),
    Error,
    "names the piece `reading-list`, which this space does not hold",
  );
  // The resolver the engine wired was the session's own, and it was asked
  // for the slug rather than for the address the caller wrote.
  assertEquals(asked, ["reading-list"]);
  assertEquals(engine.getRunState().inputCells, undefined);
  assertEquals(engine.handleTable, undefined);
});

Deno.test("CfHarnessEngine refuses a piece address naming a space that is not the session's", async () => {
  const engine = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    inputCells: [{
      name: "pattern_1",
      ref: "pattern:other-space/reading-list",
    }],
    fabricSessionFactory: () =>
      Promise.resolve(
        {
          pieces: {
            getSpace: () =>
              "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
            getSpaceName: () => "demo-space",
          },
          // deno-lint-ignore no-explicit-any
        } as any,
      ),
  });
  await assertRejects(
    () => engine.establishInputCells(),
    Error,
    "this session runs in `demo-space`",
  );
  assertEquals(engine.getRunState().inputCells, undefined);
});

Deno.test("CfHarnessEngine rejects only cross-model Codex resume", () => {
  const resumedState = (
    modelProvider: "openai-codex" | "openai-compatible-gateway",
  ): HarnessRunState => ({
    runId: `resume-${modelProvider}`,
    status: "failed",
    createdAt: "2026-07-23T20:00:00.000Z",
    updatedAt: "2026-07-23T20:00:01.000Z",
    cfcEnforcementMode: "disabled",
    currentDir: "/workspace",
    model: "gpt-recorded",
    modelProvider,
    ...(modelProvider === "openai-codex"
      ? { credentialOwnerKey: "local" }
      : {}),
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [],
  });

  new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runState: resumedState("openai-codex"),
    model: "gpt-recorded",
    credentialOwnerKey: "local",
  });
  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: resumedState("openai-codex"),
        model: "gpt-different",
        credentialOwnerKey: "local",
      }),
    Error,
    "resumed openai-codex run model gpt-recorded does not match requested model gpt-different",
  );
  new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runState: resumedState("openai-compatible-gateway"),
    model: "gpt-different",
    gatewayAuthMode: "none",
  });
});

Deno.test("CfHarnessEngine rejects direct subagent resume but permits new child creation", () => {
  const lineage = {
    role: "subagent" as const,
    rootRunId: "root-run",
    parentRunId: "parent-run",
    parentToolCallId: "call-delegate",
    depth: 1,
  };
  const resumedState: HarnessRunState = {
    runId: "child-run",
    status: "failed",
    createdAt: "2026-07-23T20:00:00.000Z",
    updatedAt: "2026-07-23T20:00:01.000Z",
    cfcEnforcementMode: "disabled",
    currentDir: "/workspace",
    model: "gpt-recorded",
    modelProvider: "openai-codex",
    credentialOwnerKey: "local",
    lineage,
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [],
  };

  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: resumedState,
        credentialOwnerKey: "local",
      }),
    Error,
    "resumed subagent run child-run requires trusted parent resume context",
  );

  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: resumedState,
        credentialOwnerKey: "local",
        subagentResumeContext: {
          type: "cf-harness.subagent-resume-context",
          version: 1,
          rootRunId: lineage.rootRunId,
          parentRunId: "different-parent",
          parentToolCallId: lineage.parentToolCallId,
        },
      }),
    Error,
    "does not match trusted parent resume context",
  );

  const resumedChild = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runState: resumedState,
    credentialOwnerKey: "local",
    subagentResumeContext: {
      type: "cf-harness.subagent-resume-context",
      version: 1,
      rootRunId: lineage.rootRunId,
      parentRunId: lineage.parentRunId,
      parentToolCallId: lineage.parentToolCallId,
    },
    structuredResult: {
      path: "/tmp/result.json",
      schema: { type: "object" },
    },
  });
  assertEquals(resumedChild.getRunState().runId, resumedState.runId);
  assertEquals(resumedChild.structuredResultAvailable, false);

  const newChild = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "new-child-run",
    lineage,
    modelProvider: "openai-codex",
    credentialOwnerKey: "local",
  });
  assertEquals(newChild.getRunState().lineage, lineage);
});

Deno.test("CfHarnessEngine refuses to run a tool in enforce mode without CFC transports", async () => {
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-explicit",
  });
  await assertRejects(
    () => engine.invokeBuiltinTool("bash", { command: "echo hi" }),
    Error,
    "requires the runsc sandbox to wire",
  );
});

Deno.test("CfHarnessEngine refuses to run capability probes in enforce mode without CFC transports", async () => {
  // The prompt loop initializes diagnostics before the first model turn, and
  // the capability probes execute scripts inside the sandbox — so the
  // transport floor must fire before any sandbox execution, not only at the
  // first builtin tool call. The probe error swallowing inside diagnostics
  // init must not absorb the floor violation into a failure record.
  const runner = new FakeProcessRunner();
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-explicit",
    processRunner: runner,
  });
  await assertRejects(
    () => engine.ensureDiagnosticsInitialized(),
    Error,
    "requires the runsc sandbox to wire",
  );
  // Nothing reached the docker lifecycle: the run failed closed before any
  // sandbox execution.
  assertEquals(runner.calls.length, 0);
});

Deno.test("CfHarnessEngine runs a tool in enforce mode when CFC transports are wired", async () => {
  const cfcResultDir = await Deno.makeTempDir({ prefix: "cf-harness-result-" });
  const cfcInvocationContextDir = await Deno.makeTempDir({
    prefix: "cf-harness-ctx-",
  });
  const runner = new FakeProcessRunner([
    { stdout: "container-1\n", stderr: "", exitCode: 0 },
    { stdout: "hi\n", stderr: "", exitCode: 0 },
    { stdout: "0\n", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-explicit",
    cfcResultDir,
    cfcInvocationContextDir,
    processRunner: runner,
  });
  // The guard does not fire; execution reaches the (faked) docker lifecycle
  // (the exact mediated output is covered elsewhere — here we only assert the
  // transport floor lets the run proceed and an outputId is produced).
  const result = await engine.invokeBuiltinTool("bash", { command: "echo hi" });
  assertEquals(typeof result.output.outputId, "string");
});

Deno.test("CfHarnessEngine does not apply the CFC transport floor to an injected sandbox runtime", async () => {
  // An injected sandboxRuntime is the thing that actually executes and carries
  // its own enforcement guarantees. The engine must not validate the *resolved
  // config's* transports against it: that config is unused here and may describe
  // a different sandbox, so doing so would falsely reject an otherwise valid
  // enforce-mode run. (Regression for the run-start transport floor.)
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath: "/host/project",
    cfcEnforcementMode: "enforce-strict",
    // A docker-runsc-cfc config with no CFC sidecar transports wired.
    sandbox: resolveDockerRunscSandboxConfig({
      workspaceHostPath: "/host/project",
    }),
    sandboxRuntime: new FakeSandboxRuntime(),
  });
  const result = await engine.invokeBuiltinTool("bash", { command: "echo hi" });
  assertEquals(typeof result.output.outputId, "string");
});

Deno.test("CfHarnessEngine runs browser actions on the host with the configured lease", async () => {
  const workspaceHostPath = await Deno.makeTempDir({
    prefix: "cf-harness-engine-browser-",
  });
  const runner = new FakeProcessRunner([{
    stdout: "Example Domain\n",
    stderr: "",
    exitCode: 0,
  }]);
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath,
    sandboxRuntime: new FakeSandboxRuntime(),
    processRunner: runner,
    browserAccess: {
      type: "cf-harness.chat.browser-access-lease",
      leaseId: "lease-1",
      cdpUrl: "http://localhost:9362",
    },
    now: () => "2026-04-29T23:20:00.000Z",
  });

  const result = await engine.invokeBuiltinTool("browser", {
    action: "get",
    kind: "title",
  });

  assertEquals(runner.calls, [{
    command: "agent-browser",
    args: ["--cdp", "http://localhost:9362", "get", "title"],
    cwd: workspaceHostPath,
    clearEnv: true,
    env: { PATH: runner.calls[0]!.env!.PATH },
    timeoutMs: 30_000,
  }]);
  assertEquals(result.output, {
    outputId: "run-1:browser:1",
    status: "ok",
    output: "Example Domain\n",
  });
});

Deno.test("CfHarnessEngine refuses browser actions when no lease is configured", async () => {
  const workspaceHostPath = await Deno.makeTempDir({
    prefix: "cf-harness-engine-browser-noleases-",
  });
  const runner = new FakeProcessRunner();
  const engine = new CfHarnessEngine({
    runId: "run-1",
    workspaceHostPath,
    sandboxRuntime: new FakeSandboxRuntime(),
    processRunner: runner,
    now: () => "2026-04-29T23:20:00.000Z",
  });

  const result = await engine.invokeBuiltinTool("browser", {
    action: "snapshot",
  });

  assertEquals(runner.calls, []);
  assertEquals(result.output, {
    outputId: "run-1:browser:1",
    status: "error",
    code: "lease_unavailable",
    message: "browser requires a Browser Access lease, and this run has none",
  });
});

Deno.test("CfHarnessEngine reserves artifact roots through host realpath mapping", async () => {
  const workspaceHostPath = await Deno.makeTempDir({
    prefix: "cf-harness-engine-artifacts-",
  });
  try {
    const artifactRoot = `${workspaceHostPath}/.cf-harness-artifacts`;
    const artifactLink = `${workspaceHostPath}/artifact-link`;
    await Deno.mkdir(artifactRoot, { recursive: true });
    await Deno.symlink(artifactRoot, artifactLink, { type: "dir" });
    const sandbox = new FakeSandboxRuntime();
    const hostRunner = new FakeProcessRunner();
    const engine = new CfHarnessEngine({
      runId: "run-artifact-reserved",
      workspaceHostPath,
      artifactRoot,
      sandboxRuntime: sandbox,
      processRunner: hostRunner,
      now: (() => {
        const timestamps = [
          "2026-05-01T17:55:00.000Z",
          "2026-05-01T17:55:01.000Z",
          "2026-05-01T17:55:02.000Z",
          "2026-05-01T17:55:03.000Z",
          "2026-05-01T17:55:04.000Z",
          "2026-05-01T17:55:05.000Z",
          "2026-05-01T17:55:06.000Z",
        ];
        return () => timestamps.shift() ?? "2026-05-01T17:55:07.000Z";
      })(),
    });

    const readResult = await engine.invokeBuiltinTool("read_file", {
      path: "artifact-link/run-state.json",
    });

    assertEquals(readResult.output, {
      outputId: createToolOutputId(
        "run-artifact-reserved",
        "read_file",
        1,
      ),
      path: "/workspace/artifact-link/run-state.json",
      ok: false,
      error: {
        type: "cf-harness.structured-file-tool-error",
        code: "permission_denied",
        message: "permission denied: /workspace/artifact-link/run-state.json",
        path: "/workspace/artifact-link/run-state.json",
        detail: RESERVED_ARTIFACT_PATH_DETAIL,
      },
    });
    assertEquals(hostRunner.calls, []);
    assertEquals(sandbox.shellRequests.length, 1);
    assertEquals(
      sandbox.shellRequests.every((request) =>
        request.command.includes(CAPABILITY_PROBE_SENTINEL)
      ),
      true,
    );
  } finally {
    await Deno.remove(workspaceHostPath, { recursive: true });
  }
});

Deno.test("CfHarnessEngine records tool outputs into run state on success", async () => {
  const sandbox = new FakeSandboxRuntime([
    { stdout: "one\n", stderr: "", exitCode: 0 },
    { stdout: "two\n", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    sandboxRuntime: sandbox,
    runId: "run-1",
    // The run-state assertions below read this dial back.
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:00:00.000Z",
        "2026-04-15T19:00:01.000Z",
        "2026-04-15T19:00:02.000Z",
        "2026-04-15T19:00:03.000Z",
        "2026-04-15T19:00:04.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:00:05.000Z";
    })(),
  });

  const first = await engine.invokeBuiltinTool("bash", { command: "echo one" });
  const second = await engine.invokeBuiltinTool("bash", {
    command: "echo two",
  });

  assertEquals(first.resultRef, {
    type: "cf-harness.tool-result-ref",
    outputId: createToolOutputId("run-1", "bash", 1),
    toolId: "bash",
    runId: "run-1",
  });
  assertEquals(second.resultRef, {
    type: "cf-harness.tool-result-ref",
    outputId: createToolOutputId("run-1", "bash", 2),
    toolId: "bash",
    runId: "run-1",
  });
  assertEquals(engine.getRunState().runId, "run-1");
  // A tool call is a step of the run, not its outcome: the status is the
  // driver's to write, and nothing here has ended the run.
  assertEquals(engine.getRunState().status, "pending");
  assertEquals(engine.getRunState().createdAt, "2026-04-15T19:00:00.000Z");
  assertEquals(engine.getRunState().updatedAt, "2026-04-15T19:00:05.000Z");
  assertEquals(engine.getRunState().endedAt, undefined);
  assertEquals(engine.getRunState().terminalReason, undefined);
  assertEquals(engine.getRunState().cfcEnforcementMode, "observe");
  assertEquals(engine.getRunState().currentDir, "/workspace");
  assertEquals(engine.getRunState().policyEvents, []);
  assertEquals(engine.getRunState().toolOutputs, [
    first.resultRef,
    second.resultRef,
  ]);
  assertEquals(engine.getRunState().failureRecords, []);
  assertEquals(
    engine.getRunState().capabilitySnapshot?.commands.python.present,
    false,
  );
  assertEquals(
    engine.getRunState().capabilitySnapshot?.commands.python3.path,
    "/usr/bin/python3",
  );
});

Deno.test("CfHarnessEngine records prompt slot binding into run state", () => {
  const promptSlotBinding = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "test.prompt-slot", subject: "engine-test" },
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "test",
    subject: "engine-test",
    eventId: "event-engine",
  } as const;
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-prompt-slot",
    now: (() => {
      const timestamps = [
        "2026-04-17T19:00:00.000Z",
        "2026-04-17T19:00:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T19:00:02.000Z";
    })(),
  });

  engine.setPromptSlotBinding(promptSlotBinding);

  assertEquals(engine.getRunState().promptSlotBinding, promptSlotBinding);
  assertEquals(engine.getRunState().updatedAt, "2026-04-17T19:00:01.000Z");
});

Deno.test("CfHarnessEngine derives prompt-slot labels for model-authored sandbox invocation inputs", async () => {
  const promptSlotBinding = {
    type: CFC_PROMPT_SLOT_BOUND_ATOM_TYPE,
    source: { type: "test.prompt-slot", subject: "engine-label-test" },
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "test",
    eventId: "event-engine-label",
  } as const;
  const sandbox = new FakeSandboxRuntime([
    { stdout: "", stderr: "", exitCode: 0 },
    { stdout: "", stderr: "", exitCode: 0 },
  ]);
  const engine = new CfHarnessEngine({
    sandboxRuntime: sandbox,
    runId: "run-prompt-slot-labels",
    now: (() => {
      const timestamps = [
        "2026-04-17T19:05:00.000Z",
        "2026-04-17T19:05:01.000Z",
        "2026-04-17T19:05:02.000Z",
        "2026-04-17T19:05:03.000Z",
        "2026-04-17T19:05:04.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T19:05:05.000Z";
    })(),
  });

  engine.setPromptSlotBinding(promptSlotBinding);
  await engine.invokeBuiltinTool("bash", {
    command: "printf hello",
    cwd: "task-dir",
  });
  await engine.invokeBuiltinTool("write_file", {
    path: "notes.md",
    content: "hello from prompt",
  });

  const expectedAtom = {
    type: CF_HARNESS_PROMPT_SLOT_INFLUENCE_ATOM_TYPE,
    version: 1,
    role: "direct-command",
    kernelName: "cf-harness",
    surface: "test",
    eventId: "event-engine-label",
  };
  assertEquals(
    engine.getRunState().cfcInvocationContexts?.map((context) => ({
      toolId: context.toolId,
      inputLabels: context.cfcInputLabels,
      influenceLabels: context.promptSlotInfluenceLabels,
    })),
    [
      {
        toolId: "bash",
        inputLabels: undefined,
        influenceLabels: {
          version: 1,
          entries: [
            {
              path: ["command"],
              label: { integrity: [expectedAtom] },
            },
            {
              path: ["cwd"],
              label: { integrity: [expectedAtom] },
            },
          ],
        },
      },
      {
        toolId: "write_file",
        inputLabels: undefined,
        influenceLabels: {
          version: 1,
          entries: [
            {
              path: ["args"],
              label: { integrity: [expectedAtom] },
            },
            {
              path: ["stdin"],
              label: { integrity: [expectedAtom] },
            },
          ],
        },
      },
    ],
  );
});

Deno.test("CfHarnessEngine stamps policy snapshot state changes with mutation time", async () => {
  const persistedStates: HarnessRunState[] = [];
  const runRoot = "/tmp/cf-harness-artifacts/run-policy-time";
  const artifactStore: HarnessArtifactStore = {
    artifactRoot: "/tmp/cf-harness-artifacts",
    runRoot,
    persistRunState(state) {
      persistedStates.push(structuredClone(state));
      return Promise.resolve(`${runRoot}/run-state.json`);
    },
    persistTranscript() {
      return Promise.resolve(`${runRoot}/transcript.json`);
    },
    persistCapabilitySnapshot() {
      return Promise.resolve(`${runRoot}/capabilities.json`);
    },
    persistCfcPolicySnapshot() {
      return Promise.reject(new Error("snapshot persist boom"));
    },
    persistPolicyTrace() {
      return Promise.resolve(`${runRoot}/policy-trace.json`);
    },
    persistRunReport() {
      return Promise.resolve(`${runRoot}/run-report.json`);
    },
    persistToolOutput() {
      return Promise.resolve(`${runRoot}/tool-output.json`);
    },
  };
  const engine = new CfHarnessEngine({
    artifactStore,
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-policy-time",
    now: (() => {
      const timestamps = [
        "2026-04-17T20:30:00.000Z",
        "2026-04-17T20:30:01.000Z",
        "2026-04-17T20:30:02.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T20:30:03.000Z";
    })(),
  });
  const snapshot = createHarnessCfcPolicySnapshot({
    runId: "run-policy-time",
    generatedAt: "2026-04-17T20:00:00.000Z",
    cfcEnforcementMode: "observe",
    cfcEnforcementModeSource: "default",
    promptSlotBindingSource: "absent",
    parentToolAllowance: "restricted",
    allowedToolIds: ["read_file"],
    allowedSubagentProfiles: [],
    subagentProfileConfigs: [],
  });

  const snapshotPath = await engine.persistCfcPolicySnapshot(snapshot);

  assertEquals(snapshotPath, undefined);
  assertEquals(engine.getRunState().cfcPolicySnapshot, snapshot);
  assertEquals(engine.getRunState().cfcPolicySnapshotPath, undefined);
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.source,
    "policy_snapshot",
  );
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.at,
    "2026-04-17T20:30:01.000Z",
  );
  assertEquals(engine.getRunState().updatedAt, "2026-04-17T20:30:02.000Z");
  assertEquals(
    persistedStates.at(-1)?.updatedAt,
    "2026-04-17T20:30:02.000Z",
  );
});

Deno.test("CfHarnessEngine persists skill resource read artifacts", async () => {
  const persistedStates: HarnessRunState[] = [];
  const persistedReads: HarnessSkillResourceReads[] = [];
  const runRoot = "/tmp/cf-harness-artifacts/run-skill-resource-read";
  const artifactStore: HarnessArtifactStore = {
    artifactRoot: "/tmp/cf-harness-artifacts",
    runRoot,
    persistRunState(state) {
      persistedStates.push(structuredClone(state));
      return Promise.resolve(`${runRoot}/run-state.json`);
    },
    persistTranscript() {
      return Promise.resolve(`${runRoot}/transcript.json`);
    },
    persistCapabilitySnapshot() {
      return Promise.resolve(`${runRoot}/capabilities.json`);
    },
    persistCfcPolicySnapshot() {
      return Promise.resolve(`${runRoot}/policy-snapshot.json`);
    },
    persistPolicyTrace() {
      return Promise.resolve(`${runRoot}/policy-trace.json`);
    },
    persistRunReport() {
      return Promise.resolve(`${runRoot}/run-report.json`);
    },
    persistSkillResourceReads(reads) {
      persistedReads.push(structuredClone(reads));
      return Promise.resolve(`${runRoot}/skill-resource-reads.json`);
    },
    persistToolOutput() {
      return Promise.resolve(`${runRoot}/tool-output.json`);
    },
  };
  const engine = new CfHarnessEngine({
    artifactStore,
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-skill-resource-read",
    now: (() => {
      const timestamps = [
        "2026-05-01T17:00:00.000Z",
        "2026-05-01T17:00:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-05-01T17:00:02.000Z";
    })(),
  });

  const path = await engine.recordSkillResourceRead({
    type: "cf-harness.skill-resource-read",
    outputId: "run-skill-resource-read:read_skill_resource:1",
    runId: "run-skill-resource-read",
    skillName: "pattern-dev",
    path: "references/guide.md",
    status: "read",
    readAt: "2026-05-01T17:00:01.000Z",
    cfcPromptRole: "context",
    diagnostics: [],
  });

  assertEquals(path, `${runRoot}/skill-resource-reads.json`);
  assertEquals(persistedReads, [{
    type: "cf-harness.skill-resource-reads",
    version: 1,
    generatedAt: "2026-05-01T17:00:01.000Z",
    reads: [{
      type: "cf-harness.skill-resource-read",
      outputId: "run-skill-resource-read:read_skill_resource:1",
      runId: "run-skill-resource-read",
      skillName: "pattern-dev",
      path: "references/guide.md",
      status: "read",
      readAt: "2026-05-01T17:00:01.000Z",
      cfcPromptRole: "context",
      diagnostics: [],
    }],
  }]);
  assertEquals(
    engine.getRunState().skillResourceReadsPath,
    `${runRoot}/skill-resource-reads.json`,
  );
  assertEquals(persistedStates.at(-1)?.skillResourceReadsPath, path);
});

Deno.test("CfHarnessEngine timestamps CFC invocation contexts with mutation time", async () => {
  const persistedStates: HarnessRunState[] = [];
  const runRoot = "/tmp/cf-harness-artifacts/run-cfc-invocation-time";
  const artifactStore: HarnessArtifactStore = {
    artifactRoot: "/tmp/cf-harness-artifacts",
    runRoot,
    persistRunState(state) {
      persistedStates.push(structuredClone(state));
      return Promise.resolve(`${runRoot}/run-state.json`);
    },
    persistTranscript() {
      return Promise.resolve(`${runRoot}/transcript.json`);
    },
    persistCapabilitySnapshot() {
      return Promise.resolve(`${runRoot}/capabilities.json`);
    },
    persistCfcPolicySnapshot() {
      return Promise.resolve(`${runRoot}/policy-snapshot.json`);
    },
    persistPolicyTrace() {
      return Promise.resolve(`${runRoot}/policy-trace.json`);
    },
    persistRunReport() {
      return Promise.resolve(`${runRoot}/run-report.json`);
    },
    persistToolOutput() {
      return Promise.resolve(`${runRoot}/tool-output.json`);
    },
  };
  const engine = new CfHarnessEngine({
    artifactStore,
    sandboxRuntime: new FakeSandboxRuntime([{
      stdout: "hello",
      stderr: "",
      exitCode: 0,
    }]),
    runId: "run-cfc-invocation-time",
    now: (() => {
      const timestamps = [
        "2026-04-17T21:00:00.000Z",
        "2026-04-17T21:00:01.000Z",
        "2026-04-17T21:00:02.000Z",
        "2026-04-17T21:00:03.000Z",
        "2026-04-17T21:00:04.000Z",
        "2026-04-17T21:00:05.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-17T21:00:06.000Z";
    })(),
  });

  await engine.invokeBuiltinTool("read_file", { path: "notes/todo.txt" });

  const invocationState = persistedStates.find((state) =>
    state.cfcInvocationContexts?.length === 1 &&
    state.toolOutputs.length === 0
  );
  assertEquals(invocationState?.updatedAt, "2026-04-17T21:00:03.000Z");
  assertEquals(
    invocationState?.cfcInvocationContexts?.[0]?.createdAt,
    "2026-04-17T21:00:03.000Z",
  );
  assertEquals(engine.getRunState().updatedAt, "2026-04-17T21:00:04.000Z");
});

Deno.test("CfHarnessEngine records a tool invocation error without ending the run", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([], new Error("sandbox boom")),
    runId: "run-fail",
    // The run-state assertions below read this dial back.
    cfcEnforcementMode: "observe",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:10:00.000Z",
        "2026-04-15T19:10:01.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:10:02.000Z";
    })(),
  });

  await assertRejects(
    () => engine.invokeBuiltinTool("bash", { command: "false" }),
    Error,
    "sandbox boom",
  );

  assertEquals(engine.getRunState().runId, "run-fail");
  // The failure is on record for the driver to end the run on; the tool
  // call itself does not decide the run's outcome.
  assertEquals(engine.getRunState().status, "pending");
  assertEquals(engine.getRunState().createdAt, "2026-04-15T19:10:00.000Z");
  assertEquals(engine.getRunState().updatedAt, "2026-04-15T19:10:02.000Z");
  assertEquals(engine.getRunState().endedAt, undefined);
  assertEquals(engine.getRunState().terminalReason, undefined);
  assertEquals(engine.getRunState().cfcEnforcementMode, "observe");
  assertEquals(engine.getRunState().currentDir, "/workspace");
  assertEquals(engine.getRunState().policyEvents, []);
  assertEquals(engine.getRunState().toolOutputs, []);
  assertEquals(engine.getRunState().failureRecords?.length, 1);
  assertEquals(engine.getRunState().primaryFailure?.kind, "unknown");
});

Deno.test("CfHarnessEngine records recoverable file-tool failures without failing the run", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([{
      stdout: "",
      stderr: "file not found: /workspace/notes/missing.txt",
      exitCode: 10,
    }]),
    runId: "run-file-missing",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:15:00.000Z",
        "2026-04-15T19:15:01.000Z",
        "2026-04-15T19:15:02.000Z",
        "2026-04-15T19:15:03.000Z",
        "2026-04-15T19:15:04.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:15:05.000Z";
    })(),
  });

  const result = await engine.invokeBuiltinTool("read_file", {
    path: "notes/missing.txt",
  });

  assertEquals(result.output, {
    outputId: createToolOutputId("run-file-missing", "read_file", 1),
    path: "/workspace/notes/missing.txt",
    ok: false,
    error: {
      type: "cf-harness.structured-file-tool-error",
      code: "file_not_found",
      message: "file not found: /workspace/notes/missing.txt",
      path: "/workspace/notes/missing.txt",
      detail: "file not found: /workspace/notes/missing.txt",
      exitCode: 10,
    },
  });
  assertEquals(engine.getRunState().status, "pending");
  assertEquals(engine.getRunState().terminalReason, undefined);
  assertEquals(engine.getRunState().toolOutputs, [result.resultRef]);
  assertEquals(engine.getRunState().failureRecords?.length, 1);
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.kind,
    "file_not_found",
  );
  assertEquals(engine.getRunState().failureRecords?.[0]?.source, "tool_output");
  assertEquals(engine.getRunState().failureRecords?.[0]?.toolId, "read_file");
  assertEquals(
    engine.getRunState().failureRecords?.[0]?.outputId,
    createToolOutputId("run-file-missing", "read_file", 1),
  );
  assertEquals(engine.getRunState().primaryFailure?.kind, "file_not_found");
});

Deno.test("CfHarnessEngine fails an interrupted run that has recorded a tool output", async () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime([
      { stdout: "done\n", stderr: "", exitCode: 0 },
    ]),
    runId: "run-interrupted",
    now: (() => {
      const timestamps = [
        "2026-04-15T19:20:00.000Z",
        "2026-04-15T19:20:01.000Z",
        "2026-04-15T19:20:02.000Z",
        "2026-04-15T19:20:03.000Z",
      ];
      return () => timestamps.shift() ?? "2026-04-15T19:20:04.000Z";
    })(),
  });

  await engine.invokeBuiltinTool("bash", { command: "echo done" });
  assertEquals(engine.getRunState().status, "pending");
  assertEquals(engine.getRunState().terminalReason, undefined);

  await engine.terminalizeInterruptedRun("SIGTERM");

  assertEquals(engine.getRunState().status, "failed");
  assertEquals(engine.getRunState().updatedAt, "2026-04-15T19:20:04.000Z");
  assertEquals(engine.getRunState().endedAt, "2026-04-15T19:20:04.000Z");
  assertEquals(engine.getRunState().terminalReason, "process_interrupted");
  assertEquals(engine.getRunState().failureRecords?.at(-1), {
    type: "cf-harness.failure-record",
    kind: "harness_error",
    source: "run_error",
    detail: "process received SIGTERM before the prompt loop completed",
    at: "2026-04-15T19:20:04.000Z",
  });
  assertEquals(engine.getRunState().primaryFailure?.kind, "harness_error");
});

Deno.test("CfHarnessEngine getRunState returns a deep clone", () => {
  const engine = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runState: {
      runId: "run-clone",
      status: "completed",
      createdAt: "2026-04-17T20:10:00.000Z",
      updatedAt: "2026-04-17T20:10:01.000Z",
      endedAt: "2026-04-17T20:10:01.000Z",
      terminalReason: "assistant_completed",
      cfcEnforcementMode: "observe",
      currentDir: "/workspace",
      policyEvents: [createHarnessPolicyEvent({
        severity: "warning",
        mode: "observe",
        toolId: "bash",
        detail: "warning detail",
        at: "2026-04-17T20:10:01.000Z",
      })],
      toolOutputs: [{
        type: "cf-harness.tool-result-ref",
        outputId: createToolOutputId("run-clone", "bash", 1),
        toolId: "bash",
        runId: "run-clone",
        artifactPath: "/tmp/original.json",
      }],
      failureRecords: [],
    },
  });

  const snapshot = engine.getRunState();
  snapshot.policyEvents[0].detail = "mutated";
  snapshot.toolOutputs[0].artifactPath = "/tmp/mutated.json";

  assertEquals(engine.getRunState(), {
    runId: "run-clone",
    status: "completed",
    createdAt: "2026-04-17T20:10:00.000Z",
    updatedAt: "2026-04-17T20:10:01.000Z",
    endedAt: "2026-04-17T20:10:01.000Z",
    terminalReason: "assistant_completed",
    cfcEnforcementMode: "observe",
    currentDir: "/workspace",
    policyEvents: [createHarnessPolicyEvent({
      severity: "warning",
      mode: "observe",
      toolId: "bash",
      detail: "warning detail",
      at: "2026-04-17T20:10:01.000Z",
    })],
    toolOutputs: [{
      type: "cf-harness.tool-result-ref",
      outputId: createToolOutputId("run-clone", "bash", 1),
      toolId: "bash",
      runId: "run-clone",
      artifactPath: "/tmp/original.json",
    }],
    failureRecords: [],
  });
});

Deno.test("CfHarnessEngine rejects legacy run state snapshots without currentDir", () => {
  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState: {
          runId: "run-legacy",
          status: "completed",
          createdAt: "2026-04-20T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:01.000Z",
          cfcEnforcementMode: "observe",
          policyEvents: [],
          toolOutputs: [],
          failureRecords: [],
        } as unknown as HarnessRunState,
      }),
    Error,
    "older cf-harness runs cannot be resumed",
  );
});

Deno.test("CfHarnessEngine keeps a resumed run's recorded provider authoritative", () => {
  const runState: HarnessRunState = {
    runId: "run-codex-resume-provider",
    status: "completed",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:01.000Z",
    cfcEnforcementMode: "disabled",
    currentDir: "/workspace",
    modelProvider: "openai-codex",
    modelAuthSource: "cf-harness-local-store",
    credentialOwnerKey: "loom:user-1",
    credentialOwner: {
      type: "cf-harness.credential-owner-ref",
      version: 1,
      ownerKey: "loom:user-1",
    },
    harnessHomeIdentity: "sha256:home-one",
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [],
  };

  const resumed = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runState,
  });
  assertEquals(resumed.config.modelProvider, "openai-codex");
  assertEquals(resumed.config.credentialOwnerKey, "loom:user-1");
  assertEquals(resumed.config.modelAuthSource, "cf-harness-local-store");
  assertEquals(resumed.config.credentialOwner, runState.credentialOwner);
  assertEquals(resumed.config.harnessHomeIdentity, "sha256:home-one");

  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState,
        modelProvider: "openai-compatible-gateway",
      }),
    Error,
    "does not match requested provider",
  );
  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState,
        modelProvider: "openai-codex",
        credentialOwnerKey: "loom:user-2",
      }),
    Error,
    "credential owner key does not match",
  );
  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState,
        credentialOwner: {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "loom:user-2",
        },
      }),
    Error,
    "credential owner does not match",
  );
  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState,
        harnessHomeIdentity: "sha256:home-two",
      }),
    Error,
    "harness home does not match",
  );
  assertThrows(
    () =>
      new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runState,
        modelAuthSource: "owner-bound-oauth",
      }),
    Error,
    "auth source does not match",
  );
});

Deno.test("CfHarnessEngine records the handle table and persists run state", async () => {
  const persistedStates: HarnessRunState[] = [];
  const runRoot = "/tmp/cf-harness-artifacts/run-handle-table";
  const artifactStore: HarnessArtifactStore = {
    artifactRoot: "/tmp/cf-harness-artifacts",
    runRoot,
    persistRunState(state) {
      persistedStates.push(structuredClone(state));
      return Promise.resolve(`${runRoot}/run-state.json`);
    },
    persistTranscript() {
      return Promise.resolve(`${runRoot}/transcript.json`);
    },
    persistCapabilitySnapshot() {
      return Promise.resolve(`${runRoot}/capabilities.json`);
    },
    persistCfcPolicySnapshot() {
      return Promise.resolve(`${runRoot}/cfc-policy-snapshot.json`);
    },
    persistPolicyTrace() {
      return Promise.resolve(`${runRoot}/policy-trace.json`);
    },
    persistRunReport() {
      return Promise.resolve(`${runRoot}/run-report.json`);
    },
    persistToolOutput() {
      return Promise.resolve(`${runRoot}/tool-output.json`);
    },
  };
  const engine = new CfHarnessEngine({
    artifactStore,
    sandboxRuntime: new FakeSandboxRuntime(),
    runId: "run-handle-table",
  });
  const { table } = await mintAddressHandle(
    createHarnessHandleTable("run-handle-table"),
    `/of:fid1:${"A".repeat(43)}/items`,
  );

  await engine.recordHandleTable(table);

  assertEquals(engine.getRunState().handleTable, table);
  assertEquals(engine.handleTable, table);
  assertEquals(persistedStates.at(-1)?.handleTable, table);
});

Deno.test("CfHarnessEngine exposes a handle table carried by a resumed run state", async () => {
  const { table } = await mintAddressHandle(
    createHarnessHandleTable("run-resumed-handles"),
    `/of:fid1:${"B".repeat(43)}`,
  );
  const runState: HarnessRunState = {
    runId: "run-resumed-handles",
    status: "running",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:01.000Z",
    cfcEnforcementMode: "disabled",
    currentDir: "/workspace",
    handleTable: table,
    policyEvents: [],
    toolOutputs: [],
    failureRecords: [],
  };

  const resumed = new CfHarnessEngine({
    sandboxRuntime: new FakeSandboxRuntime(),
    runState,
  });

  assertEquals(resumed.handleTable, table);
});

Deno.test("CfHarnessEngine records the fabric session's read ceiling in run state and refuses to resume under another", () => {
  const boundedSession = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
    cfcReadOnExceed: "skip",
    // The dial the run-state comparison below reads back. Every session this
    // case builds carries it, so the read ceiling is the only thing the
    // refused resumes differ on.
    cfcEnforcementMode: "enforce-strict",
  } as const;
  const runState = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: boundedSession,
  }).getRunState();
  const recorded = runState.fabricSessionCfc;
  assertExists(recorded);
  // Every field of the published posture but the flow-labels rung, which the
  // `fabricSessionCfcFlowLabels()` cases in `test/cfc-posture.test.ts` read.
  // No session here states that dial, so the source is `default`.
  const { flowLabels: _rung, ...ceiling } = recorded;
  assertEquals(ceiling, {
    enforcementMode: "enforce-strict",
    enforcementModeSource: "configured",
    flowLabelsSource: "default",
    readMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
    readOnExceed: "skip",
    readMaxConfidentialitySource: "session",
    record: recordFor(boundedSession),
  });

  // The same bounded session resumes cleanly.
  const resumed = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: boundedSession,
    runState,
  });
  assertEquals(
    resumed.getRunState().fabricSessionCfc?.readMaxConfidentiality,
    ["did:key:zOwner", "did:key:zFacet"],
  );

  // A resume that would run the session unbounded, or under another ceiling,
  // contradicts what the artifacts attest.
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: {
          apiUrl: boundedSession.apiUrl,
          identityKeyPath: boundedSession.identityKeyPath,
          space: boundedSession.space,
          cfcEnforcementMode: boundedSession.cfcEnforcementMode,
        },
        runState,
      }),
    Error,
    "fabric session CFC posture mismatch on resume",
  );
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: {
          ...boundedSession,
          cfcReadMaxConfidentiality: ["did:key:zOwner"],
        },
        runState,
      }),
    Error,
    "fabric session CFC posture mismatch on resume",
  );
  assertThrows(
    () =>
      new CfHarnessEngine({
        workspaceHostPath: "/host/project",
        fabricSession: { ...boundedSession, cfcReadOnExceed: "fail" },
        runState,
      }),
    Error,
    "fabric session CFC posture mismatch on resume",
  );
});

Deno.test("CfHarnessEngine records the same read ceiling in a delegated child as in its parent", () => {
  const runManifest = {
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    cfc: {
      maxConfidentiality: [
        "did:key:zO",
        { type: "Facet", owner: "did:key:zO", id: "work" },
      ],
      onExceed: "skip" as const,
    },
  };
  const parent = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
      cfcReadMaxConfidentiality: ["did:key:zO", "did:key:zX"],
    },
    runManifest,
  });
  // The shape a delegating parent builds its child with: the parent's
  // resolved session config beside the shared session factory, and the
  // same manifest.
  const child = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: parent.config.fabricSession,
    fabricSessionFactory: () =>
      Promise.reject(new Error("never built in this test")),
    inheritedFabricSessionPosture: parent.getRunState().fabricSessionCfc!
      .record,
    runManifest,
  });
  const grandchild = new CfHarnessEngine({
    workspaceHostPath: "/host/project",
    fabricSession: child.config.fabricSession,
    fabricSessionFactory: () =>
      Promise.reject(new Error("never built in this test")),
    runManifest,
  });
  const recorded = parent.getRunState().fabricSessionCfc!;
  assertEquals(
    child.getRunState().fabricSessionCfc?.readMaxConfidentiality,
    recorded.readMaxConfidentiality,
  );
  assertEquals(
    grandchild.getRunState().fabricSessionCfc?.readMaxConfidentiality,
    recorded.readMaxConfidentiality,
  );
  assertEquals(child.getRunState().fabricSessionCfc?.readOnExceed, "skip");
});
