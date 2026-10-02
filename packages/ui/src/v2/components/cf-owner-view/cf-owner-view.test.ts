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
    // The label is what the store holds, which can lag the binding: the
    // origin's document may not be loaded yet, or may be rolled back while
    // the piece's start is retried. The element follows the origin, so the
    // label an update delivers later decides the presentation.

    const attestationOf = (subject: string): CfcLabelView => ({
      version: 1,
      entries: [{
        path: [],
        label: {
          integrity: [{ kind: "represents-principal", subject }],
        },
      }],
    });
    const aliceAttestation = attestationOf("did:key:alice");

    const followedOrigin = (element: HeadlessOwnerView) => {
      let label: CfcLabelView | undefined;
      let notify:
        | ((value: unknown, cfcLabel?: CfcLabelView) => void)
        | undefined;
      const writes: (boolean | null)[] = [];
      const reads: Promise<CfcLabelView | undefined>[] = [];
      element.runtime = {
        actingPrincipalDid: () => "did:key:bob",
      } as unknown as RuntimeClient;
      element.originator = {
        getCfcLabel: () => {
          const read = Promise.resolve(label);
          reads.push(read);
          return read;
        },
        subscribe: (
          callback: (value: unknown, cfcLabel?: CfcLabelView) => void,
        ) => {
          notify = callback;
          callback(undefined, label);
          return () => {
            notify = undefined;
          };
        },
      } as unknown as CellHandle;
      element.result = {
        setStrict: (value: boolean | null) => {
          writes.push(value);
          return Promise.resolve();
        },
      } as unknown as CellHandle<boolean | null>;
      return {
        writes,
        reads,
        followed: () => notify !== undefined,
        // Stores `view` as the origin's label and delivers an update, with
        // the label unless `delivered` is false. A decision from a delivered
        // label is written by the time this returns. One from a read is
        // written once `lastRead()` settles: the element reacts to the read
        // before anything awaiting it here does.
        arrive: (view: CfcLabelView | undefined, delivered = true) => {
          label = view;
          notify?.(undefined, delivered ? view : undefined);
        },
        lastRead: () => reads.at(-1),
      };
    };

    it("decides once the label arrives, from the label the update delivers", async () => {
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);

      await element.refresh();
      expect(origin.writes).toEqual([null]);
      expect(origin.followed()).toBe(true);
      const readsBefore = origin.reads.length;
      origin.arrive(aliceAttestation);

      expect(origin.writes).toEqual([null, false]);
      expect(origin.reads).toHaveLength(readsBefore);
    });

    it("reads the label when an update delivers none", async () => {
      // Another handle on the same cell may have subscribed first for its
      // value alone, and then its updates carry no label.
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      const readsBefore = origin.reads.length;

      origin.arrive(aliceAttestation, false);
      expect(origin.reads).toHaveLength(readsBefore + 1);
      await origin.lastRead();

      expect(origin.writes).toEqual([null, false]);
    });

    it("closes the presentation again when the label stops being readable", async () => {
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      origin.arrive(aliceAttestation);

      origin.arrive(undefined);
      await origin.lastRead();

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
      origin.arrive(aliceAttestation);
      expect(origin.writes).toEqual([null, false]);
    });
  });

  describe("writes each decision once", () => {
    // Writes stay bounded whatever happens to `result` after one: a decision
    // is written once until the label or the binding changes it.

    const originDelivering = (subject: string) =>
      ({
        getCfcLabel: () =>
          Promise.resolve({
            version: 1,
            entries: [{
              path: [],
              label: {
                integrity: [{ kind: "represents-principal", subject }],
              },
            }],
          }),
        subscribe: (
          callback: (value: unknown, cfcLabel?: CfcLabelView) => void,
        ) => {
          callback(undefined, {
            version: 1,
            entries: [{
              path: [],
              label: {
                integrity: [{ kind: "represents-principal", subject }],
              },
            }],
          });
          return () => {};
        },
      }) as unknown as CellHandle;

    // A `result` cell whose subscribers see each write as soon as it is made,
    // the way storage applies a commit locally. Once `refuseWrites` is
    // called, a write that changes the value is refused later, by `refuse`,
    // which reverts it the way storage does when the server refuses the
    // commit afterwards. A cap on writes stops a loop from running forever.
    const sharedResult = () => {
      let value: boolean | null = null;
      const writes: (boolean | null)[] = [];
      const subscribers = new Set<(value: boolean | null) => void>();
      const show = (next: boolean | null) => {
        value = next;
        for (const subscriber of [...subscribers]) subscriber(next);
      };
      let refusing = false;
      const refusals: (() => void)[] = [];
      const cell = {
        setStrict: (next: boolean | null) => {
          writes.push(next);
          if (writes.length > 20 || next === value) return Promise.resolve();
          const prior = value;
          show(next);
          if (!refusing) return Promise.resolve();
          const refused = Promise.withResolvers<void>();
          refusals.push(() => {
            show(prior);
            refused.reject(new Error("the commit was refused"));
          });
          return refused.promise;
        },
        subscribe: (callback: (value: boolean | null) => void) => {
          subscribers.add(callback);
          callback(value);
          return () => subscribers.delete(callback);
        },
      } as unknown as CellHandle<boolean | null>;
      return {
        cell,
        writes,
        refuseWrites: () => {
          refusing = true;
        },
        refuse: () => refusals.shift()?.(),
      };
    };

    it("writes a refused decision once", async () => {
      const element = new HeadlessOwnerView();
      element.runtime = {
        actingPrincipalDid: () => "did:key:bob",
      } as unknown as RuntimeClient;
      element.originator = originDelivering("did:key:alice");
      const result = sharedResult();
      result.refuseWrites();
      element.result = result.cell;
      await element.refresh();
      expect(result.writes).toEqual([null, false]);

      result.refuse();

      expect(result.writes).toEqual([null, false]);
    });

    it("leaves two elements sharing one result to the last write", async () => {
      const elementFor = (subject: string) => {
        const element = new HeadlessOwnerView();
        element.runtime = {
          actingPrincipalDid: () => "did:key:bob",
        } as unknown as RuntimeClient;
        element.originator = originDelivering(subject);
        return element;
      };
      const result = sharedResult();
      const owned = elementFor("did:key:bob");
      const visited = elementFor("did:key:alice");
      owned.result = result.cell;
      visited.result = result.cell;

      await owned.refresh();
      await visited.refresh();

      expect(result.writes).toEqual([null, true, null, false]);
    });
  });
});
