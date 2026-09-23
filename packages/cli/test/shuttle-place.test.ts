/**
 * Unit tests for the place value and the module that owns it. A place is a
 * value and every move over it is a decision about one, so a case stands a
 * `CurrentPlace` somewhere, hands `cd` a string, and reads back both what the
 * move returned and where the instance ended up. No connection, no I/O and no
 * clock stands behind any of it, which is what makes a case per move, per
 * rendering and per refusal affordable.
 *
 * The returned outcome is the half to read first, because only two of the
 * five arms a `Move` has are verdicts: the move landed, or it is refused. The
 * other three report that the operand is one this module does not settle — a
 * `#name` wish target, a reference naming its space by name, and a place
 * standing on a piece, which the fabric has still to be asked to resolve and
 * to find — since settling any of them needs a connection to read over. Their
 * cases pin what gets handed on, and that the place did not move.
 *
 * The pending arm is the one nearly every case meets, a piece being where
 * navigation goes, so `moved()` (`shuttle-place-helpers.ts`) lands one with
 * the piece the operand itself named. That leaves each case saying what it
 * says about the reading and nothing about a resolution; the resolution has a
 * block of its own.
 *
 * A refusal's text is pinned whole, and several of them are somebody else's
 * words. Shuttle consumes the reference grammar rather than forking it, so
 * that grammar's diagnostics reach the reader unaltered, whichever door read
 * the operand — the space-mismatch sentence from `normalizeLLMFriendlyRef`;
 * the invalid-space, unknown-member, scope and duplicate-qualifier sentences
 * from the shared reader (`packages/runner/src/cell-reference.ts`); and the
 * not-a-slug sentence from `validatePieceSegment`, which every door relays and
 * not the reference alone. Each is marked at its case as relayed.
 * When one moves upstream, the fix is to copy the new sentence here, never to
 * match a fragment of it: the whole sentence is what pins that the diagnostic
 * arrives intact, and a substring would let a rewording through that says
 * something else. Other diagnostics from that layer reach a reader without a
 * case here — a piece segment that is no handle and holds a colon, a `@pin=`
 * value of the wrong length — and pinning these is enough to hold the relay
 * itself, since all of them travel the same path.
 *
 * Every other refusal in this file is shuttle's own.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { CellScope } from "@commonfabric/api";
import type { MemorySpace } from "@commonfabric/memory/interface";

import {
  CurrentPlace,
  FACETS,
  type HandleMove,
  type Move,
  operandForChild,
  type PendingMove,
  placeAtSpaceRoot,
  type ResolvedPlace,
} from "../lib/shuttle/place.ts";
import { RECORD_LABEL_WIDTH } from "../lib/shuttle/record.ts";
import { landed, moved } from "./shuttle-place-helpers.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const OTHER_SPACE = "did:key:z6MkOtherSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/** A `@pin=` value of the length the reader takes, which no place holds. */
const PIN = "A".repeat(43);

/** The shared reader's refusal for a qualifier that names no scope. */
const SCOPE_REFUSAL = "Invalid scope suffix. Expected `@space`, `@user`, " +
  "`@session`, or `@inherit`; other qualifiers use `@name=value` " +
  "(registered names: scope, pin). Put `#argument` before qualifiers on the " +
  "piece segment.";

/** The shared reader's refusal for a member that is not one. */
const MEMBER_REFUSAL =
  "Unknown member. Expected `#argument` or `#result` on the piece segment.";

/** Shuttle's refusal for a move that selects the arguments cell. */
const CD_MEMBER_REFUSAL = "A place is result-rooted, so `cd` selects no " +
  "`#argument` member. A place rooted at the arguments cell would leave " +
  "every later relative read ambiguous about which side of the piece it " +
  "addressed. Reach arguments per operand instead, as in " +
  "`get .#argument/title` or `get /slugs/board#argument/title`.";

/** Shuttle's refusal for `operand` carrying a `@pin=` qualifier. */
function pinRefusal(operand: string): string {
  return `\`${operand}\` carries a \`@pin=\` qualifier, and shuttle reads a ` +
    "piece as it runs rather than at a pinned version. Write the operand " +
    "without the qualifier.";
}

/** Shuttle's refusal for `operand` selecting the member where no piece is. */
function containerMemberRefusal(operand: string): string {
  return `\`${operand}\` selects the \`#argument\` member where no piece ` +
    "stands: a space root and a facet are lists of what stands inside them. " +
    "Name the piece the member is on, as in " +
    "`get /slugs/board#argument/title`.";
}

/** Helper for the cases below, which stands an instance at the space root. */
function atSpaceRoot(): CurrentPlace {
  return new CurrentPlace(SPACE);
}

/** Helper for the cases below, which stands an instance inside `slugs/`. */
function inSlugs(): CurrentPlace {
  const place = atSpaceRoot();
  moved(place, "slugs");
  return place;
}

/**
 * Helper for the cases below, which reads the position `pwd` printed.
 *
 * It slices the width the format exports rather than the label it happens to
 * write, so a change to either moves this with it.
 */
function printedPosition(place: CurrentPlace): string {
  const [position] = place.render().split("\n");
  return position.slice(RECORD_LABEL_WIDTH);
}

/** Helper for the cases below, which stands an instance at a named piece. */
function atReferencedPiece(): CurrentPlace {
  const place = atSpaceRoot();
  moved(place, `/${HANDLE}`);
  return place;
}

/** Helper for the cases below, which stands an instance at a piece. */
function atPiece(): CurrentPlace {
  const place = inSlugs();
  moved(place, "board");
  return place;
}

describe("place", () => {
  describe("FACETS", () => {
    it("holds `slugs` and `pieces`, and nothing else", () => {
      expect(FACETS).toEqual(["slugs", "pieces"]);
    });
  });

  describe("placeAtSpaceRoot()", () => {
    it("returns the space's root read at the base scope", () => {
      expect(placeAtSpaceRoot(SPACE)).toEqual({
        position: { kind: "root", space: SPACE },
        scope: "space",
      });
    });
  });

  describe("operandForChild()", () => {
    // The readings `cd()` applies, asked in the other direction. Inside a
    // piece a key is offered as the shared renderer writes it against the
    // place — bare, or behind the `.` head where the reference grammar would
    // read the bare form as a head — and behind the `.` head where one of
    // shuttle's own readings takes the renderer's form; a child no door admits
    // is reached by none of them. Above a piece a name is its own operand, and
    // a piece's complete reference is the fallback.
    //
    // One of the readings is not this module's. A token opening with `-`
    // reaches a verb as an option rather than as an operand, so a name spelled
    // that way is offered behind the `.` head, and the case for it turns on
    // `readsAsOption` (`options.ts`) rather than on any move made here.
    //
    // Two clauses of the comparison behind it have no case, and both are
    // unreachable from this door rather than untested. No spelling tried
    // moves the scope: inside a piece the renderer writes no qualifier against
    // the place's own scope, and a key that looks like one sits behind the `.`
    // head as data; above a piece the reference is rendered carrying the
    // place's scope, and a qualifier on a piece segment moves the piece too
    // and fails the position clause first. And a
    // space root's children are a closed set, checked before a candidate is
    // tried, so a candidate that lands on a facet lands on the facet named.
    // The comparison is over the whole place because a place is one, and an
    // operand landing anywhere else would name another cell; this paragraph is
    // read again if either clause becomes reachable.

    it("returns the name itself for a key the name's own reading names", () => {
      expect(operandForChild(atReferencedPiece().place, "title")).toBe("title");
    });

    it("returns a facet's own name at a space root", () => {
      expect(operandForChild(placeAtSpaceRoot(SPACE), "slugs")).toBe("slugs");
    });

    it("returns nothing at a space root for a name it lists no facet under", () => {
      expect(operandForChild(placeAtSpaceRoot(SPACE), "fuse")).toBeUndefined();
    });

    it("returns a piece's own name inside a facet", () => {
      expect(operandForChild(inSlugs().place, "board")).toBe("board");
    });

    it("returns the `.` head in front of a key called `..`", () => {
      // The renderer's own form: `..` bare would be read as a climb. Kills a
      // candidate list that offers the bare name first.

      expect(operandForChild(atReferencedPiece().place, "..")).toBe("./..");
    });

    it("returns the `.` head and the separator for the empty key", () => {
      // Kills a walk that drops a final empty key inside a piece, where `./`
      // would then reach the piece rather than the key.

      expect(operandForChild(atReferencedPiece().place, "")).toBe("./");
    });

    it("returns the `.` head in front of a key opening with `-`, which the option grammar reads as an option", () => {
      // Kills an `operandForChild` that stops consulting `readsAsOption`.

      expect(operandForChild(atReferencedPiece().place, "-x")).toBe("./-x");
    });

    it("returns the `.` head in front of a key called `--`, the token that ends the options", () => {
      expect(operandForChild(atReferencedPiece().place, "--")).toBe("./--");
    });

    it("returns the `.` head in front of a key called `-`, the previous place's reading", () => {
      // Kills a candidate list holding the renderer's form alone: `-` bare
      // returns to the previous place, which the renderer knows nothing of.

      expect(operandForChild(atReferencedPiece().place, "-")).toBe("./-");
    });

    it("returns the `.` head in front of a key opening with the handle sigil", () => {
      // Kills the same list for the `%n` head reading.

      expect(operandForChild(atReferencedPiece().place, "%1")).toBe("./%1");
    });

    it("returns the separator escaped for a key that holds it", () => {
      // Kills a relative walk that reads `~1` as two characters.

      expect(operandForChild(atReferencedPiece().place, "a/b")).toBe("a~1b");
    });

    it("returns a key ending in whitespace as itself, the reader keeping the edge", () => {
      // Kills a door that still refuses a segment ending in whitespace.

      expect(operandForChild(atReferencedPiece().place, "a ")).toBe("a ");
    });

    it("returns nothing for a key no rendering names back", () => {
      expect(operandForChild(atReferencedPiece().place, "a\nb"))
        .toBeUndefined();
    });

    it("returns the `.` head in front of a key whose first character opens a wish target", () => {
      // Kills the same list for the `#name` head reading.

      expect(operandForChild(atReferencedPiece().place, "#b")).toBe("./#b");
    });

    it("returns nothing for a piece name in neither vocabulary", () => {
      expect(operandForChild(inSlugs().place, "Board")).toBeUndefined();
    });

    it("returns an operand `cd` moves to the child by", () => {
      const place = atReferencedPiece();
      const operand = operandForChild(place.place, "..");
      expect(operand).toBeDefined();
      moved(place, operand as string);
      expect(place.place.position).toEqual({
        kind: "piece",
        space: SPACE,
        piece: HANDLE,
        path: [".."],
      });
    });
  });

  describe("render()", () => {
    it("returns a space root with no leading slash, and the scope", () => {
      expect(atSpaceRoot().render()).toBe(
        "position  @did:key:z6MkConnectedSpace/\nscope     @space",
      );
    });

    it("returns a facet with no leading slash", () => {
      expect(inSlugs().render()).toBe(
        "position  @did:key:z6MkConnectedSpace/slugs/\nscope     @space",
      );
    });

    it("returns a piece and its path as a complete reference, the scope written", () => {
      const place = atPiece();
      moved(place, "topics/3");
      moved(place, ".@session");
      expect(place.render()).toBe(
        "position  //did:key:z6MkConnectedSpace/board@session/topics/3\n" +
          "scope     @session",
      );
    });

    it("returns the shared renderer's complete form at the base scope", () => {
      // The table's row. Kills a rendering that leaves the base scope
      // unwritten, or writes the space in the `/@<space>/` form.

      const place = atPiece();
      moved(place, "items/0");
      expect(printedPosition(place)).toBe(
        "//did:key:z6MkConnectedSpace/board@space/items/0",
      );
    });

    describe("round-tripping", () => {
      // What a reader copies whole has to name the place it was printed
      // for, or name nothing. A piece is a cell, so its rendering is a
      // reference and `cd` takes it back; a container is not a cell, so its
      // rendering is not a reference and `cd` refuses it rather than
      // resolving it to a piece whose slug happens to match the container's
      // name. A segment lifted out of a rendering is outside that, for two
      // reasons: it becomes an operand in its own right, so the head
      // readings decide it, and the rendering escapes a `/` in a key where
      // a relative operand reads no escape. The walk's own cases pin both.

      it("returns a piece rendering `cd` takes back to the same place, pasted whole", () => {
        const place = atPiece();
        moved(place, "topics/3");
        const elsewhere = atSpaceRoot();
        moved(elsewhere, printedPosition(place));
        expect(elsewhere.place).toEqual(place.place);
      });

      it("escapes a `/` in a key, and takes that rendering back whole", () => {
        const place = atSpaceRoot();
        moved(place, `/${HANDLE}/a~1b`);
        const printed = printedPosition(place);
        expect(printed).toBe(
          "//did:key:z6MkConnectedSpace/of:fid1:abcdefghijklmnop@space/a~1b",
        );
        const elsewhere = atSpaceRoot();
        moved(elsewhere, printed);
        expect(elsewhere.place).toEqual(place.place);
      });

      it("returns a rendering `cd` takes back where a key holds a `#`", () => {
        // `#` in a path is data to the reader, so the rendering names the key.
        // Kills a reference door that reads `#` anywhere in the path.

        const place = atReferencedPiece();
        moved(place, "a#b");
        const elsewhere = atSpaceRoot();
        moved(elsewhere, printedPosition(place));
        expect(elsewhere.place).toEqual(place.place);
      });

      it("returns a rendering `cd` takes back for the empty key and a key ending in whitespace", () => {
        // Kills a reader or a renderer that drops a trailing empty key or a
        // trailing space, which would name the cell above.

        const place = atReferencedPiece();
        moved(place, "./");
        moved(place, "a ");
        const elsewhere = atSpaceRoot();
        moved(elsewhere, printedPosition(place));
        expect(elsewhere.place).toEqual(place.place);
        expect(elsewhere.place.position).toMatchObject({ path: ["", "a "] });
      });

      describe("over a constructed set of awkward parts", () => {
        // Five findings in this class arrived one at a time, each from
        // driving a value nobody had listed. This drives a construction and
        // asserts the property rather than the outcomes: a rendering may be
        // refused, but it may never name a cell other than the one it was
        // printed for.
        //
        // What it varies is as load-bearing as the property. A construction
        // that holds a component fixed checks a slice and reads like a
        // class, which is how a piece went unguarded while every path was
        // covered. So both parts a position spells vary, the empty value is
        // a candidate in its own right rather than something the shapes
        // happen not to reach, and every door that admits a position is
        // driven.
        //
        // Held fixed, and why: the space, which one connection settles and
        // no operand supplies, and the facet, which is a fixed set of
        // literals.
        // Everything else varies, and varies crosswise: both parts a
        // position spells, each driven through every door in the table
        // below, at each of the three scopes. Reading back stands at a
        // scope of its
        // own, so the comparison sees whether the rendering carried the
        // scope or the reader supplied it.

        const MARKS = [
          " ",
          "\t",
          "\n",
          "\r",
          "\v",
          "\f",
          "\u00a0",
          "\u2028",
          "\u2029",
          "/",
          "~",
          "#",
          "@",
          "-",
          ".",
        ];

        /**
         * Helper for the case below, which is every awkward spelling of a
         * part whose ordinary spelling is `head` followed by `tail`.
         */
        function candidates(head: string, tail: string): string[] {
          // The digit spellings sit here rather than among the marks: what
          // they exercise is the conversion a path segment goes through,
          // where a canonical index becomes a number and everything else
          // stays a string, and a door that skips it disagrees with the
          // three that do not.
          const values = ["", "3", "0", "01", "1e21", "-1", "1.5"];
          for (const mark of MARKS) {
            values.push(
              mark + head + tail,
              head + tail + mark,
              head + mark + tail,
              mark,
            );
          }
          return values;
        }

        it("never renders a place that reads back as a different one", () => {
          let readBack = 0;
          let refusedPart = 0;
          let refusedRendering = 0;

          /**
           * Helper for this case, which holds the property over `place`,
           * reading its rendering back from `reader` — a scope the place is
           * not at, so a rendering that omitted the scope would be filled
           * with the wrong one rather than silently the right one.
           */
          function check(place: CurrentPlace, move: Move, reader: CellScope) {
            if (move.kind !== "moved") {
              refusedPart++;
              return;
            }
            const elsewhere = atSpaceRoot();
            moved(elsewhere, `.@${reader}`);
            if (moved(elsewhere, printedPosition(place)).kind !== "moved") {
              refusedRendering++;
              return;
            }
            readBack++;
            expect(elsewhere.place).toEqual(place.place);
          }

          const scopes: CellScope[] = ["space", "user", "session"];

          // The matrix. A door is driven for every component rather than
          // for whichever one its loop happened to sit in — that asymmetry
          // is how `settle` kept an unnormalized path while every other
          // door normalized, in a block whose comment claimed all four.
          const doors: {
            door: string;
            piece: (at: CurrentPlace, value: string) => Move;
            segment: (at: CurrentPlace, value: string) => Move;
          }[] = [
            {
              door: "enter",
              piece: (at, v) =>
                at.enter({ space: SPACE, piece: v, path: [] }, "#x"),
              segment: (at, v) =>
                at.enter({ space: SPACE, piece: HANDLE, path: [v] }, "#x"),
            },
            {
              door: "settle",
              piece: (at, v) =>
                landed(
                  at,
                  at.settle({
                    kind: "space-by-name",
                    name: "estuary",
                    operand: `//estuary/${v}`,
                    piece: v,
                    path: [],
                    scope: at.place.scope,
                  }, SPACE),
                ),
              segment: (at, v) =>
                landed(
                  at,
                  at.settle({
                    kind: "space-by-name",
                    name: "estuary",
                    operand: `//estuary/${HANDLE}/${v}`,
                    piece: HANDLE,
                    path: [v],
                    scope: at.place.scope,
                  }, SPACE),
                ),
            },
            {
              door: "walk",
              piece: (at, v) => (moved(at, "slugs"), moved(at, v)),
              segment: (at, v) => (moved(at, `/${HANDLE}`), moved(at, v)),
            },
            {
              door: "reference",
              piece: (at, v) => moved(at, `/${v}`),
              segment: (at, v) => moved(at, `/${HANDLE}/${v}`),
            },
          ];

          const pieces = candidates(HANDLE.slice(0, 10), HANDLE.slice(10));
          const segments = candidates("b", "c");
          for (const [index, scope] of scopes.entries()) {
            const reader = scopes[(index + 1) % scopes.length];

            /** Helper for this case, which stands at `scope` to begin with. */
            const standing = (): CurrentPlace => {
              const place = atSpaceRoot();
              moved(place, `.@${scope}`);
              return place;
            };

            for (const { piece, segment } of doors) {
              for (const value of pieces) {
                const at = standing();
                check(at, piece(at, value), reader);
              }
              for (const value of segments) {
                const at = standing();
                check(at, segment(at, value), reader);
              }
            }
            // A segment reached past another one, which is the only shape
            // the single-segment drives above cannot make.
            for (const value of segments) {
              for (const path of [[value, "tail"], ["head", value]]) {
                const at = standing();
                check(
                  at,
                  at.enter({ space: SPACE, piece: HANDLE, path }, "#x"),
                  reader,
                );
              }
            }
          }

          // Every outcome has to occur, or the property above holds for want
          // of anything to hold over.
          expect(readBack).toBeGreaterThan(0);
          expect(refusedPart).toBeGreaterThan(0);
          expect(refusedRendering).toBeGreaterThan(0);
        });
      });

      it("returns a base-scope rendering a reader elsewhere reads as base", () => {
        // The case the ruling turns on. A rendering that omitted the base
        // suffix would be filled from wherever it was read, so reading one
        // from a `@user` shuttle is what tells "the scope was written and
        // read" apart from "the scope was absent and supplied".

        const place = atPiece();
        expect(place.place.scope).toBe("space");
        const elsewhere = atSpaceRoot();
        moved(elsewhere, ".@user");
        moved(elsewhere, printedPosition(place));
        expect(elsewhere.place).toEqual(place.place);
      });

      it("returns a container rendering whose refusal names the right fault", () => {
        // A container's rendering opens with the space's `@`, which is data
        // rather than a reading, so pasting one back is a walk from where it
        // is pasted. The refusal has to be about what was pasted.

        const place = inSlugs();
        const move = moved(atSpaceRoot(), printedPosition(place));
        expect(move).toEqual({
          kind: "refused",
          reason: "A space root lists facets, and " +
            "`@did:key:z6MkConnectedSpace` names none. The facets are " +
            "`slugs/` and `pieces/`.",
        });
      });

      it("returns a space root rendering `cd` refuses", () => {
        const place = atSpaceRoot();
        expect(moved(place, printedPosition(place)).kind).toBe("refused");
        expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
      });

      it("returns a facet rendering `cd` refuses", () => {
        const place = inSlugs();
        const facet = place.place;
        expect(moved(place, printedPosition(place)).kind).toBe("refused");
        expect(place.place).toEqual(facet);
      });
    });
  });

  describe("label()", () => {
    // The short form the prompt carries. What every case here turns on is
    // that it says what the place holds and nothing else: the space is left
    // out, and nothing that stays is abbreviated.

    it("returns a space root as the separator alone, and the scope", () => {
      expect(atSpaceRoot().label()).toBe("/ @space");
    });

    it("returns a facet with the separator that says it is one", () => {
      expect(inSlugs().label()).toBe("/slugs/ @space");
    });

    it("returns a piece and its path without the space in front", () => {
      const place = atPiece();
      moved(place, "topics/3");
      expect(place.label()).toBe("board/topics/3 @space");
    });

    it("returns the scope the place reads through", () => {
      const place = atPiece();
      moved(place, ".@session");
      expect(place.label()).toBe("board @session");
    });

    it("returns a piece named as the operand named it, cut down no further", () => {
      // The prompt does no shortening beyond leaving the space out, so a
      // handle prints whole. A prefix of one would print exactly as a whole
      // handle does, and nothing in it would say which it was.

      expect(atReferencedPiece().label()).toBe(`${HANDLE} @space`);
    });

    it("returns a key holding the separator as one segment", () => {
      const place = atPiece();
      moved(place, "/board/a~1b");
      expect(place.label()).toBe("board/a~1b @space");
    });
  });

  describe("a part a terminal would act on", () => {
    // The classification the doors turn on, pinned one character at a time.
    // The matrix above sorts a refusal and a round trip into buckets and
    // asserts only that each bucket has something in it, so a character moving
    // between them leaves it green. What says which bucket a character is in
    // is here.

    const ACTED_ON: [string, string][] = [
      ["\u0000", "a null"],
      ["\t", "a tab"],
      ["\u000b", "a vertical tab"],
      ["\f", "a form feed"],
      ["\r", "a carriage return"],
      ["\u001b", "an escape"],
      ["\u007f", "a delete"],
      ["\u009b", "the C1 sequence introducer"],
    ];

    const PRINTED: [string, string][] = [
      ["\u00a0", "a no-break space"],
      ["\u2028", "the line separator"],
      ["\u2029", "the paragraph separator"],
    ];

    it("refuses a segment holding one, whichever door reads it", () => {
      for (const [mark] of ACTED_ON) {
        const walked = atPiece();
        expect(moved(walked, `b${mark}c`)).toEqual({
          kind: "refused",
          reason: `\`b${mark}c\` has a segment holding a control ` +
            "character, so a terminal would act on it rather than print it.",
        });
        const entered = atSpaceRoot();
        const move = entered.enter(
          { space: SPACE, piece: HANDLE, path: [`b${mark}c`] },
          "#x",
        );
        expect(move.kind).toBe("refused");
        expect(entered.place).toEqual(placeAtSpaceRoot(SPACE));
      }
    });

    it("refuses a piece holding one, which the handle rule's length test takes", () => {
      // `isPieceHandle` counts characters rather than reading them, so a
      // handle-shaped piece carries anything past the vocabulary check. The
      // reason is that door's own: no slug holds one and base64url has none.

      for (const [mark] of ACTED_ON) {
        const piece = `of:fid1:aaaaaaaaaa${mark}aaaaaaaaa`;
        expect(moved(atSpaceRoot(), `/${piece}`)).toEqual({
          kind: "refused",
          reason: `\`/${piece}\` has a piece holding a control character, ` +
            "so no piece carries that name: a slug is lowercase letters, " +
            "numbers, and single hyphens between words, and a handle is " +
            "`of:fid1:` and unpadded base64url.",
        });
      }
    });

    it("admits a separator a terminal prints rather than acts on", () => {
      // These keep company with the others in habit rather than in any rule:
      // a reader of text breaks a line on them and a terminal does not, and
      // the printer quotes them, being whitespace to the split.

      for (const [mark] of PRINTED) {
        const at = atPiece();
        expect(moved(at, `b${mark}c`).kind).toBe("moved");
        expect(at.place.position).toEqual({
          kind: "piece",
          space: SPACE,
          piece: "board",
          path: [`b${mark}c`],
        });
      }
    });

    it("leaves a line break the reason it already had, which is not this one", () => {
      // A break is acted on by a terminal too, and one door earlier it is
      // refused for the older harm: the rendering would split and a shorter
      // reference would name another cell. What a person is told is the reason
      // that describes what would actually go wrong.

      expect(moved(atPiece(), "b\nc")).toEqual({
        kind: "refused",
        reason: "`b\nc` has a segment holding a line break, so a rendering " +
          "of the place would name a different cell.",
      });
    });
  });

  describe("CurrentPlace", () => {
    describe("constructor()", () => {
      it("returns an instance standing at the root of the space it was given", () => {
        // The constructor takes a space and not a place, so there is no
        // door here for a position the other four would refuse.

        expect(atSpaceRoot().place).toEqual(placeAtSpaceRoot(SPACE));
      });

      it("returns an instance with no previous place", () => {
        expect(atSpaceRoot().previous).toBeUndefined();
      });
    });

    describe("instance members", () => {
      describe("place", () => {
        it("returns the place a landed move moved to", () => {
          const place = atSpaceRoot();
          moved(place, "pieces");
          expect(place.place).toEqual({
            position: { kind: "facet", space: SPACE, facet: "pieces" },
            scope: "space",
          });
        });

        it("returns the place shuttle stood at when a move is refused", () => {
          const place = atSpaceRoot();
          moved(place, "board");
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("returns the place shuttle stood at for a wish target", () => {
          const place = atSpaceRoot();
          moved(place, "#favorites");
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("returns the place shuttle stood at for a space named by name", () => {
          const place = atSpaceRoot();
          moved(place, `//estuary/${HANDLE}`);
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });
      });

      describe("previous", () => {
        it("returns the place a landed move moved out of", () => {
          const place = atSpaceRoot();
          moved(place, "slugs");
          expect(place.previous).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("returns nothing after a refused move", () => {
          const place = atSpaceRoot();
          moved(place, "board");
          expect(place.previous).toBeUndefined();
        });
      });

      describe("cd()", () => {
        it("refuses an empty operand", () => {
          expect(moved(atSpaceRoot(), "")).toEqual({
            kind: "refused",
            reason: "`cd` was given an empty operand, which names no place.",
          });
        });

        it("refuses an operand that is only whitespace for naming no child", () => {
          // An empty operand and a quoted space are two mistakes rather than
          // one: the first gave nothing, and the second gave a name that is
          // only a space. A name reaches the rule the position's own children
          // answer to, which at a space root is the closed set of facets.

          expect(moved(atSpaceRoot(), " ")).toEqual({
            kind: "refused",
            reason: "A space root lists facets, and ` ` names none. The " +
              "facets are `slugs/` and `pieces/`.",
          });
        });

        describe("what comes back for a read", () => {
          // Which moves wait on the fabric and which do not. A move onto a
          // piece waits, because whether the space holds one is nothing a
          // value knows; a move to a container, and one back to a place
          // already stood at, does not.

          /** Helper for the cases below, which is `operand` moved, unlanded. */
          function step(place: CurrentPlace, operand: string): Move {
            return place.cd(operand);
          }

          it("hands back a piece a walk reached, with the route it walked", () => {
            const place = inSlugs();
            expect(step(place, "board")).toEqual({
              kind: "pending",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "space",
              },
              operand: "board",
              route: [
                { kind: "root", space: SPACE },
                { kind: "facet", space: SPACE, facet: "slugs" },
              ],
            });
          });

          it("leaves shuttle where it stood while the read is outstanding", () => {
            const place = inSlugs();
            const before = place.place;
            step(place, "board");
            expect(place.place).toBe(before);
          });

          it("hands back a piece a reference reached, with no route", () => {
            expect(step(atSpaceRoot(), `/${HANDLE}/title`)).toEqual({
              kind: "pending",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: ["title"],
                },
                scope: "space",
              },
              operand: `/${HANDLE}/title`,
              route: [],
            });
          });

          it("hands back a key a walk inside a piece reached", () => {
            expect(step(atReferencedPiece(), "topics").kind).toBe("pending");
          });

          it("lands a facet, which is a name rather than a thing to find", () => {
            expect(step(atSpaceRoot(), "slugs").kind).toBe("moved");
          });

          it("lands `..`, `-` and `/`, each a place already stood at", () => {
            // One case for the three, because what they share is the whole
            // claim: none of them reaches anywhere a read has not been.

            const place = atPiece();
            moved(place, "topics");
            for (const operand of ["..", "-", "/"]) {
              expect(step(place, operand).kind).toBe("moved");
            }
          });

          it("hands back a scope on its own, the place at it being unread", () => {
            // A scope selects which document a piece's id names, so the same
            // path at another scope is another cell and nothing has read it.
            // The position does not move, and the trail comes through whole.

            const place = atPiece();
            moved(place, "topics");
            expect(step(place, ".@session")).toEqual({
              kind: "pending",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: ["topics"],
                },
                scope: "session",
              },
              operand: ".@session",
              route: [
                { kind: "root", space: SPACE },
                { kind: "facet", space: SPACE, facet: "slugs" },
                {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
              ],
            });
          });

          it("lands a scope on its own at a container, which is no cell", () => {
            // A root and a facet are lists of names rather than cells, so
            // there is nothing for an overlay to select within and nothing to
            // read.

            expect(step(inSlugs(), ".@session").kind).toBe("moved");
            expect(step(atSpaceRoot(), ".@user").kind).toBe("moved");
          });

          it("lands a head that climbs out of the piece, there being no piece left to ask about", () => {
            // Two climbs through the trail leave `board/topics` for the facet
            // it was reached through. A walk after a head is literal, so a
            // head is the one way an operand leaves a piece.

            const place = atPiece();
            moved(place, "topics");
            expect(step(place, "../..").kind).toBe("moved");
          });

          it("hands back a walk whose `..` after a key is that key's child, nothing having climbed", () => {
            // Kills a walk that still reads `..` in a later segment as a climb,
            // which would land this on the facet.

            expect(step(inSlugs(), "board/..")).toMatchObject({
              kind: "pending",
              place: { position: { piece: "board", path: [".."] } },
            });
          });

          it("hands back a head that climbs and then descends to a level nothing read", () => {
            // The climb reaches `topics`, which was read on the way in, and
            // the descent to `4` is not, so the whole walk waits.

            const place = atReferencedPiece();
            moved(place, "topics/3");
            expect(step(place, "../4").kind).toBe("pending");
          });

          it("lands a walk that ends exactly where it started", () => {
            // Up and back down again reaches the place shuttle was standing
            // at, and that was settled when shuttle arrived — there is
            // nothing left for a read to check.

            const place = atReferencedPiece();
            moved(place, "topics");
            const before = place.place;
            expect(step(place, "../topics")).toEqual({
              kind: "moved",
              place: before,
            });
          });
        });

        describe("a rooted operand naming a facet", () => {
          // The facet names are reserved as the first segment of a rooted
          // reference as well as at the root, so `/slugs/board` is the walk
          // `cd /` and `cd slugs/board` make rather than a piece slugged
          // `slugs` with `board` inside it.

          it("walks from the root for `/slugs/<slug>`", () => {
            const place = atSpaceRoot();
            moved(place, `/slugs/board`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: [],
            });
          });

          it("leaves the route the walk leaves, so `..` reaches the facet", () => {
            const place = atSpaceRoot();
            moved(place, "/slugs/board");
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("reaches the facet itself for `/slugs`", () => {
            expect(moved(atPiece(), "/slugs")).toEqual({
              kind: "moved",
              place: {
                position: { kind: "facet", space: SPACE, facet: "slugs" },
                scope: "space",
              },
            });
          });

          it("walks from the root for `/pieces/<handle>`", () => {
            const place = atSpaceRoot();
            moved(place, `/pieces/${HANDLE}`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: [],
            });
          });

          it("takes the facet form the prompt prints back to that facet", () => {
            // The short form writes a container with the leading separator,
            // and the claim it makes is that the separator reads as the walk
            // down from the root. This is that claim.

            const place = inSlugs();
            const printed = place.label().split(" ")[0];
            expect(printed).toBe("/slugs/");
            const elsewhere = atSpaceRoot();
            moved(elsewhere, printed);
            expect(elsewhere.place).toEqual(place.place);
          });

          it("quotes what was written, not the walk it was read as", () => {
            // The walk drops the separator that rooted the operand, and a
            // refusal names what a person typed rather than what the reading
            // made of it.

            expect(moved(atSpaceRoot(), `/pieces/${HANDLE}/a\nb`)).toEqual({
              kind: "refused",
              reason: `\`/pieces/${HANDLE}/a\nb\` has a segment holding a ` +
                "line break, so a rendering of the place would name a " +
                "different cell.",
            });
          });

          it("reads every segment after the separator literally, reaching what the walk from the root reaches", () => {
            // The table's row. Kills a rooted walk that reads `..` as a climb,
            // which would leave `a` for the piece and land on `b`.

            const rooted = atSpaceRoot();
            moved(rooted, "/slugs/first/a/../b");
            const relative = atSpaceRoot();
            moved(relative, "slugs/first/a/../b");
            expect(rooted.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "first",
              path: ["a", "..", "b"],
            });
            expect(relative.place).toEqual(rooted.place);
          });

          it("refuses a walk whose piece ends in whitespace", () => {
            // The walk keeps the operand's edges, the operand reaching the
            // split as it was written, so the piece here answers to the piece
            // rule rather than to the reference grammar's trim.

            expect(moved(atSpaceRoot(), "/slugs/board ")).toEqual({
              kind: "refused",
              reason: "`/slugs/board ` has a piece ending in whitespace, so " +
                "no piece carries that name: a slug is lowercase letters, " +
                "numbers, and single hyphens between words, and a handle is " +
                "`of:fid1:` and unpadded base64url.",
            });
          });

          it("refuses an operand rooted only once its leading edge comes off", () => {
            // The reading a leading space would otherwise hand to the
            // reference grammar, which trims what it is given: `slugs` as a
            // piece rather than the facet, and reached without a word said.
            // The refusal is what stops that being silent.

            const place = atSpaceRoot();
            expect(moved(place, " /slugs/board")).toEqual({
              kind: "refused",
              reason: "` /slugs/board` is rooted only with its leading " +
                "whitespace taken off, and the two readings name different " +
                "cells. `/slugs/board` is the one that reaches the place it " +
                "names.",
            });
            expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
          });

          it("refuses a rooted reference behind whitespace, facet or not", () => {
            // The rule is about the rooting rather than about the facets: a
            // reference reached only by a trim has the same two readings.

            expect(moved(atSpaceRoot(), ` /${HANDLE}`).kind).toBe("refused");
          });

          it("reaches a key behind whitespace that trimming leaves relative", () => {
            // The other side of the boundary, and the one a wider rule would
            // quietly take: leading whitespace costs a name nothing unless
            // trimming would root the operand, so a relative name keeps its
            // edge and the key it names.

            const place = atReferencedPiece();
            moved(place, " foo");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: [" foo"],
            });
          });

          it("reads a facet name after a space as the piece a reference names", () => {
            // The rooted form only. A complete reference carries its own
            // space and is the canonical grammar's outright, which is what
            // leaves a piece slugged `slugs` reachable by name at all.

            const place = atSpaceRoot();
            moved(place, `/@${SPACE}/slugs/board`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "slugs",
              path: ["board"],
            });
          });

          it("reads a facet name inside a piece as an ordinary key", () => {
            const place = atReferencedPiece();
            moved(place, "slugs");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["slugs"],
            });
          });
        });

        describe("the previous place", () => {
          it("returns to the previous place for `-`", () => {
            const place = atPiece();
            moved(place, "topics");
            expect(moved(place, "-")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "space",
              },
            });
          });

          it("swaps the two places, so a second `-` goes back again", () => {
            const place = atPiece();
            moved(place, "topics");
            moved(place, "-");
            moved(place, "-");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics"],
            });
          });

          it("restores the route, so `..` backs out the way it came", () => {
            const place = atPiece();
            moved(place, "..");
            moved(place, "-");
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("refuses `-` while there is no previous place", () => {
            expect(moved(atSpaceRoot(), "-")).toEqual({
              kind: "refused",
              reason: "There is no previous place to return to.",
            });
          });
        });

        describe("scope", () => {
          it("moves the scope alone for `.@session`", () => {
            const place = atPiece();
            expect(moved(place, ".@session")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "session",
              },
            });
          });

          it("moves the scope back to the base for `.@space`", () => {
            // The trip out is asserted as well as the trip back: a place that
            // starts at the base and ends there says nothing about either
            // move unless it is seen away from it in between.

            const place = atSpaceRoot();
            expect(place.place.scope).toBe("space");
            moved(place, ".@user");
            expect(place.place.scope).toBe("user");
            moved(place, ".@space");
            expect(place.place.scope).toBe("space");
          });

          it("keeps the route, so `..` still backs out to the facet", () => {
            const place = atPiece();
            moved(place, ".@session");
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("refuses a qualifier naming no scope", () => {
            // Relayed: the shared reader's sentence.

            expect(moved(atSpaceRoot(), ".@overlay")).toEqual({
              kind: "refused",
              reason: SCOPE_REFUSAL,
            });
          });

          it("keeps the place's scope for `.@inherit`", () => {
            // Kills a head reading that takes `inherit` for a scope of its
            // own, which no place can hold.

            const place = atPiece();
            moved(place, ".@session");
            moved(place, ".@inherit");
            expect(place.place.scope).toBe("session");
          });

          it("refuses a `@pin=` qualifier on the head, a place holding no pin", () => {
            // Kills a head reading that drops the pin without a word.

            expect(moved(atPiece(), `.@pin=${PIN}`)).toEqual({
              kind: "refused",
              reason: pinRefusal(`.@pin=${PIN}`),
            });
          });

          it("moves position and scope together for `board@session`", () => {
            const place = inSlugs();
            expect(moved(place, "board@session")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "session",
              },
            });
          });

          it("refuses a piece left ending in whitespace by a scope qualifier", () => {
            // `cd board @space` is an ordinary typo. The suffix splits off
            // cleanly and what remains is a piece the rendering would not
            // name back, so the check runs on the piece the split produced
            // rather than on the segment that carried it.

            expect(moved(inSlugs(), "board @space")).toEqual({
              kind: "refused",
              reason: "`board @space` has a piece ending in whitespace, " +
                "so no piece carries that name: a slug is lowercase " +
                "letters, numbers, and single hyphens between words, and a " +
                "handle is `of:fid1:` and unpadded base64url.",
            });
          });

          it("refuses a piece holding `@`", () => {
            // Relayed: the shared reader's sentence. Every `@` on a piece
            // segment introduces a qualifier, so this one names the scope
            // twice, and no reading leaves an `@` inside the piece. A piece
            // holding one reaches a door only where no piece segment is read,
            // which `enter()` pins.

            expect(moved(inSlugs(), "board@session@session")).toEqual({
              kind: "refused",
              reason: "Duplicate qualifier `scope`.",
            });
          });

          it("keeps the place's scope for `@inherit` on a piece segment", () => {
            // Kills a piece segment reading that takes `inherit` for a scope.

            const place = atSpaceRoot();
            moved(place, ".@user");
            moved(place, "slugs/board@inherit");
            expect(place.place.scope).toBe("user");
          });

          it("refuses a `@pin=` qualifier on a piece segment", () => {
            // Kills a piece segment reading that drops the pin.

            expect(moved(inSlugs(), `board@pin=${PIN}`)).toEqual({
              kind: "refused",
              reason: pinRefusal(`board@pin=${PIN}`),
            });
          });

          it("refuses a segment that is only a qualifier", () => {
            // The hint is absent here, and that is the claim: the operand is
            // a walk into a facet rather than a scope word written bare, so
            // there is no `.@user` for it to have meant.

            expect(moved(atSpaceRoot(), "slugs/@user")).toEqual({
              kind: "refused",
              reason: "`@user` names no piece. A qualifier rides a piece id, " +
                "and a facet holds pieces rather than keys.",
            });
          });

          it("refuses a qualifier on a piece segment naming no scope", () => {
            // Relayed: the same refusal a scope-only head gets, since it is
            // the same fault read by the same reader.

            expect(moved(inSlugs(), "board@overlay")).toEqual({
              kind: "refused",
              reason: SCOPE_REFUSAL,
            });
          });
        });

        describe("references", () => {
          it("takes the space from the place for a rooted reference", () => {
            expect(moved(atPiece(), `/${HANDLE}/topics/3`)).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: ["topics", 3],
                },
                scope: "space",
              },
            });
          });

          it("moves for a complete reference naming the connected space", () => {
            expect(moved(atSpaceRoot(), `/@${SPACE}/${HANDLE}`)).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: [],
                },
                scope: "space",
              },
            });
          });

          it("keeps the scope the place was reading through", () => {
            // A reference without a suffix says nothing about scope, so the
            // ambient one fills it, the way the place fills the levels the
            // reference omits.

            const place = atSpaceRoot();
            moved(place, ".@session");
            moved(place, `/${HANDLE}/title`);
            expect(place.place.scope).toBe("session");
          });

          it("names two cells for one unqualified string read at two scopes", () => {
            // The observable the always-emit ruling rests on, and the one
            // the taxonomy turns on: a complete reference carries its space
            // and not its scope, so the reader supplies the level it does
            // not carry. Nothing else here reads a suffix-less reference —
            // every rendering the property case reads back carries a
            // suffix, because that is what `pwd` writes.

            const reference = `/@${SPACE}/${HANDLE}/title`;
            const reader = (scope: CellScope): CurrentPlace => {
              const place = atSpaceRoot();
              moved(place, `.@${scope}`);
              moved(place, reference);
              return place;
            };
            expect(reader("user").place.scope).toBe("user");
            expect(reader("session").place.scope).toBe("session");
            expect(reader("user").place).not.toEqual(reader("session").place);
          });

          it("names one cell for a fully qualified string read at two scopes", () => {
            const reference = `/@${SPACE}/${HANDLE}@user/title`;
            const reader = (scope: CellScope): CurrentPlace => {
              const place = atSpaceRoot();
              moved(place, `.@${scope}`);
              moved(place, reference);
              return place;
            };
            expect(reader("space").place).toEqual(reader("session").place);
            expect(reader("space").place.scope).toBe("user");
          });

          it("refuses a complete reference naming another space", () => {
            // Relayed: the canonical layer's sentence, not shuttle's
            // to choose. See the file header.

            expect(moved(atSpaceRoot(), `/@${OTHER_SPACE}/${HANDLE}`)).toEqual({
              kind: "refused",
              reason: `Reference names space "${OTHER_SPACE}" but the ` +
                `command targets space "${SPACE}".`,
            });
          });

          it("takes the scope from an `@scope` qualifier on the piece", () => {
            expect(moved(atSpaceRoot(), `/${HANDLE}@user/title`)).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: ["title"],
                },
                scope: "user",
              },
            });
          });

          it("keeps the place's scope for `@inherit` on a rooted or complete reference", () => {
            // Kills a rooted door that reads a reference with no scope in its
            // context, where `@inherit` falls back to the base.

            for (
              const reference of [
                `/${HANDLE}@inherit/title`,
                `//${SPACE}/${HANDLE}@inherit/title`,
              ]
            ) {
              const place = atSpaceRoot();
              moved(place, ".@session");
              moved(place, reference);
              expect(place.place).toEqual({
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: ["title"],
                },
                scope: "session",
              });
            }
          });

          it("refuses a `@pin=` qualifier on a rooted or complete reference", () => {
            // Kills a rooted door that drops the pin the reader carries.

            for (
              const reference of [
                `/${HANDLE}@pin=${PIN}/title`,
                `//${SPACE}/${HANDLE}@pin=${PIN}/title`,
              ]
            ) {
              expect(moved(atSpaceRoot(), reference)).toEqual({
                kind: "refused",
                reason: pinRefusal(reference),
              });
            }
          });

          it("refuses a reference carrying `#argument`", () => {
            expect(moved(atSpaceRoot(), `/${HANDLE}#argument`)).toEqual({
              kind: "refused",
              reason: CD_MEMBER_REFUSAL,
            });
          });

          it("refuses a reference carrying any other fragment", () => {
            // Relayed: the shared reader's sentence, not shuttle's
            // to choose. See the file header.

            const move = moved(atSpaceRoot(), `/${HANDLE}#items`);
            expect(move).toEqual({
              kind: "refused",
              reason: MEMBER_REFUSAL,
            });
          });

          it("reads `#result` on a reference's piece segment as the result, which is no switch", () => {
            // Kills a reference door that refuses the default member.

            const place = atSpaceRoot();
            moved(place, `/${HANDLE}#result`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: [],
            });
          });

          it("reaches the empty keys a reference's empty segments name", () => {
            // Kills a door that still refuses an empty segment. The reader
            // keeps a trailing empty key, so the rendering names it back.

            const place = atSpaceRoot();
            moved(place, `/${HANDLE}//`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["", ""],
            });
          });

          it("reaches the empty key a reference names mid-path", () => {
            const place = atSpaceRoot();
            moved(place, `/${HANDLE}/a//b`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a", "", "b"],
            });
          });

          it("reads a trailing slash as the empty key under the piece", () => {
            const place = atSpaceRoot();
            moved(place, `/${HANDLE}/`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: [""],
            });
          });

          it("refuses a reference whose piece holds a line break", () => {
            // A handle is held to its length rather than its alphabet, so a
            // reference can carry a piece the rendering would not name back
            // even after the canonical parse has accepted it.

            expect(moved(atSpaceRoot(), "/of:fid1:abc\ndefghijklmnop")).toEqual(
              {
                kind: "refused",
                reason: "`/of:fid1:abc\ndefghijklmnop` has a piece holding a " +
                  "line break, so a rendering of the place would name a " +
                  "different cell.",
              },
            );
          });

          it("reaches a key a reference writes ending in whitespace", () => {
            const place = atSpaceRoot();
            moved(place, `/${HANDLE}/a /b`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a ", "b"],
            });
          });

          it("moves for a reference holding a segment that starts with one", () => {
            // The reader trims the leading edge of the whole string, which no
            // leading character of a later segment sits at, so leading
            // whitespace survives the round trip and is admitted.

            const place = atSpaceRoot();
            moved(place, `/${HANDLE}/ a/b`);
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: [" a", "b"],
            });
          });

          it("refuses a rooted string that names no piece", () => {
            // Relayed: the shared reader's sentence, not shuttle's to choose.
            // `//` opens the space slot, and there is no space in it.

            expect(moved(atSpaceRoot(), "//")).toEqual({
              kind: "refused",
              reason: "Invalid space: expected a DID or a name without `/`, " +
                "`@`, `#`, or `:`.",
            });
          });

          it("refuses the retired named-space prefix", () => {
            expect(moved(atSpaceRoot(), `/@estuary/${HANDLE}/title`)).toEqual({
              kind: "refused",
              reason:
                "The named-space prefix `/@estuary/` is retired; use `//estuary/`.",
            });
          });

          it("hands back a reference naming its space by name", () => {
            // The arm carries no space. Whether the name denotes the
            // connected one is what is not yet known, so there is nothing
            // for a space field to hold that would not be a guess.

            expect(moved(atSpaceRoot(), `//estuary/${HANDLE}/title`)).toEqual({
              kind: "space-by-name",
              name: "estuary",
              operand: `//estuary/${HANDLE}/title`,
              piece: HANDLE,
              path: ["title"],
              scope: "space",
            });
          });
        });

        describe("the space root", () => {
          it("moves to the space root for `/` from a piece", () => {
            expect(moved(atPiece(), "/")).toEqual({
              kind: "moved",
              place: {
                position: { kind: "root", space: SPACE },
                scope: "space",
              },
            });
          });

          it("moves to the space root for `/` from a path in a piece", () => {
            const place = atPiece();
            moved(place, "topics/3");
            moved(place, "/");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("moves to the space root for `/` from a facet", () => {
            const place = inSlugs();
            moved(place, "/");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("leaves the scope alone for `/`", () => {
            const place = atPiece();
            moved(place, ".@session");
            moved(place, "/");
            expect(place.place.scope).toBe("session");
          });
        });

        describe("wish targets", () => {
          it("hands back a `#name` target for the connection to resolve", () => {
            expect(moved(atSpaceRoot(), "#favorites")).toEqual({
              kind: "wish",
              target: "#favorites",
            });
          });

          it("hands back `#argument` as a target rather than refusing it", () => {
            // The wish reading is decided on the whole operand, so it does
            // not ask which word follows the `#`. `#argument` earns the
            // result-rooted refusal as a member on a head or a piece segment;
            // standing alone it is a target name like any other, and the connection
            // is what discovers there is none. The case below drives the
            // same point through a spelling a reference refuses outright.

            expect(moved(atSpaceRoot(), "#argument")).toEqual({
              kind: "wish",
              target: "#argument",
            });
          });

          it("hands back a target holding a second `#`", () => {
            expect(moved(atSpaceRoot(), "#a#b")).toEqual({
              kind: "wish",
              target: "#a#b",
            });
          });
        });

        describe("relative segments", () => {
          it("moves into a facet named at the space root", () => {
            expect(moved(atSpaceRoot(), "slugs")).toEqual({
              kind: "moved",
              place: {
                position: { kind: "facet", space: SPACE, facet: "slugs" },
                scope: "space",
              },
            });
          });

          it("refuses a segment at the space root naming no facet", () => {
            expect(moved(atSpaceRoot(), "board")).toEqual({
              kind: "refused",
              reason: "A space root lists facets, and `board` names none. " +
                "The facets are `slugs/` and `pieces/`.",
            });
          });

          it("moves to a piece named inside a facet", () => {
            expect(moved(inSlugs(), "board")).toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [],
                },
                scope: "space",
              },
            });
          });

          it("refuses a piece segment that is in neither vocabulary", () => {
            // Relayed: `validatePieceSegment`'s own sentence, which the walk
            // calls rather than copies.

            expect(moved(inSlugs(), "Board")).toEqual({
              kind: "refused",
              reason: '"Board" is not a slug: a slug is lowercase letters, ' +
                "numbers, and single hyphens between words.",
            });
          });

          it("gives a piece segment the reason a reference's gets", () => {
            // Which is the whole of the ruling: a piece is held to the two
            // vocabularies whichever door reached it, so a name a listing
            // cannot print as an operand is one no door takes.

            expect(moved(inSlugs(), "Board")).toEqual(
              moved(atSpaceRoot(), "/Board"),
            );
          });

          it("reads a canonical index inside a piece as a number", () => {
            const place = atPiece();
            moved(place, "topics/3");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics", 3],
            });
          });

          it("refuses `#argument` in a segment naming a piece for the same reason as a reference", () => {
            // A place is result-rooted however the member was written, so
            // the two spellings are pinned equal rather than each pinning
            // its own text. That is what keeps a remedy naming the
            // reference form — which `cd` refuses in turn — out of this
            // one.

            expect(moved(inSlugs(), "board#argument")).toEqual(
              moved(atSpaceRoot(), `/${HANDLE}#argument`),
            );
          });

          it("refuses any other fragment for carrying no member at all", () => {
            // Relayed: the shared reader's sentence.

            expect(moved(inSlugs(), "board#items")).toEqual({
              kind: "refused",
              reason: MEMBER_REFUSAL,
            });
          });

          it("reads `#result` on a piece segment as the result, which is no switch", () => {
            // Kills a piece segment reading that refuses the default member.

            const place = inSlugs();
            moved(place, "board#result");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: [],
            });
          });

          it("gives a bare fragment the wording a reference's gets", () => {
            // One reader reads both, so the two sentences are one. Pinning
            // them equal is what fails if a door stops relaying that reader.

            expect(moved(inSlugs(), "board#items")).toEqual(
              moved(atSpaceRoot(), `/${HANDLE}#items`),
            );
          });

          it("refuses a second `#` on a piece segment rather than reading the member before it", () => {
            expect(moved(inSlugs(), "board#argument#x")).toEqual({
              kind: "refused",
              reason: MEMBER_REFUSAL,
            });
          });

          it("refuses a facet segment carrying a fragment for naming no facet", () => {
            expect(moved(atSpaceRoot(), "slugs#argument")).toEqual({
              kind: "refused",
              reason: "A space root lists facets, and `slugs#argument` " +
                "names none. The facets are `slugs/` and `pieces/`.",
            });
          });

          it("reads `#` inside a piece as part of a data key", () => {
            const place = atPiece();
            moved(place, "topics#argument");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics#argument"],
            });
          });

          it("reads `@` inside a segment as part of a data key", () => {
            const place = atPiece();
            moved(place, "mail@example");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["mail@example"],
            });
          });

          it("moves to the position itself for `.`", () => {
            // The context's own cell, and the head a qualifier hangs off. It
            // needs a reading of its own for `.@scope` to have one.

            const place = atPiece();
            moved(place, "topics");
            const before = place.place;
            expect(moved(place, ".")).toEqual({ kind: "moved", place: before });
            expect(place.place).toEqual(before);
          });

          it("reads `./items@user` as the key `items@user`", () => {
            // The head governs what follows it rather than standing as a
            // segment, so the `@` here sits on `items` and is data. This is
            // the operand the one-meaning rule is stated on.

            const place = atReferencedPiece();
            moved(place, "./items@user");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["items@user"],
            });
            expect(place.place.scope).toBe("space");
          });

          it("reads `./items` as the member, not as a walk through a key", () => {
            const place = atReferencedPiece();
            moved(place, "./items");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["items"],
            });
          });

          it("reaches a key named `.` through the head, and by what a listing offers", () => {
            // What the head costs: a key named `.` has no bare spelling, the
            // trade `..`, `-` and `/` already make here. It keeps two
            // spellings — the head, and the operand a listing prints for it,
            // which is what makes every name a listing prints one `cd` takes.

            const place = atReferencedPiece();
            moved(place, "./.");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["."],
            });

            const offered = operandForChild(atReferencedPiece().place, ".");
            expect(offered).toBeDefined();
            expect(offered).not.toBe(".");
            const elsewhere = atReferencedPiece();
            moved(elsewhere, offered as string);
            expect(elsewhere.place).toEqual(place.place);
          });

          it("reads a bare `@session` as a key, `@` being data off the head", () => {
            // The whole of what makes `@` one meaning: everywhere but on the
            // `.` head it is an ordinary character, so a key called
            // `@session` is reached by typing it.

            const place = atReferencedPiece();
            moved(place, "@session");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["@session"],
            });
            expect(place.place.scope).toBe("space");
          });

          it("offers the `.@` spelling where a bare scope word names no facet", () => {
            expect(moved(atSpaceRoot(), "@session")).toEqual({
              kind: "refused",
              reason: "A space root lists facets, and `@session` names none. " +
                "The facets are `slugs/` and `pieces/`. `.@session` is what " +
                "moves the scope.",
            });
          });

          it("offers it where a bare scope word names no piece", () => {
            expect(moved(inSlugs(), "@user")).toEqual({
              kind: "refused",
              reason: "`@user` names no piece. A qualifier rides a piece id, " +
                "and a facet holds pieces rather than keys. `.@user` is what " +
                "moves the scope.",
            });
          });

          it("offers it for no word that is not a scope", () => {
            // The hint is the scope words and nothing wider: a bare `@thing`
            // is a name that missed, and there is no `.@thing` to suggest.

            expect(moved(atSpaceRoot(), "@thing")).toEqual({
              kind: "refused",
              reason: "A space root lists facets, and `@thing` names none. " +
                "The facets are `slugs/` and `pieces/`.",
            });
          });

          it("refuses a `.@` head naming no scope, wherever it stands", () => {
            // Relayed: the shared reader's sentence.

            expect(moved(atPiece(), ".@foo")).toEqual({
              kind: "refused",
              reason: SCOPE_REFUSAL,
            });
          });

          it("reads `~1` in a segment as the separator inside one key", () => {
            // The table's row. A relative operand is a reference, so its path
            // is a pointer and `~1` is the escape for `/` inside a key; the
            // case below is the other half, where an unescaped `/` separates
            // two keys. Kills a walk that splits the operand itself rather
            // than reading the pointer, which leaves `~1` as two characters.

            const place = atReferencedPiece();
            moved(place, "a~1b");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a/b"],
            });
          });

          it("splits at every `/`, giving two keys rather than one holding it", () => {
            const place = atReferencedPiece();
            moved(place, "a/b");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a", "b"],
            });
          });

          describe("reserved readings", () => {
            // Each of these drives its character at the head of a later
            // segment, where the head-of-operand cases drive it first.
            // That position is what tells a reading decided on the whole
            // operand from one decided segment by segment, so these pin
            // which kind each reading is rather than several instances of
            // one kind.

            it("reads `-` as a data key in a later segment", () => {
              const place = atReferencedPiece();
              moved(place, "a/-");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", "-"],
              });
            });

            it("reads `@foo` as a data key in a later segment", () => {
              const place = atReferencedPiece();
              moved(place, "a/@foo");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", "@foo"],
              });
            });

            it("reads `#b` as a data key in a later segment", () => {
              const place = atReferencedPiece();
              moved(place, "a/#b");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", "#b"],
              });
            });

            it("reads `-` as a data key in the first segment", () => {
              // `-` is matched against the whole operand exactly, where `@`
              // and a leading `#` are matched against its head. So a key
              // named `-` is spellable first and those two are not.

              const place = atReferencedPiece();
              moved(place, "-/b");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["-", "b"],
              });
            });

            it("reads `-` as a data key where whitespace precedes it", () => {
              // The readings above are matched against the operand as it
              // was written, so a leading space is a character of the first
              // segment rather than something the reading looks past.
              // Whitespace reaches an edge only through a quote, which makes
              // it the character the writer meant.

              const place = atReferencedPiece();
              moved(place, " -");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [" -"],
              });
            });

            it("reads `@user` as a data key where whitespace precedes it", () => {
              const place = atReferencedPiece();
              moved(place, " @user");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [" @user"],
              });
            });

            it("reads `#favorites` as a data key where whitespace precedes it", () => {
              const place = atReferencedPiece();
              moved(place, " #favorites");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [" #favorites"],
              });
            });

            it("refuses `/` where whitespace precedes it, rather than reading it as the space root", () => {
              // The space-root reading is the operand exactly, so `" /"` is
              // not it. What the operand is instead is rooted only once its
              // edge comes off, and shuttle refuses that rather than letting
              // the reference grammar trim it into a reading of its own.

              expect(moved(atReferencedPiece(), " /")).toEqual({
                kind: "refused",
                reason: "` /` is rooted only with its leading whitespace " +
                  "taken off, and the two readings name different cells. " +
                  "`/` is the one that reaches the place it names.",
              });
            });

            it("reads `..` as a data key through a reference", () => {
              // A rooted reference has no head, so every `..` in it is a key.

              const place = atSpaceRoot();
              moved(place, `/${HANDLE}/..`);
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [".."],
              });
            });

            it("reads `..` as a data key in a later segment", () => {
              // Kills a walk that reads `..` after the head as a climb.

              const place = atReferencedPiece();
              moved(place, "a/..");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", ".."],
              });
            });

            it("reaches the key `..`, the empty key and a key ending in whitespace, each as its own spelling writes it", () => {
              // The table's row for `./..`, `./` and `"a "`. Kills a head
              // reading that climbs on `./..`, a walk that drops the empty key
              // `./` names, and a door that still refuses a key's trailing
              // edge.

              const spellings = [["./..", ".."], ["./", ""], ["a ", "a "]];
              for (const [operand, key] of spellings) {
                const place = atReferencedPiece();
                moved(place, operand);
                expect(place.place.position).toEqual({
                  kind: "piece",
                  space: SPACE,
                  piece: HANDLE,
                  path: [key],
                });
              }
            });
          });

          it("walks every level of a multi-segment operand", () => {
            const place = atSpaceRoot();
            moved(place, "slugs/board/topics/3");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics", 3],
            });
          });

          it("ignores a trailing slash", () => {
            // The table's row: above a piece there are no keys, so a final
            // separator where the walk ends at a facet names none. Kills a
            // walk that reads that empty key as a piece segment, which
            // refuses it as an empty piece.

            const place = atSpaceRoot();
            moved(place, "slugs/");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("reads a final separator after a piece as the empty key under it", () => {
            // The table's row. Kills a walk that drops a final empty key
            // wherever it sits.

            const place = atSpaceRoot();
            moved(place, "slugs/first/");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "first",
              path: [""],
            });
          });

          it("reaches a key ending in whitespace with a segment after it", () => {
            // A segment with something after it in the operand, where the
            // trailing whitespace is plainly the segment's own. One sitting
            // at the operand's own edge reads the same, under
            // `whitespace at an operand's edges` below.

            const place = atReferencedPiece();
            moved(place, "a /b");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["a ", "b"],
            });
          });

          it("gives a piece-name segment the piece's reason, not a segment's", () => {
            // The same edge in the same operand shape, one segment along from
            // `a /b` above, which reaches a key. No slug or handle ends in
            // whitespace, so a piece that does is refused for naming nothing.

            expect(moved(inSlugs(), "board /x")).toEqual({
              kind: "refused",
              reason: "`board /x` has a piece ending in whitespace, so no " +
                "piece carries that name: a slug is lowercase letters, " +
                "numbers, and single hyphens between words, and a handle " +
                "is `of:fid1:` and unpadded base64url.",
            });
          });

          it("refuses an operand whose empty part would name a piece", () => {
            // The empty part sits where a piece name goes, so it is held to
            // the piece rule and told the piece's reason. A segment is
            // faulted by what it is about to become, not by its position.

            expect(moved(atSpaceRoot(), "slugs//board")).toEqual({
              kind: "refused",
              reason: "`slugs//board` has an empty piece, so no piece " +
                "carries that name: a slug is lowercase letters, numbers, " +
                "and single hyphens between words, and a handle is " +
                "`of:fid1:` and unpadded base64url.",
            });
          });

          describe("whitespace at an operand's edges", () => {
            // The split separates tokens on whitespace (`line.ts`), so
            // whitespace reaches an operand's edge only through a quote
            // somebody wrote. Nothing strips it, which is what puts the outer
            // parts of an operand under the same rule as every part between
            // them: the operand's edges are those parts' edges, and at that
            // one position stripping the operand would strip a name.

            it("reaches a key ending in whitespace", () => {
              const place = atReferencedPiece();
              moved(place, "board ");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["board "],
              });
            });

            it("refuses a key ending in a tab, a terminal acting on it", () => {
              expect(moved(atReferencedPiece(), "board\t")).toEqual({
                kind: "refused",
                reason: "`board\t` has a segment holding a control " +
                  "character, so a terminal would act on it rather than " +
                  "print it.",
              });
            });

            it("reaches a key padded on both sides", () => {
              const place = atReferencedPiece();
              moved(place, " board ");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [" board "],
              });
            });

            it("reaches a key whose name starts with whitespace", () => {
              // Leading whitespace survives a rendering and the reader that
              // reads one back, so it costs a key no name and the walk spells
              // such a key. The trailing edge survives both as well.

              const place = atReferencedPiece();
              moved(place, " board");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [" board"],
              });
            });

            it("reaches a multi-segment operand's last key ending in whitespace", () => {
              // The one position where the operand's edge and a part's edge
              // are the same characters, which is the whole of what makes
              // this case different from `a /b` above.

              const place = atReferencedPiece();
              moved(place, "a/b ");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", "b "],
              });
            });

            it("reaches a key that is only whitespace inside a piece", () => {
              const place = atReferencedPiece();
              moved(place, " ");
              expect(place.place.position).toEqual({
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: [" "],
              });
            });

            it("refuses a piece ending in whitespace", () => {
              expect(moved(inSlugs(), "board ")).toEqual({
                kind: "refused",
                reason:
                  "`board ` has a piece ending in whitespace, so no piece " +
                  "carries that name: a slug is lowercase letters, numbers, " +
                  "and single hyphens between words, and a handle is " +
                  "`of:fid1:` and unpadded base64url.",
              });
            });

            it("refuses a piece ending in a tab", () => {
              expect(moved(inSlugs(), "board\t")).toEqual({
                kind: "refused",
                reason:
                  "`board\t` has a piece ending in whitespace, so no piece " +
                  "carries that name: a slug is lowercase letters, numbers, " +
                  "and single hyphens between words, and a handle is " +
                  "`of:fid1:` and unpadded base64url.",
              });
            });

            it("refuses a piece padded on both sides", () => {
              expect(moved(inSlugs(), " board ")).toEqual({
                kind: "refused",
                reason:
                  "` board ` has a piece ending in whitespace, so no piece " +
                  "carries that name: a slug is lowercase letters, numbers, " +
                  "and single hyphens between words, and a handle is " +
                  "`of:fid1:` and unpadded base64url.",
              });
            });

            it("refuses a piece whose name starts with whitespace for naming no slug", () => {
              // Relayed: the canonical layer's sentence, not shuttle's. A
              // leading space costs a piece no rendering, so what refuses it
              // is the vocabulary rather than the rendering rule — a
              // different reason from the one the same edge gets on a key.

              expect(moved(inSlugs(), " board")).toEqual({
                kind: "refused",
                reason: '" board" is not a slug: a slug is lowercase ' +
                  "letters, numbers, and single hyphens between words.",
              });
            });

            it("refuses an operand that is only whitespace inside a facet", () => {
              expect(moved(inSlugs(), " ")).toEqual({
                kind: "refused",
                reason: "` ` has a piece ending in whitespace, so no piece " +
                  "carries that name: a slug is lowercase letters, numbers, " +
                  "and single hyphens between words, and a handle is " +
                  "`of:fid1:` and unpadded base64url.",
              });
            });

            it("refuses a facet name ending in whitespace", () => {
              expect(moved(atSpaceRoot(), "slugs ")).toEqual({
                kind: "refused",
                reason: "A space root lists facets, and `slugs ` names none. " +
                  "The facets are `slugs/` and `pieces/`.",
              });
            });
          });
        });

        describe("a numbered handle", () => {
          // A handle is a head. What follows it is read as what follows the
          // `.` head is, and the row it names is the handle table's to say, so
          // these cases read what comes back for the table and what `reach()`
          // does with a row.

          it("hands back a handle with the literal keys after it, `..` among them", () => {
            // Kills a handle reading that climbs on `%1/..`.

            expect(moved(atPiece(), "%1/..")).toEqual({
              kind: "handle",
              handle: "%1",
              path: [".."],
              operand: "%1/..",
            });
          });

          it("tells a handle from the same handle followed by its separator", () => {
            // Kills a shape that drops the empty key `%1/` names.

            expect(moved(atPiece(), "%1")).toEqual({
              kind: "handle",
              handle: "%1",
              path: [],
              operand: "%1",
            });
            expect(moved(atPiece(), "%1/")).toEqual({
              kind: "handle",
              handle: "%1",
              path: [""],
              operand: "%1/",
            });
          });

          it("reaches the key `..` under the row's own position", () => {
            // The table's row. Kills a `reach()` that reads the path after the
            // handle as a climb.

            const place = atReferencedPiece();
            const move = place.cd("%1/..");
            if (move.kind !== "handle") throw new Error(`came ${move.kind}`);
            landed(place, place.reach(move, place.place, "title", "cd"));
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["title", ".."],
            });
          });

          it("hands back the head's member and scope for the row to be read against", () => {
            expect(moved(atPiece(), "%1#argument@session/a")).toEqual({
              kind: "handle",
              handle: "%1",
              member: "argument",
              scope: "session",
              path: ["a"],
              operand: "%1#argument@session/a",
            });
          });

          it("refuses `@pin=` on a handle's head before the row is looked up", () => {
            // Kills a handle reading that drops the pin.

            expect(moved(atPiece(), `%1@pin=${PIN}`)).toEqual({
              kind: "refused",
              reason: pinRefusal(`%1@pin=${PIN}`),
            });
          });

          it("refuses a member that is not one on a handle's head, in the reader's words", () => {
            // Relayed: the shared reader's sentence, given before the row is
            // looked up. Kills a handle reading that takes a head it cannot
            // read for a handle, and hands a malformed member to the table.

            expect(moved(atPiece(), "%1#items")).toEqual({
              kind: "refused",
              reason: MEMBER_REFUSAL,
            });
          });

          it("refuses a move whose handle selects `#argument`, a place being result-rooted", () => {
            // Kills a handle walk that carries the selection into a move.

            const place = atReferencedPiece();
            const move = place.cd("%1#argument");
            if (move.kind !== "handle") throw new Error(`came ${move.kind}`);
            expect(place.reach(move, place.place, "title", "cd")).toEqual({
              kind: "refused",
              reason: CD_MEMBER_REFUSAL,
            });
          });
        });

        describe("`..`", () => {
          it("stays at the space root", () => {
            const place = atSpaceRoot();
            expect(moved(place, "..")).toEqual({
              kind: "moved",
              place: placeAtSpaceRoot(SPACE),
            });
          });

          it("walks out one level per `..`", () => {
            const place = atPiece();
            moved(place, "..");
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("keeps the scope backing out of a piece a reference named", () => {
            const place = atSpaceRoot();
            moved(place, `/${HANDLE}@user`);
            moved(place, "..");
            expect(place.place.scope).toBe("user");
          });

          it("moves from a facet to the space root", () => {
            const place = inSlugs();
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("drops the last path segment inside a piece", () => {
            const place = atPiece();
            moved(place, "topics/3");
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: "board",
              path: ["topics"],
            });
          });

          it("moves from a piece back out to the facet it came through", () => {
            const place = atPiece();
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("climbs twice through the trail a rooted walk left, leaving the piece for its facet", () => {
            // The table's row. Kills a climb computed from the position rather
            // than the trail, which would reach the root.

            const place = atSpaceRoot();
            moved(place, "/slugs/first/a");
            moved(place, "../..");
            expect(place.place.position).toEqual({
              kind: "facet",
              space: SPACE,
              facet: "slugs",
            });
          });

          it("drops a path segment inside a piece a reference named", () => {
            const place = atSpaceRoot();
            moved(place, `/${HANDLE}/topics/3`);
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "piece",
              space: SPACE,
              piece: HANDLE,
              path: ["topics"],
            });
          });

          it("moves from a piece a reference named to the space root", () => {
            const place = atSpaceRoot();
            moved(place, `/${HANDLE}`);
            moved(place, "..");
            expect(place.place.position).toEqual({
              kind: "root",
              space: SPACE,
            });
          });

          it("keeps the scope while the position moves", () => {
            const place = atPiece();
            moved(place, ".@session");
            moved(place, "..");
            expect(place.place.scope).toBe("session");
          });
        });
      });

      describe("aim()", () => {
        // The read door. It differs from `cd()` in two ways and this block is
        // both of them: nothing moves, and the `#argument` member is read
        // rather than refused. Everything else is `cd()`'s reading, so what is
        // asked here is only that the operand arrives at it — the readings
        // themselves are `cd()`'s block above.

        /** Helper for the cases below, which is where `operand` points. */
        function pointsAt(place: CurrentPlace, operand: string): Move {
          return place.aim(operand, "get").move;
        }

        it("returns where a relative operand points", () => {
          expect(pointsAt(atPiece(), "topics/3")).toEqual({
            kind: "moved",
            place: {
              position: {
                kind: "piece",
                space: SPACE,
                piece: "board",
                path: ["topics", 3],
              },
              scope: "space",
            },
          });
        });

        it("leaves shuttle where it stood", () => {
          const place = atPiece();
          const before = place.place;
          place.aim("topics/3", "get");
          expect(place.place).toBe(before);
        });

        it("returns no selection of the arguments cell for an operand carrying no member", () => {
          expect(atPiece().aim("topics", "get").input).toBe(false);
        });

        it("returns the arguments cell selected for an operand whose head selects `#argument`", () => {
          // Kills a head reading that drops the member.

          expect(atPiece().aim(".#argument/topics", "get").input).toBe(true);
        });

        it("returns a result key for an operand ending in `#argument`, `#` being data in a path", () => {
          // Kills a door that still takes a trailing `#argument` off the
          // operand.

          const aim = atPiece().aim("topics#argument", "get");
          expect(aim.input).toBe(false);
          expect(aim.move).toMatchObject({
            kind: "moved",
            place: { position: { piece: "board", path: ["topics#argument"] } },
          });
        });

        it("reads the arguments cell's path from its root, whatever path the place stands at", () => {
          // The table's row, standing at `items`. Kills a member switch that
          // keeps the position's path, which would read `items/a`.

          const place = atPiece();
          moved(place, "items");
          expect(place.aim(".#argument/a", "get")).toEqual({
            input: true,
            move: pointsAt(atPiece(), "a"),
          });
        });

        it("reads a `#result` head as no switch, the path held", () => {
          // Kills a head reading that resets the path for the default member.

          const place = atPiece();
          moved(place, "items");
          expect(place.aim(".#result/a", "get")).toEqual({
            input: false,
            move: pointsAt(atPiece(), "items/a"),
          });
        });

        it("refuses a head that climbs and selects `#argument` in one", () => {
          // The table's row. Kills a head reading that climbs and then
          // switches, which would read the arguments cell at `a`.

          const place = atPiece();
          moved(place, "items");
          expect(place.aim("..#argument/a", "get")).toEqual({
            input: false,
            move: {
              kind: "refused",
              reason: "`..#argument/a` climbs and selects the `#argument` " +
                "member in one head. The member reads the path from the " +
                "arguments cell's root, so there is no level for a climb to " +
                "leave: `.#argument` is the head that selects it.",
            },
          });
        });

        it("refuses `#argument` on a head standing where no piece stands", () => {
          // Kills a member switch that does not ask whether a piece stands
          // there, which would hand a container a selection.

          expect(inSlugs().aim(".#argument", "get")).toEqual({
            input: false,
            move: {
              kind: "refused",
              reason: containerMemberRefusal(".#argument"),
            },
          });
        });

        it("reads the member off a piece segment, which `cd` refuses", () => {
          // The asymmetry the door exists for, on the one spelling where the
          // two doors visibly disagree: `cd` turns the member down because a
          // place is result-rooted, and a read is not standing anywhere.
          const place = inSlugs();
          expect(place.aim("board#argument", "get")).toEqual({
            input: true,
            move: pointsAt(inSlugs(), "board"),
          });
          expect(moved(inSlugs(), "board#argument").kind).toBe("refused");
        });

        it("reads the member off a rooted reference's piece segment", () => {
          expect(atSpaceRoot().aim(`/${HANDLE}#argument/title`, "get")).toEqual(
            {
              input: true,
              move: pointsAt(atSpaceRoot(), `/${HANDLE}/title`),
            },
          );
        });

        it("reads the member off a rooted walk's piece segment, wherever shuttle stands", () => {
          // The table's row. Kills a rooted walk that reads a piece segment
          // with no member.

          expect(atPiece().aim("/slugs/first#argument/label", "get")).toEqual({
            input: true,
            move: pointsAt(atSpaceRoot(), "/slugs/first/label"),
          });
        });

        it("reads a key named `label#argument` where `#argument` follows the path", () => {
          // The table's row. Kills a rooted walk that takes a trailing
          // `#argument` off the path.

          const aim = atPiece().aim("/slugs/first/label#argument", "get");
          expect(aim.input).toBe(false);
          expect(aim.move).toMatchObject({
            kind: "moved",
            place: { position: { piece: "first", path: ["label#argument"] } },
          });
        });

        it("refuses the member written as a whole operand, teaching the spellings that take it", () => {
          // What it teaches is the two spellings that take the member.

          expect(atPiece().aim("#argument", "get")).toEqual({
            input: false,
            move: {
              kind: "refused",
              reason: "`#argument` on its own names no piece to select the " +
                "arguments cell of. The member goes on a head or a piece " +
                "segment, as in `get .#argument/title` or " +
                "`get /slugs/board#argument/title`.",
            },
          });
        });

        it("hands `#argument` followed by whitespace on as a target", () => {
          // The member refusal reads the operand exactly, so a trailing space
          // leaves the head reading to decide, and the head reading is the
          // wish target.

          expect(atPiece().aim("#argument ", "get")).toEqual({
            input: false,
            move: { kind: "wish", target: "#argument " },
          });
        });

        it("hands a `#name` target on whole, the head reading being another one", () => {
          expect(atPiece().aim("#favorites", "get")).toEqual({
            input: false,
            move: { kind: "wish", target: "#favorites" },
          });
        });

        it("takes a `#` inside a piece as a character of a key", () => {
          // Only a head and a piece segment read a member, so every other `#`
          // reaches the door that decides it — here the walk, where `#` is
          // data.
          expect(atPiece().aim("a#b", "get")).toEqual({
            input: false,
            move: pointsAt(atPiece(), "a#b"),
          });
          expect(pointsAt(atPiece(), "a#b").kind).toBe("moved");
        });

        it("returns a key ending in whitespace inside a piece", () => {
          expect(atPiece().aim("topics ", "get")).toEqual({
            input: false,
            move: {
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: ["topics "],
                },
                scope: "space",
              },
            },
          });
        });

        it("returns the key a leading space names inside a piece", () => {
          expect(atPiece().aim(" topics", "get")).toEqual({
            input: false,
            move: {
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: "board",
                  path: [" topics"],
                },
                scope: "space",
              },
            },
          });
        });

        it("refuses a piece ending in whitespace inside a facet", () => {
          expect(inSlugs().aim("board ", "get")).toEqual({
            input: false,
            move: {
              kind: "refused",
              reason: "`board ` has a piece ending in whitespace, so no " +
                "piece carries that name: a slug is lowercase letters, " +
                "numbers, and single hyphens between words, and a handle is " +
                "`of:fid1:` and unpadded base64url.",
            },
          });
        });

        it("returns two answers for an empty operand and one that is only whitespace", () => {
          // The read door keeps the two apart the way the move door does: one
          // named nothing, and one named a key that is only a space.

          expect(atPiece().aim("", "get").move).toEqual({
            kind: "refused",
            reason: "`get` was given an empty operand, which names no place.",
          });
          expect(atPiece().aim(" ", "get").move).toMatchObject({
            kind: "moved",
            place: { position: { piece: "board", path: [" "] } },
          });
        });

        it("reads a member with a walk after it, where `cd` is refused for its place", () => {
          // One operand, two doors. A read takes the member and the path in
          // the arguments cell after it; a move is refused it, a place being
          // result-rooted. Both are asserted here because a door that stopped
          // telling reads from moves would pass whichever was pinned alone.

          expect(inSlugs().aim("board#argument/title", "get")).toEqual({
            input: true,
            move: pointsAt(inSlugs(), "board/title"),
          });
          expect(moved(inSlugs(), "board#argument/title")).toEqual({
            kind: "refused",
            reason: CD_MEMBER_REFUSAL,
          });
        });

        it("refuses `.#argument` for a move, a place being result-rooted", () => {
          // The table's row for `cd`; `ls` refuses in its own words
          // (`shuttle-verbs.serial.test.ts`). Kills a head reading that carries
          // the selection into a move.

          expect(moved(atPiece(), ".#argument")).toEqual({
            kind: "refused",
            reason: CD_MEMBER_REFUSAL,
          });
        });

        it("names the verb it was given in the refusal for an empty operand", () => {
          // Every verb aims an operand through this door, so the name in that
          // refusal is the caller's rather than the door's own.

          expect(atPiece().aim("", "set").move).toEqual({
            kind: "refused",
            reason: "`set` was given an empty operand, which names no place.",
          });
        });

        it("carries the reason a reference gave a member that is not one", () => {
          // Relayed: the shared reader's sentence, for a member that is not
          // one on the piece segment.

          expect(atSpaceRoot().aim(`/${HANDLE}#b/a`, "get")).toEqual({
            input: false,
            move: { kind: "refused", reason: MEMBER_REFUSAL },
          });
        });

        it("returns the key a reference's `#` names after the piece segment", () => {
          // Kills a reference door that reads `#` anywhere but the piece
          // segment.

          const aim = atSpaceRoot().aim(`/${HANDLE}/a#b`, "get");
          expect(aim.input).toBe(false);
          expect(aim.move).toMatchObject({
            kind: "moved",
            place: { position: { piece: HANDLE, path: ["a#b"] } },
          });
        });
      });

      describe("enter()", () => {
        it("moves to a target that resolved in the connected space", () => {
          const place = atSpaceRoot();
          expect(
            place.enter(
              { space: SPACE, piece: HANDLE, path: ["title"] },
              "#favorites",
            ),
          ).toEqual({
            kind: "moved",
            place: {
              position: {
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["title"],
              },
              scope: "space",
            },
          });
        });

        it("stands at the piece itself for a target carrying no path", () => {
          const place = atSpaceRoot();
          place.enter({ space: SPACE, piece: HANDLE }, "#favorites");
          expect(place.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [],
          });
        });

        it("normalizes the path the way a reference's is normalized", () => {
          // A position names its cell and nothing about how it was reached,
          // so every door has to agree on what a segment means. A canonical
          // index is where they would part: a door that skips the conversion
          // lands a string where the others land a number.

          const entered = atSpaceRoot();
          entered.enter({ space: SPACE, piece: HANDLE, path: ["3"] }, "#x");
          const referenced = atSpaceRoot();
          moved(referenced, `/${HANDLE}/3`);
          expect(entered.place).toEqual(referenced.place);
          expect(entered.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [3],
          });
        });

        it("carries no route, so `..` lands on the piece it entered", () => {
          const entered = atSpaceRoot();
          entered.enter({ space: SPACE, piece: HANDLE, path: ["3"] }, "#x");
          moved(entered, "..");
          expect(entered.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [],
          });
        });

        it("moves to a target whose path holds the empty key", () => {
          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: HANDLE, path: ["a", ""] },
              "#favorites",
            ),
          ).toEqual({
            kind: "moved",
            place: {
              position: {
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["a", ""],
              },
              scope: "space",
            },
          });
        });

        it("refuses a target whose piece is empty", () => {
          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to an empty piece, so no piece " +
              "carries that name: a slug is lowercase letters, numbers, and " +
              "single hyphens between words, and a handle is `of:fid1:` and " +
              "unpadded base64url.",
          });
        });

        it("refuses a target whose piece holds `#` though its length passes for a handle", () => {
          // `isPieceHandle` is a length rule, so a piece long enough to
          // pass for a handle carries either character of
          // `READ_INSIDE_AN_ID` past the vocabulary check — and a `#` then
          // costs the place its own rendering, which the reader would read as
          // a member on the piece segment.
          //
          // One case per character, not one per character per door. The rule
          // is a single loop inside `unnameablePiece` that every door calls,
          // and each character is driven at this door, which reads no piece
          // segment: a walk and a reference read `#` and `@` as a member and a
          // qualifier before the rule runs, so dropping either from the loop
          // would leave those doors refusing it still. That each door calls
          // the rule at all is a separate axis with cases of its own, and each
          // frames the one `Fault` it gets back in its own sentence.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "of:fid1:abcdefghij#k", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a piece holding `#`, so no " +
              "piece carries that name: a slug is lowercase letters, " +
              "numbers, and single hyphens between words, and a handle is " +
              "`of:fid1:` and unpadded base64url.",
          });
        });

        it("refuses a target whose piece holds `@` though its length passes for a handle", () => {
          // Kills `@` dropped from `READ_INSIDE_AN_ID`.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "of:fid1:abcdefghij@k", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a piece holding `@`, so no " +
              "piece carries that name: a slug is lowercase letters, " +
              "numbers, and single hyphens between words, and a handle is " +
              "`of:fid1:` and unpadded base64url.",
          });
        });

        it("refuses a target whose piece is in neither vocabulary", () => {
          // Relayed: `validatePieceSegment`'s own sentence.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "Board", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: '"Board" is not a slug: a slug is lowercase letters, ' +
              "numbers, and single hyphens between words.",
          });
        });

        it("refuses a target whose piece holds a line break", () => {
          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "a\nb", path: [] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a piece holding a line break, " +
              "so a rendering of the place would name a different cell.",
          });
        });

        it("refuses a target whose path holds a line break", () => {
          // A rendering separates its two lines with a newline, so a
          // segment holding one splits the position line and leaves a
          // shorter reference — one that names another cell rather than
          // failing to parse. A resolver reading JSON keys is the door
          // such a segment arrives through.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: HANDLE, path: ["a\nb"] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to a path with a segment holding " +
              "a line break, so a rendering of the place would name a " +
              "different cell.",
          });
        });

        it("moves to a target whose path holds a key ending in whitespace", () => {
          const place = atSpaceRoot();
          place.enter(
            { space: SPACE, piece: HANDLE, path: ["a "] },
            "#favorites",
          );
          expect(place.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: ["a "],
          });
        });

        it("keeps the scope the place was reading through", () => {
          // A resolved target names a cell and carries no scope of its own,
          // so the scope the place already holds is what it is read
          // through.

          const place = atSpaceRoot();
          moved(place, ".@session");
          place.enter({ space: SPACE, piece: HANDLE }, "#favorites");
          expect(place.place.scope).toBe("session");
        });

        it("refuses a target that resolved in another space", () => {
          const place = atSpaceRoot();
          expect(
            place.enter({ space: OTHER_SPACE, piece: HANDLE }, "#profile"),
          ).toEqual({
            kind: "refused",
            reason:
              "`#profile` resolves in space `did:key:z6MkOtherSpace`, and " +
              "this shuttle is connected to `did:key:z6MkConnectedSpace`. " +
              "One connection serves one space, so reaching that cell means " +
              "a shuttle started against that space.",
          });
        });

        it("leaves shuttle where it stood when the target is refused", () => {
          const place = atSpaceRoot();
          place.enter({ space: OTHER_SPACE, piece: HANDLE }, "#profile");
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("refuses a target naming its piece by slug", () => {
          // A place holds the handle a name resolved to, and this door is the
          // one that lands a piece without resolving anything — the fabric
          // resolved the target already. So the address it hands over has to
          // carry a handle, and a slug in that slot is refused rather than
          // adopted as a piece the index could repoint.

          expect(
            atSpaceRoot().enter(
              { space: SPACE, piece: "board", path: ["title"] },
              "#favorites",
            ),
          ).toEqual({
            kind: "refused",
            reason: "`#favorites` resolves to slug `board`, and a place " +
              "holds the handle a name resolved to. An address the fabric " +
              "wrote names its piece by handle.",
          });
        });
      });

      describe("confirm()", () => {
        // The door a read comes back through. What it lands is the handle,
        // and what it leaves beside it is the name the operand spelled — the
        // two differing exactly where a slug resolved, since a handle
        // resolves to itself.

        /** The handle the space's index points the slug `board` at. */
        const BOARD = "of:fid1:qrstuvwxyz012345";

        /**
         * Helper for the cases below, which is what a resolution answering
         * with `piece` and spending no path segment hands back: the move's own
         * path, which is what a plain slug or a handle resolves to. A
         * resolution that spends a segment is a collection slug, and has cases
         * of its own.
         */
        function resolving(move: PendingMove, piece: string): ResolvedPlace {
          return { piece, path: move.place.position.path };
        }

        /**
         * Helper for the cases below, which moves `operand` and lands it with
         * such a resolution.
         */
        function confirming(
          place: CurrentPlace,
          operand: string,
          piece: string,
        ): Move {
          const move = pending(place, operand);
          return place.confirm(move, resolving(move, piece));
        }

        /**
         * Helper for the cases below, which is the move `operand` came back
         * with, and fails the case where it came back landed instead.
         */
        function pending(place: CurrentPlace, operand: string): PendingMove {
          const move = place.cd(operand);
          if (move.kind !== "pending") {
            throw new Error(`\`${operand}\` came back ${move.kind}`);
          }
          return move;
        }

        it("lands the handle the piece resolved to, with the slug as the name", () => {
          const place = inSlugs();
          expect(confirming(place, "board", BOARD))
            .toEqual({
              kind: "moved",
              place: {
                position: {
                  kind: "piece",
                  space: SPACE,
                  piece: BOARD,
                  name: "board",
                  path: [],
                },
                scope: "space",
              },
            });
        });

        it("leaves no name where the operand named the piece by handle", () => {
          const place = atSpaceRoot();
          confirming(place, `/${HANDLE}`, HANDLE);
          expect(place.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [],
          });
        });

        it("lands the route, so `..` backs out the way the walk came", () => {
          const place = inSlugs();
          confirming(place, "board", BOARD);
          moved(place, "..");
          expect(place.place.position).toEqual({
            kind: "facet",
            space: SPACE,
            facet: "slugs",
          });
        });

        it("keeps the name through a descent inside the piece", () => {
          const place = inSlugs();
          confirming(place, "board", BOARD);
          confirming(place, "topics", BOARD);
          expect(place.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: BOARD,
            name: "board",
            path: ["topics"],
          });
        });

        it("writes the name in the prompt and the handle in the address", () => {
          // Decision 13 read as two renderings: the prompt shows a name an
          // index confirmed, and `pwd` is what to copy, so it writes the
          // handle every read goes to.

          const place = inSlugs();
          confirming(place, "board", BOARD);
          expect(place.label()).toBe("board @space");
          expect(printedPosition(place)).toBe(
            `//${SPACE}/${BOARD}@space`,
          );
        });

        it("refuses a piece in neither vocabulary, and moves nowhere", () => {
          // Relayed: `validatePieceSegment`'s own sentence. The handle came
          // from the fabric rather than from an operand, and this door holds
          // it to what every other door holds a piece to.

          const place = inSlugs();
          const facet = place.place;
          expect(confirming(place, "board", "Board"))
            .toEqual({
              kind: "refused",
              reason: '"Board" is not a slug: a slug is lowercase letters, ' +
                "numbers, and single hyphens between words.",
            });
          expect(place.place).toBe(facet);
        });

        it("refuses a piece no rendering would name back", () => {
          const place = inSlugs();
          expect(
            confirming(place, "board", `${HANDLE} `),
          ).toEqual({
            kind: "refused",
            reason: "`board` resolves to a piece ending in whitespace, so no " +
              "piece carries that name: a slug is lowercase letters, " +
              "numbers, and single hyphens between words, and a handle is " +
              "`of:fid1:` and unpadded base64url.",
          });
        });
      });

      describe("settle()", () => {
        it("builds the place from the connected space", () => {
          const place = atSpaceRoot();
          const move = moved(place, `//estuary/${HANDLE}/title`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          expect(landed(place, place.settle(move, SPACE))).toEqual({
            kind: "moved",
            place: {
              position: {
                kind: "piece",
                space: SPACE,
                piece: HANDLE,
                path: ["title"],
              },
              scope: "space",
            },
          });
        });

        it("keeps the scope a space-named reference asked for", () => {
          const place = atSpaceRoot();
          const move = moved(place, `//estuary/${HANDLE}@user`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          landed(place, place.settle(move, SPACE));
          expect(place.place.scope).toBe("user");
        });

        it("refuses a name that resolved to another space", () => {
          // The place is built from the connected space, so settling a name
          // that resolved elsewhere would land on the same piece id in the
          // wrong space and say nothing. The space the name resolved to is
          // the caller's to supply and this module's to check.

          const place = atSpaceRoot();
          const move = moved(place, `//estuary/${HANDLE}`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          expect(landed(place, place.settle(move, OTHER_SPACE))).toEqual({
            kind: "refused",
            reason: "`estuary` resolves to space `did:key:z6MkOtherSpace`, " +
              "and this shuttle is connected to " +
              "`did:key:z6MkConnectedSpace`. One connection serves one " +
              "space, so reaching that cell means a shuttle started against " +
              "that space.",
          });
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("carries a number a move already converted through unchanged", () => {
          // A move `cd` minted holds a path the reference grammar already
          // converted, so the number arm of that conversion is the one such
          // a move arrives on.

          const place = atSpaceRoot();
          landed(
            place,
            place.settle({
              kind: "space-by-name",
              name: "estuary",
              operand: `//estuary/${HANDLE}`,
              piece: HANDLE,
              path: [3],
              scope: "space",
            }, SPACE),
          );
          expect(place.place.position).toEqual({
            kind: "piece",
            space: SPACE,
            piece: HANDLE,
            path: [3],
          });
        });

        it("refuses a move whose path holds a number no digits name back", () => {
          // A number renders as its digits, and only a canonical array
          // index reads back as the number it was. This door is the one
          // documented as taking a caller's own move, so it is where such
          // a path arrives.

          const place = atSpaceRoot();
          expect(landed(
            place,
            place.settle({
              kind: "space-by-name",
              name: "estuary",
              operand: `//estuary/${HANDLE}`,
              piece: HANDLE,
              path: [1.5],
              scope: "space",
            }, SPACE),
          )).toEqual({
            kind: "refused",
            reason: "The reference naming space `estuary` has a segment " +
              "that is no canonical index, so a rendering of the place " +
              "would name a different cell.",
          });
        });

        it("refuses a move whose path holds a segment no rendering names", () => {
          // The arm is exported, so a caller can build one. `cd` cannot
          // mint a bad path any more, which leaves a hand-built move as the
          // way in — and this door builds a position from it exactly as
          // `enter` builds one from a resolved target.

          const place = atSpaceRoot();
          expect(landed(
            place,
            place.settle({
              kind: "space-by-name",
              name: "estuary",
              operand: `//estuary/${HANDLE}`,
              piece: HANDLE,
              path: ["a\nb"],
              scope: "space",
            }, SPACE),
          )).toEqual({
            kind: "refused",
            reason: `The reference naming space \`estuary\` has a segment ` +
              `holding a line break, so a rendering of the place would name ` +
              `a different cell.`,
          });
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("refuses a move whose piece is in neither vocabulary", () => {
          // Relayed: `validatePieceSegment`'s own sentence. A move `cd` minted
          // carries a piece the reference grammar already held to the two
          // vocabularies; one a caller assembled carries whatever it was
          // given, and this door holds that to them too.

          const place = atSpaceRoot();
          expect(landed(
            place,
            place.settle({
              kind: "space-by-name",
              name: "estuary",
              operand: `//estuary/${HANDLE}`,
              piece: "Board",
              path: [],
              scope: "space",
            }, SPACE),
          )).toEqual({
            kind: "refused",
            reason: '"Board" is not a slug: a slug is lowercase letters, ' +
              "numbers, and single hyphens between words.",
          });
          expect(place.place).toEqual(placeAtSpaceRoot(SPACE));
        });

        it("carries no route, so `..` leaves the piece for the root", () => {
          const place = inSlugs();
          const move = moved(place, `//estuary/${HANDLE}`);
          if (move.kind !== "space-by-name") throw new Error("not handed on");
          landed(place, place.settle(move, SPACE));
          moved(place, "..");
          expect(place.place.position).toEqual({
            kind: "root",
            space: SPACE,
          });
        });
      });

      describe("reach()", () => {
        it("hands back what the row's own operand reached, where that is nowhere", () => {
          // The walk to the row comes first and the walk written after the
          // handle second, so an operand that arrived at nothing is the answer
          // already — nothing walks on from a step that never arrived.

          const place = new CurrentPlace(SPACE);
          const move = {
            kind: "handle" as const,
            handle: "%1",
            path: ["deeper"],
            operand: "%1/deeper",
          };
          const reached = place.reach(
            move,
            place.place,
            "nowhere-at-all",
            "cd",
          );
          expect(reached.kind).toBe("refused");
          // And it moved nothing, a refusal leaving the place where it stood.
          expect(place.place).toEqual(new CurrentPlace(SPACE).place);
        });
      });

      describe("resolveHandle()", () => {
        // A handle's head is read against the row it names, so which cell it
        // selects is known here and not at `aim()`.

        /** Helper for the cases below, which is the handle `operand` reads as. */
        function handle(operand: string): HandleMove {
          const move = atSpaceRoot().cd(operand);
          if (move.kind !== "handle") throw new Error(`came ${move.kind}`);
          return move;
        }

        it("selects the row's piece's arguments cell, reading the path from its root", () => {
          // Kills a member on a handle's head that keeps the row's path, which
          // would read `items/a`.

          expect(
            atSpaceRoot().resolveHandle(
              handle("%1#argument/a"),
              atReferencedPiece().place,
              "items",
              "get",
            ),
          ).toEqual({
            input: true,
            move: atReferencedPiece().aim("a", "get").move,
          });
        });

        it("refuses `#argument` on a handle whose row is no piece position", () => {
          // Kills a member switch that hands a facet row a selection.

          expect(
            atSpaceRoot().resolveHandle(
              handle("%1#argument"),
              placeAtSpaceRoot(SPACE),
              "slugs",
              "get",
            ),
          ).toEqual({
            input: false,
            move: {
              kind: "refused",
              reason: containerMemberRefusal("%1#argument"),
            },
          });
        });

        it("selects the arguments cell of a piece row listed at a facet, the row's position deciding", () => {
          // The listing was read at a facet, and its row stands at a piece,
          // which is what the member is read against. Kills a member switch
          // that asks the listing's place rather than the row's position.

          expect(
            atSpaceRoot().resolveHandle(
              handle("%1#argument/a"),
              inSlugs().place,
              "first",
              "get",
            ),
          ).toEqual({
            input: true,
            move: atSpaceRoot().aim("slugs/first/a", "get").move,
          });
        });

        it("carries back a member a piece segment selects on the path after a facet row", () => {
          // Kills a handle walk that drops the selection it found entering a
          // piece from a facet.

          expect(
            atSpaceRoot().resolveHandle(
              handle("%1/board#argument/title"),
              placeAtSpaceRoot(SPACE),
              "slugs",
              "get",
            ),
          ).toEqual({
            input: true,
            move: atSpaceRoot().aim("slugs/board/title", "get").move,
          });
        });
      });

      describe("render()", () => {
        it("returns both halves of the place it stands at", () => {
          const place = atPiece();
          moved(place, "topics/3");
          expect(place.render()).toBe(
            "position  //did:key:z6MkConnectedSpace/board@space/topics/3\n" +
              "scope     @space",
          );
        });
      });
    });
  });
});
