/**
 * Exercises what a client already watching a served effect node shows once
 * the node's inputs change and the serving runtime has served the new request:
 * the served result, the same one a fresh client loads, whether or not the
 * request for the old inputs was refused, with none of the client's own
 * speculations of the node left standing over it.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  addMockResponse,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm";
import * as Engine from "@commonfabric/memory/v2/engine";

import type { Cell } from "../src/cell.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import type { NormalizedFullLink } from "../src/link-types.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { awaitReplica, settleServing } from "./support/serving-waits.ts";

const spaceSigner = await Identity.fromPassphrase("served watching client");
const service = await Identity.fromPassphrase("served watching service");
const alice = await Identity.fromPassphrase("served watching alice");
const owner = await Identity.fromPassphrase("served watching owner");
const space = spaceSigner.did() as MemorySpace;
const ownerSpace = owner.did() as MemorySpace;
const url = "https://example.test/served-watching";

/** An effect node's public state. */
type NodeView = { pending?: boolean; result?: unknown; error?: unknown };

/** The node's fields, read out of a view while its transaction is open. */
function snapshot(view: NodeView | undefined): NodeView | undefined {
  if (view === undefined) return undefined;
  const { pending, result, error } = view;
  return {
    ...(pending !== undefined ? { pending } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

/** A served builtin the cases run, and the inputs it is given. */
type Builtin = {
  name: "fetchText" | "generateText";

  /** The pattern's call of the builtin over its `url` input. */
  call: string;

  /** The admissible inputs the node's `url` changes to, in order. */
  inputs: readonly string[];

  /** What the node serves for `input`. */
  answer: (input: string) => string;
};

const fetchTextBuiltin: Builtin = {
  name: "fetchText",
  call: "fetchText({ url })",
  inputs: [`${url}?second`, `${url}?third`],
  answer: (input) => `answer for ${input}`,
};

const generateTextBuiltin: Builtin = {
  name: "generateText",
  call: `generateText({ prompt: url, system: "served watching" })`,
  inputs: ["served watching second prompt"],
  answer: (input) => `the answer to ${input}`,
};

/** What a run leaves for the cases to assert on. */
type Outcome = {
  /** The watching client's view of the node after the last input. */
  watching: NodeView | undefined;

  /** A fresh client's view of the node after the last input. */
  fresh: NodeView | undefined;

  /** The watching client's speculations still standing in the space. */
  standing: number;
};

/**
 * Runs Alice's node over `builtin` through a serving runtime whose ceiling
 * admits nothing labeled: first on `first` (a plain input, or a link to the
 * owner's `medical`-labeled one, which the ceiling refuses), then on each of
 * `builtin.inputs` in turn. Alice's client watches the node's own view all the
 * while, as a pattern's UI reading the result would. After each input the run
 * waits for the serving loop's watermark to cover it and for Alice's replica to
 * hold the store's copy of the node's result, so what the watching client shows
 * is what it makes of the served state rather than how far delivery has got.
 */
async function runWatched(
  builtin: Builtin,
  first: "plain" | "refused",
): Promise<Outcome> {
  const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
  const originalFetch = globalThis.fetch;
  const managers = new Map<Runtime, EmulatedStorageManager>();
  let host: ExecutorHost | undefined;
  let cancel: (() => void) | undefined;
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
  enableMockMode();
  for (const input of builtin.inputs) {
    addMockResponse(
      (request) =>
        request.messages.some((message) =>
          typeof message.content === "string" &&
          message.content.includes(input)
        ),
      { role: "assistant", content: builtin.answer(input), id: input },
    );
  }
  try {
    globalThis.fetch = (request, init) => {
      const requested = request instanceof Request
        ? request.url
        : String(request);
      if (!requested.startsWith(url)) return originalFetch(request, init);
      return Promise.resolve(new Response(builtin.answer(requested)));
    };
    let firstInput: unknown = `${url}?first`;
    if (first === "refused") {
      const ownerRuntime = openClient(owner);
      const source = ownerRuntime.getCell<{ url: string }>(
        ownerSpace,
        "served-watching-source",
      );
      const seed = ownerRuntime.edit();
      writeSeedEnvelopeDoc(seed, ownerSpace);
      seedStoredEnvelope(seed, {
        space: ownerSpace,
        scope: "space",
        id: source.getAsNormalizedFullLink().id,
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
      firstInput = { ...source.getAsNormalizedFullLink(), path: ["url"] };
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
          cfcSinkMaxConfidentiality: { [builtin.name]: [] },
        });
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
    const engine = await server.engineForSpace(space);
    const pattern = await client.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `
import { ${builtin.name}, pattern, Writable } from "commonfabric";
export default pattern<{ url: Writable<string> }, { fetched: any }>(
  ({ url }) => ({ fetched: ${builtin.call} }),
);
`,
      }],
    }, { space });
    const argument = client.getCell<{ url: string }>(
      space,
      "served-watching-input",
      pattern.argumentSchema,
    );
    const result = client.getCell<{ fetched: NodeView }>(
      space,
      "served-watching-result",
      pattern.resultSchema,
    );
    await argument.sync();
    await result.sync();
    const start = client.edit();
    argument.withTx(start).key("url").set(
      (typeof firstInput === "string"
        ? firstInput
        : client.getCellFromLink(firstInput as NormalizedFullLink)) as never,
    );
    client.run(start, pattern, argument, result);
    expect((await start.commit().settled).error).toBeUndefined();
    cancel = result.key("fetched").sink(() => {});
    await settleServing(engine, client, space);

    for (const input of builtin.inputs) {
      const change = client.edit();
      argument.withTx(change).key("url").set(input);
      expect((await change.commit().settled).error).toBeUndefined();
      await settleServing(engine, client, space);
      await awaitServedResult(
        client,
        engine,
        result.key("fetched"),
        builtin.answer(input),
      );
      await client.idle();
    }

    const fresh = openClient(alice).getCellFromLink<NodeView>(
      result.key("fetched").getAsNormalizedFullLink(),
    );
    await fresh.sync();
    await fresh.key("result").resolveAsCell().sync();
    return {
      watching: snapshot(result.key("fetched").get()),
      fresh: snapshot(fresh.get()),
      standing: client.speculationOverlay?.entryCount(space) ?? 0,
    };
  } finally {
    cancel?.();
    resetMockMode();
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
 * Waits until the store holds `answer` as the result of the node `node` names
 * and `client`'s replica holds the store's current copy of the document that
 * result lives in, however the client renders it.
 */
async function awaitServedResult(
  client: Runtime,
  engine: Engine.Engine,
  node: Cell<NodeView>,
  answer: string,
): Promise<void> {
  const replica = client.storageManager.open(space).replica;
  await awaitReplica(client.storageManager, () => {
    const link = node.key("result").resolveAsCell().getAsNormalizedFullLink();
    let stored: unknown = Engine.read(engine, {
      id: link.id as never,
      scope: "space",
    })?.value;
    for (const key of link.path) {
      stored = (stored as Record<string, unknown> | undefined)?.[key];
    }
    const head = Engine.selectDocHead(engine, {
      id: link.id as never,
      scopeKey: "space",
    });
    const confirmed =
      replica.speculationRetirementView?.(link.id, "space").confirmedSeq ?? 0;
    return stored === answer && confirmed >= head;
  });
}

describe("served-effect-watching-client", () => {
  for (const builtin of [fetchTextBuiltin, generateTextBuiltin]) {
    describe(`${builtin.name}`, () => {
      const last = builtin.inputs.at(-1)!;
      const served = { pending: false, result: builtin.answer(last) };

      for (const first of ["plain", "refused"] as const) {
        it(`shows a watching client the served result after the node's input changes from a ${first} one`, async () => {
          const { watching, fresh } = await runWatched(builtin, first);

          expect(fresh).toMatchObject(served);
          expect(watching).toMatchObject(served);
          expect(watching?.error).toBeUndefined();
        });

        it(`leaves none of a watching client's speculations standing once the input that follows a ${first} one is served`, async () => {
          const { fresh, standing } = await runWatched(builtin, first);

          expect(fresh).toMatchObject(served);
          expect(standing).toBe(0);
        });
      }
    });
  }
});
