import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import {
  applyCommit,
  applyWaveCommit,
  close,
  type Engine,
  open,
  ProtocolError,
  read,
  selectPendingStreamEventDocs,
} from "../v2/engine.ts";
import { executionLeaseHolder } from "../v2/execution-lease.ts";
import {
  type ClientCommit,
  type Operation,
  resetServerExecutionConfig,
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventEntry,
  type StreamEventsDocValue,
} from "../v2.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const SPACE = "did:key:z6Mk-engine-stream-events-space";
const ALICE = "user:alice";
const SESSION = "sess-1";
const STREAM = { id: "of:engine-stream", path: ["events"] };
const SIDECAR = streamEntriesDocId(STREAM);
const OTHER_STREAM = { id: "of:other-stream", path: [] };
const OTHER_SIDECAR = streamEntriesDocId(OTHER_STREAM);

const entryOf = (
  eventId: string,
  overrides: Partial<StreamEventEntry> = {},
): StreamEventEntry => ({
  eventId,
  stream: STREAM,
  payload: { vote: "green" },
  ...overrides,
});

describe("engine stream sidecar documents", () => {
  let path: string;
  let engine: Engine;
  let holder: string;
  let localSeq: number;

  beforeEach(async () => {
    setServerExecutionConfig(true);
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    holder = executionLeaseHolder(`service:${SPACE}`);
    expect(engine.executionLeases.acquire(SPACE, holder)).toBe(true);
    localSeq = 1;
  });

  afterEach(async () => {
    resetServerExecutionConfig();
    close(engine);
    await Deno.remove(path);
  });

  const authored = (
    operations: Operation[],
    eventIds: string[] = [],
    id = SIDECAR,
  ) =>
    applyCommit(engine, {
      sessionId: SESSION,
      space: SPACE,
      principal: ALICE,
      commit: {
        localSeq: localSeq++,
        reads: { confirmed: [], pending: [] },
        operations,
        eventAppends: eventIds.map((eventId) => ({ id, eventId })),
      } as ClientCommit,
    });

  const derived = (operations: Operation[], eventIds: string[] = []) =>
    applyWaveCommit(engine, {
      sessionId: holder,
      space: SPACE,
      commitClass: "derived",
      holder,
      commit: {
        localSeq: localSeq++,
        reads: { confirmed: [], pending: [] },
        operations,
        ...(eventIds.length === 0 ? {} : {
          eventAppends: eventIds.map((eventId) => ({ id: SIDECAR, eventId })),
        }),
      },
      waveBasis: {
        basisSeq: (engine.statement("selectServerSeq").get() as { seq: number })
          .seq,
        rebasedHeads: [],
      },
    });

  const sidecarValue = (id = SIDECAR): StreamEventsDocValue =>
    (read(engine, { id })?.value ?? {}) as StreamEventsDocValue;

  describe("authored admission", () => {
    it("stamps the entries of a declared whole-array creation with the commit's seq and the envelope's actor, leaving the submitted entry as it was", () => {
      const submitted = entryOf("evt-1");
      const applied = authored([{
        op: "patch",
        id: SIDECAR,
        patches: [{
          op: "add",
          path: "/value/entries",
          value: [submitted] as never,
        }],
      }], ["evt-1"]);

      const [entry] = sidecarValue().entries!;
      expect(entry.eventId).toBe("evt-1");
      expect(entry.seq).toBe(applied.seq);
      expect(entry.firedAt).toEqual({ user: ALICE, session: SESSION });
      expect(submitted).toEqual(entryOf("evt-1"));
    });

    it("throws for an append into the sidecar anywhere but its entries", () => {
      expect(() =>
        authored([{
          op: "patch",
          id: SIDECAR,
          patches: [{
            op: "append",
            path: "/value/notes",
            values: [entryOf("evt-1")] as never[],
          }],
        }], ["evt-1"])
      ).toThrow(
        `authored write into stream doc "${SIDECAR}" at "/value/notes" refused`,
      );
      expect(read(engine, { id: SIDECAR })).toBeNull();
    });

    it("throws for an appended value that is not an entry", () => {
      expect(() =>
        authored([{
          op: "patch",
          id: SIDECAR,
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [7] as never[],
          }],
        }])
      ).toThrow(
        new ProtocolError(
          `stream doc "${SIDECAR}" appended a non-entry value (events.md §1)`,
        ),
      );
      expect(read(engine, { id: SIDECAR })).toBeNull();
    });
  });

  describe("derived writes", () => {
    it("stamps a declared append and applies the other patches of its operation as written", () => {
      authored([{
        op: "patch",
        id: SIDECAR,
        patches: [{
          op: "add",
          path: "/value/entries",
          value: [] as never,
        }],
      }]);

      const applied = derived([{
        op: "patch",
        id: SIDECAR,
        patches: [
          { op: "add", path: "/value/note", value: "kept" as never },
          {
            op: "append",
            path: "/value/entries",
            values: [
              entryOf("evt-2", { firedAt: { user: ALICE, session: SESSION } }),
            ] as never[],
          },
        ],
      }], ["evt-2"]);

      const value = sidecarValue() as StreamEventsDocValue & { note?: string };
      expect(value.note).toBe("kept");
      expect(value.entries?.map((entry) => [entry.eventId, entry.seq]))
        .toEqual([["evt-2", applied.seq]]);
    });

    it("commits a write leaving a sidecar with no value, or with a value that is not an object, and writes it no watermark", () => {
      derived([{ op: "set", id: SIDECAR, value: {} as never }]);
      expect(read(engine, { id: SIDECAR })).toEqual({});

      derived([{ op: "set", id: SIDECAR, value: { value: null } as never }]);
      expect(read(engine, { id: SIDECAR })).toEqual({ value: null });
    });
  });

  describe("selectPendingStreamEventDocs()", () => {
    it("returns the pending entries of every sidecar whose value is an object, skipping one whose value is not", () => {
      authored(
        [{
          op: "patch",
          id: OTHER_SIDECAR,
          patches: [{
            op: "append",
            path: "/value/entries",
            values: [entryOf("evt-3", { stream: OTHER_STREAM })] as never[],
          }],
        }],
        ["evt-3"],
        OTHER_SIDECAR,
      );
      authored([{ op: "set", id: SIDECAR, value: { value: null } as never }]);

      expect(read(engine, { id: SIDECAR })).toEqual({ value: null });
      expect(
        selectPendingStreamEventDocs(engine).map((doc) => [
          doc.id,
          doc.entries.map((entry) => entry.eventId),
        ]),
      ).toEqual([[OTHER_SIDECAR, ["evt-3"]]]);
    });
  });
});
