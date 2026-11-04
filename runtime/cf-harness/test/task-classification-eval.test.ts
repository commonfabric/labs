import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { codexEvalModel, main } from "../scripts/task-classification-eval.ts";
import type { TaskClassificationCase } from "./task-classification-cases.ts";

const cases: TaskClassificationCase[] = [
  {
    task: "what's on Thursday?",
    context: {},
    expected: ["find"],
    domains: ["personal"],
  },
  {
    task: "make me a pomodoro timer",
    context: {},
    expected: ["author"],
    domains: ["fabric"],
  },
];

/** Runs the eval with `args`, returning its exit code and what it logged. */
const run = async (
  args: string[],
  model?: (prompt: string) => Promise<string>,
) => {
  const lines: string[] = [];
  const code = await main(args, {
    log: (line) => lines.push(line),
    cases,
    ...(model !== undefined
      ? { model: () => ({ name: "scripted", ask: model }) }
      : {}),
  });
  return { code, lines };
};

describe("task-classification-eval", () => {
  it("refuses a misspelled flag before scoring anything", async () => {
    const { code, lines } = await run(["--harness-hmoe", "x"]);

    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--harness-home");
  });

  it("scores the rule alone with --rule-only", async () => {
    const { code, lines } = await run(["--rule-only"]);

    expect(code).toBe(0);
    expect(lines[0]).toContain("model -");
    expect(lines.at(-1)).toMatch(/^rule: 2\/2 exact/);
  });

  it("scores the model on every case, counting a failed call as a miss", async () => {
    const { code, lines } = await run(
      [],
      (prompt) =>
        prompt.includes("Thursday")
          ? Promise.resolve("find")
          : Promise.reject(new Error("provider down")),
    );

    expect(code).toBe(0);
    expect(lines[0]).toContain("model find");
    expect(lines[1]).toContain("model error: provider down");
    expect(lines.at(-1)).toMatch(/^model \(scripted\): 1\/2 exact, latency/);
  });

  it("names the Codex research model and refuses a call with no credential", async () => {
    const harnessHome = await Deno.makeTempDir();
    try {
      const model = codexEvalModel(harnessHome, "local");

      expect(model.name).toBe("gpt-6-luna");
      await expect(model.ask("Tag this.")).rejects.toThrow();
    } finally {
      await Deno.remove(harnessHome, { recursive: true });
    }
  });
});
