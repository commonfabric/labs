import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { main, USAGE } from "./llm-exercise.ts";
import { describe, it } from "@commonfabric/test-support/test";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

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

  describe("as a script", () => {
    const script = fromFileUrl(new URL("./llm-exercise.ts", import.meta.url));
    const repositoryRoot = fromFileUrl(new URL("../../../", import.meta.url));

    /**
     * Runs the script under `deno run` against a toolshed serving the models
     * `good`, which answers, and `bad`, which fails.
     */
    async function runScript(args: string[]) {
      const asked: string[] = [];
      await using server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        async (request) => {
          if (new URL(request.url).pathname === "/api/ai/llm/models") {
            return Response.json({ good: {}, bad: {} });
          }
          const { model } = await request.json();
          asked.push(model);
          return Response.json({ content: "Blue" }, {
            status: model === "good" ? 200 : 500,
          });
        },
      );
      const output = await runDenoCommandWithTemporaryLock({
        root: repositoryRoot,
        cwd: fromFileUrl(new URL("../", import.meta.url)),
        args: (lock) => [
          "run",
          `--lock=${lock}`,
          "--allow-net=127.0.0.1",
          "--allow-env",
          script,
          ...args,
        ],
        env: { API_URL: `http://127.0.0.1:${server.addr.port}` },
      });
      const decoder = new TextDecoder();
      return {
        code: output.code,
        stdout: decoder.decode(output.stdout),
        stderr: decoder.decode(output.stderr),
        asked,
      };
    }

    it("asks the toolshed `API_URL` names and exits 0 when all answer", async () => {
      const { code, stdout, stderr, asked } = await runScript(["good"]);
      expect(code).toBe(0);
      expect(stderr).not.toContain("ERROR for");
      expect(asked).toEqual(["good"]);
      expect(stdout).toContain("Success!");
    });

    it("exits 1 and reports a failing model on stderr", async () => {
      const { code, stdout, stderr, asked } = await runScript([]);
      expect(code).toBe(1);
      expect(asked).toEqual(["good", "bad"]);
      expect(stderr).toContain("ERROR for bad:");
      expect(stderr).not.toContain("ERROR for good");
      expect(stdout).toContain("* bad");
      expect(stdout).not.toContain("Success!");
    });
  });
});
