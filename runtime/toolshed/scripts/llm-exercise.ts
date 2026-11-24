#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Smoke-tests the language models a running toolshed serves: asks each one
 * for a one-word answer and reports the ones that failed. `API_URL` names the
 * toolshed, `http://localhost:8000` by default.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";

import { colors } from "@/routes/ai/llm/cli.ts";

const TEST_SYSTEM_PROMPT = "Be creative.";
const TEST_PROMPT =
  `What's your favorite color? Responses must be 1 word only.`;

export const USAGE = "Usage:\n" +
  "  deno task llm-exercise [model1,model2,...]\n" +
  "If no models are provided, all supported models are checked.";

export interface ExerciseDeps {
  /** The toolshed's origin. */
  apiUrl: string;
  fetch: typeof fetch;
  log: (line: string) => void;
  logError: (line: string) => void;
}

async function listModels({ apiUrl, fetch }: ExerciseDeps): Promise<string[]> {
  const response = await fetch(`${apiUrl}/api/ai/llm/models`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Listing models failed: HTTP status ${response.status}`);
  }
  return Object.keys(await response.json());
}

/** Asks `modelName` the test prompt, returning whether it answered. */
async function exercise(
  modelName: string,
  { apiUrl, fetch, log, logError }: ExerciseDeps,
): Promise<boolean> {
  const payload = {
    model: modelName,
    system: TEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: TEST_PROMPT }],
    stream: false,
    cache: false,
  };

  log(
    `${colors.blue}TEST REQUEST for ${modelName}:${colors.reset}\n` +
      JSON.stringify(payload, null, 2) + "\n",
  );

  try {
    const response = await fetch(`${apiUrl}/api/ai/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`HTTP status ${response.status}`);
    }
    log(
      `${colors.green}TEST RESPONSE for ${modelName}:${colors.reset}\n` +
        JSON.stringify(await response.json(), null, 2) + "\n",
    );
    return true;
  } catch (error) {
    logError(
      `${colors.red}ERROR for ${modelName}:${colors.reset} ${
        describeFailure(error)
      }`,
    );
    return false;
  }
}

/** Returns an exit code rather than calling `Deno.exit`, so it is testable. */
export async function main(
  args: string[],
  deps: ExerciseDeps,
): Promise<number> {
  const { log } = deps;
  if (args.some((arg) => arg.trim() === "--help")) {
    log(USAGE);
    return 0;
  }

  const allModels = await listModels(deps);
  const matchers = args[0]?.split(",").map((s) => s.trim());
  const matchedModels = matchers
    ? allModels.filter((model) =>
      matchers.some((matcher) => model.includes(matcher))
    )
    : allModels;

  if (matchedModels.length === 0) {
    log("No models matched!");
    return 0;
  }

  log("Testing models:");
  log(matchedModels.map((model) => `* ${model}`).join("\n"));
  log("");

  const failures = [];
  for (const model of matchedModels) {
    if (!(await exercise(model, deps))) {
      failures.push(model);
    }
  }

  log("");
  if (failures.length) {
    log(`${colors.red}Failed models:`);
    log(failures.map((model) => `* ${model}`).join("\n"));
    log(`${colors.reset}`);
    return 1;
  }
  log(`${colors.green}Success!${colors.reset}`);
  return 0;
}

if (import.meta.main) {
  Deno.exit(
    await main(Deno.args, {
      apiUrl: Deno.env.get("API_URL") || "http://localhost:8000",
      fetch,
      log: console.log,
      logError: console.error,
    }),
  );
}
