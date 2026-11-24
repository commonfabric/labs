/** Verifies that batch hosts admit the declared Loom authoring tools. */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createCfHarnessCliCapabilities } from "../src/cli.ts";
import {
  createLoomLocalCfHarnessHost,
  parseCfHarnessCliArgs,
} from "./support/on-linux.ts";
import type { CreateHarnessPromptLoopOptions } from "../src/prompt-loop.ts";

/** Tool grant used by Loom's collection-capable batch profiles. */
const authoringTools = [
  "loom_compose",
  "loom_inspect",
  "loom_authoring_context",
];

describe("loom-authoring-batch-admission", () => {
  it("advertises each Loom authoring tool as a parent tool", () => {
    for (const tool of authoringTools) {
      expect(createCfHarnessCliCapabilities().parentToolIds).toContain(tool);
    }
  });
  for (const tool of authoringTools) {
    it(`accepts an explicit ${tool} grant in the batch CLI`, async () => {
      const parsed = await parseCfHarnessCliArgs([
        "--prompt",
        "Synthetic collection",
        "--allow-tool",
        tool,
      ], { cwd: "/tmp", env: {} });
      expect("help" in parsed).toBe(false);
      if ("help" in parsed) throw new Error("Unexpected help");
      expect(parsed.allowedToolIds).toEqual([tool]);
    });
  }
  it("passes all three grants through the strict Loom batch host to its prompt loop", async () => {
    const home = await Deno.makeTempDir();
    const seen: CreateHarnessPromptLoopOptions[] = [];
    try {
      const authoringConfig = {
        cliPath: Deno.execPath(),
        transport: {
          kind: "direct",
          instanceDir: home,
          runId: "synthetic-batch",
          actor: "agent:acceptance",
        },
      };
      const configPath = join(home, "loom-authoring.json");
      await Deno.writeTextFile(configPath, JSON.stringify(authoringConfig));
      const host = await createLoomLocalCfHarnessHost({
        harnessHome: await Deno.realPath(home),
        env: { CF_HARNESS_GATEWAY_AUTH_MODE: "none" },
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
        cliDependencies: {
          cwd: home,
          io: { stdout() {}, stderr() {} },
          createPromptLoop: (options) => {
            seen.push(options);
            return {
              runPrompt: () =>
                Promise.resolve({
                  model: "synthetic-model",
                  finalAssistantText: "Synthetic result",
                  transcript: [],
                  modelTurns: 1,
                  runState: options.engine!.getRunState(),
                }),
              runTranscript: () =>
                Promise.reject(new Error("Unexpected resume")),
            };
          },
        },
      });
      const code = await host.runBatch([
        "--prompt",
        "Synthetic collection",
        "--output-mode",
        "batch",
        "--loom-authoring-config",
        configPath,
        ...authoringTools.flatMap((tool) => ["--allow-tool", tool]),
      ]);
      expect(code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0].allowedToolIds).toEqual(authoringTools);
      expect(seen[0].engine?.config.loomAuthoring).toEqual(authoringConfig);
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });
});
