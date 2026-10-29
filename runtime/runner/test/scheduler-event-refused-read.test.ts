import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type ScopeKeyIdentity, toDocumentPath } from "@commonfabric/memory/v2";

import { refusedReadIn } from "../src/scheduler/events.ts";
import type {
  IReadActivity,
  Metadata,
  ScopedReadStanding,
} from "../src/storage/interface.ts";
import {
  ignoreReadForScheduling,
  linkResolutionProbe,
} from "../src/storage/reactivity-log.ts";

const HOME = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const FOREIGN = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

/**
 * A manager that refuses every scoped read of `FOREIGN`, as a serving one
 * with no grant for the reading actor does, and records the identity each
 * standing was asked under.
 */
const asked: (ScopeKeyIdentity | undefined)[] = [];
const manager = {
  scopedReadStanding: (
    address: { space: string; scope?: string },
    identity: ScopeKeyIdentity | undefined,
  ): ScopedReadStanding => {
    asked.push(identity);
    return address.space === FOREIGN && (address.scope ?? "space") !== "space"
      ? "refused"
      : "admitted";
  },
};

/** A manager still asking for the reading actor's grant on `FOREIGN`. */
const asking = {
  scopedReadStanding: (
    address: { space: string; scope?: string },
  ): ScopedReadStanding =>
    address.space === FOREIGN && (address.scope ?? "space") !== "space"
      ? "unresolved"
      : "admitted",
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

/** A transaction whose read activities are `reads`, under `identity`. */
function txReading(...reads: IReadActivity[]) {
  return { getReadActivities: () => reads, scopeKeyIdentity: undefined };
}

const REFUSED = {
  document: `${FOREIGN}/user/of:fid1:refused-read-target`,
  standing: "refused",
  address: { space: FOREIGN, id: "of:fid1:refused-read-target", scope: "user" },
};

describe("refusedReadIn()", () => {
  it("returns the document whose root a run read, with its standing", () => {
    expect(refusedReadIn(manager, txReading(read([])))).toEqual(REFUSED);
  });

  it("returns the document whose value a run read", () => {
    expect(refusedReadIn(manager, txReading(read(["value", "count"]))))
      .toEqual(REFUSED);
  });

  it("returns an unresolved standing for a document whose actor's grant is still being asked for", () => {
    expect(refusedReadIn(asking, txReading(read(["value"])))).toEqual({
      ...REFUSED,
      standing: "unresolved",
    });
  });

  it("asks the manager under the transaction's identity", () => {
    const identity = { principal: "did:key:z6MkReader" };
    asked.length = 0;
    expect(
      refusedReadIn(manager, {
        getReadActivities: () => [read(["value"])],
        scopeKeyIdentity: identity,
      }),
    ).toEqual(REFUSED);
    expect(asked).toEqual([identity]);
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
