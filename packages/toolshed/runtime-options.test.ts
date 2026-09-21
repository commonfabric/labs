import { assertEquals, assertStrictEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import type { Runtime, RuntimeOptions } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { cfcPosture, publishCfcPosture } from "@/lib/cfc-posture.ts";
import {
  experimentalPosture,
  publishExperimentalPosture,
} from "@/lib/experimental-posture.ts";
import {
  attachRuntimeOtelBridge,
  createToolshedRuntime,
  detachRuntimeOtelBridgeIfAttached,
  toolshedRuntimeOptions,
} from "@/runtime-options.ts";

Deno.test("toolshedRuntimeOptions splits MEMORY_URL/API_URL and honors the env reader", () => {
  // Pins toolshed's runtime wiring decisions (CT-1814): the runtime's storage
  // base is MEMORY_URL while patterns fetch against the public API_URL; the
  // storage manager passes through untouched; EXPERIMENTAL_* flags come from
  // the injected env reader via the canonical mapping; and the shared
  // first-party posture (the CFC pin) rides along from the preset.

  const storageManager = {
    sentinel: true,
  } as unknown as RuntimeOptions["storageManager"];

  const options = toolshedRuntimeOptions(
    {
      MEMORY_URL: "http://memory.test:8000/",
      API_URL: "http://api.test:9000/",
    },
    storageManager,
    (name) => name === "EXPERIMENTAL_MODERN_CELL_REP" ? "true" : undefined,
  );

  assertEquals(options.apiUrl.href, "http://memory.test:8000/");
  assertEquals(
    options.patternEnvironment?.apiUrl.href,
    "http://api.test:9000/",
  );
  assertStrictEquals(options.storageManager, storageManager);
  assertEquals(options.experimental?.modernCellRep, true);
  // Unset flags stay unset (tri-state fidelity), not coerced.
  assertEquals(options.experimental?.lazyMaterialization, undefined);
  // EXCEPT the posture: the deployed-topology preset resolves an unset
  // serverExecution to the first-party default, so this server-side
  // process always runs a declared arm.
  assertEquals(
    options.experimental?.serverExecution,
    SERVER_EXECUTION_DEFAULT_ENABLED,
  );
  assertEquals(options.cfcEnforcementMode, "enforce-strict");
});

Deno.test("createToolshedRuntime attaches the OTel bridge only when enabled", async () => {
  // The runtime→OTel bridge attach rides Runtime construction (CT plan: the
  // bridge is a second consumer of the RuntimeTelemetry bus). Off by default;
  // on OTEL_ENABLED it attaches and flips the preflight-telemetry gate. Without
  // a registered OTel provider the API hands the bridge no-op instruments, so
  // the enabled path is safe to exercise in a test.

  const signer = await Identity.fromPassphrase("runtime-options-otel-test");
  const config = {
    MEMORY_URL: "http://memory.test:8000/",
    API_URL: "http://api.test:9000/",
    OTEL_SERVICE_NAME: "toolshed-test",
    ENV: "test",
  };

  for (const enabled of [false, true]) {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = createToolshedRuntime(
      { ...config, OTEL_ENABLED: enabled },
      storageManager,
      () => undefined,
    );
    // The construction path fire-and-forgets the attach; assert the attach
    // behavior directly (same runtime, same config).
    assertEquals(
      await attachRuntimeOtelBridge(runtime, {
        ...config,
        OTEL_ENABLED: enabled,
      }),
      enabled,
    );
    await runtime.dispose();
    await storageManager.close();
  }

  // A successful attach registers the shutdown detach; detaching is
  // idempotent and reports whether a bridge was live.
  assertEquals(detachRuntimeOtelBridgeIfAttached(), true);
  assertEquals(detachRuntimeOtelBridgeIfAttached(), false);

  // Attach failures are logged, never fatal: a runtime whose preflight gate
  // throws must resolve false, not reject.
  const throwingRuntime = {
    telemetry: new EventTarget(),
    scheduler: {
      setEventPreflightTelemetryEnabled() {
        throw new Error("gate unavailable");
      },
    },
  } as unknown as Parameters<typeof attachRuntimeOtelBridge>[0];
  assertEquals(
    await attachRuntimeOtelBridge(throwingRuntime, {
      OTEL_ENABLED: true,
      OTEL_SERVICE_NAME: "toolshed-test",
      ENV: "test",
    }),
    false,
  );
});

Deno.test("createToolshedRuntime publishes the posture it resolved", async () => {
  // What `/api/meta` reports, and therefore what a client not built alongside
  // this server adopts (docs/development/EXPERIMENTAL_OPTIONS.md). Taken from
  // the constructed Runtime rather than re-read from the environment, so the
  // published posture includes the defaults and preset resolution the server is
  // actually running under — a second reading could disagree with the first.

  const signer = await Identity.fromPassphrase("runtime-options-posture-test");
  const storageManager = StorageManager.emulate({ as: signer });
  publishExperimentalPosture(null);
  let runtime: Runtime | undefined;
  try {
    runtime = createToolshedRuntime(
      {
        MEMORY_URL: "http://memory.test:8000/",
        API_URL: "http://api.test:9000/",
        OTEL_ENABLED: false,
        OTEL_SERVICE_NAME: "toolshed-test",
        ENV: "test",
      },
      storageManager,
      (name) => name === "EXPERIMENTAL_MODERN_CELL_REP" ? "true" : undefined,
    );
    const posture = experimentalPosture();
    // The CFC posture publishes alongside, from the same constructed Runtime
    // (lib/cfc-posture.ts): the preset core pin plus constructor defaults.
    const cfc = cfcPosture();
    assertEquals(cfc?.enforcementMode.rung, "enforce-strict");
    assertEquals(cfc?.flowLabels.rung, "persist");
    assertEquals(cfc?.flowLabels.diagnosticOnly, false);
    assertEquals(cfc?.policyDigest, null);
    // Every known sink is named, none of them ceilinged: a server that has
    // configured nothing publishes ten ungated sinks rather than an empty
    // list a reader could take for full coverage.
    assertEquals(cfc?.sinks.length, 11);
    assertEquals(cfc?.sinks.every((sink) => "ungated" in sink), true);
    assertEquals(posture?.modernCellRep, true);
    // Resolved, not passed: the env reader said nothing about these, and a
    // client adopting the posture needs the values in effect rather than the
    // subset someone happened to set.
    assertEquals(posture?.commitPreconditions, true);
    assertEquals(
      posture?.serverExecution,
      SERVER_EXECUTION_DEFAULT_ENABLED,
    );
  } finally {
    await runtime?.dispose();
    await storageManager.close();
    publishExperimentalPosture(null);
    publishCfcPosture(null);
  }
});
