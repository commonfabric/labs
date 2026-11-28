import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import ts from "typescript";
import { describe, it } from "@commonfabric/test-support/test";

const perf = new URL("../../perf/", import.meta.url);

// Runs `run-tsc.ts` as a program, with the frozen, cache-only resolution the
// script itself gives the compiler it starts.
async function runScript(args: string[]) {
  const { code, stdout } = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--cached-only",
      "--frozen=true",
      "-A",
      fromFileUrl(new URL("run-tsc.ts", perf)),
      ...args,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).output();
  return { code, stdout: new TextDecoder().decode(stdout) };
}

describe("run-tsc.ts", () => {
  it("runs the pinned compiler with its arguments and exits with its status", async () => {
    const { code, stdout } = await runScript(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(`Version ${ts.version}`);
  });

  it("exits with the compiler's failing status", async () => {
    const { code, stdout } = await runScript([
      "--project",
      fromFileUrl(new URL("tsconfig.missing.json", perf)),
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain("tsconfig.missing.json");
    expect(stdout).not.toContain("Version");
  });
});
