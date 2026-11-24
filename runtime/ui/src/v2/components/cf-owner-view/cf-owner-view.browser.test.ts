import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";

import { CFOwnerView } from "./index.ts";

Deno.test("cf-owner-view updates its native owner decision when the acting principal changes", async () => {
  const ownerDecision = Promise.withResolvers<void>();
  const visitorDecision = Promise.withResolvers<void>();
  const writes: (boolean | null)[] = [];
  const element = document.createElement("cf-owner-view") as CFOwnerView;
  element.originator = {
    getCfcLabel: () =>
      Promise.resolve({
        version: 1,
        entries: [{
          path: [],
          label: {
            integrity: [{
              kind: "represents-principal",
              subject: "did:key:owner",
            }],
          },
        }],
      }),
  } as unknown as CellHandle;
  element.result = {
    setStrict: (value: boolean | null) => {
      writes.push(value);
      if (value === true) ownerDecision.resolve();
      if (value === false) visitorDecision.resolve();
      return Promise.resolve();
    },
  } as unknown as CellHandle<boolean | null>;

  document.body.append(element);
  try {
    expect(element).toBeInstanceOf(CFOwnerView);
    element.runtime = {
      actingPrincipalDid: () => "did:key:owner",
    } as unknown as RuntimeClient;
    await element.updateComplete;
    expect(writes).toContain(null);
    await ownerDecision.promise;
    expect(writes).toEqual([null, true]);

    element.runtime = {
      actingPrincipalDid: () => "did:key:visitor",
    } as unknown as RuntimeClient;
    await visitorDecision.promise;
    expect(writes).toEqual([null, true, null, false]);
  } finally {
    element.remove();
  }
});
