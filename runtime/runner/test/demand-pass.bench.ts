/**
 * Measures the demand read a serving loop's demand pass makes of the memory
 * server, and the fold of that read into its `DemandMirror`, for one client
 * session whose schema-followed watch reaches 1,000, 5,000, and 20,000
 * documents.
 *
 * `unchanged` is a pass with no demand written since the one before it: the
 * server hands back the share it kept and the mirror finds it is the one it
 * holds. `one watch added` is a pass after the session added one watch: the
 * server rebuilds the session's share, and the mirror, holding the share from
 * before that watch, folds the rebuilt one in and finds one key changed.
 * Fixture construction, the watch evaluation that builds the session's
 * tracked set, and returning the mirror to the earlier share after each
 * iteration stay outside timing.
 */

import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";

import { DemandMirror } from "../src/executor/demand-mirror.ts";

const space = "did:key:z6Mk-demand-pass-bench";
const principal = "did:key:z6Mk-demand-pass-bench-reader";
const service = "did:key:z6Mk-demand-pass-bench-service";

const link = (id: string): FabricValue => ({
  "/": { "link@1": { id, path: [] } },
});

const follow = (id: string) => ({
  id,
  kind: "graph" as const,
  query: { roots: [{ id, selector: { path: [], schema: true as const } }] },
});

/**
 * A memory server with one session watching a root document that links to
 * `size` leaves and one more document, the session's state, and its share of
 * the demand set from before that one more watch.
 */
async function fixture(size: number) {
  const server = new Server({
    store: new URL(`memory://demand-pass-bench-${size}`),
    subscriptionRefreshDelayMs: "manual",
    authorizeSessionOpen: () => principal,
    sessionOpenAuth: { audience: "did:key:z6Mk-demand-pass-bench-audience" },
  });
  const client = await connect({ transport: loopback(server) });
  const session = await client.mount(
    space,
    {},
    (_space, _options, context) => ({
      invocation: { aud: context.audience, challenge: context.challenge.value },
      authorization: {},
    }),
  );
  const leaves = Array.from({ length: size }, (_, index) => `of:leaf-${index}`);
  await session.transact({
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [
      ...leaves.map((id) => ({
        op: "set" as const,
        id,
        value: { value: { id } },
      })),
      { op: "set", id: "of:extra", value: { value: { extra: true } } },
      {
        op: "set",
        id: "of:root",
        value: { value: { items: leaves.map(link) } },
      },
    ],
  });
  await session.watchSet([follow("of:root")]);
  const without = server.demandForSpace(space, { excludePrincipal: service });
  await session.watchAdd([follow("of:extra")]);
  const withExtra = server.demandForSpace(space, {
    excludePrincipal: service,
  });
  const [state] = server.accessForTestingOnly.sessionsForSpace(space);
  expect(without[0].rows.size).toBe(size + 1);
  expect(withExtra[0].rows.size).toBe(size + 2);
  return { server, state, without };
}

for (const size of [1_000, 5_000, 20_000]) {
  const { server, state, without } = await fixture(size);

  const unchanged = new DemandMirror();
  unchanged.update(server.demandForSpace(space, { excludePrincipal: service }));
  Deno.bench({
    name: `${size} instances, unchanged`,
    group: "demand pass read",
    fn() {
      // A read of this kind takes well under the ten microseconds `deno bench`
      // needs to honor a bracket, so the body is timed whole; the check it
      // holds is one comparison.

      const changed = unchanged.update(
        server.demandForSpace(space, { excludePrincipal: service }),
      );
      expect(changed.size).toBe(0);
    },
  });

  const beforeWatch = new DemandMirror();
  beforeWatch.update(without);
  Deno.bench({
    name: `${size} instances, one watch added`,
    group: "demand pass read",
    fn(b) {
      b.start();
      const rebuilt = server.accessForTestingOnly.buildSessionDemand(state);
      const changed = beforeWatch.update([rebuilt]);
      b.end();
      expect(rebuilt.rows.size).toBe(size + 2);
      expect(changed.size).toBe(1);
      expect(beforeWatch.update(without).size).toBe(1);
    },
  });
}
