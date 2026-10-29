import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CellScope } from "@commonfabric/api";
import type { DID } from "@commonfabric/identity";

import { PieceHandle } from "@/piece-handle.ts";
import { $conn, type RuntimeClient } from "@/runtime-client.ts";
import { type CellRef, RequestType } from "@/protocol/mod.ts";

describe("PieceHandle", () => {
  const space = "did:key:z6Mk-piece-handle-space" as DID;

  /**
   * A handle over a cell addressed by `space` and `scope`, along with the
   * requests it sends. Both halves are what the worker would otherwise
   * assume: a foreign space resolves to another piece context, and one id in
   * two scopes is two documents.
   */
  function makeHandle(scope: CellScope) {
    const requests: Array<Record<string, unknown>> = [];
    const conn = {
      request: (req: Record<string, unknown>) => {
        requests.push(req);
        return Promise.resolve({ value: true });
      },
    };
    const client = { [$conn]: () => conn } as unknown as RuntimeClient;
    const ref: CellRef = {
      id: "of:fid1-piece-handle-probe" as CellRef["id"],
      space,
      scope,
      path: [],
    };
    const handle = new PieceHandle(client, { cell: ref });
    return { handle, requests };
  }

  describe("instance members", () => {
    describe("start()", () => {
      it("sends the cell's space and its space scope", async () => {
        const { handle, requests } = makeHandle("space");
        await expect(handle.start()).resolves.toBe(true);
        expect(requests).toEqual([{
          type: RequestType.PieceStart,
          pieceId: "fid1-piece-handle-probe",
          space,
          scope: "space",
        }]);
      });

      it("sends the narrower scope the cell was reached through", async () => {
        const { handle, requests } = makeHandle("user");
        await expect(handle.start()).resolves.toBe(true);
        expect(requests).toEqual([{
          type: RequestType.PieceStart,
          pieceId: "fid1-piece-handle-probe",
          space,
          scope: "user",
        }]);
      });
    });

    describe("stop()", () => {
      it("sends the cell's space and its space scope", async () => {
        const { handle, requests } = makeHandle("space");
        await expect(handle.stop()).resolves.toBe(true);
        expect(requests).toEqual([{
          type: RequestType.PieceStop,
          pieceId: "fid1-piece-handle-probe",
          space,
          scope: "space",
        }]);
      });

      it("sends the narrower scope the cell was reached through", async () => {
        const { handle, requests } = makeHandle("session");
        await expect(handle.stop()).resolves.toBe(true);
        expect(requests).toEqual([{
          type: RequestType.PieceStop,
          pieceId: "fid1-piece-handle-probe",
          space,
          scope: "session",
        }]);
      });
    });
  });
});
