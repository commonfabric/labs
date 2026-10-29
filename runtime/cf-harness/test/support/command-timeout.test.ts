/**
 * Both outcomes of the bound are pinned, because a helper stuck on either one
 * looks correct from the other side: a bound that always expires passes a test
 * that only checks the timeout, and a bound that never expires passes a test
 * that only checks a child's own exit.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { commandStatusWithTimeout } from "./command-timeout.ts";

/**
 * The child blocks on a read of a pipe nothing ever writes to, so it cannot
 * reach an exit of its own and the bound is the only thing that can end the
 * wait. A child that merely takes a while would race the bound against
 * process startup, and the assertion would hold or not according to how
 * loaded the machine is.
 */
const blockingChild = () =>
  new Deno.Command(Deno.execPath(), {
    args: ["eval", "await Deno.stdin.read(new Uint8Array(1))"],
    stdin: "piped",
    stdout: "null",
    stderr: "null",
  });

/**
 * The longest delay `setTimeout` accepts before wrapping to a short one. A
 * bound this far out cannot expire while the test runs, so the child's own
 * exit is the only outcome the race has.
 */
const UNREACHABLE_BOUND_MS = 2_147_483_647;

describe("commandStatusWithTimeout", () => {
  it("returns `timed-out` for a child that does not exit on its own", async () => {
    const result = await commandStatusWithTimeout(blockingChild(), 20);

    expect(result).toEqual({ kind: "timed-out" });
  });

  it("returns the child's own status when it exits within the bound", async () => {
    const result = await commandStatusWithTimeout(
      new Deno.Command(Deno.execPath(), {
        args: ["eval", "Deno.exit(3)"],
        stdout: "null",
        stderr: "null",
      }),
      UNREACHABLE_BOUND_MS,
    );

    expect(result).toEqual({
      kind: "completed",
      status: { success: false, code: 3, signal: null },
    });
  });
});
