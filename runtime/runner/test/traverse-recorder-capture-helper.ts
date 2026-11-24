/**
 * Records three traversal invocations through the module-level capture hook
 * and exits, so the `unload` flush writes whatever `CF_TRAVERSE_CAPTURE`
 * names. Run in its own process by `traverse-recorder.test.ts`, because the
 * capture is configured from the environment when the module loads.
 */
import type { SchemaPathSelector } from "@commonfabric/api";

import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import { recordTraverseInvocation } from "../src/traverse-recorder.ts";

const selector: SchemaPathSelector = { path: ["value"], schema: true };
for (let i = 0; i < 3; i++) {
  const address: IMemorySpaceAddress = {
    space: "did:key:zCaptureHelper",
    id: `of:capture-${i}`,
    type: "application/json",
    path: ["value"],
  };
  recordTraverseInvocation(
    { address },
    selector,
    undefined,
    { traverseCells: false },
    undefined,
  );
}
