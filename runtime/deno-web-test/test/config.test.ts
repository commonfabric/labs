import { join } from "@std/path";
import { runDenoWebTest } from "./utils.ts";

Deno.test("config is applied", async function () {
  const run = await runDenoWebTest("project-with-config");

  run.assert(run.success, "test successfully ran, applying chrome flags");
  run.assert(/LOG FROM TEST/.test(run.stdoutText), "console output propagated");

  run.assert(/deno run/.test(run.stderrText), "stderr has deno task run");
  run.assert(
    !/experimentalDecorators/.test(run.stderrText),
    "stderr has no compiler options warning",
  );
  run.assert(
    run.stderrText.split("\n").length === 2,
    "stderr has no other messages",
  );
  run.assert(
    run.stderrText.split("\n")[1] === "",
    "stderr has no other messages",
  );
});

Deno.test("a config that throws on import fails the run", async function () {
  // The settings a config carries decide how the whole suite runs: which
  // browser flags it gets, how long a test may take, what is served next to it.
  // A run that cannot read them and continues on the defaults instead fails
  // somewhere else entirely, for a reason that says nothing about the config.
  const run = await runDenoWebTest("broken-config-project");

  run.assert(!run.success, "the run fails");
  run.assert(
    run.stderrText.includes(
      join("broken-config-project", "deno-web-test.config.ts"),
    ),
    "the failure names the config path",
  );
  run.assert(
    /this config is deliberately broken/.test(run.stderrText),
    "the failure carries the error importing the config produced",
  );
  run.assert(
    !/would-pass/.test(run.stdoutText),
    "no test ran on the default settings",
  );
});
