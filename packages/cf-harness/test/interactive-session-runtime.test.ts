import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

describe("interactive session runtime", () => {
  for (const scenario of ["release", "reopen"] as const) {
    it(
      scenario === "release"
        ? "releases closed sessions while keeping completed turn runtimes alive"
        : "reopens durable pieces and reacts in a later session",
      async () => {
        // A fresh process keeps SES initialization observable. WeakRef checks
        // need exposed GC and a task boundary after dropping strong references.
        const output = await runDenoCommandWithTemporaryLock({
          root: fromFileUrl(new URL("../../../", import.meta.url)),
          args: (lock) => [
            "run",
            "--lock",
            lock,
            "--frozen",
            "--cached-only",
            "-A",
            "--v8-flags=--expose-gc",
            fromFileUrl(
              new URL(
                "./support/interactive-session-runtime.ts",
                import.meta.url,
              ),
            ),
            scenario,
          ],
        });
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);
        expect(output.success, `${stderr}\n${stdout}`).toBe(true);
        const line = stdout.split("\n").find((line) =>
          line.startsWith("RUNTIME_REPORT ")
        );
        expect(line, stdout).toBeDefined();
        const report = JSON.parse(line!.slice("RUNTIME_REPORT ".length));
        expect(report.closedSessions).toBe(3);
        expect(report.aliveBeforeFirstClose).toBe(2);
        expect(report.reopened).toBe(scenario === "reopen" ? 3 : 0);
        expect(report.reactiveUpdates).toBe(scenario === "reopen" ? 6 : 0);
        expect(report.aliveAfterClose).toEqual([0, 0, 0]);
      },
    );
  }
});
