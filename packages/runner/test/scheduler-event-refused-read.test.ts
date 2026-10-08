import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { toDocumentPath } from "@commonfabric/memory/v2";

import { refusedReadIn } from "../src/scheduler/events.ts";
import type { IReadActivity, Metadata } from "../src/storage/interface.ts";
import {
  ignoreReadForScheduling,
  linkResolutionProbe,
} from "../src/storage/reactivity-log.ts";

const HOME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const FOREIGN = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

/** A manager that refuses every scoped read of `FOREIGN`, as a serving one. */
const manager = {
  refusesReadByConstruction: (
    address: { space: string; scope?: string },
  ): boolean =>
    address.space === FOREIGN && (address.scope ?? "space") !== "space",
};

/** A read of `path` in a document of `space`, at `scope`, with `meta`. */
function read(
  path: string[],
  options: { space?: string; scope?: string; meta?: Metadata } = {},
): IReadActivity {
  return {
    space: options.space ?? FOREIGN,
    id: "of:fid1:refused-read-target",
    type: "application/json",
    scope: options.scope ?? "user",
    path: toDocumentPath(path),
    meta: options.meta ?? {},
  } as IReadActivity;
}

/** A transaction whose read activities are `reads`. */
function txReading(...reads: IReadActivity[]) {
  return { getReadActivities: () => reads };
}

describe("refusedReadIn()", () => {
  it("returns the document whose root a run read", () => {
    expect(refusedReadIn(manager, txReading(read([])))).toBe(
      `${FOREIGN}/user/of:fid1:refused-read-target`,
    );
  });

  it("returns the document whose value a run read", () => {
    expect(refusedReadIn(manager, txReading(read(["value", "count"]))))
      .toBe(`${FOREIGN}/user/of:fid1:refused-read-target`);
  });

  it("returns `undefined` for a link-resolution probe of the document's value, whatever its path", () => {
    expect(
      refusedReadIn(
        manager,
        txReading(read(["value"], { meta: linkResolutionProbe })),
      ),
    ).toBeUndefined();
  });

  it("returns `undefined` for a read of the document's CFC metadata", () => {
    expect(refusedReadIn(manager, txReading(read(["cfc"])))).toBeUndefined();
  });

  it("returns `undefined` for a read ignored for scheduling", () => {
    expect(
      refusedReadIn(
        manager,
        txReading(read(["value"], { meta: ignoreReadForScheduling })),
      ),
    ).toBeUndefined();
  });

  it("returns `undefined` for documents the manager does not refuse", () => {
    expect(
      refusedReadIn(
        manager,
        txReading(
          read(["value"], { scope: "space" }),
          read(["value"], { space: HOME }),
        ),
      ),
    ).toBeUndefined();
  });
});
