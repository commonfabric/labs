/**
 * Exercises what a served effect node does once CFC refuses its request: a
 * `fetchText`, `fetchJson` or `llm`-family node whose request the sink ceiling
 * refuses ends with the refusal as its error, in the requesting principal's
 * instance, runs again only when what it read changes, and leaves a later
 * request over inputs the ceiling admits free to go out. A `fetchText` whose
 * request goes out is the comparison: it issues one request and keeps its
 * result.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import {
  addMockObjectResponse,
  addMockResponse,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import type { Cell } from "../src/cell.ts";
import { LLMMessageSchema } from "../src/builtins/llm-schemas.ts";
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
  name:
    | "fetchText"
    | "fetchJson"
    | "llm"
    | "generateText"
    | "generateObject"
    | "fetchProgram"
    | "compileAndRun"
    | "llmDialog";

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
  {
    name: "llm",
    call: `llm({ messages: [{ role: "user", content: url }], system: tag })`,
  },
  { name: "generateText", call: `generateText({ prompt: url, system: tag })` },
  {
    name: "generateObject",
    call: `generateObject<{ answer: string }>({ prompt: url, system: tag })`,
  },
];

/** The builtins of the `llm` family, whose request is a prompt. */
const llmFamily = refusable.filter((builtin) =>
  ["llm", "generateText", "generateObject"].includes(builtin.name)
);

const fetchProgram: Builtin = {
  name: "fetchProgram",
  call: `fetchProgram({ url })`,
};

const compileAndRun: Builtin = {
  name: "compileAndRun",
  call:
    `compileAndRun({ files: [{ name: "/main.tsx", contents: url }], main: "/main.tsx" })`,
};

/** The error a builtin's node ends with when its request is refused. */
const refusedMessage = (builtin: Builtin) =>
  `${builtin.name} request was refused before it started`;

/**
 * How many times a case lets the node's request go out, or be refused, before
 * it calls the node a loop: a refused `fetchText`, `fetchJson` or
 * `llm`-family request is staged once more before it stops, and nothing else
 * runs twice.
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

  /**
   * How many times a staging of each request was abandoned, by the request's
   * effect id, as the sink-request seam reports each abandonment.
   */
  abandonments: () => ReadonlyMap<string, number>;

  /** Alice's client runtime. */
  client: Runtime;

  /** Alice's view of the node's result, and her argument cell. */
  fetched: Cell<NodeView>;
  argument: Cell<{ url: string; tag: string; messages: unknown[] }>;

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

  /**
   * Counts a request the case answers itself, outside the `fetch` the fixture
   * stubs, as one of the node's requests.
   */
  countRequest: () => void;

  /**
   * Closes the serving host and starts another, whose serving runtimes declare
   * `ceiling` for the builtin's sink, opens a session of Alice's on the space,
   * and waits for the new serving runtime to run the node and to settle.
   */
  restartServing: (ceiling: readonly string[]) => Promise<void>;

  /** Resolves at the node's first request or refusal, waiting for no more. */
  firstRun: Promise<void>;

  /** Resolves once every serving runtime has settled. */
  servingSettled: () => Promise<unknown>;

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
 * The confidentiality a source labeled for the holder rule carries: the
 * owner's `User` clause, which no store of Alice's space is held by.
 */
const ownerUserClause = [{
  type: "https://commonfabric.org/cfc/atom/User",
  subject: owner.did(),
}];

/**
 * Writes the owner's source document, whose `url` field the node reads, in
 * `sourceSpace` (the owner's space unless given), with that field labeled when
 * `labeled`, by `confidentiality` (`medical` unless given), and returns a link
 * to it.
 */
async function seedSource(
  ownerRuntime: Runtime,
  value: string,
  labeled: boolean,
  confidentiality: readonly (string | { type: string; subject: string })[] = [
    "medical",
  ],
  sourceSpace: MemorySpace = ownerSpace,
): Promise<NormalizedFullLink> {
  const source = ownerRuntime.getCell<{ url: string }>(
    sourceSpace,
    "served-effect-rerun-source",
  );
  const seed = ownerRuntime.edit();
  writeSeedEnvelopeDoc(seed, sourceSpace);
  seedStoredEnvelope(seed, {
    space: sourceSpace,
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
          ? [{
            path: ["url"],
            label: { confidentiality: [...confidentiality] },
          }]
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
 * labeled. With `refusal: "holder"` the serving runtime declares no ceiling,
 * and what the case counts as a refusal is the served-run holder rule's
 * (§8.12.5.1) refusal of the run's own state write.
 */
async function withFixture<T>(
  { builtin, scope, input, refusal = "ceiling" }: {
    builtin: Builtin;
    scope: "space" | "user";
    input: (ownerRuntime: Runtime) => Promise<string | NormalizedFullLink>;
    refusal?: "ceiling" | "holder";
  },
  body: (f: Fixture) => Promise<T>,
): Promise<T> {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const originalFetch = globalThis.fetch;
  const managers = new Map<Runtime, EmulatedStorageManager>();
  const servingRuntimes: Runtime[] = [];
  const abandonedStamps: ServerRunInfo[] = [];
  const abandonments = new Map<string, number>();
  let host: ExecutorHost | undefined;
  let ceiling: readonly string[] | undefined = refusal === "ceiling"
    ? []
    : undefined;
  let nodeRun: PromiseWithResolvers<void> | undefined;
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
        refusal === "holder"
          ? reason.includes("(cross-holder, §8.12.5.1)")
          : reason.includes(`exceeds ceiling for ${builtin.name}`)
      )
    ) {
      refusals += 1;
      counted();
    }
  });
  let cancel: (() => void) | undefined;
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    const [line, details] = args;
    if (
      typeof line === "string" && line.includes("was abandoned before it") &&
      typeof (details as { effectId?: unknown })?.effectId === "string"
    ) {
      const { effectId } = details as { effectId: string };
      abandonments.set(effectId, (abandonments.get(effectId) ?? 0) + 1);
    }
    originalError(...args);
  };
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

    const startHost = () =>
      new ExecutorHost({
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
            ...(ceiling !== undefined
              ? { cfcSinkMaxConfidentiality: { [builtin.name]: ceiling } }
              : {}),
          });
          const demanders = runtime.serverRunDemandersFor.bind(runtime);
          runtime.serverRunDemandersFor = (pieceRootIds) =>
            undemanded ? [] : demanders(pieceRootIds);
          const stamp = runtime.stampServerRun.bind(runtime);
          runtime.stampServerRun = (tx, info) => {
            if (info.actionId.includes("/abandoned/")) {
              abandonedStamps.push(info);
            }
            if (info.actionId.startsWith(`raw:${builtin.name}:`)) {
              nodeRun?.resolve();
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
    host = startHost();

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
  { url: Writable<string>; tag: ${tagType}; messages: Writable<any[]> },
  { fetched: any }
>(({ url, tag, messages }) => ({
  fetched: ${builtin.call},
}));
`,
      }],
    }, { space });
    const argument = client.getCell<
      { url: string; tag: string; messages: unknown[] }
    >(
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
    const firstRun = ran.promise;
    const start = client.edit();
    argument.withTx(start).key("url").set(
      (typeof urlInput === "string"
        ? urlInput
        : client.getCellFromLink(urlInput)) as never,
    );
    argument.withTx(start).key("tag").set("alice's tag");
    // The conversation a dialog keeps; no other builtin reads it.
    argument.withTx(start).key("messages").set([]);
    client.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancel = result.sink(() => {});

    const engine = await server.engineForSpace(space);
    return await body({
      refusals: () => refusals,
      requests: () => requests,
      abandonedStamps,
      abandonments: () => abandonments,
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
      countRequest: () => {
        requests += 1;
        counted();
      },
      restartServing: async (admitted) => {
        await host!.close();
        servingRuntimes.length = 0;
        ceiling = admitted;
        nodeRun = Promise.withResolvers<void>();
        host = startHost();
        // A host activates a space when a session opens on it.
        await openClient(alice).getCellFromLink(
          result.key("fetched").getAsNormalizedFullLink(),
        ).sync();
        await nodeRun.promise;
        await Promise.all(servingRuntimes.map((runtime) => runtime.settled()));
      },
      firstRun,
      servingSettled: () =>
        Promise.all(servingRuntimes.map((runtime) => runtime.settled())),
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
    console.error = originalError;
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

/**
 * Answers `builtin`'s request for `prompt` once, through the LLM client's mock
 * mode, calling `onAsked` when the request reaches it, and returns the result
 * the node shows for that answer.
 */
function mockAnswer(
  builtin: Builtin,
  prompt: string,
  onAsked: () => void,
): unknown {
  const asks = (messages: readonly { content: unknown }[]): boolean => {
    const hit = messages.some((message) =>
      typeof message.content === "string" && message.content.includes(prompt)
    );
    if (hit) onAsked();
    return hit;
  };
  if (builtin.name === "generateObject") {
    addMockObjectResponse(
      (request) => asks(request.messages),
      { object: { answer: "the answer" }, id: "mock-answer" },
    );
    return { answer: "the answer" };
  }
  addMockResponse(
    (request) => asks(request.messages),
    { role: "assistant", content: "the answer", id: "mock-answer" },
  );
  return "the answer";
}

/**
 * Checks that Alice's `scope`-scoped node calling `builtin`, over a labeled
 * source document in `sourceSpace`, ends with the sink ceiling's refusal as
 * its error, in her instance, and is not refused without end.
 */
async function expectRefusedEnding(
  builtin: Builtin,
  scope: "space" | "user",
  sourceSpace: MemorySpace,
): Promise<void> {
  await withFixture({
    builtin,
    scope,
    input: (ownerRuntime) =>
      seedSource(
        ownerRuntime,
        `${url}?labeled`,
        true,
        ["medical"],
        sourceSpace,
      ),
  }, async (f) => {
    await f.settle();

    // Each request is staged again at most once after its refusal, checked
    // first so that a node that keeps staging one request is reported by
    // that request. A user-scoped node can first stage a request built
    // before its `PerUser` input reached the serving runtime, which is a
    // request of its own.
    expect(f.abandonments().size).toBeGreaterThan(0);
    for (const [effectId, count] of f.abandonments()) {
      expect(count, effectId).toBeLessThanOrEqual(2);
    }
    expect(f.refusals()).toBeGreaterThan(0);
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
}

/**
 * Seeds the source document of a case over a prompt read from the node's own
 * space: labeled `medical`, which the served-run holder rule (§8.12.5.1)
 * admits everywhere the node writes, so only the sink ceiling refuses it.
 */
const ownSpaceSource = (ownerRuntime: Runtime, value = `${url}?labeled`) =>
  seedSource(ownerRuntime, value, true, ["medical"], space);

describe("served-effect-refusal-rerun", () => {
  for (const builtin of refusable) {
    for (const scope of ["space", "user"] as const) {
      it(`ends a ${scope}-scoped served ${builtin.name} whose request the sink ceiling refuses, without running it again`, async () => {
        await expectRefusedEnding(builtin, scope, ownerSpace);
      });
    }
  }

  for (const builtin of llmFamily) {
    for (const scope of ["space", "user"] as const) {
      it(`ends a ${scope}-scoped served ${builtin.name} whose request over a prompt from its own space the sink ceiling refuses, without running it again`, async () => {
        // No request hash records the refused request, so the node's next
        // run stages it again and is refused again. That run's ending writes
        // what the first one wrote, and nothing the node reads changes.

        await expectRefusedEnding(builtin, scope, space);
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

  it("answers a refused served generateText once its prompt changes to one the ceiling admits, leaving no refusal standing", async () => {
    // The refused request's ending reads none of the node's inputs, so it
    // carries nothing that would conflict it with a change to them. What
    // keeps it from standing over newer inputs is the node's own run: one
    // on the new prompt counts as newer in this runtime, and its request,
    // staged afresh, overwrites whatever the ending wrote. The prompt
    // changes as soon as the first refusal is seen, before the serving
    // runtime settles on the ending.

    const prompt = "served effect rerun admitted prompt";
    enableMockMode();
    addMockResponse(
      (request) =>
        request.messages.some((message) =>
          typeof message.content === "string" &&
          message.content.includes(prompt)
        ),
      { role: "assistant", content: "the answer", id: "mock-answer" },
    );
    try {
      await withFixture({
        builtin: refusable.find((builtin) => builtin.name === "generateText")!,
        scope: "space",
        input: (ownerRuntime) =>
          seedSource(ownerRuntime, `${url}?labeled`, true),
      }, async (f) => {
        await f.firstRun;
        const change = f.client.edit();
        f.argument.withTx(change).key("url").set(prompt);
        expect((await change.commit().settled).error).toBeUndefined();
        await f.servingSettled();

        const answered = { pending: false, result: "the answer" };
        const servingView = f.servingView(
          f.fetched.getAsNormalizedFullLink(),
          undefined,
        );
        expect(servingView).toMatchObject(answered);
        expect(servingView?.error).toBeUndefined();
        const freshView = await f.freshView();
        expect(freshView).toMatchObject(answered);
        expect(freshView?.error).toBeUndefined();
      });
    } finally {
      resetMockMode();
    }
  });

  for (const builtin of llmFamily) {
    it(`answers a refused served ${builtin.name} once a prompt read from its own space changes to one the ceiling admits`, async () => {
      // The labeled prompt comes from a document in the node's own space (see
      // `ownSpaceSource()`), so only the sink ceiling refuses the request.
      // What the refused request's ending leaves in the node's fields carries
      // none of that prompt's label into the node's next run, whose request
      // is over the new prompt alone, and the ceiling admits it.

      const prompt = "served effect rerun admitted prompt";
      let fixture: Fixture | undefined;
      enableMockMode();
      const answer = mockAnswer(builtin, prompt, () => fixture?.countRequest());
      try {
        await withFixture({
          builtin,
          scope: "space",
          input: (ownerRuntime) => ownSpaceSource(ownerRuntime),
        }, async (f) => {
          fixture = f;
          await f.settle();
          const refused = f.refusals();
          expect(refused).toBeGreaterThan(0);
          expect(f.requests()).toBe(0);

          await f.settle(async () => {
            const change = f.client.edit();
            f.argument.withTx(change).key("url").set(prompt);
            expect((await change.commit().settled).error).toBeUndefined();
          });

          expect(f.refusals()).toBe(refused);
          expect(f.requests()).toBe(1);
          const answered = { pending: false, result: answer };
          const servingView = f.servingView(
            f.fetched.getAsNormalizedFullLink(),
            undefined,
          );
          expect(servingView).toMatchObject(answered);
          expect(servingView?.error).toBeUndefined();
          const freshView = await f.freshView();
          expect(freshView).toMatchObject(answered);
          expect(freshView?.error).toBeUndefined();
        });
      } finally {
        resetMockMode();
      }
    });
  }

  for (const builtin of llmFamily) {
    it(`answers a refused served ${builtin.name}'s unchanged request once a new serving runtime's ceiling admits its prompt`, async () => {
      // The ceiling is the serving runtime's, so a ceiling that admits the
      // prompt's label comes with a new serving runtime. Nothing the node
      // reads has changed, and its request is the one refused, so it is
      // staged again only because nothing records the refused request as
      // answered.

      const prompt = `${url}?labeled`;
      let fixture: Fixture | undefined;
      enableMockMode();
      const answer = mockAnswer(builtin, prompt, () => fixture?.countRequest());
      try {
        await withFixture({
          builtin,
          scope: "space",
          input: (ownerRuntime) => ownSpaceSource(ownerRuntime, prompt),
        }, async (f) => {
          fixture = f;
          await f.settle();
          const refused = f.refusals();
          expect(refused).toBeGreaterThan(0);
          expect(f.requests()).toBe(0);

          await f.restartServing(["medical"]);

          expect(f.refusals()).toBe(refused);
          expect(f.requests()).toBe(1);
          const answered = { pending: false, result: answer };
          const servingView = f.servingView(
            f.fetched.getAsNormalizedFullLink(),
            undefined,
          );
          expect(servingView).toMatchObject(answered);
          expect(servingView?.error).toBeUndefined();
          const freshView = await f.freshView();
          expect(freshView).toMatchObject(answered);
          expect(freshView?.error).toBeUndefined();
        });
      } finally {
        resetMockMode();
      }
    });
  }

  for (
    const [builtin, labeled, admitted] of [
      [fetchProgram, `${url}?labeled`, `${url}?admitted`],
      [compileAndRun, "export default 1;", "export default 2;"],
    ] as const
  ) {
    it(`refuses a served ${builtin.name}'s request again once its input, read from its own space, changes to one the ceiling admits`, async () => {
      // TODO(danfuzz): The request over the new input should go out, as an
      // `llm` builtin's does. It is refused instead: the refused request's
      // ending reads the node's inputs to decide whether the request is still
      // the node's, so everything it writes carries the old input's label,
      // the record of the refused request included, and the node's next run
      // reads that record and takes the label into its request. See the
      // paired TODO at each builtin's ending, in `fetch-program.ts` and
      // `compile-and-run.ts`.

      await withFixture({
        builtin,
        scope: "space",
        input: (ownerRuntime) => ownSpaceSource(ownerRuntime, labeled),
      }, async (f) => {
        await f.settle();
        const refused = f.refusals();
        expect(refused).toBeGreaterThan(0);

        await f.settle(async () => {
          const change = f.client.edit();
          f.argument.withTx(change).key("url").set(admitted);
          expect((await change.commit().settled).error).toBeUndefined();
        });

        expect(f.refusals()).toBeGreaterThan(refused);
        expect(f.requests()).toBe(0);
        expect(
          f.servingView(f.fetched.getAsNormalizedFullLink(), undefined),
        ).toMatchObject({ pending: false, error: refusedMessage(builtin) });
      });
    });
  }

  it("ends a served fetchText whose state write the holder rule refuses, without running it again", async () => {
    // Alice's node reads its URL through a link to another space's document
    // labeled with that space owner's `User` clause, which no store of
    // Alice's space is held by, so the served-run holder rule (§8.12.5.1)
    // refuses the run's write of the node's state. Its abandoned request's
    // ending, written in the open wave, is what stops it running again.

    await withFixture({
      builtin: fetchText,
      scope: "space",
      refusal: "holder",
      input: (ownerRuntime) =>
        seedSource(ownerRuntime, `${url}?private`, true, ownerUserClause),
    }, async (f) => {
      await f.settle();

      expect(f.refusals()).toBeGreaterThan(0);
      expect(f.refusals()).toBeLessThanOrEqual(RUN_BOUND);
      expect(f.requests()).toBe(0);
      const ending = { pending: false, error: refusedMessage(fetchText) };
      expect(
        f.servingView(f.fetched.getAsNormalizedFullLink(), undefined),
      ).toMatchObject(ending);
      expect(await f.freshView()).toMatchObject(ending);
      expect(f.unstampedSealRefusals()).toBe(0);
    });
  });

  it("leaves a served compileAndRun whose state write the holder rule refuses without an ending, reporting its refusal", async () => {
    // The program's source comes through a link to another space's document
    // labeled with that space owner's `User` clause, so the holder rule
    // refuses the run that stages its compile, and then refuses its ending
    // too: the node is left showing no error.
    //
    // TODO(danfuzz): The node should end showing "compileAndRun request was
    // refused before it started", as the `llm` builtins' nodes do. It can't
    // yet: the ending decides whether its request is still the target's by
    // reading the program, which is labeled, so the holder rule refuses
    // everything the ending writes. Deciding from an in-memory record of the
    // latest run's program instead would lose the guarantee that an abandoned
    // request's ending never lands over a program that replaced it
    // ("leaves an abandoned request's outputs to the program that replaced
    // it", in `compile-and-run-served.test.ts`). See the paired TODO at the
    // ending in `compile-and-run.ts`.

    const rejected: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("[compileAndRun]")) rejected.push(line);
      originalError(...args);
    };
    try {
      await withFixture({
        builtin: compileAndRun,
        scope: "space",
        refusal: "holder",
        input: (ownerRuntime) =>
          seedSource(
            ownerRuntime,
            "export default 1;",
            true,
            ownerUserClause,
          ),
      }, async (f) => {
        await f.settle();

        expect(f.refusals()).toBeGreaterThan(0);
        expect(f.refusals()).toBeLessThanOrEqual(RUN_BOUND);
        expect(rejected.length).toBeGreaterThan(0);
        expect(
          rejected.every((line) =>
            line.includes("Writing the abandoned request's error") &&
            line.includes("was rejected")
          ),
        ).toBe(true);
        const servingView = f.servingView(
          f.fetched.getAsNormalizedFullLink(),
          undefined,
        );
        expect(servingView?.error).toBeUndefined();
        expect((await f.freshView())?.error).toBeUndefined();
      });
    } finally {
      console.error = originalError;
    }
  });

  it("ends a served llmDialog turn whose staging the holder rule refuses, with no rejected ending", async () => {
    // The dialog's system prompt comes through a link to another space's
    // document labeled with that space owner's `User` clause, so the holder
    // rule refuses the handler run that stages a turn. A dialog's ending
    // leaves its conversation alone and takes its pending flag down, and
    // that write must land rather than be refused in turn.

    const llmDialog: Builtin = {
      name: "llmDialog",
      call: `llmDialog({ messages, system: url, builtinTools: false })`,
    };
    const rejected: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes("[llmDialog]")) rejected.push(line);
      originalError(...args);
    };
    try {
      await withFixture({
        builtin: llmDialog,
        scope: "space",
        refusal: "holder",
        input: (ownerRuntime) =>
          seedSource(
            ownerRuntime,
            "the system prompt",
            true,
            ownerUserClause,
          ),
      }, async (f) => {
        await waitForCellValue(
          f.client,
          f.fetched,
          (view) =>
            !!(view as { addMessage?: unknown } | undefined)?.addMessage,
        );
        await f.settle(async () => {
          f.fetched.key("addMessage" as never).asSchema({
            ...LLMMessageSchema,
            asCell: ["stream"],
          }).send({ role: "user", content: "hello" } as never);
          await f.client.idle();
        });

        expect(f.refusals()).toBeGreaterThan(0);
        expect(f.runsSinceTrigger()).toBeLessThanOrEqual(RUN_BOUND);
        expect(rejected).toEqual([]);
        expect(
          f.servingView(f.fetched.getAsNormalizedFullLink(), undefined),
        ).toMatchObject({ pending: false });
      });
    } finally {
      console.error = originalError;
    }
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
