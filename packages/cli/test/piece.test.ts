import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { BaseFabricSpecialObject } from "@commonfabric/data-model/fabric-bases";
import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { pieceId, SlugResolutionError } from "@commonfabric/piece";
import {
  type Cell,
  getCellOrThrow,
  isCell,
  isCellResult,
  type JSONSchema,
  Runtime,
} from "@commonfabric/runner";
import {
  EmulatedStorageManager,
  newLoopbackServer,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";

import { toCell } from "../../runner/src/back-to-cell.ts";
import { setResultCell } from "../../runner/src/result-utils.ts";
import {
  applyPieceSourceCommandAction,
  checkPieceSourceFromCommand,
  formatPatternIdentity,
  formatPatternRef,
  getCellValueFromCommand,
  localPatternEntry,
  mergePiecePath,
  parseLink,
  parsePieceOptions,
  parseSpaceOptions,
  piece,
  type PieceCellCommandDependencies,
  pieceDataCommand,
  readCallTarget,
  readTargetPositionals,
  setCellValueFromCommand,
  setPieceSourceFromCommand,
  setsrcSuccessLine,
} from "../commands/piece.ts";
import { normalizeApiUrl } from "../lib/api-url.ts";
import { space } from "../commands/space.ts";
import {
  CellSelectionError,
  parseCellSelectionOptions,
  parseSelectionFilter,
  parseSelectionProjection,
} from "../lib/cell-selection.ts";
import {
  checkPiecePattern,
  getCellValue,
  inspectPiece,
  listPieces,
  newPiece,
  type PieceConfig,
  PieceResultProjectionError,
  PieceVerbReadError,
  recreateSpaceRootPattern,
  resolveLinkEndpointAddress,
  resolvePieceConfig,
  searchPieces,
  setHomePattern,
  setPiecePattern,
  type SpaceConfig,
  withRuntimeCleanupOnFailure,
} from "../lib/piece.ts";
import { safeStringify } from "../lib/render.ts";
import { cf, checkStderr, stripAnsi } from "./utils.ts";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { isObjectOrArray } from "@commonfabric/utils/types";

const API_URL = "https://cf.dev";
const SPACE = "common-knowledge";
const PIECE = "abcdefghijklmnopqrstuvwxyz";
const ID = "~/.my.key";
// The 43-character id length matches the entity ids the runtime mints, and
// clears the runner parser's handle-length threshold.
const LLM_HANDLE = `of:fid1:${"baedreiabcdefghijklmnopqrstuvwxyz0123456789"}`;
const SPACE_DID =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" as const;
const OTHER_SPACE_DID =
  "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";
const FULL_URL = `${API_URL}/${SPACE}/${PIECE}`;
const NO_PIECE_FULL_URL = `${API_URL}/${SPACE}`;
// A key the commands below can open a session with; they never reach a
// server, so which identity it names does not matter.
const TEST_PKCS8_KEY = `-----BEGIN PRIVATE KEY-----
MMC4CAQAwBQYDK2VwBCIEICWSvx4QOW+mogjWSsjInQaPpmjErsDBqf2ZOoK+Y4IO
-----END PRIVATE KEY-----`;

describe("cli piece parsing", () => {
  it("formats structured pattern references for human output", () => {
    const identity = "A".repeat(43);
    const patternRef = {
      identity,
      symbol: "default",
      source: {
        ref: `cf:pattern:${identity}`,
        entry: "/notes/note.tsx",
      },
    };
    expect(formatPatternRef(patternRef)).toBe("/notes/note.tsx");
    expect(formatPatternIdentity(patternRef)).toBe(
      `cf:module/${identity}#default`,
    );
    expect(formatPatternRef({
      identity,
      symbol: "named",
      source: { ref: `cf:pattern:${identity}` },
    })).toBe(`cf:pattern:${identity}`);
    expect(formatPatternRef({
      identity,
      symbol: "named",
      source: {
        ref: `cf:pattern:${identity}`,
        repository: "https://github.com/commonfabric/labs",
        entry: "/packages/patterns/notes/note.tsx",
      },
    })).toBe(
      "https://github.com/commonfabric/labs#/packages/patterns/notes/note.tsx",
    );
    expect(formatPatternRef({
      identity,
      symbol: "named",
      source: {
        ref: `cf:pattern:${identity}`,
        origin: "cf:/did:key:z6Mk/example",
      },
    })).toBe("cf:/did:key:z6Mk/example");
    expect(formatPatternRef(undefined)).toBe("<unknown>");
  });

  it("normalizes API URLs for app route hints", () => {
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/",
    )).toBe("https://rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/base/",
    )).toBe("https://rapids.saga-castor.ts.net/base");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/base",
    )).toBe("https://rapids.saga-castor.ts.net/base");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net/?debug=true#top",
    )).toBe("https://rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net//base",
    )).toBe("https://rapids.saga-castor.ts.net/base");
    expect(normalizeApiUrl(
      "https://rapids.saga-castor.ts.net//",
    )).toBe("https://rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://user:pass@rapids.saga-castor.ts.net/",
    )).toBe("https://user:pass@rapids.saga-castor.ts.net");
    expect(normalizeApiUrl(
      "https://user:pass@rapids.saga-castor.ts.net/base/",
    )).toBe("https://user:pass@rapids.saga-castor.ts.net/base");
  });

  it("force-closes loadPieces storage before disposing failed runtime", async () => {
    let disposeCalls = 0;
    let closeNowCalls = 0;
    const cleanupOrder: string[] = [];
    const originalError = new Error("sync failed");

    await expect(withRuntimeCleanupOnFailure({
      dispose: () => {
        disposeCalls++;
        cleanupOrder.push("dispose");
        return Promise.resolve();
      },
      storageManager: {
        closeNow: () => {
          closeNowCalls++;
          cleanupOrder.push("closeNow");
          return Promise.resolve();
        },
      },
    }, () => Promise.reject(originalError))).rejects.toBe(originalError);

    expect(closeNowCalls).toBe(1);
    expect(disposeCalls).toBe(1);
    expect(cleanupOrder).toEqual(["closeNow", "dispose"]);
  });

  it("still disposes failed runtime when force-close cleanup fails", async () => {
    let disposeCalls = 0;
    const originalError = new Error("sync failed");

    await expect(withRuntimeCleanupOnFailure({
      dispose: () => {
        disposeCalls++;
        return Promise.resolve();
      },
      storageManager: {
        closeNow: () => Promise.reject(new Error("closeNow failed")),
      },
    }, () => Promise.reject(originalError))).rejects.toBe(originalError);

    expect(disposeCalls).toBe(1);
  });

  it("reports both cleanup failures through the sink a caller supplied", async () => {
    // The two warnings a failed connect's own cleanup writes. A caller
    // drawing its own screen — the shell holding a prompt in raw mode — takes
    // them here instead of finding them written behind its frame; a caller
    // that names no sink still gets them on the process's own stream.

    const reported: string[] = [];
    const originalError = new Error("sync failed");

    await expect(withRuntimeCleanupOnFailure(
      {
        dispose: () => Promise.reject(new Error("dispose failed")),
        storageManager: {
          closeNow: () => Promise.reject(new Error("closeNow failed")),
        },
      },
      () => Promise.reject(originalError),
      (message) => {
        reported.push(message);
      },
    )).rejects.toBe(originalError);

    expect(reported).toEqual([
      "loadPieces storage cleanup failed: closeNow failed",
      "loadPieces cleanup failed: dispose failed",
    ]);
  });

  it("does not dispose loadPieces runtime after successful initialization", async () => {
    let disposeCalls = 0;

    const result = await withRuntimeCleanupOnFailure({
      dispose: () => {
        disposeCalls++;
        return Promise.resolve();
      },
    }, () => Promise.resolve("ready"));

    expect(result).toBe("ready");
    expect(disposeCalls).toBe(0);
  });

  it("parseSpaceOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    };
    expect(parseSpaceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    })).toMatchObject(expected);
    const trailingApiUrl = parseSpaceOptions({
      apiUrl: `${API_URL}/`,
      space: SPACE,
      identity: ID,
    });
    expect(trailingApiUrl).toMatchObject(expected);
    expect(`${trailingApiUrl.apiUrl}/${trailingApiUrl.space}/${PIECE}`).toBe(
      FULL_URL,
    );
    expect(parseSpaceOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
    expect(parseSpaceOptions({
      url: NO_PIECE_FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
  });
  it("parseSpaceOptions() refuses malformed URLs and missing spaces", () => {
    expect(() => parseSpaceOptions({ url: "not a URL", identity: ID }))
      .toThrow(/not a URL/);
    expect(() => parseSpaceOptions({ url: API_URL, identity: ID }))
      .toThrow(/does not contain a space/);
    expect(() =>
      parseSpaceOptions({ url: `${API_URL}/foo%2Fbar/${PIECE}`, identity: ID })
    )
      .toThrow(/Invalid space/);
    for (
      const url of [
        `${API_URL}/${SPACE}/${PIECE}%23argument`,
        `${API_URL}/space%23argument/${PIECE}`,
      ]
    ) {
      expect(() => parseSpaceOptions({ url, identity: ID }))
        .toThrow(/selects a piece member/);
    }
  });

  it("parseSpaceOptions() throws on incomplete input", () => {
    expect(() =>
      parseSpaceOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        space: SPACE,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
        identity: ID,
      })
    ).toThrow(/--space/);
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parseSpaceOptions({
        identity: ID,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        space: SPACE,
      })
    ).toThrow();
    expect(() =>
      parseSpaceOptions({
        apiUrl: API_URL,
      })
    ).toThrow();
  });

  it("parsePieceOptions() handles individual components and full url", () => {
    const expected = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
    };
    expect(parsePieceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      cell: PIECE,
    })).toMatchObject(expected);
    expect(parsePieceOptions({
      url: FULL_URL,
      identity: ID,
    })).toMatchObject(expected);
    expect(
      parsePieceOptions({
        apiUrl: API_URL,
        space: SPACE,
        identity: ID,
        cell: PIECE,
        json: true,
      }).jsonOutput,
    ).toBe(true);
  });

  it("parsePieceOptions() parses scope suffixes from piece ids and urls", () => {
    expect(parsePieceOptions({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      cell: `${PIECE}@user`,
    })).toMatchObject({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
      pieceScope: "user",
    });
    expect(parsePieceOptions({
      url: `${API_URL}/${SPACE}/${PIECE}@session`,
      identity: ID,
    })).toMatchObject({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
      pieceScope: "session",
    });
  });
  it("parsePieceOptions() resolves an LLM-friendly --piece like the bare handle", () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID };
    expect(parsePieceOptions({ ...base, cell: `/${LLM_HANDLE}` })).toEqual(
      parsePieceOptions({ ...base, cell: LLM_HANDLE }),
    );
    expect(
      parsePieceOptions({ ...base, cell: `/${LLM_HANDLE}@session` }),
    ).toMatchObject({
      piece: LLM_HANDLE,
      pieceScope: "session",
    });
  });

  it("parsePieceOptions() carries an embedded path only where the command accepts one", () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID };
    const config = parsePieceOptions(
      { ...base, cell: `/${LLM_HANDLE}/items/0` },
      { acceptsPath: true },
    );
    expect(config).toMatchObject({
      piece: LLM_HANDLE,
      piecePath: ["items", 0],
    });
    expect(mergePiecePath(config, "title")).toEqual(["items", 0, "title"]);
    expect(mergePiecePath(config)).toEqual(["items", 0]);
    expect(() => mergePiecePath(config, "/other/title")).toThrow(
      /piece-relative/,
    );
    expect(() => mergePiecePath(config, "//other-space/other/title")).toThrow(
      /piece-relative/,
    );
    expect(() => mergePiecePath(config, "../../.."))
      .toThrow(/above the piece/);
    expect(() => mergePiecePath(config, ".@unknown"))
      .toThrow(/Invalid scope suffix/);
    expect(() => parsePieceOptions({ ...base, cell: `/${LLM_HANDLE}/items` }))
      .toThrow(/takes a piece id only/);
  });

  it("parsePieceOptions() checks an embedded space DID against the target space", () => {
    const base = { apiUrl: API_URL, identity: ID };
    expect(parsePieceOptions({
      ...base,
      space: SPACE_DID,
      cell: `/@${SPACE_DID}/${LLM_HANDLE}`,
    })).toMatchObject({
      space: SPACE_DID,
      piece: LLM_HANDLE,
    });
    expect(() =>
      parsePieceOptions({
        ...base,
        space: OTHER_SPACE_DID,
        cell: `/@${SPACE_DID}/${LLM_HANDLE}`,
      })
    ).toThrow(
      `Reference names space "${SPACE_DID}" but the command targets ` +
        `space "${OTHER_SPACE_DID}".`,
    );
    // A named space resolves to a DID only once the session opens, so the
    // embedded DID is carried for loadPieces' deferred check rather than
    // compared against the raw name here.
    expect(parsePieceOptions({
      ...base,
      space: SPACE,
      cell: `/@${SPACE_DID}/${LLM_HANDLE}`,
    })).toMatchObject({
      space: SPACE,
      piece: LLM_HANDLE,
      embeddedSpaces: [SPACE_DID],
    });
  });

  it("parseSpaceOptions() takes the space a canonical reference carries when --space is absent", () => {
    const base = { apiUrl: API_URL, identity: ID };
    expect(parseSpaceOptions({
      ...base,
      cell: `/@${SPACE_DID}/${LLM_HANDLE}`,
    })).toMatchObject({
      space: SPACE_DID,
      piece: LLM_HANDLE,
      embeddedSpaces: [SPACE_DID],
    });
    // The scope suffix and embedded path ride the same space-carrying token.
    expect(parsePieceOptions(
      { ...base, cell: `/@${SPACE_DID}/${LLM_HANDLE}@user/items/0` },
      { acceptsPath: true },
    )).toMatchObject({
      space: SPACE_DID,
      piece: LLM_HANDLE,
      pieceScope: "user",
      piecePath: ["items", 0],
    });
    // A reference that names no space supplies none: the requirement stands.
    expect(() => parseSpaceOptions({ ...base, cell: `/${LLM_HANDLE}` }))
      .toThrow(/--space/);
    expect(() => parseSpaceOptions({ ...base, cell: PIECE }))
      .toThrow(/--space/);
  });

  it('parsePieceOptions() honors "#argument" only where a command takes --input', () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID };
    expect(parsePieceOptions(
      { ...base, cell: `/${LLM_HANDLE}#argument` },
      { acceptsArgument: true },
    )).toMatchObject({
      piece: LLM_HANDLE,
      pieceInput: true,
    });
    expect(() =>
      parsePieceOptions({ ...base, cell: `/${LLM_HANDLE}#argument` })
    )
      .toThrow(/does not take "--input"/);
    // The command's own declaration is what decides, so the bare spelling of
    // the same selection reaches the same refusal — and the refusal names the
    // target rather than a reference, which is not what a slug is.
    expect(() => parsePieceOptions({ ...base, cell: `${PIECE}#argument` }))
      .toThrow(/does not take "--input"/);
    expect(() => parsePieceOptions({ ...base, cell: "thermostat#argument" }))
      .toThrow(
        'The target selects the arguments cell ("#argument") but this ' +
          'command does not take "--input".',
      );
  });

  it('parseSpaceOptions() reads "#argument" off a bare id and off a slug', () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID };
    expect(parseSpaceOptions({ ...base, cell: `${PIECE}#argument` }))
      .toMatchObject({ piece: PIECE, pieceInput: true });
    expect(parseSpaceOptions({ ...base, cell: "thermostat#argument" }))
      .toMatchObject({ piece: "thermostat", pieceInput: true });
    // The suffix comes off before the scope is read, so the two compose in
    // the order the reference form writes them.
    expect(parseSpaceOptions({ ...base, cell: "thermostat#argument@session" }))
      .toMatchObject({
        piece: "thermostat",
        pieceScope: "session",
        pieceInput: true,
      });
    // A target with no suffix names no cell but the result cell.
    expect(
      parsePieceOptions({ ...base, cell: "thermostat" }, {
        acceptsArgument: true,
      }).pieceInput,
    ).toBeUndefined();
  });

  it("parseSpaceOptions() reports an unknown fragment on a bare target as one", () => {
    // Left on the id the fragment is a piece nothing resolves, and the
    // refusal that follows names the piece rather than the "#" that caused
    // it. One sentence covers both spellings, since one reader splits both.

    const base = { apiUrl: API_URL, space: SPACE, identity: ID };
    expect(parseSpaceOptions({ ...base, cell: "thermostat#result" }))
      .toEqual(parseSpaceOptions({ ...base, cell: "thermostat" }));
    expect(parseSpaceOptions({ ...base, cell: `/${LLM_HANDLE}#result` }))
      .toEqual(parseSpaceOptions({ ...base, cell: `/${LLM_HANDLE}` }));
  });

  it("readTargetPositionals() reads a leading canonical reference as the address", () => {
    expect(readTargetPositionals({}, undefined, undefined)).toEqual({});
    expect(readTargetPositionals({}, "items/0", undefined)).toEqual({
      pathString: "items/0",
    });
    expect(readTargetPositionals({}, `/${LLM_HANDLE}`, "items/0")).toEqual({
      address: `/${LLM_HANDLE}`,
      pathString: "items/0",
    });
    // Naming the target twice is refused, like --space beside --url.
    expect(() => readTargetPositionals({ cell: PIECE }, `/${LLM_HANDLE}`))
      .toThrow(/"--cell" \(or "--piece"\) cannot be provided/);
    // Only an address earns a second positional.
    expect(() => readTargetPositionals({}, "items/0", "title"))
      .toThrow(/Unexpected argument "title"/);
  });

  it("readCallTarget() lets a canonical reference precede the callable name", () => {
    expect(readCallTarget({}, "addItem", ["{}"])).toEqual({
      callableName: "addItem",
      tail: ["{}"],
    });
    expect(readCallTarget({}, `/${LLM_HANDLE}`, ["addItem", "{}"])).toEqual({
      cell: `/${LLM_HANDLE}`,
      callableName: "addItem",
      tail: ["{}"],
    });
    // The flag does not collide here, it disambiguates: a callable name may
    // begin with "/", so a written flag makes the positional the callable.
    // `readTargetPositionals` refuses the same pair, because there the other
    // reading is a path and a path is never rooted.
    expect(readCallTarget({ cell: PIECE }, `/${LLM_HANDLE}`, ["addItem"]))
      .toEqual({ callableName: `/${LLM_HANDLE}`, tail: ["addItem"] });
    expect(() => readCallTarget({}, `/${LLM_HANDLE}`, []))
      .toThrow(/callable name/);
  });

  it("parseSpaceOptions() names the space and the piece in one reference", () => {
    const base = { apiUrl: API_URL, identity: ID };
    // A slug where a handle goes, a name where a DID goes: one token carrying
    // the whole target, in the spelling a person writes.
    expect(parsePieceOptions({ ...base, cell: `//${SPACE}/tracker` }))
      .toMatchObject({ space: SPACE, piece: "tracker" });
    // The named space is checked against `--space` rather than ignored, and
    // two names are settled without a session.
    expect(() =>
      parsePieceOptions({
        ...base,
        space: "other-space",
        cell: `//${SPACE}/tracker`,
      })
    ).toThrow(
      `Reference names space "${SPACE}" but the command targets ` +
        `space "other-space".`,
    );
    // Across spellings only a derivation can compare them, so the reference's
    // space is carried to the session check instead.
    expect(
      parsePieceOptions({ ...base, space: SPACE_DID, cell: "//n-space/t" }),
    ).toMatchObject({ space: SPACE_DID, embeddedSpaces: ["n-space"] });
  });

  it("readTargetPositionals() reads a slug reference as the address", () => {
    // The rooting is what separates a target from a path, so a slug reaches
    // this position rooted and a bare word is still read as a path.
    expect(readTargetPositionals({}, "/tracker", "items/0")).toEqual({
      address: "/tracker",
      pathString: "items/0",
    });
    expect(readTargetPositionals({}, `//${SPACE}/tracker`)).toEqual({
      address: `//${SPACE}/tracker`,
    });
    expect(readTargetPositionals({}, "tracker")).toEqual({
      pathString: "tracker",
    });
  });

  it("readCallTarget() lets a slug reference precede the callable name", () => {
    expect(readCallTarget({}, "/tracker", ["addItem", "{}"])).toEqual({
      cell: "/tracker",
      callableName: "addItem",
      tail: ["{}"],
    });
  });

  it("parseSpaceOptions() decomposes a --url into a transport and a reference", () => {
    // What `--url` means is an `--api-url` and a reference, so a slug in it
    // reaches the target the same way a slug written as one does.
    expect(
      parsePieceOptions({ url: `${API_URL}/${SPACE}/tracker`, identity: ID }),
    )
      .toMatchObject({ apiUrl: API_URL, space: SPACE, piece: "tracker" });
    // Segments past the piece are that reference's path rather than words the
    // URL drops without saying so.
    expect(parsePieceOptions(
      { url: `${FULL_URL}@user/items/0`, identity: ID },
      { acceptsPath: true },
    )).toMatchObject({
      apiUrl: API_URL,
      space: SPACE,
      piece: PIECE,
      pieceScope: "user",
      piecePath: ["items", 0],
    });
  });

  it("parseSpaceOptions() takes both URL encodings off a path segment", () => {
    // A URL escapes with percent-encoding and a cell path is a JSON Pointer,
    // so a key holding "/" or "~" arrives doubly escaped and a segment taken
    // verbatim names a key nothing has.
    expect(parsePieceOptions(
      { url: `${FULL_URL}/foo~1bar/~0tilde`, identity: ID },
      { acceptsPath: true },
    )).toMatchObject({ piecePath: ["foo/bar", "~tilde"] });
    expect(parsePieceOptions(
      {
        url: `${API_URL}/${SPACE}/of%3Afid1%3A${"a".repeat(43)}`,
        identity: ID,
      },
    )).toMatchObject({ piece: `of:fid1:${"a".repeat(43)}` });
  });

  it("parseSpaceOptions() refuses a URL segment that is not valid escaping", () => {
    // `new URL()` accepts a malformed escape and keeps it in the pathname, so
    // the decode is where it surfaces — and a URL naming no readable word
    // names no cell.
    expect(() => parseSpaceOptions({ url: `${API_URL}/%ZZ`, identity: ID }))
      .toThrow(/is not valid percent-encoding/);
    expect(() =>
      parsePieceOptions(
        { url: `${FULL_URL}/%E0%A4%A`, identity: ID },
        { acceptsPath: true },
      )
    ).toThrow(/is not valid percent-encoding/);
  });

  it("parsePieceOptions() preserves an encoded `#argument` path key from a URL", () => {
    const config = parsePieceOptions(
      { url: `${FULL_URL}/foo%23argument`, identity: ID },
      { acceptsPath: true, acceptsArgument: true },
    );
    expect(config.piecePath).toEqual(["foo#argument"]);
    expect(config.pieceInput).not.toBe(true);
  });

  it("readCallTarget() lets the flag name the target for a rooted callable", () => {
    // Nothing reserves the shape of a callable name, so a verb may be called
    // "/archive". The flag is what reaches it: written, it names the target
    // and the positional is the callable.
    expect(readCallTarget({ cell: "board" }, "/archive", ["{}"])).toEqual({
      callableName: "/archive",
      tail: ["{}"],
    });
    // With no flag the rooted word is still the target, as before.
    expect(readCallTarget({}, `/${LLM_HANDLE}`, ["archive"])).toEqual({
      cell: `/${LLM_HANDLE}`,
      callableName: "archive",
      tail: [],
    });
  });

  it('parseLink() rejects the "#argument" suffix on a link endpoint', () => {
    expect(() => parseLink(`/${LLM_HANDLE}#argument`))
      .toThrow(/does not apply to a link endpoint/);
    // A link endpoint names a position to store, and the arguments cell is
    // not one — whichever spelling of the target asks for it.
    expect(() => parseLink(`${LLM_HANDLE}#argument`))
      .toThrow(/does not apply to a link endpoint/);
  });

  it("parseLink() keeps a `#` inside a bare endpoint's path key", () => {
    expect(parseLink("tracker/we#ird")).toEqual({
      pieceId: "tracker",
      path: ["we#ird"],
    });
    expect(parseLink("/tracker/we#ird")).toEqual({
      pieceId: "tracker",
      path: ["we#ird"],
    });
    for (const prefix of ["", "/"]) {
      expect(parseLink(`${prefix}thermostat/draft#argument`)).toEqual({
        pieceId: "thermostat",
        path: ["draft#argument"],
      });
    }
  });

  it("parseSpaceOptions() refuses a piece reference beside a URL that names a piece", () => {
    // Silently preferring either target is how a caller reads a piece they
    // did not name; before this rule the URL's piece won without a word.
    expect(() =>
      parseSpaceOptions({ url: FULL_URL, identity: ID, cell: PIECE })
    ).toThrow(/cannot be provided when the "--url" names a piece/);
    expect(() =>
      parseSpaceOptions({
        url: FULL_URL,
        identity: ID,
        cell: `/${LLM_HANDLE}`,
      })
    ).toThrow(/cannot be provided when the "--url" names a piece/);
  });

  it("parseSpaceOptions() composes a piece-less URL with a piece reference", () => {
    expect(parsePieceOptions({
      url: NO_PIECE_FULL_URL,
      identity: ID,
      cell: PIECE,
    })).toMatchObject({
      apiUrl: API_URL,
      space: SPACE,
      piece: PIECE,
    });
    // The canonical reference keeps its whole grammar in this position: the
    // embedded path and scope ride along, and an embedded space DID defers
    // to the session check because the URL names the space as a name.
    expect(parsePieceOptions(
      {
        url: NO_PIECE_FULL_URL,
        identity: ID,
        cell: `/@${SPACE_DID}/${LLM_HANDLE}@user/items/0`,
      },
      { acceptsPath: true },
    )).toMatchObject({
      apiUrl: API_URL,
      space: SPACE,
      piece: LLM_HANDLE,
      pieceScope: "user",
      piecePath: ["items", 0],
      embeddedSpaces: [SPACE_DID],
    });
  });

  it("getCellValueFromCommand() reads through a positional address, honoring #argument", async () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID, quiet: true };
    const reads: unknown[][] = [];
    const rendered: unknown[] = [];
    const deps = {
      getCellValue: ((...args: unknown[]) => {
        reads.push(args);
        return Promise.resolve({ ok: true });
      }) as never,
      render: ((value: unknown) => {
        rendered.push(value);
      }) as never,
    };
    await getCellValueFromCommand(
      base,
      `/${LLM_HANDLE}/items/0`,
      "title",
      deps,
    );
    expect(reads[0]?.[0]).toMatchObject({ piece: LLM_HANDLE });
    expect(reads[0]?.slice(1)).toEqual([
      ["items", 0, "title"],
      { input: undefined, step: undefined },
    ]);
    await getCellValueFromCommand(
      base,
      `/${LLM_HANDLE}#argument`,
      undefined,
      deps,
    );
    expect(reads[1]?.slice(1)).toEqual([[], { input: true, step: undefined }]);
    expect(rendered).toEqual([{ ok: true }, { ok: true }]);
  });

  it("getCellValueFromCommand() resolves relative heads, members, and scope before reading", async () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID, quiet: true };
    const reads: {
      scope?: string;
      input?: boolean;
      path: readonly (string | number)[];
    }[] = [];
    const deps = {
      getCellValue: (
        config: Parameters<
          NonNullable<PieceCellCommandDependencies["getCellValue"]>
        >[0],
        path: Parameters<
          NonNullable<PieceCellCommandDependencies["getCellValue"]>
        >[1],
        options: Parameters<
          NonNullable<PieceCellCommandDependencies["getCellValue"]>
        >[2],
      ) => {
        reads.push({ scope: config.pieceScope, input: options?.input, path });
        return Promise.resolve({});
      },
      render: () => {},
    };
    await getCellValueFromCommand(
      base,
      `/${LLM_HANDLE}@user/items/0`,
      "../1/title",
      deps,
    );
    await getCellValueFromCommand(
      base,
      `/${LLM_HANDLE}@user/items/0`,
      ".@session/title",
      deps,
    );
    await getCellValueFromCommand(
      base,
      `/${LLM_HANDLE}@user/items/0`,
      ".#argument/title",
      deps,
    );
    await getCellValueFromCommand(
      { ...base, input: true },
      `/${LLM_HANDLE}/items/0`,
      ".#result/",
      deps,
    );
    expect(reads).toEqual([
      { scope: "user", input: undefined, path: ["items", 1, "title"] },
      { scope: "session", input: undefined, path: ["items", 0, "title"] },
      { scope: "user", input: true, path: ["title"] },
      { scope: undefined, input: false, path: [""] },
    ]);
  });

  it('getCellValueFromCommand() reads "#argument" on a bare target as --input does', async () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID, quiet: true };
    const reads: unknown[][] = [];
    const deps = {
      getCellValue: ((...args: unknown[]) => {
        reads.push(args);
        return Promise.resolve({ ok: true });
      }) as never,
      render: (() => {}) as never,
    };

    await getCellValueFromCommand(
      { ...base, cell: "thermostat", input: true },
      "target",
      undefined,
      deps,
    );
    await getCellValueFromCommand(
      { ...base, cell: "thermostat#argument" },
      "target",
      undefined,
      deps,
    );
    // Written together the two spellings union: one selection said twice.
    await getCellValueFromCommand(
      { ...base, cell: "thermostat#argument", input: true },
      "target",
      undefined,
      deps,
    );

    expect(reads).toHaveLength(3);
    for (const read of reads) {
      expect(read[0]).toMatchObject({ piece: "thermostat" });
      expect(read.slice(1)).toEqual([
        ["target"],
        { input: true, step: undefined },
      ]);
    }
  });

  it('setCellValueFromCommand() writes through "#argument" on a bare target', async () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID, quiet: true };
    const writes: unknown[][] = [];
    await setCellValueFromCommand(
      { ...base, cell: "thermostat#argument" },
      "target",
      undefined,
      {
        drainStdin: (() => Promise.resolve(30)) as never,
        setCellValue: ((...args: unknown[]) => {
          writes.push(args);
          return Promise.resolve({ piece: "thermostat", path: ["target"] });
        }) as never,
        render: (() => {}) as never,
      },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toMatchObject({ piece: "thermostat" });
    expect(writes[0]?.slice(1)).toEqual([
      ["target"],
      30,
      { input: true, refuseRootWrite: true },
    ]);
  });

  it("getCellValueFromCommand() leaves an unresolved path on the caller's sinks rather than exiting", async () => {
    // The exit the injected one stands in for is `Deno.exit(1)`, which no
    // long-lived caller survives. An `exit` typed `never` throws instead, so
    // the report the read failed with — its message, the remedy, and the
    // code — is left as values the caller still holds.

    const base = { apiUrl: API_URL, space: SPACE, identity: ID, quiet: true };
    const printed: string[] = [];
    const hinted: string[] = [];
    const exited: number[] = [];
    await expect(
      getCellValueFromCommand(base, `/${LLM_HANDLE}/items/0`, "title", {
        getCellValue: (() =>
          Promise.reject(
            new Error('Cannot access path "items/0/title"'),
          )) as never,
        render: () => {},
        printError: (message) => {
          printed.push(message);
        },
        hint: (message) => {
          hinted.push(message);
        },
        exit: (code): never => {
          exited.push(code);
          throw new Error("exit-sentinel");
        },
      }),
    ).rejects.toThrow("exit-sentinel");
    expect(printed).toEqual(['Cannot access path "items/0/title"']);
    expect(hinted[0]).toContain("retry with --input");
    expect(exited).toEqual([1]);
  });

  it("setCellValueFromCommand() writes through a positional address and requires a path", async () => {
    const base = { apiUrl: API_URL, space: SPACE, identity: ID, quiet: true };
    const writes: unknown[][] = [];
    const hints: string[] = [];
    const deps = {
      drainStdin: (() => Promise.resolve("Milk")) as never,
      setCellValue: ((...args: unknown[]) => {
        writes.push(args);
        return Promise.resolve({
          piece: LLM_HANDLE,
          path: args[1] as (string | number)[],
        });
      }) as never,
      render: (() => {}) as never,
      hint: ((text: string) => {
        hints.push(text);
      }) as never,
    };
    // The embedded path alone satisfies the path requirement, and the write
    // is still held to a path inside whatever piece the address reaches.
    await setCellValueFromCommand(
      base,
      `/${LLM_HANDLE}/title`,
      undefined,
      deps,
    );
    expect(writes[0]?.slice(1)).toEqual([
      ["title"],
      "Milk",
      { input: undefined, refuseRootWrite: true },
    ]);
    // A positional that is not the empty one is a path, not a root: what it
    // reaches after resolution is still held to a path inside the piece.
    await setCellValueFromCommand(base, "/top", "2", deps);
    expect(writes[1]?.slice(1)).toEqual([
      [2],
      "Milk",
      { input: undefined, refuseRootWrite: true },
    ]);
    expect(hints[0]).toContain("cf piece step");
    // An explicit empty positional has always named the root — the fuse
    // integration writes a whole input cell with `piece set "" --input` —
    // so it stays a valid spelling, in both target forms, and it is the one
    // spelling that lets a write land on a whole cell.
    await setCellValueFromCommand(
      { ...base, cell: `/${LLM_HANDLE}`, input: true },
      "",
      undefined,
      deps,
    );
    expect(writes[2]?.slice(1)).toEqual([
      [],
      "Milk",
      { input: true, refuseRootWrite: false },
    ]);
    await setCellValueFromCommand(base, `/${LLM_HANDLE}`, "", deps);
    expect(writes[3]?.slice(1)).toEqual([
      [],
      "Milk",
      { input: undefined, refuseRootWrite: false },
    ]);
    // What stays refused is no path in any spelling: a bare pasted address
    // must not silently overwrite a whole cell.
    await expect(
      setCellValueFromCommand(base, `/${LLM_HANDLE}`, undefined, deps),
    )
      .rejects.toThrow(/A path is required/);
    await expect(
      setCellValueFromCommand(
        { ...base, cell: `/${LLM_HANDLE}` },
        undefined,
        undefined,
        deps,
      ),
    ).rejects.toThrow(/A path is required/);
  });

  it("setCellValueFromCommand() reports the piece and the path the write landed on", async () => {
    // A collection's name spends its leading segments reaching a member, so
    // the address the line carries names neither the piece written to nor the
    // path written at. Both come back from the write.
    const base = { apiUrl: API_URL, space: SPACE, identity: ID, quiet: true };
    const rendered: string[] = [];
    const hints: string[] = [];
    const reporting = {
      drainStdin: (() => Promise.resolve("Oven schedule")) as never,
      setCellValue:
        (() =>
          Promise.resolve({ piece: LLM_HANDLE, path: ["title"] })) as never,
      render: ((text: string) => {
        rendered.push(text);
      }) as never,
      hint: ((text: string) => {
        hints.push(text);
      }) as never,
    };
    await setCellValueFromCommand(base, "/top/2", "title", reporting);
    expect(rendered).toEqual(["Set value at path: title"]);
    expect(hints[0]).toContain(`cf piece step --cell ${LLM_HANDLE}`);

    // Where the walk spends nothing the address still names the piece, and
    // the next command is one the reader can paste as they typed it.
    rendered.length = 0;
    hints.length = 0;
    await setCellValueFromCommand(base, "/tracker", "title", reporting);
    expect(rendered).toEqual(["Set value at path: title"]);
    expect(hints[0]).toContain("cf piece step --cell tracker");
  });

  it("parsePieceOptions() throws on incomplete input", () => {
    expect(() =>
      parsePieceOptions({
        url: NO_PIECE_FULL_URL,
        identity: ID,
      })
    ).toThrow(/--piece/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        space: SPACE,
        identity: ID,
      })
    ).toThrow(/--piece/);
    expect(() =>
      parsePieceOptions({
        url: FULL_URL,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        space: SPACE,
        cell: PIECE,
      })
    ).toThrow(/--identity/);
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        identity: ID,
        cell: PIECE,
      })
    ).toThrow(/--space/);
    expect(() =>
      parsePieceOptions({
        space: SPACE,
        identity: ID,
        cell: PIECE,
      })
    ).toThrow(/--api-url/);
    expect(() =>
      parsePieceOptions({
        identity: ID,
        cell: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        space: SPACE,
        cell: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        apiUrl: API_URL,
        cell: PIECE,
      })
    ).toThrow();
    expect(() =>
      parsePieceOptions({
        url: FULL_URL,
        cell: PIECE,
      })
    ).toThrow();
  });

  it("newPiece() asks a serving deployment to create the piece and keeps only the start", async () => {
    // The connection carries the deployment's flag posture; under it the
    // client resolves the program, sends it with the name and the registry
    // request, leaves the space root to the serving loop, and starts the
    // piece it is handed back unless told not to.
    const program = { main: "/main.tsx", files: [] };
    const cell = { name: "the new piece's cell" };
    const seen: {
      ensured?: true;
      requests: unknown[];
      started: unknown[];
    } = { requests: [], started: [] };
    const controller = {
      runtime: { experimental: { serverExecution: true } },
      getSpace: () => SPACE_DID,
      ensureDefaultPattern: () => {
        seen.ensured = true;
        return Promise.resolve();
      },
      getPieceCell: () => Promise.resolve(cell),
      startPiece: (started: unknown) => {
        seen.started.push(started);
        return Promise.resolve();
      },
    };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
      getPinnedProgramFromFile: () => Promise.resolve(program as any),
      loadIdentity: () => Promise.resolve({} as any),
      instantiatePieceOnServer: (_config: unknown, input: unknown) => {
        seen.requests.push(input);
        return Promise.resolve({
          pieceId: PIECE,
          pattern: { identity: "i", symbol: "default" },
          slug: "named",
        });
      },
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const entry = { mainPath: "/main.tsx", repository: "repo" };

    const started = await newPiece(config, entry, { slug: "named" }, deps);
    expect(started).toBe(PIECE);
    expect(seen.requests[0]).toEqual({
      space: SPACE_DID,
      program,
      repository: "repo",
      slug: "named",
      register: true,
    });
    expect(seen.started).toEqual([cell]);

    const unstarted = await newPiece(
      config,
      entry,
      { start: false, force: true },
      deps,
    );
    expect(unstarted).toBe(PIECE);
    expect(seen.requests[1]).toEqual({
      space: SPACE_DID,
      program,
      repository: "repo",
      force: true,
      register: true,
      start: false,
    });
    expect(seen.started).toEqual([cell]);
    expect(seen.ensured).toBeUndefined();
  });

  it("setPiecePattern() asks a serving deployment to replace the source and refreshes the piece here", async () => {
    // Under the deployment's flag posture the client resolves the program
    // and sends it; the serving runtime commits the update. What stays here
    // is the refresh of the piece this connection holds, whose outcome the
    // receipt reports the way a client-side update's does.
    const program = { main: "/main.tsx", files: [] };
    const cell = { name: "the piece's cell" };
    const seen: { requests: unknown[]; started: unknown[] } = {
      requests: [],
      started: [],
    };
    let refreshFails = false;
    const controller = {
      runtime: { experimental: { serverExecution: true } },
      getSpace: () => SPACE_DID,
      getPieceCell: () => Promise.resolve(cell),
      startPiece: (started: unknown) => {
        seen.started.push(started);
        return refreshFails
          ? Promise.reject(new Error("the piece never settled"))
          : Promise.resolve();
      },
    };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
      resolvePieceAddress: () => Promise.resolve(PIECE),
      getPinnedProgramFromFile: () => Promise.resolve(program as any),
      loadIdentity: () => Promise.resolve({} as any),
      setPieceSourceOnServer: (_config: unknown, input: unknown) => {
        seen.requests.push(input);
        return Promise.resolve({
          pieceId: PIECE,
          pattern: { identity: "B".repeat(43), symbol: "default" },
          revisionId: "revision-2",
          seq: 12,
          detachedOrigin: "system:origin.tsx",
        });
      },
    };
    const config = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
    };
    const entry = { mainPath: "/main.tsx", repository: "repo" };

    const receipt = await setPiecePattern(config, entry, {}, deps);
    expect(receipt).toEqual({
      status: "committed",
      ref: { identity: "B".repeat(43), symbol: "default" },
      space: SPACE_DID,
      seq: 12,
      revisionId: "revision-2",
      detachedOrigin: "system:origin.tsx",
      refresh: { status: "completed" },
    });
    expect(seen.requests[0]).toEqual({
      space: SPACE_DID,
      piece: PIECE,
      program,
      repository: "repo",
    });
    expect(seen.started).toEqual([cell]);

    refreshFails = true;
    const unrefreshed = await setPiecePattern(
      config,
      entry,
      { dangerouslyAllowIncompatibleSchema: true },
      deps,
    );
    expect(seen.requests[1]).toEqual({
      space: SPACE_DID,
      piece: PIECE,
      program,
      repository: "repo",
      dangerouslyAllowIncompatibleSchema: true,
    });
    expect(unrefreshed.refresh).toEqual({
      status: "failed",
      warning: "the piece never settled",
    });
  });

  it("recreateSpaceRootPattern() targets the explicit space", async () => {
    const seen: { config?: SpaceConfig } = {};
    const pieceId = await recreateSpaceRootPattern({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    }, {
      loadPieces: (config) => {
        seen.config = config;
        return Promise.resolve({
          recreateDefaultPattern: () => Promise.resolve({ id: PIECE }),
        } as any);
      },
    });

    expect(seen.config).toEqual({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    });
    expect(pieceId).toBe(PIECE);
  });

  it("shows recreate-root as a space-scoped command", async () => {
    const { code, stdout, stderr } = await cf("space recreate-root --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(output).toContain(
      "Recreate the root pattern for the explicitly targeted space.",
    );
    expect(output).toContain("--space <space>");
    expect(code).toBe(0);
  });

  it("shows search as a registered-piece command with JSON output", async () => {
    const { code, stdout, stderr } = await cf("piece search --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(output).toContain(
      "Search input and result data in registered pieces.",
    );
    expect(output).toContain("<query>");
    expect(output).toContain("--space <space>");
    expect(output).toContain("--json");
    expect(code).toBe(0);
  });

  it("describes listing and mapping as registry-backed", async () => {
    const commands = [
      {
        args: "piece ls --help",
        description: "List pieces registered in the space.",
      },
      {
        args: "piece map --help",
        description: "Show registered pieces and the connections between them",
      },
    ];
    for (const command of commands) {
      const { code, stdout, stderr } = await cf(command.args);
      checkStderr(stderr);
      const output = stripAnsi(stdout.join("\n"));
      expect(output).toContain(command.description);
      expect(output).not.toContain("all pieces");
      expect(code).toBe(0);
    }
  });

  it("documents the piece registry in link help", async () => {
    const { code, stdout, stderr } = await cf("piece link --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(code).toBe(0);
    expect(output).toContain("fid1:piece1/pieceRegistry");
    expect(output).toContain(
      'Link the well-known "pieceRegistry" list to a piece field.',
    );
  });

  describe("parseLink", () => {
    it("should parse piece ID only", () => {
      const result = parseLink("piece1");
      expect(result.pieceId).toBe("piece1");
      expect(result.path).toBeUndefined();
    });

    it("should parse scope suffixes on the piece ID segment", () => {
      expect(parseLink("piece1@user")).toEqual({
        pieceId: "piece1",
        scope: "user",
      });
      expect(parseLink("piece1@session/path/0")).toEqual({
        pieceId: "piece1",
        scope: "session",
        path: ["path", 0],
      });
      expect(parseLink("piece1@space/path")).toEqual({
        pieceId: "piece1",
        scope: "space",
        path: ["path"],
      });
    });

    it("should reject invalid scope suffixes on the piece ID segment", () => {
      expect(() => parseLink("piece1@any")).toThrow(/Invalid scope suffix/);
      expect(() => parseLink("piece1@inherit")).toThrow(
        /requires a reference context/,
      );
      expect(() => parseLink("piece1@")).toThrow(/Invalid scope suffix/);
    });

    it("should parse simple paths correctly", () => {
      const result = parseLink("piece1/field");
      expect(result.pieceId).toBe("piece1");
      expect(result.path).toEqual(["field"]);
    });

    it("should parse deep paths with array indices", () => {
      const result = parseLink("piece2/data/items/0/title");
      expect(result.pieceId).toBe("piece2");
      expect(result.path).toEqual(["data", "items", 0, "title"]);
    });

    it("should handle mixed string and numeric paths", () => {
      const result = parseLink("piece/users/5/profile/settings/2");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["users", 5, "profile", "settings", 2]);
    });

    it("should handle paths with only numbers", () => {
      const result = parseLink("piece/0/1/2");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual([0, 1, 2]);
    });

    it("should preserve @ in path segments after the piece ID", () => {
      const result = parseLink("piece/user@email");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["user@email"]);
      expect(result.scope).toBeUndefined();
    });

    it("should handle empty string after slash", () => {
      const result = parseLink("piece/field/");
      expect(result.pieceId).toBe("piece");
      expect(result.path).toEqual(["field", ""]);
    });

    it("parses an LLM-friendly reference like the bare form", () => {
      expect(parseLink(`/${LLM_HANDLE}`)).toEqual({ pieceId: LLM_HANDLE });
      expect(parseLink(`/${LLM_HANDLE}/data/items/0/title`)).toEqual(
        parseLink(`${LLM_HANDLE}/data/items/0/title`),
      );
      expect(parseLink(`/${LLM_HANDLE}@user/field`)).toEqual({
        pieceId: LLM_HANDLE,
        scope: "user",
        path: ["field"],
      });
    });

    it("checks an embedded space DID against the target space", () => {
      expect(
        parseLink(`/@${SPACE_DID}/${LLM_HANDLE}/field`, { space: SPACE_DID }),
      ).toEqual({
        pieceId: LLM_HANDLE,
        path: ["field"],
      });
      expect(() =>
        parseLink(`/@${SPACE_DID}/${LLM_HANDLE}/field`, {
          space: OTHER_SPACE_DID,
        })
      ).toThrow(/names space/);
      // With a named target space the DID rides along for the deferred
      // check loadPieces runs against the session's resolved space.
      expect(
        parseLink(`/@${SPACE_DID}/${LLM_HANDLE}/field`, { space: SPACE }),
      ).toEqual({
        pieceId: LLM_HANDLE,
        embeddedSpace: SPACE_DID,
        path: ["field"],
      });
    });
  });

  describe("embedded space DIDs given to a link command", () => {
    // A `--space` given as a name resolves to a DID only when the session
    // opens, so a DID embedded in a reference rides along to that point and
    // is compared there. Each command below reaches the comparison without a
    // server: the session derives the space key from the name locally, and
    // the check runs before any storage is opened.
    let identityPath = "";

    beforeEach(async () => {
      identityPath = await Deno.makeTempFile({ suffix: ".key" });
      await Deno.writeTextFile(identityPath, TEST_PKCS8_KEY);
    });

    afterEach(async () => {
      await Deno.remove(identityPath);
    });

    const options = () =>
      `--identity ${identityPath} --api-url ${API_URL} --space ${SPACE}`;

    const spaceRefusal = async (command: string) => {
      const { code, stderr } = await cf(command);
      expect(code).toBe(1);
      return stripAnsi(stderr.join("\n"));
    };

    it("refuses a link whose source names another space", async () => {
      expect(
        await spaceRefusal(
          `piece link ${options()} ` +
            `/@${SPACE_DID}/${LLM_HANDLE}/notes ${LLM_HANDLE}/inbox`,
        ),
      ).toContain(`Reference names space "${SPACE_DID}"`);
    });

    it("refuses a link whose target names another space", async () => {
      expect(
        await spaceRefusal(
          `piece link ${options()} ` +
            `${LLM_HANDLE}/notes /@${SPACE_DID}/${LLM_HANDLE}/inbox`,
        ),
      ).toContain(`Reference names space "${SPACE_DID}"`);
    });

    it("refuses a sqlite link whose target names another space", async () => {
      expect(
        await spaceRefusal(
          `piece link ${options()} ` +
            `sqlite:/tmp/reference-data.db /@${SPACE_DID}/${LLM_HANDLE}/refDb`,
        ),
      ).toContain(`Reference names space "${SPACE_DID}"`);
    });

    it("refuses a slug whose source names another space", async () => {
      expect(
        await spaceRefusal(
          `piece set-slug ${options()} ` +
            `project-notes /@${SPACE_DID}/${LLM_HANDLE}/notes`,
        ),
      ).toContain(`Reference names space "${SPACE_DID}"`);
    });

    it("still requires a path on a link target given in the canonical form", async () => {
      // The path rule is the bare form's, and reaching it proves the
      // canonical endpoint was parsed rather than refused as unrecognized.
      expect(
        await spaceRefusal(
          `piece link ${options()} ${LLM_HANDLE}/notes /${LLM_HANDLE}`,
        ),
      ).toContain("Target reference must include a path.");
    });
  });

  it("shows source-location options for every local deployment command", () => {
    // `set-home` is reached through `cf space` now; the hidden `cf piece`
    // mount is the same definition and is pinned against it below.
    const pieceFlags = (command: string) =>
      piece.getCommand(command, true)!.getOptions().flatMap((o) => o.flags);
    const spaceFlags = (command: string) =>
      space.getCommand(command)!.getOptions().flatMap((o) => o.flags);
    const newFlags = pieceFlags("new");
    expect(newFlags).toContain("--slug");
    expect(newFlags).toContain("--root");
    expect(newFlags).toContain("--repository");
    expect(newFlags).toContain("--test");
    expect(newFlags).toContain("--datafile");
    expect(newFlags).toContain("--dangerously-allow-incompatible-schema");

    for (const flags of [pieceFlags("setsrc"), spaceFlags("set-home")]) {
      expect(flags).toContain("--root");
      expect(flags).toContain("--repository");
      expect(flags).toContain("--test");
      expect(flags).toContain("--datafile");
    }
    expect(pieceFlags("setsrc")).toContain(
      "--dangerously-allow-incompatible-schema",
    );
  });

  it("declares the same options on both mounts of a moved command", () => {
    // One builder, two mount points: a caller who has not migrated yet meets
    // the surface the new spelling has, not a copy that can drift from it.
    // Compared on each command's own declarations, because the two nouns
    // contribute different globals -- see the `--json` case below.
    const own = (command: { getBaseOptions(): { flags: string[] }[] }) =>
      command.getBaseOptions().flatMap((o) => o.flags).sort();
    for (const moved of ["set-home", "recreate-root"]) {
      expect(own(piece.getCommand(moved, true)!)).toEqual(
        own(space.getCommand(moved)!),
      );
    }
  });

  it("refuses `--json` on a moved command rather than ignoring it", async () => {
    const { code, stdout, stderr } = await cf(
      "space recreate-root --json -i ./k.key -s s -a http://localhost:8000",
    );
    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      "has no machine-readable output",
    );
  });

  it("inherits `--json` on the `cf space` mount and refuses it", () => {
    // `cf space` declares --json globally for the store commands, so the two
    // target-scoped ones inherit an option they have no output to answer
    // with. Pinned rather than left implicit: the refusal is what keeps it
    // from silently printing human text to a caller who asked to parse it.
    const all = (command: { getOptions(): { flags: string[] }[] }) =>
      command.getOptions().flatMap((o) => o.flags);
    expect(all(space.getCommand("set-home")!)).toContain("--json");
    expect(all(piece.getCommand("set-home", true)!)).not.toContain("--json");
  });

  it("hides the superseded `cf piece` mounts from help", () => {
    // Hidden is what keeps the old spelling working without teaching it: it
    // stays reachable for a caller who already wrote it, and is offered to
    // nobody new.
    const names = (
      // deno-lint-ignore no-explicit-any
      command: any,
      includeHidden: boolean,
    ): string[] =>
      command.getCommands(includeHidden).map((c: { getName(): string }) =>
        c.getName()
      );
    for (const moved of ["set-home", "recreate-root"]) {
      expect(names(piece, true)).toContain(moved);
      expect(names(piece, false)).not.toContain(moved);
      expect(names(space, false)).toContain(moved);
    }
  });

  it("offers computed transforms for piece reads", () => {
    const getFlags = pieceDataCommand("get").getOptions().flatMap((option) =>
      option.flags
    );
    expect(getFlags).toContain("--step");
    expect(getFlags).toContain("--filter");
    expect(getFlags).toContain("--select");
    expect(getFlags).toContain("--schema");
  });

  it("describes `--schema` as taking the field list `--select` takes", () => {
    // `--schema` reads that field list as well as a JSON Schema, and its
    // description is the only place a caller reading `--help` learns so. A
    // description naming one of the two languages sends a caller who wants
    // both a field list and a schema shape to the wrong flag.
    const schemaOption = pieceDataCommand("get").getOptions().find((option) =>
      option.flags.includes("--schema")
    )!;
    expect(schemaOption.description).toContain("--select field list");
  });

  it("parses the --filter, --select, and --schema options into a selection", async () => {
    expect(await parseCellSelectionOptions({})).toBeUndefined();

    const filterOnly = await parseCellSelectionOptions({
      filter: ".active",
    });
    expect(filterOnly?.filter?.source).toBe(".active");
    expect(filterOnly?.projection).toBeUndefined();

    const schemaOnly = await parseCellSelectionOptions({
      schema: "id,name",
    });
    expect(schemaOnly?.filter).toBeUndefined();
    expect(schemaOnly?.projection?.source).toBe("id,name");
    expect(schemaOnly?.projection?.flag).toBe("--schema");

    const selectOnly = await parseCellSelectionOptions({
      select: "id,name",
    });
    expect(selectOnly?.filter).toBeUndefined();
    expect(selectOnly?.projection?.flag).toBe("--select");
    expect(selectOnly?.projection?.schema).toEqual(
      schemaOnly?.projection
        ?.schema,
    );

    const marked = await parseCellSelectionOptions({ select: "topic@" });
    expect(marked?.projection?.markers).toEqual({
      properties: { topic: { marked: true } },
    });

    const both = await parseCellSelectionOptions({
      filter: ".active",
      schema: "id",
    });
    expect(both?.filter?.source).toBe(".active");
    expect(both?.projection?.source).toBe("id");
  });

  it("refuses a piece get command that names both projection flags", async () => {
    const { code, stderr } = await cf(
      "get " +
        "--identity ./definitely-missing-piece-get-review.key " +
        "--api-url https://cf.dev --space common-knowledge " +
        `--piece ${PIECE} --select id --schema id`,
    );
    expect(code).not.toBe(0);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Option "--schema" conflicts with option "--select".',
    );
  });

  it("passes a --select projection through the piece get command action", async () => {
    const { code, stderr } = await cf(
      "get " +
        "--identity ./definitely-missing-piece-get-review.key " +
        "--api-url https://cf.dev --space common-knowledge " +
        `--piece ${PIECE} --select id,title`,
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain(
      "definitely-missing-piece-get-review.key",
    );
  });

  it("passes a parsed selection through the piece get command action", async () => {
    const { code, stderr } = await cf(
      "get " +
        "--identity ./definitely-missing-piece-get-review.key " +
        "--api-url https://cf.dev --space common-knowledge " +
        `--piece ${PIECE} --filter .active --schema id`,
    );
    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain(
      "definitely-missing-piece-get-review.key",
    );
  });

  it("applies a selection to the cell at the read path", async () => {
    const targetCell = { marker: "selected-path-cell" };
    const rootCell = {
      key: (...path: Array<string | number>) => {
        expect(path).toEqual(["items"]);
        return targetCell;
      },
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => {
              throw new Error("selection reads must not materialize result");
            },
            getCell: () => Promise.resolve(rootCell),
          },
        }),
      runtime: { marker: "runtime" },
      getSpace: () => "did:key:test-space",
    };
    const filter = parseSelectionFilter(".id == 2");

    const value = await getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["items"],
      { selection: { filter } },
      {
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
        deriveSelectedValue: (runtime, space, source, selection) => {
          expect(runtime).toBe(controller.runtime as any);
          expect(space).toBe("did:key:test-space");
          expect(source).toBe(targetCell as any);
          expect(selection.filter).toBe(filter);
          return Promise.resolve([{ id: 2 }]);
        },
      },
    );

    expect(value).toEqual([{ id: 2 }]);
  });

  it("preserves selection errors that are not result projection failures", async () => {
    const selectionError = new CellSelectionError("invalid selection");
    const targetCell = {};
    const rootCell = { key: () => targetCell };
    const controller = {
      get: () =>
        Promise.resolve({
          result: { getCell: () => Promise.resolve(rootCell) },
        }),
      runtime: {},
      getSpace: () => "did:key:test-space",
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      { selection: { filter: parseSelectionFilter(".active") } },
      {
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
        deriveSelectedValue: () => Promise.reject(selectionError),
      },
    )).rejects.toBe(selectionError);
  });

  it("prefers the verb refusal over a selection error on a stream path", async () => {
    // A --filter against a handler fails inside the selector with a shape
    // error ("--filter can only be applied to an array") that sends the
    // caller to their schema, when the answer is `cf piece call`. The stored
    // {$stream: true} sentinel is a definite signal, so the verb refusal
    // wins over whatever the selector threw.
    // What a real cell answers for a verb: the parent stores a LINK at the
    // name, so the child's stored value is that link and it is the
    // link-derived cell that answers as a stream. The sentinel never appears
    // in the parent's projected value at all.
    const targetCell = {
      getRaw: () => ({ "/": "stream-link" }),
      isStream: () => true,
      asSchemaFromLinks: () => targetCell,
    };
    const rootCell = {
      key: () => targetCell,
      get: () => ({ addNote: { "/": "stream-link" } }),
    };
    const controller = {
      get: () =>
        Promise.resolve({
          result: { getCell: () => Promise.resolve(rootCell) },
        }),
      runtime: {},
      getSpace: () => "did:key:test-space",
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["addNote"],
      { selection: { filter: parseSelectionFilter(".active") } },
      {
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
        deriveSelectedValue: () =>
          Promise.reject(
            new CellSelectionError("--filter can only be applied to an array"),
          ),
      },
    )).rejects.toThrow(PieceVerbReadError);
  });

  it("reports projection failures encountered during a selection read", async () => {
    const targetCell = {
      schema: { type: "number" },
      getRaw: () => ({ "/": "missing-session-count" }),
    };
    const rootCell = {
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
      key: () => targetCell,
    };
    const controller = {
      get: () =>
        Promise.resolve({
          result: { getCell: () => Promise.resolve(rootCell) },
        }),
      runtime: {},
      getSpace: () => "did:key:test-space",
    };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
      loadPieceForRead: (
        _pieces: unknown,
        id: string,
        step: boolean,
        scope: PieceConfig["pieceScope"],
      ) =>
        (controller.get as (...args: unknown[]) => Promise<never>)(
          id,
          step,
          undefined,
          scope,
        ),
      resolvePieceAddress: (_pieces: any, id: string) => Promise.resolve(id),
    };
    const options = {
      selection: { filter: parseSelectionFilter(".active") },
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["count"],
      options,
      {
        ...deps,
        deriveSelectedValue: () =>
          Promise.reject(
            new Error('Cannot access path "count" - property not found'),
          ),
      },
    )).rejects.toThrow(PieceResultProjectionError);

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["count"],
      options,
      {
        ...deps,
        deriveSelectedValue: () => Promise.resolve(undefined),
      },
    )).rejects.toThrow(PieceResultProjectionError);
  });

  it("distinguishes failed selections, JSON null, and absent sources", async () => {
    let sourceRaw: unknown;
    const targetCell = {
      schema: { type: ["object", "null"] },
      getRaw: () => sourceRaw,
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { getCell: () => Promise.resolve(targetCell) },
        }),
      runtime: {},
      getSpace: () => "did:key:test-space",
    };

    const options = {
      input: true,
      selection: { projection: await parseSelectionProjection("id") },
    };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
      loadPieceForRead: (
        _pieces: unknown,
        id: string,
        step: boolean,
        scope: PieceConfig["pieceScope"],
      ) =>
        (controller.get as (...args: unknown[]) => Promise<never>)(
          id,
          step,
          undefined,
          scope,
        ),
      resolvePieceAddress: (_pieces: any, id: string) => Promise.resolve(id),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["value"],
      options,
      {
        ...deps,
        deriveSelectedValue: () => {
          sourceRaw = { id: "loaded-during-transform" };
          return Promise.resolve(undefined);
        },
      },
    )).rejects.toThrow("This is not JSON null");

    sourceRaw = null;
    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["value"],
      options,
      {
        ...deps,
        deriveSelectedValue: () => Promise.resolve(null),
      },
    )).resolves.toBeNull();

    sourceRaw = undefined;
    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["value"],
      options,
      {
        ...deps,
        deriveSelectedValue: () => Promise.resolve(undefined),
      },
    )).resolves.toBeUndefined();
  });

  it("offers per-phase timing output for piece call", () => {
    const callFlags = pieceDataCommand("call").getOptions().flatMap((option) =>
      option.flags
    );
    expect(callFlags).toContain("--verbose");
  });

  it("offers wait control for piece call", () => {
    const callFlags = pieceDataCommand("call").getOptions().flatMap((option) =>
      option.flags
    );
    expect(callFlags).toContain("--await");
    expect(callFlags).toContain("--wait");
    expect(callFlags).toContain("--no-wait");
  });

  it("offers result-link annotation for piece call", () => {
    const callFlags = pieceDataCommand("call").getOptions().flatMap((option) =>
      option.flags
    );
    expect(callFlags).toContain("--show-links");
  });

  it("describes piece call's `--schema` as taking a field list as well", () => {
    // The call reads its selection through the read's grammar, so the flag
    // takes every form the read's does. Its own `--help` line is where a
    // caller learns which, and one naming fewer forms than the parser takes
    // reads as a narrowing that is not there.
    const schemaOption = pieceDataCommand("call").getOptions().find((option) =>
      option.flags.includes("--schema")
    )!;
    expect(schemaOption.description).toContain("--select field list");
  });

  it("steps, pulls only the requested result path, syncs, and stops", async () => {
    const order: string[] = [];
    const controller = {
      get: (
        id: string,
        runIt: boolean,
        _schema: unknown,
        scope: string | undefined,
      ) => {
        order.push(`get:${id}:${runIt}:${scope}`);
        return Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          getCell: () => ({
            pull: () =>
              Promise.reject(
                new Error("a nested stepped read pulled the piece root"),
              ),
          }),
          result: {
            getCell: () =>
              Promise.resolve({
                key: (segment: string) => {
                  order.push(`result.key:${segment}`);
                  return {
                    pull: () => {
                      order.push("result.pull");
                      return Promise.resolve();
                    },
                  };
                },
              }),
            get: () => {
              order.push("result.get");
              return Promise.resolve("ready");
            },
          },
        });
      },
      stopPiece: (id: string) => {
        order.push(`stop:${id}`);
        return Promise.resolve();
      },
      runtime: {
        idle: () => {
          order.push("runtime.idle");
          return Promise.resolve();
        },
      },
      synced: () => {
        order.push("pieces.synced");
        return Promise.resolve();
      },
    };

    const value = await getCellValue(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: ID,
        piece: PIECE,
        pieceScope: "session",
      },
      ["value"],
      { step: true },
      {
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
      },
    );

    expect(value).toBe("ready");
    expect(order).toEqual([
      `get:${PIECE}:true:session`,
      "result.key:value",
      "result.pull",
      "pieces.synced",
      "runtime.idle",
      "pieces.synced",
      "result.get",
      // The read-path guard classifies the read path after the value read
      // (verb contract WS-F), descending to the same key once more.
      "result.key:value",
      `stop:${PIECE}`,
    ]);
  });

  it("steps an input path read without pulling the piece root either", async () => {
    // The skipped pull sat ahead of the input/result fork, so the input side
    // of a stepped path read changed on the same terms as the result side.
    const order: string[] = [];
    const controller = {
      get: (id: string, runIt: boolean) => {
        order.push(`get:${id}:${runIt}`);
        return Promise.resolve({
          getCell: () => ({
            pull: () =>
              Promise.reject(
                new Error("a nested stepped input read pulled the piece root"),
              ),
          }),
          input: {
            getCell: (path: string[] = []) => {
              const root = {
                key: (segment: string) => {
                  order.push(`input.key:${segment}`);
                  return {
                    pull: () => {
                      order.push("input.pull");
                      return Promise.resolve();
                    },
                  };
                },
              };
              return Promise.resolve(path.length ? root.key(path[0]) : root);
            },
            get: () => {
              order.push("input.get");
              return Promise.resolve(["updated-while-stopped"]);
            },
          },
          result: { get: () => Promise.resolve(undefined) },
        });
      },
      stopPiece: (id: string) => {
        order.push(`stop:${id}`);
        return Promise.resolve();
      },
      runtime: {
        idle: () => {
          order.push("runtime.idle");
          return Promise.resolve();
        },
      },
      synced: () => {
        order.push("pieces.synced");
        return Promise.resolve();
      },
    };

    const value = await getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["values"],
      { step: true, input: true },
      {
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
      },
    );

    expect(value).toEqual(["updated-while-stopped"]);
    expect(order).toEqual([
      `get:${PIECE}:true`,
      "input.key:values",
      "input.pull",
      "pieces.synced",
      "runtime.idle",
      "pieces.synced",
      "input.get",
      "input.key:values",
      `stop:${PIECE}`,
    ]);
  });

  it("steps a path-less read through the whole result before syncing", async () => {
    const order: string[] = [];
    const controller = {
      get: (id: string, runIt: boolean) => {
        order.push(`get:${id}:${runIt}`);
        return Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          getCell: () => ({
            pull: () => {
              order.push("piece.pull");
              return Promise.resolve();
            },
          }),
          result: {
            getCell: () => {
              // `rootCell.key(...path)` with an empty path is `key()`: the
              // root itself, never a descent.
              const root = {
                key: (...segments: string[]) => {
                  if (segments.length > 0) {
                    throw new Error("a path-less read descended into a key");
                  }
                  order.push("result.key:<root>");
                  return root;
                },
                pull: () => {
                  order.push("result.pull");
                  return Promise.resolve();
                },
              };
              return Promise.resolve(root);
            },
            get: () => {
              order.push("result.get");
              return Promise.resolve({ value: "ready" });
            },
          },
        });
      },
      stopPiece: (id: string) => {
        order.push(`stop:${id}`);
        return Promise.resolve();
      },
      runtime: {
        idle: () => {
          order.push("runtime.idle");
          return Promise.resolve();
        },
      },
      synced: () => {
        order.push("pieces.synced");
        return Promise.resolve();
      },
    };

    const value = await getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      { step: true },
      {
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
        resolvePieceAddress: (_pieces, id) => Promise.resolve(id),
      },
    );

    expect(value).toEqual({ value: "ready" });
    // The whole-result pull is the path-less read's materialization step;
    // a nested read replaces it with its own target pull (the test above).
    expect(order).toEqual([
      `get:${PIECE}:true`,
      "piece.pull",
      "result.key:<root>",
      "result.pull",
      "pieces.synced",
      "runtime.idle",
      "pieces.synced",
      "result.get",
      `stop:${PIECE}`,
    ]);
  });

  it("reports schema projection failure when raw result data exists", async () => {
    const rawCell = {
      schema: { type: "object" },
      getRaw: () => ({ value: { "/": "missing-session-value" } }),
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => Promise.resolve(undefined),
            getCell: () => Promise.resolve(rawCell),
          },
        }),
    };

    const error = await getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      {},
      {
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
      },
    ).catch((error) => error);
    expect(error).toBeInstanceOf(PieceResultProjectionError);
    expect((error as Error).message).toContain("Use --step");
  });

  it("preserves undefined when no raw result data exists", async () => {
    const rawCell = {
      schema: { type: "object" },
      getRaw: () => undefined,
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => Promise.resolve(undefined),
            getCell: () => Promise.resolve(rawCell),
          },
        }),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      {},
      {
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
      },
    )).resolves.toBeUndefined();
  });

  it("reports a missing path backed by an unresolved raw link", async () => {
    const childCell = {
      schema: { type: "number" },
      getRaw: () => ({ "/": "missing-session-count" }),
    };
    const rootCell = {
      schema: {
        type: "object",
        properties: { count: { type: "number" } },
        required: ["count"],
      },
      getRaw: () => ({ count: { "/": "missing-session-count" } }),
      key: () => childCell,
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () =>
              Promise.reject(
                new Error('Cannot access path "count" - property not found'),
              ),
            getCell: () => Promise.resolve(rootCell),
          },
        }),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["count"],
      {},
      {
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
      },
    )).rejects.toThrow(PieceResultProjectionError);
  });

  it("rethrows a read failure that is not a path/projection condition", async () => {
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => Promise.reject(new Error("network unreachable")),
            getCell: () =>
              Promise.resolve({ schema: undefined, getRaw: () => undefined }),
          },
        }),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      ["count"],
      {},
      {
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
      },
    )).rejects.toThrow("network unreachable");
  });

  it("preserves schema-valid undefined over present raw data", async () => {
    const rawCell = {
      schema: {
        anyOf: [{ type: "object" }, { type: "undefined" }],
      },
      getRaw: () => ({ "/": "optional-session-value" }),
    };
    const controller = {
      get: () =>
        Promise.resolve({
          input: { get: () => Promise.resolve(undefined) },
          result: {
            get: () => Promise.resolve(undefined),
            getCell: () => Promise.resolve(rawCell),
          },
        }),
    };

    await expect(getCellValue(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: PIECE },
      [],
      {},
      {
        resolvePieceAddress: (_manager, id) => Promise.resolve(id),
        loadPieces: () => Promise.resolve(controller as any),
        loadPieceForRead: (_pieces, id, step, scope) =>
          (controller.get as (...args: unknown[]) => Promise<never>)(
            id,
            step,
            undefined,
            scope,
          ),
      },
    )).resolves.toBeUndefined();
  });

  describe("read-path guard (verb contract WS-F)", () => {
    /** Minimal cell double for the guard's classification walk: value
     * access, key() descent, and asSchemaFromLinks identity — the same
     * surface piece-verbs.test.ts doubles for listPieceCallables. Its
     * asSchema models the real forced-cast semantics: the cast schema
     * survives resolution for inline values and schema-less links, so a
     * forced probe answers "stream" for ANY name. The guard is certain-only
     * and must never consult that cast — the data reads below go through
     * this double to pin it. */
    function guardCell(value: unknown): {
      get: () => unknown;
      getRaw: () => unknown;
      asSchemaFromLinks: () => unknown;
      asSchema: (schema: unknown) => unknown;
      key: (...segments: (string | number)[]) => unknown;
    } {
      const self = {
        get: () => value,
        getRaw: () => value,
        asSchemaFromLinks: () => self,
        asSchema: (_schema: unknown) => ({
          key: (_name: string) => ({ isStream: () => true }),
        }),
        key: (...segments: (string | number)[]) => {
          let child: unknown = value;
          for (const segment of segments) {
            child = isObjectOrArray(child)
              ? (child as Record<string | number, unknown>)[segment]
              : undefined;
          }
          return guardCell(child);
        },
      };
      return self;
    }

    const readPath = (value: unknown, path: (string | number)[]): unknown =>
      path.reduce(
        (current: unknown, segment) =>
          isObjectOrArray(current)
            ? (current as Record<string | number, unknown>)[segment]
            : undefined,
        value,
      );

    const RESULT_VALUE = {
      title: "Groceries",
      addItem: { $stream: true },
      nested: {
        list: ["milk"],
        removeItem: { $stream: true },
      },
      search: {
        pattern: { argumentSchema: { type: "object" } },
        extraParams: {},
      },
    };

    const guardDeps = (piece: unknown) => ({
      loadPieceForRead: () => Promise.resolve(piece as never),
      resolvePieceAddress: (_pieces: unknown, id: string) =>
        Promise.resolve(id),
      loadPieces: () =>
        Promise.resolve(
          {
            get: () => Promise.resolve(piece),
            runtime: {},
            getSpace: () => "did:key:test-space",
          } as never,
        ),
    });

    const guardPiece = (
      resultValue: unknown,
      pieceCell?: unknown,
      inputValue?: unknown,
    ) => ({
      input: {
        get: (path: (string | number)[]) =>
          Promise.resolve(readPath(inputValue, path)),
        getCell: () => Promise.resolve(guardCell(inputValue)),
      },
      result: {
        get: (path: (string | number)[]) =>
          Promise.resolve(readPath(resultValue, path)),
        getCell: () => Promise.resolve(guardCell(resultValue)),
      },
      ...(pieceCell ? { getCell: () => pieceCell } : {}),
    });

    const config = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: PIECE,
    };

    it("refuses a root verb path, pointing at cf piece call", async () => {
      const deps = guardDeps(guardPiece(RESULT_VALUE));
      const error = await getCellValue(config, ["addItem"], {}, deps)
        .catch((error) => error);
      expect(error).toBeInstanceOf(PieceVerbReadError);
      expect((error as Error).message).toBe(
        `Path resolves to a verb; use 'cf piece call --cell ${PIECE} addItem' instead.`,
      );

      // A root verb on the input cell redirects the same way: the dispatcher
      // resolves result root then input root, so it is callable by name.
      const inputDeps = guardDeps(
        guardPiece(undefined, undefined, { setup: { $stream: true } }),
      );
      await expect(
        getCellValue(config, ["setup"], { input: true }, inputDeps),
      ).rejects.toThrow(/use 'cf piece call/);
    });

    it("classifies a verb path without projecting the whole parent", async () => {
      // Cost, pinned as behavior: this guard runs on every read that carries
      // a selection, so its cost must not depend on what the parent holds.
      // Projecting the parent walks every document a piece result reaches to
      // answer a question about one property. Every parent here refuses
      // `get()` outright, so the guard reaches its verdict only off the child.
      //
      // Both definite signals are put through that: a verb stored as a LINK,
      // where the link-derived cell is what answers as a stream, and a verb
      // stored INLINE, where nothing is link-derived and the child's own
      // stored `{$stream: true}` is the only evidence there is. Both are
      // reached without a parent read at all.
      const refuseParent = () => {
        throw new Error("projected the whole parent");
      };
      const linkedVerb = {
        getRaw: () => ({ "/": "stream-link" }),
        isStream: () => true,
        asSchemaFromLinks: () => linkedVerb,
      };
      const inlineVerb = {
        getRaw: () => ({ $stream: true }),
        isStream: () => false,
        asSchemaFromLinks: () => inlineVerb,
      };
      const pieceWithChild = (child: unknown) => ({
        result: {
          get: () => Promise.resolve(undefined),
          getCell: () =>
            Promise.resolve({ get: refuseParent, key: () => child }),
        },
      });

      for (const child of [linkedVerb, inlineVerb]) {
        const error = await getCellValue(
          config,
          ["addTopic"],
          {},
          guardDeps(pieceWithChild(child)),
        ).catch((error) => error);
        expect(error).toBeInstanceOf(PieceVerbReadError);
        expect((error as Error).message).toContain("cf piece call");
      }

      // And a data field under the same parent still reads: refusing on
      // anything a child merely holds would make every read a refusal.
      const dataChild = {
        getRaw: () => ({ rows: [1, 2, 3] }),
        isStream: () => false,
        asSchemaFromLinks: () => dataChild,
      };
      const read = await getCellValue(
        config,
        ["addTopic"],
        {},
        guardDeps(pieceWithChild(dataChild)),
      ).catch((error) => error);
      expect(read).not.toBeInstanceOf(PieceVerbReadError);
    });

    it("refuses on the stored schema marker even when the value reads empty", async () => {
      // The second definite signal: the link-derived schema answers as a
      // stream while the read value is an empty object (the marker survives
      // in stored links even when the serialization is bare).
      const rootCell = {
        get: () => ({ notify: {} }),
        key: (name: string) => ({
          asSchemaFromLinks: () => ({ isStream: () => name === "notify" }),
        }),
      };
      const piece = {
        input: {
          get: () => Promise.resolve(undefined),
          getCell: () => Promise.resolve(guardCell(undefined)),
        },
        result: {
          get: () => Promise.resolve({}),
          getCell: () => Promise.resolve(rootCell),
        },
      };
      await expect(getCellValue(config, ["notify"], {}, guardDeps(piece)))
        .rejects.toThrow(/use 'cf piece call/);
    });

    it("refuses a nested verb path without suggesting an uncallable command", async () => {
      // `cf piece call` resolves root-level names only, so `cf piece call
      // removeItem` would fail — the refusal must not suggest it. It says
      // why the read refused and where to go instead.
      const deps = guardDeps(guardPiece(RESULT_VALUE));
      const error = await getCellValue(
        config,
        ["nested", "removeItem"],
        {},
        deps,
      ).catch((error) => error);
      expect(error).toBeInstanceOf(PieceVerbReadError);
      expect((error as Error).message).toBe(
        "Path resolves to a verb that is not directly callable: verbs are " +
          "invoked at the piece's root surface. Read the parent object " +
          "instead, or list the callable verbs with " +
          `'cf piece verbs --cell ${PIECE}'.`,
      );
      expect((error as Error).message).not.toContain("cf piece call");
    });

    it("reads a probe-classifiable but marker-less output (fails open)", async () => {
      // The CTS integration shape: a plain data output the forced-stream
      // probe would classify as callable (the cast schema survives
      // resolution, so the probe answers "stream" for it), with no stored
      // marker and no sentinel. The dispatcher and the listing may
      // over-include it — a read guard must not: the read succeeds.
      const pieceCell = {
        asSchema: () => ({
          key: (_name: string) => ({ isStream: () => true }),
        }),
      };
      const deps = guardDeps(
        guardPiece(
          { lastMessage: { text: "hi" }, count: 3 },
          pieceCell,
        ),
      );
      await expect(getCellValue(config, ["lastMessage"], {}, deps))
        .resolves.toEqual({ text: "hi" });
      await expect(getCellValue(config, ["count"], {}, deps)).resolves.toBe(3);
    });

    it("refuses a verb whose result projection also fails", async () => {
      // The shape a real board hits: reading `addTopic` on an unstepped piece
      // fails the result-projection check BEFORE the verb is classified, so
      // the caller was told "use --step" — advice that sends them to re-run a
      // read which can never succeed, because a verb is not a materializable
      // result. The verb refusal has to win over the projection error.
      const verbCell = {
        schema: { type: "object" },
        // The parent stores a link at the name, so that is the child's stored
        // value, and the link-derived cell is what answers as a stream.
        getRaw: () => ({ "/": "stream-link" }),
        isStream: () => true,
        asSchemaFromLinks: () => verbCell,
      };
      const rootCell = {
        schema: {
          type: "object",
          properties: { addTopic: { type: "object" } },
          required: ["addTopic"],
        },
        get: () => ({ addTopic: { "/": "stream-link" } }),
        key: () => verbCell,
      };
      const piece = {
        result: {
          // The read yields nothing: the projection could not materialize it.
          get: () => Promise.resolve(undefined),
          getCell: () => Promise.resolve(rootCell),
        },
      };
      const error = await getCellValue(
        config,
        ["addTopic"],
        {},
        guardDeps(piece),
      )
        .catch((error) => error);
      expect(error).toBeInstanceOf(PieceVerbReadError);
      expect((error as Error).message).toContain("cf piece call");
      expect((error as Error).message).not.toContain("--step");
    });

    it("refuses a verb read through a selection, not a projection error", async () => {
      // The selection path has its own projection-failure exits, so a verb
      // read through --filter/--schema must reach the same refusal: asking a
      // stream to project is the same mistake whichever route it takes.
      const verbCell = {
        schema: { type: "object" },
        // The parent stores a link at the name, so that is the child's stored
        // value, and the link-derived cell is what answers as a stream.
        getRaw: () => ({ "/": "stream-link" }),
        isStream: () => true,
        asSchemaFromLinks: () => verbCell,
      };
      const rootCell = {
        schema: {
          type: "object",
          properties: { addTopic: { type: "object" } },
          required: ["addTopic"],
        },
        get: () => ({ addTopic: { "/": "stream-link" } }),
        key: () => verbCell,
      };
      const piece = {
        result: {
          get: () => Promise.resolve(undefined),
          getCell: () => Promise.resolve(rootCell),
        },
      };
      const deps = guardDeps(piece);
      const options = {
        selection: { filter: parseSelectionFilter(".active") },
      };

      // The selection throws the "Cannot access path" shape a real projection
      // failure raises.
      const thrown = await getCellValue(config, ["addTopic"], options, {
        ...deps,
        deriveSelectedValue: () =>
          Promise.reject(
            new Error('Cannot access path "addTopic" - property not found'),
          ),
      }).catch((error) => error);
      expect(thrown).toBeInstanceOf(PieceVerbReadError);
      expect((thrown as Error).message).toContain("cf piece call");

      // And the same when the selection simply yields nothing.
      const empty = await getCellValue(config, ["addTopic"], options, {
        ...deps,
        deriveSelectedValue: () => Promise.resolve(undefined),
      }).catch((error) => error);
      expect(empty).toBeInstanceOf(PieceVerbReadError);
    });

    it("fails open when classification itself fails", async () => {
      // A cell surface that throws during the guard's walk must never turn
      // a successful read into a refusal: the guard swallows the failure
      // and the value wins.
      const throwingRoot = {
        get: () => ({ field: "ok" }),
        key: () => {
          throw new Error("no traversal surface");
        },
      };
      const piece = {
        input: {
          get: () => Promise.resolve(undefined),
          getCell: () => Promise.resolve(guardCell(undefined)),
        },
        result: {
          get: () => Promise.resolve("ok"),
          getCell: () => Promise.resolve(throwingRoot),
        },
      };
      await expect(getCellValue(config, ["field"], {}, guardDeps(piece)))
        .resolves.toBe("ok");
    });

    it("still reads plain data, tool bindings, and a verb's parent object", async () => {
      const deps = guardDeps(
        guardPiece(RESULT_VALUE, undefined, { config: { retries: 2 } }),
      );
      await expect(getCellValue(config, ["title"], {}, deps)).resolves.toBe(
        "Groceries",
      );
      await expect(getCellValue(config, ["nested", "list"], {}, deps))
        .resolves.toEqual(["milk"]);
      await expect(
        getCellValue(config, ["config"], { input: true }, deps),
      ).resolves.toEqual({ retries: 2 });
      // A tool binding reads as data — the llm-dialog read tool reads tools
      // too; only streams have a serialization no reader wants.
      await expect(getCellValue(config, ["search"], {}, deps)).resolves
        .toEqual(RESULT_VALUE.search);
      // Only the path that lands ON the verb refuses: its parent object —
      // named or the path-less full result — keeps reading, verbs included.
      await expect(getCellValue(config, ["nested"], {}, deps)).resolves
        .toEqual(RESULT_VALUE.nested);
      await expect(getCellValue(config, [], {}, deps)).resolves.toEqual(
        RESULT_VALUE,
      );
    });

    it("renders an unshaped parent read without stream runtime internals", async () => {
      const signer = await Identity.fromPassphrase("piece-get-live-stream");
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });

      try {
        const tx = runtime.edit();
        // Nothing is stored where the stream stands; the schema declares it.
        const cell = runtime.getCell<{ name: string }>(
          signer.did(),
          "piece-get-live-stream",
          undefined,
          tx,
        );
        cell.set({ name: "Ada" });
        const schema = {
          type: "object",
          properties: {
            name: { type: "string" },
            submit: { type: "object", asCell: ["stream"] },
          },
        } as const satisfies JSONSchema;
        await tx.commit();
        await runtime.idle();
        const value = cell.asSchema(schema).get();
        const submit = value.submit;
        expect(isCell(submit)).toBe(true);
        const expectedLink = (submit as unknown as { toJSON(): unknown })
          .toJSON();

        const read = await getCellValue(
          config,
          [],
          {},
          guardDeps({ result: { get: () => Promise.resolve(value) } }),
        );
        const json = safeStringify(read);

        expect(json.length).toBeLessThan(2000);
        expect(json).not.toContain("scheduler");
        expect(json).not.toContain("circular reference");
        expect(json).not.toContain('"runtime"');
        expect(JSON.parse(json)).toEqual({
          name: "Ada",
          submit: expectedLink,
        });
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  it("rejects repository metadata when resetting the home pattern", async () => {
    // The test mutates the command's error handling, so it needs a copy of its
    // own; the query string is what makes the copy.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { piece: command } = await import(
      "../commands/piece.ts?repository-reset-test"
    );
    command.throwErrors();
    await expect(command.parse([
      "set-home",
      "--reset",
      "--repository",
      "https://github.com/commonfabric/labs",
    ])).rejects.toThrow("Cannot use --repository with --reset");
  });

  it("rejects attached tests when resetting the home pattern", async () => {
    // The test mutates the command's error handling, so it needs a copy of its
    // own; the query string is what makes the copy.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { piece: command } = await import(
      "../commands/piece.ts?test-reset-test"
    );
    command.throwErrors();
    await expect(command.parse([
      "set-home",
      "--reset",
      "--test",
      "/repo/home.test.tsx",
    ])).rejects.toThrow("Cannot use --test with --reset");
  });

  it("rejects attached data files when resetting the home pattern", async () => {
    // The test mutates the command's error handling, so it needs a copy of its
    // own; the query string is what makes the copy.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const { piece: command } = await import(
      "../commands/piece.ts?test-reset-datafile"
    );
    command.throwErrors();
    await expect(command.parse([
      "set-home",
      "--reset",
      "--datafile",
      "/repo/data/cities.json",
    ])).rejects.toThrow("Cannot use --datafile with --reset");
  });

  it("builds repository-aware entries from deployment flags", () => {
    expect(localPatternEntry("/repo/pattern.tsx", {
      mainExport: "named",
      repository: "https://github.com/commonfabric/labs",
      root: "/repo",
      test: ["/repo/pattern.test.tsx", "/repo/other.test.tsx"],
      datafile: ["/repo/data/cities.json"],
    })).toEqual({
      mainPath: "/repo/pattern.tsx",
      mainExport: "named",
      repository: "https://github.com/commonfabric/labs",
      rootPath: "/repo",
      testPaths: ["/repo/pattern.test.tsx", "/repo/other.test.tsx"],
      dataFilePaths: ["/repo/data/cities.json"],
    });
  });

  it("forwards the dangerous override through setsrc command behavior", async () => {
    let forwarded: unknown;
    const applied = {
      status: "committed" as const,
      ref: { identity: "B".repeat(43), symbol: "default" },
      revisionId: "revision-2",
      detachedOrigin: null,
      space: SPACE_DID,
      seq: 12,
      refresh: { status: "completed" as const },
    };
    const { config, update } = await setPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        cell: PIECE,
        mainExport: "named",
        repository: "https://github.com/commonfabric/labs",
        root: "/repo",
        test: ["/repo/pattern.test.tsx"],
        dangerouslyAllowIncompatibleSchema: true,
      },
      "/repo/pattern.tsx",
      {
        setPiecePattern: (config, entry, options) => {
          forwarded = { config, entry, options };
          return Promise.resolve(applied);
        },
      },
    );

    expect(config).toEqual({
      apiUrl: API_URL,
      space: SPACE,
      identity: "/tmp/test.key",
      piece: PIECE,
    });
    expect(update).toEqual(applied);
    expect(forwarded).toEqual({
      config,
      entry: {
        mainPath: "/repo/pattern.tsx",
        mainExport: "named",
        repository: "https://github.com/commonfabric/labs",
        rootPath: "/repo",
        testPaths: ["/repo/pattern.test.tsx"],
      },
      options: { dangerouslyAllowIncompatibleSchema: true },
    });
  });

  it("prints the committed pattern pointer and revision in the setsrc success line", () => {
    expect(setsrcSuccessLine(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        piece: PIECE,
      },
      {
        status: "committed",
        ref: { identity: "B".repeat(43), symbol: "default" },
        revisionId: "revision-2",
        detachedOrigin: null,
        space: SPACE_DID,
        seq: 12,
        refresh: { status: "completed" },
      },
    )).toBe(
      `Committed source update for piece ${PIECE} ` +
        `(Pattern Ref: cf:module/${"B".repeat(43)}#default, ` +
        `Revision: revision-2, Seq: 12)`,
    );
  });

  it("renders the setsrc transaction receipt returned by the apply", async () => {
    const applied = {
      status: "committed" as const,
      ref: { identity: "B".repeat(43), symbol: "default" },
      revisionId: "revision-2",
      detachedOrigin: null,
      space: SPACE_DID,
      seq: 12,
      refresh: { status: "completed" as const },
    };
    const rendered: string[] = [];
    const warned: string[] = [];
    const hinted: string[] = [];
    const exitCodes: number[] = [];

    await applyPieceSourceCommandAction(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        cell: PIECE,
      },
      "/repo/pattern.tsx",
      {
        setPieceSourceFromCommand: (options, mainPath) => {
          expect(mainPath).toBe("/repo/pattern.tsx");
          return Promise.resolve({
            config: parsePieceOptions(options),
            update: applied,
          });
        },
        render: (message) => rendered.push(message),
        warn: (message) => warned.push(message),
        hint: (message) => hinted.push(message),
        setExitCode: (code) => exitCodes.push(code),
      },
    );

    expect(rendered).toEqual([
      `Committed source update for piece ${PIECE} ` +
      `(Pattern Ref: cf:module/${"B".repeat(43)}#default, ` +
      `Revision: revision-2, Seq: 12)`,
    ]);
    expect(warned).toEqual([]);
    expect(exitCodes).toEqual([]);
    expect(hinted).toHaveLength(1);
    expect(hinted[0]).toContain(`${API_URL}/${SPACE}/${PIECE}`);
  });

  it("reports a setsrc refresh failure and exits nonzero", async () => {
    // A refresh failure does not undo the commit, so the command still
    // reports what committed while returning a failing process status. Both
    // halves matter: the warning alone loses the durable receipt, while exit 0
    // lets an automation mistake the source commit for a healthy deploy.
    const update = {
      status: "committed" as const,
      ref: { identity: "B".repeat(43), symbol: "default" },
      revisionId: "revision-2",
      detachedOrigin: null,
      space: SPACE_DID,
      seq: 12,
      refresh: {
        status: "failed" as const,
        warning: "dependency unavailable",
      },
    };
    const rendered: string[] = [];
    const warned: string[] = [];
    const hinted: string[] = [];
    const exitCodes: number[] = [];

    await applyPieceSourceCommandAction(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        cell: PIECE,
      },
      "/repo/pattern.tsx",
      {
        setPieceSourceFromCommand: () =>
          Promise.resolve({
            config: {
              apiUrl: API_URL,
              space: SPACE,
              identity: "/tmp/test.key",
              piece: PIECE,
            },
            update,
          }),
        render: (message) => rendered.push(message),
        warn: (message) => warned.push(message),
        hint: (message) => hinted.push(message),
        setExitCode: (code) => exitCodes.push(code),
      },
    );

    expect(rendered).toEqual([
      `Committed source update for piece ${PIECE} ` +
      `(Pattern Ref: cf:module/${"B".repeat(43)}#default, ` +
      `Revision: revision-2, Seq: 12)`,
    ]);
    expect(warned).toEqual([
      `Source revision revision-2 committed as ` +
      `cf:module/${"B".repeat(43)}#default at seq 12, but refreshing the ` +
      `running ` +
      `piece failed: dependency unavailable`,
    ]);
    expect(hinted).toHaveLength(1);
    expect(hinted[0]).toContain("this deploy is not healthy");
    expect(hinted[0]).toContain("cf piece render");
    expect(exitCodes).toEqual([1]);
  });

  it("sends the setsrc refresh warning to stderr", async () => {
    // The success line goes to stdout and the warning must not, or a caller
    // redirecting stdout to a log keeps the receipt and loses the warning
    // silently. Asserted against the real default sink rather than an
    // injected one, since the default is the thing that can regress.
    const errors: string[] = [];
    const originalError = console.error;
    const originalExitCode = Deno.exitCode;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    Deno.exitCode = 0;

    try {
      await applyPieceSourceCommandAction(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: "/tmp/test.key",
          cell: PIECE,
        },
        "/repo/pattern.tsx",
        {
          setPieceSourceFromCommand: () =>
            Promise.resolve({
              config: {
                apiUrl: API_URL,
                space: SPACE,
                identity: "/tmp/test.key",
                piece: PIECE,
              },
              update: {
                status: "committed" as const,
                ref: { identity: "B".repeat(43), symbol: "default" },
                revisionId: "revision-2",
                detachedOrigin: null,
                space: SPACE_DID,
                seq: 12,
                refresh: {
                  status: "failed" as const,
                  warning: "dependency unavailable",
                },
              },
            }),
          render: () => {},
          hint: () => {},
        },
      );
      expect(Deno.exitCode).toBe(1);
    } finally {
      console.error = originalError;
      Deno.exitCode = originalExitCode;
    }

    expect(errors.filter((line) => line.includes("refreshing the running")))
      .toHaveLength(1);
  });

  it("prints no setsrc receipt when the update fails to commit", async () => {
    // A commit failure is the case the receipt exists for: the action must
    // report nothing that reads as success and must let the failure out, which
    // is what `cf`'s top-level handler turns into a non-zero exit.
    const rendered: string[] = [];
    const warned: string[] = [];
    const hinted: string[] = [];

    await expect(applyPieceSourceCommandAction(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        cell: PIECE,
      },
      "/repo/pattern.tsx",
      {
        setPieceSourceFromCommand: () =>
          Promise.reject(new Error("commit refused by storage")),
        render: (message) => rendered.push(message),
        warn: (message) => warned.push(message),
        hint: (message) => hinted.push(message),
      },
    )).rejects.toThrow("commit refused by storage");

    expect(rendered).toEqual([]);
    expect(warned).toEqual([]);
    expect(hinted).toEqual([]);
  });

  it("propagates a setsrc failure before the setup transaction commits", async () => {
    await expect(setPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        cell: PIECE,
      },
      "/repo/pattern.tsx",
      {
        setPiecePattern: () =>
          Promise.reject(
            new Error(
              "piece pattern changed while the source update was compiling",
            ),
          ),
      },
    )).rejects.toThrow(
      "piece pattern changed while the source update was compiling",
    );
  });

  it("aims the setsrc preflight at the same piece and entry the apply would use", async () => {
    // A preflight that resolves a different target than the apply is worse
    // than none, so the check parses the same options and hands the same entry
    // down. It must also apply nothing — no `setPiecePattern` here at all.
    let checked: unknown;
    const { config, report, summary } = await checkPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        cell: PIECE,
        mainExport: "named",
        repository: "https://github.com/commonfabric/labs",
        root: "/repo",
        test: ["/repo/pattern.test.tsx"],
      },
      "/repo/pattern.tsx",
      {
        checkPiecePattern: (config, entry) => {
          checked = { config, entry };
          return Promise.resolve({
            compatible: true,
            issues: {},
            candidate: { identity: "A".repeat(43), symbol: "default" },
          });
        },
      },
    );

    expect(report.compatible).toBe(true);
    expect(summary).toContain("can replace the source");
    expect(checked).toEqual({
      config,
      entry: {
        mainPath: "/repo/pattern.tsx",
        mainExport: "named",
        repository: "https://github.com/commonfabric/labs",
        rootPath: "/repo",
        testPaths: ["/repo/pattern.test.tsx"],
      },
    });
  });

  it("fails the setsrc preflight loudly enough to gate a script", async () => {
    // `--check` is meant to sit in front of a deploy, so a refusal has to be a
    // non-zero exit and not just prose on stdout — and it has to carry the
    // rules' own reason so the operator knows what to fix. It reports as a
    // data error (plain stderr + exit 1), not a Cliffy ValidationError, so
    // the verdict is not buried under a usage screen.
    const printed: string[] = [];
    let exitCode: number | undefined;
    class ExitSentinel extends Error {}
    await expect(checkPieceSourceFromCommand(
      {
        apiUrl: API_URL,
        space: SPACE,
        identity: "/tmp/test.key",
        cell: PIECE,
      },
      "/repo/pattern.tsx",
      {
        checkPiecePattern: () =>
          Promise.resolve({
            compatible: false,
            issues: { schema: "result narrowed: label" },
            message: "result narrowed: label",
            candidate: { identity: "D".repeat(43), symbol: "default" },
          }),
        exit: {
          printError: (message) => printed.push(message),
          exit: (code) => {
            exitCode = code;
            throw new ExitSentinel();
          },
        },
      },
    )).rejects.toThrow(ExitSentinel);

    expect(exitCode).toBe(1);
    expect(printed.join("\n")).toContain("cannot replace the source");
    expect(printed.join("\n")).toContain("result narrowed: label");
  });

  it("lists pattern provenance and isolates unreadable pieces", async () => {
    const patternRef = {
      identity: "A".repeat(43),
      symbol: "default",
      source: {
        ref: `cf:pattern:${"A".repeat(43)}`,
        repository: "https://github.com/commonfabric/labs",
        entry: "/notes/note.tsx",
      },
    };
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([
          { id: "of:readable" },
          { id: "of:unreadable" },
        ]),
      get: (id: string) =>
        id === "of:unreadable"
          ? Promise.reject(new Error("not readable"))
          : Promise.resolve({
            getCell: () => ({
              key: () => ({ pull: () => Promise.resolve("Readable") }),
            }),
            getPatternRef: () => Promise.resolve(patternRef),
          }),
    };

    const listed = await listPieces({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
    }, {
      loadPieces: () => Promise.resolve(controller as any),
    });

    expect(listed).toEqual([
      { id: "of:readable", name: "Readable", patternRef },
      { id: "of:unreadable", error: "not readable" },
    ]);
  });

  it("searches nested input and result data without matching metadata", async () => {
    const patternRef = {
      identity: "S".repeat(43),
      symbol: "default",
      source: { ref: `cf:pattern:${"S".repeat(43)}` },
    };
    const cyclicInput: Record<string, unknown> = {
      nested: { message: "A NeEdLe in the input" },
    };
    cyclicInput.self = cyclicInput;
    class InternalObject {
      needleInternalField = "not piece data";
    }
    const fabricHash = new FabricHash(
      new Uint8Array([1, 2, 3, 4]),
      "fid1",
    );

    const searchablePiece = (
      id: string,
      name: string,
      input: unknown,
      result: unknown,
    ) => {
      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      return {
        id,
        name: () => name,
        getPatternRef: () => Promise.resolve(patternRef),
        input: { getCell: () => Promise.resolve(cell(input)) },
        result: { getCell: () => Promise.resolve(cell(result)) },
      };
    };
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([
          searchablePiece(
            "of:input-match",
            "Input match",
            cyclicInput,
            {},
          ),
          searchablePiece(
            "of:key-match",
            "Key match",
            {},
            { nested: { needleStatus: false } },
          ),
          searchablePiece(
            "of:needle-metadata-only",
            "Needle appears only in metadata",
            { content: "haystack" },
            { $NAME: "Needle appears only in metadata" },
          ),
          searchablePiece(
            "of:class-internals",
            "Class internals",
            new InternalObject(),
            {},
          ),
          searchablePiece(
            "of:internal-symbol",
            "Internal symbol metadata",
            {
              [Symbol("internal metadata")]:
                "Needle in internal identity metadata",
            },
            {},
          ),
          searchablePiece(
            "of:fabric-special-object",
            "Fabric special object",
            new FabricError({
              type: "Error",
              name: "Error",
              message: "Needle in encoded Fabric data",
              stack: undefined,
              cause: undefined,
            }),
            {},
          ),
          searchablePiece(
            "of:fabric-hash",
            "Fabric hash",
            fabricHash,
            {},
          ),
        ]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
    };

    const matches = await searchPieces(config, "NEEDLE", deps);

    expect(matches).toEqual([
      { id: "of:input-match", name: "Input match", patternRef },
      { id: "of:key-match", name: "Key match", patternRef },
      {
        id: "of:fabric-special-object",
        name: "Fabric special object",
        patternRef,
      },
    ]);
    expect(await searchPieces(config, fabricHash.toString(), deps)).toEqual([{
      id: "of:fabric-hash",
      name: "Fabric hash",
      patternRef,
    }]);
  });

  it("searches scalar data and rejects an empty query", async () => {
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([{
          id: "of:number-match",
          name: () => "Number match",
          getPatternRef: () => Promise.resolve(undefined),
          input: { getCell: () => Promise.resolve(cell(2048)) },
          result: { getCell: () => Promise.resolve(cell(null)) },
        }]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
    };

    expect(await searchPieces(config, "048", deps)).toEqual([{
      id: "of:number-match",
      name: "Number match",
      patternRef: undefined,
    }]);
    await expect(searchPieces(config, "", deps)).rejects.toThrow(
      "Search query must not be empty.",
    );
  });

  it("searches named array properties and skips result metadata", async () => {
    const input: unknown[] = ["ordinary array value"];
    Object.defineProperty(input, "annotation", {
      enumerable: true,
      value: "needle in a named array property",
    });
    const result: unknown[] = [];
    Object.defineProperty(result, "$NAME", {
      enumerable: true,
      value: "needle only in ignored result metadata",
    });
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([{
          id: "of:named-array-property",
          name: () => "Named array property",
          getPatternRef: () => Promise.resolve(undefined),
          input: { getCell: () => Promise.resolve(cell(input)) },
          result: { getCell: () => Promise.resolve(cell(result)) },
        }]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
    };

    expect(
      await searchPieces(config, "named array property", deps),
    ).toEqual([{
      id: "of:named-array-property",
      name: "Named array property",
      patternRef: undefined,
    }]);
    expect(
      await searchPieces(config, "ignored result metadata", deps),
    ).toEqual([]);
  });

  it("reports unreadable iterators, cell proxies, and `FabricValue`s", async () => {
    const iteratorError = new Error("array keys are not readable");
    const unreadableArray = new Proxy<unknown[]>([], {
      ownKeys: () => {
        throw iteratorError;
      },
    });
    const cellProxyError = new Error("cell proxy lost its backing cell");
    const unreadableCellProxy = {
      [toCell]: () => {
        throw cellProxyError;
      },
    };
    const stringError = new Error("Fabric string representation unavailable");
    class UnrepresentableFabricValue extends BaseFabricSpecialObject {
      override toString(): string {
        throw stringError;
      }
    }
    const fabricValue = new UnrepresentableFabricValue();
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const piece = (id: string, input: unknown) => ({
      id,
      name: () => id,
      getPatternRef: () => Promise.resolve(undefined),
      input: { getCell: () => Promise.resolve(cell(input)) },
      result: { getCell: () => Promise.resolve(cell({})) },
    });
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([
          piece("of:unreadable-array-iterator", unreadableArray),
          piece("of:unreadable-cell-proxy", unreadableCellProxy),
          piece("of:unrepresentable-fabric-value", fabricValue),
        ]),
    };
    const errors: unknown[] = [];

    expect(
      await searchPieces(
        { apiUrl: API_URL, space: SPACE, identity: ID },
        "absent search value",
        {
          loadPieces: () => Promise.resolve(controller as any),
          reportSearchError: (_pieceId, _source, error) => errors.push(error),
        },
      ),
    ).toEqual([]);
    expect(errors).toContain(iteratorError);
    expect(errors).toContain(cellProxyError);
    expect(errors).toContain(stringError);
    expect(errors.map(String).some((error) => error.includes("no `[CODEC]`")))
      .toBe(true);
  });

  it("warns when input and result data cannot be read", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
    try {
      const controller = {
        getRegisteredPieces: () =>
          Promise.resolve([{
            id: "of:unreadable-data",
            name: () => "Unreadable data",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.reject(new Error("input unavailable")),
            },
            result: {
              getCell: () => Promise.reject("result unavailable"),
            },
          }]),
      };

      expect(
        await searchPieces(
          { apiUrl: API_URL, space: SPACE, identity: ID },
          "needle",
          {
            loadPieces: () => Promise.resolve(controller as any),
          },
        ),
      ).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).toEqual([
      "Warning: Could not read input data for piece of:unreadable-data: input unavailable",
      "Warning: Could not read result data for piece of:unreadable-data: result unavailable",
    ]);
  });

  it("returns a match when its metadata cannot be read", async () => {
    const nameError = new Error("piece name unavailable");
    const patternError = new Error("pattern reference unavailable");
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([{
          id: "of:unreadable-metadata",
          name: () => {
            throw nameError;
          },
          getPatternRef: () => Promise.reject(patternError),
          input: { getCell: () => Promise.resolve(cell("needle")) },
          result: { getCell: () => Promise.resolve(cell({})) },
        }]),
    };
    const errors: Array<{ source: string; error: unknown }> = [];

    expect(
      await searchPieces(
        { apiUrl: API_URL, space: SPACE, identity: ID },
        "needle",
        {
          loadPieces: () => Promise.resolve(controller as any),
          reportSearchError: (_pieceId, source, error) =>
            errors.push({ source, error }),
        },
      ),
    ).toEqual([{
      id: "of:unreadable-metadata",
      name: undefined,
      patternRef: undefined,
    }]);
    expect(errors).toEqual([
      { source: "metadata", error: nameError },
      { source: "metadata", error: patternError },
    ]);
  });

  it("uses full Unicode case folding and canonical normalization", async () => {
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const piece = (id: string, input: unknown) => ({
      id,
      name: () => id,
      getPatternRef: () => Promise.resolve(undefined),
      input: { getCell: () => Promise.resolve(cell(input)) },
      result: { getCell: () => Promise.resolve(cell({})) },
    });
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([
          piece("of:full-fold", "Maße"),
          piece("of:canonical-equivalence", "café"),
          piece("of:indic-substring", "क्ष"),
          piece("of:unicode-17", "\u{16EA0}"),
          piece("of:unrelated", "needle"),
        ]),
    };
    const config = { apiUrl: API_URL, space: SPACE, identity: ID };
    const deps = {
      loadPieces: () => Promise.resolve(controller as any),
    };

    expect(await searchPieces(config, "MASSE", deps)).toEqual([{
      id: "of:full-fold",
      name: "of:full-fold",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "CAFE\u0301", deps)).toEqual([{
      id: "of:canonical-equivalence",
      name: "of:canonical-equivalence",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "\u{16EBB}", deps)).toEqual([{
      id: "of:unicode-17",
      name: "of:unicode-17",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "ष", deps)).toEqual([{
      id: "of:indic-substring",
      name: "of:indic-substring",
      patternRef: undefined,
    }]);
    expect(await searchPieces(config, "s", deps)).toEqual([]);
    expect(await searchPieces(config, "CAFE", deps)).toEqual([]);
  });

  it("materializes nested runtime cells without searching cell internals", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search nested cell test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const nestedSchema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const inputSchema = {
        type: "object",
        properties: {
          nested: { ...nestedSchema, asCell: ["cell"] },
          hidden: { ...nestedSchema, asCell: ["opaque"] },
        },
        required: ["nested", "hidden"],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const nested = runtime.getCell(
        space,
        "piece-search-nested-visible",
        nestedSchema,
        tx,
      );
      nested.set({ text: "needle in a nested runtime cell" });
      const hidden = runtime.getCell(
        space,
        "piece-search-nested-hidden",
        nestedSchema,
        tx,
      );
      hidden.set({ text: "opaque-search-secret" });
      const input = runtime.getCell(
        space,
        "piece-search-input",
        inputSchema,
        tx,
      );
      input.set({ nested, hidden });
      const result = runtime.getCell(
        space,
        "piece-search-result",
        undefined,
        tx,
      );
      result.set({ $NAME: "needle only in the piece name" });
      await tx.commit();
      await runtime.idle();

      const inputValue = await input.pull();
      expect(isCell(inputValue.nested)).toBe(true);
      if (!isCell(inputValue.nested)) {
        throw new Error("Expected nested input data to remain a Cell");
      }
      expect(await inputValue.nested.pull()).toEqual({
        text: "needle in a nested runtime cell",
      });

      const controller = {
        getRegisteredPieces: () =>
          Promise.resolve([{
            id: "of:runtime-cell-piece",
            name: () => "needle only in the piece name",
            getPatternRef: () => Promise.resolve(undefined),
            input: { getCell: () => Promise.resolve(input) },
            result: { getCell: () => Promise.resolve(result) },
          }]),
      };
      const config = { apiUrl: API_URL, space: SPACE, identity: ID };
      const deps = {
        loadPieces: () => Promise.resolve(controller as any),
      };

      expect(await searchPieces(config, "nested runtime", deps)).toEqual([{
        id: "of:runtime-cell-piece",
        name: "needle only in the piece name",
        patternRef: undefined,
      }]);
      expect(await searchPieces(config, "opaque-search-secret", deps)).toEqual(
        [],
      );
      expect(await searchPieces(config, "_link", deps)).toEqual([]);
      expect(await searchPieces(config, "unique to the context", deps))
        .toEqual([]);
      expect(await searchPieces(config, "piece name", deps)).toEqual([]);

      const narrowView = runtime.getCell(
        space,
        "piece-search-nested-visible",
        {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      );
      const wideView = runtime.getCell(
        space,
        "piece-search-nested-visible",
        nestedSchema,
      );
      const viewController = {
        getRegisteredPieces: () =>
          Promise.resolve([{
            id: "of:multiple-runtime-cell-views",
            name: () => "Multiple runtime cell views",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () =>
                Promise.resolve({
                  pull: () => Promise.resolve([narrowView, wideView]),
                }),
            },
            result: {
              getCell: () =>
                Promise.resolve({ pull: () => Promise.resolve({}) }),
            },
          }]),
      };
      expect(
        await searchPieces(config, "nested runtime cell", {
          loadPieces: () => Promise.resolve(viewController as any),
        }),
      ).toEqual([{
        id: "of:multiple-runtime-cell-views",
        name: "Multiple runtime cell views",
        patternRef: undefined,
      }]);

      const brokenNested = runtime.getCell(
        space,
        "piece-search-broken-nested",
        nestedSchema,
      );
      Object.defineProperty(brokenNested, "pull", {
        value: () => Promise.reject(new Error("nested cell unavailable")),
      });
      const nestedErrors: unknown[] = [];
      const partialController = {
        getRegisteredPieces: () =>
          Promise.resolve([{
            id: "of:partial-runtime-cell-piece",
            name: () => "Partial runtime cell piece",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () =>
                Promise.resolve({
                  pull: () =>
                    Promise.resolve([
                      brokenNested,
                      "surviving nested cell data",
                    ]),
                }),
            },
            result: {
              getCell: () =>
                Promise.resolve({ pull: () => Promise.resolve({}) }),
            },
          }]),
      };
      expect(
        await searchPieces(config, "surviving nested", {
          loadPieces: () => Promise.resolve(partialController as any),
          reportSearchError: (_pieceId, _source, error) =>
            nestedErrors.push(error),
        }),
      ).toEqual([{
        id: "of:partial-runtime-cell-piece",
        name: "Partial runtime cell piece",
        patternRef: undefined,
      }]);
      expect(nestedErrors).toEqual([new Error("nested cell unavailable")]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("attributes linked data to its owner and preserves ownerless data", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search linked cell owner test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const sharedSchema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const scalarSchema = { type: "string" } as const;
      const emptySchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const;
      const inputSchema = {
        type: "object",
        properties: {
          sharedCell: { ...sharedSchema, asCell: ["cell"] },
          sharedValue: sharedSchema,
          sharedScalar: scalarSchema,
          ownerlessCell: { ...sharedSchema, asCell: ["cell"] },
          ownerlessValue: sharedSchema,
          unregisteredPieceValue: sharedSchema,
          unregisteredKeylessValue: sharedSchema,
        },
        required: [
          "sharedCell",
          "sharedValue",
          "sharedScalar",
          "ownerlessCell",
          "ownerlessValue",
          "unregisteredPieceValue",
          "unregisteredKeylessValue",
        ],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const sharedCell = runtime.getCell(
        space,
        "piece-search-owned-cell-data",
        sharedSchema,
        tx,
      );
      const sharedValue = runtime.getCell(
        space,
        "piece-search-owned-proxy-data",
        sharedSchema,
        tx,
      );
      const sharedScalar = runtime.getCell(
        space,
        "piece-search-owned-scalar-data",
        scalarSchema,
        tx,
      );
      const ownerlessCell = runtime.getCell(
        space,
        "piece-search-ownerless-cell-data",
        sharedSchema,
        tx,
      );
      const ownerlessValue = runtime.getCell(
        space,
        "piece-search-ownerless-proxy-data",
        sharedSchema,
        tx,
      );
      const unregisteredPieceValue = runtime.getCell(
        space,
        "piece-search-unregistered-piece-data",
        sharedSchema,
        tx,
      );
      const unregisteredKeylessValue = runtime.getCell(
        space,
        "piece-search-unregistered-keyless-data",
        sharedSchema,
        tx,
      );
      const unregisteredKeylessArgument = runtime.getCell(
        space,
        "piece-search-unregistered-keyless-argument",
        emptySchema,
        tx,
      );
      const ownerResult = runtime.getCell(
        space,
        "piece-search-owner-result",
        emptySchema,
        tx,
      );
      const ownerInput = runtime.getCell(
        space,
        "piece-search-owner-input",
        inputSchema,
        tx,
      );
      const referrerResult = runtime.getCell(
        space,
        "piece-search-referrer-result",
        emptySchema,
        tx,
      );
      const referrerInput = runtime.getCell(
        space,
        "piece-search-referrer-input",
        inputSchema,
        tx,
      );
      const aliasInput = runtime.getCell(
        space,
        "piece-search-alias-input",
        emptySchema,
        tx,
      );
      const aliasResult = runtime.getCell(
        space,
        "piece-search-alias-result",
        sharedSchema,
        tx,
      );

      sharedCell.set({ text: "explicit ownership match" });
      sharedValue.set({ text: "proxy ownership match" });
      sharedScalar.set("scalar ownership match");
      ownerlessCell.set({ text: "ownerless explicit match" });
      ownerlessValue.set({ text: "ownerless proxy match" });
      unregisteredPieceValue.set({ text: "unregistered piece match" });
      unregisteredPieceValue.setMetaRaw("patternIdentity", {
        identity: "P".repeat(43),
        symbol: "default",
      }, rawMetaWriteAuthorization);
      unregisteredKeylessValue.set({ text: "unregistered keyless match" });
      unregisteredKeylessArgument.set({});
      unregisteredKeylessValue.setMetaRaw(
        "argument",
        unregisteredKeylessArgument.getAsWriteRedirectLink(),
        rawMetaWriteAuthorization,
      );
      ownerResult.set({});
      ownerInput.set({
        sharedCell,
        sharedValue,
        sharedScalar,
        ownerlessCell,
        ownerlessValue,
        unregisteredPieceValue,
        unregisteredKeylessValue,
      });
      referrerResult.set({});
      referrerInput.set({
        sharedCell,
        sharedValue,
        sharedScalar,
        ownerlessCell,
        ownerlessValue,
        unregisteredPieceValue,
        unregisteredKeylessValue,
      });
      aliasInput.set({});
      aliasResult.set(sharedValue);
      setResultCell(sharedCell, ownerResult);
      setResultCell(sharedValue, ownerResult);
      setResultCell(sharedScalar, ownerResult);
      setResultCell(ownerInput, ownerResult);
      setResultCell(ownerResult, referrerResult);
      setResultCell(referrerInput, referrerResult);
      setResultCell(aliasInput, aliasResult);
      await tx.commit();
      await runtime.idle();

      const referrerInputValue = await referrerInput.pull();
      expect(isCell(referrerInputValue.sharedCell)).toBe(true);
      expect(isCellResult(referrerInputValue.sharedValue)).toBe(true);
      expect(referrerInputValue.sharedScalar).toBe("scalar ownership match");
      expect(isCell(referrerInputValue.ownerlessCell)).toBe(true);
      expect(isCellResult(referrerInputValue.ownerlessValue)).toBe(true);
      expect(isCellResult(referrerInputValue.unregisteredPieceValue)).toBe(
        true,
      );
      expect(isCellResult(referrerInputValue.unregisteredKeylessValue)).toBe(
        true,
      );
      const linkedValueCell = getCellOrThrow(referrerInputValue.sharedValue);
      expect(pieceId(linkedValueCell)).toBe(pieceId(referrerInput));
      expect(pieceId(linkedValueCell.resolveAsCell())).toBe(
        pieceId(sharedValue),
      );

      const ownerId = pieceId(ownerResult);
      const referrerId = pieceId(referrerResult);
      const aliasId = pieceId(aliasResult);
      if (
        ownerId === undefined || referrerId === undefined ||
        aliasId === undefined
      ) {
        throw new Error("Expected result cells to have piece IDs");
      }
      const piece = (
        id: string,
        name: string,
        input: Cell<unknown>,
        result: Cell<unknown>,
      ) => ({
        id,
        name: () => name,
        getPatternRef: () => Promise.resolve(undefined),
        input: { getCell: () => Promise.resolve(input) },
        result: { getCell: () => Promise.resolve(result) },
      });
      const controller = {
        getRegisteredPieces: () =>
          Promise.resolve([
            piece(referrerId, "Referrer", referrerInput, referrerResult),
            piece(aliasId, "Top-level alias", aliasInput, aliasResult),
            piece(ownerId, "Owner", ownerInput, ownerResult),
          ]),
      };
      const config = { apiUrl: API_URL, space: SPACE, identity: ID };
      const deps = {
        loadPieces: () => Promise.resolve(controller as any),
      };

      expect(
        await searchPieces(config, "explicit ownership", deps),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      expect(
        await searchPieces(config, "proxy ownership", deps),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      expect(
        await searchPieces(config, "scalar ownership", deps),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      const referrerAndOwner = [
        { id: referrerId, name: "Referrer", patternRef: undefined },
        { id: ownerId, name: "Owner", patternRef: undefined },
      ];
      expect(
        await searchPieces(config, "ownerless explicit", deps),
      ).toEqual(referrerAndOwner);
      expect(
        await searchPieces(config, "ownerless proxy", deps),
      ).toEqual(referrerAndOwner);
      expect(
        await searchPieces(config, "unregistered piece", deps),
      ).toEqual([]);
      expect(
        await searchPieces(config, "unregistered keyless", deps),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("deduplicates cells and rejects values whose owner cannot be read", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search traversal edge coverage test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const textSchema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const emptySchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const;
      const rootSchema = {
        type: "object",
        properties: { field: { type: "string" } },
        required: ["field"],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const repeatedCell = runtime.getCell(
        space,
        "piece-search-repeated-cell",
        textSchema,
        tx,
      );
      repeatedCell.set({ text: "repeated cell haystack" });
      const repeatedProxySource = runtime.getCell(
        space,
        "piece-search-repeated-proxy",
        textSchema,
        tx,
      );
      repeatedProxySource.set({ text: "repeated proxy haystack" });
      const ownedProxySource = runtime.getCell(
        space,
        "piece-search-owned-proxy-coverage",
        textSchema,
        tx,
      );
      ownedProxySource.set({ text: "owned proxy coverage needle" });
      const ownerResult = runtime.getCell(
        space,
        "piece-search-owner-result-coverage",
        emptySchema,
        tx,
      );
      ownerResult.set({});
      setResultCell(ownedProxySource, ownerResult);

      const brokenRoot = runtime.getCell(
        space,
        "piece-search-broken-source-root",
        rootSchema,
        tx,
      );
      brokenRoot.set({ field: "unreachable source value" });
      const brokenSource = runtime.getCell(
        space,
        "piece-search-broken-source-child",
        { type: "string" },
        tx,
      );
      brokenSource.set("unreachable source value");
      await tx.commit();
      await runtime.idle();

      const sourceError = new Error("source ownership unavailable");
      let repeatedCellPulls = 0;
      const repeatedCellView = new Proxy(repeatedCell, {
        get(target, property) {
          if (property === "pull") {
            return async () => {
              repeatedCellPulls++;
              return await target.pull();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let repeatedProxyMaterializations = 0;
      const repeatedProxyCellView = new Proxy(repeatedProxySource, {
        get(target, property) {
          if (property === "asSchema") {
            return (schema?: JSONSchema) => {
              repeatedProxyMaterializations++;
              return target.asSchema(schema);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const brokenSourceView = new Proxy(brokenSource, {
        get(target, property) {
          if (property === "resolveAsCell") {
            return () => {
              throw sourceError;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const brokenRootView = new Proxy(brokenRoot, {
        get(target, property) {
          if (property === "key") {
            return () => brokenSourceView;
          }
          if (property === "pull") {
            return () => Promise.resolve({ field: "unreachable source value" });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const ownerId = pieceId(ownerResult);
      if (ownerId === undefined) {
        throw new Error("Expected the owner result to have a piece ID");
      }
      const repeatedProxy = {
        [toCell]: () => repeatedProxyCellView,
      };
      const ownedProxy = ownedProxySource.getAsQueryResult();
      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      const piece = (id: string, name: string, input: unknown) => ({
        id,
        name: () => name,
        getPatternRef: () => Promise.resolve(undefined),
        input: { getCell: () => Promise.resolve(cell(input)) },
        result: { getCell: () => Promise.resolve(cell({})) },
      });
      const controller = {
        getRegisteredPieces: () =>
          Promise.resolve([
            piece("of:owned-proxy-referrer", "Referrer", [ownedProxy]),
            piece(ownerId, "Owner", "owned proxy coverage needle"),
            piece("of:repeated-cell", "Repeated cell", [
              repeatedCellView,
              repeatedCellView,
            ]),
            piece("of:repeated-proxy", "Repeated proxy", [
              repeatedProxy,
              repeatedProxy,
            ]),
            {
              id: "of:broken-source-owner",
              name: () => "Broken source owner",
              getPatternRef: () => Promise.resolve(undefined),
              input: { getCell: () => Promise.resolve(brokenRootView) },
              result: { getCell: () => Promise.resolve(cell({})) },
            },
          ]),
      };
      const errors: Array<{
        pieceId: string;
        source: "input data" | "result data" | "metadata";
        error: unknown;
      }> = [];
      const searchDeps = {
        loadPieces: () => Promise.resolve(controller as any),
        reportSearchError: (
          pieceId: string,
          source: "input data" | "result data" | "metadata",
          error: unknown,
        ) => errors.push({ pieceId, source, error }),
      };

      expect(
        await searchPieces(
          { apiUrl: API_URL, space: SPACE, identity: ID },
          "owned proxy coverage needle",
          searchDeps,
        ),
      ).toEqual([{
        id: ownerId,
        name: "Owner",
        patternRef: undefined,
      }]);
      expect(repeatedCellPulls).toBe(1);
      expect(repeatedProxyMaterializations).toBe(1);
      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.every(({ pieceId, source, error }) =>
          pieceId === "of:broken-source-owner" && source === "input data" &&
          error === sourceError
        ),
      ).toBe(true);

      errors.length = 0;
      expect(
        await searchPieces(
          { apiUrl: API_URL, space: SPACE, identity: ID },
          "unreachable source value",
          searchDeps,
        ),
      ).toEqual([]);
      expect(errors).toContainEqual({
        pieceId: "of:broken-source-owner",
        source: "input data",
        error: sourceError,
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reports cyclic Cell ownership without attributing the data", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search cyclic cell owner test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const space = signer.did();
      const schema = {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      } as const;
      const tx = runtime.edit();
      const first = runtime.getCell(
        space,
        "piece-search-owner-cycle-first",
        schema,
        tx,
      );
      const second = runtime.getCell(
        space,
        "piece-search-owner-cycle-second",
        schema,
        tx,
      );
      first.set({ text: "cyclic ownership match" });
      second.set({ text: "other cycle value" });
      setResultCell(first, second);
      setResultCell(second, first);
      await tx.commit();
      await runtime.idle();

      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      const controller = {
        getRegisteredPieces: () =>
          Promise.resolve([{
            id: "of:cycle-referrer",
            name: () => "Cycle referrer",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(cell({ linked: first })),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          }]),
      };
      const errors: unknown[] = [];

      expect(
        await searchPieces(
          { apiUrl: API_URL, space: SPACE, identity: ID },
          "cyclic ownership",
          {
            loadPieces: () => Promise.resolve(controller as any),
            reportSearchError: (_pieceId, _source, error) => errors.push(error),
          },
        ),
      ).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(String(errors[0])).toContain(
        "Cycle found while resolving piece ownership",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("loads nested cells from a cold runtime before searching them", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search cold runtime test",
    );
    const space = signer.did();
    const server = newLoopbackServer();

    const leafSchema = {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    } as const satisfies JSONSchema;
    const middleSchema = {
      type: "object",
      properties: { leaf: { ...leafSchema, asCell: ["cell"] } },
      required: ["leaf"],
    } as const satisfies JSONSchema;
    const rootSchema = {
      type: "object",
      properties: { middle: { ...middleSchema, asCell: ["cell"] } },
      required: ["middle"],
    } as const satisfies JSONSchema;
    const writerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const writer = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: writerStorage,
    });
    const writeTx = writer.edit();
    const leaf = writer.getCell(
      space,
      "piece-search-cold-leaf",
      leafSchema,
      writeTx,
    );
    const middle = writer.getCell(
      space,
      "piece-search-cold-middle",
      middleSchema,
      writeTx,
    );
    const root = writer.getCell(
      space,
      "piece-search-cold-root",
      rootSchema,
      writeTx,
    );
    leaf.set({ text: "cold-cache-needle" });
    middle.set({ leaf });
    root.set({ middle });
    await writeTx.commit();
    await writerStorage.synced();

    const readerStorage = EmulatedStorageManager.connectTo(server, {
      as: signer,
    });
    const reader = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: readerStorage,
    });
    try {
      const readerRoot = reader.getCell(
        space,
        "piece-search-cold-root",
        rootSchema,
      );
      const empty = reader.getCell(space, "piece-search-cold-empty", true);
      const controller = {
        getRegisteredPieces: () =>
          Promise.resolve([{
            id: "of:cold-runtime-piece",
            name: () => "Cold runtime piece",
            getPatternRef: () => Promise.resolve(undefined),
            input: { getCell: () => Promise.resolve(readerRoot) },
            result: { getCell: () => Promise.resolve(empty) },
          }]),
      };

      expect(
        await searchPieces(
          {
            apiUrl: API_URL,
            space: SPACE,
            identity: ID,
          },
          "cold-cache-needle",
          {
            loadPieces: () => Promise.resolve(controller as any),
          },
        ),
      ).toEqual([{
        id: "of:cold-runtime-piece",
        name: "Cold runtime piece",
        patternRef: undefined,
      }]);
    } finally {
      await reader.dispose();
      await readerStorage.close();
      await writer.dispose();
      await writerStorage.close();
      await server.close();
    }
  });

  it("searches arrays with a large sparse length", async () => {
    const values: unknown[] = [];
    values.length = 0xffff_ffff;
    values[0xffff_fffe] = "large-array-needle";
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([{
          id: "of:large-array",
          name: () => "Large array",
          getPatternRef: () => Promise.resolve(undefined),
          input: { getCell: () => Promise.resolve(cell(values)) },
          result: { getCell: () => Promise.resolve(cell({})) },
        }]),
    };

    expect(
      await searchPieces(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: ID,
        },
        "large-array-needle",
        {
          loadPieces: () => Promise.resolve(controller as any),
        },
      ),
    ).toEqual([{
      id: "of:large-array",
      name: "Large array",
      patternRef: undefined,
    }]);
  });

  it("searches current data after a query proxy changes shape", async () => {
    const signer = await Identity.fromPassphrase(
      "cf piece search stale array proxy test",
    );
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    try {
      const tx = runtime.edit();
      const arrayToObjectSource = runtime.getCell<unknown>(
        signer.did(),
        "piece-search-array-to-object-proxy",
        undefined,
        tx,
      );
      arrayToObjectSource.set(["old array value"]);
      const arrayToObjectProxy = arrayToObjectSource.getAsQueryResult();
      arrayToObjectSource.set({
        changedShape: "shape-change-value",
        length: "hidden-length-value",
      });

      const arrayToScalarSource = runtime.getCell<unknown>(
        signer.did(),
        "piece-search-array-to-scalar-proxy",
        undefined,
        tx,
      );
      arrayToScalarSource.set(["other old array value"]);
      const arrayToScalarProxy = arrayToScalarSource.getAsQueryResult();
      arrayToScalarSource.set("scalar-shape-value");

      const objectToArraySource = runtime.getCell<unknown>(
        signer.did(),
        "piece-search-object-to-array-proxy",
        undefined,
        tx,
      );
      objectToArraySource.set({ oldObjectValue: true });
      const objectToArrayProxy = objectToArraySource.getAsQueryResult();
      objectToArraySource.set(["array-shape-value"]);
      await tx.commit();
      await runtime.idle();

      const cell = (value: unknown) => ({
        pull: () => Promise.resolve(value),
      });
      const controller = {
        getRegisteredPieces: () =>
          Promise.resolve([{
            id: "of:stale-array-proxy",
            name: () => "Stale array proxy",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () =>
                Promise.resolve(cell({
                  arrayToObject: arrayToObjectProxy,
                  arrayToScalar: arrayToScalarProxy,
                  objectToArray: objectToArrayProxy,
                })),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          }]),
      };
      const config = { apiUrl: API_URL, space: SPACE, identity: ID };
      const deps = {
        loadPieces: () => Promise.resolve(controller as any),
      };
      const match = [{
        id: "of:stale-array-proxy",
        name: "Stale array proxy",
        patternRef: undefined,
      }];

      expect(
        await searchPieces(config, "changedShape", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "shape-change-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "hidden-length-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "scalar-shape-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "array-shape-value", deps),
      ).toEqual(match);
      expect(
        await searchPieces(config, "0", deps),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("continues after an unreadable piece and preserves match order", async () => {
    const errors: Array<{
      pieceId: string;
      source: "input data" | "result data" | "metadata";
      error: unknown;
    }> = [];
    const cell = (value: unknown) => ({
      pull: () => Promise.resolve(value),
    });
    const matchingPiece = (id: string) => ({
      id,
      name: () => id,
      getPatternRef: () => Promise.resolve(undefined),
      input: { getCell: () => Promise.resolve(cell("needle")) },
      result: { getCell: () => Promise.resolve(cell({})) },
    });
    const partiallyReadableObject = {
      get broken(): unknown {
        throw new Error("object property not readable");
      },
      survives: "needle after unreadable object property",
    };
    const partiallyReadableArray = [undefined, "needle after unreadable array"];
    Object.defineProperty(partiallyReadableArray, 0, {
      enumerable: true,
      get: () => {
        throw new Error("array element not readable");
      },
    });
    const controller = {
      getRegisteredPieces: () =>
        Promise.resolve([
          matchingPiece("of:first-match"),
          {
            id: "of:unreadable",
            name: () => "Result-only match",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.reject(new Error("not readable")),
            },
            result: { getCell: () => Promise.resolve(cell("needle")) },
          },
          {
            id: "of:partial-object",
            name: () => "Partial object",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(cell(partiallyReadableObject)),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          },
          {
            id: "of:partial-array",
            name: () => "Partial array",
            getPatternRef: () => Promise.resolve(undefined),
            input: {
              getCell: () => Promise.resolve(cell(partiallyReadableArray)),
            },
            result: { getCell: () => Promise.resolve(cell({})) },
          },
          matchingPiece("of:second-match"),
        ]),
    };

    expect(
      await searchPieces(
        {
          apiUrl: API_URL,
          space: SPACE,
          identity: ID,
        },
        "needle",
        {
          loadPieces: () => Promise.resolve(controller as any),
          reportSearchError: (pieceId, source, error) =>
            errors.push({ pieceId, source, error }),
        },
      ),
    ).toEqual([
      {
        id: "of:first-match",
        name: "of:first-match",
        patternRef: undefined,
      },
      {
        id: "of:unreadable",
        name: "Result-only match",
        patternRef: undefined,
      },
      {
        id: "of:partial-object",
        name: "Partial object",
        patternRef: undefined,
      },
      {
        id: "of:partial-array",
        name: "Partial array",
        patternRef: undefined,
      },
      {
        id: "of:second-match",
        name: "of:second-match",
        patternRef: undefined,
      },
    ]);
    expect(errors).toHaveLength(3);
    expect(errors).toContainEqual({
      pieceId: "of:unreadable",
      source: "input data",
      error: new Error("not readable"),
    });
    expect(errors).toContainEqual({
      pieceId: "of:partial-object",
      source: "input data",
      error: new Error("object property not readable"),
    });
    expect(errors).toContainEqual({
      pieceId: "of:partial-array",
      source: "input data",
      error: new Error("array element not readable"),
    });
  });

  it("forwards repository metadata through piece creation and updates", async () => {
    const repository = "https://github.com/commonfabric/labs";
    const entry = { mainPath: "/repo/main.tsx", repository };
    const program = {} as any;
    let createOptions: unknown;
    let setPatternOptions: unknown;
    const createdPiece = { id: PIECE, getCell: () => ({} as any) };

    const createdId = await newPiece(
      { apiUrl: API_URL, space: SPACE, identity: ID },
      entry,
      { start: false },
      {
        loadPieces: () =>
          Promise.resolve({
            add: () => Promise.resolve(),
            ensureDefaultPattern: () => Promise.resolve({}),
            create: (_program: unknown, options: unknown) => {
              createOptions = options;
              return Promise.resolve(createdPiece);
            },
          } as any),
        getPinnedProgramFromFile: () => Promise.resolve(program),
      },
    );
    expect(createdId).toBe(PIECE);
    expect(createOptions).toEqual({ repository, start: false });

    const pieceConfig = {
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: "notes",
    };
    const deps = {
      loadPieces: () =>
        Promise.resolve({
          get: () =>
            Promise.resolve({
              setPattern: (_program: unknown, options: unknown) => {
                setPatternOptions = options;
                return Promise.resolve({
                  status: "committed" as const,
                  ref: {
                    identity: "A".repeat(43),
                    symbol: "default",
                  },
                  revisionId: "revision-2",
                  detachedOrigin: null,
                  space: SPACE_DID,
                  seq: 12,
                  refresh: { status: "completed" as const },
                });
              },
            }),
        } as any),
      resolvePieceAddress: () => Promise.resolve(PIECE),
      getPinnedProgramFromFile: () => Promise.resolve(program),
    };

    await setPiecePattern(pieceConfig, entry, {}, deps);
    expect(setPatternOptions).toEqual({ repository });

    await setPiecePattern(
      pieceConfig,
      entry,
      { dangerouslyAllowIncompatibleSchema: true },
      deps,
    );
    expect(setPatternOptions).toEqual({
      repository,
      dangerouslyAllowIncompatibleSchema: true,
    });
  });

  it("resolves the piece and pinned program before checking compatibility", async () => {
    // The preflight has to reach the SAME piece the apply would, through the
    // same address resolution and the same pinned program — a check against a
    // different target, or against source with different imports resolved, is
    // worse than no check at all.
    const entry = { mainPath: "/repo/main.tsx" };
    const program = {} as any;
    let resolvedPiece: unknown;
    let checkedProgram: unknown;
    const report = {
      compatible: false,
      issues: { schema: "output narrowed" },
      message: "output narrowed",
      candidate: { identity: "C".repeat(43), symbol: "default" },
    };

    const result = await checkPiecePattern(
      { apiUrl: API_URL, space: SPACE, identity: ID, piece: "notes" },
      entry,
      {
        loadPieces: () =>
          Promise.resolve({
            get: (id: string) => {
              resolvedPiece = id;
              return Promise.resolve({
                checkPattern: (candidate: unknown) => {
                  checkedProgram = candidate;
                  return Promise.resolve(report);
                },
              });
            },
          } as any),
        resolvePieceAddress: () => Promise.resolve(PIECE),
        getPinnedProgramFromFile: () => Promise.resolve(program),
      },
    );

    expect(resolvedPiece).toBe(PIECE);
    expect(checkedProgram).toBe(program);
    // The verdict is passed through verbatim: the CLI reports the rules'
    // finding, it does not re-interpret it.
    expect(result).toEqual(report);
  });

  it("returns pattern provenance from piece inspection", async () => {
    const patternRef = {
      identity: "B".repeat(43),
      symbol: "default",
      source: { ref: `cf:pattern:${"B".repeat(43)}` },
    };
    const signer = await Identity.fromPassphrase("cf piece inspect provenance");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const space = signer.did();
      const inspected = await inspectPiece(
        { apiUrl: API_URL, space: SPACE, identity: ID, piece: "notes" },
        {
          resolvePieceAddress: () => Promise.resolve(PIECE),
          loadPieces: () =>
            Promise.resolve({
              get: () =>
                Promise.resolve({
                  id: PIECE,
                  name: () => "Notes",
                  getPatternRef: () => Promise.resolve(patternRef),
                  input: {
                    get: () => Promise.resolve({ title: "Input" }),
                    getCell: () =>
                      Promise.resolve(runtime.getCell(space, "argument")),
                  },
                  result: {
                    get: () => Promise.resolve({ title: "Result" }),
                    getCell: () =>
                      Promise.resolve(runtime.getCell(space, "result")),
                  },
                  readingFrom: () => Promise.resolve([]),
                  readBy: () => Promise.resolve([]),
                }),
            } as any),
        },
      );

      expect(inspected.patternRef).toEqual(patternRef);
      expect(inspected.id).toBe(PIECE);
      expect(inspected.cachedResultFields).toEqual([]);
      expect(inspected.sourceCommit).toBeUndefined();
      expect(inspected.sourceSpace).toBe(space);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("forwards repository metadata when deploying a home pattern", async () => {
    const repository = "https://github.com/commonfabric/labs";
    let recreateOptions: unknown;

    await setHomePattern(
      { apiUrl: API_URL, identity: ID },
      { mainPath: "/repo/home.tsx", repository },
      {
        loadIdentity: () =>
          Promise.resolve({ did: () => "did:key:home" } as any),
        getProgramFromFile: () => Promise.resolve({} as any),
        loadPieces: () =>
          Promise.resolve({
            recreateDefaultPattern: (options: unknown) => {
              recreateOptions = options;
              return Promise.resolve({ id: PIECE });
            },
          } as any),
      },
    );

    expect(recreateOptions).toEqual({
      customProgram: {},
      repository,
    });
  });

  it("shows set-slug command options", async () => {
    const { code, stdout, stderr } = await cf("piece set-slug --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(code).toBe(0);
    expect(output).toContain("Set a slug redirect");
    expect(output).toContain("--resolve-before-linking");
  });

  it("resolves slug piece config through storage", async () => {
    const manager = {};
    const resolved = await resolvePieceConfig({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: "demo",
    }, {
      loadPieces: (config: SpaceConfig) => {
        expect(config.space).toBe(SPACE);
        return Promise.resolve(manager as any);
      },
      resolvePieceAddress: (seenManager: unknown, token: string) => {
        expect(seenManager).toBe(manager);
        expect(token).toBe("demo");
        return Promise.resolve(PIECE);
      },
    });

    expect(resolved.piece).toBe(PIECE);
  });

  it("preserves URI piece config without slug lookup", async () => {
    const resolved = await resolvePieceConfig({
      apiUrl: API_URL,
      space: SPACE,
      identity: ID,
      piece: "of:fid1:piece-123",
    }, {
      loadPieces: () => Promise.resolve({} as any),
    });

    expect(resolved.piece).toBe("of:fid1:piece-123");
  });

  it("preserves URI link endpoints and their paths without slug lookup", async () => {
    const token = "of:fid1:piece-123";
    const resolved = await resolveLinkEndpointAddress({} as any, token, [
      "items",
      0,
    ]);

    expect(resolved).toEqual({ piece: token, pathAfter: ["items", 0] });
  });

  it("rejects a bare endpoint with no slug document, even with the fallback", async () => {
    const manager = {};
    // A colon-less token (a bare name, or a legacy CID) is not an id-shaped
    // endpoint, so the missing-slug fallback does not preserve it; with no slug
    // document it is genuinely missing rather than a usable raw id.
    const token = "a-bare-name";
    await expect(resolveLinkEndpointAddress(
      manager as any,
      token,
      [],
      {
        resolvePieceAddress: () =>
          Promise.reject(
            new SlugResolutionError(`Slug "${token}" not found.`, "missing"),
          ),
      },
      { allowMissingSlugFallback: true },
    )).rejects.toThrow(/Slug "a-bare-name" not found/);
  });

  it("rejects missing destination slug endpoints", async () => {
    const manager = {};
    const token = "demo";
    await expect(resolveLinkEndpointAddress(
      manager as any,
      token,
      [],
      {
        resolvePieceAddress: () =>
          Promise.reject(
            new SlugResolutionError(`Slug "${token}" not found.`, "missing"),
          ),
      },
    )).rejects.toThrow(/Slug "demo" not found/);
  });
});
