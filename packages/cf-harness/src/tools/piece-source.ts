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
 * Neither tool undoes anything. A revision is reversible from the piece menu
 * `cf-render` gives every host, which lists the recorded revisions and offers
 * an earlier one; a session that could revert could discard a person's change
 * without them asking, and what it would buy is a button that already exists.
 */

import type { JSONSchema } from "@commonfabric/api";
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
import { type Cell, getPatternIdentityRef } from "@commonfabric/runner";
import { cfcLabelViewForCellFailClosed } from "@commonfabric/runner/cfc";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import {
  type DisclosedCfcLabel,
  disclosedCfcLabels,
} from "../cfc-label-disclosure.ts";
import { errorMessage } from "../error-message.ts";
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

  files: { name: string; contents: string }[];

  /** Names among {@link files} that carry data rather than code. */
  dataFiles?: string[];

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
    "Read the current authored source of a piece behind a handle token, so you can revise a piece that already exists rather than write a replacement blind. Returns the source files, their revision, an inputRef to the piece's bound arguments, where the source came from, and its CFC labels. Wire inputRef into run_pattern for a before/after check against the actual inputs; it is a reference, not their contents. Reading source puts this context under its labels. Pass sourceRevisionId back to revise_piece so a piece that moved in the meantime refuses the write.",
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
    "Replace the source of a piece behind a handle token with a revised program, keeping the piece's data. The candidate is checked against what the piece holds before it is applied — its argument and result schemas, the links it retains, and the CFC envelope on its argument — and a candidate that does not fit is refused with every reason at once rather than applied and left broken. Returns the new revision's id and a reference to the refreshed result, never source. Use it after read_piece_source when someone asks for a piece they already have to work differently; use run_pattern when there is no such piece. A change that needs a rehearsal against a copy of the space is refused, because that is a person's judgement to make and not this tool's.",
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
 * The piece a handle token names, or the refusal that says why it names none.
 *
 * Every check here is one `assign_slug` already makes of the same kind of
 * token, for the same reasons: a reference this run does not hold, a space
 * the session has no authority in, and a position inside a piece rather than
 * a piece are three different mistakes and each is said by name.
 */
const resolvePiece = async (
  toolId: string,
  pieces: PiecesController,
  ref: string,
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
  if (link.space !== space) {
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
        errorMessage(error)
      }`,
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
const sessionPieces = async (
  toolId: string,
  context: HarnessToolContext,
): Promise<
  { ok: true; pieces: PiecesController } | {
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
    return { ok: true, pieces: (await context.getFabricSession()).pieces };
  } catch (error) {
    return {
      ok: false,
      message: `${toolId} could not establish the fabric session: ${
        errorMessage(error)
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
    try {
      state = await readPieceSourceState(session.pieces.runtime, piece.cell);
      inputRef = createLLMFriendlyLink(
        session.pieces.getArgument(piece.cell).getAsNormalizedFullLink(),
        session.pieces.getSpace(),
      );
    } catch (error) {
      return fail(
        `read_piece_source could not read the piece's source: ${
          errorMessage(error)
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
    return {
      outputId,
      status: "ok",
      inputRef,
      ...(state.entry !== undefined ? { entry: state.entry } : {}),
      files: state.files.map((file) => ({ ...file })),
      ...(state.dataFiles !== undefined
        ? { dataFiles: [...state.dataFiles] }
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

    const program = {
      main: "/main.tsx",
      files: [{ name: "/main.tsx", contents: input.sourceText }],
    };
    const previousPattern = getPatternIdentityRef(piece.cell);
    let controller: PieceController;
    try {
      controller = await pieces.get(piece.id);
    } catch (error) {
      return fail(
        `revise_piece could not open the piece: ${errorMessage(error)}`,
      );
    }

    // The caller's precondition, checked before anything is compiled: a
    // piece that moved since the read this revision was written against is a
    // different piece to revise, and saying so costs nothing here.
    if (
      typeof input.expectedRevisionId === "string" &&
      input.expectedRevisionId.length > 0
    ) {
      let current: PieceSourceState;
      try {
        current = await readPieceSourceState(pieces.runtime, piece.cell);
      } catch (error) {
        return fail(
          `revise_piece could not read the piece's current revision: ${
            errorMessage(error)
          }`,
        );
      }
      if (current.currentRevisionId !== input.expectedRevisionId) {
        return fail(
          "revise_piece refused: the piece has been revised since the " +
            "source you are editing was read. Read it again and rewrite " +
            "your change against what it holds now.",
        );
      }
    }

    // Preflight, so an incompatible candidate is refused with every reason at
    // once rather than with whichever low-level assertion fires first. The
    // apply path revalidates independently, so this is a better message and
    // not the enforcement.
    let report: PatternCompatibilityReport;
    try {
      report = await controller.checkPattern(program);
    } catch (error) {
      return fail(
        `revise_piece could not compile the candidate: ${errorMessage(error)}`,
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
        `revise_piece could not apply the revision: ${errorMessage(error)}`,
      );
    }
    const resultRef = createLLMFriendlyLink(
      controller.getCell().getAsNormalizedFullLink(),
      pieces.getSpace(),
    );
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
