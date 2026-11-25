import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import type { JSONSchema } from "../../src/builder/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/relay-send.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const PROGRAM = {
  main: "/relay-send.tsx",
  files: [{
    name: "/relay-send.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

/** The label of the value of the other space the sending handler reads. */
const SECRET_ATOM = "https://commonfabric.org/cfc/atom/Public/relay-secret";

/** The schema the other space's value is written under, which labels it. */
const SECRET_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", ifc: { confidentiality: [SECRET_ATOM] } },
  },
} as const satisfies JSONSchema;

type Held = { name: string; acts: number; sent: string[]; send: unknown };

// `fixtures/relay-send.tsx`, a FabriChat send reduced to what its commit
// prepares: a handler reads a labeled value of another space, as a room's
// send reads the sender's profile from the profile's own space, and sends
// `{ messageAct: true }` to another stream of the piece in its own
// transaction, which appends the event to that stream's event log. The
// write policies of the program are kept.
describe("a handler of a compiled piece that read a labeled value of another space and sends an event, under the serving loop", () => {
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];

  beforeEach(async () => {
    serving = await listenCompiledServingMemoryServer({
      compile: () =>
        Promise.resolve({ main: MAIN, artifacts: () => undefined }),
    });
    clients = [];
    cancels = [];
  });

  afterEach(async () => {
    for (const cancel of cancels) cancel();
    await serving.host.close();
    for (const client of clients) await client.dispose();
    await serving.close();
  });

  const clientOf = (identity: Identity): Runtime => {
    const client = new Runtime({
      apiUrl: serving.url,
      storageManager: StorageManager.open({
        as: identity,
        memoryHost: serving.url,
      }),
      experimental: { serverExecution: true },
    });
    clients.push(client);
    return client;
  };

  it("commits the send, and the event reaches the stream's handler", async () => {
    const owner = await Identity.fromPassphrase("compiled relay send owner");
    const other = await Identity.fromPassphrase("compiled relay send other");
    const space = owner.did() as MemorySpace;
    // The labeled value, in a space of its own.
    const elsewhere = clientOf(other);
    const secret = elsewhere.getCell<{ name?: string }>(
      other.did() as MemorySpace,
      "relay secret",
      SECRET_SCHEMA,
    );
    const seed = elsewhere.edit();
    secret.withTx(seed).set({ name: "Ann" });
    expect((await seed.commit().settled).error).toBeUndefined();

    const client = clientOf(owner);
    const result = client.getCell<Held>(space, "relay-send result");
    const tx = client.edit();
    setUpCompiledPiece(client, tx, PROGRAM, { secret }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
    const read = client.getCellFromLink<Held>(result.getAsNormalizedFullLink());
    cancels.push(read.sink(() => {}));
    await waitForCellValue<Held>(
      client,
      read,
      // The piece has derived from the other space's value, which the
      // serving runtime then holds.
      (held) => held?.send !== undefined && held?.name === "Ann",
      { stuckLabel: "a client reads the name the piece derived" },
    );

    (read.key("send") as unknown as Cell<{ text: string }>).send({
      text: "hello",
    });

    const acts = read.key("acts") as unknown as Cell<number>;
    cancels.push(acts.sink(() => {}));
    await waitForCellValue<number>(client, acts, (held) => held === 1, {
      stuckLabel: "the act the send told reaches its handler",
    });
    expect(serving.pieces()[0].refusals).toEqual([]);
  });
});
