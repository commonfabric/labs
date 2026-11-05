import { runDenoWebTest } from "./utils.ts";

Deno.test("a `bundle` entry is bundled onto the server root", async function () {
  const run = await runDenoWebTest("bundle-project");

  run.assert(run.success, "the run succeeds");
  run.assert(
    /a bundled module loads into a realm the page creates \.\.\. ok/.test(
      run.stdoutText,
    ),
    "the worker loads its bundled module",
  );
  run.assert(
    /a bundled module loads into a sandboxed iframe \.\.\. ok/.test(
      run.stdoutText,
    ),
    "the sandboxed iframe loads its bundled module",
  );
});
