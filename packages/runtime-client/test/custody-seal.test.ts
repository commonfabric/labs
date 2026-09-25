import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CellHandle } from "@/cell-handle.ts";
import { type CellRef, RequestType } from "@/protocol/mod.ts";
import { RuntimeClient } from "@/runtime-client.ts";

const ref = (id: string, space = "did:key:home"): CellRef => ({
  id: `of:fid1:${id}` as CellRef["id"],
  space: space as CellRef["space"],
  scope: "space",
  path: [],
});
const cells = {
  draft: ref("draft"),
  terms: ref("terms", "did:key:room"),
  policy: ref("policy"),
  allowedSources: ref("sources"),
};
const receipt = ref("receipt");

describe("custody-seal", () => {
  it("prepares a preview and commits only its opaque confirmation id", async () => {
    const requests: unknown[] = [];
    const preview = {
      id: "prepared",
      actor: "did:key:home",
      room: "did:key:room",
      readers: [{ principal: "did:key:home", role: "owner" }],
      terms: { seats: ["did:key:home"] },
      instance: "instance",
      policy: { type: "https://commonfabric.org/cfc/atom/Policy" },
      sources: [],
      stance: { choice: "sushi" },
    };
    const conn = {
      on: () => {},
      request: (request: { type: string }) => {
        requests.push(request);
        return Promise.resolve(
          request.type === RequestType.CustodySealPrepare
            ? preview
            : request.type === RequestType.CustodySealCommit
            ? { cell: receipt }
            : undefined,
        );
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, principal: undefined): RuntimeClient;
    })(conn, undefined);

    expect(await client.prepareCustodySeal(cells)).toEqual(preview);
    await client.cancelCustodySeal("cancelled");
    const sealed = await client.commitCustodySeal(preview.id);
    expect(sealed).toBeInstanceOf(CellHandle);
    expect(sealed.ref()).toEqual(receipt);
    expect(requests).toEqual([
      { type: RequestType.CustodySealPrepare, ...cells },
      { type: RequestType.CustodySealCancel, id: "cancelled" },
      { type: RequestType.CustodySealCommit, id: "prepared" },
    ]);
  });
});
