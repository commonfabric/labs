import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { taggedHashStringOf } from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type MemoryProtocolFlags,
  type SessionSync,
} from "../../v2.ts";
import { connect, loopback, type Transport } from "../../v2/client.ts";
import { Server } from "../../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

/** Returns a sync envelope for wire assertions without asserting its type. */
function syncOf(message: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(message)) return;
  const sync = message.type === "session/effect"
    ? message.effect
    : message.type === "response" && isPlainObject(message.ok)
    ? message.ok.sync
    : undefined;
  return isPlainObject(sync) ? sync : undefined;
}

/** Returns metadata with enough repetition to benefit from a label table. */
function document(version: number) {
  return {
    value: { flavor: "chocolate", version },
    cfc: {
      version: 1,
      schemaHash: taggedHashStringOf(true),
      otherMetadata: "unchanged",
      labelMap: {
        version: 1,
        entries: Array.from({ length: 17 }, (_, index) => ({
          path: ["flavor", "ingredients", "chocolate", String(index % 2)],
          label: {
            confidentiality: ["donut-secret", "chocolate-recipe"],
            integrity: [],
            ...(index === 16 ? { singleton: true } : {}),
            evidence: linkRefFrom({
              id: "of:donut-policy",
              path: [],
              schema: {
                type: "object",
                properties: { origin: { type: "string" } },
              },
            }),
          },
        })),
      },
    },
  };
}

describe("sync-label-negotiation", () => {
  for (const schemaEnabled of [false, true]) {
    for (const serverEnabled of [false, true]) {
      for (const clientEnabled of [undefined, false, true]) {
        it(`restores exact metadata with server=${serverEnabled}, client=${clientEnabled}, and schemas=${schemaEnabled}`, async () => {
          /** Server whose advertised capability models each deployment arm. */
          class CapabilityServer extends Server {
            /** @inheritDoc */
            override memoryProtocolFlags(): MemoryProtocolFlags {
              return {
                ...super.memoryProtocolFlags(),
                syncLabelTableV1: serverEnabled,
                syncSchemaTableV2: schemaEnabled,
              };
            }
          }
          const server = new CapabilityServer({
            ...testSessionOpenServerOptions,
            store: new URL("memory://sync-label-negotiation"),
          });
          const frames: Record<string, unknown>[] = [];
          const transport = loopback(server);
          const observerTransport: Transport = {
            ...transport,
            send(payload) {
              const message = decodeMemoryBoundary(payload);
              if (isPlainObject(message) && message.type === "hello") {
                const { syncLabelTableV1: _offered, ...flags } =
                  getMemoryProtocolFlags();
                return transport.send(encodeMemoryBoundary({
                  ...message,
                  flags: {
                    ...flags,
                    syncSchemaTableV2: schemaEnabled,
                    ...(clientEnabled === undefined
                      ? {}
                      : { syncLabelTableV1: clientEnabled }),
                  },
                }));
              }
              return transport.send(payload);
            },
            setReceiver(receiver) {
              transport.setReceiver((payload) => {
                const sync = syncOf(decodeMemoryBoundary(payload));
                if (sync !== undefined) frames.push(sync);
                receiver(payload);
              });
            },
          };
          const writerClient = await connect({ transport: loopback(server) });
          const observerClient = await connect({
            transport: observerTransport,
          });
          try {
            const space = "did:key:sync-label-negotiation";
            const writer = await writerClient.mount(
              space,
              {},
              testSessionOpenAuthFactory,
            );
            const observer = await observerClient.mount(
              space,
              {},
              testSessionOpenAuthFactory,
            );
            const write = (version: number) =>
              writer.transact({
                localSeq: version,
                reads: { confirmed: [], pending: [] },
                operations: [{
                  op: "set",
                  id: "of:donuts",
                  value: document(version),
                }, {
                  op: "set",
                  id: `cid:${taggedHashStringOf(true)}`,
                  value: { value: true },
                }],
              });
            await write(1);
            const { view, sync } = await observer.watchAddSync([{
              id: "donuts",
              kind: "graph",
              query: {
                roots: [{
                  id: "of:donuts",
                  selector: { path: [], schema: true },
                }],
              },
            }]);
            expect(encodeMemoryBoundary(
              sync.upserts.find((entry) => entry.id === "of:donuts")?.doc,
            )).toBe(encodeMemoryBoundary(document(1)));
            expect(Object.hasOwn(sync, "labelTable")).toBe(false);
            expect(Object.hasOwn(sync, "labelPathTable")).toBe(false);

            const updates = view.subscribeSync();
            await write(2);
            const pushed = await updates.next();
            expect(pushed.done).toBe(false);
            if (pushed.done) throw new Error("Expected a pushed sync");
            expect(encodeMemoryBoundary(
              pushed.value.upserts.find((entry) => entry.id === "of:donuts")
                ?.doc,
            )).toBe(encodeMemoryBoundary(document(2)));
            expect(Object.hasOwn(pushed.value, "labelTable")).toBe(false);
            expect(Object.hasOwn(pushed.value, "labelPathTable")).toBe(false);
            const contentFrames = frames.filter((frame) =>
              Array.isArray(frame.upserts) && frame.upserts.length > 0
            );
            expect(contentFrames).toHaveLength(2);
            for (const frame of contentFrames) {
              expect(Array.isArray(frame.labelTable))
                .toBe(serverEnabled && clientEnabled === true);
              expect(Array.isArray(frame.labelPathTable))
                .toBe(serverEnabled && clientEnabled === true);
              expect(Object.hasOwn(frame, "schemaTable")).toBe(schemaEnabled);
              if (!serverEnabled || clientEnabled !== true) {
                expect(Object.hasOwn(frame, "labelTable")).toBe(false);
                expect(Object.hasOwn(frame, "labelPathTable")).toBe(false);
              }
            }
          } finally {
            await writerClient.close();
            await observerClient.close();
            await server.close();
          }
        });
      }
    }
  }

  for (const advertised of [undefined, false, true]) {
    for (
      const sample of [
        { name: "label table", fields: { labelTable: [null] } },
        { name: "path table", fields: { labelPathTable: [null] } },
        {
          name: "indexed path without a table",
          fields: {
            upserts: [{
              branch: "",
              id: "of:donuts",
              seq: 1,
              doc: { cfc: { labelMap: { entries: [{ path: 0, label: {} }] } } },
            }],
          },
        },
        {
          name: "indexed label without a table",
          fields: {
            upserts: [{
              branch: "",
              id: "of:donuts",
              seq: 1,
              doc: { cfc: { labelMap: { entries: [{ path: [], label: 0 }] } } },
            }],
          },
        },
        ...["label", "path"].flatMap((field) =>
          [false, true].map((objectEntries) => ({
            name: `indexed ${field} with missing sibling and version in ${
              objectEntries ? "object" : "array"
            } entries`,
            fields: {
              upserts: [{
                branch: "",
                id: "of:donuts",
                seq: 1,
                doc: {
                  cfc: {
                    labelMap: {
                      entries: objectEntries
                        ? { "0": { [field]: 0 } }
                        : [{ [field]: 0 }],
                    },
                  },
                },
              }],
            },
          }))
        ),
        {
          name: "application metadata lookalikes with null CFC",
          accepted: true,
          fields: {
            upserts: [{
              branch: "",
              id: "of:donuts",
              seq: 1,
              doc: {
                cfc: null,
                value: {
                  labelTable: [null],
                  labelPathTable: [null],
                  cfc: { labelMap: { entries: [{ label: 0, path: 0 }] } },
                },
              },
            }],
          },
        },
      ]
    ) {
      it(`${"accepted" in sample ? "delivers" : "rejects"} ${sample.name} when the server advertises ${advertised}`, async () => {
        let receive = (_payload: string): void => {};
        const { syncLabelTableV1: _capability, ...flags } =
          getMemoryProtocolFlags();
        const transport: Transport = {
          send(payload) {
            const message = decodeMemoryBoundary(payload);
            if (!isPlainObject(message)) throw new Error("Expected a request");
            receive(encodeMemoryBoundary(
              message.type === "hello"
                ? {
                  type: "hello.ok",
                  protocol: "memory",
                  flags: {
                    ...flags,
                    ...(advertised === undefined
                      ? {}
                      : { syncLabelTableV1: advertised }),
                  },
                  sessionOpen: {
                    audience: "did:key:donuts",
                    challenge: { value: "donuts", expiresAt: 1_000_000 },
                  },
                }
                : {
                  type: "response",
                  requestId: message.requestId,
                  ok: {
                    sync: {
                      type: "sync",
                      fromSeq: 0,
                      toSeq: 1,
                      upserts: [],
                      removes: [],
                      ...sample.fields,
                    },
                  },
                },
            ));
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
          setReceiver(receiver) {
            receive = receiver;
          },
        };
        const client = await connect({ transport });
        try {
          expect(client.serverFlags?.syncLabelTableV1).toBe(
            advertised === true,
          );
          const pending = client.request<{ sync: SessionSync }>({
            type: "test.sync",
            requestId: "invalid-table",
          });
          if ("accepted" in sample) {
            const delivered = await pending;
            expect(encodeMemoryBoundary(delivered.sync.upserts)).toBe(
              encodeMemoryBoundary(sample.fields.upserts),
            );
            expect(client.isConnected()).toBe(true);
            return;
          }
          await expect(pending).rejects.toMatchObject({
            name: "InvalidMessageError",
            cause: {
              message: advertised === true
                ? expect.stringContaining("label")
                : "Unnegotiated `syncLabelTableV1` metadata",
            },
          });
        } finally {
          await client.close();
        }
      });
    }
  }
});
