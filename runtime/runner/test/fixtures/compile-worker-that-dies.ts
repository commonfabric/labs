/**
 * A compile worker that dies on a request for a program whose entry is
 * `/dies.tsx`, by throwing from a listener, and otherwise compiles as the
 * real one does (`module-compile-worker.test.ts`).
 */

import { isPlainObject } from "@commonfabric/js-values/types";

import "../../src/harness/compile-worker.ts";

self.addEventListener("message", (event: MessageEvent) => {
  const data: unknown = event.data;
  if (
    isPlainObject(data) && isPlainObject(data.request) &&
    isPlainObject(data.request.program) &&
    typeof data.request.program.main === "string" &&
    data.request.program.main.endsWith("/dies.tsx")
  ) {
    throw new Error("This compile worker dies on `/dies.tsx`");
  }
});
