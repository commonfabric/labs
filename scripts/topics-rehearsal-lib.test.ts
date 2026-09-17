/** Unit coverage for the pure halves of the Topics export/restore pair; the
 * live halves are exercised by the rehearsal drill
 * (`packages/cli/integration/topics-restore-drill.sh`). */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  buildRestoreDocument,
  deepEqual,
  findLink,
  isAbsentPathError,
  normalizeFid,
  retiredKeys,
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
          boardCrossrefs: link,
          boardNames: link,
          myName: link,
        },
        resolved,
      );
      expect(structural).toEqual(["mentionable", "boardCrossrefs"]);
      // In the raw argument's own order, which is what the walk follows.
      expect(legacy).toEqual(["boardNames", "myName"]);
      expect(doc.mentionable).toBeUndefined();
      expect(doc.boardCrossrefs).toBeUndefined();
      expect(doc.boardNames).toBeUndefined();
      expect(doc.myName).toBeUndefined();
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

    it("throws on a link-valued field it does not understand", () => {
      expect(() => buildRestoreDocument({ attachments: [link] }, resolved))
        .toThrow("attachments");
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
