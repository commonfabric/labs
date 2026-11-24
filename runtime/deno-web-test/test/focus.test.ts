import { describe, it } from "@std/testing/bdd";

import { runDenoWebTest } from "./utils.ts";

describe("browser", () => {
  it("gives the page focus in every test file a run loads", async () => {
    // The browser stopped treating the page as focused after its fifth test
    // file, so the project has more files than that, each failing unless the
    // page has focus.
    const run = await runDenoWebTest("focus-project");

    run.assert(run.success, "the run passes");
    run.assert(/8 passed \| 0 failed/.test(run.stdoutText), "summary");
  });
});
