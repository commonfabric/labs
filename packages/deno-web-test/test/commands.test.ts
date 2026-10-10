import { runDenoWebTest } from "./utils.ts";

Deno.test("a test presses keys the browser treats as the person's", async function () {
  const run = await runDenoWebTest("commands-project");

  for (
    const name of [
      "a pressed Tab moves focus",
      "a dispatched Tab moves nothing",
      "a pressed key reaches listeners as trusted",
    ]
  ) {
    run.assert(
      new RegExp(`${name} \\.\\.\\. .*ok`).test(run.stdoutText),
      `${name} passes`,
    );
  }
  run.assert(
    /an unknown key is refused \.\.\. .*FAILED/.test(run.stdoutText),
    "an unknown key fails its test",
  );
  run.assert(
    /pressKey cannot press "Space"/.test(run.stdoutText),
    "the failure names the key",
  );
  run.assert(/3 passed \| 1 failed/.test(run.stdoutText), "summary");
});
