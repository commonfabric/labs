import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { newPiece } from "../lib/piece.ts";
import type { PhaseTrace } from "../lib/trace-timing.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "creation-phases",
  identity: "/unused/test.key",
  quiet: true,
};

describe("newPiece()", () => {
  it("reports each creation step and the steps the serving side timed", async () => {
    const lines: string[] = [];
    const trace: PhaseTrace = {
      enabled: true,
      log: (line) => lines.push(line),
    };
    const id = await newPiece(
      CONFIG,
      { mainPath: "/main.tsx" },
      { start: false, requestKey: "creation-phases" },
      {
        loadPieces: () =>
          Promise.resolve({
            runtime: { experimental: { serverExecution: true } },
            getSpace: () => "did:key:test-space",
            getPieceCell: () => Promise.resolve({}),
          } as never),
        getPinnedProgramFromFile: () =>
          Promise.resolve({ main: "/main.tsx", files: [] }),
        loadIdentity: () => Promise.resolve({} as never),
        instantiatePieceOnServer: () =>
          Promise.resolve({
            pieceId: "fid1:created",
            pattern: { identity: "pattern", symbol: "default" },
            requestKey: "creation-phases",
            registration: { status: "handled" },
            timings: [
              { phase: "instantiate.queue", ms: 1500 },
              { phase: "registration.delivery", ms: 30 },
            ],
          }),
        phaseTrace: trace,
      },
    );
    expect(id).toBe("fid1:created");
    expect(lines.map((line) => line.replace(/^\[cf-phase\] \d+ms :: /, "")))
      .toEqual([
        "newPiece.create.instantiate",
        "newPiece.create.server.instantiate.queue",
        "newPiece.create.server.registration.delivery",
        "newPiece.create.getPieceCell",
      ]);
    expect(lines).toContain(
      "[cf-phase] 1500ms :: newPiece.create.server.instantiate.queue",
    );
  });
});
