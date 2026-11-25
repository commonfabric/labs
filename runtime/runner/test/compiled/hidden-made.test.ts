import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { hashStringOf } from "@commonfabric/data-model";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

import type { Artifact } from "../../../../base/pattern-compiler/exec/executor.ts";
import type { Cell, MemorySpace } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  type CompiledServingMemoryServer,
  listenCompiledServingMemoryServer,
} from "../../src/compiled/serving-memory-server.deno.ts";
import { setUpCompiledPiece } from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/hidden-made.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const ITEM = patterns.find(({ name }) => name === "Item")!;
const PROGRAM = {
  main: "/hidden-made.tsx",
  files: [{
    name: "/hidden-made.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

type Held = {
  items: { title: string; byline: string }[];
  table: { title: string }[];
  nickname: string;
  add: unknown;
};

const USER = "https://commonfabric.org/cfc/atom/User";

/** The `User` clauses a stored label map holds, by the subject's digest. */
const usersIn = (value: unknown): string[] => {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.type === USER) {
      const subject = record.subject as string | { digestOf?: string };
      found.add(
        typeof subject === "string"
          ? hashStringOf(subject)
          : subject?.digestOf ?? "?",
      );
    }
    Object.values(record).forEach(walk);
  };
  walk(value);
  return [...found];
};

// `fixtures/hidden-made.tsx`, the Topics board's topics reduced to the read
// of a value of each viewer: a handler makes an instance whose view reads a
// value of the scope `user` of the principal who reads it, and the board
// derives a table over the instances. Two principals hold a session on the
// board, each with a value of the scope `user` under that principal's own
// `User` clause, as each viewer's profile is. One of them makes an instance.
// Nothing of the other principal, value or clause, may be stored in a
// document of the space or in an instance of the creator, or the creator's
// display ceiling refuses what the instance shows ("Content hidden by
// policy").
describe("an instance a handler makes, whose view reads a value of the scope `user`, with two principals under the serving loop", () => {
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];
  let ann: Identity;
  let bob: Identity;
  let space: MemorySpace;

  beforeEach(async () => {
    ann = await Identity.fromPassphrase("compiled hidden made ann");
    bob = await Identity.fromPassphrase("compiled hidden made bob");
    space = ann.did();
    serving = await listenCompiledServingMemoryServer({
      compile: () =>
        Promise.resolve({
          main: MAIN,
          artifacts: (id) =>
            (ITEM.plan as { patterns?: string[] }).patterns?.[0] === id
              ? ITEM
              : undefined,
        }),
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

  /** The result as `client` reads it, once it holds its stream. */
  const opened = async (client: Runtime) => {
    const read = client.getCellFromLink<Held>(
      client.getCell<Held>(space, "hidden-made result")
        .getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    await waitForCellValue<Held>(
      client,
      read,
      (held) => held?.add !== undefined,
      { stuckLabel: "a client reads the stream of the piece" },
    );
    return read;
  };

  /**
   * Writes the principal's nickname, whose type declares the `User` clause
   * of the principal whose instance holds it, as a profile's fields are
   * stored, through the link the result holds, as the shell's `$value`
   * binding writes the cell it holds.
   */
  const named = async (
    client: Runtime,
    read: Cell<Held>,
    name: string,
  ) => {
    const cell = read.key("nickname").resolveAsCell() as unknown as Cell<
      string
    >;
    cancels.push(cell.sink(() => {}));
    const tx = client.edit();
    cell.withTx(tx).set(name);
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** Resolves when `client` reads `expected` as the titles of the table. */
  const tabled = async (
    client: Runtime,
    read: Cell<Held>,
    expected: string[],
  ) => {
    const table = read.key("table") as unknown as Cell<Held["table"]>;
    cancels.push(table.sink(() => {}));
    await waitForCellValue<Held["table"]>(
      client,
      table,
      (held) =>
        JSON.stringify(held?.map((row) => row?.title)) ===
          JSON.stringify(expected),
      { stuckLabel: `a client reads the table ${JSON.stringify(expected)}` },
    );
  };

  /**
   * Resolves when a new client of `identity` reads `expected` as the byline
   * of the first item, through the link the result's list holds.
   */
  const byline = async (identity: Identity, expected: string) => {
    const client = clientOf(identity);
    const read = client.getCellFromLink<Held>(
      client.getCell<Held>(space, "hidden-made result")
        .getAsNormalizedFullLink(),
    );
    const held = read.key("items").key(0).key("byline") as unknown as Cell<
      string
    >;
    cancels.push(held.sink(() => {}));
    await waitForCellValue<string>(
      client,
      held,
      (value) => value === expected,
      { stuckLabel: `a client reads the byline ${expected}` },
    );
  };

  /**
   * The documents the serving runtime's store holds whose stored label map
   * holds a `User` clause of `principal`, each with the scope key of the
   * instance and the positions, for the instances of the space and of each
   * principal.
   */
  const carrying = (principal: Identity): string[] => {
    const [runtime] = serving.runtimes();
    const [piece] = serving.pieces();
    const digest = hashStringOf(principal.did());
    const found: string[] = [];
    const docs = new Set<string>();
    for (const doc of piece.instance.store.docs.keys()) {
      docs.add(doc.replace(/~(user|session):.*$/, "~$1"));
    }
    for (const viewer of [undefined, ann, bob]) {
      const tx = runtime.edit();
      if (viewer !== undefined) {
        tx.tx.scopeKeyIdentity = { principal: viewer.did() };
      }
      try {
        for (const doc of docs) {
          const link = piece.transactions.linkOf(doc, []);
          if ((link.scope === "space") !== (viewer === undefined)) continue;
          const metadata = readStoredCfcMetadata(tx, {
            space,
            id: link.id,
            scope: link.scope,
          });
          const positions = (metadata?.labelMap.entries ?? []).filter((
            { label },
          ) => usersIn(label).includes(digest)).map(({ path }) =>
            "/" + path.join("/")
          );
          if (positions.length > 0) {
            found.push(
              `${doc} [${viewer === undefined ? "space" : viewer.did()}] ${
                positions.join(" ")
              }`,
            );
          }
        }
      } finally {
        tx.abort();
      }
    }
    return found;
  };

  /**
   * The piece set up by Ann, both principals reading it and each named,
   * and one item Ann made, which Ann reads with her own nickname.
   */
  const madeByAnn = async () => {
    const [byAnnClient, byBobClient] = [clientOf(ann), clientOf(bob)];
    const tx = byAnnClient.edit();
    setUpCompiledPiece(
      byAnnClient,
      tx,
      PROGRAM,
      { items: [] },
      byAnnClient.getCell(space, "hidden-made result").withTx(tx),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
    const [byAnn, byBob] = [
      await opened(byAnnClient),
      await opened(byBobClient),
    ];
    await named(byAnnClient, byAnn, "Ann");
    await named(byBobClient, byBob, "Bob");

    (byAnn.key("add") as unknown as Cell<unknown>).send(
      { title: "First" } as never,
    );

    await tabled(byAnnClient, byAnn, ["First"]);
    await tabled(byBobClient, byBob, ["First"]);
    await byline(ann, "First, seen by Ann");
    await serving.host.whenQuiescent();
    return { byBobClient, byBob };
  };

  it("stores no `User` clause in a document of the space", async () => {
    await madeByAnn();

    expect(carrying(ann).filter((at) => at.includes("[space]"))).toEqual([]);
    expect(carrying(bob).filter((at) => at.includes("[space]"))).toEqual([]);
  });

  it("stores the `User` clause of each principal in that principal's instances alone", async () => {
    const { byBobClient, byBob } = await madeByAnn();
    // A derivation for Bob after the item was made.
    await named(byBobClient, byBob, "Bobby");
    await serving.host.whenQuiescent();

    // Each principal's own clause is where that principal's value is.
    expect(carrying(ann).length).toBeGreaterThan(0);
    expect(carrying(bob).length).toBeGreaterThan(0);
    expect(carrying(ann).filter((at) => !at.includes(ann.did()))).toEqual([]);
    expect(carrying(bob).filter((at) => !at.includes(bob.did()))).toEqual([]);
  });
});
