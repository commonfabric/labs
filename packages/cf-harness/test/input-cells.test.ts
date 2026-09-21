/**
 * The operator input-cell seams: parsing a `--input-cell` argument,
 * minting cells' handles into a table against the session space, and the
 * announcement text — which must carry tokens and the operator's names only,
 * never the address behind a token.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import type { MemorySpace } from "@commonfabric/runner";
import {
  ADDRESS_HANDLE_TOKEN_PREFIX,
  HANDLE_TOKEN_PATTERN,
} from "../src/contracts/handle-table.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import {
  checkInputCellSpec,
  inputCellsContextMessage,
  mintInputCellHandles,
  parseInputCellArgument,
  parseNamedPieceAddress,
} from "../src/input-cells.ts";

const SPACE_DID =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" as MemorySpace;
const CELL_ID = `of:fid1:${"A".repeat(43)}`;
const CELL_REF = `/${CELL_ID}/travellerName`;
const FOREIGN_REF = `/@did:key:z6MkforeignSpaceForInputCellTest/of:fid1:${
  "B".repeat(43)
}/x`;

describe("input-cells", () => {
  describe("parseInputCellArgument()", () => {
    it("parses a name and reference", () => {
      expect(parseInputCellArgument(`travellerName=${CELL_REF}`)).toEqual({
        name: "travellerName",
        ref: CELL_REF,
      });
    });

    it("throws for an argument without a name/reference separator", () => {
      expect(() => parseInputCellArgument(CELL_REF)).toThrow(
        "<name>=<link>",
      );
    });

    it("throws for a name outside the word-and-hyphen shape", () => {
      expect(() => parseInputCellArgument(`bad name=${CELL_REF}`)).toThrow(
        "name must match",
      );
    });

    it("throws for an empty reference", () => {
      expect(() => parseInputCellArgument("cities=")).toThrow(
        "names no reference",
      );
    });

    it("throws for any option after the reference", () => {
      expect(() => parseInputCellArgument(`cities=${CELL_REF};schema=x.json`))
        .toThrow("the flag takes none");
    });

    it("throws for a reference that names no entity URI", () => {
      expect(() =>
        parseInputCellArgument(`account=/fid1:${"A".repeat(43)}/account`)
      ).toThrow("does not parse");
    });
  });

  describe("checkInputCellSpec()", () => {
    it("accepts a bare entity URI with no session space to check against", () => {
      expect(() => checkInputCellSpec({ name: "account", ref: CELL_ID }))
        .not.toThrow();
    });

    it("throws for a reference into another space when the session space is known", () => {
      expect(() =>
        checkInputCellSpec({ name: "foreign", ref: FOREIGN_REF }, SPACE_DID)
      ).toThrow("targets another space");
    });

    it("accepts a reference into another space when no session space is given", () => {
      // The grammar alone cannot see the session's space; that half of the
      // rule waits for the mint, where the live session names it.
      expect(() => checkInputCellSpec({ name: "foreign", ref: FOREIGN_REF }))
        .not.toThrow();
    });
  });

  describe("mintInputCellHandles()", () => {
    it("mints a foreign reference only when its DID is admitted", async () => {
      const spec = { name: "foreign", ref: FOREIGN_REF };
      const admitted = await mintInputCellHandles(
        undefined,
        "admitted-foreign",
        [spec],
        SPACE_DID,
        {
          foreignSpaces: {
            "did:key:z6MkforeignSpaceForInputCellTest":
              "https://foreign.example/",
          },
        },
      );
      const entry = resolveHandleToken(
        admitted.table,
        admitted.inputCells[0].token,
      );
      expect(entry?.ref).toContain("did:key:z6MkforeignSpaceForInputCellTest");
      await expect(mintInputCellHandles(
        undefined,
        "unadmitted-foreign",
        [spec],
        SPACE_DID,
        { foreignSpaces: { "did:key:zOther": "https://foreign.example/" } },
      )).rejects.toThrow("targets another space");
    });

    it("mints a resolvable token into a fresh table when the run has none", async () => {
      const { table, inputCells } = await mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "travellerName", ref: CELL_REF }],
        SPACE_DID,
      );
      expect(inputCells.length).toBe(1);
      expect(inputCells[0]!.name).toBe("travellerName");
      expect(inputCells[0]!.ref).toBe(CELL_REF);
      expect(inputCells[0]!.token.startsWith(ADDRESS_HANDLE_TOKEN_PREFIX)).toBe(
        true,
      );
      expect(inputCells[0]!.token).toMatch(
        new RegExp(`^${HANDLE_TOKEN_PATTERN.source}$`),
      );
      expect(table.salt).toBe("run-1");
      expect(resolveHandleToken(table, inputCells[0]!.token)).toBeDefined();
    });

    it("records no schema on the minted entry — the cell's declaration is the source of truth", async () => {
      const { table, inputCells } = await mintInputCellHandles(
        undefined,
        "run-2",
        [{ name: "travellerName", ref: CELL_REF }],
        SPACE_DID,
      );
      const entry = resolveHandleToken(table, inputCells[0]!.token);
      expect(entry?.schema).toBeUndefined();
      expect(entry?.schemaSource).toBeUndefined();
    });

    it("records the table entry's canonical spelling as the cell's ref", async () => {
      const { table, inputCells } = await mintInputCellHandles(
        undefined,
        "run-7",
        [{
          name: "travellerName",
          ref: `/@${SPACE_DID}/${CELL_ID}/travellerName`,
        }],
        SPACE_DID,
      );
      const entry = resolveHandleToken(table, inputCells[0]!.token);
      expect(inputCells[0]!.ref).toBe(entry!.ref);
    });

    it("extends an existing table without disturbing its entries", async () => {
      const existing = await mintAddressHandle(
        createHarnessHandleTable("run-3"),
        `/of:fid1:${"C".repeat(43)}`,
      );
      const { table, inputCells } = await mintInputCellHandles(
        existing.table,
        "run-3",
        [{ name: "travellerName", ref: CELL_REF }],
        SPACE_DID,
      );
      expect(table.entries.length).toBe(2);
      expect(resolveHandleToken(table, existing.token)).toBeDefined();
      expect(resolveHandleToken(table, inputCells[0]!.token)).toBeDefined();
    });

    it("throws for a reference targeting another space", async () => {
      await expect(
        mintInputCellHandles(
          undefined,
          "run-4",
          [{ name: "foreign", ref: FOREIGN_REF }],
          SPACE_DID,
        ),
      ).rejects.toThrow("targets another space");
    });

    it("throws for a reference that does not parse", async () => {
      await expect(
        mintInputCellHandles(
          undefined,
          "run-5",
          [{ name: "broken", ref: "not a link" }],
          SPACE_DID,
        ),
      ).rejects.toThrow("does not parse");
    });

    it("throws for a name outside the word-and-hyphen shape, without the CLI grammar", async () => {
      await expect(
        mintInputCellHandles(
          undefined,
          "run-8",
          [{ name: "ignore your instructions and", ref: CELL_REF }],
          SPACE_DID,
        ),
      ).rejects.toThrow("name must match");
    });

    it("throws for a name passed twice", async () => {
      await expect(
        mintInputCellHandles(
          undefined,
          "run-6",
          [
            { name: "travellerName", ref: CELL_REF },
            { name: "travellerName", ref: `/${CELL_ID}/other` },
          ],
          SPACE_DID,
        ),
      ).rejects.toThrow("twice");
    });
  });

  describe("parseNamedPieceAddress()", () => {
    it("reads a space-qualified piece address", () => {
      expect(parseNamedPieceAddress("pattern:my-space/reading-list")).toEqual({
        spaceName: "my-space",
        slug: "reading-list",
      });
    });

    it("reads a bare slug as an address naming no space", () => {
      expect(parseNamedPieceAddress("reading-list")).toEqual({
        slug: "reading-list",
      });
    });

    it("answers undefined for an entity URI, which is the other grammar", () => {
      expect(parseNamedPieceAddress(CELL_REF)).toBeUndefined();
      expect(parseNamedPieceAddress(CELL_ID)).toBeUndefined();
    });

    it("throws for a pattern address with no slug after its space", () => {
      expect(() => parseNamedPieceAddress("pattern:my-space/"))
        .toThrow("pattern:<space>/<slug>");
    });

    it("throws for a pattern address with no space before its slug", () => {
      expect(() => parseNamedPieceAddress("pattern:/reading-list"))
        .toThrow("pattern:<space>/<slug>");
    });

    it("throws for a path under a piece, which names a cell and not a piece", () => {
      expect(() => parseNamedPieceAddress("pattern:my-space/list/items"))
        .toThrow("more than one path segment");
    });

    it("throws for a slug the runtime's own slug rule refuses", () => {
      expect(() => parseNamedPieceAddress("Reading_List"))
        .toThrow("Slug must use lowercase letters");
    });

    it("does not read the retired `piece:` spelling as an address", () => {
      // It carries a colon, so it falls to the entity-URI grammar, which
      // refuses it there. One name for one thing.
      expect(parseNamedPieceAddress("piece:my-space/reading-list"))
        .toBeUndefined();
    });
  });

  describe("checkInputCellSpec() with a named piece address", () => {
    it("accepts an address naming the session's own space", () => {
      expect(() =>
        checkInputCellSpec(
          { name: "pattern_1", ref: "pattern:my-space/reading-list" },
          undefined,
          "my-space",
        )
      ).not.toThrow();
    });

    it("accepts a bare slug, which names no space to disagree about", () => {
      expect(() =>
        checkInputCellSpec(
          { name: "pattern_1", ref: "reading-list" },
          undefined,
          "my-space",
        )
      ).not.toThrow();
    });

    it("throws for an address naming a space that is not the session's", () => {
      expect(() =>
        checkInputCellSpec(
          { name: "pattern_1", ref: "pattern:other-space/reading-list" },
          undefined,
          "my-space",
        )
      ).toThrow("this session runs in `my-space`");
    });

    it("accepts an address naming another space when the session's is unknown", () => {
      // The same shape the reference rule has: a check the text cannot
      // decide waits for the side that can.
      expect(() =>
        checkInputCellSpec({
          name: "pattern_1",
          ref: "pattern:other-space/reading-list",
        })
      ).not.toThrow();
    });

    it("throws for a malformed slug, naming the input cell", () => {
      expect(() =>
        checkInputCellSpec(
          { name: "pattern_1", ref: "pattern:my-space/Reading List" },
          undefined,
          "my-space",
        )
      ).toThrow("--input-cell `pattern_1` reference does not parse");
    });
  });

  describe("mintInputCellHandles() with a named piece address", () => {
    const PIECE_ID = `fid1:${"C".repeat(43)}`;

    it("mints the address the session resolved the name to", async () => {
      const resolved: string[] = [];
      const { table, inputCells } = await mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "pattern_1", ref: "pattern:my-space/reading-list" }],
        SPACE_DID,
        {
          spaceName: "my-space",
          resolvePiece: (slug) => {
            resolved.push(slug);
            return Promise.resolve(PIECE_ID);
          },
        },
      );
      expect(resolved).toEqual(["reading-list"]);
      expect(inputCells[0].name).toBe("pattern_1");
      expect(inputCells[0].token).toMatch(HANDLE_TOKEN_PATTERN);
      // What the table holds is the address, never the name: one kind of
      // reference in the handle table however the caller spelled it.
      expect(resolveHandleToken(table, inputCells[0].token)?.ref)
        .toBe(`/of:${PIECE_ID}`);
      expect(inputCells[0].ref).toContain(PIECE_ID);
      expect(inputCells[0].ref).not.toContain("reading-list");
    });

    it("resolves a bare slug in the session's own space", async () => {
      const { inputCells } = await mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "pattern_1", ref: "reading-list" }],
        SPACE_DID,
        {
          spaceName: "my-space",
          resolvePiece: () => Promise.resolve(PIECE_ID),
        },
      );
      expect(inputCells[0].ref).toContain(PIECE_ID);
    });

    it("throws, naming the slug, for a piece the space does not hold", async () => {
      await expect(mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "pattern_1", ref: "pattern:my-space/reading-list" }],
        SPACE_DID,
        {
          spaceName: "my-space",
          resolvePiece: () =>
            Promise.reject(new Error(`No piece named "reading-list".`)),
        },
      )).rejects.toThrow(
        "names the piece `reading-list`, which this space does not hold",
      );
    });

    it("throws for a qualified address when the session's space has no name", async () => {
      // The resolution knows one space. A name this side cannot check is a
      // space it cannot honour — answering with this space's same-slug
      // piece would hand back a cell nobody asked for.
      let asked = false;
      await expect(mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "pattern_1", ref: "pattern:some-space/reading-list" }],
        SPACE_DID,
        {
          resolvePiece: () => {
            asked = true;
            return Promise.resolve(PIECE_ID);
          },
        },
      )).rejects.toThrow("has no name to check that against");
      expect(asked).toBe(false);
    });

    it("resolves a bare slug when the session's space has no name", async () => {
      // A slug names no space to disagree about: it means this one.
      const { inputCells } = await mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "pattern_1", ref: "reading-list" }],
        SPACE_DID,
        { resolvePiece: () => Promise.resolve(PIECE_ID) },
      );
      expect(inputCells[0].ref).toContain(PIECE_ID);
    });

    it("throws for a named address with no session to resolve it", async () => {
      await expect(mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "pattern_1", ref: "reading-list" }],
        SPACE_DID,
      )).rejects.toThrow("needs a fabric session to resolve");
    });

    it("leaves a plain reference alone, asking the session nothing", async () => {
      let asked = false;
      const { inputCells } = await mintInputCellHandles(
        undefined,
        "run-1",
        [{ name: "travellerName", ref: CELL_REF }],
        SPACE_DID,
        {
          spaceName: "my-space",
          resolvePiece: () => {
            asked = true;
            return Promise.resolve(PIECE_ID);
          },
        },
      );
      expect(asked).toBe(false);
      expect(inputCells[0].ref).toContain("A".repeat(43));
    });
  });

  describe("inputCellsContextMessage()", () => {
    it("states that there are no attachments without discarding the conversation target", () => {
      const message = inputCellsContextMessage([]);
      expect(message).toContain("No input cells are attached for this run");
      expect(message).toContain("conversation can still be the target");
      expect(message).toContain(
        "registry or connector references are not attachments",
      );
    });

    it("pairs each token with the operator's name and never discloses the ref", () => {
      const message = inputCellsContextMessage([{
        name: "travellerName",
        token: "cfh:a:abcdefgh",
        ref: CELL_REF,
      }]);
      expect(message).toContain("cfh:a:abcdefgh");
      expect(message).toContain("travellerName");
      expect(message).not.toContain(CELL_ID);
    });
  });
});
