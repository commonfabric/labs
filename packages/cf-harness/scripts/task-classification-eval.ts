/**
 * Scores task classification over the 2026-10-13 playtest asks two ways: the
 * keyword rule alone, and the cheap-model path alone, asked of every case
 * whether or not the rule had an answer. Prints each case and the accuracy and
 * latency of both paths.
 *
 * The model path makes one live call per case on the owner's Codex
 * credential from the harness home, so it is run by hand, never in CI:
 *
 *   deno run -A packages/cf-harness/scripts/task-classification-eval.ts \
 *     [--harness-home ~/.cf-harness] [--owner local] [--rule-only]
 */
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

import {
  defaultHarnessCredentialStorePath,
  FileHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import { OpenAICodexCredentialResolver } from "../src/auth/openai-codex.ts";
import {
  recordUndeclaredFlags,
  refuseFlagsWithoutValue,
  refuseUndeclaredFlags,
} from "../src/cli-flags.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { researchModel } from "../src/research/runner.ts";
import {
  classifyTaskByModel,
  classifyTaskByRule,
  type HarnessTaskTag,
} from "../src/task-classification.ts";
import {
  PLAYTEST_2026_10_13_TASKS,
  type TaskClassificationCase,
} from "../test/task-classification-cases.ts";

/** The model the eval asks: its name and one call. */
export interface EvalModel {
  name: string;
  ask: (prompt: string) => Promise<string>;
}

/** The Codex research model on the owner's credential in `harnessHome`. */
export const codexEvalModel = (
  harnessHome: string,
  ownerKey: string,
): EvalModel => {
  const credentialOwner = {
    type: "cf-harness.credential-owner-ref",
    version: 1,
    ownerKey,
  } as const;
  const client = new OpenAICodexResponsesClient({
    credentialResolver: new OpenAICodexCredentialResolver({
      store: new FileHarnessCredentialStore({
        path: defaultHarnessCredentialStorePath(harnessHome),
      }),
      ownerKey,
      credentialOwner,
    }),
    credentialOwner,
  });
  const model = researchModel(client.providerId);
  return {
    name: model,
    ask: async (prompt) =>
      (await client.complete({
        model,
        transcript: [{ role: "user", content: prompt }],
        tools: [],
        nativeModelToolIds: [],
        runId: "task-classification-eval",
      })).assistant.content,
  };
};

const label = (tags: ReadonlySet<HarnessTaskTag> | undefined) =>
  tags === undefined ? "(none)" : [...tags].sort().join(",");

/** The `q` quantile of `sorted`, in whole milliseconds. */
const quantile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    .toFixed(0);

export const main = async (
  args: readonly string[],
  options: {
    log?: (line: string) => void;
    cases?: readonly TaskClassificationCase[];

    /** The model to score; the owner's Codex research model by default. */
    model?: (harnessHome: string, ownerKey: string) => EvalModel;
  } = {},
): Promise<number> => {
  const log = options.log ?? console.log;
  const cases = options.cases ?? PLAYTEST_2026_10_13_TASKS;
  const undeclared: string[] = [];
  const flags = parseArgs([...args], {
    string: ["harness-home", "owner"],
    boolean: ["rule-only"],
    unknown: recordUndeclaredFlags(undeclared),
  });
  // Before any call: a misspelled `--harness-home` would otherwise score
  // against the default credential store.
  try {
    refuseFlagsWithoutValue(args, ["harness-home", "owner"]);
    refuseUndeclaredFlags(
      undeclared,
      ["harness-home", "owner", "rule-only"],
      "`task-classification-eval`",
    );
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const model = flags["rule-only"] ? undefined : (options.model ??
    codexEvalModel)(
      flags["harness-home"] ??
        join(Deno.env.get("HOME") ?? ".", ".cf-harness"),
      flags.owner ?? "local",
    );

  let ruleCorrect = 0;
  let modelCorrect = 0;
  let ruleMs = 0;
  const modelMs: number[] = [];
  for (const { task, context, expected } of cases) {
    const want = label(new Set(expected));
    const ruleStarted = performance.now();
    const byRule = label(classifyTaskByRule(task, context));
    ruleMs += performance.now() - ruleStarted;
    if (byRule === want) ruleCorrect += 1;
    let byModel = "-";
    if (model !== undefined) {
      const modelStarted = performance.now();
      try {
        byModel = label(await classifyTaskByModel(task, context, model.ask));
      } catch (error) {
        byModel = `error: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      modelMs.push(performance.now() - modelStarted);
      if (byModel === want) modelCorrect += 1;
    }
    log(
      [
        JSON.stringify(task),
        `want ${want}`,
        `rule ${byRule}`,
        `model ${byModel}`,
      ].join(" | "),
    );
  }

  log(
    `rule: ${ruleCorrect}/${cases.length} exact, ${
      ruleMs.toFixed(2)
    } ms for the set`,
  );
  if (model !== undefined) {
    const sorted = [...modelMs].sort((a, b) => a - b);
    log(
      `model (${model.name}): ${modelCorrect}/${cases.length} exact, latency p50 ${
        quantile(sorted, 0.5)
      } ms, p90 ${quantile(sorted, 0.9)} ms, max ${quantile(sorted, 1)} ms`,
    );
  }
  return 0;
};

// deno-coverage-ignore-start -- the entrypoint guard is false under every test
// that imports this module, which is what it is for
if (import.meta.main) Deno.exit(await main(Deno.args));
// deno-coverage-ignore-stop
