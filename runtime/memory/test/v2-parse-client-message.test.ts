import { expect } from "@std/expect";

import type { FabricPlainObject } from "@commonfabric/api";
import { describe, it } from "@commonfabric/test-support/test";

import { encodeMemoryBoundary } from "../v2.ts";
import { parseClientMessage } from "../v2/server.ts";

const SPACE = "did:key:z6Mk-parse-client-message";

describe("parseClientMessage()", () => {
  describe("`session.open`", () => {
    const open = (session: FabricPlainObject) =>
      parseClientMessage(encodeMemoryBoundary({
        type: "session.open",
        requestId: "open-1",
        space: SPACE,
        session,
      }));

    it("returns the message for a session declaring a well-formed space kind and no demand", () => {
      expect(open({ spaceKind: "home", demand: false })).toMatchObject({
        type: "session.open",
        requestId: "open-1",
        space: SPACE,
      });
    });

    for (
      const [label, session] of [
        ["a genesis root that is not one", { genesisRoot: "of:root" }],
        ["a malformed space kind", { spaceKind: "Not A Kind" }],
        ["`demand: true`", { demand: true }],
        ["a branch that is not a string", { branch: 7 }],
        ["an invite that is not a redemption", { invite: { code: 7 } }],
      ] as const
    ) {
      it(`returns an \`invalid\` rejection for a session declaring ${label}`, () => {
        expect(open(session)).toEqual({ type: "invalid", requestId: "open-1" });
      });
    }
  });

  describe("`branch.create`", () => {
    const create = (fields: FabricPlainObject) =>
      parseClientMessage(encodeMemoryBoundary({
        type: "branch.create",
        requestId: "create-1",
        space: SPACE,
        sessionId: "session:1",
        name: "fork",
        ...fields,
      }));

    it("returns the message with the parent branch and fork point it names", () => {
      expect(create({ parentBranch: "base", forkSeq: 3 })).toEqual({
        type: "branch.create",
        requestId: "create-1",
        space: SPACE,
        sessionId: "session:1",
        name: "fork",
        parentBranch: "base",
        forkSeq: 3,
      });
    });

    for (
      const [label, fields] of [
        ["a parent branch that is not a string", { parentBranch: 7 }],
        ["a negative fork point", { forkSeq: -1 }],
        ["a fork point that is not an integer", { forkSeq: 1.5 }],
      ] as const
    ) {
      it(`returns an \`invalid\` rejection for ${label}`, () => {
        expect(create(fields)).toEqual({
          type: "invalid",
          requestId: "create-1",
        });
      });
    }
  });

  describe("`session.watch.set`", () => {
    const watchSet = (fields: FabricPlainObject) =>
      parseClientMessage(encodeMemoryBoundary({
        type: "session.watch.set",
        requestId: "watch-1",
        space: SPACE,
        sessionId: "session:1",
        watches: [],
        ...fields,
      }));

    it("returns a staged part that names its set, its number, and that more follow", () => {
      expect(watchSet({ stage: "stage-1", part: 0, more: true })).toEqual({
        type: "session.watch.set",
        requestId: "watch-1",
        space: SPACE,
        sessionId: "session:1",
        watches: [],
        stage: "stage-1",
        part: 0,
        more: true,
      });
    });

    for (
      const [label, fields] of [
        ["a part with no stage", { part: 0 }],
        ["a stage with no part", { stage: "stage-1" }],
        ["a negative part", { stage: "stage-1", part: -1 }],
        ["a stage that is not an identifier", { stage: "", part: 0 }],
        ["`more` on an unstaged set", { more: true }],
        ["`more` that is not `true`", { stage: "stage-1", part: 0, more: 1 }],
      ] as const
    ) {
      it(`returns an \`invalid\` rejection for ${label}`, () => {
        expect(watchSet(fields)).toEqual({
          type: "invalid",
          requestId: "watch-1",
        });
      });
    }
  });
});
