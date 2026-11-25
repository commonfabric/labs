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
  argumentDocumentOf,
  setUpCompiledPiece,
} from "../../src/compiled/setup.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";

const fixture = (extension: string): URL =>
  new URL(
    `../../../../base/pattern-compiler/compare/fixtures/session-draft.${extension}`,
    import.meta.url,
  );

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(fixture("emit.json")),
) as { patterns: Artifact[] }[];
const MAIN = patterns.find(({ name }) => name === "default")!;
const PROGRAM = {
  main: "/session-draft.tsx",
  files: [{
    name: "/session-draft.tsx",
    contents: await Deno.readTextFile(fixture("tsx")),
  }],
};

type Held = {
  draft: string;
  nickname: string;
  author: string;
  count: number;
  submit: unknown;
};

// `fixtures/session-draft.tsx`, the Topics board's composer: a draft of the
// scope `session` and a nickname of the scope `user`, which a client writes
// through the links the result holds as the shell's `$value` binding does,
// and a handler that reads the draft and the nickname through a `computed`
// and appends both to a list of the space where neither is blank. The
// serving loop runs the handler for the client that sent the event.
describe("a handler of a compiled piece that reads state of the scope `session` a client wrote, under the serving loop", () => {
  let serving: CompiledServingMemoryServer;
  let clients: Runtime[];
  let cancels: (() => void)[];
  let space: MemorySpace;

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

  /** Resolves when `client` reads a member of the result `read` `held` matches. */
  const reads = async <K extends keyof Held>(
    client: Runtime,
    read: Cell<Held>,
    key: K,
    held: (value: Held[K] | undefined) => boolean,
    label: string,
  ): Promise<void> => {
    const member = read.key(key) as unknown as Cell<Held[K]>;
    cancels.push(member.sink(() => {}));
    await waitForCellValue<Held[K]>(client, member, held, {
      stuckLabel: label,
    });
  };

  /** Sets the piece up from `client`, in the space of `identity`. */
  const setUp = async (client: Runtime, identity: Identity) => {
    space = identity.did();
    const result = client.getCell<Held>(space, "session-draft result");
    const tx = client.edit();
    setUpCompiledPiece(client, tx, PROGRAM, { notes: [] }, result.withTx(tx));
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** The result as `client` reads it, once it holds its stream. */
  const opened = async (client: Runtime) => {
    const read = client.getCellFromLink<Held>(
      client.getCell<Held>(space, "session-draft result")
        .getAsNormalizedFullLink(),
    );
    cancels.push(read.sink(() => {}));
    await reads(
      client,
      read,
      "submit",
      (stream) => stream !== undefined,
      "a client reads the stream of the piece",
    );
    return read;
  };

  /**
   * Writes `value` into the cell the link at `key` of `read` leads to, as
   * the shell's `$value` binding writes the cell it holds, and returns
   * that cell.
   */
  const typed = async (
    client: Runtime,
    read: Cell<Held>,
    key: "draft" | "nickname",
    value: string,
  ): Promise<Cell<string>> => {
    const cell = read.key(key).resolveAsCell() as unknown as Cell<string>;
    cancels.push(cell.sink(() => {}));
    const tx = client.edit();
    cell.withTx(tx).set(value);
    expect((await tx.commit().settled).error).toBeUndefined();
    return cell;
  };

  /**
   * Resolves when `client` reads `expected` in the list of notes, as the
   * argument document of the piece holds it.
   */
  const holdsNotes = async (client: Runtime, expected: string[]) => {
    const argument = client.getCellFromLink({
      space,
      id: argumentDocumentOf(
        client.getCell(space, "session-draft result").getAsNormalizedFullLink()
          .id,
      ),
      path: ["notes"],
      scope: "space",
    }) as unknown as Cell<string[]>;
    cancels.push(argument.sink(() => {}));
    await waitForCellValue<string[]>(
      client,
      argument,
      (held) => JSON.stringify(held) === JSON.stringify(expected),
      { stuckLabel: `a client reads the notes ${JSON.stringify(expected)}` },
    );
  };

  it("appends the draft the client wrote under its nickname, and clears the draft", async () => {
    const ann = await Identity.fromPassphrase("compiled session draft ann");
    const client = clientOf(ann);
    await setUp(client, ann);
    const read = await opened(client);
    await typed(client, read, "nickname", "Ann");
    const draft = await typed(client, read, "draft", "A topic");

    (read.key("submit") as unknown as Cell<unknown>).send(undefined as never);

    await holdsNotes(client, ["Ann: A topic"]);
    await waitForCellValue<string>(client, draft, (held) => held === "", {
      stuckLabel: "the client reads the draft cleared",
    });
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("derives again from a value of the scope `user` that the client wrote after the piece read it as absent", async () => {
    const ann = await Identity.fromPassphrase("compiled session draft ann");
    const client = clientOf(ann);
    await setUp(client, ann);
    const read = await opened(client);
    // The piece has derived the author for the client's user from no
    // nickname at all.
    await reads(client, read, "author", (author) => author === "", "no author");

    await typed(client, read, "nickname", " Ann ");

    await reads(client, read, "author", (author) => author === "Ann", "Ann");
    expect(serving.pieces()[0].refusals).toEqual([]);
  });

  it("reads the draft of the session that sent the event", async () => {
    const ann = await Identity.fromPassphrase("compiled session draft ann");
    const [first, second] = [clientOf(ann), clientOf(ann)];
    await setUp(first, ann);
    const [byFirst, bySecond] = [await opened(first), await opened(second)];
    await typed(first, byFirst, "nickname", "Ann");
    const firstDraft = await typed(first, byFirst, "draft", "From the first");
    await typed(second, bySecond, "draft", "From the second");

    (bySecond.key("submit") as unknown as Cell<unknown>).send(
      undefined as never,
    );

    await holdsNotes(first, ["Ann: From the second"]);
    expect(firstDraft.get()).toBe("From the first");
    expect(serving.pieces()[0].refusals).toEqual([]);
  });
});
