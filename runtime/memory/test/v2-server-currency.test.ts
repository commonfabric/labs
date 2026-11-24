import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import type { EntityDocument } from "../v2.ts";
import type { CurrencyRecord } from "../v2/currency-index.ts";
import * as Engine from "../v2/engine.ts";
import { Server } from "../v2/server.ts";
import { connectPeer, openSession } from "./support/wire-peer.ts";
import {
  TEST_SESSION_OPEN_PRINCIPAL,
  testSessionOpenServerOptions,
} from "./v2-auth-test-helpers.ts";

const SPACE = "did:key:z6Mk-server-currency";
const EPOCH = "server-currency-build";
const PIECE = "of:piece";
const OUTPUT = "computed:output";
const INPUT = "of:input";

/** A result back-link to the document `id`. */
const link = (id: string) => ({ "/": { "link@1": { id, path: [] } } });

describe("Server", () => {
  let server: Server;
  let engine: Engine.Engine;
  let localSeq: number;

  beforeEach(async () => {
    server = new Server({
      ...testSessionOpenServerOptions,
      store: new URL(`memory://server-currency-${crypto.randomUUID()}`),
      subscriptionRefreshDelayMs: "manual",
    });
    engine = await server.engineForSpace(SPACE);
    localSeq = 0;
  });

  afterEach(async () => {
    await server.close();
  });

  /** Writes `documents` together and returns their commit's sequence. */
  const write = (documents: Record<string, EntityDocument>): number =>
    Engine.applyCommit(engine, {
      space: SPACE,
      sessionId: "currency-writer",
      commit: {
        localSeq: ++localSeq,
        reads: { confirmed: [], pending: [] },
        operations: Object.entries(documents).map(([id, value]) => ({
          op: "set" as const,
          id,
          value,
        })),
      },
    }).seq;

  /** Records a piece that read `INPUT` and vouches for `OUTPUT`. */
  const record = (): CurrencyRecord => ({
    piece: PIECE,
    under: [],
    vouched: true,
    writes: [OUTPUT],
    owned: [],
    slices: [{
      key: "space",
      vouched: true,
      reads: [{ space: SPACE, id: INPUT, scopeKey: "space", derived: false }],
      vouches: [OUTPUT],
    }],
  });

  /** Stores a record after seeding the piece, its input, and its output. */
  const seed = async (): Promise<void> => {
    const asOf = write({
      [PIECE]: { value: {} },
      [INPUT]: { value: 1 },
      [OUTPUT]: { value: "computed", result: link(PIECE) },
    });
    expect(
      await server.storeCurrencyRecords(SPACE, {
        asOf,
        seen: [],
        epoch: EPOCH,
        records: [record()],
      }),
    ).toMatchObject({ marked: [], falseClean: [], blocked: [] });
  };

  describe("instance members", () => {
    describe("judgeCurrencyRoots()", () => {
      it("returns the piece for its result and for a chain of output back-links", async () => {
        await seed();
        write({ "of:outer": { value: 2, result: link(OUTPUT) } });

        expect(
          await server.judgeCurrencyRoots(
            SPACE,
            [PIECE, OUTPUT, "of:outer"],
            { epoch: EPOCH },
          ),
        ).toEqual({
          servable: [
            { root: PIECE, piece: PIECE, origins: [] },
            { root: OUTPUT, piece: PIECE, origins: [] },
            { root: "of:outer", piece: PIECE, origins: [] },
          ],
          held: [],
          upstream: [],
          refused: {},
          marked: [],
        });
      });

      it("counts refusals per requested output when their piece belongs to another build", async () => {
        await seed();

        expect(
          await server.judgeCurrencyRoots(SPACE, [PIECE, OUTPUT], {
            epoch: "another-build",
          }),
        ).toEqual({
          servable: [],
          held: [],
          upstream: [],
          refused: { "other-epoch": 2 },
          marked: [],
        });
      });

      it("advances the index before judging a piece whose input changed", async () => {
        await seed();
        const seq = write({ [INPUT]: { value: 2 } });

        expect(
          await server.judgeCurrencyRoots(SPACE, [OUTPUT], {
            epoch: EPOCH,
          }),
        ).toEqual({
          servable: [],
          held: [],
          upstream: [],
          refused: { marked: 1 },
          marked: [{ piece: PIECE, slice: "space", seq, under: [] }],
        });
        expect(await server.advanceCurrency(SPACE)).toEqual([]);
      });

      it("judges the instances watched by a live session and reports their demand", async () => {
        await seed();
        const peer = await connectPeer(server);
        const { sessionId } = await openSession(peer, SPACE);
        expect(
          (await server.watchSet({
            type: "session.watch.set",
            requestId: "watch-output",
            space: SPACE,
            sessionId,
            watches: [{
              id: "output",
              kind: "graph",
              query: {
                roots: [{ id: OUTPUT, selector: { path: [], schema: false } }],
              },
            }],
          })).error,
        ).toBeUndefined();

        expect(
          await server.judgeCurrencyRoots(SPACE, [OUTPUT], {
            epoch: EPOCH,
            excludePrincipal: "did:key:another-principal",
          }),
        ).toMatchObject({ servable: [{ root: OUTPUT, piece: PIECE }] });
        expect(server.demandSetSizesForSpace(SPACE)).toEqual({
          perSession: [{
            sessionId,
            principal: TEST_SESSION_OPEN_PRINCIPAL,
            tracked: 1,
            watches: 1,
          }],
          unionKeys: 1,
        });
        expect(
          server.hasLiveSessionFor(
            SPACE,
            TEST_SESSION_OPEN_PRINCIPAL,
            sessionId,
          ),
        )
          .toBe(true);
        expect(
          server.hasLiveSessionFor(
            SPACE,
            "did:key:another-principal",
            sessionId,
          ),
        )
          .toBe(false);
        expect(
          server.hasLiveSessionFor(
            SPACE,
            TEST_SESSION_OPEN_PRINCIPAL,
            "absent",
          ),
        )
          .toBe(false);
        expect(server.watchedRootsForSpace(SPACE)).toEqual([{
          id: OUTPUT,
          identity: { principal: TEST_SESSION_OPEN_PRINCIPAL, sessionId },
        }]);

        await server.storeCurrencyRecords(SPACE, {
          asOf: Engine.serverSeq(engine),
          seen: [],
          epoch: EPOCH,
          records: [{
            ...record(),
            slices: [{ key: "space", vouched: true, reads: [], vouches: [] }],
          }],
        });
        expect(
          await server.judgeCurrencyRoots(SPACE, [OUTPUT], {
            epoch: EPOCH,
          }),
        ).toMatchObject({ servable: [], refused: { "unvouched-instance": 1 } });
      });

      it("returns as held a root whose piece read an output of a piece whose input changed, with that read and the piece to start for it", async () => {
        await seed();
        const asOf = write({
          "of:reader": { value: {} },
          "computed:read": { value: "read", result: link("of:reader") },
        });
        await server.storeCurrencyRecords(SPACE, {
          asOf,
          seen: [],
          epoch: EPOCH,
          records: [{
            piece: "of:reader",
            under: [],
            vouched: true,
            writes: ["computed:read"],
            owned: [],
            slices: [{
              key: "space",
              vouched: true,
              reads: [
                { space: SPACE, id: OUTPUT, scopeKey: "space", derived: true },
              ],
              vouches: ["computed:read"],
            }],
          }],
        });
        write({ [INPUT]: { value: 2 } });

        expect(
          await server.judgeCurrencyRoots(SPACE, ["computed:read"], {
            epoch: EPOCH,
          }),
        ).toMatchObject({
          servable: [],
          held: [{
            root: "computed:read",
            piece: "of:reader",
            readers: ["of:reader"],
          }],
          upstream: [{
            reader: "of:reader",
            slice: "space",
            id: OUTPUT,
            scopeKey: "space",
            piece: PIECE,
          }],
          refused: {},
        });
      });

      it("returns what is upstream of a piece the loop says it runs, with no root asked about", async () => {
        await seed();
        const asOf = write({ "of:reader": { value: {} } });
        await server.storeCurrencyRecords(SPACE, {
          asOf,
          seen: [],
          epoch: EPOCH,
          records: [{
            piece: "of:reader",
            under: [],
            vouched: true,
            writes: [],
            owned: [],
            slices: [{
              key: "space",
              vouched: true,
              reads: [
                { space: SPACE, id: OUTPUT, scopeKey: "space", derived: true },
              ],
              vouches: [],
            }],
          }],
        });
        write({ [INPUT]: { value: 2 } });

        expect(
          await server.judgeCurrencyRoots(SPACE, [], {
            epoch: EPOCH,
            running: ["of:reader"],
          }),
        ).toMatchObject({
          servable: [],
          held: [],
          upstream: [{ reader: "of:reader", id: OUTPUT, piece: PIECE }],
        });
      });

      it("returns, with each root that leads to a piece recording a source origin, that piece", async () => {
        const asOf = write({
          [PIECE]: { value: {} },
          [INPUT]: { value: 1 },
          [OUTPUT]: { value: "computed", result: link(PIECE) },
        });
        await server.storeCurrencyRecords(SPACE, {
          asOf,
          seen: [],
          epoch: EPOCH,
          records: [{ ...record(), followsOrigin: true }],
        });

        const { servable } = await server.judgeCurrencyRoots(
          SPACE,
          [PIECE, OUTPUT],
          { epoch: EPOCH },
        );

        expect(servable).toEqual([
          { root: PIECE, piece: PIECE, origins: [PIECE] },
          { root: OUTPUT, piece: PIECE, origins: [PIECE] },
        ]);
      });

      it("returns the piece for an output one record writes that the space holds no instance of", async () => {
        // A derived document that exists only at instances narrower than the
        // space has no back-link to read at the `space` instance.

        const asOf = write({ [PIECE]: { value: {} }, [INPUT]: { value: 1 } });
        await server.storeCurrencyRecords(SPACE, {
          asOf,
          seen: [],
          epoch: EPOCH,
          records: [{ ...record(), writes: [OUTPUT, "computed:per-user"] }],
        });

        expect(
          await server.judgeCurrencyRoots(SPACE, ["computed:per-user"], {
            epoch: EPOCH,
          }),
        ).toEqual({
          servable: [{
            root: "computed:per-user",
            piece: PIECE,
            origins: [],
          }],
          held: [],
          upstream: [],
          refused: {},
          marked: [],
        });
      });

      it("returns no result for missing records, invalid back-links, or a cycle", async () => {
        write({
          "of:plain": { value: 1 },
          "of:invalid": { value: 2, result: link("of:missing") },
          "of:cycle": { value: 3, result: link("of:cycle") },
        });

        expect(
          await server.judgeCurrencyRoots(
            SPACE,
            ["of:missing", "of:plain", "of:invalid", "of:cycle"],
            { epoch: EPOCH },
          ),
        ).toEqual({
          servable: [],
          held: [],
          upstream: [],
          refused: { "no-record": 4 },
          marked: [],
        });
      });

      it("returns the earliest time a slice expires at, and marks that slice once the time has come", async () => {
        let now = 1_700_000_000_000;
        using _clock = stub(Date, "now", () => now);
        const asOf = write({
          [PIECE]: { value: {} },
          [INPUT]: { value: 1 },
          [OUTPUT]: { value: "computed", result: link(PIECE) },
        });
        const expiring = record();
        await server.storeCurrencyRecords(SPACE, {
          asOf,
          seen: [],
          epoch: EPOCH,
          records: [{
            ...expiring,
            slices: [{ ...expiring.slices[0], expiresAt: 1_700_000_060_000 }],
          }],
        });
        expect(
          await server.judgeCurrencyRoots(SPACE, [PIECE], { epoch: EPOCH }),
        ).toEqual({
          servable: [{ root: PIECE, piece: PIECE, origins: [] }],
          held: [],
          upstream: [],
          refused: {},
          marked: [],
          nextExpiry: 1_700_000_060_000,
        });
        now = 1_700_000_060_000;

        expect(
          await server.judgeCurrencyRoots(SPACE, [PIECE], { epoch: EPOCH }),
        ).toEqual({
          servable: [],
          held: [],
          upstream: [],
          refused: { marked: 1 },
          marked: [{ piece: PIECE, slice: "space", seq: asOf + 1, under: [] }],
        });
      });

      it("advances the index even when no root was requested", async () => {
        await seed();
        const seq = write({ [INPUT]: { value: 2 } });

        expect(await server.judgeCurrencyRoots(SPACE, [], { epoch: EPOCH }))
          .toEqual({
            servable: [],
            held: [],
            upstream: [],
            refused: {},
            marked: [{ piece: PIECE, slice: "space", seq, under: [] }],
          });
      });
    });
  });
});
