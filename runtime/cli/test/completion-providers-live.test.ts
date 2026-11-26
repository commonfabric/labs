/**
 * Live completion candidates read from a real piece. A runtime on emulated
 * storage runs one pattern and gives its piece a slug, and each line is
 * completed over that runtime's controller, handed in as the connection. The
 * space has no root pattern to keep a piece registry, so the controller's
 * registry is the one piece.
 */

import { expect } from "@std/expect";

import { createSession, Identity } from "@commonfabric/identity";
import { pieceId, setSlugLink } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  afterAll,
  beforeAll,
  describe,
  it,
} from "@commonfabric/test-support/test";

import { resolveCompletionLine } from "../lib/completion/line.ts";
import { complete, tokenizeLine } from "../lib/completion/mod.ts";
import {
  liveCandidates,
  type LiveConnectionDeps,
} from "../lib/completion/providers.ts";
import { main } from "../commands/main.ts";

/** A pattern with one verb, a scalar, an object, and an empty collection. */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, Default, NAME, pattern, Stream } from "commonfabric";',
      "",
      "interface AddEvent { title: string; }",
      "interface In { items: Default<string[], []>; }",
      "interface Out {",
      "  [NAME]: string;",
      "  title: string;",
      "  meta: { owner: string; tags: string };",
      "  items: string[];",
      "  add: Stream<AddEvent>;",
      "}",
      "",
      "export default pattern<In, Out>(({ items }) => {",
      "  const add = action((event: AddEvent) => { items.push(event.title); });",
      "  return {",
      "    [NAME]: 'Test board',",
      "    title: 'Board',",
      "    meta: { owner: 'me', tags: 'none' },",
      "    items,",
      "    add,",
      "  };",
      "});",
    ].join("\n"),
  }],
};

describe("completion-providers-live", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let deps: LiveConnectionDeps;
  let id: string;
  let connection: string;

  beforeAll(async () => {
    const signer = await Identity.fromPassphrase("cli completion providers");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
    const compiled = await runtime.patternManager.compilePattern(
      PROGRAM,
      { space: pieces.getSpace() },
    );
    const piece = await pieces.runPersistent(compiled, {}, undefined, {
      start: true,
    });
    await setSlugLink(pieces, "board", piece);
    await pieces.synced();
    id = pieceId(piece)!;
    const registered = await pieces.get(id, true);
    pieces.getRegisteredPieces = () => Promise.resolve([registered]);
    deps = { loadPieces: () => Promise.resolve(pieces) };
    connection = `-i /keys/me.key -a http://h:1 -s ${pieces.getSpace()}`;
  });

  afterAll(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Returns the live candidates for `text`, cursor at its end. */
  async function candidatesFor(text: string) {
    const { words, cword } = tokenizeLine(text, text.length);
    return await liveCandidates(
      resolveCompletionLine(main, words, cword),
      deps,
    );
  }

  /** Returns the lines `complete()` emits for `text`, cursor at its end. */
  async function linesFor(text: string) {
    const { words, cword } = tokenizeLine(text, text.length);
    return await complete(main, words, cword, "bash", deps);
  }

  describe("`--cell`", () => {
    it("returns the space's slugs, then its piece ids, each labeled", async () => {
      const result = await candidatesFor(`cf piece call ${connection} --cell `);

      expect(result).toEqual({
        candidates: [
          { value: "board", description: "slug for Test board" },
          { value: id, description: "Test board" },
        ],
        directives: [],
      });
    });

    it("returns nothing for a line that names no space", async () => {
      const result = await candidatesFor(
        "cf piece call -i /k --url bad --cell ",
      );

      expect(result).toEqual({ candidates: [], directives: [] });
    });
  });

  describe("`piece set-slug`", () => {
    it("returns the space's slugs and no piece ids", async () => {
      const result = await candidatesFor(`cf piece set-slug ${connection} `);

      expect(result.candidates).toEqual([
        { value: "board", description: "slug for Test board" },
      ]);
    });
  });

  describe("`piece call`", () => {
    it("returns the piece's verbs, annotated with their kind", async () => {
      const result = await candidatesFor(
        `cf piece call ${connection} --cell ${id} `,
      );

      expect(result.candidates).toEqual([
        { value: "add", description: "handler" },
      ]);
    });
  });

  describe("`cell get` paths", () => {
    it("returns the piece's keys, holding the cursor in the word", async () => {
      const result = await candidatesFor(
        `cf cell get ${connection} --cell ${id} me`,
      );

      expect(result.candidates.map((c) => c.value)).toContain("meta");
      expect(result.candidates.map((c) => c.value)).toContain("title");
      expect(result.directives).toEqual([{ kind: "nospace" }]);
    });

    it("returns the keys below a parent path, each carrying it", async () => {
      const result = await candidatesFor(
        `cf cell get ${connection} --cell ${id} meta/`,
      );

      expect(result.candidates.map((c) => c.value).sort()).toEqual([
        "meta/owner",
        "meta/tags",
      ]);
    });

    it("returns nothing, and no directive, below an empty collection", async () => {
      const result = await candidatesFor(
        `cf cell get ${connection} --cell ${id} items/`,
      );

      expect(result).toEqual({ candidates: [], directives: [] });
    });
  });

  describe("`cell get --select`", () => {
    it("returns the fields of the value, holding the cursor in the word", async () => {
      const result = await candidatesFor(
        `cf cell get ${connection} --cell ${id} --select meta.`,
      );

      expect(result.candidates.map((c) => c.value)).toEqual(
        expect.arrayContaining(["meta.owner", "meta.tags"]),
      );
      expect(result.candidates.map((c) => c.value)).not.toContain("title");
      expect(result.directives).toEqual([{ kind: "nospace" }]);
    });

    it("returns nothing below a scalar field", async () => {
      const result = await candidatesFor(
        `cf cell get ${connection} --cell ${id} --select title.`,
      );

      expect(result).toEqual({ candidates: [], directives: [] });
    });
  });

  describe("`piece link` endpoints", () => {
    it("emits the slugs and piece ids before a `/`, with the directive that holds the cursor", async () => {
      expect(await linesFor(`cf piece link ${connection} `)).toEqual([
        ":cf:nospace",
        "board",
        id,
      ]);
    });

    it("emits the piece's keys after a `/`, each carrying the piece", async () => {
      const lines = await linesFor(`cf piece link ${connection} ${id}/ti`);

      expect(lines).toEqual([":cf:nospace", `${id}/title`]);
    });

    it("emits nothing below an empty collection", async () => {
      expect(await linesFor(`cf piece link ${connection} ${id}/items/`))
        .toEqual([]);
    });

    it("emits nothing after a `/` on a line that names no space", async () => {
      expect(await linesFor(`cf piece link -i /k --url bad ${id}/`))
        .toEqual([]);
    });
  });
});
