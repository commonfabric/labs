/** Resolves a user-named piece in the session's space to an opaque reference. */

import { resolvePieceAddress, SlugResolutionError } from "@commonfabric/piece";

import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import {
  checkNamedPieceAddressSpace,
  parseNamedPieceAddress,
} from "../input-cells.ts";
import type { HarnessToolDefinition } from "./types.ts";

/** An exact slug, optionally qualified by the session's space name. */
export interface ResolvePieceToolInput {
  slug: string;
}

/** Resolution returns an address for the ordinary outbound handle boundary. */
export type ResolvePieceToolOutput =
  | { outputId: string; status: "ok"; resultRef: string }
  | {
    outputId: string;
    status: "error";
    code: "invalid-address" | "foreign-space" | "not-found" | "unavailable";
    message: string;
  };

/** Parent discovery of an exact piece address, with values and source kept in Fabric. */
export const resolvePieceToolDescriptor: HarnessToolDescriptor = {
  toolId: "resolve_piece",
  title: "Resolve Piece",
  description:
    "Resolve a piece slug supplied by the user to a handle in this session's space. Call this before author delegation or a registry lookup when the user names a piece, including when answering a question in the same conversation. Accepts a bare slug or pattern:<space>/<slug>; this resolves an exact address, not a display name or fuzzy match. Pass the returned resultRef to the pattern-author child to read or revise the piece. A missing or refused address is a reason to ask for the exact slug or an attachment, not to author a name matcher. Returns no source or piece values.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      slug: {
        type: "string",
        description:
          "Exact piece slug or pattern:<space>/<slug> supplied by the user.",
      },
    },
    required: ["slug"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      resultRef: { type: "string" },
      code: {
        enum: ["invalid-address", "foreign-space", "not-found", "unavailable"],
      },
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  },
  tags: ["fabric", "piece"],
};

/** Uses the same exact-address resolver as operator-supplied input cells. */
export const resolvePieceTool: HarnessToolDefinition<
  ResolvePieceToolInput,
  ResolvePieceToolOutput
> = {
  descriptor: resolvePieceToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("resolve_piece");
    const error = (
      code: Extract<ResolvePieceToolOutput, { status: "error" }>["code"],
      message: string,
    ): ResolvePieceToolOutput => ({ outputId, status: "error", code, message });
    let address;
    try {
      address = typeof input.slug === "string"
        ? parseNamedPieceAddress(input.slug)
        : undefined;
    } catch {
      address = undefined;
    }
    if (address === undefined) {
      return error(
        "invalid-address",
        "Use an exact piece slug or pattern:<space>/<slug>.",
      );
    }
    if (context.getFabricSession === undefined) {
      return error(
        "unavailable",
        "This run has no Fabric session for resolving a piece.",
      );
    }
    let session;
    try {
      session = await context.getFabricSession();
    } catch {
      return error(
        "unavailable",
        "The Fabric session could not be opened to resolve the piece.",
      );
    }
    const spaceName = session.pieces.getSpaceName();
    if (address.spaceName !== undefined && spaceName === undefined) {
      return error(
        "unavailable",
        "This session has no space name to check the qualified address against. Supply the piece's bare slug in this session's space.",
      );
    }
    try {
      checkNamedPieceAddressSpace(address, spaceName);
    } catch {
      return error(
        "foreign-space",
        "That address names another space. Only pieces in this session's space can be resolved.",
      );
    }
    try {
      const pieceId = await resolvePieceAddress(session.pieces, address.slug);
      return { outputId, status: "ok", resultRef: `/of:${pieceId}` };
    } catch (cause) {
      if (cause instanceof SlugResolutionError) {
        switch (cause.code) {
          case "missing":
          case "malformed":
          case "not-piece":
          case "inside-piece":
          case "missing-member":
          case "missing-piece-id":
            return error(
              "not-found",
              "That slug does not resolve to a usable piece in this session's space. Ask for its exact slug or an attachment.",
            );
        }
      }
      return error(
        "unavailable",
        "The piece address could not be checked. Ask the user to attach the piece; do not infer that it is absent.",
      );
    }
  },
};
