// A process that locks its realm down, prints whether lockdown froze the
// intrinsics, and then ends the way its one argument names:
//
// - `succeed` returns normally.
// - `reject` awaits a rejection at the top level.
// - `abandon` creates a rejected promise and attaches no handler.
// - `contain` installs `logUnhandledRejections()` before the lockdown, as a
//   host does at startup, then ends as `abandon` does.
// - `throw` throws from a timer callback.
//
// `run-locked-down-process.ts` runs it, for `../ses-runtime.test.ts` and
// `../unhandled-rejections.test.ts`.

import { ensureSESLockdown } from "../../src/sandbox/ses-runtime.ts";
import { logUnhandledRejections } from "../../src/sandbox/unhandled-rejections.ts";

if (Deno.args[0] === "contain") logUnhandledRejections();
ensureSESLockdown();
console.log(`intrinsics frozen: ${Object.isFrozen(Object.prototype)}`);

switch (Deno.args[0]) {
  case "succeed":
    break;
  case "reject":
    await Promise.reject(new Error("rejected at the top level"));
    break;
  case "contain":
    Promise.reject(new Error("rejected with no handler"));
    break;
  case "abandon":
    Promise.reject(new Error("rejected with no handler"));
    break;
  case "throw":
    setTimeout(() => {
      throw new Error("thrown from a timer");
    });
    break;
  default:
    throw new Error(`no ending named ${Deno.args[0]}`);
}
