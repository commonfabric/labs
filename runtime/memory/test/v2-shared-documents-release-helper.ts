/**
 * Helper for `v2-shared-documents.test.ts`, run in a process of its own with
 * `--v8-flags=--expose-gc`. Two sessions track one document in an engine
 * whose document cache retains nothing. The helper prints, as JSON, whether
 * the decoded copy survives a collection while one session still holds it,
 * whether it survives one once neither does, and what reading it again
 * returns.
 */

import { toFileUrl } from "@std/path";

import { applyCommit, close, open } from "../v2/engine.ts";
import { type TrackedGraphState, trackGraph } from "../v2/query.ts";

const collectGarbage = (globalThis as { gc?: () => void }).gc;
if (collectGarbage === undefined) {
  throw new Error("run with --v8-flags=--expose-gc");
}

/**
 * Collects garbage. A `WeakRef` target reached in a turn survives that turn
 * whatever holds it, so this crosses one task boundary first.
 */
const collect = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  collectGarbage();
  collectGarbage();
};

/** A `WeakRef` to `value`, so that the caller holds no strong reference. */
const weakRefTo = (value: unknown): WeakRef<object> => {
  if (typeof value !== "object" || value === null) {
    throw new Error("the session tracked no document");
  }
  return new WeakRef(value);
};

const space = "did:key:z6Mk-memory-v2-shared-documents-release";
const id = "of:shared-release";
const query = {
  roots: [{ id, selector: { path: [], schema: false as const } }],
};
const alice = { principal: "did:key:alice", sessionId: "session:alice" };
const bob = { principal: "did:key:bob", sessionId: "session:bob" };

const path = await Deno.makeTempFile({ suffix: ".sqlite" });
const engine = await open({
  url: toFileUrl(path),
  documentCacheBudgetBytes: 1,
});
try {
  applyCommit(engine, {
    ...alice,
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id, value: { value: { name: "shared" } } }],
    },
  });

  const documentOf = (state: TrackedGraphState): unknown =>
    [...state.entities.values()][0]?.document;
  let forAlice: TrackedGraphState | undefined =
    trackGraph(space, engine, query, undefined, alice).state;
  let forBob: TrackedGraphState | undefined =
    trackGraph(space, engine, query, undefined, bob).state;
  const copy = weakRefTo(documentOf(forAlice));

  forAlice = undefined;
  await collect();
  const whileBobHoldsIt = copy.deref() !== undefined;
  if (forBob === undefined) throw new Error("bob's session was dropped");

  forBob = undefined;
  await collect();
  const onceNobodyHoldsIt = copy.deref() !== undefined;

  const readAgain = documentOf(
    trackGraph(space, engine, query, undefined, alice).state,
  );
  console.log(
    JSON.stringify({ whileBobHoldsIt, onceNobodyHoldsIt, readAgain }),
  );
} finally {
  close(engine);
  await Deno.remove(path);
}
