import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  appendLineToFile,
  createFrameLog,
  frameLogEnabled,
  frameLogFromEnvironment,
  logIncomingFrame,
  logOutgoingFrame,
  readEnvironmentVariable,
} from "./frame-log.ts";

describe("frame log", () => {
  const collect = () => {
    const lines: Record<string, unknown>[] = [];
    const log = createFrameLog((line) => lines.push(JSON.parse(line)));
    return { lines, log };
  };

  it("records a watch mutation's roots with each distinct selector written once", () => {
    const { lines, log } = collect();
    const selector = { path: [], schema: { type: "string" } };
    log.logOutgoing({
      type: "session.watch.add",
      requestId: "req:1",
      watches: [
        {
          id: "w1",
          kind: "graph",
          query: { roots: [{ id: "of:a", scope: "space", selector }] },
        },
        {
          id: "w2",
          kind: "graph",
          query: { roots: [{ id: "of:b", scope: "space", selector }] },
        },
      ],
    }, 120);
    const selectors = lines.filter((line) => line.dir === "selector");
    expect(selectors.length).toBe(1);
    const frame = lines.find((line) => line.dir === "out")!;
    expect(frame.type).toBe("session.watch.add");
    expect(frame.bytes).toBe(120);
    const watches = frame.watches as { roots: { selector: string }[] }[];
    expect(watches[0].roots[0].selector).toBe(selectors[0].hash);
    expect(watches[1].roots[0].selector).toBe(selectors[0].hash);
  });

  it("summarizes a commit's read set, counting reads that assert absence", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:2",
      commit: {
        localSeq: 3,
        operations: [{ id: "of:a", scope: "space", op: "set", value: {} }],
        reads: {
          confirmed: [
            { id: "of:a", path: ["value"], seq: 5 },
            { id: "of:b", path: ["value", "x"], seq: 0 },
            { id: "computed:c", path: ["value"], seq: 0 },
          ],
          pending: [],
        },
      },
    }, 400);
    const commit = lines[0].commit as Record<string, unknown>;
    expect(commit.confirmedReads).toBe(3);
    expect(commit.confirmedReadsAtSeqZero).toBe(2);
    expect(commit.confirmedReadIdsAtSeqZero).toEqual(["of:b", "computed:c"]);
    const reads = commit.reads as Record<string, unknown>;
    expect(reads.distinctDocs).toBe(3);
    expect(reads.byKind).toEqual({ of: 2, computed: 1 });
    expect(reads.byDepth).toEqual({ "1": 2, "2": 1 });
  });

  it("lists the documents a response delivered with their size and keys", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:1",
      ok: {
        serverSeq: 9,
        sync: {
          type: "sync",
          fromSeq: 0,
          toSeq: 9,
          upserts: [
            { id: "of:a", seq: 4, doc: { value: { title: "t", body: "b" } } },
            { id: "of:s", seq: 4, doc: { value: "plain" } },
          ],
          removes: [],
        },
      },
    }, 900);
    const frame = lines[0];
    expect(frame.dir).toBe("in");
    expect(frame.serverSeq).toBe(9);
    const sync = frame.sync as { upserts: Record<string, unknown>[] };
    expect(sync.upserts[0].keys).toEqual(["title", "body"]);
    expect(sync.upserts[1].keys).toBe("string");
    expect(sync.upserts[0].bytes).toBeGreaterThan(0);
  });

  it("records a pushed effect under its effect type", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "session/effect",
      space: "did:key:x",
      sessionId: "s",
      effect: { type: "sync", fromSeq: 1, toSeq: 2, upserts: [], removes: [] },
    }, 50);
    expect(lines[0].effectType).toBe("sync");
    expect((lines[0].sync as { upserts: unknown[] }).upserts).toEqual([]);
  });
});

describe("frame log against what the wire actually carries", () => {
  const collect = () => {
    const lines: Record<string, unknown>[] = [];
    const log = createFrameLog((line) => lines.push(JSON.parse(line)));
    return { lines, log };
  };

  it("records each commit operation's kind under op", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:3",
      commit: {
        localSeq: 1,
        operations: [
          { op: "set", id: "of:a", scope: "space", value: { value: 1 } },
          { op: "delete", id: "of:b", scope: "space" },
        ],
        reads: { confirmed: [], pending: [] },
      },
    }, 10);
    const ops = (lines[0].commit as { operations: { op: string }[] })
      .operations;
    expect(ops.map((entry) => entry.op)).toEqual(["set", "delete"]);
  });

  it("never lets a value JSON cannot write stop the frame", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:4",
      commit: {
        localSeq: 1,
        operations: [{ op: "set", id: "of:a", value: { value: 1n } }],
        reads: { confirmed: [], pending: [] },
      },
    }, 10);
    const ops = (lines[0].commit as { operations: { bytes?: number }[] })
      .operations;
    expect(ops[0].bytes).toBeUndefined();
    log.logIncoming({
      type: "response",
      requestId: "req:4",
      ok: {
        sync: {
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          upserts: [{ id: "of:a", seq: 1, doc: { value: { n: 2n } } }],
          removes: [],
        },
      },
    }, 10);
    const upserts = (lines[1].sync as { upserts: { bytes?: number }[] })
      .upserts;
    expect(upserts[0].bytes).toBeUndefined();
    expect(lines.length).toBe(2);
  });

  it("sizes a document in UTF-8 bytes, not UTF-16 units", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:5",
      ok: {
        sync: {
          type: "sync",
          fromSeq: 0,
          toSeq: 1,
          upserts: [{ id: "of:a", seq: 1, doc: { value: "é" } }],
          removes: [],
        },
      },
    }, 10);
    const upserts = (lines[0].sync as { upserts: { bytes: number }[] })
      .upserts;
    // `{"value":"é"}` is 13 UTF-16 units and 14 UTF-8 bytes.
    expect(upserts[0].bytes).toBe(14);
  });

  it("summarizes the entities a graph.query response returns", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:6",
      ok: {
        serverSeq: 3,
        entities: [
          { branch: "", id: "of:a", seq: 3, document: { value: { x: 1 } } },
          { branch: "", id: "of:gone", seq: 0, document: null },
        ],
      },
    }, 10);
    const entities = lines[0].entities as Record<string, unknown>[];
    expect(entities[0].keys).toEqual(["x"]);
    expect(entities[0].bytes).toBeGreaterThan(0);
    expect(entities[1].absent).toBe(true);
  });

  it("carries a response's error", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:7",
      error: { name: "ConflictError", message: "stale" },
    }, 10);
    expect((lines[0].error as { name: string }).name).toBe("ConflictError");
  });

  it("reports a summary it could not build without dropping the frame", () => {
    const { lines, log } = collect();
    const hostile = {
      type: "transact",
      requestId: "req:8",
      get commit(): never {
        throw new Error("no commit for you");
      },
    };
    log.logOutgoing(hostile, 10);
    expect(lines[0].dir).toBe("error");
    expect(lines[0].message).toBe("no commit for you");
  });
});

describe("frame log from the environment", () => {
  it("is absent when the variable is unset or empty", () => {
    expect(frameLogFromEnvironment(() => undefined, () => {})).toBeUndefined();
    expect(frameLogFromEnvironment(() => "", () => {})).toBeUndefined();
  });

  it("is absent when the environment cannot be read", () => {
    expect(
      frameLogFromEnvironment(() => {
        throw new Error("no env permission");
      }, () => {}),
    ).toBeUndefined();
  });

  it("appends lines to the named file", () => {
    const written: { path: string; line: string }[] = [];
    const log = frameLogFromEnvironment(
      (name: string) =>
        name === "CF_MEMORY_FRAME_LOG" ? "/tmp/frames.jsonl" : undefined,
      (path: string, line: string) => written.push({ path, line }),
    );
    log!.logOutgoing({ type: "session.ack", requestId: "req:9" }, 5);
    expect(written.length).toBe(1);
    expect(written[0].path).toBe("/tmp/frames.jsonl");
    expect(JSON.parse(written[0].line).type).toBe("session.ack");
  });
});

describe("frame log document identity", () => {
  const collect = () => {
    const lines: Record<string, unknown>[] = [];
    const log = createFrameLog((line) => lines.push(JSON.parse(line)));
    return { lines, log };
  };

  it("keeps a document's scope, branch and instance on its record", () => {
    const { lines, log } = collect();
    log.logIncoming({
      type: "response",
      requestId: "req:10",
      ok: {
        sync: {
          type: "sync",
          fromSeq: 0,
          toSeq: 2,
          upserts: [
            {
              branch: "",
              id: "of:a",
              scope: "space",
              seq: 1,
              doc: { value: 1 },
            },
            {
              branch: "b",
              id: "of:a",
              scope: "user",
              scopeKey: "k",
              seq: 2,
              doc: { value: 2 },
            },
          ],
          removes: [],
        },
      },
    }, 10);
    const upserts = (lines[0].sync as { upserts: Record<string, unknown>[] })
      .upserts;
    expect(upserts[0]).toMatchObject({
      id: "of:a",
      scope: "space",
      branch: "",
    });
    expect(upserts[1]).toMatchObject({
      id: "of:a",
      scope: "user",
      branch: "b",
      scopeKey: "k",
    });
  });

  it("counts reads of one id in two scopes as two documents", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:11",
      commit: {
        localSeq: 1,
        operations: [],
        reads: {
          confirmed: [
            { id: "of:a", scope: "space", path: ["value"], seq: 1 },
            { id: "of:a", scope: "user", path: ["value"], seq: 1 },
            { id: "of:a", scope: "user", path: ["value", "x"], seq: 1 },
          ],
          pending: [],
        },
      },
    }, 10);
    const reads = (lines[0].commit as { reads: Record<string, unknown> }).reads;
    expect(reads.distinctDocs).toBe(2);
    expect(reads.topDocs).toEqual([["of:a", 2], ["of:a", 1]]);
    expect(reads.topDocPaths).toEqual(["value", "value/x"]);
  });

  it("names two different selectors by two different references", () => {
    const { lines, log } = collect();
    const root = (selector: unknown) => ({
      id: "w",
      kind: "graph",
      query: { roots: [{ id: "of:a", scope: "space", selector }] },
    });
    log.logOutgoing({
      type: "session.watch.add",
      requestId: "req:12",
      watches: [
        root({ path: [], schema: false }),
        root({ path: [], schema: true }),
      ],
    }, 10);
    const selectors = lines.filter((line) => line.dir === "selector");
    expect(selectors.length).toBe(2);
    expect(selectors[0].hash).not.toBe(selectors[1].hash);
  });

  it("sizes a selector in UTF-8 bytes", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "session.watch.add",
      requestId: "req:13",
      watches: [{
        id: "w",
        kind: "graph",
        query: {
          roots: [{ id: "of:a", scope: "space", selector: { path: ["é"] } }],
        },
      }],
    }, 10);
    const selector = lines.find((line) => line.dir === "selector")!;
    // `{"path":["é"]}` is 14 UTF-16 units and 15 UTF-8 bytes.
    expect(selector.bytes).toBe(15);
  });
});

describe("frame log default scope", () => {
  it("reads a record without a scope as the space scope", () => {
    const lines: Record<string, unknown>[] = [];
    const log = createFrameLog((line) => lines.push(JSON.parse(line)));
    log.logOutgoing({
      type: "transact",
      requestId: "req:14",
      commit: {
        localSeq: 1,
        operations: [],
        reads: {
          confirmed: [
            { id: "of:a", path: ["value"], seq: 1 },
            { id: "of:a", scope: "space", path: ["value", "x"], seq: 1 },
          ],
          pending: [],
        },
      },
    }, 10);
    const reads = (lines[0].commit as { reads: Record<string, unknown> }).reads;
    expect(reads.distinctDocs).toBe(1);
  });
});

describe("frame log edges", () => {
  const collect = () => {
    const lines: Record<string, unknown>[] = [];
    const log = createFrameLog((line) => lines.push(JSON.parse(line)));
    return { lines, log };
  };

  it("records a graph.query with its roots and a response with a seq", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "graph.query",
      requestId: "req:15",
      query: {
        roots: [{ id: "of:a", scope: "space", selector: { path: [] } }],
      },
    }, 10);
    const query = lines.find((line) => line.dir === "out")!.query as {
      roots: unknown[];
    }[];
    expect(query[0].roots.length).toBe(1);
    log.logIncoming(
      { type: "response", requestId: "req:16", ok: { seq: 7 } },
      5,
    );
    expect(lines.at(-1)!.seq).toBe(7);
  });

  it("tolerates frames whose parts are missing or not what their type says", () => {
    const { lines, log } = collect();
    log.logOutgoing({ type: "transact", requestId: "req:17" }, 5);
    expect(lines[0].commit).toBeUndefined();
    log.logOutgoing({ type: "session.watch.add", requestId: "req:18" }, 5);
    expect(lines[1].watches).toBeUndefined();
    log.logIncoming({
      type: "response",
      requestId: "req:19",
      ok: { sync: { type: "other" }, entities: "none" },
    }, 5);
    expect(lines[2].sync).toBeUndefined();
    expect(lines[2].entities).toBeUndefined();
  });

  it("caps the paths recorded for the most-read document at sixty", () => {
    const { lines, log } = collect();
    const confirmed = Array.from({ length: 70 }, (_, i) => ({
      id: "of:a",
      path: ["value", `k${i}`],
      seq: 1,
    }));
    log.logOutgoing({
      type: "transact",
      requestId: "req:20",
      commit: {
        localSeq: 1,
        operations: [],
        reads: { confirmed, pending: [] },
      },
    }, 5);
    const reads = (lines[0].commit as { reads: { topDocPaths: string[] } })
      .reads;
    expect(reads.topDocPaths.length).toBe(60);
  });

  it("keeps two selectors apart when their hashes collide", () => {
    // Two selector texts with the same FNV-1a hash, found by search.
    const { lines, log } = collect();
    const root = (key: string) => ({
      id: "w",
      kind: "graph",
      query: {
        roots: [{
          id: "of:a",
          scope: "space",
          selector: { path: [key], schema: { type: "string" } },
        }],
      },
    });
    log.logOutgoing({
      type: "session.watch.add",
      requestId: "req:21",
      watches: [root("k132789"), root("k729192")],
    }, 5);
    const selectors = lines.filter((line) => line.dir === "selector");
    expect(selectors.length).toBe(2);
    expect(selectors[1].hash).toBe(`${selectors[0].hash}-1`);
    const watches = lines.find((line) => line.dir === "out")!.watches as {
      roots: { selector: string }[];
    }[];
    expect(watches[0].roots[0].selector).toBe(selectors[0].hash);
    expect(watches[1].roots[0].selector).toBe(selectors[1].hash);
  });

  it("reports a non-Error failure and survives a writer that throws", () => {
    const { lines, log } = collect();
    log.logOutgoing({
      type: "transact",
      requestId: "req:22",
      get commit(): never {
        throw "plain string";
      },
    }, 5);
    expect(lines[0].message).toBe("plain string");
    const throwing = createFrameLog(() => {
      throw new Error("disk full");
    });
    throwing.logOutgoing({ type: "session.ack", requestId: "req:23" }, 5);
  });

  it("exposes no-op process-level entry points when the variable is unset", () => {
    expect(frameLogEnabled).toBe(false);
    logOutgoingFrame({ type: "session.ack", requestId: "req:24" }, 5);
    logIncomingFrame({ type: "response", requestId: "req:24" }, 5);
    expect(readEnvironmentVariable("CF_MEMORY_FRAME_LOG_NOT_SET")).toBe(
      undefined,
    );
  });

  it("appends lines to a file", async () => {
    const path = await Deno.makeTempFile({ suffix: ".jsonl" });
    try {
      appendLineToFile(path, "{}");
      appendLineToFile(path, "{}");
      expect(await Deno.readTextFile(path)).toBe("{}\n{}\n");
    } finally {
      await Deno.remove(path);
    }
  });
});
