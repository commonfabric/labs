import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { listCallableKeys } from "../lib/piece.ts";

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  piece: "fid1:piece-123",
  space: "home",
};

/**
 * Helper for the cases below, which is a child cell whose link-derived schema
 * is `schema` and which holds `value`. `key()` reaches a child holding
 * nothing, which is what the tool-shape probe asks of a non-callable.
 */
function child(schema: unknown, value: unknown) {
  return {
    schema,
    getRaw: () => value,
    get: () => value,
    key: () => ({ getRaw: () => undefined, get: () => undefined }),
    asSchemaFromLinks() {
      return this;
    },
  };
}

/**
 * Helper for the cases below, which stands a piece in for the one the read
 * loads: its two cells each hold the children `keys` names, and a key the
 * cell refuses throws, the way a link the store cannot follow does. What was
 * asked of the piece is recorded in `asked`.
 */
function pieceOf(
  children: Record<string, ReturnType<typeof child>>,
  asked: string[],
) {
  const cell = (side: string) => ({
    key: (key: string) => {
      asked.push(`${side}.${key}`);
      const found = children[key];
      if (found === undefined) throw new Error(`no link at ${key}`);
      return found;
    },
  });
  return {
    result: { getCell: () => Promise.resolve(cell("result")) },
    input: { getCell: () => Promise.resolve(cell("input")) },
  };
}

/** Helper for the cases below, which hands the read `piece` for the piece. */
function reaching(piece: ReturnType<typeof pieceOf>) {
  return {
    loadPieces: () => Promise.resolve({} as never),
    resolvePieceAddress: (_pieces: unknown, token: string) =>
      Promise.resolve(token),
    loadPieceForRead: () => Promise.resolve(piece as never),
  };
}

describe("listCallableKeys()", () => {
  const children = {
    bump: child({ asCell: ["stream"], type: "object" }, undefined),
    label: child({ type: "string" }, "a place"),
  };

  it("returns no callables for no keys, without reaching the piece", async () => {
    const callables = await listCallableKeys(CONFIG, [], [], {}, {
      loadPieces: () => Promise.reject(new Error("the piece was loaded")),
    });
    expect([...callables]).toEqual([]);
  });

  it("names the keys whose link-derived schema declares a stream, and passes over a key the cell refuses", async () => {
    const asked: string[] = [];
    const callables = await listCallableKeys(
      CONFIG,
      [],
      ["bump", "label", "missing"],
      {},
      reaching(pieceOf(children, asked)),
    );
    expect([...callables]).toEqual(["bump"]);
    expect(asked).toEqual(["result.bump", "result.label", "result.missing"]);
  });

  it("reads the arguments cell where the read asks for it", async () => {
    const asked: string[] = [];
    const callables = await listCallableKeys(
      CONFIG,
      [],
      ["bump"],
      { input: true },
      reaching(pieceOf(children, asked)),
    );
    expect([...callables]).toEqual(["bump"]);
    expect(asked).toEqual(["input.bump"]);
  });

  it("yields no callables where the piece cannot be reached", async () => {
    const callables = await listCallableKeys(CONFIG, [], ["bump"], {}, {
      loadPieces: () => Promise.reject(new Error("no connection")),
    });
    expect([...callables]).toEqual([]);
  });
});
