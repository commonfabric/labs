import { checkoutDocsCorpusRoots } from "../src/docs-corpus/corpus.ts";
import { resolveHarnessSkillsRoot } from "../src/skills/root.ts";
import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import type { CfcConfClause } from "@commonfabric/runner/cfc";
import {
  type CfcEnforcementMode,
  cfcEnforcementStrictness,
  cfcObservationFitsCeiling,
} from "@commonfabric/runner/cfc";
import { presetCfcOptions } from "@commonfabric/runner";
import {
  DEFAULT_GATEWAY_BASE_URL,
  DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
  fabricSessionCfcEnforcementMode,
  type HarnessConfig,
  parseCfcEnforcementMode,
  parseHarnessGatewayAuthMode,
  readCeilingsEqual,
  resolveCfcEnforcementMode,
  resolveCfcEnforcementModeSource,
  resolveGatewayAuthMode,
  resolveHarnessConfig,
} from "../src/config.ts";
import { resolveDockerRunscSandboxConfig } from "../src/sandbox/docker-runsc.ts";

Deno.test("HarnessConfig preserves legacy gateway object literals", () => {
  const legacy: HarnessConfig = {
    gatewayBaseUrl: "https://gateway.example/",
    gatewayAuthMode: "bearer",
    skillScriptExecutionTarget: "sandbox",
    cfcEnforcementMode: "observe",
    cfcEnforcementModeSource: "default",
  };
  assertEquals(legacy.modelProvider, undefined);
});

Deno.test("parseCfcEnforcementMode accepts runner-aligned values", () => {
  assertEquals(parseCfcEnforcementMode("observe"), "observe");
  assertEquals(
    parseCfcEnforcementMode("enforce-explicit"),
    "enforce-explicit",
  );
  assertEquals(parseCfcEnforcementMode("bogus"), undefined);
});

Deno.test("parseHarnessGatewayAuthMode accepts supported values", () => {
  assertEquals(parseHarnessGatewayAuthMode("bearer"), "bearer");
  assertEquals(parseHarnessGatewayAuthMode("none"), "none");
  assertEquals(parseHarnessGatewayAuthMode("bogus"), undefined);
});

Deno.test("resolveCfcEnforcementMode prefers explicit override", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      cfcEnforcementModeOverride: "observe",
      cfcEnforcementMode: "disabled",
      inheritedCfcEnforcementMode: "enforce-strict",
    }),
    "observe",
  );
});

Deno.test("resolveCfcEnforcementMode falls back through config and inherited values", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      cfcEnforcementMode: "enforce-explicit",
      inheritedCfcEnforcementMode: "observe",
    }),
    "enforce-explicit",
  );
  assertEquals(
    resolveCfcEnforcementMode({
      inheritedCfcEnforcementMode: "observe",
    }),
    "observe",
  );
  assertEquals(
    resolveCfcEnforcementMode({}),
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
  );
});

Deno.test("resolveCfcEnforcementMode can inherit from a run manifest", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        cfc: { enforcementMode: "observe" },
      },
    }),
    "observe",
  );
});

Deno.test("resolveCfcEnforcementMode ignores malformed in-memory run manifest modes", () => {
  const manifest = {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
  } as const;
  const malformed = {
    ...manifest,
    cfc: { enforcementMode: "bogus" as CfcEnforcementMode },
  };
  // A mode nothing parses contributes nothing: the resolution is the one the
  // same manifest gets naming no mode at all.
  assertEquals(
    resolveCfcEnforcementMode({ runManifest: malformed }),
    resolveCfcEnforcementMode({ runManifest: manifest }),
  );
  // And the source says so: the manifest decided nothing.
  assertEquals(
    resolveCfcEnforcementModeSource({ runManifest: malformed }),
    "default",
  );
});

Deno.test("resolveCfcEnforcementModeSource identifies the winning mode source", () => {
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementModeOverride: "observe",
      cfcEnforcementMode: "disabled",
    }),
    "override",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementMode: "disabled",
      inheritedCfcEnforcementMode: "observe",
    }),
    "explicit-config",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      inheritedCfcEnforcementMode: "observe",
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        cfc: { enforcementMode: "enforce-strict" },
      },
    }),
    "inherited",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      runManifest: {
        type: "cf-harness.loom-run-manifest",
        version: 1,
        source: "loom",
        cfc: { enforcementMode: "enforce-strict" },
      },
    }),
    "run-manifest",
  );
  assertEquals(resolveCfcEnforcementModeSource({}), "default");
});

Deno.test("resolveCfcEnforcementModeSource treats null like absent mode values", () => {
  assertEquals(
    resolveCfcEnforcementMode({
      cfcEnforcementModeOverride: null as unknown as CfcEnforcementMode,
      cfcEnforcementMode: "observe",
    }),
    "observe",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementModeOverride: null as unknown as CfcEnforcementMode,
      cfcEnforcementMode: "observe",
    }),
    "explicit-config",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      cfcEnforcementMode: null as unknown as CfcEnforcementMode,
      inheritedCfcEnforcementMode: "enforce-explicit",
    }),
    "inherited",
  );
});

Deno.test("resolveCfcEnforcementMode follows a fabric session raised to strict", () => {
  const strictSession = {
    apiUrl: "https://fabric.test",
    identityKeyPath: "/keys/identity.pkcs8",
    space: "demo",
    cfcEnforcementMode: "enforce-strict" as const,
  };

  // The raise is a comparison against whatever the loop would otherwise
  // resolve, so the manifest puts that at `observe`, below the session, at
  // any harness default. The session decides the mode, and the source names
  // it.
  const observeManifest = {
    type: "cf-harness.loom-run-manifest",
    version: 1,
    source: "loom",
    cfc: { enforcementMode: "observe" },
  } as const;
  assertEquals(
    resolveCfcEnforcementMode({
      fabricSession: strictSession,
      runManifest: observeManifest,
    }),
    "enforce-strict",
  );
  assertEquals(
    resolveCfcEnforcementModeSource({
      fabricSession: strictSession,
      runManifest: observeManifest,
    }),
    "fabric-session",
  );

  // A dial already at least as strict stands, and keeps its own source.
  assertEquals(
    resolveCfcEnforcementModeSource({
      fabricSession: strictSession,
      cfcEnforcementModeOverride: "enforce-strict",
    }),
    "override",
  );

  // A session that states no mode of its own does not raise the harness dial,
  // so the override stands.
  assertEquals(
    resolveCfcEnforcementMode({
      fabricSession: { ...strictSession, cfcEnforcementMode: undefined },
      cfcEnforcementModeOverride: "observe",
    }),
    "observe",
  );
});

Deno.test("resolveCfcEnforcementMode leaves the loop alone under a session nobody stated a mode on", () => {
  const unstatedSession = {
    apiUrl: "https://fabric.test",
    identityKeyPath: "/keys/identity.pkcs8",
    space: "demo",
  };

  // The session enforces at whatever rung its preset pins, and that rung is
  // not an operator raise: a loop weaker than the pin is what every run that
  // states neither dial is. The loop keeps its own default and names it,
  // whatever `fabricSessionCfcEnforcementMode` reports the session to be at.
  assertEquals(
    resolveCfcEnforcementMode({ fabricSession: unstatedSession }),
    DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE,
  );
  assertEquals(
    resolveCfcEnforcementModeSource({ fabricSession: unstatedSession }),
    "default",
  );
});

Deno.test("the harness loop's own default matches the rung an unstated fabric session enforces at", () => {
  const unstatedSession = {
    apiUrl: "https://fabric.test",
    identityKeyPath: "/keys/identity.pkcs8",
    space: "demo",
  };

  // The rung a session nobody stated a dial on runs at, read from the runner's
  // preset rather than from anything this package writes down.
  const pinned = presetCfcOptions({}).cfcEnforcementMode;
  assertExists(pinned, "the session runtime preset pins no enforcement mode");

  assertEquals(
    fabricSessionCfcEnforcementMode(unstatedSession),
    pinned,
    "`fabricSessionCfcEnforcementMode` no longer reads the rung `presetCfcOptions` resolves; take it back to that resolution rather than naming a rung in `config.ts`",
  );

  assert(
    cfcEnforcementStrictness(DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE) >=
      cfcEnforcementStrictness(pinned),
    `the harness loop defaults to ${DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE} while an unstated fabric session enforces at ${pinned}, so a run stating neither dial enforces less than the session it writes through, which AUD-15 fails; raise DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE to the pinned rung`,
  );
});

Deno.test("resolveCfcEnforcementMode refuses a harness dial weaker than a strict session", () => {
  assertThrows(
    () =>
      resolveCfcEnforcementMode({
        fabricSession: {
          apiUrl: "https://fabric.test",
          identityKeyPath: "/keys/identity.pkcs8",
          space: "demo",
          cfcEnforcementMode: "enforce-strict",
        },
        cfcEnforcementModeOverride: "enforce-explicit",
      }),
    Error,
    "--cfc-enforcement-mode enforce-explicit is weaker than the enforce-strict",
  );
});

Deno.test("resolveGatewayAuthMode prefers explicit override", () => {
  assertEquals(
    resolveGatewayAuthMode({
      gatewayAuthModeOverride: "none",
      gatewayAuthMode: "bearer",
    }),
    "none",
  );
});

Deno.test("resolveGatewayAuthMode defaults to bearer", () => {
  assertEquals(resolveGatewayAuthMode({}), "bearer");
});

Deno.test("resolveHarnessConfig normalizes the gateway base URL", () => {
  const config = resolveHarnessConfig({
    gatewayBaseUrl: "https://llm.stage.commontools.dev",
  });
  assertEquals(config.gatewayBaseUrl, DEFAULT_GATEWAY_BASE_URL);
  assertEquals(config.gatewayAuthMode, "bearer");
  assertEquals(config.cfcEnforcementMode, DEFAULT_HARNESS_CFC_ENFORCEMENT_MODE);
  assertEquals(config.cfcEnforcementModeSource, "default");
});

Deno.test("resolveHarnessConfig preserves legacy gateway fields for openai-codex callers", () => {
  const config = resolveHarnessConfig({
    modelProvider: "openai-codex",
    credentialOwnerKey: "loom:user-1",
  });
  // The enforcement rung is not a gateway field, and
  // `resolveHarnessConfig normalizes the gateway base URL` above reads it.
  // The source it came from stays: `default` is what a caller stating no dial
  // gets whatever rung that dial resolves to.
  const { cfcEnforcementMode: _rung, ...preserved } = config;
  assertEquals(preserved, {
    modelProvider: "openai-codex",
    credentialOwnerKey: "loom:user-1",
    gatewayBaseUrl: DEFAULT_GATEWAY_BASE_URL,
    gatewayAuthMode: "bearer",
    skillScriptExecutionTarget: "sandbox",
    cfcEnforcementModeSource: "default",
    docsCorpus: {
      type: "cf-harness.docs-corpus-record",
      source: "checkout-default",
      roots: checkoutDocsCorpusRoots(),
    },
    // The skills tree resolves the same way and in the same place, so a
    // caller that names neither gets both from the checkout it runs out of.
    skillsRoot: resolveHarnessSkillsRoot()?.hostPath,
    skillsRootRecord: resolveHarnessSkillsRoot(),
  });
  assertEquals(config.skillsRootRecord?.source, "checkout-default");
  assertThrows(
    () =>
      resolveHarnessConfig({
        modelProvider: "openai-codex",
        gatewayBaseUrl: "https://example.invalid",
      }),
    Error,
    "gateway URL/auth configuration cannot be combined",
  );
});

Deno.test("resolveHarnessConfig requires exact explicit and manifest credential owners", () => {
  const runManifest = {
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    credentialOwner: {
      type: "cf-harness.credential-owner-ref" as const,
      version: 1 as const,
      ownerKey: "local",
      tenantKey: "tenant-a",
    },
  };
  assertThrows(
    () =>
      resolveHarnessConfig({
        credentialOwner: {
          type: "cf-harness.credential-owner-ref",
          version: 1,
          ownerKey: "local",
          tenantKey: "tenant-b",
        },
        runManifest,
      }),
    Error,
    "does not match run manifest",
  );
  assertEquals(
    resolveHarnessConfig({
      credentialOwner: runManifest.credentialOwner,
      runManifest,
    }).credentialOwner,
    runManifest.credentialOwner,
  );
});

Deno.test("resolveHarnessConfig accepts an explicit mode override string", () => {
  const config = resolveHarnessConfig({
    inheritedCfcEnforcementMode: "disabled",
    cfcEnforcementModeOverride: "enforce-strict",
  });
  assertEquals(config.cfcEnforcementMode, "enforce-strict");
  assertEquals(config.cfcEnforcementModeSource, "override");
});

Deno.test("resolveHarnessConfig preserves explicit sandbox config", () => {
  const sandbox = resolveDockerRunscSandboxConfig({
    workspaceHostPath: "/host/workspace",
  });
  const config = resolveHarnessConfig({
    sandbox,
  });
  assertEquals(config.sandbox, sandbox);
});

Deno.test("resolveHarnessConfig preserves explicit artifact root config", () => {
  const config = resolveHarnessConfig({
    artifactRoot: "/tmp/cf-harness-artifacts",
  });
  assertEquals(config.artifactRoot, "/tmp/cf-harness-artifacts");
});

Deno.test("resolveHarnessConfig carries a pattern index alongside a fabric session", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    patternIndex: { baseUrl: "https://index.example/" },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.patternIndex, { baseUrl: "https://index.example/" });
});

Deno.test("resolveHarnessConfig carries deliberate discoverable publishing", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    patternIndex: {
      baseUrl: "https://index.example/",
      publishDiscoverable: true,
    },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.patternIndex, {
    baseUrl: "https://index.example/",
    publishDiscoverable: true,
  });
});

Deno.test("resolveHarnessConfig rejects a pattern index with no fabric session", () => {
  assertThrows(
    () =>
      resolveHarnessConfig({
        patternIndex: { baseUrl: "https://index.example/" },
        skillScriptExecutionTarget: "sandbox",
      }),
    Error,
    "pattern index configuration requires a fabric session",
  );
});

Deno.test("resolveHarnessConfig carries a pattern index the run does not publish to", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    patternIndex: { baseUrl: "https://index.example/", publish: false },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.patternIndex, {
    baseUrl: "https://index.example/",
    publish: false,
  });
});

Deno.test("resolveHarnessConfig carries a skills.sh discovery registry", () => {
  const config = resolveHarnessConfig({
    skillsSh: { baseUrl: "https://registry.example/" },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.skillsSh, { baseUrl: "https://registry.example/" });
});

Deno.test("resolveHarnessConfig bounds the fabric session by the run manifest's read ceiling", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    runManifest: {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      cfc: {
        maxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
        onExceed: "skip",
      },
    },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    cfcReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
    cfcReadOnExceed: "skip",
    readCeilingSource: "run-manifest",
    manifestReadMaxConfidentiality: ["did:key:zOwner", "did:key:zFacet"],
    manifestReadOnExceed: "skip",
  });
});

Deno.test("resolveHarnessConfig meets the run manifest's read ceiling with the session's own", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
      cfcReadMaxConfidentiality: ["did:key:zA", "did:key:zB"],
      cfcReadOnExceed: "fail",
    },
    runManifest: {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      cfc: {
        maxConfidentiality: ["did:key:zB", "did:key:zC"],
        onExceed: "skip",
      },
    },
    skillScriptExecutionTarget: "sandbox",
  });
  const ceiling = config.fabricSession?.cfcReadMaxConfidentiality;
  // Only what both admit fits the result: neither side's ceiling replaced
  // the other's.
  assertEquals(cfcObservationFitsCeiling(["did:key:zB"], ceiling), true);
  assertEquals(cfcObservationFitsCeiling(["did:key:zA"], ceiling), false);
  assertEquals(cfcObservationFitsCeiling(["did:key:zC"], ceiling), false);
  // The session's own onExceed stands over the manifest's.
  assertEquals(config.fabricSession?.cfcReadOnExceed, "fail");
});

Deno.test("resolveHarnessConfig leaves a session with no ceiling unbounded when the manifest declares none", () => {
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    runManifest: {
      type: "cf-harness.loom-run-manifest",
      version: 1,
      source: "loom",
      cfc: { enforcementMode: "observe" },
    },
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(config.fabricSession, {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
    readCeilingSource: "none",
  });
});

Deno.test("resolveHarnessConfig refuses a run manifest read ceiling with no fabric session to apply it", () => {
  assertThrows(
    () =>
      resolveHarnessConfig({
        runManifest: {
          type: "cf-harness.loom-run-manifest",
          version: 1,
          source: "loom",
          cfc: { maxConfidentiality: ["did:key:zOwner"] },
        },
        skillScriptExecutionTarget: "sandbox",
      }),
    Error,
    "run manifest cfc.maxConfidentiality names a read ceiling for the fabric session's runtime, and the run has no fabric session",
  );
});

Deno.test("resolveHarnessConfig folds the run manifest's read ceiling once: a resolved session passes through unchanged", () => {
  const runManifest = {
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    cfc: {
      maxConfidentiality: [
        "did:key:zO",
        { type: "Facet", owner: "did:key:zO", id: "work" },
      ],
    },
  };
  const parent = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
      cfcReadMaxConfidentiality: ["did:key:zO", "did:key:zX"],
    },
    runManifest,
    skillScriptExecutionTarget: "sandbox",
  });
  // A delegated child is built from its parent's resolved session and the
  // same manifest; it must record the ceiling its parent's runtime holds,
  // byte for byte, not a second meet of it.
  const child = resolveHarnessConfig({
    fabricSession: parent.fabricSession,
    runManifest,
    skillScriptExecutionTarget: "sandbox",
  });
  assertEquals(child.fabricSession, parent.fabricSession);
});

Deno.test("resolveHarnessConfig meets onExceed toward the stricter mode", () => {
  const session = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
  };
  const manifestWith = (onExceed: "fail" | "skip") => ({
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    cfc: { maxConfidentiality: ["did:key:zO"], onExceed },
  });
  // A session's `skip` is a wider release than the manifest's `fail`, and
  // the operator cannot widen what the dispatch declared.
  assertEquals(
    resolveHarnessConfig({
      fabricSession: {
        ...session,
        cfcReadMaxConfidentiality: ["did:key:zO"],
        cfcReadOnExceed: "skip",
      },
      runManifest: manifestWith("fail"),
      skillScriptExecutionTarget: "sandbox",
    }).fabricSession?.cfcReadOnExceed,
    "fail",
  );
  assertEquals(
    resolveHarnessConfig({
      fabricSession: {
        ...session,
        cfcReadMaxConfidentiality: ["did:key:zO"],
        cfcReadOnExceed: "skip",
      },
      runManifest: manifestWith("skip"),
      skillScriptExecutionTarget: "sandbox",
    }).fabricSession?.cfcReadOnExceed,
    "skip",
  );
  assertEquals(
    resolveHarnessConfig({
      fabricSession: session,
      runManifest: manifestWith("skip"),
      skillScriptExecutionTarget: "sandbox",
    }).fabricSession?.cfcReadOnExceed,
    "skip",
  );
});

Deno.test("resolveHarnessConfig refuses a resolved session beside a manifest ceiling it did not fold", () => {
  const session = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
  };
  const manifestWith = (ceiling: string[]) => ({
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    cfc: { maxConfidentiality: ceiling },
  });
  // A config resolved with no manifest, then handed on beside a manifest
  // that declares a ceiling: passing it through would run unbounded under a
  // manifest that asked for a bound.
  const unbounded = resolveHarnessConfig({
    fabricSession: session,
    skillScriptExecutionTarget: "sandbox",
  }).fabricSession;
  assertThrows(
    () =>
      resolveHarnessConfig({
        fabricSession: unbounded,
        runManifest: manifestWith(["did:key:zO"]),
        skillScriptExecutionTarget: "sandbox",
      }),
    Error,
    "resolved fabric session did not fold the run manifest's read ceiling",
  );
  // A config resolved under one manifest, handed on beside another: passing
  // it through would attest a ceiling the manifest beside it never declared.
  const underA = resolveHarnessConfig({
    fabricSession: session,
    runManifest: manifestWith(["did:key:zO", "did:key:zA"]),
    skillScriptExecutionTarget: "sandbox",
  }).fabricSession;
  assertThrows(
    () =>
      resolveHarnessConfig({
        fabricSession: underA,
        runManifest: manifestWith(["did:key:zO", "did:key:zB"]),
        skillScriptExecutionTarget: "sandbox",
      }),
    Error,
    "resolved fabric session did not fold the run manifest's read ceiling",
  );
  // The same manifest it folded passes through unchanged.
  assertEquals(
    resolveHarnessConfig({
      fabricSession: underA,
      runManifest: manifestWith(["did:key:zO", "did:key:zA"]),
      skillScriptExecutionTarget: "sandbox",
    }).fabricSession,
    underA,
  );
});

Deno.test("resolveHarnessConfig snapshots the run manifest's read ceiling rather than holding it by reference", () => {
  const ceiling: string[] = ["did:key:zOwner"];
  const runManifest = {
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    cfc: { maxConfidentiality: ceiling },
  };
  const config = resolveHarnessConfig({
    fabricSession: {
      apiUrl: "https://toolshed.example/",
      identityKeyPath: "/keys/agent.pkcs8",
      space: "my-space",
    },
    runManifest,
    skillScriptExecutionTarget: "sandbox",
  });
  // The session is built lazily, on the first tool call; a manifest object
  // mutated in between must not widen what that session is built under.
  ceiling.push("did:key:zEveryone");
  assertEquals(config.fabricSession?.cfcReadMaxConfidentiality, [
    "did:key:zOwner",
  ]);
  assertEquals(config.fabricSession?.manifestReadMaxConfidentiality, [
    "did:key:zOwner",
  ]);
});

Deno.test("readCeilingsEqual is a multiset match with order-insensitive alternatives, never a string compare", () => {
  const A = "did:key:zA";
  const B = "did:key:zB";
  const O = "did:key:zO";
  assertEquals(
    readCeilingsEqual([{ anyOf: [A, B] }, O], [O, { anyOf: [B, A] }]),
    true,
  );
  assertEquals(readCeilingsEqual([{ anyOf: [A, B] }], [{ anyOf: [A] }]), false);
  assertEquals(readCeilingsEqual([O], [O, O]), false);
  assertEquals(readCeilingsEqual(undefined, undefined), true);
  assertEquals(readCeilingsEqual(undefined, [O]), false);
  assertEquals(readCeilingsEqual([O], undefined), false);
});

Deno.test("resolveHarnessConfig refuses a resolved session beside a manifest that dropped its ceiling, and passes through the same ceiling respelled", () => {
  const session = {
    apiUrl: "https://toolshed.example/",
    identityKeyPath: "/keys/agent.pkcs8",
    space: "my-space",
  };
  const manifestWith = (ceiling: CfcConfClause[] | undefined) => ({
    type: "cf-harness.loom-run-manifest" as const,
    version: 1 as const,
    source: "loom" as const,
    ...(ceiling !== undefined ? { cfc: { maxConfidentiality: ceiling } } : {}),
  });
  const underAB = resolveHarnessConfig({
    fabricSession: session,
    runManifest: manifestWith([{ anyOf: ["did:key:zA", "did:key:zB"] }]),
    skillScriptExecutionTarget: "sandbox",
  }).fabricSession;
  // Folded under a ceiling, handed on beside a manifest that now declares
  // none: the config would attest a ceiling this manifest never carried.
  assertThrows(
    () =>
      resolveHarnessConfig({
        fabricSession: underAB,
        runManifest: manifestWith(undefined),
        skillScriptExecutionTarget: "sandbox",
      }),
    Error,
    "resolved fabric session did not fold the run manifest's read ceiling",
  );
  // The same ceiling with its alternatives in another order is the same
  // ceiling: passed through, not refused over spelling.
  assertEquals(
    resolveHarnessConfig({
      fabricSession: underAB,
      runManifest: manifestWith([{ anyOf: ["did:key:zB", "did:key:zA"] }]),
      skillScriptExecutionTarget: "sandbox",
    }).fabricSession,
    underAB,
  );
});
