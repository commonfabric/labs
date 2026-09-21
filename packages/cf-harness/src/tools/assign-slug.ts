import { getPatternIdentityRef, validateSlug } from "@commonfabric/runner";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
  UI,
} from "@commonfabric/runner/shared";
import { uiSchema } from "@commonfabric/runner/schemas";
import {
  assignSlug,
  pieceId,
  readSlugBinding,
  resolvePieceAddress,
  SlugAssignedError,
  SlugReleasedError,
  SlugResolutionError,
} from "@commonfabric/piece";
import {
  PieceController,
  type PiecesController,
} from "@commonfabric/piece/ops";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { observedOutputsIn } from "../run-pattern-output-concerns.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface AssignSlugToolInput {
  token?: string;
  slug?: string;
}

export interface AssignSlugToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** The assigned slug, the caller's own word echoed back. */
  slug: string;

  /**
   * Absolute URL for the named piece, composed from the session's API URL
   * and the space's configured name. Absent when the session was configured
   * by `did:key` rather than by name: the only URL available then would
   * carry the space DID, a bare fabric identifier that does not cross the
   * model boundary, so no URL is offered rather than a fabricated one.
   */
  url?: string;
}

export interface AssignSlugToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type AssignSlugToolOutput =
  | AssignSlugToolSuccessOutput
  | AssignSlugToolErrorOutput;

/**
 * Names a piece the caller holds a handle to: registers it in the space's
 * piece list and points `slug` — the named address a person opens — at it.
 * Naming is separate from creation on purpose: `run_pattern` always returns
 * a plain handle, and whether a piece deserves a public name is a decision
 * the caller can make later, about any piece it can reference, and revise by
 * naming a replacement under a fresh slug. A pending read or missing UI
 * refuses publication. These host-side checks return fixed diagnostics;
 * the values read and the address behind the token stay trusted-side.
 *
 * A slug rather than a free-text name because the slug is the only handle
 * the tool can set: what the piece list displays is the pattern's own `NAME`
 * result, which the pattern source carries and nothing outside it writes.
 */
export const assignSlugToolDescriptor: HarnessToolDescriptor = {
  toolId: "assign_slug",
  title: "Assign Slug",
  description:
    "Register the piece behind a handle token in the space's piece list and give it a named address a person can open. Use it after verifying a settled result and a UI; pending reads and data-only results cannot be named; a piece never named stays out of the list, which is what pure computation wants. A slug already naming another piece, or a collection, is refused rather than repointed.",
  effectClass: "side-effect",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description:
          "A handle token of the form cfh:a:<suffix> referring to a piece — a run_pattern resultRef, or any granted or discovered piece reference.",
      },
      slug: {
        type: "string",
        description:
          "Named address for the piece: lowercase letters, numbers, and single hyphens between words, at most 80 characters.",
      },
    },
    required: ["token", "slug"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      slug: { type: "string" },
      url: { type: "string" },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  },
  tags: ["fabric", "piece"],
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * What each `SlugResolutionError` code says about the name.
 *
 * `free` is a positive statement about what the space holds, arrived at by
 * reading it: the slug's document is absent, holds no usable redirect, or
 * redirects to something that is not a piece, and a name only ever competes
 * with a piece. `in-use` is equally positive the other way — the name
 * resolves to a collection, which is a thing a person opens, so assigning
 * over it would take the address away from whoever holds it.
 *
 * `unknown` is a failure to establish anything: a storage error, a sync that
 * never landed, a lost connection. `invalid` sits there too — the slug was
 * validated before this is asked, so a resolver calling it unusable means the
 * two disagree about the rule rather than that the space is empty.
 *
 * The map is total over the code union, so a code added to the resolver does
 * not compile until it is classified here. Totality is the point: only
 * `inside-piece` can reach this from an address with no path, and
 * `missing-member` is classified because it belongs to the same answer, not
 * because it arrives.
 */
const SLUG_CODE_STATES: Readonly<
  Record<
    NonNullable<SlugResolutionError["code"]>,
    "free" | "in-use" | "unknown"
  >
> = {
  invalid: "unknown",
  missing: "free",
  malformed: "free",
  "not-piece": "free",
  "missing-piece-id": "free",
  "inside-piece": "in-use",
  "missing-member": "in-use",
};

/**
 * Whether `slug` already names a piece in the session's space — and which —
 * whether it names something else a person opens, or whether that could not
 * be established at all.
 *
 * Assignment refuses a name that is already bound, so this asks first for a
 * different reason than the write does. The write's rule is "bound at all";
 * this one is "names a piece or a collection a person opens", and a name
 * whose document holds no usable redirect competes with nothing. Asking here
 * is what lets the refusal name which of the two it is.
 *
 * The answer is carried into the write as `takeFrom` rather than forced over
 * whatever is there. Forcing would spend the claim the assignment makes: two
 * calls that both read this name as free would both take it, and one would
 * overwrite the other silently — the very race the claim closes. Handing the
 * binding this rule was judged against to the transaction keeps the rule and
 * the claim at once, so a name bound under this call is refused by the write
 * even though this read called it free.
 *
 * That also makes an unanswered question a refusal rather than a "free": a
 * resolution that failed operationally says nothing about what the slug
 * holds, and treating it as vacancy would repoint a name this side never
 * established was free.
 *
 * The outcomes are told apart by the typed `code` `resolvePieceAddress`
 * carries on its `SlugResolutionError`, never by the message text.
 */
const slugAvailability = async (
  pieces: PiecesController,
  slug: string,
): Promise<
  | { state: "free"; binding: string | null }
  | { state: "taken"; pieceId: string }
  | { state: "in-use" }
  | { state: "unknown"; reason: string }
> => {
  // The binding this rule is about to be applied to, read before the rule
  // runs so that an answer of "free" and the state it was reached from are
  // the same observation. A binding that cannot be read is an unestablished
  // answer for the same reason a failed resolution is.
  let binding: string | null;
  try {
    binding = await readSlugBinding(pieces, slug);
  } catch (error) {
    return { state: "unknown", reason: errorMessage(error) };
  }
  try {
    const holder = await resolvePieceAddress(pieces, slug);
    return { state: "taken", pieceId: holder };
  } catch (error) {
    const state = error instanceof SlugResolutionError &&
        error.code !== undefined
      ? SLUG_CODE_STATES[error.code]
      : "unknown";
    // Only `unknown` carries the resolver's text. The other two are answers
    // about what the space holds, and their refusals name the caller's own
    // slug and nothing the caller did not already have.
    if (state === "unknown") return { state, reason: errorMessage(error) };
    return state === "free" ? { state, binding } : { state };
  }
};

/**
 * The URL a person opens for a named piece, or `undefined` when none can be
 * composed without inventing one. The address is the session's API URL, then
 * the space, then the slug — the same shape `cf piece new` prints. Only a
 * space configured by NAME yields one: a space configured by `did:key` would
 * put a bare fabric identifier in the URL, and that does not cross the model
 * boundary.
 */
export const namedPieceUrl = (
  pieces: PiecesController,
  slug: string,
): string | undefined => {
  const spaceName = pieces.getSpaceName();
  if (spaceName === undefined) {
    return undefined;
  }
  try {
    const url = new URL(pieces.runtime.apiUrl);
    const base = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    url.pathname = `${base}${encodeURIComponent(spaceName)}/${slug}`;
    return url.toString();
  } catch {
    return undefined;
  }
};

/**
 * Puts `cell` in the space's piece list unless the list already holds it.
 * Establishes the space root first because the registry belongs to it. The
 * registry's addPiece handler appends unconditionally, so membership is asked
 * first — by piece id over the registered list — rather than by re-adding and
 * hoping.
 */
const ensureRegistered = async (
  pieces: PiecesController,
  cell: Parameters<PiecesController["add"]>[0][number],
  targetId: string,
): Promise<void> => {
  await pieces.ensureDefaultPattern();
  const registered = await pieces.getRegisteredPieces();
  if (registered.some((piece) => piece.id === targetId)) {
    return;
  }
  await pieces.add([cell]);
};

export const assignSlugTool: HarnessToolDefinition<
  AssignSlugToolInput,
  AssignSlugToolOutput
> = {
  descriptor: assignSlugToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("assign_slug");
    const errorOutput = (message: string): AssignSlugToolErrorOutput => ({
      outputId,
      status: "error",
      message,
    });
    if (context.getFabricSession === undefined) {
      return errorOutput(
        "assign_slug requires a fabric session; run without one cannot name pieces",
      );
    }
    const ref = typeof input.token === "string" ? input.token.trim() : "";
    if (ref.length === 0) {
      return errorOutput("assign_slug requires a token naming a piece");
    }
    if (typeof input.slug !== "string") {
      return errorOutput("assign_slug requires a string slug");
    }
    let slug: string;
    try {
      slug = validateSlug(input.slug);
    } catch (error) {
      return errorOutput(
        `assign_slug slug is invalid: ${errorMessage(error)}`,
      );
    }
    let pieces: PiecesController;
    try {
      pieces = (await context.getFabricSession()).pieces;
    } catch (error) {
      return errorOutput(
        `assign_slug could not establish the fabric session: ${
          errorMessage(error)
        }`,
      );
    }
    const space = pieces.getSpace();
    let link;
    try {
      link = parseLLMFriendlyLink(
        ref.startsWith("/") ? ref : `/${ref}`,
        space,
      );
    } catch {
      return errorOutput(
        "assign_slug token does not name a reference this run holds",
      );
    }
    if (link.space !== space) {
      return errorOutput(
        "assign_slug can only name a piece in this run's own space",
      );
    }
    if (link.path.length > 0) {
      return errorOutput(
        "assign_slug token must name a piece itself, not a position inside one",
      );
    }
    const cell = pieces.runtime.getCellFromLink({
      ...link,
      schema: undefined,
    });
    try {
      await cell.sync();
    } catch (error) {
      return errorOutput(
        `assign_slug could not load the referenced piece: ${
          errorMessage(error)
        }`,
      );
    }
    // The same discriminators the slug resolver applies to what a slug
    // redirects to: a document with no pattern identity, or no piece id, is
    // not a piece, and naming it would put a dead entry in the piece list.
    const targetId = pieceId(cell);
    if (getPatternIdentityRef(cell) === undefined || targetId === undefined) {
      return errorOutput(
        "assign_slug token does not refer to a piece; only a piece can be named",
      );
    }
    const controller = new PieceController(pieces, cell);
    const pattern = await controller.getPattern({ projectResult: false });
    const result = pieces.getResult(cell);
    const value = await controller.result.get();
    if (
      observedOutputsIn(value, pattern.resultSchema)
        .some((output) => output.concern.concern === "pending")
    ) {
      return errorOutput(
        "assign_slug cannot name a piece whose read is pending. Read the same piece again and verify its settled result before naming it.",
      );
    }
    const ui = result.asSchema(uiSchema);
    await ui.pull();
    const rendered = ui.get();
    if (!isObjectNotArray(rendered) || rendered[UI] == null) {
      return errorOutput(
        "assign_slug cannot confirm a UI on this piece. Keep data-only probes unnamed; name the user-facing page after verifying it.",
      );
    }
    const successOutput = (): AssignSlugToolSuccessOutput => {
      context.recordAssignedPiece?.({
        slug,
        ref: createLLMFriendlyLink(cell.getAsNormalizedFullLink()),
      });
      const url = namedPieceUrl(pieces, slug);
      return {
        outputId,
        status: "ok",
        slug,
        ...(url !== undefined ? { url } : {}),
      };
    };
    const availability = await slugAvailability(pieces, slug);
    if (availability.state === "taken") {
      if (availability.pieceId === targetId) {
        // The name already points where the caller is pointing it, so the
        // request is already true, and saying so beats refusing it. The
        // contract's other half still has to hold: a slug can point at a
        // piece the registry does not list — a pre-existing name, a naming
        // interrupted between its two steps — so membership is ensured
        // before answering, without duplicating an entry that is there.
        try {
          await ensureRegistered(pieces, cell, targetId);
        } catch (error) {
          return errorOutput(
            `assign_slug failed while listing the piece: ${
              errorMessage(error)
            }`,
          );
        }
        return successOutput();
      }
      return errorOutput(
        `assign_slug slug "${slug}" already names another piece in this space, and assigning would repoint that address. Choose another slug.`,
      );
    }
    if (availability.state === "in-use") {
      return errorOutput(
        `assign_slug slug "${slug}" already names a collection in this space, and assigning would repoint that address. Choose another slug.`,
      );
    }
    if (availability.state === "unknown") {
      return errorOutput(
        `assign_slug could not establish whether slug "${slug}" is available: ${availability.reason}. Nothing was assigned. Try the same call again.`,
      );
    }
    // The registry join goes first, so a failure between the two leaves a
    // listed-but-unnamed piece — visible and reachable by its handle —
    // rather than an orphan name pointing outside the list. Membership is
    // ensured rather than appended: a retry after exactly that failure must
    // not list the piece twice.
    //
    // Its own try, because what the two failures leave behind differs: this
    // one leaves nothing, and the refusals below leave a listed piece. A
    // sentence attached to the catch rather than to the state it describes
    // would say the piece is listed when the listing is what failed.
    try {
      await ensureRegistered(pieces, cell, targetId);
    } catch (error) {
      return errorOutput(
        `assign_slug failed while listing the piece: ${errorMessage(error)}`,
      );
    }
    try {
      await assignSlug(pieces, cell, slug, { takeFrom: availability.binding });
    } catch (error) {
      // The name was bound between this call's reading of it and its write,
      // so the answer is the same one a name found taken gets, and for the
      // same reason: assigning now would repoint an address someone holds.
      // The registry join above has already committed, so every refusal from
      // here reports what it left: the name was not assigned, and the piece
      // is listed. A caller told "nothing was assigned" would read that as
      // all-or-nothing and never look for the piece it did not mean to list.
      if (error instanceof SlugAssignedError) {
        return errorOutput(
          `assign_slug slug "${slug}" was taken while this call was ` +
            `deciding, and assigning would repoint that address. The slug ` +
            `was not assigned and the piece is listed in this space. Choose ` +
            `another slug.`,
        );
      }
      // The name moved the other way and now points nowhere, so nobody is
      // holding it and the answer is the one an unestablished availability
      // gets: read it again rather than choose another name.
      if (error instanceof SlugReleasedError) {
        return errorOutput(
          `assign_slug slug "${slug}" changed while this call was deciding ` +
            `and now names nothing. The slug was not assigned and the piece ` +
            `is listed in this space. Try the same call again.`,
        );
      }
      return errorOutput(
        `assign_slug failed while naming the piece: ${
          errorMessage(error)
        }. The piece is listed in this space.`,
      );
    }
    return successOutput();
  },
};
