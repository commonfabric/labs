#!/usr/bin/env -S deno run --allow-net --allow-env

import { colors } from "@/routes/ai/llm/cli.ts";

const API_URL = Deno.env.get("API_URL") || "http://localhost:8000";
const MODEL_URL = `${API_URL}/api/ai/llm`;
const MODELS_URL = `${API_URL}/api/ai/llm/models`;
const TEST_SYSTEM_PROMPT = "Be creative.";
const TEST_PROMPT =
  `What's your favorite color? Responses must be 1 word only.`;

class LLMTest {
  static async getModels(): Promise<string[]> {
    const response = await fetch(MODELS_URL, {
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error("Response not ok.");
    }
    return Object.keys(await response.json());
  }

  async test(modelName: string): Promise<boolean> {
    const payload = {
      model: modelName,
      system: TEST_SYSTEM_PROMPT,
      messages: [{ role: "user", content: TEST_PROMPT }],
      stream: false,
      cache: false,
    };

    console.log(
      `${colors.blue}TEST REQUEST for ${modelName}:${colors.reset}\n` +
        JSON.stringify(payload, null, 2) +
        "\n",
    );

    try {
      const response = await fetch(MODEL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      console.log(
        `${colors.green}TEST RESPONSE for ${modelName}:${colors.reset}\n` +
          JSON.stringify(data, null, 2) +
          "\n",
      );
    } catch (error) {
      console.error(
        `${colors.red}ERROR for ${modelName}:${colors.reset} ${
          (error as Error).message
        }`,
      );
      return false;
    }
    return true;
  }
}

function printUsage() {
  console.log(
    "Usage:\n" +
      "  deno run --allow-net --allow-env scripts/test-toolshed-llm.ts [model1,model2,...]\n" +
      "If no models are provided, all supported models are checked.",
  );
}

async function main(args: string[]) {
  if (args.some((arg) => arg.trim() === "--help")) {
    printUsage();
    Deno.exit(0);
  }

  const llm = new LLMTest();
  const allModels = await LLMTest.getModels();
  const matchers = args[0]
    ? args[0].split(",").map((s) => s.trim())
    : undefined;
  const matchedModels = matchers
    ? allModels.filter((model) =>
      matchers.some((matcher) => model.indexOf(matcher) !== -1)
    )
    : allModels;

  if (matchedModels.length === 0) {
    console.log("No models matched!");
    Deno.exit(0);
  }

  console.log("Testing models:");
  console.log(matchedModels.map((model) => `* ${model}`).join("\n"));
  console.log("");

  const failures = [];
  for (const model of matchedModels) {
    if (!(await llm.test(model))) {
      failures.push(model);
    }
  }

  console.log("");
  if (failures.length) {
    console.log(`${colors.red}Failed models:`);
    console.log(failures.map((model) => `* ${model}`).join("\n"));
    console.log(`${colors.reset}`);
    Deno.exit(1);
  } else {
    console.log(`${colors.green}Success!${colors.reset}`);
    Deno.exit(0);
  }
}

await main(Deno.args);
