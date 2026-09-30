/**
 * These cover the entry point alone — what it prints and what code it returns.
 * The checks it applies are pinned in
 * `packages/dashboard/bench-report.test.ts`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { main } from "./check-bench-report.ts";
import { KEY_BENCHMARKS } from "../packages/dashboard/bench-report.ts";

const CALIBRATION = "packages/dashboard/machine-calibration.bench.ts";

const stats = { min: 1, avg: 2, max: 3, p75: 2, p99: 3, p995: 3, p999: 3 };

/** Helper for the tests below, which turns whole keys into a report. */
const report = (keys: readonly string[]): string =>
  JSON.stringify({
    version: 1,
    cpu: "AMD EPYC 9V74",
    benches: keys.map((key) => {
      const [origin, rest] = key.split(" > ");
      const slash = rest.lastIndexOf("/");
      return {
        origin: `file:///runner/${origin}`,
        group: slash < 0 ? null : rest.slice(0, slash),
        name: rest.slice(slash + 1),
        results: [{ ok: stats }],
      };
    }),
  });

/** Helper for the tests below, which runs `body` with console output captured. */
function captureConsole(body: () => void): {
  out: string;
  err: string;
} {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    body();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

/** Helper for the tests below, which writes `json` to a file and checks it. */
async function check(
  json: string,
): Promise<{ code: number; out: string; err: string }> {
  const directory = await Deno.makeTempDir({ prefix: "check-bench-report-" });
  const path = join(directory, "results.json");
  await Deno.writeTextFile(path, json);
  let code = -1;
  const { out, err } = captureConsole(() => {
    code = main(path);
  });
  await Deno.remove(directory, { recursive: true });
  return {
    code,
    out: out.replaceAll(path, "<path>"),
    err: err.replaceAll(path, "<path>"),
  };
}

describe("check-bench-report", () => {
  describe("as a program", () => {
    // The Benchmarks workflow reads this check's exit code and nothing else,
    // which only running it as a program states. It is started through
    // `Deno.execPath()` rather than through `deno` on the PATH, since a
    // coverage profile one Deno version writes cannot be reported by another,
    // and with `--frozen` so that the spawn resolves the checked-in dependency
    // graph rather than a new one.

    it("exits 1 and names the problem for a report the tiles cannot read", async () => {
      const directory = await Deno.makeTempDir({
        prefix: "check-bench-report-program-",
      });
      const path = join(directory, "results.json");
      await Deno.writeTextFile(
        path,
        report([`${CALIBRATION} > integer arithmetic`]),
      );
      const { code, stderr } = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--frozen",
          "--allow-read",
          "tasks/check-bench-report.ts",
          path,
        ],
        cwd: new URL("../", import.meta.url),
        stdout: "null",
      }).output();
      await Deno.remove(directory, { recursive: true });
      expect(code).toBe(1);
      expect(new TextDecoder().decode(stderr))
        .toContain("no product benchmark measurements");
    });
  });

  describe("main()", () => {
    it("returns 0 and names the file for a report the tiles can read", async () => {
      const { code, out, err } = await check(
        report([`${CALIBRATION} > integer arithmetic`, ...KEY_BENCHMARKS]),
      );
      expect(code).toBe(0);
      expect(out).toBe("<path>: readable by every benchmark tile");
      expect(err).toBe("");
    });

    it("returns 1 and names the problem for a report the tiles cannot read", async () => {
      const { code, out, err } = await check(
        report([`${CALIBRATION} > integer arithmetic`]),
      );
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toContain("<path>: the report carries no product benchmark");
    });

    it("returns 2 and prints usage given no file", () => {
      let code = -1;
      const { out, err } = captureConsole(() => {
        code = main(undefined);
      });
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toBe("usage: check-bench-report.ts <results.json>");
    });
  });
});
