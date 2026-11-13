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
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import type { Cell } from "../src/cell.ts";
import { addCfcDenialListener } from "../src/cfc/denial-report.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { Runtime, type ServerRunInfo } from "../src/runtime.ts";
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

/** The error a builtin's node ends with when its request is refused. */
const refusedMessage = (builtin: Builtin) =>
  `${builtin.name} request was refused before it started`;

/**
 * How many times a case lets the node's request go out, or be refused, before
 * it calls the node a loop: a refused `fetch*` request is staged once more
 * before it stops, and nothing else runs twice.
 */
const RUN_BOUND = 3;

/** An effect node's public state. */
type NodeView = { pending?: boolean; result?: unknown; error?: unknown };

/** A running fixture: a serving host, Alice's client, and what they did. */
type Fixture = {
  /** How many of the node's requests the sink ceiling refused. */
  refusals: () => number;

  /** How many of the node's requests went out. */
  requests: () => number;

  /** The serving runtime's stamps for abandoned requests' endings. */
  abandonedStamps: ServerRunInfo[];

  /** Alice's client runtime. */
  client: Runtime;

  /** Alice's view of the node's result, and her argument cell. */
  fetched: Cell<NodeView>;
  argument: Cell<{ url: string; tag: string }>;

  /** The owner's runtime, which writes the document the URL comes from. */
  ownerRuntime: Runtime;

  /**
   * Runs `trigger`, if there is one, then waits for the node's next request or
   * refusal, and then for the serving runtimes to settle, or for the requests
   * and refusals since `trigger` to pass `RUN_BOUND`, whichever comes first.
   * A node that runs again without end never lets the runtime settle, so the
   * count is what ends the wait then. Without `trigger`, the wait is for the
   * node's start.
   */
  settle: (trigger?: () => Promise<void>) => Promise<void>;

  /** How many requests and refusals the last `settle()` waited through. */
  runsSinceTrigger: () => number;

  /** Opens another client runtime authenticated as `signer`. */
  openClient: (signer: typeof alice) => Runtime;

  /**
   * Makes the serving runtime see no demander for any node from now on, so it
   * runs each one as nobody's, with no scope-key identity.
   */
  stopDemand: () => void;

  /** The serving runtime's view of `link`, in `identity`'s instance. */
  servingView: (
    link: NormalizedFullLink,
    identity: ScopeKeyIdentity | undefined,
  ) => NodeView | undefined;

  /**
   * The document and path the node's `error` field resolves to, read through
   * Alice's client.
   */
  errorLink: () => Promise<NormalizedFullLink>;

  /** The value the server's store holds at `link`, in `identity`'s instance. */
  stored: (link: NormalizedFullLink, identity: ScopeKeyIdentity) => unknown;

  /** The node's state as a fresh client of Alice's reads it. */
  freshView: () => Promise<NodeView | undefined>;

  /** How many transactions the serving loop refused to seal as unstamped. */
  unstampedSealRefusals: () => number;
};

/**
 * Writes the owner's source document, whose `url` field the node reads, with
 * that field labeled `medical` when `labeled`, and returns a link to it.
 */
async function seedSource(
  ownerRuntime: Runtime,
  value: string,
  labeled: boolean,
): Promise<NormalizedFullLink> {
  const source = ownerRuntime.getCell<{ url: string }>(
    ownerSpace,
    "served-effect-rerun-source",
  );
  const seed = ownerRuntime.edit();
  writeSeedEnvelopeDoc(seed, ownerSpace);
  seedStoredEnvelope(seed, {
    space: ownerSpace,
    scope: "space",
    id: source.getAsNormalizedFullLink().id,
    path: [],
  }, {
    value: { url: value },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: labeled
          ? [{ path: ["url"], label: { confidentiality: ["medical"] } }]
          : [],
      },
    },
  });
  expect((await seed.commit().settled).error).toBeUndefined();
  return { ...source.getAsNormalizedFullLink(), path: ["url"] };
}

/**
 * Runs `body` against Alice's node calling `builtin`, run through a serving
 * runtime whose ceiling for the builtin's sink admits no confidentiality. The
 * node's URL is `input`: a plain URL, or a link to the owner's source document
 * (see `seedSource()`), which the ceiling refuses when that document is
 * labeled.
 */
async function withFixture<T>(
  { builtin, scope, input }: {
    builtin: Builtin;
    scope: "space" | "user";
    input: (ownerRuntime: Runtime) => Promise<string | NormalizedFullLink>;
  },
  body: (f: Fixture) => Promise<T>,
): Promise<T> {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const originalFetch = globalThis.fetch;
  const managers = new Map<Runtime, EmulatedStorageManager>();
  const servingRuntimes: Runtime[] = [];
  const abandonedStamps: ServerRunInfo[] = [];
  let host: ExecutorHost | undefined;
  let undemanded = false;
  let refusals = 0;
  let requests = 0;
  let base = 0;
  let ran = Promise.withResolvers<void>();
  let overBound = Promise.withResolvers<void>();
  const counted = () => {
    ran.resolve();
    if (refusals + requests - base > RUN_BOUND) overBound.resolve();
  };
  const stopListening = addCfcDenialListener((denial) => {
    const reasons = (denial.inputs.reasons ?? []) as readonly string[];
    if (
      reasons.some((reason) =>
        reason.includes(`exceeds ceiling for ${builtin.name}`)
      )
    ) {
      refusals += 1;
      counted();
    }
  });
  let cancel: (() => void) | undefined;
  try {
    globalThis.fetch = (input, init) => {
      const requestedUrl = input instanceof Request ? input.url : String(input);
      if (!requestedUrl.startsWith(url)) return originalFetch(input, init);
      requests += 1;
      counted();
      return Promise.resolve(new Response("the response"));
    };

    const openClient = (signer: typeof alice) => {
      const manager = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      managers.set(runtime, manager);
      return runtime;
    };

    const ownerRuntime = openClient(owner);
    const urlInput = await input(ownerRuntime);

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
          cfcSinkMaxConfidentiality: { [builtin.name]: [] },
        });
        const demanders = runtime.serverRunDemandersFor.bind(runtime);
        runtime.serverRunDemandersFor = (pieceRootIds) =>
          undemanded ? [] : demanders(pieceRootIds);
        const stamp = runtime.stampServerRun.bind(runtime);
        runtime.stampServerRun = (tx, info) => {
          if (info.actionId.includes("/abandoned/")) {
            abandonedStamps.push(info);
          }
          stamp(tx, info);
        };
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
      (typeof urlInput === "string"
        ? urlInput
        : client.getCellFromLink(urlInput)) as never,
    );
    argument.withTx(start).key("tag").set("alice's tag");
    client.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancel = result.sink(() => {});

    const engine = await server.engineForSpace(space);
    return await body({
      refusals: () => refusals,
      requests: () => requests,
      abandonedStamps,
      client,
      fetched: result.key("fetched"),
      argument,
      ownerRuntime,
      settle: async (trigger) => {
        if (trigger !== undefined) {
          base = refusals + requests;
          ran = Promise.withResolvers<void>();
          overBound = Promise.withResolvers<void>();
          await trigger();
        }
        const over = overBound.promise;
        await ran.promise;
        await Promise.race([
          over,
          Promise.all(servingRuntimes.map((runtime) => runtime.settled())),
        ]);
      },
      runsSinceTrigger: () => refusals + requests - base,
      openClient,
      stopDemand: () => {
        undemanded = true;
      },
      servingView: (link, identity) =>
        viewAs(servingRuntimes[0], link, identity),
      errorLink: async () => {
        const error = result.key("fetched").key("error").resolveAsCell();
        await error.sync();
        return error.getAsNormalizedFullLink();
      },
      stored: (link, identity) => storedValue(engine, link, identity),
      freshView: async () => {
        const fresh = openClient(alice).getCellFromLink<NodeView>(
          result.key("fetched").getAsNormalizedFullLink(),
        );
        await fresh.sync();
        await fresh.key("error").resolveAsCell().sync();
        return snapshot(fresh.get());
      },
      unstampedSealRefusals: () => host!.stats().unstampedSealRefusals,
    });
  } finally {
    cancel?.();
    stopListening();
    globalThis.fetch = originalFetch;
    await host?.close();
    for (const runtime of managers.keys()) {
      await runtime.dispose({ closeStorage: false });
    }
    for (const manager of managers.values()) await manager.close();
    await server.close();
  }
}

/**
 * Reads `link` through `runtime`'s replica, in the instance `identity` names
 * when there is one, the way a run carrying that identity reads it.
 */
function viewAs(
  runtime: Runtime,
  link: NormalizedFullLink,
  identity: ScopeKeyIdentity | undefined,
): NodeView | undefined {
  const tx = runtime.edit();
  try {
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    return snapshot(runtime.getCellFromLink<NodeView>(link).withTx(tx).get());
  } finally {
    tx.abort();
  }
}

/**
 * The node's fields, read out of a view while the transaction it reads
 * through is still open. Every field these cases set is a primitive.
 */
function snapshot(view: NodeView | undefined): NodeView | undefined {
  if (view === undefined) return undefined;
  const { pending, result, error } = view;
  return {
    ...(pending !== undefined ? { pending } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** The value the server's store holds at `link` in `identity`'s instance. */
function storedValue(
  engine: Engine.Engine,
  link: NormalizedFullLink,
  identity: ScopeKeyIdentity,
): unknown {
  const document = Engine.read(engine, {
    id: link.id as never,
    ...(link.scope !== undefined && link.scope !== "space"
      ? {
        scope: link.scope,
        principal: identity.principal,
        sessionId: identity.sessionId,
      }
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
        await withFixture({
          builtin,
          scope,
          input: (ownerRuntime) =>
            seedSource(ownerRuntime, `${url}?labeled`, true),
        }, async (f) => {
          await f.settle();

          expect(f.refusals()).toBeLessThanOrEqual(RUN_BOUND);
          expect(f.requests()).toBe(0);
          const requester = f.client.scopeKeyIdentity;
          const errorLink = await f.errorLink();
          const ending = { pending: false, error: refusedMessage(builtin) };
          expect(
            f.servingView(
              f.fetched.getAsNormalizedFullLink(),
              scope === "user" ? requester : undefined,
            ),
          ).toMatchObject(ending);
          expect(await f.freshView()).toMatchObject(ending);
          expect(f.stored(errorLink, requester)).toBe(refusedMessage(builtin));
          if (scope === "user") {
            // Where the ending lands without the requester's identity.
            expect(
              f.stored(errorLink, {
                principal: service.did(),
                sessionId: requester.sessionId,
              }),
            ).toBeUndefined();
          }
          expect(f.unstampedSealRefusals()).toBe(0);
        });
      });
    }
  }

  for (const scope of ["space", "user"] as const) {
    it(`issues a ${scope}-scoped served fetchText's request once and keeps its result`, async () => {
      await withFixture({
        builtin: fetchText,
        scope,
        input: () => Promise.resolve(url),
      }, async (f) => {
        await f.settle();

        expect(f.requests()).toBe(1);
        expect(f.refusals()).toBe(0);
        const answer = { pending: false, result: "the response" };
        expect(
          f.servingView(
            f.fetched.getAsNormalizedFullLink(),
            scope === "user" ? f.client.scopeKeyIdentity : undefined,
          ),
        ).toMatchObject(answer);
        expect(await f.freshView()).toMatchObject(answer);
        expect(f.stored(await f.errorLink(), f.client.scopeKeyIdentity))
          .toBeUndefined();
        expect(f.unstampedSealRefusals()).toBe(0);
      });
    });
  }

  it("issues a refused served fetchText's request once its URL changes to one the ceiling admits", async () => {
    await withFixture({
      builtin: fetchText,
      scope: "space",
      input: (ownerRuntime) => seedSource(ownerRuntime, `${url}?labeled`, true),
    }, async (f) => {
      await f.settle();
      const refused = f.refusals();
      expect(refused).toBeLessThanOrEqual(RUN_BOUND);
      expect(f.requests()).toBe(0);

      await f.settle(async () => {
        const change = f.client.edit();
        f.argument.withTx(change).key("url").set(`${url}?admitted`);
        expect((await change.commit().settled).error).toBeUndefined();
      });

      expect(f.requests()).toBe(1);
      expect(f.refusals()).toBe(refused);
      expect(
        f.servingView(f.fetched.getAsNormalizedFullLink(), undefined),
      ).toMatchObject({ pending: false, result: "the response" });
    });
  });

  it("ends a served fetchText that nobody demands, whose request the sink ceiling refuses", async () => {
    // Alice's node runs once for her, its URL unlabeled. Then the serving
    // runtime stops seeing her demand, and the owner labels the URL: the
    // serving runtime runs the node again for nobody, with no scope-key
    // identity, and the ending belongs in the node's one, space-scoped
    // instance.

    await withFixture({
      builtin: fetchText,
      scope: "space",
      input: (ownerRuntime) =>
        seedSource(ownerRuntime, `${url}?unlabeled`, false),
    }, async (f) => {
      await f.settle();
      expect(f.requests()).toBe(1);
      await waitForCellValue<NodeView>(
        f.client,
        f.fetched,
        (view) => view?.pending === false && view.result === "the response",
      );
      const errorLink = await f.errorLink();
      const fetchedLink = f.fetched.getAsNormalizedFullLink();
      const requester = f.client.scopeKeyIdentity;

      f.stopDemand();
      await f.settle(async () => {
        await seedSource(f.ownerRuntime, `${url}?labeled`, true);
      });

      expect(f.refusals()).toBeGreaterThan(0);
      expect(f.requests()).toBe(1);
      expect(f.runsSinceTrigger()).toBeLessThanOrEqual(RUN_BOUND);
      expect(f.abandonedStamps.map((stamp) => stamp.scopeKeyIdentity))
        .toContain(undefined);
      expect(f.servingView(fetchedLink, undefined)).toMatchObject({
        pending: false,
        error: refusedMessage(fetchText),
      });
      expect(f.stored(errorLink, requester)).toBe(refusedMessage(fetchText));
    });
  });
});
