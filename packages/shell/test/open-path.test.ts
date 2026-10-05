/**
 * The shell's `?path=` deep link, sent into a piece only when it exports an
 * `openPath` stream. The connection below answers as the worker does: a
 * field read as a stream comes back as a handle to that field whether or not
 * the piece holds one there, and a field read for what is stored there comes
 * back as stored, or not at all.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  $conn,
  CellHandle,
  type CellRef,
  RequestType,
  type RuntimeClient,
} from "@commonfabric/runtime-client";

import { deliverOpenPath } from "../src/lib/open-path.ts";

const SPACE = "did:key:z6Mk-open-path" as CellRef["space"];

/** A piece whose result holds `stored`, and the requests made of it. */
function piece(stored: Record<string, unknown>) {
  const ref: CellRef = {
    id: "of:fid1:open-path-piece" as CellRef["id"],
    space: SPACE,
    scope: "space",
    path: [],
  };
  const sends: unknown[] = [];
  const runtime = {
    [$conn]: () => ({
      signal: new AbortController().signal,
      request: (request: {
        type: RequestType;
        cell: CellRef;
        event?: unknown;
      }) => {
        if (request.type === RequestType.CellSend) {
          sends.push({ path: request.cell.path, event: request.event });
          return Promise.resolve({});
        }
        if (request.type !== RequestType.CellGet) {
          return Promise.reject(new Error(`unexpected ${request.type}`));
        }
        const field = (request.cell.schema as {
          properties?: { openPath?: { asCell?: unknown } };
        })?.properties?.openPath;
        if (field?.asCell !== undefined) {
          return Promise.resolve({
            value: {
              openPath: {
                "/": {
                  "link@1": { id: ref.id, space: SPACE, path: ["openPath"] },
                },
              },
            },
          });
        }
        return Promise.resolve({
          value: "openPath" in stored ? { openPath: stored.openPath } : {},
        });
      },
      subscribe: () => Promise.resolve(),
      unsubscribe: () => Promise.resolve(),
    }),
  } as unknown as RuntimeClient;
  return { cell: new CellHandle(runtime, ref), sends };
}

describe("deliverOpenPath()", () => {
  it("sends the path to a piece that exports an `openPath` stream", async () => {
    const { cell, sends } = piece({ openPath: { $stream: true } });

    expect(await deliverOpenPath(cell, "Notes/today.md", () => true)).toBe(
      true,
    );
    expect(sends).toEqual([{
      path: ["openPath"],
      event: { path: "Notes/today.md" },
    }]);
  });

  for (
    const [what, stored] of [
      ["no `openPath`", { title: "no exports" }],
      ["an `openPath` that is not a stream", { openPath: { path: "x" } }],
    ] as const
  ) {
    it(`writes nothing to a piece with ${what}`, async () => {
      const { cell, sends } = piece(stored);

      expect(await deliverOpenPath(cell, "Notes/today.md", () => true)).toBe(
        false,
      );
      expect(sends).toEqual([]);
    });
  }

  it("sends nothing when the claim is withdrawn", async () => {
    const { cell, sends } = piece({ openPath: { $stream: true } });

    expect(await deliverOpenPath(cell, "Notes/today.md", () => false)).toBe(
      false,
    );
    expect(sends).toEqual([]);
  });
});
