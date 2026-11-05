/**
 * Verifies that host-configured Fabric sessions reach interactive prompt loops.
 * Provider clients and Fabric I/O are replaced at their construction boundary.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type {
  CreateHarnessPromptLoopOptions,
  HarnessPromptLoopResult,
} from "../src/prompt-loop.ts";
import {
  HARNESS_CHAT_PROTOCOL_VERSION,
  HARNESS_CHAT_REQUEST_TYPE,
} from "../src/contracts/interactive-chat.ts";
import {
  runHarnessInteractiveChatStdio,
  type RunHarnessInteractiveChatStdioOptions,
} from "../src/interactive-chat-stdio.ts";
import {
  createLoomLocalCfHarnessHost,
  parseCfHarnessCliArgs,
  runHarnessInteractiveChatStdioCli,
} from "./support/on-linux.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";

/** Host settings isolated from the invoking developer's persisted sessions. */
const hostKeys = [
  "CF_HARNESS_CHAT_SESSION_DB",
  "CF_HARNESS_CHAT_MAX_IN_MEMORY_EVENTS",
  "CF_HARNESS_LOOM_AUTHORING_CONFIG",
  "CF_HARNESS_FABRIC_API_URL",
  "CF_HARNESS_FABRIC_IDENTITY",
  "CF_HARNESS_FABRIC_SPACE",
  "CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE",
  "CF_HARNESS_FABRIC_CFC_FLOW_LABELS",
  "CF_HARNESS_FABRIC_CFC_POSTURE",
];

/** Helper for entrypoint tests, which restores the process environment. */
const withFabricEnv = async (
  env: Record<string, string>,
  run: () => Promise<void>,
) => {
  const original = new Map(hostKeys.map((key) => [key, Deno.env.get(key)]));
  try {
    for (const key of hostKeys) {
      if (env[key] === undefined) Deno.env.delete(key);
      else Deno.env.set(key, env[key]);
    }
    await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
};

/** Helper for entrypoint tests, which observes a real service turn's options. */
const observeTurn = async (
  entrypoint: "stdio" | "loom",
  flags: string[],
  env: Record<string, string> = {},
) => {
  const root = await Deno.makeTempDir();
  const seen: CreateHarnessPromptLoopOptions[] = [];
  const run = async (options: RunHarnessInteractiveChatStdioOptions) => {
    const encoder = new TextEncoder();
    const requests = [
      {
        method: "start_session",
        params: {
          sessionId: "synthetic",
          workspace: { hostPath: root },
          model: "synthetic-model",
        },
      },
      {
        method: "start_turn",
        params: {
          sessionId: "synthetic",
          turnId: "synthetic-turn",
          input: { text: "Synthetic input" },
        },
      },
    ];
    await runHarnessInteractiveChatStdio({
      ...options,
      basePromptLoopOptions: {
        ...options.basePromptLoopOptions,
        ...(options.basePromptLoopOptions?.fabricSession === undefined ? {} : {
          fabricSessionFactory: () =>
            Promise.resolve({
              pieces: {
                getSpace: () =>
                  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
                getDefaultPattern: () =>
                  Promise.resolve({
                    key: (segment: string) => ({
                      getAsNormalizedFullLink: () => ({
                        space:
                          "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
                        id: `of:fid1:${"A".repeat(43)}`,
                        path: [segment],
                      }),
                    }),
                  }),
              },
            } as unknown as HarnessFabricSession),
        }),
      },
      input: new ReadableStream({
        start(controller) {
          for (const [index, request] of requests.entries()) {
            controller.enqueue(
              encoder.encode(
                JSON.stringify({
                  type: HARNESS_CHAT_REQUEST_TYPE,
                  protocolVersion: HARNESS_CHAT_PROTOCOL_VERSION,
                  requestId: String(index),
                  ...request,
                }) + "\n",
              ),
            );
          }
          controller.close();
        },
      }),
      output: new WritableStream({ write() {} }),
      createPromptLoop: (loopOptions) => {
        seen.push(loopOptions);
        return {
          runTranscript: (turn) =>
            Promise.resolve({
              model: "synthetic-model",
              finalAssistantText: "Synthetic result",
              transcript: [...turn.transcript],
              modelTurns: 1,
              runState: {} as HarnessPromptLoopResult["runState"],
            }),
        };
      },
    });
  };
  try {
    if (entrypoint === "stdio") {
      await withFabricEnv(
        env,
        () => runHarnessInteractiveChatStdioCli(flags, root, run),
      );
    } else {
      const host = await createLoomLocalCfHarnessHost({
        harnessHome: await Deno.realPath(root),
        env,
        providerSettingsStore: {
          inspect: () =>
            Promise.resolve({
              state: "configured" as const,
              settings: {
                version: 1 as const,
                modelProvider: "openai-compatible-gateway" as const,
              },
            }),
        },
        cliDependencies: { cwd: root },
        interactiveStdioRunner: run,
      });
      await host.runInteractive(flags);
    }
    expect(seen).toHaveLength(1);
    return { options: seen[0], root };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
};

describe("interactive-fabric-session", () => {
  for (const entrypoint of ["stdio", "loom"] as const) {
    describe(entrypoint, () => {
      it("passes the configured Fabric session to the actual prompt loop", async () => {
        const { options, root } = await observeTurn(entrypoint, [
          "--fabric-api-url",
          "http://localhost:8123",
          "--fabric-identity",
          "identity.pem",
          "--fabric-space",
          "synthetic-space",
        ]);
        expect(options.fabricSession).toEqual({
          apiUrl: "http://localhost:8123",
          identityKeyPath: join(root, "identity.pem"),
          space: "synthetic-space",
        });
      });
      it("uses the host environment and retains the selected CFC posture", async () => {
        const { options, root } = await observeTurn(entrypoint, [], {
          CF_HARNESS_FABRIC_API_URL: "http://localhost:8123",
          CF_HARNESS_FABRIC_IDENTITY: "identity.pem",
          CF_HARNESS_FABRIC_SPACE: "synthetic-space",
          CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE: "enforce-strict",
          CF_HARNESS_FABRIC_CFC_FLOW_LABELS: "persist",
        });
        expect(options.fabricSession).toEqual({
          apiUrl: "http://localhost:8123",
          identityKeyPath: join(root, "identity.pem"),
          space: "synthetic-space",
          cfcEnforcementMode: "enforce-strict",
          cfcFlowLabels: "persist",
        });
      });
      it("passes a named posture and read ceiling through the same host binding", async () => {
        const { options } = await observeTurn(entrypoint, [
          "--fabric-cfc-posture",
          "max-enforcement",
          "--max-confidentiality",
          '["did:key:zOwner"]',
        ], {
          CF_HARNESS_FABRIC_API_URL: "http://localhost:8123",
          CF_HARNESS_FABRIC_IDENTITY: "/tmp/synthetic-identity.pem",
          CF_HARNESS_FABRIC_SPACE: "synthetic-space",
        });
        expect(options.fabricSession?.cfcPosture).toBe("max-enforcement");
        expect(options.fabricSession?.cfcReadMaxConfidentiality).toEqual([
          "did:key:zOwner",
        ]);
      });
      for (
        const [flags, env, error] of [
          [
            [
              "--fabric-api-url",
              "not-a-url",
              "--fabric-identity",
              "identity.pem",
              "--fabric-space",
              "synthetic-space",
            ],
            {},
            "valid URL",
          ],
          [
            ["--fabric-space="],
            { CF_HARNESS_FABRIC_SPACE: "synthetic-space" },
            "non-empty",
          ],
          [
            [],
            { CF_HARNESS_FABRIC_CFC_ENFORCEMENT_MODE: "observe" },
            "enforce-explicit or enforce-strict",
          ],
          [
            [],
            { CF_HARNESS_FABRIC_CFC_FLOW_LABELS: "unsupported" },
            "off, observe, or persist",
          ],
          [
            [],
            { CF_HARNESS_FABRIC_CFC_POSTURE: "max-enforcement" },
            "need --fabric-api-url",
          ],
          [
            ["--max-confidentiality", '["did:key:zOwner"]'],
            {},
            "needs --fabric-api-url",
          ],
        ] as const
      ) {
        it(`refuses invalid configuration: ${error}`, async () => {
          await expect(observeTurn(entrypoint, [...flags], env)).rejects
            .toThrow(error);
        });
      }
      it("leaves Fabric session options absent without configuration", async () => {
        const { options } = await observeTurn(entrypoint, []);
        expect(options.fabricSession).toBeUndefined();
      });
      it("throws before starting a turn when the host supplies only part of a session", async () => {
        await expect(
          observeTurn(entrypoint, [], {
            CF_HARNESS_FABRIC_SPACE: "synthetic-space",
          }),
        ).rejects.toThrow("go together");
      });
      it("lets explicit flags override the host environment", async () => {
        const { options } = await observeTurn(entrypoint, [
          "--fabric-space=chosen-space",
        ], {
          CF_HARNESS_FABRIC_API_URL: "http://localhost:8123",
          CF_HARNESS_FABRIC_IDENTITY: "/tmp/synthetic-identity.pem",
          CF_HARNESS_FABRIC_SPACE: "environment-space",
        });
        expect(options.fabricSession?.space).toBe("chosen-space");
      });
      it("keeps repeated Fabric flags consistent with the batch parser", async () => {
        const flags = [
          "--fabric-space",
          "first-space",
          "--fabric-space",
          "last-space",
        ];
        const env = {
          CF_HARNESS_FABRIC_API_URL: "http://localhost:8123",
          CF_HARNESS_FABRIC_IDENTITY: "/tmp/synthetic-identity.pem",
          CF_HARNESS_FABRIC_SPACE: "environment-space",
        };
        const batch = await parseCfHarnessCliArgs([
          "--prompt",
          "Synthetic input",
          ...flags,
        ], { cwd: "/tmp", env });
        if ("help" in batch) throw new Error("Unexpected help");
        const { options } = await observeTurn(entrypoint, flags, env);
        expect(options.fabricSession).toEqual(batch.fabricSession);
        expect(options.fabricSession?.space).toBe("last-space");
      });
      it("refuses a missing Fabric value instead of treating the next flag as its value", async () => {
        await expect(observeTurn(entrypoint, ["--fabric-space", "--help"], {
          CF_HARNESS_FABRIC_API_URL: "http://localhost:8123",
          CF_HARNESS_FABRIC_IDENTITY: "/tmp/synthetic-identity.pem",
        })).rejects.toThrow("`--fabric-space` was given no value");
      });
    });
  }
});
