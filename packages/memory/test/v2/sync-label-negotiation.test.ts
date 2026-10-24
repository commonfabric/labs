import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { JSONSchema } from "@commonfabric/api";
import { type FabricValue, taggedHashStringOf } from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { internSchema } from "@commonfabric/data-model-schema";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type MemoryProtocolFlags,
  type SessionSync,
} from "../../v2.ts";
import { connect, loopback, type Transport } from "../../v2/client.ts";
import { evictDocumentCacheEntries } from "../../v2/engine.ts";
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
          name: "a stored numeric path without a table",
          accepted: true,
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
          name: "a stored numeric label without a table",
          accepted: true,
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
            name:
              `a stored numeric ${field} with missing sibling and version in ${
                objectEntries ? "object" : "array"
              } entries`,
            accepted: true,
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

  for (const clientEnabled of [false, true]) {
    it(`delivers a stored label carrying a reserved schema reference inline to a client with syncLabelTableV1=${clientEnabled}`, async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-label-stored-reserved-ref"),
      });
      const frames: Record<string, unknown>[] = [];
      const transport = loopback(server);
      const observerTransport: Transport = {
        ...transport,
        send(payload) {
          const message = decodeMemoryBoundary(payload);
          if (isPlainObject(message) && message.type === "hello") {
            return transport.send(encodeMemoryBoundary({
              ...message,
              flags: {
                ...getMemoryProtocolFlags(),
                syncLabelTableV1: clientEnabled,
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
      const observerClient = await connect({ transport: observerTransport });
      try {
        const space = "did:key:sync-label-stored-reserved-ref";
        const writer = await writerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        await writer.transact({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "set",
            id: "of:donuts",
            value: document(1),
          }, {
            op: "set",
            id: `cid:${taggedHashStringOf(true)}`,
            value: { value: true },
          }],
        });
        // Admission refuses persisting a reserved schema reference, so the
        // row is rewritten in place to model a label an older server
        // interned: its evidence link names the schema the document's other
        // labels carry inline, by the reference the frame's schema table
        // will resolve.
        const schema: JSONSchema = {
          type: "object",
          properties: { origin: { type: "string" } },
        };
        const interned = internSchema(schema, true);
        if (interned === undefined) throw new Error("Expected a schema hash");
        const reference = `schema-ref@2:${interned.taggedHashString}`;
        const labelWith = (evidence: FabricValue) => ({
          path: ["flavor", "origin"],
          label: { confidentiality: ["origin"], integrity: [], evidence },
        });
        // Repeated enough that the sender would intern the label if it did
        // not check for the reference.
        const repeats = 17;
        const base = document(1);
        const entries = base.cfc.labelMap.entries;
        const stored = {
          ...base,
          cfc: {
            ...base.cfc,
            labelMap: {
              version: 1,
              entries: [
                ...entries,
                ...Array.from({ length: repeats }, () =>
                  labelWith(
                    linkRefFrom({
                      id: "of:policy",
                      path: [],
                      schema: reference,
                    }),
                  )),
              ],
            },
          },
        };
        const expected = {
          ...stored,
          cfc: {
            ...stored.cfc,
            labelMap: {
              version: 1,
              entries: [
                ...entries,
                ...Array.from(
                  { length: repeats },
                  () =>
                    labelWith(
                      linkRefFrom({ id: "of:policy", path: [], schema }),
                    ),
                ),
              ],
            },
          },
        };
        const engine = await server.engineForSpace(space);
        engine.database.prepare(
          `UPDATE revision SET data = :data WHERE id = 'of:donuts'`,
        ).run({ data: encodeMemoryBoundary(stored) });
        evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);

        const observer = await observerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
        const { sync } = await observer.watchAddSync([{
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
        )).toBe(encodeMemoryBoundary(expected));
        expect(observerClient.isConnected()).toBe(true);
        // On the wire the repeated self-contained labels are interned when
        // negotiated (the document's last entry is a singleton and stays
        // inline), and the reserved-reference label travels inline either way.
        const contentFrames = frames.filter((frame) =>
          Array.isArray(frame.upserts) && frame.upserts.length > 0
        );
        expect(contentFrames).toHaveLength(1);
        const frame = contentFrames[0];
        expect(Array.isArray(frame.labelTable)).toBe(clientEnabled);
        const upsert = (frame.upserts as { id: string; doc: unknown }[]).find(
          (entry) => entry.id === "of:donuts",
        );
        const wireEntries =
          (upsert?.doc as { cfc: { labelMap: { entries: unknown[] } } }).cfc
            .labelMap.entries;
        const inlineLabels = wireEntries.filter((entry) =>
          isPlainObject(entry) && isPlainObject(entry.label)
        );
        expect(
          wireEntries.filter((entry) =>
            isPlainObject(entry) && typeof entry.label === "number"
          ),
        ).toHaveLength(clientEnabled ? entries.length - 1 : 0);
        expect(inlineLabels).toHaveLength(
          clientEnabled ? repeats + 1 : entries.length + repeats,
        );
        // The stored labels are told apart by their path: with schema tables
        // negotiated the other labels' inline schemas travel as the same
        // reference string.
        // The shared path is interned too when negotiated.
        const pathOf = (entry: unknown) =>
          isPlainObject(entry) && typeof entry.path === "number"
            ? (frame.labelPathTable as unknown[])[entry.path]
            : isPlainObject(entry)
            ? entry.path
            : undefined;
        const reservedOnWire = inlineLabels.filter((entry) =>
          JSON.stringify(pathOf(entry)) ===
            JSON.stringify(["flavor", "origin"])
        );
        expect(reservedOnWire).toHaveLength(repeats);
        expect(
          reservedOnWire.every((entry) =>
            JSON.stringify(entry).includes(reference)
          ),
        ).toBe(true);
      } finally {
        await writerClient.close();
        await observerClient.close();
        await server.close();
      }
    });

    it(`delivers a stored numeric label inline to a client with syncLabelTableV1=${clientEnabled} and keeps delivering`, async () => {
      const server = new Server({
        ...testSessionOpenServerOptions,
        store: new URL("memory://sync-label-stored-number"),
      });
      const frames: Record<string, unknown>[] = [];
      const transport = loopback(server);
      const observerTransport: Transport = {
        ...transport,
        send(payload) {
          const message = decodeMemoryBoundary(payload);
          if (isPlainObject(message) && message.type === "hello") {
            return transport.send(encodeMemoryBoundary({
              ...message,
              flags: {
                ...getMemoryProtocolFlags(),
                syncLabelTableV1: clientEnabled,
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
      const observerClient = await connect({ transport: observerTransport });
      try {
        const space = "did:key:sync-label-stored-number";
        const writer = await writerClient.mount(
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
        // Commit admission now refuses a numeric whole-field label, so the
        // row is rewritten in place to stand for one stored before that
        // check existed (a `move` of application data into the label map).
        const stored = {
          ...document(1),
          cfc: {
            ...document(1).cfc,
            labelMap: {
              version: 1,
              entries: [
                { path: ["flavor"], label: 3 },
                { path: 4, label: { confidentiality: [], integrity: [] } },
              ],
            },
          },
        };
        const engine = await server.engineForSpace(space);
        engine.database.prepare(
          `UPDATE revision SET data = :data WHERE id = 'of:donuts'`,
        ).run({ data: encodeMemoryBoundary(stored) });
        evictDocumentCacheEntries(engine, Number.MAX_SAFE_INTEGER);

        const observer = await observerClient.mount(
          space,
          {},
          testSessionOpenAuthFactory,
        );
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
        )).toBe(encodeMemoryBoundary(stored));
        // The stored number travelled inline on the wire, beside no table.
        const contentFrames = frames.filter((frame) =>
          Array.isArray(frame.upserts) && frame.upserts.length > 0
        );
        expect(contentFrames).toHaveLength(1);
        expect(Object.hasOwn(contentFrames[0], "labelTable")).toBe(false);
        expect(Object.hasOwn(contentFrames[0], "labelPathTable")).toBe(false);
        expect(observerClient.isConnected()).toBe(true);

        // Delivery continues: a later write is pushed, compressed when the
        // connection negotiated tables.
        const updates = view.subscribeSync();
        await write(2);
        const pushed = await updates.next();
        expect(pushed.done).toBe(false);
        if (pushed.done) throw new Error("Expected a pushed sync");
        expect(encodeMemoryBoundary(
          pushed.value.upserts.find((entry) => entry.id === "of:donuts")?.doc,
        )).toBe(encodeMemoryBoundary(document(2)));
        expect(Array.isArray(frames.at(-1)?.labelTable)).toBe(clientEnabled);
      } finally {
        await writerClient.close();
        await observerClient.close();
        await server.close();
      }
    });
  }
});
