import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

/**
 * Conformance guard for the runtime presets.
 *
 * The presets exist so a new `RuntimeOptions` key — or a changed default —
 * cannot land unevenly across first-party environments. Two mechanisms are
 * pinned here:
 *
 * 1. TREATMENT: for every registered option key, each preset's minimal-args
 *    output must match the declared classification (per-site sentinel /
 *    core-pinned value / pinned-in-family / absent). `MINIMAL_TREATMENT` is
 *    a `Record<RuntimeOptionKey, ...>`, so registering a new option in
 *    `RUNTIME_OPTION_KEYS` forces a row here too — the compiler walks a new
 *    option all the way into this spec.
 * 2. DELTA ROUTING: every declared preset parameter must land on exactly its
 *    `RuntimeOptions` key (full-args goldens), so a param cannot be silently
 *    dropped or mis-mapped.
 */
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

import {
  ADOPT_SERVER_FLAGS_ENV,
  adoptServerExperimentalOptions,
  EXPERIMENTAL_ENV_VARS,
  EXPERIMENTAL_FLAG_AUTHORITY,
  experimentalOptionsForDeployedClient,
  experimentalOptionsFromEnv,
  MAX_ENFORCEMENT_CFC_OPTIONS,
  MAX_ENFORCEMENT_SINK_CEILINGS,
  parseServerExperimentalOptions,
  RUNTIME_OPTION_KEYS,
  type RuntimeOptionKey,
  runtimePresets,
} from "../src/runtime-presets.ts";
import type { ExperimentalOptions, RuntimeOptions } from "../src/runtime.ts";
import type { IStorageManager } from "../src/storage/interface.ts";
import { Runtime, signer, StorageManager } from "./engine-test-support.ts";

/**
 * Runs `body` with `console.warn` captured, returning what it warned and what
 * it returned. Restored synchronously, so a `body` that returns a promise has
 * to be awaited by the caller AFTER this returns.
 */
function captureWarnings<T>(
  body: () => T,
): { warnings: unknown[][]; result: T } {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    return { warnings, result: body() };
  } finally {
    console.warn = originalWarn;
  }
}

type PresetName = keyof typeof runtimePresets;
const PRESET_NAMES = Object.keys(runtimePresets) as PresetName[];

const apiUrl = new URL("https://conformance.example/api");
const storageManager = {
  id: "conformance-storage",
} as unknown as IStorageManager;
const experimental: ExperimentalOptions = { modernCellRep: true };
const minimalCore = { apiUrl, storageManager, experimental };

const minimalOutputs: Record<PresetName, RuntimeOptions> = {
  productionServer: runtimePresets.productionServer(minimalCore),
  remoteClient: runtimePresets.remoteClient(minimalCore),
  patternTest: runtimePresets.patternTest(minimalCore),
  localDev: runtimePresets.localDev(minimalCore),
  browserWorker: runtimePresets.browserWorker(minimalCore),
  // unitTest is the one preset where `experimental` is optional (so the 282
  // hand-rolled test constructions can adopt it without ceremony).
  unitTest: runtimePresets.unitTest({ apiUrl, storageManager }),
};

/** Presets whose runtimes serve patterns against a real deployment. */
const DEPLOYMENT_FACING: PresetName[] = [
  "productionServer",
  "remoteClient",
  "browserWorker",
];

type MinimalTreatment =

  /** Equals the sentinel passed in, in every preset. */
  | { treat: "per-site" }
  /** Present in every preset with this exact shared value. */
  | { treat: "core-pinned"; value: unknown }
  /** Present (derived, not caller-supplied) in exactly these presets. */
  | { treat: "pinned-in"; presets: PresetName[]; value: unknown }
  /** No minimal output owns the key: the constructor default governs. */
  | { treat: "absent" };

const MINIMAL_TREATMENT: Record<RuntimeOptionKey, MinimalTreatment> = {
  apiUrl: { treat: "per-site" },
  storageManager: { treat: "per-site" },
  experimental: { treat: "per-site" },
  clientClass: {
    treat: "pinned-in",
    presets: ["browserWorker"],
    value: "web",
  },
  // Same values as the Runtime constructor defaults today, the strict end
  // state of docs/specs/cfc-enforcement-matrix.md §3; pinned so a changed
  // constructor default cannot silently relax first-party environments.
  cfcEnforcementMode: { treat: "core-pinned", value: "enforce-strict" },
  cfcFlowLabels: { treat: "core-pinned", value: "persist" },
  cfcWriteFloor: { treat: "core-pinned", value: "enforce" },
  cfcTriggerReadGating: { treat: "core-pinned", value: true },
  cfcPolicyEvaluation: { treat: "core-pinned", value: "enforce" },
  cfcLabelMetadataProtection: { treat: "core-pinned", value: "enforce" },
  cfcDeclaredMonotonicity: { treat: "core-pinned", value: "observe" },
  // Deployment-facing runtimes point patterns at the deployment itself;
  // local presets keep the builder-env default (localhost fall-through).
  patternEnvironment: {
    treat: "pinned-in",
    presets: DEPLOYMENT_FACING,
    value: { apiUrl },
  },
  // Everything below rides the constructor default unless a preset's
  // declared delta param supplies it (covered by the routing tests).
  spaceHostMap: { treat: "absent" },
  consoleHandler: { treat: "absent" },
  errorHandlers: { treat: "absent" },
  navigateCallback: { treat: "absent" },
  pieceCreatedCallback: { treat: "absent" },
  debug: { treat: "absent" },
  telemetry: { treat: "absent" },
  cfcDecomposedEnvelopes: { treat: "absent" },
  cfcContentAddressedLabels: { treat: "absent" },
  cfcPolicyRecords: { treat: "absent" },
  cfcPrefixProvenanceStats: { treat: "absent" },
  cfcTrustConfig: { treat: "absent" },
  cfcSinkMaxConfidentiality: { treat: "absent" },
  cfcReadMaxConfidentiality: { treat: "absent" },
  cfcReadOnExceed: { treat: "absent" },
  trustSnapshotProvider: { treat: "absent" },
  hideInternalStackFrames: { treat: "absent" },
  commitBackpressure: { treat: "absent" },
  moduleByteCache: { treat: "absent" },
  patternCoverage: { treat: "absent" },
  onPatternInstantiated: { treat: "absent" },
  fetch: { treat: "absent" },
  // Server-execution v2 Phase 2: only the SpaceServer's hand-rolled
  // runtime factory marks the serving posture; no preset ever sets it —
  // a preset-built runtime under the flag is a speculating client by
  // construction.
  servingPosture: { treat: "absent" },
};

describe("runtimePresets conformance", () => {
  it("every registered option key gets its declared treatment in every preset", () => {
    for (const key of RUNTIME_OPTION_KEYS) {
      const treatment = MINIMAL_TREATMENT[key];
      for (const preset of PRESET_NAMES) {
        const output = minimalOutputs[preset];
        const owns = Object.hasOwn(output, key);
        const context = `${preset}.${key}`;
        switch (treatment.treat) {
          case "per-site": {
            expect(owns, `${context} must be set from its param`).toBe(true);
            if (key === "experimental" && preset === "unitTest") {
              // unitTest defaulted it; every other preset got the sentinel.
              expect(output.experimental).toEqual({});
            } else if (
              key === "experimental" &&
              (preset === "productionServer" || preset === "remoteClient")
            ) {
              // The DEPLOYED-TOPOLOGY presets carry the sentinel PLUS the
              // first-party server-execution default for an unset flag
              // (server-execution v2 Phase 7's flip; the single-process
              // presets keep the constructor default — the OFF baseline).
              expect(output.experimental).toEqual({
                ...experimental,
                serverExecution: SERVER_EXECUTION_DEFAULT_ENABLED,
              });
            } else {
              expect(output[key], context).toBe(
                minimalCore[
                  key as keyof typeof minimalCore
                ],
              );
            }
            break;
          }
          case "core-pinned": {
            expect(owns, `${context} must carry the shared pin`).toBe(true);
            expect(output[key], context).toEqual(treatment.value);
            break;
          }
          case "pinned-in": {
            const expected = treatment.presets.includes(preset);
            expect(
              owns,
              `${context} pinned-in mismatch (expected ${expected})`,
            ).toBe(expected);
            if (expected) expect(output[key], context).toEqual(treatment.value);
            break;
          }
          case "absent": {
            expect(
              owns,
              `${context} must ride the constructor default in minimal form`,
            ).toBe(false);
            break;
          }
        }
      }
    }
  });

  it("presets set no keys outside the registry", () => {
    for (const preset of PRESET_NAMES) {
      for (const key of Object.keys(minimalOutputs[preset])) {
        expect(RUNTIME_OPTION_KEYS, `${preset} sets unregistered "${key}"`)
          .toContain(key);
      }
    }
  });

  describe("delta routing (full-args goldens)", () => {
    const fetchSentinel = (() =>
      Promise.reject(
        new Error("sentinel"),
      )) as unknown as typeof globalThis.fetch;
    const errorHandlers = [() => {}];
    const navigateCallback = () => {};
    const consoleHandler = (
      { args }: { args: unknown[] },
    ) => args;
    const pieceCreatedCallback = () => {};
    const moduleByteCache = {
      get: () => undefined,
      set: () => {},
    } as unknown as NonNullable<RuntimeOptions["moduleByteCache"]>;
    const patternCoverage = {
      registerSpan: () => {},
    } as unknown as NonNullable<RuntimeOptions["patternCoverage"]>;
    const trustSnapshotProvider = () => undefined;
    const telemetry = {
      dispatchEvent: () => true,
    } as unknown as NonNullable<RuntimeOptions["telemetry"]>;
    const commitBackpressure = { retryWindowMs: 100 };
    const spaceHostMap = { "did:key:zSpace": "https://host.example" };
    const readCeiling = ["did:key:zOwner", { anyOf: ["a", "b"] }];
    const onPatternInstantiated = () => {};

    it("productionServer", () => {
      const patternApiUrl = new URL("https://public.example/api");
      expect(runtimePresets.productionServer({
        ...minimalCore,
        patternApiUrl,
        consoleHandler,
        errorHandlers,
        telemetry,
      })).toEqual({
        ...minimalOutputs.productionServer,
        patternEnvironment: { apiUrl: patternApiUrl },
        consoleHandler,
        errorHandlers,
        telemetry,
      });
    });

    it("remoteClient", () => {
      expect(runtimePresets.remoteClient({
        ...minimalCore,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        trustSnapshotProvider,
        patternCoverage,
        onPatternInstantiated,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcWriteFloor: "enforce",
        cfcReadMaxConfidentiality: readCeiling,
        cfcReadOnExceed: "skip",
      })).toEqual({
        ...minimalOutputs.remoteClient,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        trustSnapshotProvider,
        patternCoverage,
        onPatternInstantiated,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
        cfcWriteFloor: "enforce",
        cfcReadMaxConfidentiality: readCeiling,
        cfcReadOnExceed: "skip",
      });
    });

    it("patternTest", () => {
      expect(runtimePresets.patternTest({
        ...minimalCore,
        fetch: fetchSentinel,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        cfcEnforcementMode: "observe",
        cfcFlowLabels: "persist",
        patternCoverage,
        onPatternInstantiated,
      })).toEqual({
        ...minimalOutputs.patternTest,
        fetch: fetchSentinel,
        errorHandlers,
        navigateCallback,
        moduleByteCache,
        cfcEnforcementMode: "observe",
        cfcFlowLabels: "persist",
        patternCoverage,
        onPatternInstantiated,
      });
    });

    it("browserWorker", () => {
      expect(runtimePresets.browserWorker({
        ...minimalCore,
        spaceHostMap,
        cfcEnforcementMode: "observe",
        cfcFlowLabels: "observe",
        cfcReadMaxConfidentiality: readCeiling,
        cfcReadOnExceed: "skip",
        trustSnapshotProvider,
        telemetry,
        consoleHandler,
        errorHandlers,
        navigateCallback,
        pieceCreatedCallback,
        patternCoverage,
      })).toEqual({
        ...minimalOutputs.browserWorker,
        spaceHostMap,
        cfcEnforcementMode: "observe",
        cfcFlowLabels: "observe",
        cfcReadMaxConfidentiality: readCeiling,
        cfcReadOnExceed: "skip",
        trustSnapshotProvider,
        telemetry,
        consoleHandler,
        errorHandlers,
        navigateCallback,
        pieceCreatedCallback,
        patternCoverage,
      });
    });

    it("unitTest", () => {
      expect(runtimePresets.unitTest({
        apiUrl,
        storageManager,
        experimental,
        fetch: fetchSentinel,
        errorHandlers,
        moduleByteCache,
        cfcEnforcementMode: "disabled",
        commitBackpressure,
      })).toEqual({
        ...minimalOutputs.unitTest,
        experimental,
        fetch: fetchSentinel,
        errorHandlers,
        moduleByteCache,
        cfcEnforcementMode: "disabled",
        commitBackpressure,
      });
    });
  });

  describe("experimentalOptionsFromEnv", () => {
    it("consults exactly the env-wired canonical mapping", () => {
      const read: string[] = [];
      experimentalOptionsFromEnv((name) => {
        read.push(name);
        return undefined;
      });
      const wired = Object.values(EXPERIMENTAL_ENV_VARS)
        .flatMap((v) => v === null ? [] : [v]);
      expect(read.toSorted()).toEqual(wired.toSorted());
    });

    it("parses canonical values and leaves unset flags to their defaults", () => {
      const env: Record<string, string> = {
        EXPERIMENTAL_MODERN_CELL_REP: "true",
        EXPERIMENTAL_SERVER_EXECUTION: "true",
      };
      expect(experimentalOptionsFromEnv((name) => env[name])).toEqual({
        modernCellRep: true,
        serverExecution: true,
      });
      expect(experimentalOptionsFromEnv(() => undefined)).toEqual({});
    });

    it("ignores (with a warning) non-canonical values instead of coercing", () => {
      // The wirings this replaced coerced garbage in OPPOSITE directions
      // (toolshed's flagValue(): anything but "false" ⇒ true; the CLI reader:
      // anything but "true" ⇒ false). Ignoring keeps the flag on its default
      // and surfaces the typo.
      const { warnings, result } = captureWarnings(() =>
        experimentalOptionsFromEnv((name) =>
          name === "EXPERIMENTAL_MODERN_CELL_REP" ? "1" : undefined
        )
      );
      expect(result).toEqual({});
      expect(warnings.length).toBe(1);
      expect(String(warnings[0][0])).toContain("EXPERIMENTAL_MODERN_CELL_REP");
    });
  });

  describe("experimental flag authority", () => {
    describe("parseServerExperimentalOptions", () => {
      it("reads the boolean flags it recognizes", () => {
        expect(parseServerExperimentalOptions({
          modernCellRep: true,
          serverExecution: false,
        })).toEqual({
          modernCellRep: true,
          serverExecution: false,
          readerSchemaPrecedence: false,
        });
      });

      it("warns naming the value, and skips the flag, given a value that is not a boolean", () => {
        const warn = stub(console, "warn");
        let parsed;
        try {
          parsed = parseServerExperimentalOptions({ modernCellRep: "yes" });
        } finally {
          warn.restore();
        }
        expect(parsed).toEqual({ readerSchemaPrecedence: false });
        expect(warn.calls.length).toBe(1);
        expect(warn.calls[0].args[0]).toContain('modernCellRep=`"yes"`');
      });

      it("adopts legacy false for an absent readerSchemaPrecedence declaration", () => {
        // A responding server that declares no readerSchemaPrecedence predates
        // the flag and necessarily runs the strict combine: absence adopts as
        // the legacy false. A declared value wins as usual.

        expect(parseServerExperimentalOptions({}).readerSchemaPrecedence)
          .toBe(false);
        expect(
          parseServerExperimentalOptions({ readerSchemaPrecedence: true })
            .readerSchemaPrecedence,
        ).toBe(true);
      });

      it("adopts nothing for a published null and legacy false for an absent field", () => {
        // toolshed publishes `experimental: null` until a Runtime exists —
        // a NEW server saying "nothing yet", which adopts nothing — while a
        // meta document with no experimental field at all predates the
        // flag and takes the legacy arm. Malformed declarations adopt
        // nothing.
        expect(parseServerExperimentalOptions(null)).toEqual({});
        expect(parseServerExperimentalOptions(undefined)).toEqual({
          readerSchemaPrecedence: false,
        });
        expect(parseServerExperimentalOptions("modernCellRep")).toEqual({});
      });

      it("ignores a key this build has no flag for", () => {
        // A newer server publishing a flag this client predates. Normal, and
        // not something to warn about.
        const { warnings, result } = captureWarnings(() =>
          parseServerExperimentalOptions({
            modernCellRep: true,
            flagFromTheFuture: true,
          })
        );
        expect(result).toEqual({
          modernCellRep: true,
          readerSchemaPrecedence: false,
        });
        expect(warnings.length).toBe(0);
      });

      it("drops a non-boolean value with a warning", () => {
        const { warnings, result } = captureWarnings(() =>
          parseServerExperimentalOptions({ modernCellRep: "true" })
        );
        expect(result).toEqual({ readerSchemaPrecedence: false });
        expect(warnings.length).toBe(1);
        expect(String(warnings[0][0])).toContain("modernCellRep");
      });
    });

    describe("adoptServerExperimentalOptions", () => {
      it("takes a server-authoritative flag from the server", () => {
        expect(adoptServerExperimentalOptions({ modernCellRep: true }, {}))
          .toEqual({ modernCellRep: true });
      });

      it("keeps an explicit environment value over the server's", () => {
        // An explicit value is the documented rollback lever and CI's way to
        // pin a lane, so it outranks the declaration: a server able to
        // overrule it would leave neither mechanism working.
        expect(
          adoptServerExperimentalOptions(
            { modernCellRep: true },
            { modernCellRep: false },
          ),
        ).toEqual({ modernCellRep: false });
      });

      it("leaves a client-authoritative flag on the environment alone", () => {
        expect(
          adoptServerExperimentalOptions(
            { modernCellRep: true, serverExecution: true },
            {},
            { ...EXPERIMENTAL_FLAG_AUTHORITY, modernCellRep: "client" },
          ),
        ).toEqual({ serverExecution: true });
      });

      it("leaves a flag the server did not publish unset", () => {
        // Absence of a declaration is not a declaration of `false`: the
        // built-in default has to govern, or an older server would silently
        // turn every default-on flag off.
        expect(adoptServerExperimentalOptions({}, {})).toEqual({});
      });
    });

    describe("experimentalOptionsForDeployedClient", () => {
      const metaResponse = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });

      it("adopts the posture the server publishes on its meta document", async () => {
        const requested: string[] = [];
        const adopted = await experimentalOptionsForDeployedClient({
          apiUrl: new URL("https://deployment.example/api/"),
          env: (name) =>
            name === "EXPERIMENTAL_MODERN_CELL_REP" ? "false" : undefined,
          fetch: (input) => {
            requested.push(String(input));
            return Promise.resolve(metaResponse({
              did: "did:key:z",
              experimental: { modernCellRep: true, serverExecution: true },
            }));
          },
        });
        // Spelled out rather than composed from the constant: the point is
        // WHICH document the client reads, and a test that reuses the
        // constant cannot tell a changed path from an unchanged one. The
        // toolshed side pins the constant against the route that serves it.
        expect(requested).toEqual(["https://deployment.example/api/meta"]);
        // The env's explicit `false` outranks the server; the flag it says
        // nothing about is adopted — and a posture with no
        // readerSchemaPrecedence declaration is a pre-flag server, adopted
        // as the legacy strict `false`.
        expect(adopted).toEqual({
          modernCellRep: false,
          serverExecution: true,
          readerSchemaPrecedence: false,
        });
      });

      it("falls back to the environment when the server answers an error", async () => {
        // The body of an error response is not a posture even when it parses
        // as one — an error page, or a proxy standing in for the deployment.
        expect(
          await experimentalOptionsForDeployedClient({
            apiUrl: new URL("https://deployment.example"),
            env: (name) =>
              name === "EXPERIMENTAL_MODERN_CELL_REP" ? "true" : undefined,
            fetch: () =>
              Promise.resolve(metaResponse({
                experimental: { serverExecution: true },
              }, 404)),
          }),
        ).toEqual({ modernCellRep: true });
      });

      it("falls back to the environment when the request fails", async () => {
        // A deployment that is simply down. The caller is about to fail
        // loudly on its real work; failing here first would only obscure it.
        expect(
          await experimentalOptionsForDeployedClient({
            apiUrl: new URL("https://deployment.example"),
            env: () => undefined,
            fetch: () => Promise.reject(new TypeError("connection refused")),
          }),
        ).toEqual({});
      });

      it("falls back to the environment when the body is not JSON", async () => {
        expect(
          await experimentalOptionsForDeployedClient({
            apiUrl: new URL("https://deployment.example"),
            env: () => undefined,
            fetch: () => Promise.resolve(new Response("<html>nope</html>")),
          }),
        ).toEqual({});
      });

      it("falls back to the environment for a server that publishes no posture", async () => {
        // An older server, whose meta document predates the field. It also
        // predates readerSchemaPrecedence, so that one flag adopts as the
        // legacy strict `false` rather than staying unset.
        expect(
          await experimentalOptionsForDeployedClient({
            apiUrl: new URL("https://deployment.example"),
            env: () => undefined,
            fetch: () =>
              Promise.resolve(metaResponse({ did: "did:key:z", gitSha: null })),
          }),
        ).toEqual({ readerSchemaPrecedence: false });
      });

      it("hands the request the caller's cancellation signal", async () => {
        // Without it, a deployment that accepts the connection and then says
        // nothing holds a cancellable startup here for as long as it stays
        // silent, and no shutdown can reach it.
        const controller = new AbortController();
        let passed: AbortSignal | undefined;
        await experimentalOptionsForDeployedClient({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          signal: controller.signal,
          fetch: (_input, init) => {
            passed = init?.signal ?? undefined;
            return Promise.resolve(metaResponse({ experimental: {} }));
          },
        });
        expect(passed).toBe(controller.signal);
      });

      it("throws the abort reason even under CF_ADOPT_SERVER_FLAGS=false", async () => {
        // The opt-out is over adopting a posture, not over the caller's
        // cancellation: a startup that has already stopped gets the abort
        // whichever way it was going to resolve its flags.
        const controller = new AbortController();
        controller.abort(new Error("shutting down"));
        await expect(experimentalOptionsForDeployedClient({
          apiUrl: new URL("https://deployment.example"),
          env: (name) => name === ADOPT_SERVER_FLAGS_ENV ? "false" : undefined,
          signal: controller.signal,
          fetch: () => Promise.reject(new Error("must not be reached")),
        })).rejects.toThrow("shutting down");
      });

      it("throws the abort reason when the body read is cancelled", async () => {
        // The signal rides the request, so aborting it errors the response
        // stream: a deployment that sends headers and then stalls its body
        // cannot hold a cancellable startup open.
        const controller = new AbortController();
        await expect(experimentalOptionsForDeployedClient({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          signal: controller.signal,
          fetch: (_input, init) =>
            Promise.resolve(
              new Response(
                new ReadableStream({
                  start(chunk) {
                    chunk.enqueue(new TextEncoder().encode('{"experimental":'));
                    init?.signal?.addEventListener(
                      "abort",
                      () => chunk.error(init.signal!.reason),
                    );
                    controller.abort(new Error("shutting down"));
                  },
                }),
                { headers: { "content-type": "application/json" } },
              ),
            ),
        })).rejects.toThrow("shutting down");
      });

      it("throws the abort reason instead of resolving a cancelled startup", async () => {
        // The one failure that is NOT read as "the server said nothing": the
        // caller asked to stop, so handing back a posture would feed a
        // runtime construction it is abandoning.
        const controller = new AbortController();
        controller.abort(new Error("shutting down"));
        await expect(experimentalOptionsForDeployedClient({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          signal: controller.signal,
          fetch: (_input, init) => {
            init?.signal?.throwIfAborted();
            return Promise.resolve(metaResponse({ experimental: {} }));
          },
        })).rejects.toThrow("shutting down");
      });

      it("ignores the server's posture under CF_ADOPT_SERVER_FLAGS=false", async () => {
        let fetched = false;
        expect(
          await experimentalOptionsForDeployedClient({
            apiUrl: new URL("https://deployment.example"),
            env: (name) =>
              name === ADOPT_SERVER_FLAGS_ENV ? "false" : undefined,
            fetch: () => {
              fetched = true;
              return Promise.resolve(metaResponse({
                experimental: { serverExecution: true },
              }));
            },
          }),
        ).toEqual({});
        expect(fetched).toBe(false);
      });

      it("adopts under a non-canonical CF_ADOPT_SERVER_FLAGS, with a warning", async () => {
        // Same discipline as the EXPERIMENTAL_* mapping: a value that is
        // neither "true" nor "false" leaves the default (adopting) in place
        // rather than being read as an opt-out.
        const { warnings, result } = captureWarnings(() =>
          experimentalOptionsForDeployedClient({
            apiUrl: new URL("https://deployment.example"),
            env: (name) => name === ADOPT_SERVER_FLAGS_ENV ? "0" : undefined,
            fetch: () =>
              Promise.resolve(metaResponse({
                experimental: { serverExecution: true },
              })),
          })
        );
        expect(await result).toEqual({
          serverExecution: true,
          readerSchemaPrecedence: false,
        });
        expect(warnings.length).toBe(1);
        expect(String(warnings[0][0])).toContain(ADOPT_SERVER_FLAGS_ENV);
      });

      it("an adopted server-OFF posture rides the deployed-topology presets explicitly, immune to the first-party default", async () => {
        // The separately-installed-host shape: nothing declared in the
        // environment, talking to a
        // server held on the explicit-OFF rollback posture. Adoption hands
        // the preset an EXPLICIT `false`, and the presets' `??` fill then
        // never consults `SERVER_EXECUTION_DEFAULT_ENABLED` — which is why
        // the first arm of this pin references no constant: it must hold
        // under EITHER value (that immunity is the rollback lever working
        // across a staggered upgrade, not a restatement of the absolute
        // pin in toolshed's server-execution-flag.test.ts).
        const adopted = await experimentalOptionsForDeployedClient({
          apiUrl: new URL("https://deployment.example"),
          env: () => undefined,
          fetch: () =>
            Promise.resolve(metaResponse({
              did: "did:key:z",
              experimental: { serverExecution: false },
            })),
        });
        expect(adopted.serverExecution).toBe(false);
        for (const preset of ["remoteClient", "productionServer"] as const) {
          expect(
            runtimePresets[preset]({
              apiUrl,
              storageManager,
              experimental: adopted,
            })
              .experimental?.serverExecution,
          ).toBe(false);
        }
        // The arm adoption replaces: an env-only resolution leaves the
        // unset flag ABSENT, and the preset fills it with the first-party
        // constant — under a flipped default that is an ON client against
        // the rolled-back OFF server, the mixed topology the adoption
        // exists to prevent. Compared against the imported constant, not a
        // literal, so this documents the exposure without pinning the
        // constant's value.
        expect(
          runtimePresets.remoteClient({
            apiUrl,
            storageManager,
            experimental: experimentalOptionsFromEnv(() => undefined),
          }).experimental?.serverExecution,
        ).toBe(SERVER_EXECUTION_DEFAULT_ENABLED);
      });

      it("an explicit environment outranks the published posture in both directions, through the preset", async () => {
        // Both arms stay selectable on a deployed client: the env is the
        // documented rollback lever and CI's way to pin a lane, so it must
        // survive adoption AND the preset fill in each direction.
        for (
          const arm of [
            { env: "true", server: false, resolved: true },
            { env: "false", server: true, resolved: false },
          ] as const
        ) {
          const adopted = await experimentalOptionsForDeployedClient({
            apiUrl: new URL("https://deployment.example"),
            env: (name) =>
              name === "EXPERIMENTAL_SERVER_EXECUTION" ? arm.env : undefined,
            fetch: () =>
              Promise.resolve(metaResponse({
                did: "did:key:z",
                experimental: { serverExecution: arm.server },
              })),
          });
          expect(adopted.serverExecution).toBe(arm.resolved);
          expect(
            runtimePresets.remoteClient({
              apiUrl,
              storageManager,
              experimental: adopted,
            }).experimental?.serverExecution,
          ).toBe(arm.resolved);
        }
      });
    });
  });

  describe("cfcPosture: max-enforcement", () => {
    const posture = { cfcPosture: "max-enforcement" } as const;
    const postureOutputs: Record<PresetName, RuntimeOptions> = {
      productionServer: runtimePresets.productionServer({
        ...minimalCore,
        ...posture,
      }),
      remoteClient: runtimePresets.remoteClient({ ...minimalCore, ...posture }),
      patternTest: runtimePresets.patternTest({ ...minimalCore, ...posture }),
      localDev: runtimePresets.localDev({ ...minimalCore, ...posture }),
      browserWorker: runtimePresets.browserWorker({
        ...minimalCore,
        ...posture,
      }),
      unitTest: runtimePresets.unitTest({ apiUrl, storageManager, ...posture }),
    };

    it("spreads exactly the named bundle over each preset's minimal output", () => {
      for (const preset of PRESET_NAMES) {
        expect(postureOutputs[preset], preset).toEqual({
          ...minimalOutputs[preset],
          ...MAX_ENFORCEMENT_CFC_OPTIONS,
        });
      }
    });

    it("keeps the shared enforcement-mode pin out of the bundle", () => {
      // The bundle names no enforcement mode, so a runtime taking it keeps
      // the core pin and a host dial is the only thing that moves it.
      expect(Object.keys(MAX_ENFORCEMENT_CFC_OPTIONS))
        .not.toContain("cfcEnforcementMode");
      expect(postureOutputs.remoteClient.cfcEnforcementMode)
        .toBe("enforce-strict");
    });

    it("lets a host session dial apply over the bundle", () => {
      const output = runtimePresets.remoteClient({
        ...minimalCore,
        ...posture,
        cfcEnforcementMode: "enforce-strict",
      });
      expect(output.cfcEnforcementMode).toBe("enforce-strict");
      // The bundle's persist is what makes the strict raise conform.
      expect(output.cfcFlowLabels).toBe("persist");
    });

    it("lets a host session hold the write floor at observe over the bundle", () => {
      // The floor's rollout runs observe before enforce (§8.12.4.1 / SC-18),
      // a rung the all-or-nothing bundle cannot name. The host dial is what
      // reaches it, so it has to win over the bundle's enforcing value.
      const output = runtimePresets.remoteClient({
        ...minimalCore,
        ...posture,
        cfcWriteFloor: "observe",
      });
      expect(output.cfcWriteFloor).toBe("observe");
      expect(postureOutputs.remoteClient.cfcWriteFloor).toBe("enforce");
    });

    it("ceilings every network-fetch sink and the agent sink public-only, and no llm sink", () => {
      expect(MAX_ENFORCEMENT_SINK_CEILINGS).toEqual({
        fetchBinary: [],
        fetchText: [],
        fetchJson: [],
        fetchJsonUnchecked: [],
        fetchProgram: [],
        streamData: [],
        agent: [],
      });
    });

    it("constructs a working Runtime with the dials and policy resolved", async () => {
      const emulated = StorageManager.emulate({ as: signer });
      const runtime = new Runtime(runtimePresets.unitTest({
        apiUrl: new URL(import.meta.url),
        storageManager: emulated,
        ...posture,
      }));
      try {
        expect(runtime.cfcEnforcementMode).toBe("enforce-strict");
        expect(runtime.cfcFlowLabels).toBe("persist");
        expect(runtime.cfcWriteFloor).toBe("enforce");
        expect(runtime.cfcTriggerReadGating).toBe(true);
        expect(runtime.cfcPolicyEvaluation).toBe("enforce");
        expect(runtime.cfcDeclaredMonotonicity).toBe("enforce");
        expect(runtime.cfcLabelMetadataProtection).toBe("enforce");
        // The §10.1 records validated and digested at boot (fail-closed
        // config: a malformed bundle would have thrown in the constructor).
        expect(runtime.cfcPolicySnapshot).toBeDefined();
        expect(runtime.cfcSinkMaxConfidentiality)
          .toEqual(MAX_ENFORCEMENT_SINK_CEILINGS);
      } finally {
        await runtime.dispose();
        await emulated.close();
      }
    });
  });

  it("preset output constructs a working Runtime", async () => {
    const emulated = StorageManager.emulate({ as: signer });
    const runtime = new Runtime(runtimePresets.unitTest({
      apiUrl: new URL(import.meta.url),
      storageManager: emulated,
    }));
    try {
      expect(runtime.cfcEnforcementMode).toBe("enforce-strict");
    } finally {
      await runtime.dispose();
      await emulated.close();
    }
  });
});
