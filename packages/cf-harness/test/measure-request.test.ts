/** The per-tag first-request measurement, over a recorded run. */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { main, measureRequest } from "../scripts/measure-request.ts";

/** What a recorded loom carry run leaves that the measurement reads. */
const writeRecordedRun = (dir: string): void => {
  Deno.writeTextFileSync(
    join(dir, "policy-snapshot.json"),
    JSON.stringify({
      parentTools: {
        allowedToolIds: [
          "run_pattern",
          "search_patterns",
          "describe_handle",
          "run_command",
          "loom_search",
          "submit_result",
        ],
      },
      subagents: { allowedProfiles: ["default", "pattern-author"] },
    }),
  );
  Deno.writeTextFileSync(
    join(dir, "transcript.json"),
    JSON.stringify([
      {
        role: "system",
        content: [
          "You are cf-harness.",
          "Result schema (JSON):",
          JSON.stringify({ type: "object" }),
          "",
          "Additional instructions:",
          "Answer in one line.",
        ].join("\n"),
      },
      { role: "user", content: "Granted references for this run: none." },
      { role: "user", content: "count to 100" },
      { role: "assistant", content: "" },
    ]),
  );
};

describe("measure-request", () => {
  let dir: string;

  beforeEach(() => {
    dir = Deno.makeTempDirSync();
    writeRecordedRun(dir);
  });

  afterEach(() => {
    Deno.removeSync(dir, { recursive: true });
  });

  it("returns one row per tag over the recorded run's granted tools", async () => {
    const { toolCount, rows } = await measureRequest(dir);
    expect(toolCount).toBe(6);
    expect(rows.map((row) => row.tag)).toEqual([
      "respond",
      "find",
      "act",
      "pieces",
      "author",
      "fallback",
    ]);
  });

  it("returns the same tools bytes for every tag", async () => {
    const { rows } = await measureRequest(dir);
    expect(new Set(rows.map((row) => row.toolsBytes)).size).toBe(1);
  });

  it("measures a recorded run with no result schema, additional instructions or pattern index", async () => {
    Deno.writeTextFileSync(
      join(dir, "transcript.json"),
      JSON.stringify([
        { role: "system", content: "You are cf-harness." },
        { role: "user", content: "count to 100" },
        { role: "assistant", content: "" },
      ]),
    );
    Deno.writeTextFileSync(
      join(dir, "policy-snapshot.json"),
      JSON.stringify({
        parentTools: { allowedToolIds: ["run_pattern", "submit_result"] },
        subagents: { allowedProfiles: ["default"] },
      }),
    );
    const { rows } = await measureRequest(dir);
    expect(rows).toHaveLength(6);
  });

  it("returns more input bytes for an author task than for a reply, and the most with no tags", async () => {
    const { rows } = await measureRequest(dir);
    const inputOf = (tag: string) =>
      rows.find((row) => row.tag === tag)!.inputBytes;
    expect(inputOf("author")).toBeGreaterThan(inputOf("respond"));
    expect(inputOf("fallback")).toBeGreaterThanOrEqual(inputOf("author"));
  });

  it("logs the rows as JSON and exits 0 given one directory", async () => {
    const logged: string[] = [];
    const out = { log: (line: string) => logged.push(line), error: () => {} };
    expect(await main([dir], out)).toBe(0);
    expect(JSON.parse(logged[0]).rows).toHaveLength(6);
  });

  it("logs its usage as an error and exits 2 given no directory", async () => {
    const logged: string[] = [];
    const errors: string[] = [];
    const out = {
      log: (line: string) => logged.push(line),
      error: (line: string) => errors.push(line),
    };
    expect(await main([], out)).toBe(2);
    expect(logged).toEqual([]);
    expect(errors[0]).toContain("usage:");
  });
});
