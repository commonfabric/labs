import type { CfcLabelView } from "@commonfabric/runner/cfc";
import {
  $conn,
  CellHandle,
  type CellRef,
  type CellUpdateNotification,
  EventEmitter,
  type InitializationData,
  type IPCClientMessage,
  type IPCClientNotification,
  NotificationType,
  RequestType,
  type RuntimeClient,
  RuntimeConnection,
  type RuntimeTransport,
  type RuntimeTransportEvents,
} from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { PropertyValues } from "lit";

import { CFOwnerView } from "./index.ts";

/**
 * Gives a stand-in origin the `asSchema()` the element subscribes through,
 * answering with the stand-in itself.
 */
const asOrigin = (origin: object): CellHandle => {
  const handle = { ...origin, asSchema: () => handle };
  return handle as unknown as CellHandle;
};

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
    // The ambiguous label decides `null` once, as any label read after the
    // reset decides once.
    expect(writes).toEqual([null, null]);
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
      let notifyRefused: (() => void) | undefined;
      const writes: (boolean | null)[] = [];
      const reads: Promise<CfcLabelView | undefined>[] = [];
      element.runtime = {
        actingPrincipalDid: () => "did:key:bob",
      } as unknown as RuntimeClient;
      element.originator = asOrigin({
        getCfcLabel: () => {
          const read = Promise.resolve(label);
          reads.push(read);
          return read;
        },
        subscribe: (
          callback: (value: unknown, cfcLabel?: CfcLabelView) => void,
          options: { onRefused: () => void },
        ) => {
          notify = callback;
          notifyRefused = options.onRefused;
          callback(undefined, label);
          return () => {
            notify = undefined;
            notifyRefused = undefined;
          };
        },
      });
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
        // The worker refuses the origin's read from here on.
        refuse: () => notifyRefused?.(),
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

    it("closes the presentation when the worker refuses the origin, reading no label", async () => {
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      origin.arrive(attestationOf("did:key:bob"));
      expect(origin.writes).toEqual([null, true]);
      const readsBefore = origin.reads.length;

      origin.refuse();

      expect(origin.writes).toEqual([null, true, null]);
      expect(origin.reads).toHaveLength(readsBefore);
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

    it("writes a changed label's decision even when it decides the same", async () => {
      // A write of the earlier decision may have been rolled back since, and
      // the changed label writes it again.
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      origin.arrive(aliceAttestation);

      origin.arrive(attestationOf("did:key:carol"));

      expect(origin.writes).toEqual([null, false, false]);
    });

    it("writes nothing for a label it has already decided from", async () => {
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      origin.arrive(aliceAttestation);

      origin.arrive(aliceAttestation);
      origin.arrive(aliceAttestation, false);
      await origin.lastRead();

      expect(origin.writes).toEqual([null, false]);
    });

    it("ignores an update from an origin it is no longer bound to", async () => {
      // The binding changes when the property is set, and the element
      // follows the new origin only once the update that follows runs. An
      // update the old origin delivers in between is not this binding's.
      const element = new HeadlessOwnerView();
      const origin = followedOrigin(element);
      await element.refresh();
      const aliceLabel = (
        callback: (value: unknown, cfcLabel?: CfcLabelView) => void,
      ) => {
        callback(undefined, aliceAttestation);
        return () => {};
      };
      element.originator = asOrigin({
        getCfcLabel: () => Promise.resolve(aliceAttestation),
        subscribe: aliceLabel,
      });

      origin.arrive(attestationOf("did:key:bob"));
      await element.refresh();

      expect(origin.writes).toEqual([null, null, false]);
    });
  });

  describe("writes each decision once", () => {
    // Writes stay bounded whatever happens to `result` after one: a decision
    // is written once until the label or the binding changes it.

    const originDelivering = (subject: string) =>
      asOrigin({
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
      });

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
  describe("an origin another handle subscribed to first for its value", () => {
    // The client shares one subscription among the handles on one cell and
    // schema, and the first of them decides whether it carries labels. The
    // stand-in worker below answers the connection as the worker does: a
    // change to the label alone reaches only the subscriptions that asked
    // for labels.

    const attestation: CfcLabelView = {
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

    class StandInWorker extends EventEmitter<RuntimeTransportEvents>
      implements RuntimeTransport {
      #label: CfcLabelView | undefined;
      readonly #labelled: CellRef[] = [];

      send(message: IPCClientMessage | IPCClientNotification): void {
        if (!("msgId" in message)) return;
        const request = message.data;
        if (request.type === RequestType.CellSubscribe) {
          if (request.includeCfcLabel) this.#labelled.push(request.cell);
        }
        const data = request.type === RequestType.CellGetCfcLabel
          ? { cfcLabel: this.#label }
          : undefined;
        queueMicrotask(() => {
          this.emit("message", { msgId: message.msgId, data });
        });
      }

      /** Changes the origin's label and nothing else. */
      relabel(label: CfcLabelView): void {
        this.#label = label;
        for (const cell of this.#labelled) {
          // What the worker's host-read gate posts; a test stands in for it.
          const update = {
            type: NotificationType.CellUpdate,
            cell,
            value: {},
            cfcLabel: label,
          } as CellUpdateNotification;
          this.emit("message", update);
        }
      }

      dispose(): Promise<void> {
        return Promise.resolve();
      }
    }

    it("decides from a change to the label alone", async () => {
      const worker = new StandInWorker();
      const connection = new RuntimeConnection(worker);
      await connection.initialize({} as InitializationData);
      const runtime = {
        [$conn]: () => connection,
        actingPrincipalDid: () => "did:key:bob",
      } as unknown as RuntimeClient;
      const origin: CellRef = {
        space: "did:key:space",
        id: "of:origin",
        scope: "space",
        path: [],
      };
      const valueOnly = new CellHandle(runtime, origin);
      const stopValueOnly = valueOnly.subscribe(() => {}, {
        onRefused: () => {},
      });
      const writes: (boolean | null)[] = [];
      const element = new HeadlessOwnerView();
      element.runtime = runtime;
      element.originator = new CellHandle(runtime, origin);
      element.result = {
        setStrict: (value: boolean | null) => {
          writes.push(value);
          return Promise.resolve();
        },
      } as unknown as CellHandle<boolean | null>;
      try {
        await element.refresh();
        expect(writes).toEqual([null]);

        worker.relabel(attestation);

        expect(writes).toEqual([null, false]);
      } finally {
        element.disconnectedCallback();
        stopValueOnly();
        await connection.dispose();
      }
    });
  });
  describe("edges of its lifecycle", () => {
    const alice: CfcLabelView = {
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

    // Runs Lit's update hook as a mounted element does, without a DOM.
    class UpdatingOwnerView extends CFOwnerView {
      override get isConnected(): boolean {
        return true;
      }

      protected override performUpdate(): void {}
    }

    const bind = (
      element: CFOwnerView,
      options: {
        actor?: () => string;
        label?: () => Promise<CfcLabelView | undefined>;
        reset?: () => Promise<void>;
      } = {},
    ) => {
      const writes: (boolean | null)[] = [];
      element.runtime = {
        actingPrincipalDid: options.actor ?? (() => "did:key:bob"),
      } as unknown as RuntimeClient;
      element.originator = {
        getCfcLabel: options.label ?? (() => Promise.resolve(alice)),
      } as unknown as CellHandle;
      element.result = {
        setStrict: (value: boolean | null) => {
          writes.push(value);
          return value === null && options.reset
            ? options.reset()
            : Promise.resolve();
        },
      } as unknown as CellHandle<boolean | null>;
      return writes;
    };

    it("rechecks the origin when a bound property changes, and not otherwise", () => {
      const element = new UpdatingOwnerView();
      const writes = bind(element);

      element.willUpdate(new Map([["hidden", false]]));
      expect(writes).toEqual([]);

      element.willUpdate(new Map([["originator", undefined]]));
      expect(writes).toEqual([null]);
    });

    it("renders no content of its own", () => {
      expect(new HeadlessOwnerView().render().strings.join("")).toBe("");
    });

    it("leaves a first connect to the update that follows it", () => {
      const element = new HeadlessOwnerView();
      const writes = bind(element);

      element.connectedCallback();

      expect(writes).toEqual([]);
    });

    it("starts over when moved before its reset landed", async () => {
      // The first reset is held, so the move finds no decision standing and
      // refreshes again, and the held reset decides nothing once it lands.
      const element = new HeadlessOwnerView();
      const held = Promise.withResolvers<void>();
      let resets = 0;
      const writes = bind(element, {
        reset: () => ++resets === 1 ? held.promise : Promise.resolve(),
      });
      const refreshes: Promise<void>[] = [];
      const refresh = element.refresh.bind(element);
      element.refresh = () => {
        const refreshing = refresh();
        refreshes.push(refreshing);
        return refreshing;
      };
      void element.refresh();
      element.disconnectedCallback();

      element.connectedCallback();
      held.resolve();
      await Promise.all(refreshes);

      expect(refreshes).toHaveLength(2);
      expect(writes).toEqual([null, null, false]);
    });

    it("follows its origin before a result is bound, and writes nothing", async () => {
      const element = new HeadlessOwnerView();
      const writes = bind(element);
      element.result = undefined;

      await element.refresh();

      expect(writes).toEqual([]);
    });

    it("keeps the presentation closed when the label cannot be read", async () => {
      const element = new HeadlessOwnerView();
      const writes = bind(element, {
        label: () => Promise.reject(new Error("the label is unreadable")),
      });

      await element.refresh();

      expect(writes).toEqual([null]);
    });

    it("keeps the presentation closed when the acting principal is unknown", async () => {
      const element = new HeadlessOwnerView();
      const writes = bind(element, {
        actor: () => {
          throw new Error("no principal is signed in");
        },
      });

      await element.refresh();

      expect(writes).toEqual([null, null]);
    });
  });
});
