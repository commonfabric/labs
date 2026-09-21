import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";

import { attachOptionsFrom, RuntimeClient } from "@/runtime-client.ts";
import { findKeyMaterial } from "@/shared/key-material.ts";
import {
  type CellRef,
  NotificationType,
  RequestType,
  type UploadBlobRequest,
} from "@/protocol/mod.ts";
import type { RuntimeTransport } from "@/client/transport.ts";

describe("RuntimeClient", () => {
  describe("initialize option validation", () => {
    it("rejects an unknown renderDeclassificationPolicy loudly", async () => {
      // The policy is a security knob: a typo'd host config must surface as the
      // host's own error instead of silently flipping the worker to a fallback.
      // The check throws before the transport is used, so a stub suffices.
      const transport = {
        send: () => {
          throw new Error("transport must not be used");
        },
        dispose: () => Promise.resolve(),
        ready: () => Promise.resolve(),
        on: () => {},
        off: () => {},
      } as unknown as RuntimeTransport;
      const identity = await Identity.fromPassphrase(
        "runtime-client-option-validation",
      );

      await expect(
        RuntimeClient.initialize(transport, {
          apiUrl: new URL("http://localhost:9/"),
          identity,
          spaceDid: identity.did(),
          renderDeclassificationPolicy: "allow-all" as never,
        }),
      ).rejects.toThrow("Invalid renderDeclassificationPolicy");
    });
  });

  describe("createPiece", () => {
    it("preserves the host's cause and home address across repeated creation requests", async () => {
      const space = "did:key:z6Mk-client-create-home" as CellRef["space"];
      const ref: CellRef = {
        id: "of:fid1:header",
        space,
        scope: "space",
        path: [],
      };
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ piece: { cell: ref } });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      const input = "export default pattern(() => ({}));";
      const options = {
        cause: "host:participant-header:v1",
        argument: {},
        run: true,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const piece = await client.createPiece(input, space, options);
        expect(piece.cell().ref()).toEqual(ref);
      }
      expect(requests).toEqual(Array.from({ length: 2 }, () => ({
        type: RequestType.PieceCreate,
        space,
        source: {
          program: {
            main: "/main.tsx",
            files: [{ name: "/main.tsx", contents: input }],
          },
        },
        cause: options.cause,
        argument: {},
        run: true,
      })));
      await client.createPiece(
        new URL("https://fabric.example/header.tsx"),
        space,
      );
      expect(requests[2]).toEqual({
        type: RequestType.PieceCreate,
        space,
        source: { url: "https://fabric.example/header.tsx" },
        argument: undefined,
        run: undefined,
      });
    });
  });

  describe("signal", () => {
    it("exposes the connection's lifetime signal", () => {
      const signal = new AbortController().signal;
      // The constructor only wires event listeners and stores the connection, so
      // a connection stub with on()/signal is enough to read the getter through.
      const conn = { on: () => {}, signal } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      expect(client.signal).toBe(signal);
    });
  });

  describe("cellInstanceId", () => {
    const ref: CellRef = {
      id: "of:fid1:instance" as CellRef["id"],
      space: "did:key:instance-space" as CellRef["space"],
      scope: "space",
      path: [],
    };

    function clientWith(identity?: Identity): RuntimeClient {
      const conn = { on: () => {} } as unknown as never;
      // The constructor takes the acting principal itself, an attaching
      // client having only a DID to give it.
      return new (RuntimeClient as unknown as {
        new (conn: never, principal: unknown): RuntimeClient;
      })(conn, identity?.did());
    }

    it("identifies space, user, and session instances at their scopes", async () => {
      const identity = await Identity.fromPassphrase(
        "runtime-client-cell-instance",
      );
      const first = clientWith(identity);
      const second = clientWith(identity);

      expect(first.cellInstanceId(ref)).toBe(second.cellInstanceId(ref));
      expect(first.cellInstanceId({ ...ref, scope: "user" })).toBe(
        second.cellInstanceId({ ...ref, scope: "user" }),
      );
      expect(first.cellInstanceId({ ...ref, scope: "session" })).toBe(
        first.cellInstanceId({ ...ref, scope: "session" }),
      );
      expect(first.cellInstanceId({ ...ref, scope: "session" })).not.toBe(
        second.cellInstanceId({ ...ref, scope: "session" }),
      );
    });

    it("refuses a scoped instance without a runtime identity", () => {
      const client = clientWith();
      expect(() => client.cellInstanceId({ ...ref, scope: "user" })).toThrow(
        "Cannot identify a user-scoped Cell without a runtime identity.",
      );
      expect(() => client.cellInstanceId({ ...ref, scope: "session" })).toThrow(
        "Cannot identify a session-scoped Cell without a runtime identity.",
      );
      expect(client.cellInstanceId(ref)).toBeDefined();
    });
  });

  describe("setForwardWorkerConsole", () => {
    // The constructor only wires `on()` listeners and stores the connection, so a
    // stub that records requests is enough to assert the IPC the method sends.
    function clientWithRequestStub(): {
      client: RuntimeClient;
      requests: unknown[];
    } {
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve(undefined);
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      return { client, requests };
    }

    it("sends a SetForwardWorkerConsole request to enable forwarding", async () => {
      const { client, requests } = clientWithRequestStub();
      await client.setForwardWorkerConsole(true);
      expect(requests).toEqual([
        { type: RequestType.SetForwardWorkerConsole, enabled: true },
      ]);
    });

    it("sends a SetForwardWorkerConsole request to disable forwarding", async () => {
      const { client, requests } = clientWithRequestStub();
      await client.setForwardWorkerConsole(false);
      expect(requests).toEqual([
        { type: RequestType.SetForwardWorkerConsole, enabled: false },
      ]);
    });
  });

  describe("getLoggerCounts", () => {
    // The method reshapes the response field by field, so a field the worker
    // sends and the client forgets is invisible to its caller — which is how a
    // browser harness would find the CFC counters missing with nothing to say
    // why.

    it("carries the CFC counters through from the response", async () => {
      const response = {
        counts: { total: 1 },
        metadata: {},
        timing: {},
        flags: {},
        cfc: { cfcRelevantTx: 4, dereferenceTracesMax: 9 },
      };
      const conn = {
        on: () => {},
        request: () => Promise.resolve(response),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      expect((await client.getLoggerCounts()).cfc).toEqual({
        cfcRelevantTx: 4,
        dereferenceTracesMax: 9,
      });
    });
  });

  describe("setMemoryMessageCompression", () => {
    it("asks the worker to change live memory WebSocket compression", async () => {
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve(undefined);
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      await client.setMemoryMessageCompression(false);

      expect(requests).toEqual([{
        type: RequestType.SetMemoryMessageCompression,
        enabled: false,
      }]);
    });
  });

  describe("getPiece", () => {
    it("sends the scope alongside the id, an id alone naming no document", async () => {
      const space = "did:key:z6Mk-runtime-client-piece";
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({
            piece: {
              cell: { id: "of:fid1:mine", space, scope: "user", path: [] },
            },
          });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      // A piece in a narrower scope is addressed by its id AND that scope;
      // the worker builds the cell from both, so a scope left behind here
      // reaches a document that does not exist.
      const piece = await client.getPiece(
        "fid1:mine",
        space as never,
        true,
        "user",
      );

      expect(requests).toEqual([{
        type: RequestType.PieceGet,
        pieceId: "fid1:mine",
        runIt: true,
        space,
        scope: "user",
      }]);
      expect(piece?.id()).toBe("fid1:mine");
    });

    it("leaves the scope out when the caller names none", async () => {
      const space = "did:key:z6Mk-runtime-client-piece";
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({
            piece: {
              cell: { id: "of:fid1:ours", space, scope: "space", path: [] },
            },
          });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      await client.getPiece("fid1:ours", space as never);

      expect(requests).toEqual([{
        type: RequestType.PieceGet,
        pieceId: "fid1:ours",
        runIt: undefined,
        space,
        scope: undefined,
      }]);
    });

    it("returns null where the worker answers with no piece", async () => {
      const space = "did:key:z6Mk-runtime-client-piece";
      const conn = {
        on: () => {},
        request: () => Promise.resolve(null),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      await expect(client.getPiece("fid1:gone", space as never)).resolves
        .toBeNull();
    });
  });

  describe("piece-addressed requests", () => {
    it("carries a narrower scope on every request naming a piece by id", async () => {
      // The id alone names a different document in every other scope, so a
      // method that takes a scope and drops it reaches the wrong piece
      // rather than failing.

      const space = "did:key:z6Mk-runtime-client-scoped";
      const requests: Array<Record<string, unknown>> = [];
      const cell = { id: "of:fid1:mine", space, scope: "user", path: [] };
      const conn = {
        on: () => {},
        request: (message: Record<string, unknown>) => {
          requests.push(message);
          switch (message.type) {
            case RequestType.PieceGetSlug:
              return Promise.resolve({ slug: "mine" });
            case RequestType.PieceRemove:
              return Promise.resolve({ value: true });
            case RequestType.PieceClone:
              return Promise.resolve({ piece: { cell } });
            default:
              return Promise.resolve({ source: { files: [], history: [] } });
          }
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      await client.getPieceSlug("fid1:mine", space as never, "user");
      await client.removePiece("fid1:mine", space as never, "user");
      await client.getPieceSource("fid1:mine", space as never, "user");
      await client.getPieceSourceRevision(
        "fid1:mine",
        space as never,
        "revision-1",
        "user",
      );
      await client.clonePiece(
        "fid1:mine",
        space as never,
        space as never,
        { scope: "user" },
      );
      await client.updatePieceSource(
        "fid1:mine",
        space as never,
        { kind: "detach" },
        { scope: "user" },
      );

      expect(requests.map((request) => request.scope)).toEqual([
        "user",
        "user",
        "user",
        "user",
        "user",
        "user",
      ]);
      expect(requests.map((request) => request.type)).toEqual([
        RequestType.PieceGetSlug,
        RequestType.PieceRemove,
        RequestType.PieceGetSource,
        RequestType.PieceGetSourceRevision,
        RequestType.PieceClone,
        RequestType.PieceUpdateSource,
      ]);
    });
  });

  describe("resolveSlug", () => {
    it("asks the worker where a slug reference lands", async () => {
      const space = "did:key:z6Mk-runtime-client-slug";
      const piece = {
        cell: { id: "of:fid1:member", space, scope: "space", path: [] },
      };
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ piece, pathAfter: [] });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      const landed = await client.resolveSlug("top", space as never, "42");
      if (landed.refusal) throw new Error("the worker answered with a piece");

      // The slug, the space and the member cross in the fields the worker
      // reads them from. This method takes them in a different order than it
      // sends them, so which value lands in which field is the thing to hold.
      expect(requests).toEqual([{
        type: RequestType.SlugResolve,
        slug: "top",
        member: "42",
        space,
      }]);
      // The piece comes back as a handle over the ref the worker answered
      // with, in the routing form of its id.
      expect(landed.piece.id()).toBe("fid1:member");
      expect(landed.pathAfter).toEqual([]);
    });

    it("asks for no member where the reference stops at the slug", async () => {
      const space = "did:key:z6Mk-runtime-client-slug";
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({
            piece: {
              cell: { id: "of:fid1:board", space, scope: "space", path: [] },
            },
            pathAfter: [],
          });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      const landed = await client.resolveSlug("top", space as never);

      expect(requests).toEqual([{
        type: RequestType.SlugResolve,
        slug: "top",
        member: undefined,
        space,
      }]);
      // What came back matters as much as what went out: a board reached
      // with a member still to spend is a different answer than a board
      // reached with none.
      if (landed.refusal) throw new Error("the worker answered with a piece");
      expect(landed.piece.id()).toBe("fid1:board");
      expect(landed.pathAfter).toEqual([]);
    });

    it("carries back a member the walk did not spend", async () => {
      const space = "did:key:z6Mk-runtime-client-slug";
      const conn = {
        on: () => {},
        request: () =>
          Promise.resolve({
            piece: {
              cell: { id: "of:fid1:plain", space, scope: "space", path: [] },
            },
            pathAfter: ["42"],
          }),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      // The leftover is what tells a caller the segment named nothing, so it
      // has to survive this hop rather than being read off the piece.
      const landed = await client.resolveSlug("plain", space as never, "42");
      if (landed.refusal) throw new Error("the worker answered with a piece");
      expect(landed.piece.id()).toBe("fid1:plain");
      expect(landed.pathAfter).toEqual(["42"]);
    });

    it("returns a refusal as an answer rather than throwing it", async () => {
      const space = "did:key:z6Mk-runtime-client-slug";
      const conn = {
        on: () => {},
        request: () =>
          Promise.resolve({
            refusal: {
              code: "missing-member",
              message: "no member 999 in top",
            },
          }),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      // A name nobody bound is what the caller asked about. Throwing it would
      // make it indistinguishable from a transport that dropped, and the two
      // want opposite responses: report the one, retry the other.
      const landed = await client.resolveSlug("top", space as never, "999");
      expect(landed.refusal).toEqual({
        code: "missing-member",
        message: "no member 999 in top",
      });
      expect(landed.piece).toBeUndefined();
    });

    it("refuses an answer carrying both a piece and a refusal", async () => {
      const space = "did:key:z6Mk-runtime-client-slug";
      const conn = {
        on: () => {},
        request: () =>
          Promise.resolve({
            piece: {
              cell: { id: "of:fid1:board", space, scope: "space", path: [] },
            },
            pathAfter: [],
            refusal: { code: "missing-member", message: "no member 9 in top" },
          }),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      // The type cannot express this; a message off the wire can. Reading the
      // refusal first would report a protocol fault as a name that is not
      // bound, and the caller would tell a reader so.
      await expect(client.resolveSlug("top", space as never)).rejects.toThrow(
        "both a piece and a refusal",
      );
    });

    it("refuses a landing that carries no path", async () => {
      const space = "did:key:z6Mk-runtime-client-slug";
      const conn = {
        on: () => {},
        request: () =>
          Promise.resolve({
            piece: {
              cell: { id: "of:fid1:board", space, scope: "space", path: [] },
            },
          }),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      // Defaulting the missing path to `[]` would say the member was spent,
      // which is the fact the citation is offered on.
      await expect(client.resolveSlug("top", space as never, "42")).rejects
        .toThrow("a piece and no path");
    });

    it("refuses an answer that is neither a piece nor a refusal", async () => {
      const space = "did:key:z6Mk-runtime-client-slug";
      const conn = {
        on: () => {},
        request: () => Promise.resolve({}),
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      // Silently reporting "no piece" for a malformed answer would read as a
      // name that does not resolve, which is a different fact entirely.
      await expect(client.resolveSlug("top", space as never)).rejects.toThrow(
        "neither a piece nor a refusal",
      );
    });
  });

  describe("getPieceSource", () => {
    it("asks the worker for one piece's source state", async () => {
      const source = {
        space: "did:key:z6Mk-runtime-client-source",
        pieceId: "of:fid1:piece",
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
        history: [],
      };
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ source });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      const result = await client.getPieceSource(
        "of:fid1:piece",
        "did:key:z6Mk-runtime-client-source" as never,
      );

      expect(requests).toEqual([{
        type: RequestType.PieceGetSource,
        pieceId: "of:fid1:piece",
        space: "did:key:z6Mk-runtime-client-source",
      }]);
      // The response is unwrapped: callers get the source state, not the envelope.
      expect(result).toBe(source);
    });
  });

  describe("getPieceSourceRevision", () => {
    it("asks the worker for one recorded revision's retained source", async () => {
      const source = {
        pattern: { identity: "pattern-identity", symbol: "default" },
        files: [{ name: "/main.tsx", contents: "export default 1;" }],
      };
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ source });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      const result = await client.getPieceSourceRevision(
        "of:fid1:piece",
        "did:key:z6Mk-runtime-client-source" as never,
        "revision-1",
      );

      expect(requests).toEqual([{
        type: RequestType.PieceGetSourceRevision,
        pieceId: "of:fid1:piece",
        space: "did:key:z6Mk-runtime-client-source",
        revisionId: "revision-1",
      }]);
      expect(result).toBe(source);
    });
  });

  describe("updatePieceSource", () => {
    it("sends a discriminated source action to the worker", async () => {
      const source = {
        space: "did:key:z6Mk-runtime-client-source",
        pieceId: "of:fid1:piece",
        files: [],
        history: [],
      };
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ source });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      const response = await client.updatePieceSource(
        "of:fid1:piece",
        "did:key:z6Mk-runtime-client-source" as never,
        { kind: "restore", revisionId: "revision-1" },
        { confirmationToken: "confirmation-1" },
      );

      expect(requests).toEqual([{
        type: RequestType.PieceUpdateSource,
        pieceId: "of:fid1:piece",
        space: "did:key:z6Mk-runtime-client-source",
        action: { kind: "restore", revisionId: "revision-1" },
        confirmationToken: "confirmation-1",
      }]);
      expect(response).toEqual({ source });
    });
  });

  describe("space ACL methods", () => {
    it("sends read, set, and remove requests to the worker", async () => {
      const access = {
        space: "did:key:z6Mk-runtime-client-acl",
        principal: "did:key:z6Mk-runtime-client-owner",
        acl: { "did:key:z6Mk-runtime-client-owner": "OWNER" },
        canEdit: true,
      };
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ access });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      const space = access.space as never;

      expect(await client.getSpaceAcl(space)).toBe(access);
      expect(
        await client.setSpaceAclEntry(
          space,
          "did:key:z6Mk-runtime-client-reader",
          "READ",
        ),
      ).toBe(access);
      expect(
        await client.removeSpaceAclEntry(
          space,
          "did:key:z6Mk-runtime-client-reader",
        ),
      ).toBe(access);

      expect(requests).toEqual([
        { type: RequestType.SpaceGetAcl, space },
        {
          type: RequestType.SpaceSetAclEntry,
          space,
          user: "did:key:z6Mk-runtime-client-reader",
          capability: "READ",
        },
        {
          type: RequestType.SpaceRemoveAclEntry,
          space,
          user: "did:key:z6Mk-runtime-client-reader",
        },
      ]);
    });
  });

  describe("clonePiece", () => {
    it("asks the worker to clone between the named spaces", async () => {
      const sourceSpace = "did:key:z6Mk-runtime-client-source";
      const destinationSpace = "did:key:z6Mk-runtime-client-destination";
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({
            piece: {
              cell: {
                id: "of:fid1:clone",
                space: destinationSpace,
                path: [],
              },
            },
          });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      const clone = await client.clonePiece(
        "of:fid1:piece",
        sourceSpace as never,
        destinationSpace as never,
      );

      expect(requests).toEqual([{
        type: RequestType.PieceClone,
        pieceId: "of:fid1:piece",
        sourceSpace,
        destinationSpace,
      }]);
      expect(clone.id()).toBe("fid1:clone");
    });

    it("asks the worker to copy the piece's input data", async () => {
      const sourceSpace = "did:key:z6Mk-runtime-client-source";
      const destinationSpace = "did:key:z6Mk-runtime-client-destination";
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({
            piece: {
              cell: {
                id: "of:fid1:clone",
                space: destinationSpace,
                path: [],
              },
            },
          });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      await client.clonePiece(
        "of:fid1:piece",
        sourceSpace as never,
        destinationSpace as never,
        { copyData: true },
      );

      expect(requests).toEqual([{
        type: RequestType.PieceClone,
        pieceId: "of:fid1:piece",
        sourceSpace,
        destinationSpace,
        copyData: true,
      }]);
    });
  });

  describe("resolveSpaceName", () => {
    it("resolves the name inside the worker runtime", async () => {
      const space = "did:key:z6Mk-runtime-client-named-space";
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ space });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      expect(await client.resolveSpaceName("notebook")).toBe(space);
      expect(requests).toEqual([{
        type: RequestType.ResolveSpaceName,
        name: "notebook",
      }]);
    });
  });

  describe("hasPendingWrites", () => {
    // The constructor registers connection listeners; capture them so the
    // pending-writes notification can be driven directly, no worker needed.
    function clientWithConnHandlers(): {
      client: RuntimeClient;
      handlers: Map<string, (data: unknown) => void>;
    } {
      const handlers = new Map<string, (data: unknown) => void>();
      const conn = {
        on: (event: string, handler: (data: unknown) => void) => {
          handlers.set(event, handler);
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      return { client, handlers };
    }

    it("mirrors a pending-writes notification into a synchronous flag and event", () => {
      const { client, handlers } = clientWithConnHandlers();
      const onChange = handlers.get("pendingwriteschange");
      expect(onChange).toBeDefined();

      const emitted: boolean[] = [];
      client.on("pendingwriteschange", ({ pending }) => emitted.push(pending));

      // Defaults to false, and reflects each transition synchronously — the
      // property a beforeunload handler relies on (no async round-trip possible).
      expect(client.hasPendingWrites()).toBe(false);

      onChange!({ type: NotificationType.PendingWritesChanged, pending: true });
      expect(client.hasPendingWrites()).toBe(true);

      onChange!({
        type: NotificationType.PendingWritesChanged,
        pending: false,
      });
      expect(client.hasPendingWrites()).toBe(false);

      expect(emitted).toEqual([true, false]);
    });
  });

  describe("event attention", () => {
    const notice = {
      space: "did:key:z6Mk-runtime-client-attention" as never,
      eventId: "evt-original",
      seq: 42,
      sidecarId: "of:stream-events:attention",
      reason: "This event could not be delivered.",
      attention: {
        phase: "dispatch-load" as const,
        failureClass: "session-revoked" as const,
        code: "permanent-delivery-failure" as const,
        firstFailureAt: 10,
        lastFailureAt: 10,
        accumulatedFailureMs: 0,
        failureCount: 1,
        recovery: "explicit-retry" as const,
      },
    };

    it("lists and resolves retained notices with the complete recovery handle", async () => {
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: { type: RequestType }) => {
          requests.push(message);
          return Promise.resolve(
            message.type === RequestType.ListEventAttention
              ? { notices: [notice] }
              : { resolution: { kind: "retried", eventId: "evt-retry" } },
          );
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);

      expect(await client.listEventAttention(notice.space)).toEqual([notice]);
      expect(await client.resolveEventAttention(notice, "retry")).toEqual({
        kind: "retried",
        eventId: "evt-retry",
      });
      expect(requests).toEqual([{
        type: RequestType.ListEventAttention,
        space: notice.space,
      }, {
        type: RequestType.ResolveEventAttention,
        space: notice.space,
        eventId: notice.eventId,
        seq: notice.seq,
        sidecarId: notice.sidecarId,
        action: "retry",
      }]);
    });

    it("forwards a live worker notice without dropping safe detail", () => {
      const handlers = new Map<string, (data: unknown) => void>();
      const conn = {
        on: (event: string, handler: (data: unknown) => void) => {
          handlers.set(event, handler);
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      const observed: unknown[] = [];
      client.on("eventneedsattention", (value) => observed.push(value));

      handlers.get("eventneedsattention")!({
        type: NotificationType.EventNeedsAttention,
        ...notice,
      });
      expect(observed).toEqual([notice]);
    });
  });

  describe("getPatternCoverage", () => {
    // Same connection stub as above: the method is a single request whose response
    // `data` it returns verbatim (null included), so a stub that records the
    // request and replies with a fixed response pins the wiring.
    function clientWithResponse(
      response: unknown,
    ): { client: RuntimeClient; requests: unknown[] } {
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve(response);
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      return { client, requests };
    }

    it("returns the worker's coverage report", async () => {
      const data = {
        spans: [],
        hits: [{ fileName: "/main.tsx", id: 1, count: 2 }],
      };
      const { client, requests } = clientWithResponse({ data });
      expect(await client.getPatternCoverage()).toEqual(data);
      expect(requests).toEqual([{ type: RequestType.GetPatternCoverage }]);
    });

    it("returns null when the worker has no collector", async () => {
      const { client } = clientWithResponse({ data: null });
      expect(await client.getPatternCoverage()).toBeNull();
    });
  });

  describe("boot-window diagnostics", () => {
    it("exposes pending-request and request-timeline snapshots", () => {
      // Both getters are main-thread snapshots forwarded straight from the
      // connection (no worker round-trip), so a connection stub pins the
      // wiring.

      const pending = [{ msgId: 7, type: RequestType.Idle, ageMs: 12 }];
      const timeline = [
        { msgId: 7, type: RequestType.Idle, sentAtMs: 3, doneAtMs: 8 },
      ];
      const conn = {
        on: () => {},
        getPendingRequestDiagnostics: () => pending,
        getRequestTimelineDiagnostics: () => timeline,
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      expect(client.getPendingRequests()).toEqual(pending);
      expect(client.getRequestTimeline()).toEqual(timeline);
    });
  });

  describe("uploadBlob", () => {
    it("sends the blob's bytes as a `FabricBytes`", async () => {
      const requests: unknown[] = [];
      const conn = {
        on: () => {},
        request: (message: unknown) => {
          requests.push(message);
          return Promise.resolve({ id: "fid1:blob", url: "blobs/blob.png" });
        },
      } as unknown as never;
      const client = new (RuntimeClient as unknown as {
        new (conn: never, options: unknown): RuntimeClient;
      })(conn, undefined);
      const body = new Uint8Array([1, 2, 3]);

      const upload = client.uploadBlob({
        space: "did:key:z6Mk-runtime-client-blob" as never,
        contentType: "image/png",
        body,
        suffix: "png",
      });
      // Mutated with nothing awaited in between, so that what passes here is the
      // method's own copy rather than one some layer beneath it might take. The
      // connection double holds what it was handed without copying, so a request
      // that carried the caller's array would show this write.
      body[0] = 0xff;
      // The write has to have LANDED for the decode below to mean anything. Had
      // the method ceded the array rather than copied it, this view would be
      // detached, where a write is a silent no-op rather than an error and the
      // request would still decode to the original bytes -- so every assertion
      // about the decode would hold while the array the caller was promised had
      // been taken from it.
      expect(body.length).toBe(3);
      expect(body[0]).toBe(0xff);

      expect(await upload).toEqual({ id: "fid1:blob", url: "blobs/blob.png" });
      expect(requests.length).toBe(1);
      const request = requests[0] as UploadBlobRequest;
      expect(request.type).toBe(RequestType.UploadBlob);
      expect(request.space).toBe("did:key:z6Mk-runtime-client-blob");
      expect(request.contentType).toBe("image/png");
      expect(request.suffix).toBe("png");

      expect(request.body).toBeInstanceOf(FabricBytes);
      expect(request.body.slice()).toEqual(new Uint8Array([1, 2, 3]));
    });
  });
});

describe("attachOptionsFrom()", () => {
  // What it drops is the point: a document that attaches holds no signer, so
  // neither `Identity` survives the mapping. `findKeyMaterial` refuses a frame
  // holding one; this is what keeps one from being built.

  it("returns the acting principal as a DID and keeps no `Identity`", async () => {
    const identity = await Identity.fromPassphrase("attach-options-signer");
    const spaceIdentity = await Identity.fromPassphrase("attach-options-space");
    const attach = attachOptionsFrom({
      apiUrl: new URL("http://backend.test/"),
      identity,
      spaceIdentity,
      spaceDid: identity.did(),
    });

    expect(attach.identity).toBe(identity.did());
    expect(Object.values(attach)).not.toContain(identity);
    expect(Object.values(attach)).not.toContain(spaceIdentity);
    expect("spaceIdentity" in attach).toBe(false);
    expect(findKeyMaterial(attach)).toBeUndefined();
  });

  it("carries the posture fields an attach asserts", async () => {
    const identity = await Identity.fromPassphrase("attach-options-posture");
    const attach = attachOptionsFrom({
      apiUrl: new URL("http://backend.test/"),
      identity,
      spaceDid: identity.did(),
      spaceHostMap: { [identity.did()]: "http://memory.test/" },
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
      cfcReadMaxConfidentiality: [identity.did()],
      cfcReadOnExceed: "skip",
    });

    expect(attach.apiUrl.toString()).toBe("http://backend.test/");
    expect(attach.spaceHostMap).toEqual({
      [identity.did()]: "http://memory.test/",
    });
    expect(attach.cfcEnforcementMode).toBe("observe");
    expect(attach.cfcFlowLabels).toBe("persist");
    expect(attach.cfcReadMaxConfidentiality).toEqual([identity.did()]);
    expect(attach.cfcReadOnExceed).toBe("skip");
  });
});
