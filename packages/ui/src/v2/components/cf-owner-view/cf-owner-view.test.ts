import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFOwnerView } from "./index.ts";

class HeadlessOwnerView extends CFOwnerView {
  override get isConnected(): boolean {
    return true;
  }
}

describe("CFOwnerView", () => {
  it("uses runtime principal and persisted label across profile changes", async () => {
    const element = new HeadlessOwnerView();
    const writes: boolean[] = [];
    element.runtime = {
      actingPrincipalDid: () => "did:key:alice",
    } as unknown as RuntimeClient;
    element.originator = {
      getCfcLabel: () =>
        Promise.resolve({
          version: 1,
          entries: [{
            path: [],
            label: {
              integrity: [{
                kind: "represents-principal",
                subject: "did:key:alice",
              }],
            },
          }],
        }),
      selectedProfile: "did:key:bob",
    } as unknown as CellHandle;
    element.result = {
      set: (value: boolean) => {
        writes.push(value);
        return Promise.resolve();
      },
    } as unknown as CellHandle<boolean>;

    await element.refresh();
    expect(writes).toEqual([false, true]);
    (element.originator as unknown as { selectedProfile: string })
      .selectedProfile = "did:key:alice";
    await element.refresh();
    expect(writes).toEqual([false, true, false, true]);
  });

  it("keeps the owner view closed when the attestation is forged or ambiguous", async () => {
    const element = new HeadlessOwnerView();
    const writes: boolean[] = [];
    element.runtime = {
      actingPrincipalDid: () => "did:key:alice",
    } as unknown as RuntimeClient;
    element.originator = {
      ownerPrincipal: "did:key:alice",
      getCfcLabel: () =>
        Promise.resolve({
          version: 1,
          entries: [{
            path: [],
            label: {
              integrity: [
                { kind: "represents-principal", subject: "did:key:alice" },
                { kind: "represents-principal", subject: "did:key:bob" },
              ],
            },
          }],
        }),
    } as unknown as CellHandle;
    element.result = {
      set: (value: boolean) => {
        writes.push(value);
        return Promise.resolve();
      },
    } as unknown as CellHandle<boolean>;

    await element.refresh();
    expect(writes).toEqual([false]);
  });
});
