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
const box = ref("box", "did:key:room");

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
      witnessedRelease: true,
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
            ? { receipt, box, instance: "instance" }
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
    expect(sealed.receipt).toBeInstanceOf(CellHandle);
    expect(sealed.receipt.ref()).toEqual(receipt);
    expect(sealed.box).toBeInstanceOf(CellHandle);
    expect(sealed.box.ref()).toEqual(box);
    expect(sealed.instance).toBe("instance");
    expect(requests).toEqual([
      { type: RequestType.CustodySealPrepare, ...cells },
      { type: RequestType.CustodySealCancel, id: "cancelled" },
      { type: RequestType.CustodySealCommit, id: "prepared" },
    ]);
  });

  it("asks the worker to publish an answer and to read it back", async () => {
    const requests: unknown[] = [];
    const answered: Record<string, unknown> = {
      [RequestType.CustodyAnswerPublish]: {
        instance: "instance",
        answer: "sushi",
      },
      [RequestType.CustodyAnswerRead]: { answer: "sushi" },
    };
    const conn = {
      on: () => {},
      request: (request: { type: string }) => {
        requests.push(request);
        return Promise.resolve(answered[request.type]);
      },
    } as unknown as never;
    const client = new (RuntimeClient as unknown as {
      new (conn: never, principal: undefined): RuntimeClient;
    })(conn, undefined);
    const room = { terms: cells.terms, policy: cells.policy };
    const output = ref("choice", "did:key:room");

    expect(await client.publishCustodyAnswer({ ...room, output })).toEqual({
      instance: "instance",
      answer: "sushi",
    });
    expect(await client.readCustodyAnswer(room)).toBe("sushi");
    answered[RequestType.CustodyAnswerRead] = {};
    expect(await client.readCustodyAnswer(room)).toBeUndefined();
    expect(requests).toEqual([
      { type: RequestType.CustodyAnswerPublish, ...room, output },
      { type: RequestType.CustodyAnswerRead, ...room },
      { type: RequestType.CustodyAnswerRead, ...room },
    ]);
  });
});
