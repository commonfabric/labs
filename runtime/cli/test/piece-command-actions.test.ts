/**
 * The `cf piece` actions that open a connection, driven over a runtime this
 * process holds. Each case hands the action that runtime's controller in
 * place of a connection and collects what it renders, so the assertions read
 * what a person at the command line would see, and what the space holds
 * afterwards.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import { ValidationError } from "@cliffy/command";
import { createSession, Identity } from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import type { DID } from "@commonfabric/identity/did";
import { PieceController, PiecesController } from "@commonfabric/piece/ops";
import { Runtime, type RuntimeProgram } from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  applyPieceInputFromCommand,
  linkPiecesFromCommand,
  listPieceVerbsFromCommand,
  mapSpaceFromCommand,
  type PieceCommandDependencies,
  removePieceFromCommand,
  renderPieceFromCommand,
  savePiecePatternFromCommand,
  setPieceSlugFromCommand,
  setsrcFromCommand,
  type SignalListeners,
  stepPieceFromCommand,
  untilInterrupted,
  viewPieceFromCommand,
} from "../commands/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";

const signer = await Identity.fromPassphrase("piece-command-actions");

function program(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

/** A piece with a view, a name, two data fields, and one verb. */
const CARD = program(`
import { action, Default, NAME, pattern, UI } from "commonfabric";

interface Input {
  title: Default<string, "Untitled">;
  tags: Default<string[], []>;
}

export default pattern<Input>(({ title, tags }) => {
  const addTag = action((event: { tag: string }) => {
    tags.push(event.tag);
  });
  return {
    [NAME]: title,
    [UI]: <div><h1>{title}</h1><p>tagged</p></div>,
    title,
    tags,
    addTag,
  };
});
`);

/** A piece that publishes no view and exposes no verb. */
const PLAIN = program(`
import { Default, pattern } from "commonfabric";

interface Input {
  names: Default<string[], []>;
}

export default pattern<Input>(({ names }) => ({ names }));
`);

/** What an action rendered: each value, and whether it asked for JSON. */
interface Rendered {
  value: unknown;
  json: boolean;
}

describe("piece-command-actions", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let pieces: PiecesController;
  let space: DID;
  let rendered: Rendered[];
  let hints: string[];
  let deps: PieceCommandDependencies;

  beforeEach(async () => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: signer });
    space = (await Identity.generate()).did();
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
    );
    await pieces.synced();
    rendered = [];
    hints = [];
    deps = {
      loadPieces: () => Promise.resolve(pieces),
      render: (value: unknown, options?: { json?: boolean }) => {
        rendered.push({ value, json: options?.json === true });
      },
      hint: (message) => hints.push(message),
    };
    resetWriteReceipts();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  /** The target options naming `piece` in the test's space. */
  function target(piece?: string) {
    return {
      apiUrl: "http://localhost:9999",
      identity: "/nonexistent/keyfile",
      space,
      explicitSpace: true,
      ...(piece === undefined ? {} : { cell: piece }),
    };
  }

  async function create(
    source: RuntimeProgram,
    input: Record<string, unknown>,
  ): Promise<PieceController> {
    const pattern = await runtime.patternManager.compilePattern(source, {
      space,
    });
    const cell = await pieces.runPersistent(pattern, input, undefined, {
      start: true,
    });
    await pieces.synced();
    return new PieceController(pieces, cell);
  }

  const values = () => rendered.map((entry) => entry.value);

  describe("stepPieceFromCommand()", () => {
    it("renders the piece it stepped", async () => {
      const card = await create(CARD, { title: "Stepped" });

      await stepPieceFromCommand(target(card.id), deps);

      expect(values()).toEqual([`Stepped piece ${card.id}`]);
    });
  });

  describe("applyPieceInputFromCommand()", () => {
    it("writes what standard input holds as the piece's input", async () => {
      const card = await create(CARD, { title: "Before" });

      await applyPieceInputFromCommand(target(card.id), {
        ...deps,
        drainStdin: () => Promise.resolve({ title: "After", tags: ["new"] }),
      });

      expect(await card.input.get()).toEqual({
        title: "After",
        tags: ["new"],
      });
    });
  });

  describe("savePiecePatternFromCommand()", () => {
    it("writes the piece's source files under the directory named", async () => {
      const card = await create(CARD, { title: "Saved" });
      const outDir = await Deno.makeTempDir();
      try {
        await savePiecePatternFromCommand(target(card.id), outDir, deps);

        expect(await Deno.readTextFile(join(outDir, "main.tsx"))).toBe(
          CARD.files[0].contents,
        );
      } finally {
        await Deno.remove(outDir, { recursive: true });
      }
    });
  });

  describe("viewPieceFromCommand()", () => {
    it("renders the piece's view as a tree", async () => {
      const card = await create(CARD, { title: "Viewed" });

      await viewPieceFromCommand(target(card.id), deps);

      expect(values()).toEqual([
        "└─ div\n   ├─ h1\n   │  └─ Viewed\n   └─ p\n      └─ tagged",
      ]);
    });

    it("renders the view node as JSON under `json`", async () => {
      const card = await create(CARD, { title: "Viewed" });

      await viewPieceFromCommand({ ...target(card.id), json: true }, deps);

      expect(rendered).toHaveLength(1);
      expect(rendered[0].json).toBe(true);
      expect(rendered[0].value).toMatchObject({ type: "vnode", name: "div" });
    });

    it("renders a placeholder for a piece that publishes no view", async () => {
      const plain = await create(PLAIN, {});

      await viewPieceFromCommand(target(plain.id), deps);

      expect(rendered).toEqual([{ value: "<no view data>", json: false }]);
    });

    it("renders `null` as JSON for a piece that publishes no view", async () => {
      const plain = await create(PLAIN, {});

      await viewPieceFromCommand({ ...target(plain.id), json: true }, deps);

      expect(rendered).toEqual([{ value: null, json: true }]);
    });
  });

  describe("renderPieceFromCommand()", () => {
    it("renders the piece's view as HTML", async () => {
      const card = await create(CARD, { title: "Rendered" });

      await renderPieceFromCommand(target(card.id), deps);

      expect(rendered).toEqual([{
        value: "<div><h1>Rendered</h1><p>tagged</p></div>",
        json: false,
      }]);
    });

    it("renders the HTML inside a JSON object under `json`", async () => {
      const card = await create(CARD, { title: "Rendered" });

      await renderPieceFromCommand({ ...target(card.id), json: true }, deps);

      expect(rendered).toEqual([{
        value: { html: "<div><h1>Rendered</h1><p>tagged</p></div>" },
        json: true,
      }]);
    });

    it("renders a placeholder for a piece with no view", async () => {
      const plain = await create(PLAIN, {});

      await renderPieceFromCommand(target(plain.id), deps);

      expect(values()).toEqual(["<piece has no UI>"]);
    });

    it("throws for a piece with no view under `json`, rendering nothing", async () => {
      const plain = await create(PLAIN, {});

      await expect(
        renderPieceFromCommand({ ...target(plain.id), json: true }, deps),
      ).rejects.toThrow(`Piece ${plain.id} has no UI`);
      expect(rendered).toEqual([]);
    });

    it("throws an error other than a missing view as it stands, rendering nothing", async () => {
      await expect(
        renderPieceFromCommand(target("fid1:refused"), {
          ...deps,
          loadPieces: () => Promise.reject(new Error("server unreachable")),
        }),
      ).rejects.toThrow("server unreachable");
      expect(rendered).toEqual([]);
    });
  });

  describe("linkPiecesFromCommand()", () => {
    it("links the source field into the target field and renders the link", async () => {
      const source = await create(CARD, { title: "Source", tags: ["a"] });
      const sink = await create(PLAIN, {});

      await linkPiecesFromCommand(
        target(),
        `${source.id}/tags`,
        `${sink.id}/names`,
        deps,
      );

      expect(values()).toEqual([
        `Linked ${source.id}/tags to ${sink.id}/names`,
      ]);
      expect(hints.join("\n")).toContain(
        `cf piece inspect --cell ${sink.id}`,
      );
      expect(await sink.result.get()).toEqual({ names: ["a"] });
    });

    it("throws for a target with no path, linking nothing", async () => {
      const source = await create(CARD, { title: "Source" });
      const sink = await create(PLAIN, {});

      await expect(
        linkPiecesFromCommand(target(), `${source.id}/tags`, sink.id, deps),
      ).rejects.toThrow(ValidationError);
      expect(rendered).toEqual([]);
    });

    it("throws for a SQLite source whose target has no path", async () => {
      const sink = await create(PLAIN, {});

      await expect(
        linkPiecesFromCommand(target(), "sqlite:/tmp/ref.db", sink.id, deps),
      ).rejects.toThrow("Target reference must include a path");
    });

    describe("a link that does not validate", () => {
      // Each case names an endpoint the link cannot use. The action reports
      // the refusal as a data error, and the stub exit throws in place of
      // ending the process.

      /** Runs the link and returns what it printed on its way to exit 1. */
      async function refusal(
        sourceRef: string,
        targetRef: string,
        options: { allowNonExisting?: boolean } = {},
      ): Promise<string> {
        const errors: string[] = [];
        const exits: number[] = [];
        await expect(
          linkPiecesFromCommand(
            { ...target(), ...options },
            sourceRef,
            targetRef,
            {
              ...deps,
              printError: (message) => errors.push(message),
              exit: (code) => {
                exits.push(code);
                throw new Error("exited");
              },
            },
          ),
        ).rejects.toThrow("exited");
        expect(exits).toEqual([1]);
        expect(rendered).toEqual([]);
        return errors.join("\n");
      }

      /** A document in the space that no pattern made. */
      async function plainDocument(): Promise<string> {
        const tx = runtime.edit();
        const cell = runtime.getCell<unknown>(
          space,
          "not-a-piece",
          undefined,
          tx,
        );
        cell.set({ names: ["x"] });
        await tx.commit().settled;
        const id = pieceId(cell);
        if (id === undefined) throw new Error("The document has no id.");
        return id;
      }

      it("reports a source that is not a piece", async () => {
        const plain = await plainDocument();
        const sink = await create(PLAIN, {});

        expect(await refusal(`${plain}/names`, `${sink.id}/names`)).toContain(
          `Source piece ${plain} does not have pattern`,
        );
      });

      it("reports a target that is not a piece", async () => {
        const source = await create(CARD, { title: "Source" });
        const plain = await plainDocument();

        expect(await refusal(`${source.id}/tags`, `${plain}/names`)).toContain(
          `Target piece ${plain} does not have pattern`,
        );
      });

      it("reports a source path the piece lacks, and hints at inspecting the piece", async () => {
        const source = await create(CARD, { title: "Source" });
        const sink = await create(PLAIN, {});

        expect(
          await refusal(`${source.id}/missing`, `${sink.id}/names`),
        ).toContain(
          `Source path "missing" does not exist on piece ${source.id}`,
        );
        expect(hints.join("\n")).toContain(
          `cf piece inspect --cell ${source.id}`,
        );
      });

      it("reports a source path that runs through a scalar", async () => {
        const source = await create(CARD, { title: "Source" });
        const sink = await create(PLAIN, {});

        expect(
          await refusal(`${source.id}/title/deeper`, `${sink.id}/names`),
        ).toContain(
          `Source path "title/deeper" does not exist on piece ${source.id}`,
        );
      });

      it("reports a target path the input does not hold yet", async () => {
        const source = await create(CARD, { title: "Source" });
        const sink = await create(PLAIN, {});

        expect(
          await refusal(`${source.id}/title`, `${sink.id}/names/0`),
        ).toContain(
          `Target path "names/0" does not exist on piece ${sink.id}`,
        );
      });

      // What the refusal of a path the input schema does not declare says.
      const SCHEMA_REFUSAL =
        'Cannot access path "elsewhere" - property "elsewhere" not found in ' +
        "the current pattern's input schema.";

      it("reports a target path the input schema has no place for", async () => {
        const source = await create(CARD, { title: "Source" });
        const sink = await create(PLAIN, {});

        const message = await refusal(
          `${source.id}/title`,
          `${sink.id}/elsewhere`,
        );
        expect(message).toContain(SCHEMA_REFUSAL);
        expect(message).not.toContain("does not exist on piece");
      });

      it("reports a target path the input schema has no place for under `allowNonExisting`", async () => {
        const source = await create(CARD, { title: "Source" });
        const sink = await create(PLAIN, {});

        expect(
          await refusal(`${source.id}/title`, `${sink.id}/elsewhere`, {
            allowNonExisting: true,
          }),
        ).toContain(SCHEMA_REFUSAL);
      });
    });
  });

  describe("mapSpaceFromCommand()", () => {
    // Registering a piece, and finding which registered pieces read which,
    // both take the space's default pattern, which these cases have no server
    // to compile. So the registry is the list each case names, and the reads
    // are the `[reader, source]` pairs it names.

    let registry: PieceController[];
    let reads: [PieceController, PieceController][];

    beforeEach(() => {
      registry = [];
      reads = [];
      pieces.getRegisteredPieces = () => Promise.resolve(registry);
      pieces.getReadingFrom = (cell) =>
        Promise.resolve(
          reads.filter(([reader]) => reader.id === pieceId(cell))
            .map(([, source]) => source.getCell()),
        );
      pieces.getReadByPieces = (cell) =>
        Promise.resolve(
          reads.filter(([, source]) => source.id === pieceId(cell))
            .map(([reader]) => reader.getCell()),
        );
    });

    it("renders each registered piece by its name, or by a short id where it has none, with what it reads and what reads it", async () => {
      const source = await create(CARD, { title: "Producer", tags: ["a"] });
      const sink = await create(PLAIN, {});
      const loner = await create(CARD, { title: "Loner" });
      registry = [loner, source, sink];
      reads = [[sink, source]];
      const sinkShort = `${sink.id.slice(0, 8)}...`;

      await mapSpaceFromCommand(target(), deps);

      const [map] = values();
      expect(map).toContain("=== Piece Space Map ===");
      expect(map).toContain(
        `📦 Producer [${source.id.slice(0, 8)}...${source.id.slice(-8)}]\n` +
          `  → read by:\n    • ${sinkShort}`,
      );
      expect(map).toContain(
        `📦 ${sinkShort}${sink.id.slice(-8)} [`,
      );
      expect(map).toContain("  ← reads from:\n    • Producer\n");
      expect(map).toContain(
        `📦 Loner [${loner.id.slice(0, 8)}...${loner.id.slice(-8)}]\n` +
          "  (no connections)\n",
      );
    });

    it("renders Graphviz DOT for `format` dot, with an edge from each source to its reader", async () => {
      const source = await create(CARD, { title: "Producer", tags: ["a"] });
      const sink = await create(PLAIN, {});
      registry = [source, sink];
      reads = [[sink, source]];

      await mapSpaceFromCommand({ ...target(), format: "dot" }, deps);

      const [dot] = values();
      expect(dot).toMatch(/^digraph PieceSpace \{/);
      expect(dot).toContain(`"${source.id}" [label="Producer\\n`);
      expect(dot).toContain(`"${sink.id}" [label="${sink.id.slice(0, 8)}...`);
      expect(dot).toContain(`"${source.id}" -> "${sink.id}";`);
      expect(dot).not.toContain(`"${sink.id}" -> "${source.id}";`);
    });
  });

  describe("listPieceVerbsFromCommand()", () => {
    it("renders a row per verb and points at the per-verb help", async () => {
      const card = await create(CARD, { title: "Verbs" });

      await listPieceVerbsFromCommand(target(card.id), deps);

      expect(values().join("\n")).toContain("addTag");
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain(`cf piece call --cell ${card.id} <verb>`);
    });

    it("renders the listing as one JSON document under `json`", async () => {
      const card = await create(CARD, { title: "Verbs" });

      await listPieceVerbsFromCommand({ ...target(card.id), json: true }, deps);

      expect(rendered).toHaveLength(1);
      expect(rendered[0].json).toBe(true);
      expect(JSON.stringify(rendered[0].value)).toContain('"addTag"');
      expect(hints).toEqual([]);
    });

    it("gives no per-verb hint for a piece with no verbs", async () => {
      const plain = await create(PLAIN, {});

      await listPieceVerbsFromCommand({ ...target(plain.id), all: true }, deps);

      expect(values()).toEqual(["<no callable verbs>"]);
      expect(hints).toEqual([]);
    });
  });

  describe("removePieceFromCommand()", () => {
    // Registering a piece takes the space's default pattern, which these
    // cases have no server to compile, so the registry is a set each case
    // fills.

    let registered: Set<string>;

    beforeEach(() => {
      registered = new Set();
      pieces.remove = (piece) => {
        expect(typeof piece).toBe("string");
        return Promise.resolve(registered.delete(String(piece)));
      };
    });

    it("removes the piece from the registry and renders its removal", async () => {
      const card = await create(CARD, { title: "Doomed" });
      registered.add(card.id);

      await removePieceFromCommand(target(card.id), deps);

      expect(values()).toEqual([`Removed piece ${card.id}`]);
      expect(registered.has(card.id)).toBe(false);
    });

    it("throws naming a piece the registry does not hold, rendering nothing", async () => {
      const card = await create(CARD, { title: "Unlisted" });

      await expect(removePieceFromCommand(target(card.id), deps)).rejects
        .toThrow(`Piece "${card.id}" not found`);
      expect(rendered).toEqual([]);
    });
  });

  describe("setPieceSlugFromCommand()", () => {
    it("points the slug at the piece and renders where it now leads", async () => {
      const card = await create(CARD, { title: "Slugged" });

      await setPieceSlugFromCommand(target(), "my-card", card.id, deps);

      expect(values()).toEqual([`Set slug my-card to ${card.id}`]);
      expect(hints.join("\n")).toContain(
        `http://localhost:9999/${space}/my-card`,
      );
    });
  });

  describe("setsrcFromCommand()", () => {
    const config = {
      apiUrl: "http://localhost:9999",
      space: "did:key:z6Mkspace",
      identity: "/nonexistent/keyfile",
      piece: "fid1:checked",
    };

    it("renders the check's summary under `check`, and applies nothing", async () => {
      const applied: string[] = [];

      await setsrcFromCommand({ check: true }, "./main.tsx", {
        ...deps,
        checkPieceSourceFromCommand: (_options, mainPath) =>
          Promise.resolve({
            config,
            report: {
              compatible: true,
              issues: {},
              candidate: { identity: "identity", symbol: "default" },
            },
            summary: `${mainPath} can replace the source`,
          }),
        applyPieceSourceCommandAction: (_options, mainPath) => {
          applied.push(mainPath);
          return Promise.resolve();
        },
      });

      expect(values()).toEqual(["./main.tsx can replace the source"]);
      expect(hints.join("\n")).toContain(
        "cf piece setsrc --cell fid1:checked ./main.tsx",
      );
      expect(applied).toEqual([]);
    });

    it("applies the source without `check`, and checks nothing", async () => {
      const applied: string[] = [];
      const checked: string[] = [];

      await setsrcFromCommand({}, "./main.tsx", {
        ...deps,
        checkPieceSourceFromCommand: (_options, mainPath) => {
          checked.push(mainPath);
          return Promise.reject(new Error("checked"));
        },
        applyPieceSourceCommandAction: (_options, mainPath) => {
          applied.push(mainPath);
          return Promise.resolve();
        },
      });

      expect(applied).toEqual(["./main.tsx"]);
      expect(checked).toEqual([]);
      expect(rendered).toEqual([]);
    });
  });

  describe("untilInterrupted()", () => {
    /** A signal source that delivers `SIGINT` when the case says so. */
    function signalSource() {
      const listeners = new Set<() => void>();
      const signals: SignalListeners = {
        addSignalListener: (signal, listener) => {
          expect(signal).toBe("SIGINT");
          listeners.add(listener);
        },
        removeSignalListener: (signal, listener) => {
          expect(signal).toBe("SIGINT");
          listeners.delete(listener);
        },
      };
      const interrupt = () => {
        for (const listener of [...listeners]) listener();
      };
      return { signals, listeners, interrupt };
    }

    it("resolves at the next `SIGINT` and stops listening", async () => {
      const { signals, listeners, interrupt } = signalSource();
      let resolved = false;

      const interrupted = untilInterrupted(signals).then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      expect(listeners.size).toBe(1);

      interrupt();
      await interrupted;
      expect(resolved).toBe(true);
      expect(listeners.size).toBe(0);
    });
  });
});
