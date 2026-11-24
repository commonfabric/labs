// A worker that, on its first message, locks its realm down and rejects a
// promise it never handles, first installing `logUnhandledRejections()` when
// that message is `contained`. A listener for the rejection posts `rejected`,
// and the worker answers each later message `ping` with `pong`.
//
// `../unhandled-rejections.test.ts` runs it.

import { ensureSESLockdown } from "../../src/sandbox/ses-runtime.ts";
import { logUnhandledRejections } from "../../src/sandbox/unhandled-rejections.ts";

let started = false;
globalThis.onmessage = (event: MessageEvent<string>) => {
  if (started) {
    if (event.data === "ping") globalThis.postMessage("pong");
    return;
  }
  started = true;
  if (event.data === "contained") logUnhandledRejections();
  ensureSESLockdown();
  globalThis.addEventListener(
    "unhandledrejection",
    () => globalThis.postMessage("rejected"),
  );
  Promise.reject(new Error("rejected with no handler"));
};
