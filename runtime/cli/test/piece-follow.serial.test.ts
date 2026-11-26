/**
 * The exit status `cf piece follow` sets when no setter is supplied.
 */

import { expect } from "@std/expect";

import { followPieceSourceAction } from "../commands/piece.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const TARGET = {
  apiUrl: "http://127.0.0.1:8000",
  identity: "/nonexistent-but-unread.key",
  space: "did:key:z6MkFollowed",
  cell: "board",
};

describe("piece-follow", () => {
  let exitCode: number;

  beforeEach(() => {
    exitCode = Deno.exitCode;
  });

  afterEach(() => {
    Deno.exitCode = exitCode;
  });

  it("sets the process's exit status for a source the piece cannot take", async () => {
    Deno.exitCode = 0;
    const printed: string[] = [];

    await followPieceSourceAction(TARGET, "system:system/room.tsx", {
      followPieceSource: () =>
        Promise.resolve({ status: "incompatible", message: "no" }),
      render: () => {},
      hint: () => {},
      printError: (message) => printed.push(message),
    });

    expect(Deno.exitCode).toBe(1);
    expect(printed[0]).toBe(
      "The source system:system/room.tsx serves now cannot replace what " +
        "board runs: no",
    );
  });
});
