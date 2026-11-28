/**
 * What a memory server that retires bare-DID labels reports as it opens a
 * store: each document instance whose respelling the store refused, while the
 * others are respelled and the store is served.
 */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { stub } from "@std/testing/mock";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  BARE_DID_RESPELLING,
  isMigrationDone,
} from "../v2/cfc-bare-did-migration.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { resolveSpaceStoreUrl } from "../v2/storage-path.ts";

const SPACE = "did:key:z6MkServerBareDidLabelsFixture";
const schema = { type: "object" } as const;
const schemaHash = internSchemaAsTaggedHashString(schema);

/** A label map whose one entry names `owner` as its confidentiality. */
const labelled = (owner: string | { type: string; subject: string }) => ({
  version: 1,
  schemaHash,
  labelMap: {
    version: 1,
    entries: [{
      path: [],
      origin: "derived",
      observes: "shape",
      label: { confidentiality: [owner] },
    }],
  },
});

/** The label naming the space's owner by bare DID. */
const STALE = labelled(SPACE);

/** `STALE` with the owner named as `User{subject}`. */
const RESPELLED = labelled({ type: CFC_ATOM_TYPE.User, subject: SPACE });

describe("Server", () => {
  let directory: string;
  let store: URL;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "server-bare-did-labels-" });
    store = toFileUrl(`${directory}/`);
  });

  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  describe("instance members", () => {
    describe("engineForSpace()", () => {
      it("reports each document instance whose respelling the store refused, and respells the others", async () => {
        const url = resolveSpaceStoreUrl(
          store,
          SPACE as `did:${string}:${string}`,
        );
        await Deno.mkdir(new URL(".", url), { recursive: true });
        const seeding = await Engine.open({ url });
        Engine.applyCommit(seeding, {
          sessionId: "s:fixture",
          space: SPACE,
          principal: SPACE,
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: `cid:${schemaHash}`, value: { value: schema } },
              ...["of:kept", "of:refused"].map((id) => ({
                op: "set" as const,
                id,
                value: { value: { n: 1 }, cfc: STALE },
              })),
            ],
          },
        });
        seeding.prepare(
          `CREATE TRIGGER refuse_respelling BEFORE INSERT ON revision
           WHEN NEW.id = 'of:refused'
           BEGIN SELECT RAISE(ABORT, 'the store refuses of:refused'); END`,
        ).run();
        Engine.close(seeding);
        using errors = stub(console, "error");
        using _info = stub(console, "info");
        const server = new Server({
          store,
          subscriptionRefreshDelayMs: "manual",
          authorizeSessionOpen: () => undefined,
          sessionOpenAuth: { audience: "did:key:z6MkServerBareDidAudience" },
          retireBareDidLabels: true,
        });
        try {
          const served = await server.engineForSpace(SPACE);

          const cfcOf = (id: string) =>
            (Engine.read(served, { id }) as { cfc?: unknown } | null)?.cfc;
          expect(cfcOf("of:kept")).toEqual(RESPELLED);
          expect(cfcOf("of:refused")).toEqual(STALE);
          expect(isMigrationDone(served, BARE_DID_RESPELLING.name)).toBe(true);
          expect(errors.calls.map(({ args }) => args)).toEqual([[
            "memory v2: could not respell the bare-DID labels of of:refused " +
            `(space) in ${SPACE}: the store refuses of:refused`,
          ]]);
        } finally {
          await server.close();
        }
      });
    });
  });
});
