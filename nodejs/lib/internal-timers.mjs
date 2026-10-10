// Keeps Node's own internals on the real timers when code replaces the global
// timer functions (as a test's fake clock does).
//
// Node implements parts of the platform in JavaScript that calls the global
// `setTimeout()` and friends: `fetch()` and `WebSocket` (undici) arm timers for
// their deadlines and expect Node `Timeout` objects back. Deno implements the
// same APIs natively, so a replaced global never reaches them. To match, each
// global timer function here is an accessor: assigning it installs a
// replacement as usual, and reading it from a Node builtin (a `node:` frame)
// still yields the real function. The accessor hands out the function itself
// rather than a wrapper, so no frame of this file stands between a caller and
// the replacement (a fake clock classifies callers by their stack frames).

import { getCallSites } from "node:util";

const NAMES = ["setTimeout", "setInterval", "clearTimeout", "clearInterval"];

/**
 * Whether the code reading a global (the caller of the accessor's getter) is
 * a Node builtin. This reads V8's call sites through `util.getCallSites()`
 * rather than an error's `stack`, which SES, once it locks down, empties and
 * filters `node:` frames from.
 */
function readerIsNodeBuiltin() {
  const reader = getCallSites(3)[2];
  return reader !== undefined && reader.scriptName.startsWith("node:");
}

for (const name of NAMES) {
  const real = globalThis[name];
  let installed = real;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    get: () => installed !== real && readerIsNodeBuiltin() ? real : installed,
    set: (value) => {
      installed = value;
    },
  });
}
