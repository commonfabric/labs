/**
 * A push refresh of a tracked graph after a commit to a document whose link
 * schema references a schema document the session already holds, for a
 * session already delivered 10, 100, or 1,000 schema documents. The graph
 * tracks a carrier whose links reference every schema document and a tally
 * document whose one link references the first of them; each sample commits
 * a new tally, untimed, and times `refreshTrackedGraph()` over that one
 * dirty document. The tally's schema reference is a root of the refresh's
 * schema-closure walk, which stops at the established schema document, so
 * what the refresh costs beyond the tally's own re-walk is the closure
 * pass: one that re-reads the established closure grows with the schema
 * count and one that stops at it does not.
 *
 * Fixture construction, the commit, and the result check are outside the
 * timed interval. The documents one refresh reads are written to stderr
 * once per fixture, from an untimed refresh.
 */

import { toFileUrl } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { applyCommit, close, type Engine, open } from "../v2/engine.ts";
import {
  refreshTrackedGraph,
  toDirtyKey,
  type TrackedGraphState,
  trackGraph,
} from "../v2/query.ts";

const SPACE = "did:key:z6Mk-memory-v2-refresh-schema-closure-bench";
const IDENTITY = {
  principal: "did:key:refresh-closure-bench",
  sessionId: "session:refresh-closure-bench",
};
const CARRIER = "of:refresh-closure-bench-carrier";
const TALLY = "of:refresh-closure-bench-tally";
const DIRTY = new Set([toDirtyKey(TALLY)]);

interface Fixture {
  schemaCount: number;
  engine: Engine;
  path: string;
  state: TrackedGraphState;
  localSeq: number;

  /** The hash of the schema document the tally's link references. */
  tallySchemaHash: string;
}

const fixtures: Fixture[] = [];

/** A link whose schema references the schema document `hash` names. */
function linkWithSchemaRef(hash: string): FabricValue {
  return {
    "/": {
      "link@1": {
        id: "of:refresh-closure-bench-target",
        path: [],
        schema: { $ref: `cid:${hash}` },
      },
    },
  };
}

/** The tally's value at `votes`: a count, and a link carrying a schema ref. */
function tallyValue(votes: number, schemaHash: string): FabricValue {
  return { votes, link: linkWithSchemaRef(schemaHash) };
}

/** Commits the next tally value, so the next refresh has a change to see. */
function commitTally(fixture: Fixture): void {
  fixture.localSeq += 1;
  applyCommit(fixture.engine, {
    sessionId: IDENTITY.sessionId,
    principal: IDENTITY.principal,
    commit: {
      localSeq: fixture.localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [{
        op: "set",
        id: TALLY,
        value: {
          value: tallyValue(fixture.localSeq, fixture.tallySchemaHash),
        },
      }],
    },
  });
}

/** Runs one refresh over the dirty tally. */
function refresh(fixture: Fixture): ReturnType<typeof refreshTrackedGraph> {
  return refreshTrackedGraph(SPACE, fixture.engine, fixture.state, DIRTY);
}

/**
 * Checks that `refreshed` delivered exactly the tally, and returns the number
 * of documents the refresh read.
 */
function checkRefresh(
  refreshed: ReturnType<typeof refreshTrackedGraph>,
): number {
  if (refreshed === null || refreshed.updates.size !== 1) {
    throw new Error("refresh did not deliver exactly the tally");
  }
  return refreshed.stats.managerReads;
}

async function createFixture(schemaCount: number): Promise<Fixture> {
  const path = await Deno.makeTempFile({
    prefix: "v2-refresh-schema-closure-bench-",
    suffix: ".sqlite",
  });
  const engine = await open({ url: toFileUrl(path) });
  const operations: Parameters<typeof applyCommit>[1]["commit"]["operations"] =
    [];
  const links: Record<string, FabricValue> = {};
  const hashes: string[] = [];
  for (let index = 0; index < schemaCount; index++) {
    const schema = {
      type: "string",
      title: `refresh-closure-${index}`,
    } as const;
    const hash = internSchemaAsTaggedHashString(schema);
    hashes.push(hash);
    operations.push({ op: "set", id: `cid:${hash}`, value: { value: schema } });
    links[`field${index}`] = linkWithSchemaRef(hash);
  }
  const tallySchemaHash = hashes[0];
  operations.push(
    { op: "set", id: CARRIER, value: { value: links } },
    { op: "set", id: TALLY, value: { value: tallyValue(0, tallySchemaHash) } },
  );
  applyCommit(engine, {
    sessionId: IDENTITY.sessionId,
    principal: IDENTITY.principal,
    commit: { localSeq: 1, reads: { confirmed: [], pending: [] }, operations },
  });
  const { state } = trackGraph(
    SPACE,
    engine,
    {
      roots: [
        { id: CARRIER, selector: { path: [], schema: false } },
        { id: TALLY, selector: { path: [], schema: false } },
      ],
    },
    undefined,
    IDENTITY,
  );
  // The carrier, the tally, and every schema document.
  if (state.entities.size !== schemaCount + 2) {
    throw new Error(
      `expected ${schemaCount + 2} delivered documents, got ` +
        `${state.entities.size}`,
    );
  }
  const fixture = {
    schemaCount,
    engine,
    path,
    state,
    localSeq: 1,
    tallySchemaHash,
  };
  commitTally(fixture);
  console.error(
    `refresh-schema-closure: ${schemaCount} schema documents, ` +
      `${checkRefresh(refresh(fixture))} documents read per refresh`,
  );
  return fixture;
}

for (const schemaCount of [10, 100, 1_000]) {
  fixtures.push(await createFixture(schemaCount));
}

globalThis.addEventListener("unload", () => {
  for (const fixture of fixtures) {
    close(fixture.engine);
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        Deno.removeSync(`${fixture.path}${suffix}`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
});

for (const fixture of fixtures) {
  Deno.bench({
    name: `${fixture.schemaCount} schema documents`,
    group:
      "refreshTrackedGraph after a commit referencing an established schema",
    baseline: fixture.schemaCount === 10,
    fn(b) {
      commitTally(fixture);
      b.start();
      const refreshed = refresh(fixture);
      b.end();
      checkRefresh(refreshed);
    },
  });
}
