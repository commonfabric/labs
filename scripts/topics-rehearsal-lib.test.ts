/** Unit coverage for the pure halves of the Topics export/restore pair; the
 * live halves are exercised by the rehearsal drill
 * (`runtime/cli/integration/topics-restore-drill.sh`). */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildRestoreDocument,
  declaredRetirableLinks,
  deepEqual,
  findLink,
  isAbsentPathError,
  isStoredLink,
  normalizeFid,
  type ProgressLine,
  publishedBoardSources,
  recreatedDocument,
  type RecreateSteps,
  recreateTopics,
  retiredKeys,
  storedLink,
  type TopicExportRow,
  WHOLE_VALUE,
  withoutKeys,
} from "./topics-rehearsal-lib.ts";

describe("topics-rehearsal-lib", () => {
  describe("retiredKeys", () => {
    it("names a key the live read does not surface", () => {
      // The case this exists for: an export taken before a migration carries a
      // field the migrated schema no longer declares.

      const exported = [{ author: { name: "a" }, authorName: "a", body: "x" }];
      const live = [{ author: { name: "a" }, body: "x" }];
      expect(retiredKeys(exported, live)).toEqual(["[].authorName"]);
    });

    it("names nothing when both sides carry the same keys", () => {
      expect(retiredKeys({ a: 1, b: { c: 2 } }, { a: 9, b: { c: 8 } })).toEqual(
        [],
      );
    });

    //
    // A retired field leaves no record to be missing from
    //
    // A migration that retires a whole top-level field leaves no surviving
    // record for a key to be missing from, so absence is reported about the
    // compared value itself — and where neither side carried a value, there
    // is no retirement to report at all.
    //

    it("names the whole value when a retired scalar reads back absent", () => {
      expect(retiredKeys("a legacy display name", undefined)).toEqual([
        WHOLE_VALUE,
      ]);
    });

    it("names the whole value when a retired object reads back absent", () => {
      expect(retiredKeys({ kind: "agent", name: "Fable" }, undefined)).toEqual([
        WHOLE_VALUE,
      ]);
    });

    it("names nothing when neither side carries the value", () => {
      expect(retiredKeys(undefined, undefined)).toEqual([]);
    });

    //
    // Present but changed is not absence
    //
    // The distinction the whole approach rests on: a field the schema still
    // declares reads back present even when its value was lost, so genuine loss
    // is a difference rather than a gap and must not be forgiven.
    //

    it("does not name a key that is present but changed", () => {
      expect(retiredKeys({ body: "kept" }, { body: "" })).toEqual([]);
    });

    it("does not name a whole value that is present but changed", () => {
      expect(retiredKeys("a legacy display name", "changed")).toEqual([]);
    });

    it("does not name a whole value that reads back null", () => {
      // `null` is how a declared-but-empty field reads back, so it is a present
      // value that lost its content — a difference, never a retirement.

      expect(retiredKeys("a legacy display name", null)).toEqual([]);
    });
  });

  describe("withoutKeys", () => {
    it("drops only the named path, leaving the rest comparable", () => {
      const exported = [{ author: { name: "a" }, authorName: "a", body: "x" }];
      expect(withoutKeys(exported, new Set(["[].authorName"]))).toEqual([
        { author: { name: "a" }, body: "x" },
      ]);
    });

    it("drops the value itself when the whole of it was retired", () => {
      expect(withoutKeys("a legacy display name", new Set([WHOLE_VALUE])))
        .toBeUndefined();
    });

    //
    // The two together
    //
    // Together these are what let a restore across a migration report success
    // for a retired field while still failing on a body that came back wrong.
    //

    it("leaves a changed value in place for the comparison to catch", () => {
      const retired = retiredKeys({ authorName: "a", body: "x" }, {
        body: "wrong",
      });
      expect(withoutKeys({ authorName: "a", body: "x" }, new Set(retired)))
        .toEqual({ body: "x" });
    });

    it("forgives a wholly retired field and nothing else", () => {
      // The verdict the restore actually reaches, asked the way it asks it:
      // read the field back, forgive what the schema retired, compare the rest.
      // A retired top-level field passes; a damaged one still fails.

      const survives = (exported: unknown, live: unknown) =>
        deepEqual(
          live,
          withoutKeys(exported, new Set(retiredKeys(exported, live))),
        );
      expect(survives("a legacy display name", undefined)).toBe(true);
      expect(survives({ kind: "agent", name: "Fable" }, undefined)).toBe(true);
      expect(survives("a legacy display name", "changed")).toBe(false);
      expect(survives("a legacy display name", null)).toBe(false);
      expect(
        survives({ kind: "agent", name: "Fable" }, {
          kind: "agent",
          name: "",
        }),
      ).toBe(false);
    });
  });

  describe("isAbsentPathError", () => {
    // The restore forgives an absent field as retired, so only a read that
    // landed and reported the path missing may present as absent.

    it("recognizes the runtime's missing-property failure through cf", () => {
      const error = new Error(
        "cf cell get -q --input authorName exited 1\nCannot access path " +
          '"authorName" - property "authorName" not found. ' +
          "Available keys: body, title",
      );
      expect(isAbsentPathError(error)).toBe(true);
    });

    it("returns false for a read that never reached the document", () => {
      expect(
        isAbsentPathError(
          new Error(
            "cf cell get -q --input body exited 1\nerror sending request for url " +
              "(http://localhost:8020/): connection refused",
          ),
        ),
      ).toBe(false);
      expect(isAbsentPathError(new Error("did not return JSON"))).toBe(false);
      expect(isAbsentPathError("not an error")).toBe(false);
    });
  });

  describe("isStoredLink", () => {
    // What tells a bound structural field from an absent one, which a read
    // of the field and a `<field>@` selection cannot.

    it("returns true for a link as a whole-document read prints it", () => {
      expect(isStoredLink({
        "/": {
          "link@1": {
            id: "of:fid1:board",
            path: ["board"],
            space: "did:key:z6Mkspace",
            scope: "space",
          },
        },
      })).toBe(true);
    });

    it("returns false for an address a selection answers with", () => {
      expect(isStoredLink({ $link: "/of:fid1:topic-argument/board" })).toBe(
        false,
      );
    });

    it("returns false for a value and for nothing", () => {
      expect(isStoredLink({ "/": "not a link" })).toBe(false);
      expect(isStoredLink([])).toBe(false);
      expect(isStoredLink(undefined)).toBe(false);
    });
  });

  describe("findLink", () => {
    it("returns null for plain scalars and objects", () => {
      expect(findLink("body text")).toBe(null);
      expect(findLink({ author: { kind: "agent", name: "Fable" } })).toBe(
        null,
      );
      expect(findLink(null)).toBe(null);
    });

    it("returns the path of a top-level link marker", () => {
      expect(findLink({ $link: { id: "of:fid1:x" } })).toBe("$");
    });

    it("returns the path of a nested link marker", () => {
      const doc = {
        comments: [{ body: "plain" }, { $link: { id: "of:fid1:x" } }],
      };
      expect(findLink(doc)).toBe("$.comments.1");
    });
  });

  describe("deepEqual", () => {
    it("treats an undefined property as an absent one", () => {
      expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    });

    it("returns false for a changed nested value", () => {
      expect(
        deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }),
      ).toBe(false);
    });

    it("returns false when an array meets an object", () => {
      expect(deepEqual([], {})).toBe(false);
    });

    it("returns true for equal arrays of records", () => {
      const comments = [{ body: "x", sentAt: 5 }, { body: "y", sentAt: 6 }];
      expect(deepEqual(comments, structuredClone(comments))).toBe(true);
    });
  });

  describe("buildRestoreDocument", () => {
    const link = { $link: { id: "of:fid1:board" } };
    const resolved = {
      comments: [{ body: "c", sentAt: 1 }],
      links: [{ url: "https://x", addedAt: 2 }],
    };

    it("carries a plain field no list names, so a grown schema survives", () => {
      const { doc } = buildRestoreDocument(
        { title: "t", titleUpdatedAt: 5, mentionable: link },
        resolved,
      );
      expect(doc.titleUpdatedAt).toBe(5);
    });

    it("substitutes resolved values for the linked arrays", () => {
      const { doc } = buildRestoreDocument(
        { comments: [link], links: [link] },
        resolved,
      );
      expect(doc.comments).toEqual(resolved.comments);
      expect(doc.links).toEqual(resolved.links);
    });

    it("routes known link fields aside instead of into the document", () => {
      // Every wiring input the topic pattern declares, so a new one that never
      // reached STRUCTURAL_LINK_SOURCES fails here rather than at a restore.

      const { doc, structural, legacy } = buildRestoreDocument(
        {
          title: "t",
          mentionable: link,
          board: link,
          boardCrossrefs: link,
          boardCrossrefIndex: link,
          boardNames: link,
          myName: link,
        },
        resolved,
      );
      expect(structural).toEqual(["mentionable"]);
      // In the raw argument's own order, which is what the walk follows. All
      // five are retired here because this target declares none of them.
      expect(legacy).toEqual([
        "board",
        "boardCrossrefs",
        "boardCrossrefIndex",
        "boardNames",
        "myName",
      ]);
      expect(doc.mentionable).toBeUndefined();
      expect(doc.board).toBeUndefined();
      expect(doc.boardCrossrefs).toBeUndefined();
      expect(doc.boardCrossrefIndex).toBeUndefined();
      expect(doc.boardNames).toBeUndefined();
      expect(doc.myName).toBeUndefined();
    });

    describe("the board's crossref index", () => {
      // `boardCrossrefIndex` is declared by some generations of the topic
      // pattern and published by some generations of the board, and a topic
      // and its board are updated separately. Each case here is one pairing
      // of an export, a target and a board.

      const board = ["mentionable", "crossrefs", "crossrefIndex", "namesTable"];
      const olderBoard = ["mentionable", "crossrefs", "namesTable"];
      const newerExport = {
        title: "t",
        mentionable: link,
        boardCrossrefs: link,
        boardCrossrefIndex: link,
      };
      const olderExport = {
        title: "t",
        mentionable: link,
        boardCrossrefs: link,
      };

      it("relinks it for a target that declares it", () => {
        const { doc, structural, legacy, unpublished } = buildRestoreDocument(
          newerExport,
          resolved,
          {
            declaredLinks: ["boardCrossrefs", "boardCrossrefIndex"],
            publishedSources: board,
          },
        );
        expect(structural).toEqual([
          "mentionable",
          "boardCrossrefs",
          "boardCrossrefIndex",
        ]);
        expect(legacy).toEqual([]);
        expect(unpublished).toEqual([]);
        expect(doc.boardCrossrefIndex).toBeUndefined();
      });

      it("relinks it from an export that predates it, onto a target that declares it", () => {
        // The apply replaces the whole document, so a declared link the
        // export never named would be erased if nothing put it back.

        const { structural, legacy } = buildRestoreDocument(
          olderExport,
          resolved,
          {
            declaredLinks: ["boardCrossrefs", "boardCrossrefIndex"],
            publishedSources: board,
          },
        );
        expect(structural).toEqual([
          "mentionable",
          "boardCrossrefs",
          "boardCrossrefIndex",
        ]);
        expect(legacy).toEqual([]);
      });

      it("retires it for a target that does not declare it", () => {
        const { structural, legacy, unpublished } = buildRestoreDocument(
          newerExport,
          resolved,
          { declaredLinks: ["boardCrossrefs"], publishedSources: board },
        );
        expect(structural).toEqual(["mentionable", "boardCrossrefs"]);
        expect(legacy).toEqual(["boardCrossrefIndex"]);
        expect(unpublished).toEqual([]);
      });

      it("leaves it out where the board publishes no index, whichever export", () => {
        // A topic that declares the input, on a board that does not publish
        // `crossrefIndex`: a relink there is refused after the apply, so it
        // is never attempted, and the other links are still relinked.

        for (const exported of [newerExport, olderExport]) {
          const { doc, structural, legacy, unpublished } = buildRestoreDocument(
            exported,
            resolved,
            {
              declaredLinks: ["boardCrossrefs", "boardCrossrefIndex"],
              publishedSources: olderBoard,
            },
          );
          expect(structural).toEqual(["mentionable", "boardCrossrefs"]);
          expect(unpublished).toEqual(["boardCrossrefIndex"]);
          expect(legacy).toEqual([]);
          expect(doc.boardCrossrefIndex).toBeUndefined();
        }
      });

      it("decides the same whatever order the raw argument holds its fields in", () => {
        const target = {
          declaredLinks: ["boardCrossrefs", "boardCrossrefIndex"],
          publishedSources: olderBoard,
        };
        const first = buildRestoreDocument(
          { boardCrossrefIndex: link, ...olderExport },
          resolved,
          target,
        );
        const last = buildRestoreDocument(
          { ...olderExport, boardCrossrefIndex: link },
          resolved,
          target,
        );
        expect(first.structural).toEqual(["mentionable", "boardCrossrefs"]);
        expect(last.structural).toEqual(first.structural);
        expect(first.unpublished).toEqual(["boardCrossrefIndex"]);
        expect(last.unpublished).toEqual(first.unpublished);
      });

      it("refuses, before the apply, a link that cannot be retired and whose board path is missing", () => {
        expect(() =>
          buildRestoreDocument(newerExport, resolved, {
            declaredLinks: ["boardCrossrefs", "boardCrossrefIndex"],
            publishedSources: ["crossrefs", "crossrefIndex"],
          })
        ).toThrow("mentionable");
      });

      it("retires both for a topic that asks the board's collection, and relinks `board`", () => {
        // A topic on the collection-backed pattern declares neither graph
        // input. An export taken from it before it moved still names both.

        const { structural, legacy } = buildRestoreDocument(
          { ...newerExport, board: link },
          resolved,
          { declaredLinks: ["board"], publishedSources: [...board, "board"] },
        );
        expect(structural).toEqual(["mentionable", "board"]);
        expect(legacy).toEqual(["boardCrossrefs", "boardCrossrefIndex"]);
      });
    });

    describe("a topic's `board` link", () => {
      // `board` is declared by the topics that ask the board's collection for
      // their backlinks and by no topic before them, and a restore runs
      // against targets of both. Each case here is one pairing of an export
      // and a target.

      const published = ["mentionable", "board"];

      it("relinks it from an export that predates it, onto a target holding one", async () => {
        const declaredLinks = await declaredRetirableLinks((field) =>
          Promise.resolve(
            field === "board" ? { id: "fid1:collection" } : undefined,
          )
        );
        const { structural, legacy } = buildRestoreDocument(
          { title: "t", mentionable: link },
          resolved,
          { declaredLinks, publishedSources: published },
        );
        expect(structural).toEqual(["mentionable", "board"]);
        expect(legacy).toEqual([]);
      });

      it("retires it for a target that predates it, rather than relinking a path the target lacks", () => {
        const { doc, structural, legacy } = buildRestoreDocument(
          { title: "t", mentionable: link, board: link },
          resolved,
          { declaredLinks: [], publishedSources: published },
        );
        expect(structural).toEqual(["mentionable"]);
        expect(legacy).toEqual(["board"]);
        expect(doc.board).toBeUndefined();
      });
    });

    it("relinks a retirable field the target still declares", () => {
      // The two vintages a migration has in flight at once. This target still
      // runs a pattern declaring `boardNames` and holds a live link there, so
      // retiring it by name would delete a link doing its job: the apply
      // replaces the whole document, and a field in neither list is gone.
      const { doc, structural, legacy } = buildRestoreDocument(
        { title: "t", boardNames: link },
        resolved,
        { declaredLinks: ["boardNames"] },
      );
      expect(structural).toEqual(["boardNames"]);
      expect(legacy).toEqual([]);
      expect(doc.boardNames).toBeUndefined();
    });

    it("carries a preserved value the export does not name", () => {
      // An export taken before a topic stored its own number names none, and
      // the apply replaces the whole document, so saying nothing about
      // `shortName` removes it. A number is permanent and the board's
      // namespace still points at the topic, so the live value is carried.
      const { doc, carried } = buildRestoreDocument(
        { title: "old" },
        resolved,
        { preserved: { shortName: "42" } },
      );
      expect(doc.shortName).toBe("42");
      expect(carried).toEqual(["shortName"]);
      expect(doc.title).toBe("old");
    });

    it("leaves a preserved value alone when the export names the same one", () => {
      const { doc, carried } = buildRestoreDocument(
        { title: "t", shortName: "42" },
        resolved,
        { preserved: { shortName: "42" } },
      );
      expect(doc.shortName).toBe("42");
      expect(carried).toEqual([]);
    });

    it("refuses a preserved value the export and the target disagree on", () => {
      expect(() =>
        buildRestoreDocument(
          { title: "t", shortName: "7" },
          resolved,
          { preserved: { shortName: "42" } },
        )
      ).toThrow("permanent");
    });

    it("keeps a link the pattern stopped declaring out of the relink list", () => {
      // The whole point of retiring a link field rather than leaving it
      // structural: `structural` is what the restore hands to `cf piece link`
      // after the apply has already landed, so a path the current pattern does
      // not declare there is a refusal the operator meets mid-restore, with
      // the content write done and unverified. An export taken before a topic
      // stored its own number carries exactly such a link.
      const { doc, structural, legacy } = buildRestoreDocument(
        { title: "t", boardNames: link },
        resolved,
      );
      expect(structural).toEqual([]);
      expect(legacy).toEqual(["boardNames"]);
      expect(doc.boardNames).toBeUndefined();
      expect(doc.title).toBe("t");
    });

    it("relinks a live link the target declares and the export never had", () => {
      // The mirror of the two cases above, and the direction a migration
      // reaches second: the EXPORT is the newer of the two. A topic filed
      // after the pattern stopped declaring `boardNames` never had one, so an
      // export taken from it names no such field — while a target still on the
      // old pattern holds a live link there. The apply replaces the whole
      // document, so a field in neither list is gone: the target's working
      // wiring is erased by an export that simply never mentioned it. The
      // relink needs nothing from the export, because it links to the board's
      // own path.
      const { doc, structural, legacy } = buildRestoreDocument(
        { title: "t" },
        resolved,
        { declaredLinks: ["boardNames"] },
      );
      expect(structural).toEqual(["boardNames"]);
      expect(legacy).toEqual([]);
      expect(doc.boardNames).toBeUndefined();
    });

    it("refuses a declared link it has no board path to relink from", () => {
      // `myName` is retirable but not structural: no board path re-establishes
      // it. A target declaring one the export does not name cannot be restored
      // without destroying it, and the throw comes before the apply rather
      // than after, which is the difference between a refusal and a loss.
      expect(() =>
        buildRestoreDocument({ title: "t" }, resolved, {
          declaredLinks: ["myName"],
        })
      ).toThrow("myName");
    });

    it("throws on a link-valued field it does not understand", () => {
      expect(() => buildRestoreDocument({ attachments: [link] }, resolved))
        .toThrow("attachments");
    });
  });

  describe("recreatedDocument", () => {
    const recreated = new Map([["of:fid1:old-2", "of:fid1:new-2"]]);
    const linkTo = (id: string, space?: string) => ({
      $link: { id, ...(space ? { space } : {}) },
    });

    /** An exported topic whose raw argument holds `raw` besides its body. */
    const exported = (raw: Record<string, unknown>): TopicExportRow => ({
      fid: "of:fid1:old-1",
      patternIdentity: "pattern",
      argumentId: "argument",
      content: { title: "t", body: "b", comments: [], links: [] },
      rawArgument: { title: "t", body: "b", ...raw },
    });

    it("points a mention of an exported topic at the topic recreated from it, and keeps any other", () => {
      const doc = recreatedDocument(
        exported({
          mentioned: [
            linkTo("of:fid1:old-2"),
            linkTo("of:fid1:elsewhere", "did:key:z"),
          ],
        }),
        "1",
        recreated,
      );
      expect(doc.mentioned).toEqual([
        storedLink("of:fid1:new-2"),
        storedLink("of:fid1:elsewhere", [], "did:key:z"),
      ]);
    });

    it("points each reference's destination at the topic recreated from it, keeping its wording flag", () => {
      const doc = recreatedDocument(
        exported({
          references: {
            "0": { destination: linkTo("of:fid1:old-2"), modifiedTitle: true },
          },
        }),
        "1",
        recreated,
      );
      expect(doc.references).toEqual({
        "0": { destination: storedLink("of:fid1:new-2"), modifiedTitle: true },
      });
    });

    it("keeps a reference to a piece outside the exported board as it was", () => {
      const doc = recreatedDocument(
        exported({
          references: {
            pr: {
              destination: linkTo("of:fid1:elsewhere", "did:key:z"),
              modifiedTitle: false,
            },
          },
        }),
        "1",
        recreated,
      );
      expect(doc.references).toEqual({
        pr: {
          destination: storedLink("of:fid1:elsewhere", [], "did:key:z"),
          modifiedTitle: false,
        },
      });
    });

    it("throws for a reference whose destination is not a link", () => {
      expect(() =>
        recreatedDocument(
          exported({
            references: { "0": { destination: "#2", modifiedTitle: false } },
          }),
          "1",
          recreated,
        )
      ).toThrow("of:fid1:old-1 references.0 is not a link");
    });
  });

  describe("recreateTopics", () => {
    /** The export's topics `old-1` to `old-<count>`, numbered from 1. */
    const exportOf = (count: number): [string, TopicExportRow][] =>
      Array.from({ length: count }, (_, at) => [String(at + 1), {
        fid: `of:fid1:old-${at + 1}`,
        patternIdentity: "pattern",
        argumentId: "argument",
        content: { title: `t${at + 1}`, comments: [], links: [] },
        rawArgument: { title: `t${at + 1}` },
      }]);

    /**
     * A fresh board, which numbers each topic it creates one past the topics
     * it holds, and a progress file. `steps` records each create and write in
     * `calls`. With `interrupted`, the first create lands on the board and
     * then fails before its progress line is written, as an interrupted run
     * does.
     */
    function freshBoard({ interrupted = false } = {}) {
      const held = new Map<string, string>();
      const progress = new Map<string, string>();
      const lines: ProgressLine[] = [];
      const calls: string[] = [];
      let interrupt = interrupted;
      const steps: RecreateSteps = {
        create: (name) => {
          const number = String(held.size + 1);
          if (number !== name) {
            return Promise.reject(new Error(`numbered ${number}, not ${name}`));
          }
          const id = `of:fid1:new-${number}`;
          held.set(number, id);
          calls.push(`create ${name}`);
          if (interrupt) {
            interrupt = false;
            return Promise.reject(new Error("interrupted"));
          }
          return Promise.resolve(id);
        },
        record: (line) => {
          lines.push(line);
          progress.set(line.from, line.to);
          return Promise.resolve();
        },
        write: (id) => {
          calls.push(`write ${id}`);
          return Promise.resolve();
        },
      };
      return { held, progress, lines, calls, steps };
    }

    it("records a topic an interrupted run created, rather than creating it again", async () => {
      const topics = exportOf(2);
      const board = freshBoard({ interrupted: true });
      await expect(
        recreateTopics(
          topics,
          board.progress,
          board.held,
          Infinity,
          board.steps,
        ),
      ).rejects.toThrow("interrupted");
      board.calls.length = 0;

      const counts = await recreateTopics(
        topics,
        board.progress,
        board.held,
        Infinity,
        board.steps,
      );
      expect(counts).toEqual({ reconciled: 1, created: 1, written: 2 });
      expect(board.calls).toEqual([
        "create 2",
        "write of:fid1:new-1",
        "write of:fid1:new-2",
      ]);
      expect(board.lines).toEqual([
        { name: "1", from: "of:fid1:old-1", to: "of:fid1:new-1" },
        { name: "2", from: "of:fid1:old-2", to: "of:fid1:new-2" },
      ]);
    });

    it("bounds both passes to the topics numbered up to the limit, so a rerun goes on from there", async () => {
      const topics = exportOf(4);
      const board = freshBoard();
      const run = async (limit: number) => {
        board.calls.length = 0;
        await recreateTopics(
          topics,
          board.progress,
          board.held,
          limit,
          board.steps,
        );
        return [...board.calls];
      };
      expect(await run(2)).toEqual([
        "create 1",
        "create 2",
        "write of:fid1:new-1",
        "write of:fid1:new-2",
      ]);
      expect(await run(2)).toEqual([
        "write of:fid1:new-1",
        "write of:fid1:new-2",
      ]);
      expect(await run(4)).toEqual([
        "create 3",
        "create 4",
        "write of:fid1:new-1",
        "write of:fid1:new-2",
        "write of:fid1:new-3",
        "write of:fid1:new-4",
      ]);
    });

    it("throws, before any write, for a board holding a number the export lacks", async () => {
      const board = freshBoard();
      board.held.set("1", "of:fid1:new-1");
      board.held.set("2", "of:fid1:other");
      await expect(
        recreateTopics(
          exportOf(1),
          board.progress,
          board.held,
          Infinity,
          board.steps,
        ),
      ).rejects.toThrow("2");
      expect(board.calls).toEqual([]);
      expect(board.lines).toEqual([]);
    });

    it("throws, before any write, for a progress file the board disagrees with", async () => {
      const board = freshBoard();
      board.held.set("1", "of:fid1:new-1");
      board.progress.set("of:fid1:old-1", "of:fid1:elsewhere");
      await expect(
        recreateTopics(
          exportOf(1),
          board.progress,
          board.held,
          Infinity,
          board.steps,
        ),
      ).rejects.toThrow("of:fid1:elsewhere");
      expect(board.calls).toEqual([]);
    });

    it("throws, before any write, for a recorded topic the board does not hold", async () => {
      const board = freshBoard();
      board.progress.set("of:fid1:old-1", "of:fid1:new-1");
      await expect(
        recreateTopics(
          exportOf(1),
          board.progress,
          board.held,
          Infinity,
          board.steps,
        ),
      ).rejects.toThrow("of:fid1:new-1");
      expect(board.calls).toEqual([]);
    });
  });

  describe("declaredRetirableLinks", () => {
    // No export fixture here on purpose: the probe asks the TARGET, and what
    // the export holds is not a parameter of the question.
    const probe = (answers: Record<string, unknown>) => (field: string) =>
      Promise.resolve(answers[field]);

    it("reads a bound link as declared", async () => {
      expect(
        await declaredRetirableLinks(probe({ boardNames: [{ name: "1" }] })),
      ).toEqual(["boardNames"]);
    });

    it("reads a declared input's own default as declared", async () => {
      // An unbound but declared `boardNames` answers with the `Default<[]>`
      // its input carries, which is what tells it apart from a path the
      // pattern does not declare at all. The 2026-09-05 clone rehearsal
      // measured that read.
      expect(
        await declaredRetirableLinks(probe({ boardNames: [] })),
      ).toEqual(["boardNames"]);
    });

    it("retires a link the target's own source no longer declares", async () => {
      // The case this change creates, and the one an export's vintage cannot
      // settle: a topic migrated past `boardNames` keeps the stored link in
      // its raw argument, so an export taken from it AFTERWARDS holds a link
      // at a path its own source does not declare — with the pattern identity
      // matching, because no migration separates the two. Classifying that as
      // declared sends the restore to `cf piece link` against a path that
      // refuses, after the content write has landed.
      expect(
        await declaredRetirableLinks(probe({})),
      ).toEqual([]);
    });

    it("asks about every retirable field, not only the ones the export holds", async () => {
      // What the export holds cannot bound the question, because the target is
      // the one being asked. A newer export names no `boardNames`; a target
      // still on the old pattern holds a live one, and the whole-document
      // apply erases whatever neither list names. So each retirable field is
      // probed once whether or not the export mentions it, and only the
      // structural fields — which are never retired — go unasked.
      const asked: string[] = [];
      const counted = (field: string) => {
        asked.push(field);
        return Promise.resolve(field === "boardNames" ? [] : undefined);
      };
      expect(
        await declaredRetirableLinks(counted),
      ).toEqual(["boardNames"]);
      expect(asked).toEqual([
        "myName",
        "boardNames",
        "boardCrossrefs",
        "boardCrossrefIndex",
        "board",
      ]);
    });
  });

  describe("publishedBoardSources", () => {
    it("returns the board paths that answer, asking each once", async () => {
      const asked: string[] = [];
      const read = (source: string) => {
        asked.push(source);
        return Promise.resolve(
          source === "mentionable" || source === "crossrefs"
            ? { "$link": { id: "of:fid1:board" } }
            : undefined,
        );
      };
      expect(await publishedBoardSources(read)).toEqual([
        "mentionable",
        "crossrefs",
      ]);
      expect([...asked].sort()).toEqual([
        "board",
        "crossrefIndex",
        "crossrefs",
        "mentionable",
        "namesTable",
      ]);
    });
  });

  describe("import graph", () => {
    // `topics-restore.ts` declares `--allow-run --allow-read --allow-env` in
    // its shebang and talks to a running server over `cf`. `@db/sqlite` opens
    // its dynamic library with a top-level `await dlopen`, and the only entry
    // point `@commonfabric/state-inspector` publishes re-exports the module
    // that imports it — so one import of that barrel anywhere in the restore's
    // graph makes the script die at module load with a permission error,
    // whatever permissions the pure function it wanted actually needs. Twice
    // now that failure was hidden by testing the script under `deno run -A`,
    // which is why this asks the graph rather than trusting the run.

    it("names no store-reader dependency in the restore's graph", async () => {
      // Static `from "…"` specifiers followed through relative hops, which is
      // the whole of these scripts' own graph: they use no dynamic import and
      // no re-export. A bare specifier ends the walk — what a package pulls in
      // behind its own entry point is the reason this check exists.
      const seen = new Set<string>();
      const bare = new Set<string>();
      const queue = [new URL("./topics-restore.ts", import.meta.url)];
      while (queue.length > 0) {
        const module = queue.pop()!;
        if (seen.has(module.href)) continue;
        seen.add(module.href);
        const source = await Deno.readTextFile(module);
        for (const [, specifier] of source.matchAll(/from\s+"([^"]+)"/g)) {
          if (specifier.startsWith(".")) queue.push(new URL(specifier, module));
          else bare.add(specifier);
        }
      }
      expect(seen.size).toBeGreaterThan(1);
      expect([...bare]).not.toContain("@commonfabric/state-inspector");
    });
  });

  describe("normalizeFid", () => {
    it("returns a bare of-prefixed id for every accepted spelling", () => {
      expect(normalizeFid("of:fid1:abc")).toBe("of:fid1:abc");
      expect(normalizeFid("fid1:abc")).toBe("of:fid1:abc");
      expect(normalizeFid("/of:fid1:abc")).toBe("of:fid1:abc");
      expect(normalizeFid("/of:fid1:abc#argument")).toBe("of:fid1:abc");
    });
  });
});
