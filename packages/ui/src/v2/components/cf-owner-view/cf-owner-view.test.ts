import type { CfcLabelView } from "@commonfabric/runner/cfc";
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

  // Connecting makes Lit schedule an update, which wants a DOM. These tests
  // call `refresh()` directly instead.
  protected override performUpdate(): void {}
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

  describe("an origin whose label is not readable at the first check", () => {
    // The label is read from what the store holds, which can lag the
    // binding: the origin's document may not be loaded yet, or may be rolled
    // back while the piece's start is retried. The element follows the
    // origin, so the label arriving later decides the presentation.

    const aliceAttestation: CfcLabelView = {
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
    };

    const followedOrigin = (element: HeadlessOwnerView) => {
      let label: CfcLabelView | undefined;
      let notify: (() => void) | undefined;
      const writes: (boolean | null)[] = [];
      let wrote = Promise.withResolvers<void>();
      element.runtime = {
        actingPrincipalDid: () => "did:key:bob",
      } as unknown as RuntimeClient;
      element.originator = {
        getCfcLabel: () => Promise.resolve(label),
        subscribe: (callback: () => void) => {
          notify = callback;
          callback();
          return () => {
            notify = undefined;
          };
        },
      } as unknown as CellHandle;
      element.result = {
        setStrict: (value: boolean | null) => {
          writes.push(value);
          wrote.resolve();
          wrote = Promise.withResolvers<void>();
          return Promise.resolve();
        },
      } as unknown as CellHandle<boolean | null>;
      return {
        writes,
        followed: () => notify !== undefined,
        // Updates the origin's label and resolves once the element has
        // written in answer.
        arrive: (view: CfcLabelView | undefined) => {
          const written = wrote.promise;
          label = view;
          notify?.();
          return written;
        },
      };
    };

    it("decides once the label arrives", async () => {
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);

      await element.refresh();
      expect(origin.writes).toEqual([null]);
      expect(origin.followed()).toBe(true);
      await origin.arrive(aliceAttestation);

      expect(origin.writes).toEqual([null, false]);
    });

    it("closes the presentation again when the label stops being readable", async () => {
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      expect(origin.followed()).toBe(true);
      await origin.arrive(aliceAttestation);

      await origin.arrive(undefined);

      expect(origin.writes).toEqual([null, false, null]);
    });

    it("stops following the origin once disconnected", async () => {
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);

      await element.refresh();
      expect(origin.followed()).toBe(true);
      element.disconnectedCallback();

      expect(origin.followed()).toBe(false);
    });

    it("follows the origin again once moved to another parent", async () => {
      // A move disconnects and reconnects the element without changing a
      // property, so no update runs to start following again.
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      element.disconnectedCallback();

      element.connectedCallback();

      expect(origin.followed()).toBe(true);
      await origin.arrive(aliceAttestation);
      expect(origin.writes).toEqual([null, false]);
    });
  });
});
