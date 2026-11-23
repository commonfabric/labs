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
import {
  type PatternProgram,
  setUpCompiledPiece,
} from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (name: string, extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/${name}.${extension}`,
    import.meta.url,
  );

const FIXTURES = ["scoped", "scoped-rows"];
const ARTIFACTS = new Map<string, Artifact>();
const PROGRAMS = new Map<string, PatternProgram>();
for (const name of FIXTURES) {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(fixture(name, "emit.json")),
  ) as { patterns: Artifact[] }[];
  ARTIFACTS.set(name, patterns.find(({ name }) => name === "default")!);
  PROGRAMS.set(name, {
    main: `/${name}.tsx`,
    files: [{
      name: `/${name}.tsx`,
      contents: await Deno.readTextFile(fixture(name, "tsx")),
    }],
  });
}

type Held = {
  nickname: string;
  count: number;
  summary: string;
  greeting: string;
  rename: unknown;
  post: unknown;
};

// Two clients with server execution on, each with an identity of its own,
// read one compiled piece of the space of the first. The serving loop runs
// the piece for each of them: `fixtures/scoped.tsx` declares a nickname of
// the scope `user` and reads a list of the space.
describe("a compiled piece that two principals demand under the serving loop", () => {
  let ann: Identity;
  let bob: Identity;
  let space: MemorySpace;
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];

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

  beforeEach(async () => {
    ann = await Identity.fromPassphrase("compiled piece scoped ann");
    bob = await Identity.fromPassphrase("compiled piece scoped bob");
    space = ann.did();
    serving = await listenCompiledServingMemoryServer({
      // The crate's binary is not run here: what stands in its place gives
      // the artifact the crate emitted for the fixture the program names.
      compile: (program) =>
        Promise.resolve({
          main: ARTIFACTS.get(program.main.slice(1, -".tsx".length))!,
          artifacts: () => undefined,
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

  /** The result of the piece `name` as `client` reads it. */
  const readBy = <T>(client: Runtime, name: string): Cell<T> => {
    const read = client.getCellFromLink<T>(
      client.getCell<T>(space, `${name} result`).getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    return read;
  };

  /** Sets the fixture `name` up from `client` over `argument`. */
  const setUp = async (client: Runtime, name: string, argument: unknown) => {
    const result = client.getCell(space, `${name} result`);
    const tx = client.edit();
    setUpCompiledPiece(
      client,
      tx,
      PROGRAMS.get(name)!,
      argument,
      result.withTx(tx),
    );
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /**
   * Resolves when `client` reads `value` at the member `key` of the result
   * `read`. The wait is on the member, so that a change of the document a
   * link at the member leads to wakes it.
   */
  const reads = async <K extends keyof Held>(
    client: Runtime,
    read: Cell<Held>,
    key: K,
    value: Held[K],
  ): Promise<void> => {
    const member = read.key(key) as unknown as Cell<Held[K]>;
    cancels.push(member.sink(() => {}));
    await waitForCellValue<Held[K]>(
      client,
      member,
      (held) => held === value,
      { stuckLabel: `a client reads ${JSON.stringify(value)} at \`${key}\`` },
    );
  };

  /** Resolves when `client` reads the streams of the result `read`. */
  const readsStreams = (client: Runtime, read: Cell<Held>) =>
    waitForCellValue<Held>(
      client,
      read,
      (held) => held?.rename !== undefined && held?.post !== undefined,
      { stuckLabel: "a client reads the streams of the piece" },
    );

  const send = (read: Cell<Held>, stream: "rename" | "post", event: unknown) =>
    (read.key(stream) as unknown as Cell<unknown>).send(event as never);

  /** Both clients, each reading the piece once it holds its streams. */
  const started = async () => {
    const [first, second] = [clientOf(ann), clientOf(bob)];
    await setUp(first, "scoped", { notes: ["one"] });
    const [byAnn, byBob] = [
      readBy<Held>(first, "scoped"),
      readBy<Held>(second, "scoped"),
    ];
    await readsStreams(first, byAnn);
    await readsStreams(second, byBob);
    return { first, second, byAnn, byBob };
  };

  it("keeps the state of the scope `user` of each principal apart", async () => {
    const { first, second, byAnn, byBob } = await started();

    send(byAnn, "rename", { name: "Ann" });
    send(byBob, "rename", { name: "Bob" });

    await reads(first, byAnn, "nickname", "Ann");
    await reads(first, byAnn, "summary", "Ann reads 1");
    await reads(second, byBob, "nickname", "Bob");
    await reads(second, byBob, "summary", "Bob reads 1");
    await reads(first, byAnn, "count", 1);
    await reads(second, byBob, "count", 1);
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("gives both principals a value of the space that one of them changed", async () => {
    const { first, second, byAnn, byBob } = await started();
    send(byAnn, "rename", { name: "Ann" });
    await reads(first, byAnn, "summary", "Ann reads 1");

    send(byBob, "post", { text: "two" });

    await reads(first, byAnn, "count", 2);
    await reads(second, byBob, "count", 2);
    await reads(first, byAnn, "summary", "Ann reads 2");
    await reads(second, byBob, "summary", "nobody reads 2");
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("stores what it derived for a principal in the instances of that principal alone", async () => {
    const { first, second, byAnn, byBob } = await started();
    send(byAnn, "rename", { name: "Annabel" });
    send(byBob, "rename", { name: "Robert" });
    await reads(first, byAnn, "summary", "Annabel reads 1");
    await reads(second, byBob, "summary", "Robert reads 1");

    // What the store holds of each document of the piece: the instance of
    // the space, and the instance of each principal of a document of the
    // scope `user`, read by the key of the instance.
    const [piece] = serving.pieces();
    const [runtime] = serving.runtimes();
    const held = (principal?: Identity): string => {
      const tx = runtime.edit();
      // The transaction reads the instances of the identity it carries.
      if (principal !== undefined) {
        tx.tx.scopeKeyIdentity = { principal: principal.did() };
      }
      const instances = principal === undefined
        ? undefined
        : `~user:${encodeURIComponent(principal.did())}`;
      try {
        return [...piece.instance.store.docs.keys()].flatMap((doc) => {
          if (instances === undefined) return doc.includes("~") ? [] : [doc];
          // The name the executor has for the instances of every key.
          return doc.endsWith(instances)
            ? [doc.slice(0, -instances.length) + "~user"]
            : [];
        }).map((doc) =>
          JSON.stringify(
            tx.readValueOrThrow(piece.transactions.linkOf(doc, [])),
          )
        ).join("\n");
      } finally {
        tx.abort();
      }
    };
    const ofSpace = held();
    const ofAnn = held(ann);
    const ofBob = held(bob);

    expect(ofSpace).not.toContain("Annabel");
    expect(ofSpace).not.toContain("Robert");
    expect(ofAnn).toContain("Annabel reads 1");
    expect(ofAnn).not.toContain("Robert");
    expect(ofBob).toContain("Robert reads 1");
    expect(ofBob).not.toContain("Annabel");
  });

  it("holds the state of each principal when another serving loop takes the space over", async () => {
    const { first, second, byAnn, byBob } = await started();
    send(byAnn, "rename", { name: "Ann" });
    send(byBob, "rename", { name: "Bob" });
    await reads(first, byAnn, "summary", "Ann reads 1");
    await reads(second, byBob, "summary", "Bob reads 1");
    await serving.host.whenQuiescent();

    await serving.restart();
    // Clients that connect to the serving process that started again.
    const [later, latest] = [clientOf(ann), clientOf(bob)];
    const [againByAnn, againByBob] = [
      readBy<Held>(later, "scoped"),
      readBy<Held>(latest, "scoped"),
    ];
    await reads(later, againByAnn, "summary", "Ann reads 1");
    await reads(latest, againByBob, "summary", "Bob reads 1");

    send(againByBob, "post", { text: "two" });

    await reads(later, againByAnn, "summary", "Ann reads 2");
    await reads(latest, againByBob, "summary", "Bob reads 2");
    await reads(later, againByAnn, "nickname", "Ann");
    await reads(latest, againByBob, "nickname", "Bob");
    expect(serving.pieces().flatMap((piece) => piece.refusals)).toEqual([]);
  });
});
