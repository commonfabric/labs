import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { main, USAGE } from "./llm-exercise.ts";

const API_URL = "http://toolshed.test";

/**
 * Runs the script against a toolshed serving `models`, where each model
 * answers with `answer(model)`: a status, or a thrown failure.
 */
async function run(
  args: string[],
  models: string[],
  answer: (model: string) => number | Error = () => 200,
) {
  const lines: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  const code = await main(args, {
    apiUrl: API_URL,
    fetch: (input, init) => {
      const url = String(input);
      if (url === `${API_URL}/api/ai/llm/models`) {
        return Promise.resolve(Response.json(
          Object.fromEntries(models.map((name) => [name, {}])),
        ));
      }
      expect(url).toBe(`${API_URL}/api/ai/llm`);
      const { model, cache, stream } = JSON.parse(String(init?.body));
      expect({ cache, stream }).toEqual({ cache: false, stream: false });
      asked.push(model);
      const outcome = answer(model);
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(
        Response.json({ role: "assistant", content: "Blue" }, {
          status: outcome,
        }),
      );
    },
    log: (line) => lines.push(line),
    logError: (line) => errors.push(line),
  });
  return { code, lines, errors, asked };
}

describe("llm-exercise", () => {
  describe("main()", () => {
    it("prints the usage for `--help` and asks nothing", async () => {
      const { code, lines, asked } = await run(["--help"], ["a:one"]);
      expect(code).toBe(0);
      expect(lines).toEqual([USAGE]);
      expect(asked).toEqual([]);
    });

    it("asks every model when no matcher is given and returns 0", async () => {
      const { code, lines, asked } = await run([], ["a:one", "b:two"]);
      expect(code).toBe(0);
      expect(asked).toEqual(["a:one", "b:two"]);
      expect(lines.at(-1)).toContain("Success!");
    });

    it("asks only the models a matcher names", async () => {
      const { asked } = await run(["one, three"], [
        "a:one",
        "b:two",
        "c:three",
      ]);
      expect(asked).toEqual(["a:one", "c:three"]);
    });

    it("returns 0 without asking when no model matches", async () => {
      const { code, lines, asked } = await run(["zzz"], ["a:one"]);
      expect(code).toBe(0);
      expect(lines).toEqual(["No models matched!"]);
      expect(asked).toEqual([]);
    });

    it("returns 1 and names each model that failed", async () => {
      const { code, lines, errors } = await run(
        [],
        ["a:one", "b:two", "c:three"],
        (model) =>
          model === "a:one"
            ? 500
            : model === "b:two"
            ? new TypeError("connection refused")
            : 200,
      );
      expect(code).toBe(1);
      expect(errors).toEqual([
        expect.stringContaining("HTTP status 500"),
        expect.stringContaining("connection refused"),
      ]);
      expect(lines).toContain("* a:one\n* b:two");
    });

    it("rejects when the model list cannot be read", async () => {
      await expect(
        main([], {
          apiUrl: API_URL,
          fetch: () => Promise.resolve(new Response("", { status: 503 })),
          log: () => {},
          logError: () => {},
        }),
      ).rejects.toThrow("Listing models failed: HTTP status 503");
    });
  });
});
