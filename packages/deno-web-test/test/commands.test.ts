import { runDenoWebTest } from "./utils.ts";

Deno.test("a test presses keys the browser treats as the person's", async function () {
  const run = await runDenoWebTest("commands-project");

  for (
    const name of [
      "a pressed Tab moves focus, and Shift\\+Tab moves it back",
      "a dispatched Tab moves nothing",
      "a press settles once the browser has handled all of it",
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
    /an unknown modifier is refused \.\.\. .*FAILED/.test(run.stdoutText),
    "an unknown modifier fails its test",
  );
  run.assert(
    /`Space` is not a key a test may press/.test(run.stdoutText),
    "the failure names the key",
  );
  run.assert(
    /`Hyper` is not a key a test may hold down/.test(run.stdoutText),
    "the failure names the modifier",
  );
  run.assert(/3 passed \| 2 failed/.test(run.stdoutText), "summary");
});
