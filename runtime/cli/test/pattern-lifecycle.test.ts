// Drives the pattern-lifecycle client (lib/pattern-lifecycle.ts) against a
// stubbed memory session, so the wire contract the serving side verifies is
// exercised without a live toolshed: the arguments go without their space,
// and a refusal comes back with the server's code and message.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  instantiatePieceOnServer,
  type LifecycleClientConfig,
  ServedLifecycleError,
  setPieceSourceOnServer,
  wireProgram,
} from "../lib/pattern-lifecycle.ts";

const SPACE_DID: MemorySpace =
  "did:key:z6MkPatternLifecycleTestSpaceAAAAAAAAAAAAAAAAAAA";

const PROGRAM = {
  main: "/main.tsx",
  mainExport: "default",
  files: [{ name: "/main.tsx", contents: "export default 1;" }],
};

/** An error shaped as the memory client raises a lifecycle refusal. */
const refusal = (code: string, message = `refused: ${code}`) =>
  Object.assign(new Error(message), {
    name: "PatternLifecycleRefusal",
    code,
  });

/** A config whose session records each call and answers with `answer`. */
const sessionConfig = (answer: () => Promise<Record<string, unknown>>) => {
  const sent: { space: MemorySpace; verb: string; body: unknown }[] = [];
  const cfg: LifecycleClientConfig = {
    session: (space, verb, body) => {
      sent.push({ space, verb, body });
      return answer() as never;
    },
  };
  return { cfg, sent };
};

describe("pattern-lifecycle client", () => {
  describe("wireProgram", () => {
    it("carries the entry, its export, the files, the source roots, and the data files, and nothing else", () => {
      const carried = wireProgram({
        ...PROGRAM,
        sourceRoots: ["/main.test.tsx"],
        dataFiles: ["/data/cities.json"],
        // A field the wire does not take.
        extra: 1,
      } as never);
      expect(carried).toEqual({
        ...PROGRAM,
        sourceRoots: ["/main.test.tsx"],
        dataFiles: ["/data/cities.json"],
      });
    });
  });

  describe("instantiatePieceOnServer", () => {
    it("carries the same creation key across explicit retries", async () => {
      const { cfg, sent } = sessionConfig(() =>
        Promise.resolve({
          pieceId: "p1",
          pattern: { identity: "i", symbol: "s" },
        })
      );
      const input = {
        space: SPACE_DID,
        program: PROGRAM,
        requestKey: "stable-request",
      };
      await instantiatePieceOnServer(cfg, input);
      await instantiatePieceOnServer(cfg, input);
      expect(
        sent.map(({ body }) => (body as { requestKey?: string }).requestKey),
      ).toEqual(["stable-request", "stable-request"]);
    });

    it("raises the server's refusal with its code and message", async () => {
      const { cfg } = sessionConfig(() =>
        Promise.reject(refusal("compile-failed", "main.tsx:1 nope"))
      );
      const failure = await instantiatePieceOnServer(cfg, {
        space: SPACE_DID,
        program: PROGRAM,
      }).then(() => undefined, (error) => error);
      expect(failure).toBeInstanceOf(ServedLifecycleError);
      expect(failure.code).toBe("compile-failed");
      expect(failure.message).toBe("main.tsx:1 nope");
    });
  });

  describe("setPieceSourceOnServer", () => {
    it("names the piece, and carries the override and the start flag only when set", async () => {
      const { cfg, sent } = sessionConfig(() =>
        Promise.resolve({
          pieceId: "p1",
          pattern: { identity: "i", symbol: "s" },
          revisionId: "r1",
          seq: 7,
          detachedOrigin: null,
        })
      );
      const receipt = await setPieceSourceOnServer(cfg, {
        space: SPACE_DID,
        piece: "p1",
        program: PROGRAM,
        repository: "https://example.invalid/repo",
      });
      expect(receipt.revisionId).toBe("r1");
      expect(receipt.seq).toBe(7);
      await setPieceSourceOnServer(cfg, {
        space: SPACE_DID,
        piece: "p1",
        program: PROGRAM,
        dangerouslyAllowIncompatibleSchema: true,
        start: false,
      });
      expect(sent).toEqual([{
        space: SPACE_DID,
        verb: "setsrc",
        body: {
          piece: "p1",
          program: PROGRAM,
          repository: "https://example.invalid/repo",
        },
      }, {
        space: SPACE_DID,
        verb: "setsrc",
        body: {
          piece: "p1",
          program: PROGRAM,
          dangerouslyAllowIncompatibleSchema: true,
          start: false,
        },
      }]);
    });

    it("raises the server's refusal with its code", async () => {
      const { cfg } = sessionConfig(() =>
        Promise.reject(refusal("source-moved", "the piece moved"))
      );
      const failure = await setPieceSourceOnServer(cfg, {
        space: SPACE_DID,
        piece: "p1",
        program: PROGRAM,
      }).then(() => undefined, (error) => error);
      expect(failure).toBeInstanceOf(ServedLifecycleError);
      expect(failure.code).toBe("source-moved");
    });
  });

  describe("on a memory session", () => {
    it("sends the verb on the session of its space, without the space among its arguments", async () => {
      const receipt = {
        pieceId: "p1",
        pattern: { identity: "i", symbol: "s" },
      };
      const { cfg, sent } = sessionConfig(() => Promise.resolve(receipt));
      const result = await instantiatePieceOnServer(cfg, {
        space: SPACE_DID,
        program: PROGRAM,
        requestKey: "k",
        register: true,
      });
      expect(result).toEqual(receipt);
      expect(sent).toEqual([{
        space: SPACE_DID,
        verb: "instantiate",
        body: { requestKey: "k", program: PROGRAM, register: true },
      }]);
    });

    it("throws a settled refusal when the memory server does not take the request", async () => {
      const { cfg } = sessionConfig(() =>
        Promise.reject(refusal("lifecycle-unsupported"))
      );
      const failure = await setPieceSourceOnServer(cfg, {
        space: SPACE_DID,
        piece: "p1",
        program: PROGRAM,
      }).then(() => undefined, (error) => error);
      expect(failure).toBeInstanceOf(ServedLifecycleError);
      expect(failure.code).toBe("lifecycle-unsupported");
      expect(failure.refused).toBe(true);
    });

    it("throws a settled refusal with the server's code", async () => {
      const { cfg } = sessionConfig(() =>
        Promise.reject(refusal("slug-taken", "the slug names a piece"))
      );
      const failure = await instantiatePieceOnServer(cfg, {
        space: SPACE_DID,
        program: PROGRAM,
      }).then(() => undefined, (error) => error);
      expect(failure).toBeInstanceOf(ServedLifecycleError);
      expect(failure.code).toBe("slug-taken");
      expect(failure.refused).toBe(true);
      expect(failure.message).toBe("the slug names a piece");
    });

    it("throws a settled refusal from a memory server that runs no verbs", async () => {
      const { cfg } = sessionConfig(() =>
        Promise.reject(refusal("server-execution-off"))
      );
      const failure = await instantiatePieceOnServer(cfg, {
        space: SPACE_DID,
        program: PROGRAM,
      }).then(() => undefined, (error) => error);
      expect(failure).toBeInstanceOf(ServedLifecycleError);
      expect(failure.refused).toBe(true);
    });

    it("throws an unsettled refusal for a code that leaves the outcome unknown", async () => {
      const { cfg } = sessionConfig(() => Promise.reject(refusal("internal")));
      const failure = await instantiatePieceOnServer(cfg, {
        space: SPACE_DID,
        program: PROGRAM,
      }).then(() => undefined, (error) => error);
      expect(failure).toBeInstanceOf(ServedLifecycleError);
      expect(failure.refused).toBe(false);
    });

    it("throws a lost connection as it came", async () => {
      const lost = Object.assign(new Error("socket closed"), {
        name: "ConnectionError",
      });
      const { cfg } = sessionConfig(() => Promise.reject(lost));
      const failure = await instantiatePieceOnServer(cfg, {
        space: SPACE_DID,
        program: PROGRAM,
      }).then(() => undefined, (error) => error);
      expect(failure).toBe(lost);
    });
  });

  describe("ServedLifecycleError", () => {
    describe("instance members", () => {
      describe("refused", () => {
        it("returns `true` for a code that settles the verb, and `false` for any other", () => {
          expect(new ServedLifecycleError("forbidden", "").refused).toBe(true);
          expect(new ServedLifecycleError("space-not-served", "").refused)
            .toBe(false);
          expect(new ServedLifecycleError("internal", "").refused).toBe(false);
        });
      });
    });
  });
});
