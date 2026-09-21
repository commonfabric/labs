import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { PropertyValues } from "lit";

import { CFOwnerView } from "./index.ts";

class HeadlessOwnerView extends CFOwnerView {
  override get isConnected(): boolean {
    return true;
  }

  override willUpdate(_changed: PropertyValues): void {}
}

describe("CFOwnerView", () => {
  it("uses runtime principal and persisted label across profile changes", async () => {
    const element = new HeadlessOwnerView();
    const writes: (boolean | null)[] = [];
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
      setStrict: (value: boolean | null) => {
        writes.push(value);
        return Promise.resolve();
      },
    } as unknown as CellHandle<boolean | null>;

    await element.refresh();
    expect(writes).toEqual([null, true]);
    (element.originator as unknown as { selectedProfile: string })
      .selectedProfile = "did:key:alice";
    await element.refresh();
    expect(writes).toEqual([null, true, null, true]);
  });

  it("keeps the owner view closed when the attestation is forged or ambiguous", async () => {
    const element = new HeadlessOwnerView();
    const writes: (boolean | null)[] = [];
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
      setStrict: (value: boolean | null) => {
        writes.push(value);
        return Promise.resolve();
      },
    } as unknown as CellHandle<boolean | null>;

    await element.refresh();
    expect(writes).toEqual([null]);
  });

  it("does not verify a visitor when the reset is refused", async () => {
    const element = new HeadlessOwnerView();
    const writes: (boolean | null)[] = [];
    element.runtime = {
      actingPrincipalDid: () => "did:key:bob",
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
    } as unknown as CellHandle;
    element.result = {
      setStrict: (value: boolean | null) => {
        writes.push(value);
        if (value === null) return Promise.reject(new Error("write refused"));
        return Promise.resolve();
      },
    } as unknown as CellHandle<boolean | null>;

    await element.refresh();
    expect(writes).toEqual([null]);
  });

  it("verifies a non-owner only from a readable unique attestation", async () => {
    const element = new HeadlessOwnerView();
    const writes: (boolean | null)[] = [];
    element.runtime = {
      actingPrincipalDid: () => "did:key:bob",
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
    } as unknown as CellHandle;
    element.result = {
      setStrict: (value: boolean | null) => {
        writes.push(value);
        return Promise.resolve();
      },
    } as unknown as CellHandle<boolean | null>;

    await element.refresh();
    expect(writes).toEqual([null, false]);
  });
});
