import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CellHandle, CellReadRefusedError } from "@/cell-handle.ts";
import { type CellRef, RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";

const source: CellRef = {
  id: "of:fid1:source" as CellRef["id"],
  space: "did:key:space" as CellRef["space"],
  scope: "user",
  path: [],
};
const recipient: CellRef = {
  ...source,
  id: "of:fid1:recipient",
  scope: "space",
};

/** A client whose worker answers each request with `answer`. */
function clientAnswering(
  answer: (request: { type: string }) => unknown,
): RuntimeClient {
  const conn = {
    on: () => {},
    request: (request: { type: string }) => Promise.resolve(answer(request)),
  } as unknown as never;
  return new (RuntimeClient as unknown as {
    new (conn: never, principal: undefined): RuntimeClient;
  })(conn, undefined);
}

describe("snapshot-share", () => {
  it("prepares a preview and commits only its opaque confirmation id", async () => {
    const requests: unknown[] = [];
    const audience = {
      type: "https://commonfabric.org/cfc/atom/User",
      subject: "recipient",
    };
    const client = clientAnswering((request) => {
      requests.push(request);
      return request.type === "snapshotShare:prepare"
        ? { id: "prepared", value: { title: "Solaris" }, audience }
        : { cell: recipient };
    });

    const preview = await client.prepareSnapshotShare(source, {
      user: recipient,
    });
    expect(preview).toEqual({
      id: "prepared",
      value: { title: "Solaris" },
      audience,
    });
    await client.cancelSnapshotShare("cancelled");
    const released = await client.commitSnapshotShare(preview.id);
    expect(released).toBeInstanceOf(CellHandle);
    expect(released.ref()).toEqual(recipient);
    expect(requests).toEqual([
      {
        type: RequestType.SnapshotSharePrepare,
        source,
        audience: { user: recipient },
      },
      { type: RequestType.SnapshotShareCancel, id: "cancelled" },
      { type: RequestType.SnapshotShareCommit, id: "prepared" },
    ]);
  });

  it("rejects a preview of a source the worker refuses the host", async () => {
    const client = clientAnswering(() => ({
      refused: { refusedBy: "display-ceiling" },
    }));

    await expect(client.prepareSnapshotShare(source, { user: recipient }))
      .rejects.toThrow(CellReadRefusedError);
  });
});
