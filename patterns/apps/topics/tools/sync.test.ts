import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import { Identity, legacySpaceDid } from "@commonfabric/identity";
import { taggedHashStringOf } from "@commonfabric/data-model";
import { ROUTED_HOLDINGS_LIMIT } from "@commonfabric/memory/v2/routed-limits";
import { cfcLabelDocumentHash } from "@commonfabric/runner/cfc";
import type { MirrorData } from "./mirror.ts";
import {
  applyDocs,
  boardFile,
  fetchedFrom,
  identityDid,
  loadMirror,
  openDocSource,
  refreshMirror,
  saveMirror,
  sessionDocSource,
  spaceDid,
} from "./sync.ts";
import {
  BOARD,
  BOARD_DOCS,
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
    it("reads a label held by reference, fetched or sent along, on every refresh", async () => {
      const label = {
        integrity: [{ kind: "authored-by", subject: "did:key:zAda" }],
      };
      const id = `cid:${cfcLabelDocumentHash(label)}`;
      await board.write({
        "of:fid1:comment-1": {
          value: BOARD_DOCS["of:fid1:comment-1"].value,
          cfc: {
            version: 2,
            schemaHash: taggedHashStringOf(true),
            labelMap: {
              version: 1,
              entries: [{ path: [], origin: "declared", label: { $ref: id } }],
            },
          },
        },
        [id]: { value: label },
        [`cid:${taggedHashStringOf(true)}`]: { value: true },
      });
      const data = empty();

      for (let refreshes = 0; refreshes < 2; refreshes++) {
        const { topics } = await refresh(data);

        expect(topics[0].comments[0].labels?.authors).toEqual([
          "did:key:zAda",
        ]);
        expect(data.docs[id]?.value).toEqual(label);
      }

      // A copy holding the label document for its revision alone, as one
      // pruned holds it, fetches its content again.
      const pruned = structuredClone(data);
      pruned.docs[id] = { seq: data.docs[id].seq };
      const { topics } = await refresh(pruned);

      expect(topics[0].comments[0].labels?.authors).toEqual(["did:key:zAda"]);
      expect(pruned.docs[id]?.value).toEqual(label);
    });

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
        // The alias is a document the piece was reached through, whose
        // labels restrict what it leads to.
        "of:fid1:topic-alias-1": {
          piece: "of:fid1:topic-piece-1",
          input: "of:fid1:input-1",
          via: ["of:fid1:topic-alias-1"],
        },
        "of:fid1:topic-piece-2": {
          piece: "of:fid1:topic-piece-2",
          input: "of:fid1:input-2",
          via: [],
        },
      });
      expect(fetched).toBeGreaterThan(0);
    });

    it("keeps the content of no piece, only of the documents Topics are read from or reached through", async () => {
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
        "of:fid1:topic-alias-1",
      ]);
    });

    it("keeps a piece sent along for its revision, so that the server does not send it again", async () => {
      const { client, session } = await board.mount();
      const watch = session.watchSetSync.bind(session);
      const sent: string[] = [];
      session.watchSetSync = async (...args: Parameters<typeof watch>) => {
        const answer = await watch(...args);
        for (const upsert of answer.sync.upserts) sent.push(upsert.id);
        return answer;
      };
      try {
        const data = empty();
        await refreshMirror(data, BOARD, sessionDocSource(session, SPACE));

        expect(sent).toContain("of:fid1:topic-piece-1");
        expect(data.docs["of:fid1:topic-piece-1"]).toEqual({
          seq: expect.any(Number),
        });

        sent.length = 0;
        await refreshMirror(data, BOARD, sessionDocSource(session, SPACE));

        expect(sent).toEqual([]);
      } finally {
        await client.close();
      }
    });

    it("keeps the content of a document it reads when the document also rides along with another", async () => {
      const data = empty();
      await refresh(data);
      await board.write({
        "of:fid1:alias-c": { value: link("of:fid1:comment-1") },
        "of:fid1:input-1": {
          value: {
            ...INPUT_1,
            comments: [link("of:fid1:comment-1"), link("of:fid1:alias-c")],
          },
        },
      });
      const { topics, fetched } = await refresh(data);

      expect(topics[0].comments.map((c) => c.body)).toEqual([
        "Reproduced with cold oil.",
        "Reproduced with cold oil.",
      ]);
      expect(data.docs["of:fid1:comment-1"]?.value).toBeDefined();
      // The input, the new link, and the comment the link sends along.
      expect(fetched).toBe(3);
    });

    it("restricts a Topic by the labels a document it is reached through holds now", async () => {
      /** The alias to Topic 1, labeled as for `subjects`. */
      const alias = (...subjects: string[]) => ({
        "of:fid1:topic-alias-1": {
          value: BOARD_DOCS["of:fid1:topic-alias-1"].value,
          cfc: {
            version: 2,
            schemaHash: taggedHashStringOf(true),
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                origin: "declared",
                label: {
                  confidentiality: subjects.map((subject) => ({
                    type: "https://commonfabric.org/cfc/atom/User",
                    subject,
                  })),
                },
              }],
            },
          },
        },
        [`cid:${taggedHashStringOf(true)}`]: { value: true },
      });
      await board.write(alias("did:key:zX"));
      const data = empty();
      const before = await refresh(data);
      await board.write(alias("did:key:zX", "did:key:zY"));
      const after = await refresh(data);

      expect(before.topics[0].labels?.confidentiality).toEqual([
        ["User(did:key:zX)"],
      ]);
      expect(after.topics[0].labels?.confidentiality).toEqual([
        ["User(did:key:zX)"],
        ["User(did:key:zY)"],
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
    it("keeps a document riding along whole where the copy holds its content, and otherwise for its revision", () => {
      const data: MirrorData = {
        pieces: {},
        docs: {
          "of:held": { seq: 1, value: "old", cfc: null },
          "of:piece": { seq: 1 },
        },
      };
      const absent = new Set<string>();
      applyDocs(data, [
        { id: "of:held", seq: 2, value: "new", cfc: null, riding: true },
        { id: "of:piece", seq: 2, value: "big", cfc: null, riding: true },
        { id: "of:stranger", seq: 3, value: "big", cfc: null, riding: true },
        { id: "of:gone", seq: 4, deleted: true, riding: true },
      ], absent);

      expect(data.docs).toEqual({
        "of:held": { seq: 2, value: "new", cfc: null },
        "of:piece": { seq: 2 },
        "of:stranger": { seq: 3 },
        "of:gone": { seq: 4 },
      });
      expect(absent).toEqual(new Set());
    });

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

    it("keeps the label envelope a document stores, and a label document's content when it is sent along without it", () => {
      const data: MirrorData = {
        pieces: {},
        docs: { "cid:label": { seq: 1, value: { integrity: [] } } },
      };
      applyDocs(data, [
        { id: "of:a", seq: 2, value: "a", cfc: { version: 2 } },
        { id: "cid:label", seq: 3 },
        { id: "of:b", seq: 4 },
      ], new Set());

      expect(data.docs).toEqual({
        "of:a": { seq: 2, value: "a", cfc: { version: 2 } },
        "cid:label": { seq: 3, value: { integrity: [] } },
        "of:b": { seq: 4 },
      });
    });
  });

  describe("fetchedFrom()", () => {
    it("returns every document sent, marking those not wanted as riding along", () => {
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
        { id: "of:a", seq: 1, value: "x", cfc: null },
        { id: "of:b", seq: 2, value: "x", cfc: null, riding: true },
        { id: "cid:c", seq: 3, value: "x", cfc: null, riding: true },
        { id: "of:d", seq: 4, deleted: true },
      ]);
    });
  });

  describe("sessionDocSource()", () => {
    it("declares no more holdings in one request than the server takes, however many ride along", async () => {
      const { client, session } = await board.mount();
      const watch = session.watchSetSync.bind(session);
      const declared: number[] = [];
      session.watchSetSync = (...args: Parameters<typeof watch>) => {
        declared.push(args[1]?.length ?? 0);
        return watch(...args);
      };
      try {
        const riding = Array.from(
          { length: ROUTED_HOLDINGS_LIMIT + 100 },
          (_, index) => ({ id: `of:fid1:riding-${index}`, seq: 1 }),
        );
        await sessionDocSource(session, SPACE).fetch(
          ["of:fid1:input-1"],
          [{ id: "of:fid1:input-1", seq: 1 }, ...riding],
        );

        expect(declared).toEqual([ROUTED_HOLDINGS_LIMIT]);
      } finally {
        await client.close();
      }
    });

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

    describe("on a deployment whose naming mode it is told", () => {
      // The memory server admits a session by the naming mode it declares
      // (INV-16): a space a naming runtime wrote refuses a session that
      // declares none, and a server whose posture names no instances refuses
      // one that declares it. A session opened in this build's default mode
      // is therefore refused one of these two boards, whichever the default
      // is.

      for (const namesInstances of [true, false]) {
        it(`reads a board whose deployment runs \`instanceNames: ${namesInstances}\``, async () => {
          const deployed = await boardServer({ namesInstances });
          try {
            const identity = join(dir, "identity.key");
            await Deno.writeFile(identity, await Identity.generatePkcs8());
            const source = await openDocSource(
              { apiUrl: "http://localhost:1", space: SPACE, identity },
              {
                settings: () =>
                  Promise.resolve({
                    experimental: { instanceNames: namesInstances },
                    memoryHost: new URL("https://memory.example"),
                  }),
                Sessions: deployed.Sessions,
              },
            );
            try {
              expect(
                (await source.fetch(["of:fid1:topic-piece-2"], [])).map((
                  doc,
                ) => doc.id),
              ).toEqual(["of:fid1:topic-piece-2"]);
            } finally {
              await source.close();
            }
          } finally {
            await deployed.close();
          }
        });
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

  describe("spaceDid()", () => {
    it("returns a space named by its DID as it is, and one named by its name as its DID", async () => {
      expect(await spaceDid(SPACE)).toBe(SPACE);
      expect(await spaceDid("topics-dev")).toBe(
        await legacySpaceDid("topics-dev"),
      );
      expect(await spaceDid("topics-dev")).toMatch(/^did:key:/);
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

    it("returns what `browse` remembers under `XDG_STATE_HOME`, apart for each viewer", () => {
      expect(boardFile({ browse: "did:key:zA" }, "https://h", "s", "b", env))
        .toBe("/state/commonfabric/topics/h/s/b.did%3Akey%3AzA.browse.json");
      expect(boardFile({ browse: "did:key:zB" }, "https://h", "s", "b", env))
        .not.toBe(
          boardFile({ browse: "did:key:zA" }, "https://h", "s", "b", env),
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

  describe("identityDid()", () => {
    it("returns the DID of the identity the keyfile holds", async () => {
      const path = join(dir, "identity.key");
      const pkcs8 = await Identity.generatePkcs8();
      await Deno.writeFile(path, pkcs8);

      expect(await identityDid(path)).toBe(
        (await Identity.fromPkcs8(pkcs8)).did(),
      );
    });

    it("throws naming a keyfile it cannot read", async () => {
      await expect(identityDid(join(dir, "absent.key"))).rejects.toThrow(
        "absent.key",
      );
    });
  });

  describe("loadMirror()", () => {
    it("returns what `saveMirror()` wrote, to a file only its owner reads", async () => {
      const path = join(dir, "nested", "copy.json");
      const data: MirrorData = {
        space: SPACE,
        boardInput: "of:fid1:board-input",
        pieces: {
          "of:fid1:a": {
            piece: "of:fid1:p",
            input: "of:fid1:i",
            via: ["of:fid1:a"],
          },
        },
        docs: {
          "of:fid1:i": { seq: 3, value: { title: "T" }, cfc: null },
          "cid:x": { seq: 1 },
        },
      };
      await saveMirror(path, data);

      expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);

      expect(await loadMirror(path)).toEqual(data);
      expect([...Deno.readDirSync(join(dir, "nested"))].map((e) => e.name))
        .toEqual(["copy.json"]);
    });

    it("lets go of a document read before the copy kept label envelopes, so that it is read again", async () => {
      const path = join(dir, "old.json");
      await saveMirror(path, {
        pieces: {},
        docs: {
          "of:fid1:old": { seq: 3, value: { title: "T" } },
          "of:fid1:new": { seq: 4, value: { title: "U" }, cfc: null },
          "cid:x": { seq: 1, value: { integrity: [] } },
        },
      });

      expect(Object.keys((await loadMirror(path)).docs).sort()).toEqual([
        "cid:x",
        "of:fid1:new",
      ]);
    });

    it("lets go of an entry followed before the copy kept what it went through, so that it is followed again", async () => {
      const path = join(dir, "unrouted.json");
      const followed = { piece: "of:fid1:p", input: "of:fid1:i" };
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          pieces: {
            "of:fid1:old": followed,
            "of:fid1:odd": { ...followed, via: ["of:fid1:odd", 2] },
            "of:fid1:new": { ...followed, via: ["of:fid1:new"] },
          },
          docs: {},
        }),
      );

      expect(Object.keys((await loadMirror(path)).pieces)).toEqual([
        "of:fid1:new",
      ]);
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
