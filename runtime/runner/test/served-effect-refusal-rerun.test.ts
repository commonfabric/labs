/**
 * Exercises what a served effect node does once CFC refuses its request: a
 * `fetchText`, `fetchJson` or `generateText` node whose request the sink
 * ceiling refuses ends with the refusal as its error, in the requesting
 * principal's instance, and runs again only when what it read changes. A
 * `fetchText` whose request goes out is the comparison: it issues one request
 * and keeps its result.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import type { Cell } from "../src/cell.ts";
import { addCfcDenialListener } from "../src/cfc/denial-report.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("served effect rerun");
const service = await Identity.fromPassphrase("served effect rerun service");
const alice = await Identity.fromPassphrase("served effect rerun alice");
const owner = await Identity.fromPassphrase("served effect rerun owner");
const space = spaceSigner.did() as MemorySpace;
const ownerSpace = owner.did() as MemorySpace;
const url = "https://example.test/served-effect-rerun";

/** A builtin the case drives, and how a pattern calls it. */
type Builtin = {
  /** The builtin's name, which is also the sink its ceiling names. */
  name: "fetchText" | "fetchJson" | "generateText";

  /** The call, over the pattern's `url` and `tag` inputs. */
  call: string;
};

const fetchText: Builtin = {
  name: "fetchText",
  call: `fetchText({ url, options: { headers: { "x-tag": tag } } })`,
};

const refusable: readonly Builtin[] = [
  fetchText,
  {
    name: "fetchJson",
    call:
      `fetchJson<{ answer: string }>({ url, options: { headers: { "x-tag": tag } } })`,
  },
  { name: "generateText", call: `generateText({ prompt: url, system: tag })` },
];

/**
 * How many times the case lets the node's request go out, or be refused,
 * before it calls the node a loop: a few re-runs from the replica settling,
 * and no more.
 */
const RUN_BOUND = 20;

/** An effect node's public state. */
type NodeView = { pending?: boolean; result?: unknown; error?: unknown };

/** What one case observed once the serving runtime settled. */
type Observed = {
  /** How many times the node's request went out, or was refused. */
  runs: number;

  /** The node's state as the serving runtime sees it for the requester. */
  servingView: NodeView | undefined;

  /** The node's state as a fresh client of the requester reads it. */
  storedView: NodeView | undefined;

  /** The node's `error` in the server's store, in the requester's instance. */
  storedError: unknown;

  /**
   * The node's `error` in the server's store, in the service's instance of a
   * scoped node: where the ending would land without the requester's
   * identity. `undefined` for a space-scoped node, which has one instance.
   */
  serviceInstanceError: unknown;

  /** How many transactions the serving loop refused to seal as unstamped. */
  unstampedSealRefusals: number;
};

/**
 * Runs Alice's node calling `builtin` through a serving runtime and reports
 * what it did. With `refused`, the URL comes through a link to a document
 * labeled `medical`, and the serving runtime's ceiling for the builtin's sink
 * admits no confidentiality, so the served node's request is refused before it
 * starts.
 * The run ends on whichever comes first: every serving runtime settling, or
 * the node's request going out or being refused more than `RUN_BOUND` times.
 * A node that runs again without end never lets the runtime settle, so the
 * count is what ends the case then.
 */
async function runNode(
  { builtin, scope, refused }: {
    builtin: Builtin;
    scope: "space" | "user";
    refused: boolean;
  },
): Promise<Observed> {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const originalFetch = globalThis.fetch;
  const managers: EmulatedStorageManager[] = [];
  const runtimes: Runtime[] = [];
  const servingRuntimes: Runtime[] = [];
  let host: ExecutorHost | undefined;
  let runs = 0;
  const firstRun = Promise.withResolvers<void>();
  const overBound = Promise.withResolvers<void>();
  const counted = () => {
    runs += 1;
    firstRun.resolve();
    if (runs > RUN_BOUND) overBound.resolve();
  };
  const stopListening = addCfcDenialListener((denial) => {
    const reasons = (denial.inputs.reasons ?? []) as readonly string[];
    if (
      reasons.some((reason) =>
        reason.includes(`exceeds ceiling for ${builtin.name}`)
      )
    ) counted();
  });
  try {
    globalThis.fetch = (input, init) => {
      const requestedUrl = input instanceof Request ? input.url : String(input);
      if (!requestedUrl.startsWith(url)) return originalFetch(input, init);
      counted();
      return Promise.resolve(new Response("the response"));
    };

    /** Opens a client runtime authenticated as `signer`. */
    const openClient = (signer: typeof alice) => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      managers.push(manager);
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      runtimes.push(runtime);
      return runtime;
    };

    let input: unknown = url;
    if (refused) {
      const ownerRuntime = openClient(owner);
      const labeled = ownerRuntime.getCell<{ url: string }>(
        ownerSpace,
        "served-effect-rerun-source",
      );
      const seed = ownerRuntime.edit();
      writeSeedEnvelopeDoc(seed, ownerSpace);
      seedStoredEnvelope(seed, {
        space: ownerSpace,
        scope: "space",
        id: labeled.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value: { url: `${url}?labeled` },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["url"],
              label: { confidentiality: ["medical"] },
            }],
          },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      input = { ...labeled.getAsNormalizedFullLink(), path: ["url"] };
    }

    host = new ExecutorHost({
      server,
      serviceIdentity: service.did(),
      // The execution host owns an asynchronous factory contract.
      // deno-lint-ignore require-await
      createRuntime: async () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: service,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
          ...(refused
            ? { cfcSinkMaxConfidentiality: { [builtin.name]: [] } }
            : {}),
        });
        servingRuntimes.push(runtime);
        return {
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
    });

    const client = openClient(alice);
    // The node reads `tag` beside its URL, so `tag`'s scope is the node's:
    // a `PerUser` one gives each user an instance of the node's cells.
    const tagType = scope === "user"
      ? "PerUser<Writable<string>>"
      : "Writable<string>";
    const pattern = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { ${builtin.name}, pattern, PerUser, Writable } from "commonfabric";
export default pattern<
  { url: Writable<string>; tag: ${tagType} },
  { fetched: any }
>(({ url, tag }) => ({
  fetched: ${builtin.call},
}));
`,
      }],
    }, { space });
    const argument = client.getCell<{ url: string; tag: string }>(
      space,
      "served-effect-rerun-input",
      pattern.argumentSchema,
    );
    const result = client.getCell<{ fetched: NodeView }>(
      space,
      "served-effect-rerun-result",
      pattern.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const start = client.edit();
    argument.withTx(start).key("url").set(
      (refused ? client.getCellFromLink(input as never) : input) as never,
    );
    argument.withTx(start).key("tag").set("alice's tag");
    client.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    const cancel = result.sink(() => {});
    try {
      await firstRun.promise;
      await Promise.race([
        overBound.promise,
        Promise.all(servingRuntimes.map((runtime) => runtime.settled())),
      ]);

      const requester = client.scopeKeyIdentity;
      const fetched = result.key("fetched");
      const servingView = viewAs(
        servingRuntimes[0],
        fetched,
        scope === "user" ? requester : undefined,
      );

      const fresh = openClient(alice);
      const freshFetched = fresh.getCellFromLink<NodeView>(
        fetched.getAsNormalizedFullLink(),
      );
      await freshFetched.sync();
      const errorCell = freshFetched.key("error").resolveAsCell();
      await errorCell.sync();
      const storedView = snapshot(freshFetched.get());
      const errorLink = errorCell.getAsNormalizedFullLink();
      const engine = await server.engineForSpace(space);
      const storedError = storedValue(engine, errorLink, scope, requester);
      const serviceInstanceError = scope === "user"
        ? storedValue(engine, errorLink, scope, {
          principal: service.did(),
          sessionId: requester.sessionId,
        })
        : undefined;
      return {
        runs,
        servingView,
        storedView,
        storedError,
        serviceInstanceError,
        unstampedSealRefusals: host.stats().unstampedSealRefusals,
      };
    } finally {
      cancel();
    }
  } finally {
    stopListening();
    globalThis.fetch = originalFetch;
    await host?.close();
    for (const runtime of runtimes) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers) await manager.close();
    await server.close();
  }
}

/**
 * Reads `cell` through `runtime`'s replica, in the instance `identity` names
 * when there is one, the way a run carrying that identity reads it.
 */
function viewAs(
  runtime: Runtime,
  cell: Cell<NodeView>,
  identity: ScopeKeyIdentity | undefined,
): NodeView | undefined {
  const tx = runtime.edit();
  try {
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    return snapshot(
      runtime.getCellFromLink<NodeView>(cell.getAsNormalizedFullLink())
        .withTx(tx).get(),
    );
  } finally {
    tx.abort();
  }
}

/**
 * A plain copy of a view, taken while the transaction it reads through is
 * still open.
 */
function snapshot(view: NodeView | undefined): NodeView | undefined {
  return view === undefined ? undefined : JSON.parse(JSON.stringify(view));
}

/** The value the server's store holds at `link` in one instance. */
function storedValue(
  engine: Engine.Engine,
  link: { id: string; path: readonly string[] },
  scope: "space" | "user",
  identity: ScopeKeyIdentity,
): unknown {
  const document = Engine.read(engine, {
    id: link.id as never,
    ...(scope === "user"
      ? { scope, principal: identity.principal, sessionId: identity.sessionId }
      : {}),
  });
  return link.path.reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key],
    document?.value,
  );
}

describe("served-effect-refusal-rerun", () => {
  for (const builtin of refusable) {
    for (const scope of ["space", "user"] as const) {
      it(`ends a ${scope}-scoped served ${builtin.name} whose request the sink ceiling refuses, without running it again`, async () => {
        const observed = await runNode({ builtin, scope, refused: true });
        expect(observed.runs).toBeLessThanOrEqual(RUN_BOUND);
        const message = `${builtin.name} request was refused before it started`;
        const ending = { pending: false, error: message };
        expect(observed.servingView).toMatchObject(ending);
        expect(observed.storedView).toMatchObject(ending);
        expect(observed.storedError).toBe(message);
        expect(observed.serviceInstanceError).toBeUndefined();
        expect(observed.unstampedSealRefusals).toBe(0);
      });
    }
  }

  for (const scope of ["space", "user"] as const) {
    it(`issues a ${scope}-scoped served fetchText's request once and keeps its result`, async () => {
      const observed = await runNode({
        builtin: fetchText,
        scope,
        refused: false,
      });
      expect(observed.runs).toBe(1);
      const answer = { pending: false, result: "the response" };
      expect(observed.servingView).toMatchObject(answer);
      expect(observed.storedView).toMatchObject(answer);
      expect(observed.storedError).toBeUndefined();
      expect(observed.serviceInstanceError).toBeUndefined();
      expect(observed.unstampedSealRefusals).toBe(0);
    });
  }
});
