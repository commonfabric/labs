// Drives the pattern-lifecycle client (lib/pattern-lifecycle.ts) against a
// stubbed memory session, so the wire contract the serving side verifies is
// exercised without a live toolshed: the arguments go without their space,
// and a refusal comes back with the server's code and message.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  followPieceOnServer,
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

  describe("followPieceOnServer", () => {
    it("names the piece and the origin, and carries each pin, the override, and the start flag only when set", async () => {
      const { cfg, sent } = sessionConfig(() =>
        Promise.resolve({
          pieceId: "p1",
          pattern: { identity: "i", symbol: "s" },
          origin: "system:x.tsx",
          revisionId: "r2",
        })
      );
      const receipt = await followPieceOnServer(cfg, {
        space: SPACE_DID,
        piece: "p1",
        origin: "system:x.tsx",
      });
      expect(receipt.origin).toBe("system:x.tsx");
      expect(receipt.revisionId).toBe("r2");
      await followPieceOnServer(cfg, {
        space: SPACE_DID,
        piece: "p1",
        origin: "system:x.tsx",
        expectedPattern: { identity: "i0", symbol: "s" },
        expectedRevision: null,
        dangerouslyAllowIncompatibleSchema: true,
        start: false,
      });
      expect(sent).toEqual([{
        space: SPACE_DID,
        verb: "follow",
        body: { piece: "p1", origin: "system:x.tsx" },
      }, {
        space: SPACE_DID,
        verb: "follow",
        body: {
          piece: "p1",
          origin: "system:x.tsx",
          expectedPattern: { identity: "i0", symbol: "s" },
          // A pin to an empty source log, which is not an absent pin.
          expectedRevision: null,
          dangerouslyAllowIncompatibleSchema: true,
          start: false,
        },
      }]);
    });

    it("refuses before sending to a deployment whose verbs take no origin, and sends where they do or it cannot tell", async () => {
      const { cfg, sent } = sessionConfig(() =>
        Promise.resolve({
          pieceId: "p1",
          pattern: { identity: "i", symbol: "s" },
          origin: "system:x.tsx",
          revisionId: "r2",
          seq: 3,
          detachedOrigin: null,
        })
      );
      let takes: boolean | undefined = false;
      const config = { ...cfg, takesOrigins: () => Promise.resolve(takes) };
      const follow = () =>
        followPieceOnServer(config, {
          space: SPACE_DID,
          piece: "p1",
          origin: "system:x.tsx",
        });
      const setsrc = (origin?: string) =>
        setPieceSourceOnServer(config, {
          space: SPACE_DID,
          piece: "p1",
          program: PROGRAM,
          ...(origin === undefined ? {} : { origin }),
        });

      for (const refused of [follow(), setsrc("system:x.tsx")]) {
        const failure = await refused.then(() => undefined, (error) => error);
        expect(failure).toBeInstanceOf(ServedLifecycleError);
        expect(failure.code).toBe("origin-unsupported");
        expect(failure.refused).toBe(true);
      }
      expect(sent).toEqual([]);
      // An update naming no origin does not depend on the capability.
      await setsrc();
      expect(sent.map(({ verb }) => verb)).toEqual(["setsrc"]);

      takes = true;
      await follow();
      takes = undefined;
      await setsrc("system:x.tsx");
      expect(sent.map(({ verb }) => verb)).toEqual([
        "setsrc",
        "follow",
        "setsrc",
      ]);
    });

    it("sends the scope of a piece addressed at one only to a deployment whose verbs say they take it", async () => {
      const { cfg, sent } = sessionConfig(() =>
        Promise.resolve({
          pieceId: "p1",
          pattern: { identity: "i", symbol: "s" },
          origin: "system:x.tsx",
          revisionId: "r2",
          seq: 3,
          detachedOrigin: null,
          scope: "session",
        })
      );
      let takes: boolean | undefined = false;
      const config = {
        ...cfg,
        takesOrigins: () => Promise.resolve(true),
        takesScopes: () => Promise.resolve(takes),
      };
      const follow = () =>
        followPieceOnServer(config, {
          space: SPACE_DID,
          piece: "p1",
          scope: "session",
          origin: "system:x.tsx",
        });
      const setsrc = (scope?: "user") =>
        setPieceSourceOnServer(config, {
          space: SPACE_DID,
          piece: "p1",
          ...(scope === undefined ? {} : { scope }),
          program: PROGRAM,
        });

      // An older server reads past the scope and changes the space
      // instance, and one that cannot be asked might: neither is sent to.
      for (const answer of [false, undefined]) {
        takes = answer;
        for (const refused of [follow(), setsrc("user")]) {
          const failure = await refused.then(() => undefined, (e) => e);
          expect(failure).toBeInstanceOf(ServedLifecycleError);
          expect(failure.code).toBe("scope-unsupported");
          expect(failure.refused).toBe(true);
        }
      }
      expect(sent).toEqual([]);
      // A space piece does not depend on the capability.
      await setsrc();
      expect(sent).toEqual([{
        space: SPACE_DID,
        verb: "setsrc",
        body: { piece: "p1", program: PROGRAM },
      }]);

      takes = true;
      expect((await follow()).scope).toBe("session");
      await setsrc("user");
      expect(sent.slice(1)).toEqual([{
        space: SPACE_DID,
        verb: "follow",
        body: { piece: "p1", scope: "session", origin: "system:x.tsx" },
      }, {
        space: SPACE_DID,
        verb: "setsrc",
        body: { piece: "p1", scope: "user", program: PROGRAM },
      }]);
    });

    it("raises the server's refusal with its code, which settles the verb", async () => {
      const { cfg } = sessionConfig(() =>
        Promise.reject(refusal("origin-unreachable", "Failed to fetch: 404"))
      );
      const failure = await followPieceOnServer(cfg, {
        space: SPACE_DID,
        piece: "p1",
        origin: "system:absent.tsx",
      }).then(() => undefined, (error) => error);
      expect(failure).toBeInstanceOf(ServedLifecycleError);
      expect(failure.code).toBe("origin-unreachable");
      expect(failure.refused).toBe(true);
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
