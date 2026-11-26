import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { Pattern } from "../src/builder/types.ts";
import { getDerivedInternalCell, getMetaCell } from "../src/link-utils.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { setResultCell } from "../src/result-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import {
  commitRefusal,
  interceptPieceStartCommit,
} from "./support/intercept-piece-start-commit.ts";
import { trustPattern } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner event start teardown");
const space = signer.did();

const patternIdentity = {
  identity: "test-runner-event-start-teardown",
  symbol: "default",
};

describe("runner", () => {
  describe("event start of a piece whose instantiation commit is refused", () => {
    // `creator` commits the piece, and `runtime` reaches it only through the
    // shared server, so a start on `runtime` installs its registration and
    // commits its instantiation.

    let server: MemoryV2Server.Server;
    let creatorStorage: EmulatedStorageManager;
    let storage: EmulatedStorageManager;
    let creator: Runtime;
    let runtime: Runtime;

    function newRuntime(storageManager: EmulatedStorageManager): Runtime {
      const made = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const pattern: Pattern = {
        argumentSchema: { type: "object", properties: {} },
        resultSchema: {
          type: "object",
          properties: { events: { type: "object" } },
        },
        derivedInternalCells: [
          { partialCause: "events", schema: { asCell: ["stream"] } },
        ],
        result: { events: { $alias: { partialCause: "events", path: [] } } },
        nodes: [{
          module: {
            type: "javascript",
            wrapper: "handler",
            implementation: () => {},
          },
          inputs: {
            $event: { $alias: { partialCause: "events", path: [] } },
          },
          outputs: {},
        }],
      };
      made.patternManager.associatePatternIdentity(
        trustPattern(made, pattern),
        patternIdentity,
      );
      return made;
    }

    async function createPiece(name: string): Promise<void> {
      const tx = creator.edit();
      const resultCell = creator.getCell(space, name, undefined, tx);
      const argumentCell = getMetaCell(resultCell, "argument", tx);
      const eventsCell = getDerivedInternalCell(resultCell, {
        partialCause: "events",
      }, tx);
      resultCell.setRaw({ events: eventsCell.getAsWriteRedirectLink() });
      resultCell.setMetaRaw(
        "patternIdentity",
        patternIdentity,
        rawMetaWriteAuthorization,
      );
      resultCell.setMetaRaw(
        "argument",
        argumentCell.getAsWriteRedirectLink(),
        rawMetaWriteAuthorization,
      );
      setResultCell(eventsCell, resultCell);
      argumentCell.setRaw({});
      expect((await tx.commit().settled).error).toBeUndefined();
    }

    beforeEach(() => {
      server = newSharedServer();
      creatorStorage = EmulatedStorageManager.connectTo(server, { as: signer });
      storage = EmulatedStorageManager.connectTo(server, { as: signer });
      creator = newRuntime(creatorStorage);
      runtime = newRuntime(storage);
    });

    afterEach(async () => {
      await runtime.runner.idlePieceInstantiationSettlements();
      await creator.dispose({ closeStorage: false });
      await runtime.dispose({ closeStorage: false });
      await creatorStorage.close();
      await storage.close();
      await server.close();
    });

    const namedSince = (mark: number): string[] =>
      runtime.runner.eventStartsSince(mark).map((link) => link.id);

    it("names the piece once its instantiation commits", async () => {
      await createPiece("committed");
      const piece = runtime.getCell(space, "committed");
      const mark = runtime.runner.eventStartMark;

      expect(await runtime.start(piece, { forEvent: true })).toBe(true);
      await runtime.runner.idlePieceInstantiationSettlements();

      expect(namedSince(mark)).toEqual([piece.getAsNormalizedFullLink().id]);
    });

    it("names the piece no more, and releases nothing, once the refusal retires its registration", async () => {
      await createPiece("refused");
      const piece = runtime.getCell(space, "refused");
      const mark = runtime.runner.eventStartMark;
      const commit = interceptPieceStartCommit(runtime, {
        refusal: commitRefusal("The instantiation is refused"),
        held: true,
      });
      try {
        expect(await runtime.start(piece, { forEvent: true })).toBe(true);
        expect(namedSince(mark)).toEqual([
          piece.getAsNormalizedFullLink().id,
        ]);

        commit.release();
        await runtime.runner.idlePieceInstantiationSettlements();
      } finally {
        commit.restore();
      }

      expect(runtime.runner.isRunning(piece)).toBe(false);
      expect(namedSince(mark)).toEqual([]);
      expect(runtime.runner.releaseEventStart(piece)).toBe(false);
    });
  });
});
