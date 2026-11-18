/**
 * Measures the heap that sessions watching the same documents hold, as the
 * number of sessions grows. One space holds `DOCUMENTS` documents of a few
 * kilobytes each. Each of `N` sessions tracks a graph over all of them, as a
 * memory server's session does for its watch set, and keeps the tracked
 * state alive, as the session does until its watch set changes. The space's
 * document cache is smaller than the corpus, as on a server whose spaces
 * together outgrow its document-cache budget, so a session's walk finds most
 * documents evicted and reads them from storage again. No evaluation cache
 * is passed: sessions' watch sets differ, so a real server seldom serves one
 * session's evaluation to another.
 *
 * The script reports the heap the sessions hold, after collecting garbage,
 * for each `N`, and the cost of one more session.
 *
 * Run from the repository root:
 *
 *   deno run -A --v8-flags=--expose-gc \
 *     runtime/memory/test/v2-shared-documents.profile.ts
 */

import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "../v2/engine.ts";
import { type TrackedGraphState, trackGraph } from "../v2/query.ts";

const DOCUMENTS = 400;
const ITEMS_PER_DOCUMENT = 40;
const SESSIONS = [1, 2, 4, 8, 16, 32];
const SPACE = "did:key:z6Mk-memory-v2-shared-documents-profile";

const collectGarbage = (globalThis as { gc?: () => void }).gc;
if (collectGarbage === undefined) {
  throw new Error("run with --v8-flags=--expose-gc");
}

/**
 * Collects garbage and returns the heap in use. A `WeakRef` target reached
 * in a turn survives that turn whatever holds it, so this crosses one task
 * boundary first.
 */
const collectedHeap = async (): Promise<number> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  collectGarbage();
  collectGarbage();
  return Deno.memoryUsage().heapUsed;
};

const documentId = (index: number) => `of:shared-documents-${index}`;

const documentValue = (index: number) => ({
  title: `document ${index}`,
  items: Array.from({ length: ITEMS_PER_DOCUMENT }, (_, item) => ({
    id: item,
    label: `document ${index} item ${item}`,
    done: item % 2 === 0,
    tags: [`tag-${item % 7}`, `tag-${item % 11}`],
  })),
});

const path = await Deno.makeTempFile({ suffix: ".sqlite" });
const engine = await open({
  url: toFileUrl(path),
  // A tenth of the corpus fits.
  documentCacheBudgetBytes: 64 * 1024,
});
try {
  applyCommit(engine, {
    sessionId: "session:writer",
    principal: "did:key:writer",
    commit: {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: Array.from({ length: DOCUMENTS }, (_, index) => ({
        op: "set" as const,
        id: documentId(index),
        value: { value: documentValue(index) },
      })),
    },
  });
  const query = {
    roots: Array.from({ length: DOCUMENTS }, (_, index) => ({
      id: documentId(index),
      selector: { path: [], schema: false as const },
    })),
  };

  console.log(`${DOCUMENTS} documents, each session tracks all of them`);
  console.log("sessions  held heap (MB)  per session (MB)");
  for (const count of SESSIONS) {
    const before = await collectedHeap();
    let held: TrackedGraphState[] = [];
    for (let session = 0; session < count; session++) {
      held.push(
        trackGraph(SPACE, engine, query, undefined, {
          principal: `did:key:reader-${session}`,
          sessionId: `session:reader-${session}`,
        }).state,
      );
    }
    const after = await collectedHeap();
    if (held.some((state) => state.entities.size !== DOCUMENTS)) {
      throw new Error("a session did not track every document");
    }
    const megabytes = (after - before) / (1024 * 1024);
    console.log(
      `${String(count).padStart(8)}  ${megabytes.toFixed(1).padStart(14)}  ${
        (megabytes / count).toFixed(2).padStart(16)
      }`,
    );
    held = [];
  }
} finally {
  close(engine);
  await Deno.remove(path);
}
