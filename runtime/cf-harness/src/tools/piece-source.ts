/**
 * Reading and revising the source of a piece the run holds a handle to.
 *
 * The two tools here are what an authoring child needs to change a piece
 * someone already has rather than build a new one. Both address the piece by
 * handle — the address stays trusted-side, as it does for every other tool —
 * and both lean on the runtime for everything but the handle resolution: the
 * source facts come from `readPieceSourceState`, and the revision is the
 * piece controller's own `checkPattern` then `setPattern`, which is the
 * "direct edit" row of `docs/specs/piece-source-lifecycle.md`.
 *
 * They sit on the `pattern-author` surface and on no other, and no parent
 * surface may offer them — see `SUBAGENT_ONLY_TOOL_IDS`. That profile's
 * return contract has no field for source in any encoding and the profile
 * holds authority over it, so a child that reads a piece's source has no
 * field to return it in.
 *
 * That is a statement about the return contract and not about every route
 * out of a child. The run artifact root holds each raw tool output and the
 * parent's `bash` can read it (CT-2117), which defeats this boundary as it
 * defeats every other withheld-content boundary in the harness. What is new
 * here is the kind of content that route exposes — program text a third
 * party authored — rather than the route.
 *
 * A revision is also a version of the pattern the piece ran. When the run
 * contributes to the pattern index it is queued on the session's ledger
 * revised from the piece's previous pattern, so it joins that pattern's
 * version history (or is credited as a remix of someone else's) as a
 * `run_pattern` naming the piece in `revises` does. It keeps its
 * predecessor's description unless the caller gives a new one. It is
 * recorded, never offered to search: no render was checked. It names its
 * piece as where it is deployed but not as a slot: the piece's previous
 * pattern already finds the history, and a slot would outrank it — filing
 * the version wherever the piece's key was first bound, which a piece still
 * held unsent by another session's ledger, or one whose source came from
 * elsewhere, gets wrong.
 *
 * Neither tool undoes anything. A revision is reversible from the piece menu
 * `cf-render` gives every host, which lists the recorded revisions and offers
 * an earlier one; a session that could revert could discard a person's change
 * without them asking, and what it would buy is a button that already exists.
 *
 * A binary media file in the source — an image, a font, a sound — is stored
 * as a base64 `data:` URL (`@commonfabric/text/data-file`). The read leaves
 * each such file out and lists it by name, media type, and size, and a
 * revision carries every one over from the current source unchanged. So
 * those bytes never reach the model's context, and a revision cannot drop or
 * corrupt one. A revision sends only the entry's source, so it carries a text
 * data file over unchanged too.
 */

import type { JSONSchema } from "@commonfabric/api";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { pieceId } from "@commonfabric/piece";
import {
  type PatternCompatibilityReport,
  type PatternUpdateReceipt,
  type PieceController,
  type PiecesController,
  PieceSourceChangedError,
  type PieceSourceState,
  readPieceSourceState,
} from "@commonfabric/piece/ops";
import {
  type Cell,
  getPatternIdentityRef,
  PatternManager,
} from "@commonfabric/runner";
import { deployedPieceRef } from "@commonfabric/pattern-index/client";
import { patternIndexDependencies } from "@commonfabric/pattern-index/deploy";
import { PATTERN_DISCOVERABILITY_REASONS } from "../pattern-index/publish-render-gate.ts";
import { cfcLabelViewForCellFailClosed } from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  dataFileMediaType,
  encodeDataFile,
  isStoredAsDataUrl,
} from "@commonfabric/text/data-file";
import {
  type DisclosedCfcLabel,
  disclosedCfcLabels,
} from "../cfc-label-disclosure.ts";
import type { HarnessForeignSpaces } from "../foreign-spaces.ts";
import { scrubBareFabricIdentifiers } from "../fabric-identifier-scrub.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import type { HarnessToolContext, HarnessToolDefinition } from "./types.ts";

/**
 * Where a piece's current source came from, read off the origin the piece
 * records rather than asserted about whoever typed it.
 *
 * The revision log names no author, so "this principal wrote it" is not a
 * fact this can report. What the piece does record is the origin it follows,
 * and the three values below are that origin's three states: a pattern the
 * deployment serves, source followed from elsewhere in the fabric, and no
 * origin at all, which is what an in-place edit leaves behind.
 */
export type PieceSourceProvenance =
  | "deployment-served"
  | "followed-in-fabric"
  | "authored-in-place"
  | "unreadable-origin";

export interface ReadPieceSourceToolInput {
  token: string;
}

export interface ReadPieceSourceToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** The canonical entry filename among {@link files}. */
  entry?: string;

  /** The source's files, less those {@link omittedFiles} lists. */
  files: { name: string; contents: string }[];

  /** Names among {@link files} that carry data rather than code. */
  dataFiles?: string[];

  /** The binary media files left out of {@link files}, when there are any. */
  omittedFiles?: OmittedPieceSourceFiles;

  /**
   * The revision these files are the source of. Pass it back as
   * `revise_piece`'s `expectedRevisionId` to have the write refused if the
   * piece moved in between.
   */
  sourceRevisionId?: string;

  /**
   * Reference to this piece's bound argument cell. Wire it into run_pattern
   * to verify a revision against the same inputs under the session's labels.
   */
  inputRef: string;

  provenance: PieceSourceProvenance;

  /**
   * The CFC labels the piece carries. Reading source puts this context under
   * them, so they are stated rather than left to be discovered at the
   * boundary that withholds something.
   */
  labels: DisclosedCfcLabel[];
}

/**
 * The binary media files `read_piece_source` leaves out of the source it
 * returns, with the reason it gives the model for leaving them out.
 */
export interface OmittedPieceSourceFiles {
  /** Why the files were left out, and what a revision does with them. */
  reason: string;

  /** One entry per file left out, in the order the source lists them. */
  files: OmittedPieceSourceFile[];
}

/** One binary media file `read_piece_source` leaves out. */
export interface OmittedPieceSourceFile {
  /** The file's name in the source, as the source reads it. */
  name: string;

  /** The media type its `data:` URL carries. */
  mediaType: string;

  /** The size of the file, in bytes. */
  bytes: number;
}

export interface PieceSourceToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type ReadPieceSourceToolOutput =
  | ReadPieceSourceToolSuccessOutput
  | PieceSourceToolErrorOutput;

export interface RevisePieceToolInput {
  token: string;
  sourceText: string;
  expectedRevisionId?: string;

  /**
   * What the revised pattern does, in one line, when the revision changes
   * that. Without it the version keeps its predecessor's description.
   */
  description?: string;

  /** Tags for the version, with `description`; otherwise inherited. */
  hashtags?: readonly string[];
}

export interface RevisePieceToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** The revision the accepted setup transaction appended. */
  revisionId: string;

  /** Reference to the revised piece's result cell. */
  resultRef: string;

  /** The origin this update detached, when the piece was following one. */
  detachedOrigin?: string;

  /**
   * Set when the source update committed but the refresh of the running
   * piece did not. The revision is durable and `resultRef` names the piece;
   * what is unestablished is that the piece runs the new source yet. It is
   * the tool's equivalent of `cf piece setsrc`'s "source changed, running
   * deploy unverified" — a state a caller has to be able to tell from a
   * clean apply, since rendering the result is how it would find out.
   */
  refreshWarning?: string;
}

export type RevisePieceToolOutput =
  | RevisePieceToolSuccessOutput
  | PieceSourceToolErrorOutput;

const LABEL_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    path: { type: "array", items: { type: "string" } },
    confidentiality: {
      type: "array",
      items: { type: "array", items: { type: "string" } },
    },
    integrity: { type: "array", items: { type: "string" } },
  },
  required: ["confidentiality", "integrity"],
  additionalProperties: false,
};

export const readPieceSourceToolDescriptor: HarnessToolDescriptor = {
  toolId: "read_piece_source",
  title: "Read Piece Source",
  description:
    "Read the current authored source of a piece behind a handle token, so you can revise a piece that already exists rather than write a replacement blind. Returns the source files, their revision, an inputRef to the piece's bound arguments, where the source came from, and its CFC labels. Binary media files (images, fonts, sounds) are listed under omittedFiles by name, media type, and size rather than returned. revise_piece keeps every data file, binary or text, unchanged. Wire inputRef into run_pattern for a before/after check against the actual inputs; it is a reference, not their contents. Reading source puts this context under its labels. Pass sourceRevisionId back to revise_piece so a piece that moved in the meantime refuses the write. To run a revised copy as a new piece instead, pass this token as run_pattern's revises.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "A handle token of the form cfh:a:<suffix> naming a piece.",
      },
    },
    required: ["token"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      entry: { type: "string" },
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            contents: { type: "string" },
          },
          required: ["name", "contents"],
          additionalProperties: false,
        },
      },
      dataFiles: { type: "array", items: { type: "string" } },
      omittedFiles: {
        type: "object",
        properties: {
          reason: { type: "string" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                mediaType: { type: "string" },
                bytes: { type: "integer" },
              },
              required: ["name", "mediaType", "bytes"],
              additionalProperties: false,
            },
          },
        },
        required: ["reason", "files"],
        additionalProperties: false,
      },
      sourceRevisionId: { type: "string" },
      inputRef: { type: "string" },
      provenance: {
        enum: [
          "deployment-served",
          "followed-in-fabric",
          "authored-in-place",
          "unreadable-origin",
        ],
      },
      labels: { type: "array", items: LABEL_SCHEMA },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  },
  tags: ["fabric", "piece", "source"],
};

export const revisePieceToolDescriptor: HarnessToolDescriptor = {
  toolId: "revise_piece",
  title: "Revise Piece",
  description:
    "Replace the source of a piece behind a handle token with a revised program, keeping the piece's data. The piece's data files, the binary ones read_piece_source lists under omittedFiles included, are carried over unchanged at the same paths, so the revised source reads them as the current one does; a piece whose source the space does not hold is refused. The candidate is checked against what the piece holds before it is applied — its argument and result schemas, the links it retains, and the CFC envelope on its argument — and a candidate that does not fit is refused with every reason at once rather than applied and left broken. Returns the new revision's id and a reference to the refreshed result, never source. Use it after read_piece_source when someone asks for a piece they already have to work differently; use run_pattern when there is no such piece. A change that needs a rehearsal against a copy of the space is refused, because that is a person's judgment to make and not this tool's.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "A handle token of the form cfh:a:<suffix> naming the piece to revise.",
      },
      sourceText: {
        type: "string",
        description:
          "The complete revised pattern source, written the way run_pattern's sourceText is.",
      },
      expectedRevisionId: {
        type: "string",
        description:
          "The sourceRevisionId read_piece_source reported. Supplied, a piece that moved since that read refuses this write rather than taking it.",
      },
      description: {
        type: "string",
        description:
          "Only when the revision changes what the pattern does: one new line saying what it now does. Otherwise the version keeps the previous description.",
      },
      hashtags: {
        type: "array",
        items: { type: "string" },
        description:
          "With description: words someone searching for this capability would type.",
      },
    },
    required: ["token", "sourceText"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      revisionId: { type: "string" },
      resultRef: { type: "string" },
      detachedOrigin: { type: "string" },
      refreshWarning: { type: "string" },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  },
  tags: ["fabric", "piece", "source"],
};

/**
 * Where the piece says its current source came from.
 *
 * A piece carrying a recorded origin string no resolver can follow is
 * neither following nor detached — it holds something a person can read and
 * repair — so it is reported as its own state rather than folded into
 * `authored-in-place`, which would assert an authorship the piece never
 * recorded.
 */
const provenanceOf = (state: PieceSourceState): PieceSourceProvenance => {
  if (state.origin === undefined) {
    return state.unusableOrigin === undefined
      ? "authored-in-place"
      : "unreadable-origin";
  }
  return state.origin.kind === "system"
    ? "deployment-served"
    : "followed-in-fabric";
};

/**
 * What `read_piece_source` tells the model about the files it leaves out. It
 * travels in the output rather than only in the tool's description, so a
 * reader of the output alone knows the list is not the whole program.
 */
const OMITTED_FILES_REASON =
  "Binary media files (images, fonts, sounds) are stored as base64 data: " +
  "URLs, so they are listed here instead of returned in files. The source " +
  "reads each one by its path. revise_piece carries them over unchanged; " +
  "a revision does not send them.";

/**
 * Splits `files`, for `read_piece_source`, into the files it returns and a
 * description, without contents, of each binary media file it leaves out.
 * Throws, naming the file, for a binary media file whose contents are not a
 * `data:` URL of its media type. A program built without `decodeDataFile()`
 * can hold one, and `cf piece getsrc` refuses it the same way.
 */
const withoutBinaryMedia = (
  files: readonly { name: string; contents: string }[],
): {
  files: { name: string; contents: string }[];
  omitted: OmittedPieceSourceFile[];
} => {
  const kept: { name: string; contents: string }[] = [];
  const omitted: OmittedPieceSourceFile[] = [];
  for (const file of files) {
    const mediaType = dataFileMediaType(file.name);
    if (mediaType === undefined || !isStoredAsDataUrl(file.name)) {
      kept.push({ ...file });
      continue;
    }
    omitted.push({
      name: file.name,
      mediaType,
      bytes: encodeDataFile(file.contents, file.name).byteLength,
    });
  }
  return { files: kept, omitted };
};

/**
 * The program a revision writes: `sourceText` as `main.tsx`, beside every
 * data file of `current`, the piece's current source, carried over unchanged.
 *
 * A revision sends only its source, so no caller can send a data file back:
 * not a binary media file, which `read_piece_source` leaves out, and not a
 * text one either. A data file is read by a path relative to the module
 * reading it, so `sourceText` is placed in the directory of the entry it
 * replaces, where each path the current source reads names the same file.
 * Code modules other than the entry are not carried over.
 */
const revisedProgram = (
  sourceText: string,
  current: PieceSourceState,
): {
  main: string;
  files: { name: string; contents: string }[];
  dataFiles?: string[];
} => {
  const entry = current.entry ?? "/main.tsx";
  const main = `${entry.slice(0, entry.lastIndexOf("/"))}/main.tsx`;
  // A binary media file is always data, whether or not the source lists it.
  const data = new Set(current.dataFiles);
  const carried = current.files.filter((file) =>
    file.name !== main && (data.has(file.name) || isStoredAsDataUrl(file.name))
  );
  return {
    main,
    files: [
      { name: main, contents: sourceText },
      ...carried.map((file) => ({ ...file })),
    ],
    ...(carried.length === 0
      ? {}
      : { dataFiles: carried.map((file) => file.name) }),
  };
};

/**
 * The piece a handle token names, or the refusal that says why it names none.
 *
 * Every check here is one `assign_slug` already makes of the same kind of
 * token, for the same reasons: a reference this run does not hold, a space
 * the session has no authority in, and a position inside a piece rather than
 * a piece are three different mistakes and each is said by name. A piece in
 * another space is reached only where `admitsSpace` says the caller may act
 * there; by default nothing outside the run's own space is.
 */
export const resolvePiece = async (
  toolId: string,
  pieces: PiecesController,
  ref: string,
  admitsSpace: (space: string) => boolean = () => false,
): Promise<
  { ok: true; cell: Cell<unknown>; id: string } | { ok: false; message: string }
> => {
  const space = pieces.getSpace();
  let link;
  try {
    link = parseLLMFriendlyLink(ref.startsWith("/") ? ref : `/${ref}`, space);
  } catch {
    return {
      ok: false,
      message: `${toolId} token does not name a reference this run holds`,
    };
  }
  if (link.space !== space && !admitsSpace(link.space)) {
    return {
      ok: false,
      message: `${toolId} can only reach a piece in this run's own space`,
    };
  }
  if (link.path.length > 0) {
    return {
      ok: false,
      message:
        `${toolId} token must name a piece itself, not a position inside one`,
    };
  }
  const cell = pieces.runtime.getCellFromLink({ ...link, schema: undefined });
  try {
    await cell.sync();
  } catch (error) {
    return {
      ok: false,
      message: `${toolId} could not load the referenced piece: ${
        describeFailure(error)
      }`,
    };
  }
  // A space this session may not read serves the piece as empty; say so
  // rather than report a piece that is not one.
  const denied = pieces.runtime.storageManager.authorizationError?.(
    link.space,
  );
  if (denied !== undefined) {
    return {
      ok: false,
      message: `${toolId} cannot read the piece's space: ${denied.message}`,
    };
  }
  const id = pieceId(cell);
  if (getPatternIdentityRef(cell) === undefined || id === undefined) {
    return {
      ok: false,
      message: `${toolId} token does not refer to a piece`,
    };
  }
  return { ok: true, cell, id };
};

/** The session's piece controller, or the refusal that says why there is none. */
export const sessionPieces = async (
  toolId: string,
  context: HarnessToolContext,
): Promise<
  | { ok: true; pieces: PiecesController; foreignSpaces: HarnessForeignSpaces }
  | {
    ok: false;
    message: string;
  }
> => {
  if (context.getFabricSession === undefined) {
    return {
      ok: false,
      message:
        `${toolId} requires a fabric session; a run without one holds no pieces`,
    };
  }
  try {
    const session = await context.getFabricSession();
    return {
      ok: true,
      pieces: session.pieces,
      foreignSpaces: session.foreignSpaces ?? {},
    };
  } catch (error) {
    return {
      ok: false,
      message: `${toolId} could not establish the fabric session: ${
        describeFailure(error)
      }`,
    };
  }
};

export const readPieceSourceTool: HarnessToolDefinition<
  ReadPieceSourceToolInput,
  ReadPieceSourceToolOutput
> = {
  descriptor: readPieceSourceToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("read_piece_source");
    const fail = (message: string): PieceSourceToolErrorOutput => ({
      outputId,
      status: "error",
      message: scrubBareFabricIdentifiers(message),
    });
    const ref = typeof input.token === "string" ? input.token.trim() : "";
    if (ref.length === 0) {
      return fail("read_piece_source requires a token naming a piece");
    }
    const session = await sessionPieces("read_piece_source", context);
    if (!session.ok) return fail(session.message);
    const piece = await resolvePiece("read_piece_source", session.pieces, ref);
    if (!piece.ok) return fail(piece.message);
    let state: PieceSourceState;
    let inputRef: string;
    let source: ReturnType<typeof withoutBinaryMedia>;
    try {
      state = await readPieceSourceState(session.pieces.runtime, piece.cell);
      inputRef = createLLMFriendlyLink(
        session.pieces.getArgument(piece.cell).getAsNormalizedFullLink(),
        session.pieces.getSpace(),
      );
      source = withoutBinaryMedia(state.files);
    } catch (error) {
      return fail(
        `read_piece_source could not read the piece's source: ${
          describeFailure(error)
        }`,
      );
    }
    if (state.files.length === 0) {
      // The piece runs a pattern whose authored closure this space cannot
      // load. That is a fact about the space rather than a failure of the
      // call, and it is said plainly so the caller does not read an empty
      // file list as an empty program.
      return fail(
        "read_piece_source found no authored source retained for this piece",
      );
    }
    const dataFiles =
      state.dataFiles?.filter((name) => !isStoredAsDataUrl(name)) ?? [];
    return {
      outputId,
      status: "ok",
      inputRef,
      ...(state.entry !== undefined ? { entry: state.entry } : {}),
      files: source.files,
      ...(dataFiles.length > 0 ? { dataFiles } : {}),
      ...(source.omitted.length > 0
        ? {
          omittedFiles: { reason: OMITTED_FILES_REASON, files: source.omitted },
        }
        : {}),
      ...(state.currentRevisionId !== undefined
        ? { sourceRevisionId: state.currentRevisionId }
        : {}),
      provenance: provenanceOf(state),
      labels: disclosedCfcLabels(cfcLabelViewForCellFailClosed(piece.cell)),
    };
  },
};

/**
 * Whether the space this piece lives in holds data a rehearsal would be
 * protecting. `space-clone-rehearsal.md` scopes its requirement to a
 * populated space, and the piece registry is the reading of "populated" this
 * has: a space with pieces in it is one whose content an incompatible update
 * could strand. A registry that cannot be read counts as populated, since a
 * refusal that cannot be justified is the safe way round.
 */
const spaceIsPopulated = async (pieces: PiecesController): Promise<boolean> => {
  try {
    return (await pieces.getRegisteredPieces()).length > 0;
  } catch {
    return true;
  }
};

/**
 * Queues an applied revision as a version on the session's ledger when the
 * run contributes to the index. A person's own agent names the piece it is
 * deployed to, as `run_pattern` does, so their use of the piece finds it. The
 * pattern the piece ran before is what it was revised from; the ledger
 * decides from it which history the version joins and, without a new
 * description, what the version is described as. A revision that left the
 * pattern as it was is no new version.
 */
const stageRevisedVersion = async (
  context: HarnessToolContext,
  input: RevisePieceToolInput,
  revision: {
    program: ReturnType<typeof revisedProgram>;
    space: string;
    pieceId: string;
    identity: string;
    previous: string | undefined;
  },
): Promise<void> => {
  // Model input: a field of the wrong type is no description, rather than a
  // throw after the revision has already been applied.
  const description = typeof input.description === "string"
    ? input.description.trim()
    : undefined;
  const hashtags = Array.isArray(input.hashtags)
    ? input.hashtags.filter((tag) => typeof tag === "string")
    : [];
  const ledger = context.patternIndexLedger;
  if (
    ledger === undefined || context.getPatternIndexClient === undefined ||
    context.patternIndexPublishEnabled !== true ||
    revision.previous === undefined ||
    revision.previous === revision.identity ||
    // Named only within the session that minted it: no other runtime could
    // ever load an entry published under it.
    PatternManager.isKeylessPatternIdentity(revision.identity)
  ) {
    return;
  }
  const pieceRef = context.patternIndexOrigin === "agent"
    ? await deployedPieceRef(revision.space, revision.pieceId)
    : undefined;
  ledger.stage(
    {
      patternId: revision.identity,
      ...(pieceRef !== undefined
        ? { origin: "agent" as const, deployedTo: pieceRef }
        : {}),
      program: revision.program,
      ...(description !== undefined && description !== ""
        ? { description, hashtags }
        : {}),
      ...(context.taskText !== undefined
        ? { directQuery: context.taskText }
        : description !== undefined && description !== ""
        ? { directQuery: description }
        : {}),
      // A data file is stored uninterpreted, so an import its text spells is
      // no dependency, as the index reads the same program.
      dependencies: patternIndexDependencies(
        revision.program.files.filter((file) =>
          !revision.program.dataFiles?.includes(file.name)
        ),
      ),
      nonDiscoverable: {
        reason: PATTERN_DISCOVERABILITY_REASONS["recorded-automatically"],
      },
    },
    { revisedFrom: revision.previous },
  );
};

export const revisePieceTool: HarnessToolDefinition<
  RevisePieceToolInput,
  RevisePieceToolOutput
> = {
  descriptor: revisePieceToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("revise_piece");
    const fail = (message: string): PieceSourceToolErrorOutput => ({
      outputId,
      status: "error",
      message: scrubBareFabricIdentifiers(message),
    });
    const ref = typeof input.token === "string" ? input.token.trim() : "";
    if (ref.length === 0) {
      return fail("revise_piece requires a token naming a piece");
    }
    if (typeof input.sourceText !== "string" || input.sourceText.length === 0) {
      return fail("revise_piece requires the revised sourceText");
    }
    const session = await sessionPieces("revise_piece", context);
    if (!session.ok) return fail(session.message);
    const { pieces } = session;
    const piece = await resolvePiece("revise_piece", pieces, ref);
    if (!piece.ok) return fail(piece.message);

    const previousPattern = getPatternIdentityRef(piece.cell);
    let controller: PieceController;
    try {
      controller = await pieces.get(piece.id);
    } catch (error) {
      return fail(
        `revise_piece could not open the piece: ${describeFailure(error)}`,
      );
    }

    // The current source holds the files the revision carries over, and the
    // revision the caller's precondition names.
    let current: PieceSourceState;
    try {
      current = await readPieceSourceState(pieces.runtime, piece.cell);
    } catch (error) {
      return fail(
        `revise_piece could not read the piece's current source: ${
          describeFailure(error)
        }`,
      );
    }

    // The caller's precondition, checked before anything is compiled: a
    // piece that moved since the read this revision was written against is a
    // different piece to revise, and saying so costs nothing here.
    if (
      typeof input.expectedRevisionId === "string" &&
      input.expectedRevisionId.length > 0 &&
      current.currentRevisionId !== input.expectedRevisionId
    ) {
      return fail(
        "revise_piece refused: the piece has been revised since the " +
          "source you are editing was read. Read it again and rewrite " +
          "your change against what it holds now.",
      );
    }
    // With no authored source to read, the files a revision carries over are
    // unknown, so writing one could drop a picture the piece shows. The read
    // refuses the same piece.
    if (current.files.length === 0) {
      return fail(
        "revise_piece refused: the space holds no authored source for this " +
          "piece, so the files a revision carries over from it cannot be read",
      );
    }
    const program = revisedProgram(input.sourceText, current);

    // Preflight, so an incompatible candidate is refused with every reason at
    // once rather than with whichever low-level assertion fires first. The
    // apply path revalidates independently, so this is a better message and
    // not the enforcement.
    let report: PatternCompatibilityReport;
    try {
      report = await controller.checkPattern(program);
    } catch (error) {
      return fail(
        `revise_piece could not compile the candidate: ${
          describeFailure(error)
        }`,
      );
    }
    if (!report.compatible) {
      const reason = report.message ??
        "it cannot replace this piece's source";
      // A candidate that does not fit is the first case
      // `space-clone-rehearsal.md` sends to a person, and the override that
      // would take it anyway is not on this tool: a session cannot obtain
      // the informed consent that flag stands for. On a populated space the
      // refusal says which rule sent it back, since that is the space where
      // taking it would cost someone their data.
      return fail(
        `revise_piece refused the candidate: ${reason}` +
          (await spaceIsPopulated(pieces)
            ? ". Applying it anyway on a space that holds data has to be " +
              "rehearsed against a copy of the space by a person first " +
              "(docs/development/space-clone-rehearsal.md), so this tool " +
              "will not. Revise so the candidate fits what the piece holds."
            : ""),
      );
    }

    let receipt: PatternUpdateReceipt;
    try {
      receipt = await controller.setPattern(program, {
        // The pin the write transaction re-checks: a concurrent writer
        // landing between the preflight above and this commit is refused by
        // name rather than silently written over.
        ...(previousPattern === undefined
          ? {}
          : { expectedPattern: previousPattern }),
      });
    } catch (error) {
      // A piece that moved under the pin is said by name and in this tool's
      // own words. The runtime's own text for it quotes the pattern it was
      // proved against as `<identity>#<symbol>`, and a bare content identity
      // carries no scheme for the identifier scrub to recognize, so relaying
      // it would put a fabric identifier in model context that nothing
      // downstream would catch.
      if (error instanceof PieceSourceChangedError) {
        return fail(
          "revise_piece refused: the piece moved onto different source " +
            "between the check and the write. Read its source again and " +
            "rewrite your change against what it holds now.",
        );
      }
      return fail(
        `revise_piece could not apply the revision: ${describeFailure(error)}`,
      );
    }
    const resultRef = createLLMFriendlyLink(
      controller.getCell().getAsNormalizedFullLink(),
      pieces.getSpace(),
    );
    await stageRevisedVersion(context, input, {
      program,
      space: pieces.getSpace(),
      pieceId: piece.id,
      identity: receipt.ref.identity,
      previous: previousPattern?.identity,
    });
    return {
      outputId,
      status: "ok",
      revisionId: receipt.revisionId,
      resultRef,
      ...(receipt.detachedOrigin !== null
        ? { detachedOrigin: receipt.detachedOrigin }
        : {}),
      ...(receipt.refresh.status === "failed"
        ? {
          refreshWarning: scrubBareFabricIdentifiers(receipt.refresh.warning),
        }
        : {}),
    };
  },
};
