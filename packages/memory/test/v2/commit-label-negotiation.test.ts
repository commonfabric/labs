import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricPlainObject } from "@commonfabric/api";
import { deepFreeze, taggedHashStringOf } from "@commonfabric/data-model";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  type ClientCommit,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  type MemoryProtocolFlags,
  type ServerMessage,
  type SetOperation,
} from "../../v2.ts";
import { connect, type Transport } from "../../v2/client.ts";
import {
  compressClientMessageLabels,
  compressServerMessageCommitLabels,
} from "../../v2/commit-label-table.ts";
import { parseRoutedJson } from "../../v2/routed-parser.ts";
import { parseClientMessage, Server } from "../../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "../v2-auth-test-helpers.ts";

/** Endpoint whose next connection may advertise a different build capability. */
class CapabilityServer extends Server {
  advertised: boolean | undefined = true;

  /** @inheritDoc */
  override memoryProtocolFlags(): MemoryProtocolFlags {
    return {
      ...super.memoryProtocolFlags(),
      commitLabelTableV1: this.advertised === true,
      syncLabelTableV1: false,
    };
  }
}

/** Captures immutable canonical verdicts before connection-specific encoding. */
class VerdictServer extends CapabilityServer {
  verdicts: {
    message: ServerMessage;
    canonical: string;
    okCanonical: string;
  }[] = [];

  /** @inheritDoc */
  override async transact(
    ...[message, publish]: Parameters<Server["transact"]>
  ): ReturnType<Server["transact"]> {
    return await super.transact(message, (verdict) => {
      this.verdicts.push({
        message: deepFreeze(verdict),
        canonical: encodeMemoryBoundary(verdict),
        okCanonical: encodeMemoryBoundary(verdict.ok),
      });
      publish?.(verdict);
    });
  }
}

/** Returns exact repeated metadata and ordinary data that resembles metadata. */
function document(version: number) {
  return {
    value: { version, labelTable: ["ordinary data"], path: 0, label: 0 },
    cfc: {
      version: 1,
      schemaHash: taggedHashStringOf(true),
      labelMap: {
        version: 1,
        entries: Array.from({ length: 24 }, () => ({
          path: ["donuts", "ingredients", "chocolate"],
          label: { confidentiality: ["chocolate-recipe"], integrity: [] },
        })),
      },
    },
  };
}

/** Includes the schema document named by the metadata's schema hash. */
function schemaOperation(): SetOperation {
  return {
    op: "set",
    id: `cid:${taggedHashStringOf(true)}`,
    value: { value: true },
  };
}

/** Records encoded requests and can lose an unanswered commit before delivery. */
function transportFor(server: CapabilityServer) {
  let connection: ReturnType<Server["connect"]> | undefined;
  let receiver = (_payload: string) => {};
  let closeReceiver = (_error?: Error) => {};
  let holdCommit = false;
  let nextAck:
    | ((message: ServerMessage) => ServerMessage | undefined)
    | undefined;
  const held = Promise.withResolvers<void>();
  const firstCommitSent = Promise.withResolvers<void>();
  const commits: FabricPlainObject[] = [];
  const messages: ServerMessage[] = [];
  const reset = () => {
    connection?.close();
    connection = undefined;
  };
  const transport: Transport = {
    async send(payload) {
      parseRoutedJson(payload.slice("fvj1:".length), 150_000);
      connection ??= server.connect((message) => {
        messages.push(message);
        if (
          message.type === "response" && isPlainObject(message.ok) &&
          Array.isArray(message.ok.revisions) && nextAck
        ) {
          const transform = nextAck;
          nextAck = undefined;
          const transformed = transform(message);
          if (transformed === undefined) return;
          message = transformed;
        }
        if (message.type === "hello.ok" && server.advertised === undefined) {
          const { commitLabelTableV1: _capability, ...flags } = message.flags;
          receiver(encodeMemoryBoundary({ ...message, flags }));
        } else {
          const encoded = encodeMemoryBoundary(message);
          parseRoutedJson(encoded.slice("fvj1:".length), 150_000);
          receiver(encoded);
        }
      });
      const message = decodeMemoryBoundary(payload);
      if (isPlainObject(message) && message.type === "transact") {
        commits.push(message);
        firstCommitSent.resolve();
        if (holdCommit) {
          holdCommit = false;
          held.resolve();
          return;
        }
      }
      await connection.receive(payload);
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
    reset,
    close() {
      reset();
      return Promise.resolve();
    },
  };
  return {
    transport,
    commits,
    messages,
    held: held.promise,
    firstCommitSent: firstCommitSent.promise,
    interceptNextAck(
      transform: (message: ServerMessage) => ServerMessage | undefined,
    ) {
      const intercepted = Promise.withResolvers<void>();
      nextAck = (message) => {
        const result = transform(message);
        intercepted.resolve();
        return result;
      };
      return intercepted.promise;
    },
    receive(payload: string) {
      receiver(payload);
    },
    holdNextCommit() {
      holdCommit = true;
    },
    drop() {
      reset();
      closeReceiver(new Error("connection dropped"));
    },
  };
}

/** Returns the commit record captured at the wire boundary. */
function commitOf(message: FabricPlainObject): Record<string, unknown> {
  if (!isPlainObject(message.commit)) throw new Error("Expected a commit");
  return message.commit;
}

/** Returns transaction acknowledgments captured at the server wire boundary. */
function acknowledgments(messages: ServerMessage[]): Record<string, unknown>[] {
  return messages.flatMap((message) =>
    message.type === "response" && isPlainObject(message.ok) &&
      Array.isArray(message.ok.revisions)
      ? [message.ok]
      : []
  );
}

describe("commit-label-negotiation", () => {
  for (const advertised of [undefined, false]) {
    it(`sends inline acknowledgments when the client's capability is ${advertised}`, async () => {
      const server = new VerdictServer({
        ...testSessionOpenServerOptions,
        store: new URL("memory://commit-ack-legacy-client"),
      });
      const messages: ServerMessage[] = [];
      const connection = server.connect((message) => messages.push(message));
      try {
        const { commitLabelTableV1: _capability, ...flags } =
          getMemoryProtocolFlags();
        await connection.receive(encodeMemoryBoundary({
          type: "hello",
          protocol: "memory",
          flags: {
            ...flags,
            ...(advertised === undefined
              ? {}
              : { commitLabelTableV1: advertised }),
          },
        }));
        const hello = messages[0];
        if (hello.type !== "hello.ok" || !hello.sessionOpen) {
          throw new Error("Expected hello challenge");
        }
        await connection.receive(encodeMemoryBoundary({
          type: "session.open",
          requestId: "open",
          space: "did:key:commit-ack-legacy",
          session: {},
          invocation: {
            aud: hello.sessionOpen.audience,
            challenge: hello.sessionOpen.challenge.value,
          },
        }));
        const opened = messages.find((message) =>
          message.type === "response" && message.requestId === "open"
        );
        if (
          opened?.type !== "response" || !isPlainObject(opened.ok) ||
          typeof opened.ok.sessionId !== "string"
        ) {
          throw new Error("Expected an open session");
        }
        await connection.receive(encodeMemoryBoundary({
          type: "transact",
          requestId: "write",
          space: "did:key:commit-ack-legacy",
          sessionId: opened.ok.sessionId,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:donuts", value: document(1) },
              schemaOperation(),
            ],
          },
        }));
        const frames = acknowledgments(messages);
        expect(frames).toHaveLength(1);
        expect(Object.hasOwn(frames[0], "labelTable")).toBe(false);
        expect(Object.hasOwn(frames[0], "labelPathTable")).toBe(false);
        expect(
          encodeMemoryBoundary(
            messages.find((message) =>
              message.type === "response" && message.requestId === "write"
            ),
          ),
        )
          .toBe(server.verdicts[0].canonical);
      } finally {
        connection.close();
        await server.close();
      }
    });
  }

  for (const advertised of [undefined, false]) {
    for (const indexedOnly of [false, true]) {
      it(`refuses unsolicited acknowledgment ${indexedOnly ? "references" : "tables"} with capability=${advertised}`, async () => {
        const server = new CapabilityServer({
          ...testSessionOpenServerOptions,
          store: new URL("memory://commit-ack-unsolicited"),
        });
        server.advertised = advertised;
        const wire = transportFor(server);
        const client = await connect({
          transport: { ...wire.transport, reset: undefined },
        });
        try {
          const session = await client.mount(
            "did:key:commit-ack-unsolicited",
            {},
            testSessionOpenAuthFactory,
          );
          wire.interceptNextAck((message) => {
            const compact = compressServerMessageCommitLabels(message);
            if (compact.type !== "response" || !isPlainObject(compact.ok)) {
              throw new Error("Expected an acknowledgment");
            }
            expect(Object.hasOwn(compact.ok, "labelTable")).toBe(true);
            if (!indexedOnly) return compact;
            const { labelTable: _labels, labelPathTable: _paths, ...ok } =
              compact.ok;
            return { ...compact, ok };
          });
          await expect(session.transact({
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:donuts", value: document(1) },
              schemaOperation(),
            ],
          })).rejects.toMatchObject({
            name: "InvalidMessageError",
            cause: { message: "Unnegotiated `commitLabelTableV1` metadata" },
          });
          expect(client.connectionState).toBe("failed");
        } finally {
          await client.close();
          await server.close();
        }
      });
    }
  }

  for (const advertised of [undefined, false, true]) {
    it(`restores exact immutable normal and replay acknowledgment revisions with capability=${advertised}`, async () => {
      const server = new VerdictServer({
        ...testSessionOpenServerOptions,
        store: new URL("memory://commit-ack-roundtrip"),
      });
      server.advertised = advertised;
      const wire = transportFor(server);
      const client = await connect({ transport: wire.transport });
      try {
        const session = await client.mount(
          "did:key:commit-ack-roundtrip",
          {},
          testSessionOpenAuthFactory,
        );
        const commit: ClientCommit = deepFreeze({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:donuts", value: document(1) },
            schemaOperation(),
          ],
        });
        const original = encodeMemoryBoundary(commit);
        const accepted = await session.transact(commit);
        const replayed = await session.transact(commit);
        const patched = await session.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "of:donuts",
            patches: [
              { op: "replace", path: "/cfc", value: document(2).cfc },
              { op: "replace", path: "/value", value: document(2).value },
            ],
          }],
        });
        expect(accepted.seq).toBe(1);
        expect(replayed.seq).toBe(1);
        expect(replayed.replayed).toBe(true);
        const frames = acknowledgments(wire.messages);
        expect(frames).toHaveLength(3);
        expect(patched.seq).toBe(2);
        for (const [index, result] of [accepted, replayed, patched].entries()) {
          expect(encodeMemoryBoundary(result)).toBe(
            server.verdicts[index].okCanonical,
          );
          expect(encodeMemoryBoundary(server.verdicts[index].message)).toBe(
            server.verdicts[index].canonical,
          );
          const revision = result.revisions.find((entry) =>
            entry.id === "of:donuts"
          );
          if (index < 2) {
            expect(encodeMemoryBoundary(revision?.document)).toBe(
              encodeMemoryBoundary(document(1)),
            );
            expect(taggedHashStringOf(revision?.document)).toBe(
              taggedHashStringOf(document(1)),
            );
          } else {
            expect(revision?.op).toBe("patch");
            expect(encodeMemoryBoundary(revision?.patches)).toBe(
              encodeMemoryBoundary([
                { op: "replace", path: "/cfc", value: document(2).cfc },
                { op: "replace", path: "/value", value: document(2).value },
              ]),
            );
          }
          expect(Object.hasOwn(frames[index], "labelTable")).toBe(
            advertised === true,
          );
          expect(Object.hasOwn(frames[index], "labelPathTable")).toBe(
            advertised === true,
          );
          expect(Object.hasOwn(result, "labelTable")).toBe(false);
        }
        expect(encodeMemoryBoundary(commit)).toBe(original);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  for (const failure of ["lost", "malformed", "fatal"]) {
    it(`handles a ${failure} acknowledgment without delivering compact revisions and replays using reduced capabilities`, async () => {
      const server = new VerdictServer({
        ...testSessionOpenServerOptions,
        store: new URL("memory://commit-ack-recovery"),
      });
      const wire = transportFor(server);
      const client = await connect({
        transport: failure === "fatal"
          ? { ...wire.transport, reset: undefined }
          : wire.transport,
      });
      try {
        const session = await client.mount(
          "did:key:commit-ack-recovery",
          {},
          testSessionOpenAuthFactory,
        );
        const commit: ClientCommit = deepFreeze({
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:donuts", value: document(1) },
            schemaOperation(),
          ],
        });
        const intercepted = wire.interceptNextAck((message) => {
          server.advertised = false;
          if (failure === "lost") return undefined;
          if (message.type !== "response" || !isPlainObject(message.ok)) {
            throw new Error("Expected an acknowledgment");
          }
          return { ...message, ok: { ...message.ok, labelTable: [null] } };
        });
        const pending = session.transact(commit);
        pending.catch(() => {});
        await intercepted;
        if (failure === "fatal") {
          await expect(pending).rejects.toMatchObject({
            name: "InvalidMessageError",
          });
          expect(client.connectionState).toBe("failed");
        } else {
          if (failure === "lost") wire.drop();
          await client.restoreConnection();
          const result = await pending;
          expect(result.seq).toBe(1);
          expect(result.replayed).toBe(true);
          expect(encodeMemoryBoundary(result)).toBe(
            server.verdicts[1].okCanonical,
          );
          expect(client.serverFlags?.commitLabelTableV1).toBe(false);
          expect(wire.commits).toHaveLength(2);
          const frames = acknowledgments(wire.messages);
          expect(frames).toHaveLength(2);
          expect(Object.hasOwn(frames[0], "labelTable")).toBe(true);
          expect(Object.hasOwn(frames[1], "labelTable")).toBe(false);
          expect(
            encodeMemoryBoundary(
              result.revisions.find((entry) => entry.id === "of:donuts")
                ?.document,
            ),
          )
            .toBe(encodeMemoryBoundary(document(1)));
        }
        for (const verdict of server.verdicts) {
          expect(encodeMemoryBoundary(verdict.message)).toBe(verdict.canonical);
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  for (const failure of ["recoverable", "fatal", "close"]) {
    it(`settles a pre-send request after ${failure} invalidates its awaited connection without sending stale metadata`, async () => {
      const server = new CapabilityServer({
        ...testSessionOpenServerOptions,
        store: new URL("memory://commit-label-presend-race"),
      });
      const wire = transportFor(server);
      const client = await connect({
        transport: failure === "fatal"
          ? { ...wire.transport, reset: undefined }
          : wire.transport,
      });
      try {
        const session = await client.mount(
          "did:key:commit-presend-race",
          {},
          testSessionOpenAuthFactory,
        );
        const commit: ClientCommit = {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:donuts", value: document(1) },
            schemaOperation(),
          ],
        };
        const original = encodeMemoryBoundary(commit);
        expect(client.isConnected()).toBe(true);
        expect(client.serverFlags?.commitLabelTableV1).toBe(true);
        // `request()` suspends at its already-resolved readiness promise. The
        // failure runs synchronously before its encoding/registration continuation.
        const pending = client.request({
          type: "transact",
          requestId: "presend",
          space: session.space,
          sessionId: session.sessionId,
          commit,
        });
        const outcome = pending.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        let closing: Promise<void> | undefined;
        if (failure === "close") {
          closing = client.close();
        } else {
          server.advertised = false;
          wire.receive("malformed boundary");
        }
        const settled = await Promise.race([
          outcome,
          wire.firstCommitSent.then(() => ({ kind: "sent" as const })),
        ]);
        expect(settled.kind).toBe("rejected");
        if (settled.kind !== "rejected") {
          throw new Error("Expected a pre-send rejection");
        }
        expect(settled.error).toMatchObject({
          name: failure === "recoverable"
            ? "ConnectionError"
            : failure === "fatal"
            ? "InvalidMessageError"
            : "Error",
        });
        expect(wire.commits).toEqual([]);
        expect(encodeMemoryBoundary(commit)).toBe(original);
        if (failure === "recoverable") {
          await client.restoreConnection();
          await session.whenRestored();
          expect(client.serverFlags?.commitLabelTableV1).toBe(false);
          await expect(session.transact(commit)).resolves.toMatchObject({
            seq: 1,
          });
          expect(wire.commits).toHaveLength(1);
          expect(Object.hasOwn(commitOf(wire.commits[0]), "labelTable")).toBe(
            false,
          );
          expect(Object.hasOwn(commitOf(wire.commits[0]), "labelPathTable"))
            .toBe(false);
        } else {
          await closing;
          expect(client.connectionState).toBe(
            failure === "fatal" ? "failed" : "closed",
          );
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  it("compacts before transport validation when inline metadata exceeds the routed node cap", async () => {
    const server = new CapabilityServer({
      ...testSessionOpenServerOptions,
      store: new URL("memory://commit-label-node-cap"),
    });
    const wire = transportFor(server);
    const client = await connect({ transport: wire.transport });
    try {
      const session = await client.mount(
        "did:key:commit-node-cap",
        {},
        testSessionOpenAuthFactory,
      );
      const value = document(1);
      value.cfc.labelMap.entries = Array(18_000).fill(
        value.cfc.labelMap.entries[0],
      );
      const commit: ClientCommit = {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{ op: "set", id: "of:donuts", value }, schemaOperation()],
      };
      const inline = encodeMemoryBoundary(commit);
      expect(() => parseRoutedJson(inline.slice("fvj1:".length), 150_000))
        .toThrow();
      const accepted = await session.transact(commit);
      expect(accepted.seq).toBe(1);
      const inlineAck = encodeMemoryBoundary(accepted);
      expect(() => parseRoutedJson(inlineAck.slice("fvj1:".length), 150_000))
        .toThrow();
      expect(
        encodeMemoryBoundary(
          accepted.revisions.find((entry) => entry.id === "of:donuts")
            ?.document,
        ),
      )
        .toBe(encodeMemoryBoundary(value));
      expect(Object.hasOwn(acknowledgments(wire.messages)[0], "labelTable"))
        .toBe(true);
      expect(Object.hasOwn(commitOf(wire.commits[0]), "labelTable")).toBe(true);
      expect(encodeMemoryBoundary(commit)).toBe(inline);
    } finally {
      await client.close();
      await server.close();
    }
  });

  for (const advertised of [undefined, false, true]) {
    it(`preserves exact set and patch metadata with server capability=${advertised}`, async () => {
      const server = new CapabilityServer({
        ...testSessionOpenServerOptions,
        store: new URL("memory://commit-label-negotiation"),
      });
      server.advertised = advertised;
      const wire = transportFor(server);
      const client = await connect({ transport: wire.transport });
      try {
        const session = await client.mount(
          "did:key:commit-labels",
          {},
          testSessionOpenAuthFactory,
        );
        const first: ClientCommit = {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:donuts", value: document(1) },
            schemaOperation(),
          ],
        };
        const original = encodeMemoryBoundary(first);
        await session.transact(first);
        expect(encodeMemoryBoundary(first)).toBe(original);
        await session.transact({
          localSeq: 2,
          reads: { confirmed: [], pending: [] },
          operations: [{
            op: "patch",
            id: "of:donuts",
            patches: [
              { op: "replace", path: "/cfc", value: document(2).cfc },
              { op: "replace", path: "/value", value: document(2).value },
            ],
          }],
        });
        expect(wire.commits).toHaveLength(2);
        for (const message of wire.commits) {
          const commit = commitOf(message);
          expect(Object.hasOwn(commit, "labelTable")).toBe(advertised === true);
          expect(Object.hasOwn(commit, "labelPathTable")).toBe(
            advertised === true,
          );
        }
        const { sync } = await session.watchAddSync([{
          id: "donuts",
          kind: "graph",
          query: {
            roots: [{ id: "of:donuts", selector: { path: [], schema: true } }],
          },
        }]);
        expect(
          encodeMemoryBoundary(
            sync.upserts.find((entry) => entry.id === "of:donuts")?.doc,
          ),
        )
          .toBe(encodeMemoryBoundary(document(2)));
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  for (
    const [before, after] of [[true, false], [false, true], [true, undefined]]
  ) {
    it(`re-encodes a retained commit when capability changes from ${before} to ${after}`, async () => {
      const server = new CapabilityServer({
        ...testSessionOpenServerOptions,
        store: new URL("memory://commit-label-reconnect"),
      });
      server.advertised = before;
      const wire = transportFor(server);
      const client = await connect({ transport: wire.transport });
      try {
        const session = await client.mount(
          "did:key:commit-reconnect",
          {},
          testSessionOpenAuthFactory,
        );
        const commit: ClientCommit = {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [
            { op: "set", id: "of:donuts", value: document(1) },
            schemaOperation(),
          ],
        };
        const original = encodeMemoryBoundary(commit);
        wire.holdNextCommit();
        const pending = session.transact(commit);
        pending.catch(() => {});
        await wire.held;
        server.advertised = after;
        wire.drop();
        await client.restoreConnection();
        await pending;
        expect(wire.commits).toHaveLength(2);
        expect(Object.hasOwn(commitOf(wire.commits[0]), "labelTable")).toBe(
          before === true,
        );
        expect(Object.hasOwn(commitOf(wire.commits[1]), "labelTable")).toBe(
          after === true,
        );
        expect(encodeMemoryBoundary(commit)).toBe(original);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  for (const serverEnabled of [false, true]) {
    for (const clientEnabled of [undefined, false, true]) {
      it(`accepts compact commits only with server=${serverEnabled} and client=${clientEnabled}`, async () => {
        const server = new CapabilityServer({
          ...testSessionOpenServerOptions,
          store: new URL("memory://commit-label-client-offer"),
        });
        server.advertised = serverEnabled;
        const messages: ServerMessage[] = [];
        const connection = server.connect((message) => messages.push(message));
        try {
          const { commitLabelTableV1: _capability, ...flags } =
            getMemoryProtocolFlags();
          await connection.receive(encodeMemoryBoundary({
            type: "hello",
            protocol: "memory",
            flags: {
              ...flags,
              ...(clientEnabled === undefined
                ? {}
                : { commitLabelTableV1: clientEnabled }),
            },
          }));
          const compact = compressClientMessageLabels({
            type: "transact",
            requestId: "compact",
            space: "did:key:commit-raw",
            sessionId: "missing-session",
            commit: {
              localSeq: 1,
              reads: { confirmed: [], pending: [] },
              operations: [
                { op: "set", id: "of:donuts", value: document(1) },
                schemaOperation(),
              ],
            },
          });
          await connection.receive(encodeMemoryBoundary(compact));
          const response = messages.at(-1);
          expect(response?.type).toBe("response");
          if (response?.type !== "response") {
            throw new Error("Expected a response");
          }
          // A negotiated request reaches session admission; an unsolicited table
          // fails request parsing before any session or CFC store can handle it.
          expect(response.requestId).toBe(
            serverEnabled && clientEnabled === true ? "compact" : "invalid",
          );
          expect(response.error).toBeDefined();
        } finally {
          connection.close();
          await server.close();
        }
      });
    }
  }

  it("rejects malformed and unsolicited commit tables and indexed metadata during parsing", () => {
    const base = {
      type: "transact",
      requestId: "invalid",
      space: "did:key:commit-invalid",
      sessionId: "session",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:donuts", value: document(1) },
          schemaOperation(),
        ],
      },
    };
    for (const fields of [{ labelTable: [null] }, { labelPathTable: [null] }]) {
      const payload = encodeMemoryBoundary({
        ...base,
        commit: { ...base.commit, ...fields },
      });
      expect(parseClientMessage(payload)).toBeNull();
      expect(parseClientMessage(payload, { commitLabelTableV1: true }))
        .toBeNull();
    }
    for (const entry of [{ path: [], label: 0 }, { path: 0, label: {} }]) {
      const payload = encodeMemoryBoundary({
        ...base,
        commit: {
          ...base.commit,
          operations: [{
            op: "set",
            id: "of:donuts",
            value: { cfc: { labelMap: { entries: [entry] } } },
          }],
        },
      });
      expect(parseClientMessage(payload)).toBeNull();
      expect(parseClientMessage(payload, { commitLabelTableV1: true }))
        .toBeNull();
    }
  });

  it("leaves stored metadata and commit sequence unchanged after a malformed table", async () => {
    const server = new CapabilityServer({
      ...testSessionOpenServerOptions,
      store: new URL("memory://commit-label-no-mutation"),
    });
    const wire = transportFor(server);
    const client = await connect({ transport: wire.transport });
    try {
      const session = await client.mount(
        "did:key:commit-no-mutation",
        {},
        testSessionOpenAuthFactory,
      );
      const commit: ClientCommit = {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [
          { op: "set", id: "of:donuts", value: document(1) },
          schemaOperation(),
        ],
      };
      await session.transact(commit);
      const originalRequest = wire.commits[0];
      await wire.transport.send(encodeMemoryBoundary({
        ...originalRequest,
        requestId: "bad-table",
        commit: {
          ...commit,
          localSeq: 2,
          labelTable: [null],
          operations: [{ op: "set", id: "of:donuts", value: document(2) }],
        },
      }));
      expect(wire.messages.at(-1)).toMatchObject({
        type: "response",
        requestId: "invalid",
        error: { name: "InvalidMessageError" },
      });
      const { sync } = await session.watchAddSync([{
        id: "donuts",
        kind: "graph",
        query: {
          roots: [{ id: "of:donuts", selector: { path: [], schema: true } }],
        },
      }]);
      expect(sync.toSeq).toBe(1);
      expect(
        encodeMemoryBoundary(
          sync.upserts.find((entry) => entry.id === "of:donuts")?.doc,
        ),
      )
        .toBe(encodeMemoryBoundary(document(1)));
      await expect(session.transact({
        ...commit,
        localSeq: 2,
        operations: [
          { op: "set", id: "of:donuts", value: document(3) },
        ],
      })).resolves.toMatchObject({ seq: 2 });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
