/**
 * Checks the seed probe's posture assertion against canonical and faulty flag
 * parsers. Pass the checkout to inspect; run with that checkout's Deno config.
 */

import { expect } from "@std/expect";
import { join, resolve, toFileUrl } from "@std/path";

const root = resolve(Deno.args[0] ?? Deno.cwd());
const { experimentalOptionsFromEnv } = await import(
  toFileUrl(join(root, "packages/runner/src/runtime-presets.ts")).href
);
const source = await Deno.readTextFile(
  join(root, "tools/server-execution-topics/seed-check.ts"),
);
const start = source.includes("const rawPosture")
  ? source.indexOf("const rawPosture")
  : source.indexOf("const expectedPosture");
const end = source.indexOf("const topicCount");
expect(start >= 0 && end > start).toBe(true);
const evaluate = new Function(
  "Deno",
  "experimentalOptionsFromEnv",
  "SERVER_EXECUTION_DEFAULT_ENABLED",
  "expect",
  `${source.slice(start, end)}\nreturn expectedPosture;`,
);
for (const fallback of [false, true]) {
  for (const flag of [undefined, "false", "true"]) {
    const env = {
      get: (key: string) =>
        key === "EXPERIMENTAL_SERVER_EXECUTION" ? flag : undefined,
    };
    const expected = flag === undefined ? fallback : flag === "true";
    expect(evaluate({ env }, experimentalOptionsFromEnv, fallback, expect))
      .toBe(expected);
    console.log(JSON.stringify({ fallback, flag: flag ?? "unset", expected }));
    if (flag !== undefined) {
      const wrongParser = () => ({ serverExecution: flag !== "true" });
      expect(() => evaluate({ env }, wrongParser, fallback, expect)).toThrow();
      console.log(
        JSON.stringify({ fallback, flag, faultyParserRejected: true }),
      );
    }
  }
}
