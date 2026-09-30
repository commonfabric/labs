/** Verifies required dependency negotiation at initial issue and reconnect. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type ClientCommit,
  decodeMemoryBoundary,
  encodeMemoryBoundary,
  getMemoryProtocolFlags,
  parseMemoryProtocolFlags,
  toDocumentPath,
  wireMemoryProtocolFlags,
} from "../v2.ts";
import { connect, type Transport } from "../v2/client.ts";
import { Server } from "../v2/server.ts";
import {
  testSessionOpenAuthFactory,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

/** Overrides only the advertised capability and can drop one unissued commit. */
function validationTransport(
  server: Server,
  capable: boolean | ((connection: number) => boolean),
  dropFirst: boolean,
  capability: "readValidation" | "eventContext" = "readValidation",
): {
  transport: Transport;
  sent: () => number;
  hellos: () => number;
  disconnect: () => void;
} {
  let receiver: (payload: string) => void = () => {};
  let closeReceiver: (error?: Error) => void = () => {};
  let connection: ReturnType<Server["connect"]> | undefined;
  let connectionCount = 0;
  let commits = 0;
  let hellos = 0;
  const transport: Transport = {
    async send(payload) {
      if (connection === undefined) {
        connectionCount++;
        connection = server.connect((message) => {
          receiver(encodeMemoryBoundary(
            message.type === "hello.ok"
              ? {
                ...message,
                flags: {
                  ...message.flags,
                  [capability]: typeof capable === "function"
                    ? capable(connectionCount)
                    : capable && connectionCount === 1,
                },
              }
              : message,
          ));
        });
      }
      const message = decodeMemoryBoundary(payload) as { type: string };
      if (message.type === "hello") hellos++;
      if (
        message.type === "transact" ||
        message.type === "event.attention.resolve"
      ) {
        commits++;
        if (dropFirst && commits === 1) {
          connection.close();
          connection = undefined;
          closeReceiver(
            new Error("connection replaced before commit delivery"),
          );
          return;
        }
      }
      await connection.receive(payload);
    },
    close() {
      connection?.close();
      connection = undefined;
      return Promise.resolve();
    },
    setReceiver(next) {
      receiver = next;
    },
    setCloseReceiver(next) {
      closeReceiver = next;
    },
  };
  return {
    transport,
    sent: () => commits,
    hellos: () => hellos,
    disconnect: () => {
      connection?.close();
      connection = undefined;
      closeReceiver(
        new Error("connection replaced before request continuation"),
      );
    },
  };
}

/** Returns one dependency on an absent document and its creation operation. */
function writeCommit(validation?: "required" | "elidable"): ClientCommit {
  return {
    localSeq: 1,
    reads: {
      confirmed: [{
        id: "of:read-validation",
        path: toDocumentPath([]),
        seq: 0,
        validation,
      }],
      pending: [],
    },
    operations: [{
      op: "set",
      id: "of:read-validation",
      value: { value: "created" },
    }],
  };
}

describe("v2-read-validation-client", () => {
  it("requires a positive event context capability and preserves it on the wire", () => {
    const flags = getMemoryProtocolFlags();
    expect(flags.eventContext).toBe(true);
    expect(
      parseMemoryProtocolFlags(wireMemoryProtocolFlags(flags))?.eventContext,
    ).toBe(true);
    const { eventContext: _capability, ...absent } = flags;
    expect(parseMemoryProtocolFlags(absent)?.eventContext).toBe(false);
    expect(parseMemoryProtocolFlags({ ...flags, eventContext: "true" }))
      .toBeNull();
  });

  for (const timing of ["initial", "readiness", "replay"] as const) {
    it(`refuses event appends when ${timing} negotiation lacks context support`, async () => {
      const server = new Server(testSessionOpenServerOptions);
      const scripted = validationTransport(
        server,
        timing !== "initial",
        timing === "replay",
        "eventContext",
      );
      const client = await connect({ transport: scripted.transport });
      try {
        const session = await client.mount(
          "did:key:event-context",
          {},
          testSessionOpenAuthFactory,
        );
        const commit: ClientCommit = {
          localSeq: 1,
          reads: { confirmed: [], pending: [] },
          operations: [],
          eventAppends: [{ id: "of:stream-events:context", eventId: "event" }],
        };
        const pending = session.transact(commit);
        if (timing === "readiness") scripted.disconnect();
        await expect(pending).rejects.toThrow(
          "memory server does not support opaque event context",
        );
        expect(scripted.sent()).toBe(timing === "replay" ? 1 : 0);
        expect(scripted.hellos()).toBe(timing === "initial" ? 1 : 2);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  for (const timing of ["initial", "readiness"] as const) {
    it(`refuses event retry when ${timing} negotiation lacks context support`, async () => {
      const server = new Server(testSessionOpenServerOptions);
      const scripted = validationTransport(
        server,
        timing !== "initial",
        false,
        "eventContext",
      );
      const client = await connect({ transport: scripted.transport });
      try {
        const session = await client.mount(
          "did:key:event-context",
          {},
          testSessionOpenAuthFactory,
        );
        const pending = session.resolveEventAttention(
          "event",
          1,
          "of:stream-events:context",
          "retry",
        );
        if (timing === "readiness") scripted.disconnect();
        await expect(pending).rejects.toThrow(
          "memory server does not support opaque event context",
        );
        expect(scripted.sent()).toBe(0);
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  it("requires positive capability advertisement and preserves it on the wire", () => {
    const flags = getMemoryProtocolFlags();
    expect(flags.readValidation).toBe(true);
    expect(
      parseMemoryProtocolFlags(wireMemoryProtocolFlags(flags))?.readValidation,
    ).toBe(true);
    const { readValidation: _capability, ...absent } = flags;
    expect(parseMemoryProtocolFlags(absent)?.readValidation).toBe(false);
    expect(parseMemoryProtocolFlags({ ...flags, readValidation: "true" }))
      .toBeNull();
  });

  for (const validation of [undefined, "required", "elidable"] as const) {
    it(`${validation === "elidable" ? "issues" : "refuses"} ${validation ?? "unclassified"} reads without server capability`, async () => {
      const server = new Server(testSessionOpenServerOptions);
      const scripted = validationTransport(server, false, false);
      const client = await connect({
        transport: scripted.transport,
      });
      try {
        const session = await client.mount(
          "did:key:read-validation",
          {},
          testSessionOpenAuthFactory,
        );
        if (validation === "elidable") {
          expect((await session.transact(writeCommit(validation))).seq)
            .toBeGreaterThan(0);
          expect(scripted.sent()).toBe(1);
        } else {
          await expect(session.transact(writeCommit(validation))).rejects
            .toThrow("memory server does not support required read validation");
          expect(scripted.sent()).toBe(0);
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
  }

  it("queues required reads while disconnected and checks the new capability", async () => {
    const server = new Server(testSessionOpenServerOptions);
    const scripted = validationTransport(
      server,
      (connection) => connection > 1,
      false,
    );
    const client = await connect({ transport: scripted.transport });
    try {
      const session = await client.mount(
        "did:key:read-validation",
        {},
        testSessionOpenAuthFactory,
      );
      scripted.disconnect();
      expect((await session.transact(writeCommit("required"))).seq)
        .toBeGreaterThan(0);
      expect(scripted.sent()).toBe(1);
      expect(scripted.hellos()).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses before send when the connection changes during request readiness", async () => {
    const server = new Server(testSessionOpenServerOptions);
    const scripted = validationTransport(server, true, false);
    const client = await connect({ transport: scripted.transport });
    try {
      const session = await client.mount(
        "did:key:read-validation",
        {},
        testSessionOpenAuthFactory,
      );
      const pending = session.transact(writeCommit("required"));
      scripted.disconnect();
      await expect(pending).rejects.toThrow(
        "memory server does not support required read validation",
      );
      expect(scripted.sent()).toBe(0);
      expect(scripted.hellos()).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses outstanding required reads when a reconnect loses capability", async () => {
    const server = new Server(testSessionOpenServerOptions);
    const scripted = validationTransport(server, true, true);
    const client = await connect({
      transport: scripted.transport,
    });
    try {
      const session = await client.mount(
        "did:key:read-validation",
        {},
        testSessionOpenAuthFactory,
      );
      await expect(session.transact(writeCommit("required"))).rejects.toThrow(
        "memory server does not support required read validation",
      );
      expect(scripted.sent()).toBe(1);
      expect(scripted.hellos()).toBe(2);
      expect(
        await server.readDocument(
          "did:key:read-validation",
          "of:read-validation",
        ),
      ).toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
