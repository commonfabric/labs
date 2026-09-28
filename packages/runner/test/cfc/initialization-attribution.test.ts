import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import { toDocumentPath } from "@commonfabric/memory/v2";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { JSONSchema } from "../../src/builder/types.ts";
import type { Cell } from "../../src/cell.ts";
import { cfcLabelViewForCell } from "../../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import {
  type RuntimeWritePolicyAuthorization,
  runtimeWritePolicyAuthorization,
} from "../../src/cfc/types.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { TransactionWrapper } from "../../src/storage/extended-storage-transaction.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager as V2StorageManager,
} from "../../src/storage/v2.ts";

const TEXT = "I, the person running this, endorse this statement";
const signer = await Identity.fromPassphrase("initialization-attribution");
const other = await Identity.fromPassphrase("initialization-attribution-other");

/** The DIDs every `represents-principal` claim in a label view names. */
const representedBy = (cell: Cell<unknown>): string[] => {
  const subjects = new Set<string>();
  for (const entry of cfcLabelViewForCell(cell)?.entries ?? []) {
    for (const atom of entry.label.integrity ?? []) {
      const claim = atom as { kind?: string; subject?: unknown };
      if (
        claim.kind === "represents-principal" &&
        typeof claim.subject === "string"
      ) {
        subjects.add(claim.subject);
      }
    }
  }
  return [...subjects].sort();
};

describe("initialization attribution", () => {
  describe("the mark on a transaction", () => {
    const space = signer.did();
    const writer = {
      __ctWriterIdentityOf: { file: "/trusted.tsx", path: ["save"] },
    };
    // profile-home's field shape: represents the current user, owner-bound.
    const claimSchema: JSONSchema = {
      type: "string",
      default: TEXT,
      ifc: {
        ownerPrincipal: { __ctCurrentPrincipal: true },
        addIntegrity: [{
          kind: "represents-principal",
          subject: { __ctCurrentPrincipal: true },
        }],
        writeAuthorizedBy: writer,
      },
    };
    let runtime: Runtime;
    let actingPrincipal: string;

    beforeEach(() => {
      actingPrincipal = signer.did();
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: StorageManager.emulate({ as: signer }),
        trustSnapshotProvider: () => ({
          id: actingPrincipal,
          actingPrincipal,
        }),
      });
    });

    afterEach(async () => {
      await runtime.dispose();
    });

    /**
     * Seeds a protected cell with its default, as serializing a constructed
     * `Writable` does, and returns who its stored label says it represents.
     */
    async function seedClaim(
      name: string,
      mark?: (tx: ReturnType<Runtime["edit"]>) => void,
    ): Promise<string[]> {
      const tx = runtime.edit();
      mark?.(tx);
      const seed = runtime.getCell(space, name, claimSchema, tx);
      const result = runtime.getCell(space, `${name}-result`, undefined, tx);
      result.set({ claim: seed });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const inspect = runtime.edit();
      expect(inspect.readValueOrThrow(seed.getAsNormalizedFullLink())).toBe(
        TEXT,
      );
      const stored = readStoredCfcMetadata(
        inspect,
        seed.getAsNormalizedFullLink(),
      );
      inspect.abort();
      return (stored?.labelMap.entries ?? [])
        .flatMap((entry) => entry.label.integrity ?? [])
        .filter((atom) =>
          (atom as { kind?: string }).kind === "represents-principal"
        )
        .map((atom) => (atom as { subject: unknown }).subject as string)
        .sort();
    }

    it("claims nobody for a seed in a transaction the runtime did not mark", async () => {
      expect(await seedClaim("unmarked")).toEqual([]);
    });

    it("claims the acting principal for a seed in a marked transaction", async () => {
      actingPrincipal = other.did();
      expect(
        await seedClaim(
          "marked",
          (tx) =>
            tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization),
        ),
      ).toEqual([other.did()]);
    });

    it("invalidates a preparation made before the mark", () => {
      const tx = runtime.edit();
      const seed = runtime.getCell(space, "held", claimSchema, tx);
      runtime.getCell(space, "held-result", undefined, tx).set({ claim: seed });
      runtime.prepareTxForCommit(tx);
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
      expect(tx.getCfcState().prepare.status).toBe("invalidated");
      expect(tx.getCfcState().attributedInitialization).toBe(true);
      // A second mark is no change.
      tx.markCfcAttributedInitialization(runtimeWritePolicyAuthorization);
      expect(tx.getCfcState().attributedInitialization).toBe(true);
      tx.abort();
    });

    it("marks through a transaction wrapper", () => {
      const tx = runtime.edit();
      new TransactionWrapper(tx, {}).markCfcAttributedInitialization(
        runtimeWritePolicyAuthorization,
      );
      expect(tx.getCfcState().attributedInitialization).toBe(true);
      tx.abort();
    });

    it("ignores a mark that does not carry the runtime's authorization", async () => {
      expect(
        await seedClaim(
          "forged",
          (tx) =>
            tx.markCfcAttributedInitialization(
              { forged: true } as unknown as RuntimeWritePolicyAuthorization,
            ),
        ),
      ).toEqual([]);
    });
  });

  describe("a piece with a represents-current-user field", () => {
    // Whichever runtime constructs an `Item` seeds its `claim` with the
    // pattern author's text: a runtime that starts the piece and finds a
    // seed it has not built constructs one, and so does the handler that
    // pushes a new `Item`.
    const PROGRAM: RuntimeProgram = {
      main: "/main.tsx",
      files: [
        {
          name: "/main.tsx",
          contents: [
            "import {",
            "  Cfc,",
            "  CurrentPrincipal,",
            "  Default,",
            "  handler,",
            "  navigateTo,",
            "  pattern,",
            "  RepresentsCurrentUser,",
            "  Stream,",
            "  Writable,",
            "  WriteAuthorizedBy,",
            "} from 'commonfabric';",
            "",
            `const TEXT = ${JSON.stringify(TEXT)};`,
            "",
            "type OwnedClaim<Binding> = RepresentsCurrentUser<",
            "  Cfc<WriteAuthorizedBy<string, Binding>, { ownerPrincipal: CurrentPrincipal }>",
            ">;",
            "",
            "const setItemClaim = handler<{ value: string }, { claim: Writable<string> }>(",
            "  (event, state) => state.claim.set(event.value),",
            ");",
            "",
            "interface ItemOutput {",
            "  label: string;",
            "  claim: OwnedClaim<typeof setItemClaim>;",
            "  setClaim: Stream<{ value: string }>;",
            "}",
            "",
            "const Item = pattern<{ label: string }, ItemOutput>(({ label }) => {",
            "  const claim = new Writable<OwnedClaim<typeof setItemClaim>>(TEXT).for('claim');",
            "  return { label, claim, setClaim: setItemClaim({ claim }) };",
            "});",
            "",
            "const setOwned = handler<{ value: string }, { owned: Writable<string> }>(",
            "  (event, state) => state.owned.set(event.value),",
            ");",
            "",
            "const addItem = handler<{ label: string }, { added: Writable<ItemOutput[]> }>(",
            "  (event, { added }) => {",
            "    added.push(Item({ label: event.label }) as ItemOutput);",
            "  },",
            ");",
            "",
            "// Opens the item it adds: its result pattern starts once the run commits.",
            "const openItem = handler<{ label: string }, { added: Writable<ItemOutput[]> }>(",
            "  (event, { added }) => {",
            "    const item = Item({ label: event.label }) as ItemOutput;",
            "    added.push(item);",
            "    navigateTo(item);",
            "  },",
            ");",
            "",
            "export default pattern<{ seeds: Default<string[], ['first']> }, {",
            "  owned: OwnedClaim<typeof setOwned>;",
            "  items: ItemOutput[];",
            "  added: ItemOutput[];",
            "  addItem: Stream<{ label: string }>;",
            "  openItem: Stream<{ label: string }>;",
            "}>(({ seeds }) => {",
            "  const owned = new Writable<OwnedClaim<typeof setOwned>>(TEXT).for('owned');",
            "  const items = seeds.map((label) => Item({ label }));",
            "  const added = new Writable<ItemOutput[]>([]).for('added');",
            "  return {",
            "    owned,",
            "    items,",
            "    added,",
            "    addItem: addItem({ added }),",
            "    openItem: openItem({ added }),",
            "  };",
            "});",
          ].join("\n"),
        },
      ],
    };
    const ANY = { type: "object", additionalProperties: true } as JSONSchema;
    const SEEDS: JSONSchema = { type: "array", items: { type: "string" } };
    const TEST_AUDIENCE = "did:key:z6Mk-runner-initialization-attribution";

    /** Speaks the wire protocol in-process against an ACL-enforcing server. */
    class LoopbackSessionFactory implements SessionFactory {
      readonly supportsAclBootstrap = true;
      readonly #server: MemoryV2Server.Server;

      constructor(server: MemoryV2Server.Server) {
        this.#server = server;
      }

      async create(
        space: MemorySpace,
        signer?: Signer,
        requested: MemoryV2Client.MountOptions = {},
      ) {
        const client = await MemoryV2Client.connect({
          transport: MemoryV2Client.loopback(this.#server),
        });
        const session = await client.mount(
          space,
          requested,
          (_space, _session, context) => ({
            invocation: {
              aud: context.audience,
              challenge: context.challenge.value,
            },
            authorization: { principal: signer?.did() },
          }),
        );
        return { client, session };
      }
    }

    class TestStorageManager extends V2StorageManager {
      static overServer(
        options: Omit<Options, "memoryHost">,
        factory: SessionFactory,
      ): TestStorageManager {
        return new TestStorageManager(
          { ...options, memoryHost: new URL("memory://") },
          factory,
        );
      }
    }

    let author: Identity;
    let runner: Identity;
    let reader: Identity;
    let spaceIdentity: Identity;
    let space: MemorySpace;
    let server: MemoryV2Server.Server;
    let factory: LoopbackSessionFactory;
    const runtimes: Runtime[] = [];

    beforeEach(async () => {
      author = await Identity.fromPassphrase("initialization-attribution-a");
      runner = await Identity.fromPassphrase("initialization-attribution-b");
      reader = await Identity.fromPassphrase("initialization-attribution-c");
      spaceIdentity = await Identity.fromPassphrase(
        "initialization-attribution-space",
      );
      space = spaceIdentity.did();
      server = new MemoryV2Server.Server({
        store: new URL(
          `memory://initialization-attribution-${crypto.randomUUID()}`,
        ),
        // Test-only: trust the asserted principal instead of verifying a
        // signature, as the memory package's own ACL tests do.
        authorizeSessionOpen(message) {
          const principal = (message.authorization as { principal?: unknown })
            ?.principal;
          return typeof principal === "string" ? principal : undefined;
        },
        sessionOpenAuth: { audience: TEST_AUDIENCE },
        acl: { mode: "enforce" },
        subscriptionRefreshDelayMs: 0,
      });
      factory = new LoopbackSessionFactory(server);
      // The author owns the space; anyone may write, as a profile space or a
      // lobby is granted.
      const genesis = await factory.create(space, spaceIdentity, {});
      try {
        await genesis.session.transact({
          localSeq: 1,
          reads: {
            confirmed: [{
              id: `of:${space}`,
              path: toDocumentPath([]),
              seq: 0,
            }],
            pending: [],
          },
          operations: [{
            op: "set",
            id: `of:${space}`,
            value: { value: { [author.did()]: "OWNER", "*": "WRITE" } },
          }],
        });
      } finally {
        await genesis.client.close();
      }
    });

    afterEach(async () => {
      for (const runtime of runtimes.splice(0)) {
        await runtime.dispose();
      }
      await server.close();
    });

    function open(identity: Identity): Runtime {
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: TestStorageManager.overServer(
          { as: identity },
          factory,
        ),
        experimental: { serverExecution: false },
        trustSnapshotProvider: () => ({
          id: identity.did(),
          actingPrincipal: identity.did(),
        }),
        // A handler here opens what it adds; where it goes is not asked.
        navigateCallback: () => {},
      });
      runtimes.push(runtime);
      return runtime;
    }

    /** What the stored label of a claim says, read by a runtime of its own. */
    async function claimAsReader(
      ...path: (string | number)[]
    ): Promise<{ value: unknown; representedBy: string[] }> {
      const runtime = open(reader);
      const piece = runtime.getCell(space, "piece", ANY);
      await piece.sync();
      let at = piece as Cell<unknown>;
      for (const step of path) at = at.key(step as never) as Cell<unknown>;
      const claim = at.resolveAsCell();
      await claim.sync();
      await runtime.idle();
      return { value: await claim.pull(), representedBy: representedBy(claim) };
    }

    /** Sends an event to a stream of the piece as `identity` and settles. */
    async function sendAs(
      identity: Identity,
      event: unknown,
      ...path: (string | number)[]
    ): Promise<void> {
      const runtime = open(identity);
      const piece = runtime.getCell(space, "piece");
      await piece.sync();
      expect(await runtime.start(piece)).toBe(true);
      await runtime.idle();
      let at = piece.asSchema(ANY) as Cell<unknown>;
      for (const step of path) at = at.key(step as never) as Cell<unknown>;
      await at.sync();
      const tx = runtime.edit();
      (at.withTx(tx) as Cell<unknown>).send(event);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await runtime.storageManager.synced();
      await runtime.idle();
    }

    it("attributes a seed to the principal whose act made it, and to no runtime that merely built it", async () => {
      // The author creates the piece: `owned`, set up in the creating
      // transaction, is their act and claims them. Item 0 is built by the
      // list builtin's action, nobody's act, and claims nobody.
      const a = open(author);
      const pattern = await a.patternManager.compilePattern(PROGRAM, { space });
      const seeds = a.getCell(space, "seeds", SEEDS);
      await a.editWithRetry((tx) => {
        seeds.withTx(tx).set(["first"]);
        a.prepareTxForCommit(tx);
      });
      const piece = a.getCell(space, "piece");
      await a.runSynced(piece, pattern, { seeds });
      await a.idle();
      await (piece.asSchema(ANY).key("items").key(0).key("claim") as Cell<
        unknown
      >).pull();
      await a.idle();
      await a.storageManager.synced();
      expect(await claimAsReader("owned")).toEqual({
        value: TEXT,
        representedBy: [author.did()],
      });
      expect(await claimAsReader("items", 0, "claim")).toEqual({
        value: TEXT,
        representedBy: [],
      });

      // The author appends a seed with a plain write. Nothing runs the piece
      // until another principal starts it and the list builds item 1, which
      // is nobody's act; `owned` keeps its claim.
      const a2 = open(author);
      const seeds2 = a2.getCell(space, "seeds", SEEDS);
      await seeds2.sync();
      await a2.editWithRetry((tx) => {
        seeds2.withTx(tx).set(["first", "second"]);
        a2.prepareTxForCommit(tx);
      });
      await a2.storageManager.synced();
      const b = open(runner);
      const asRunner = b.getCell(space, "piece");
      await asRunner.sync();
      expect(await b.start(asRunner)).toBe(true);
      await b.idle();
      await (asRunner.asSchema(ANY).key("items").key(1).key("claim") as Cell<
        unknown
      >).pull();
      await b.idle();
      await b.storageManager.synced();
      expect(await claimAsReader("items", 1, "claim")).toEqual({
        value: TEXT,
        representedBy: [],
      });
      expect(await claimAsReader("owned")).toEqual({
        value: TEXT,
        representedBy: [author.did()],
      });

      // A write through the field's handler is the actor's.
      await sendAs(author, { value: "endorsed" }, "items", 1, "setClaim");
      expect(await claimAsReader("items", 1, "claim")).toEqual({
        value: "endorsed",
        representedBy: [author.did()],
      });

      // An item a handler run builds is seeded on behalf of the principal
      // who invoked the handler, pattern default and all.
      await sendAs(runner, { label: "third" }, "addItem");
      expect(await claimAsReader("added", 0, "claim")).toEqual({
        value: TEXT,
        representedBy: [runner.did()],
      });

      // So is one the handler opens, whose result pattern starts in a
      // transaction deferred until the run commits.
      await sendAs(runner, { label: "fourth" }, "openItem");
      expect(await claimAsReader("added", 1, "claim")).toEqual({
        value: TEXT,
        representedBy: [runner.did()],
      });
    });
  });
});
