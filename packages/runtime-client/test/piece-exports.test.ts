/**
 * The reads a host makes to ask what a piece exports beside its UI: each is
 * one read, addressed at the field it asks about and stopping at that
 * field's shape, so that the worker decides it on that field alone. A refusal
 * of it answers "not exported". What the worker decides on those reads is in
 * `backends/host-read-gate.test.ts`.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { rendererVDOMSchema } from "@commonfabric/runner/schemas";

import {
  $conn,
  CellHandle,
  type CellRef,
  deliverOpenPath,
  FIELD_SHAPE_SCHEMA,
  RequestType,
  type RuntimeClient,
  sidebarOf,
} from "@/mod.ts";

const piece: CellRef = {
  id: "of:piece" as CellRef["id"],
  space: "did:key:piece-exports" as CellRef["space"],
  scope: "space",
  path: [],
  schema: { type: "object", properties: { name: { type: "string" } } },
};

/** The address of `field` in the piece, as a read of its shape names it. */
function shapeOf(field: string): CellRef {
  const { schema: _schema, ...address } = piece;
  return { ...address, path: [field], schema: FIELD_SHAPE_SCHEMA };
}

/**
 * A piece handle over a worker that answers every read with `answer`,
 * keeping each request it is sent.
 */
function pieceAnswering(answer: unknown) {
  const requests: { type: RequestType; cell: CellRef }[] = [];
  const runtime = {
    [$conn]: () => ({
      signal: new AbortController().signal,
      request: (request: { type: RequestType; cell: CellRef }) => {
        requests.push(request);
        return Promise.resolve(
          request.type === RequestType.CellGet ? answer : undefined,
        );
      },
    }),
  } as unknown as RuntimeClient;
  return { cell: new CellHandle<unknown>(runtime, piece), requests };
}

const REFUSED = { refused: { refusedBy: "display-ceiling" } };

describe("deliverOpenPath()", () => {
  it("reads only the shape of `openPath`, then sends the path to it", async () => {
    const { cell, requests } = pieceAnswering({ value: {} });

    expect(await deliverOpenPath(cell, "Notes/today.md")).toBe(true);
    const { schema: _schema, ...address } = piece;
    expect(requests).toEqual([
      { type: RequestType.CellGet, cell: shapeOf("openPath") },
      {
        type: RequestType.CellSend,
        cell: { ...address, path: ["openPath"] },
        event: { path: "Notes/today.md" },
      },
    ]);
  });

  for (
    const [what, answer] of [
      ["that exports no `openPath`", { value: undefined }],
      ["whose `openPath` the worker will not show", REFUSED],
    ] as const
  ) {
    it(`sends nothing to a piece ${what}`, async () => {
      const { cell, requests } = pieceAnswering(answer);

      expect(await deliverOpenPath(cell, "Notes/today.md")).toBe(false);
      expect(requests.map((request) => request.type)).toEqual([
        RequestType.CellGet,
      ]);
    });
  }

  it("sends nothing once the caller withdraws its claim", async () => {
    const { cell, requests } = pieceAnswering({ value: {} });

    expect(await deliverOpenPath(cell, "Notes/today.md", () => false)).toBe(
      false,
    );
    expect(requests.map((request) => request.type)).toEqual([
      RequestType.CellGet,
    ]);
  });
});

describe("sidebarOf()", () => {
  it("reads only the shape of `sidebarUI`, and returns it as a render tree", async () => {
    const { cell, requests } = pieceAnswering({ value: {} });

    const sidebar = await sidebarOf(cell);

    expect(requests).toEqual([
      { type: RequestType.CellGet, cell: shapeOf("sidebarUI") },
    ]);
    const { schema: _schema, ...address } = piece;
    expect(sidebar?.ref()).toEqual({
      ...address,
      path: ["sidebarUI"],
      schema: rendererVDOMSchema,
    });
  });

  for (
    const [what, answer] of [
      ["that shows none", { value: undefined }],
      ["whose `sidebarUI` the worker will not show", REFUSED],
    ] as const
  ) {
    it(`returns no sidebar for a piece ${what}`, async () => {
      const { cell } = pieceAnswering(answer);

      expect(await sidebarOf(cell)).toBeUndefined();
    });
  }
});
