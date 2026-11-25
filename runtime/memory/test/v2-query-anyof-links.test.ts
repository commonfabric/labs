/**
 * What a tracked graph delivers when a document it reaches through a link at
 * an `anyOf` position changes to a value another option of the `anyOf`
 * matches. The walk narrows the options by the value the link resolves to,
 * so the record it keeps for the target has to reach, on a later walk,
 * whatever any option reaches.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";

import type { JSONSchema } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";

import type { URI } from "../interface.ts";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import { refreshTrackedGraph, toDirtyKey, trackGraph } from "../v2/query.ts";

const SPACE = "did:key:z6Mk-memory-v2-query-anyof-links";
const ROOT = "of:root" as URI;
const CHILD = "of:child" as URI;
const GRANDCHILD = "of:grandchild" as URI;

/** A link to the root of document `id`. */
const link = (id: URI): FabricValue => ({
  "/": { "link@1": { id, path: [], space: SPACE } },
});

/** A node is text, or a record that links to another node. */
const schema = {
  $defs: {
    node: {
      anyOf: [
        { type: "string" },
        {
          type: "object",
          properties: { next: { $ref: "#/$defs/node" } },
          required: ["next"],
        },
      ],
    },
  },
  type: "object",
  properties: { child: { $ref: "#/$defs/node" } },
} as const satisfies JSONSchema;

describe("v2-query-anyof-links", () => {
  let engine: Engine;
  let path: string;
  let localSeq: number;

  /** Commits `docs`, each a document's id and the value it takes. */
  const write = (docs: Record<string, FabricValue>): void => {
    localSeq++;
    applyCommit(engine, {
      sessionId: "session:writer",
      invocation: {
        iss: "did:key:alice",
        aud: "did:key:service",
        cmd: "/memory/transact",
        sub: "did:key:space",
        args: { localSeq },
      },
      authorization: { signature: "sig:alice", access: { "proof:1": {} } },
      commit: {
        localSeq,
        reads: { confirmed: [], pending: [] },
        operations: Object.entries(docs).map(([id, value]) => ({
          op: "set" as const,
          id: id as URI,
          value: { value },
        })),
      },
    });
  };

  /** Tracks the graph the root reaches under `schema`. */
  const track = () =>
    trackGraph(SPACE, engine, {
      roots: [{ id: ROOT, selector: { path: [], schema } }],
    });

  /** The ids of the documents `state` tracks, sorted. */
  const trackedIds = (state: ReturnType<typeof track>["state"]): string[] =>
    [
      ...new Set(
        [...state.tracker].map(([key]) => key.slice(key.lastIndexOf("/") + 1)),
      ),
    ].sort();

  /** The ids a refresh delivers after `dirty` changed, sorted. */
  const refreshedIds = (
    state: ReturnType<typeof track>["state"],
    dirty: URI[],
  ): string[] => {
    const refreshed = refreshTrackedGraph(
      SPACE,
      engine,
      state,
      new Set(dirty.map((id) => toDirtyKey(id))),
    );
    return [...refreshed?.updates.values() ?? []].map((entity) => entity.id)
      .sort();
  };

  beforeEach(async () => {
    path = await Deno.makeTempFile({ suffix: ".sqlite" });
    engine = await open({ url: toFileUrl(path) });
    localSeq = 0;
  });

  afterEach(async () => {
    close(engine);
    await Deno.remove(path);
  });

  it("delivers what a linked document reaches once it changes to match another option", () => {
    write({
      [ROOT]: { child: link(CHILD) },
      [CHILD]: "text",
      [GRANDCHILD]: "more text",
    });
    const tracked = track();
    expect(trackedIds(tracked.state)).toEqual([CHILD, ROOT]);

    write({ [CHILD]: { next: link(GRANDCHILD) } });

    expect(refreshedIds(tracked.state, [CHILD])).toEqual([CHILD, GRANDCHILD]);
  });

  it("delivers what a linked document reaches once it exists", () => {
    write({ [ROOT]: { child: link(CHILD) }, [GRANDCHILD]: "more text" });
    const tracked = track();

    write({ [CHILD]: { next: link(GRANDCHILD) } });

    expect(refreshedIds(tracked.state, [CHILD])).toEqual([CHILD, GRANDCHILD]);
  });

  it("stops delivering what a linked document reached once it no longer matches that option", () => {
    write({
      [ROOT]: { child: link(CHILD) },
      [CHILD]: { next: link(GRANDCHILD) },
      [GRANDCHILD]: "more text",
    });
    const tracked = track();
    expect(trackedIds(tracked.state)).toEqual([CHILD, GRANDCHILD, ROOT]);

    write({ [CHILD]: "text" });
    refreshedIds(tracked.state, [CHILD]);
    write({ [GRANDCHILD]: "changed" });

    expect(refreshedIds(tracked.state, [GRANDCHILD])).toEqual([]);
  });
});
