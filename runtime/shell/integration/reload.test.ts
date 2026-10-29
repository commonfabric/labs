import { assert } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { createTestSpace, env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";

import { ShellIntegration } from "../../integration/shell-utils.ts";

const { FRONTEND_URL } = env;

// How many reloads one run holds the harness to. The shell finishes booting a
// couple of milliseconds after the document's load event, so a single read
// taken right after a reload can step over that window by luck; several
// reloads make a navigation that returns early show up.
const RELOADS = 5;

describe("shell reload tests", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("answers for its state as soon as a reload returns", async () => {
    // `globalThis.app` is the handle every driver reaches the shell through,
    // and the shell publishes it as the last step of its bootstrap module. That
    // module body runs on past the document's load event, so a navigation that
    // returns on load can return while the shell is still booting, and a driver
    // that reads the shell right then reads nothing. A test that reloads should
    // not have to know that: when a reload returns, the shell behind it
    // answers.

    const identity = await Identity.generate({ implementation: "noble" });
    const spaceDid = await createTestSpace(identity);
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid },
      identity,
    });

    for (let reload = 1; reload <= RELOADS; reload++) {
      await page.reload({ waitUntil: "load" });
      assert(
        await shell.state(),
        `Reload ${reload} returned before the shell was there to drive: ` +
          `the shell reported no state.`,
      );
    }
  });
});
