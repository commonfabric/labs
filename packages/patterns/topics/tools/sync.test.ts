import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { Identity } from "@commonfabric/identity";
import type { MirrorData } from "./mirror.ts";
import {
  applyDocs,
  boardFile,
  fetchedFrom,
  loadMirror,
  openDocSource,
  refreshMirror,
  saveMirror,
} from "./sync.ts";
import {
  BOARD,
  type BoardServer,
  boardServer,
  INPUT_1,
  link,
  SPACE,
} from "./board-fixture.ts";

/** An empty copy. */
function empty(): MirrorData {
  return { pieces: {}, docs: {} };
}

describe("sync", () => {
  let board: BoardServer;
  let dir: string;

  beforeEach(async () => {
    board = await boardServer();
    dir = await Deno.makeTempDir({ prefix: "topics-tool-sync-" });
  });

  afterEach(async () => {
    await board.close();
    await Deno.remove(dir, { recursive: true });
  });

  /** Refreshes `data` through a source of its own, closed afterwards. */
  async function refresh(data: MirrorData) {
    const source = await board.open();
    try {
      return await refreshMirror(data, BOARD, source);
    } finally {
      await source.close();
    }
  }

  describe("refreshMirror()", () => {
    it("returns every Topic the board names, following documents that only link onward to a piece", async () => {
      const data = empty();
      const { topics, fetched } = await refresh(data);

      expect(
        topics.map((t) => [t.number, t.address, t.piece, t.title, t.createdBy]),
      ).toEqual([
        [
          "1",
          "of:fid1:topic-alias-1",
          "of:fid1:topic-piece-1",
          "Flaky fryer test",
          "Sol (agent)",
        ],
        [
          "2",
          "of:fid1:topic-piece-2",
          "of:fid1:topic-piece-2",
          "Donut glaze",
          "Legacy Lu",
        ],
      ]);
      expect(topics[0].comments.map((c) => c.body)).toEqual([
        "Reproduced with cold oil.",
      ]);
      expect(data.space).toBe(SPACE);
      expect(data.boardInput).toBe("of:fid1:board-input");
      expect(data.pieces).toEqual({
        "of:fid1:topic-alias-1": {
          piece: "of:fid1:topic-piece-1",
          input: "of:fid1:input-1",
        },
        "of:fid1:topic-piece-2": {
          piece: "of:fid1:topic-piece-2",
          input: "of:fid1:input-2",
        },
      });
      expect(fetched).toBeGreaterThan(0);
    });

    it("keeps no piece documents, only the documents Topics are read from", async () => {
      const data = empty();
      await refresh(data);
      const kept = Object.entries(data.docs).flatMap(([id, doc]) =>
        doc.value === undefined ? [] : [id]
      );

      expect(kept.sort()).toEqual([
        "of:fid1:board-input",
        "of:fid1:comment-1",
        "of:fid1:input-1",
        "of:fid1:input-2",
      ]);
    });

    it("fetches nothing when nothing changed", async () => {
      const data = empty();
      const first = await refresh(data);
      const second = await refresh(data);

      expect(second.fetched).toBe(0);
      expect(second.topics).toEqual(first.topics);
    });

    it("fetches only the documents a change touched, and the documents they newly link", async () => {
      const data = empty();
      await refresh(data);
      await board.write({
        "of:fid1:comment-2": {
          value: {
            author: { name: "Bo" },
            body: "Warm oil fixes it.",
            sentAt: 9000,
          },
        },
        "of:fid1:input-1": {
          value: {
            ...INPUT_1,
            comments: [link("of:fid1:comment-1"), link("of:fid1:comment-2")],
          },
        },
      });
      const { topics, fetched } = await refresh(data);

      expect(fetched).toBe(2);
      expect(topics[0].comments.map((c) => c.body)).toEqual([
        "Reproduced with cold oil.",
        "Warm oil fixes it.",
      ]);
      expect(topics[0].lastActivityAt).toBe(9000);
      expect(topics[1].title).toBe("Donut glaze");
    });

    it("drops a Topic the board no longer names, and the documents only it was read from", async () => {
      const data = empty();
      await refresh(data);
      await board.write({
        "of:fid1:board-input": {
          value: { names: { "1": link("of:fid1:topic-alias-1") } },
        },
      });
      const { topics } = await refresh(data);

      expect(topics.map((t) => t.number)).toEqual(["1"]);
      expect(data.docs["of:fid1:input-2"]).toBeUndefined();
      expect(Object.keys(data.pieces)).toEqual(["of:fid1:topic-alias-1"]);
    });

    it("leaves out an entry that reaches no piece, and one whose document does not exist", async () => {
      await board.write({
        "of:fid1:board-input": {
          value: {
            names: {
              "1": link("of:fid1:topic-alias-1"),
              "3": link("of:fid1:no-piece"),
              "4": link("of:fid1:nowhere"),
            },
          },
        },
        "of:fid1:no-piece": { value: { plain: true } },
      });
      const { topics } = await refresh(empty());

      expect(topics.map((t) => t.number)).toEqual(["1"]);
    });

    it("reads a record whose document does not exist as empty", async () => {
      await board.write({
        "of:fid1:input-2": {
          value: {
            title: "Orphaned",
            comments: [link("of:fid1:never-written")],
          },
        },
      });
      const { topics } = await refresh(empty());

      expect(topics[1].comments).toEqual([
        { author: "", body: "", sentAt: 0, removed: false },
      ]);
    });

    it("keeps only the revision of a document that was deleted, reading it as nothing", async () => {
      const data = empty();
      await refresh(data);
      await board.delete("of:fid1:comment-1");
      const { topics } = await refresh(data);

      expect(data.docs["of:fid1:comment-1"]).toEqual({
        seq: expect.any(Number),
      });
      expect(topics[0].comments).toEqual([
        { author: "", body: "", sentAt: 0, removed: false },
      ]);
    });

    it("lets go of a deleted document once no Topic links it", async () => {
      const data = empty();
      await refresh(data);
      await board.delete("of:fid1:comment-1");
      await refresh(data);
      await board.write({
        "of:fid1:input-1": { value: { ...INPUT_1, comments: [] } },
      });
      await refresh(data);

      expect(data.docs["of:fid1:comment-1"]).toBeUndefined();
    });

    it("lets go of a document deleted as its Topic stops linking it", async () => {
      const data = empty();
      await refresh(data);
      await board.delete("of:fid1:comment-1");
      await board.write({
        "of:fid1:input-1": { value: { ...INPUT_1, comments: [] } },
      });
      await refresh(data);

      expect(data.docs["of:fid1:comment-1"]).toBeUndefined();
    });

    it("reports a Topic whose input document is not stored as the pattern stores one", async () => {
      await board.write({
        "of:fid1:input-2": { value: { heading: "Renamed field" } },
      });
      const { topics, unreadable } = await refresh(empty());

      expect(unreadable).toEqual(["2"]);
      expect(topics[1].title).toBe("");
      expect((await refresh(empty())).unreadable).toEqual(["2"]);
    });

    it("reports no Topic when every one is stored as the pattern stores it", async () => {
      expect((await refresh(empty())).unreadable).toEqual([]);
    });

    it("reads a document a source leaves out as nothing, rather than asking again", async () => {
      const data = empty();
      await refresh(data);
      delete data.docs["of:fid1:comment-1"];
      const asked: string[][] = [];
      const { topics } = await refreshMirror(data, BOARD, {
        space: SPACE,
        fetch: (ids) => {
          asked.push([...ids]);
          return Promise.resolve([]);
        },
        lookup: () => Promise.resolve([]),
      });

      expect(topics[0].comments).toEqual([
        { author: "", body: "", sentAt: 0, removed: false },
      ]);
      expect(asked.at(-1)).toEqual(["of:fid1:comment-1"]);
    });

    it("throws for a board whose piece links no input document", async () => {
      await board.write({ [BOARD]: { value: {} } });

      await expect(refresh(empty())).rejects.toThrow(/has no input document/);
    });
  });

  describe("applyDocs()", () => {
    it("records each document as the server sent it, a deleted one by its revision alone", () => {
      const data: MirrorData = {
        pieces: {},
        docs: { "of:a": { seq: 5, value: "five" } },
      };
      const absent = new Set(["of:b"]);
      applyDocs(data, [
        { id: "of:a", seq: 6, deleted: true },
        { id: "of:b", seq: 7, value: "seven" },
      ], absent);

      expect(data.docs).toEqual({
        "of:a": { seq: 6 },
        "of:b": { seq: 7, value: "seven" },
      });
      expect([...absent]).toEqual(["of:a"]);

      // A server whose revisions started again, as a wiped one does.
      applyDocs(data, [{ id: "of:b", seq: 1, value: "one" }], absent);

      expect(data.docs["of:b"]).toEqual({ seq: 1, value: "one" });
    });
  });

  describe("fetchedFrom()", () => {
    it("returns the documents wanted, and the revisions of content-addressed ones riding along", () => {
      const doc = { value: "x" };
      const branch = "";

      expect(
        fetchedFrom([
          { branch, id: "of:a", seq: 1, doc },
          { branch, id: "of:b", seq: 2, doc },
          { branch, id: "cid:c", seq: 3, doc },
          { branch, id: "of:d", seq: 4, deleted: true },
        ], new Set(["of:a", "of:d"])),
      ).toEqual([
        { id: "of:a", seq: 1, value: "x" },
        { id: "cid:c", seq: 3 },
        { id: "of:d", seq: 4, deleted: true },
      ]);
    });
  });

  describe("sessionDocSource()", () => {
    it("leaves out a document held at its current revision, and sends one held at an older revision", async () => {
      const source = await board.open();
      try {
        const [first] = (await source.fetch(["of:fid1:input-1"], [])).filter((
          doc,
        ) => doc.id === "of:fid1:input-1");
        const current = await source.fetch(["of:fid1:input-1"], [{
          id: "of:fid1:input-1",
          seq: first.seq,
        }]);
        const stale = await source.fetch(["of:fid1:input-1"], [{
          id: "of:fid1:input-1",
          seq: first.seq - 1,
        }]);

        expect(current.filter((doc) => doc.id === "of:fid1:input-1")).toEqual(
          [],
        );
        expect(stale.map((doc) => doc.id)).toContain("of:fid1:input-1");
      } finally {
        await source.close();
      }
    });

    it("fetches more documents than one watch names", async () => {
      const ids = Array.from({ length: 600 }, (_, i) => `of:fid1:absent-${i}`);
      const source = await board.open();
      try {
        const docs = await source.fetch([...ids, "of:fid1:input-2"], []);

        const present = docs.filter((doc) => !doc.deleted);

        expect(present.map((doc) => doc.id)).toEqual(["of:fid1:input-2"]);
        expect(
          docs.filter((doc) => doc.deleted).every((doc) =>
            ids.includes(doc.id)
          ),
        ).toBe(true);
        expect(present[0].value).toMatchObject({ draftTitle: "Donut glaze" });
      } finally {
        await source.close();
      }
    });
  });

  describe("openDocSource()", () => {
    it("opens a session as the identity in the keyfile, on the space the name derives", async () => {
      const identity = join(dir, "identity.key");
      await Deno.writeFile(identity, await Identity.generatePkcs8());
      const source = await openDocSource(
        { apiUrl: "http://localhost:1", space: SPACE, identity },
        {
          settings: () =>
            Promise.resolve({
              experimental: {},
              memoryHost: new URL("https://memory.example"),
            }),
          Sessions: board.Sessions,
        },
      );
      try {
        expect(source.space).toBe(SPACE);
        expect(board.addresses).toEqual([
          "https://memory.example/api/storage/memory",
        ]);
        expect(
          (await source.fetch(["of:fid1:topic-piece-2"], [])).map((doc) =>
            doc.id
          ),
        )
          .toEqual(["of:fid1:topic-piece-2"]);
      } finally {
        await source.close();
      }
    });

    it("derives the space's DID from a space name", async () => {
      const identity = join(dir, "identity.key");
      await Deno.writeFile(identity, await Identity.generatePkcs8());
      const source = await openDocSource(
        { apiUrl: "http://localhost:1", space: "some-space", identity },
        {
          settings: () =>
            Promise.resolve({
              experimental: {},
              memoryHost: new URL("https://memory.example"),
            }),
          Sessions: board.Sessions,
        },
      );
      try {
        expect(source.space).toMatch(/^did:key:/);
        expect(source.space).not.toBe(SPACE);
      } finally {
        await source.close();
      }
    });

    it("throws, naming the keyfile, when it cannot be read", async () => {
      const identity = join(dir, "missing.key");

      await expect(
        openDocSource(
          { apiUrl: "http://localhost:1", space: SPACE, identity },
          {
            settings: () =>
              Promise.resolve({
                experimental: {},
                memoryHost: new URL("https://memory.example"),
              }),
            Sessions: board.Sessions,
          },
        ),
      ).rejects.toThrow(`The identity keyfile \`${identity}\` cannot be read`);
    });
  });

  describe("boardFile()", () => {
    const env = (name: string) =>
      ({
        XDG_CACHE_HOME: "/cache",
        XDG_STATE_HOME: "/state",
        HOME: "/home/ada",
      })[
        name
      ];
    const home = (name: string) => ({ HOME: "/home/ada" })[name];

    it("returns the copy under `XDG_CACHE_HOME`, named for the host, space, and board", () => {
      expect(
        boardFile(
          "copy",
          "https://estuary.example:8000/x",
          "my space",
          "of:fid1:a/b",
          env,
        ),
      ).toBe(
        "/cache/commonfabric/topics/estuary%2Eexample%3A8000/my%20space/" +
          "of%3Afid1%3Aa%2Fb.json",
      );
    });

    it("gives different hosts, spaces, and boards different files, none outside its directory", () => {
      const files = [
        ["a_b", "b"],
        ["a/b", "b"],
        ["a:b", "b"],
        ["..", "b"],
        ["s", ".."],
        ["s", "../b"],
      ].map(([space, board]) =>
        boardFile("copy", "https://h", space, board, env)
      );

      expect(new Set(files).size).toBe(files.length);
      for (const file of files) {
        expect(file).toMatch(
          /^\/cache\/commonfabric\/topics\/h\/[^/]+\/[^/]+\.json$/,
        );
        expect(file.split("/")).not.toContain("..");
      }
    });

    it("returns the session under `XDG_STATE_HOME`, apart from the copy", () => {
      expect(boardFile("session", "https://h", "s", "b", env)).toBe(
        "/state/commonfabric/topics/h/s/b.invocation-session",
      );
    });

    it("falls back to `~/.cache` and `~/.local/state`", () => {
      expect(boardFile("copy", "https://h", "s", "b", home)).toBe(
        "/home/ada/.cache/commonfabric/topics/h/s/b.json",
      );
      expect(boardFile("session", "https://h", "s", "b", home)).toBe(
        "/home/ada/.local/state/commonfabric/topics/h/s/b.invocation-session",
      );
    });
  });

  describe("loadMirror()", () => {
    it("returns what `saveMirror()` wrote", async () => {
      const path = join(dir, "nested", "copy.json");
      const data: MirrorData = {
        space: SPACE,
        boardInput: "of:fid1:board-input",
        pieces: {
          "of:fid1:a": {
            piece: "of:fid1:p",
            input: "of:fid1:i",
          },
        },
        docs: {
          "of:fid1:i": { seq: 3, value: { title: "T" } },
          "cid:x": { seq: 1 },
        },
      };
      await saveMirror(path, data);

      expect(await loadMirror(path)).toEqual(data);
      expect([...Deno.readDirSync(join(dir, "nested"))].map((e) => e.name))
        .toEqual(["copy.json"]);
    });

    it("returns an empty copy for a missing file, a malformed one, or one of another shape", async () => {
      const malformed = join(dir, "malformed.json");
      await Deno.writeTextFile(malformed, "{");
      const shapes = [
        [],
        { pieces: {}, docs: { "of:fid1:a": { seq: "1" } } },
        { pieces: { "of:fid1:a": "of:fid1:b" }, docs: {} },
        { space: 1, pieces: {}, docs: {} },
        { boardInput: 1, pieces: {}, docs: {} },
      ];

      expect(await loadMirror(join(dir, "absent.json"))).toEqual(empty());
      expect(await loadMirror(malformed)).toEqual(empty());
      for (const [index, shape] of shapes.entries()) {
        const path = join(dir, `shape-${index}.json`);
        await Deno.writeTextFile(path, JSON.stringify(shape));
        expect(await loadMirror(path)).toEqual(empty());
      }
    });

    it("throws for a copy it cannot read", async () => {
      await expect(loadMirror(dir)).rejects.toThrow();
    });
  });
});
