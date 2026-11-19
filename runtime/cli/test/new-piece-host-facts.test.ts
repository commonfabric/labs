import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { newPieceFromCommand, piece } from "../commands/piece.ts";
import { captureStderr } from "./utils.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "host-facts",
  identity: "/unused/test.key",
  quiet: true,
};

/** The options `cf piece new` hands creation for `hostFact`. */
const createdWith = async (hostFact: string[]): Promise<unknown> => {
  let received: unknown;
  await captureStderr(() =>
    newPieceFromCommand({ ...CONFIG, hostFact }, "/repo/main.tsx", {
      newPiece: (_config, _entry, options) => {
        received = options;
        return Promise.resolve({ pieceId: "fid1:created" });
      },
    })
  );
  return received;
};

describe("piece creation host facts", () => {
  it("declares the host fact option on piece new", () => {
    expect(piece.getCommand("new")?.getOption("host-fact")).toBeDefined();
  });

  it("hands creation each `<key>=<value>` fact by its key", async () => {
    expect(await createdWith(["loom.id=loom-1", "loom.note=a=b"]))
      .toMatchObject({
        hostFacts: { "loom.id": "loom-1", "loom.note": "a=b" },
      });
  });

  it("hands creation no host facts when none is given", async () => {
    expect(await createdWith([])).not.toHaveProperty("hostFacts");
  });

  for (
    const [facts, says] of [
      [["loom.id"], "takes `<key>=<value>`"],
      [["=loom-1"], "takes `<key>=<value>`"],
      [["loom.id=a", "loom.id=b"], "names `loom.id` twice"],
    ] as const
  ) {
    it(`refuses ${JSON.stringify(facts)} before creating a piece`, async () => {
      let created = false;
      await expect(newPieceFromCommand(
        { ...CONFIG, hostFact: [...facts] },
        "/repo/main.tsx",
        {
          newPiece: () => {
            created = true;
            return Promise.resolve({ pieceId: "fid1:unwanted" });
          },
        },
      )).rejects.toThrow(says);
      expect(created).toBe(false);
    });
  }
});
