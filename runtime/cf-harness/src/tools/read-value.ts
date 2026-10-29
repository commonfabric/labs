/**
 * `read_value` hands the model the value behind a handle the run holds — the
 * one tool whose answer is a fabric value itself rather than its shape or a
 * reference to it.
 *
 * Two things bound it. A handle is read only once `describe_handle` has
 * answered for it in this run, so a value is read after its shape was looked
 * at rather than instead of looking; the prompt loop records that answer on
 * the handle's entry. And what is read is measured the way a `call_verb` or
 * `run_pattern` result is before it is released: through a transaction of its
 * own, against the run's release ceiling, with the model as the sink. Where
 * the run's posture refuses it, the refusal names the atoms that kept it back
 * and the route that can still use the value — a subagent that reads it and
 * returns what the task needs. Where it is released, the label of what was
 * read travels on the output, and the prompt loop joins it into the run's
 * model context, so everything the model writes afterwards carries it.
 *
 * A piece's derived fields live in documents its run writes, so a read that
 * lands in one no run has written runs the piece first, as `call_verb` does,
 * where the run is authorized for side effects.
 * "Holds nothing at that path" is then a statement about the path rather than
 * about a piece nobody ran.
 */

import type { JSONSchema } from "@commonfabric/api";
import {
  type Cell,
  getPatternIdentityRef,
  type MemorySpace,
  type NormalizedFullLink,
  type Runtime,
} from "@commonfabric/runner";
import {
  cfcLabelViewForCellFailClosedWithStatus,
  CfcReadCeilingError,
  collectConsumedLabel,
  describeSinkReleaseRefusal,
  type IFCLabel,
} from "@commonfabric/runner/cfc";
import { entityKindOfIdString } from "@commonfabric/runner/entity-kind";
import {
  createLLMFriendlyLink,
  parseLLMFriendlyLink,
} from "@commonfabric/runner/shared";
import { disclosedCfcLabels } from "../cfc-label-disclosure.ts";
import type { HarnessToolDescriptor } from "../contracts/tool-descriptor.ts";
import { errorMessage } from "../error-message.ts";
import { scrubBareFabricIdentifiers } from "../fabric-identifier-scrub.ts";
import {
  admitsFabricReference,
  type HarnessForeignSpaces,
} from "../foreign-spaces.ts";
import { resolveHandleRef, resolveHandleToken } from "../handle-table.ts";
import { replacedAt, storedLinkPaths } from "./call-verb.ts";
import { sessionPieces } from "./piece-source.ts";
import { asSerializableValue } from "./run-pattern.ts";
import type { HarnessToolDefinition } from "./types.ts";

export interface ReadValueToolInput {
  token: string;

  /** A path within the value, its segments separated by `/`. */
  select?: string;
}

export interface ReadValueToolSuccessOutput {
  outputId: string;
  status: "ok";

  /** The handle that was read, echoed so a reply stands on its own. */
  token: string;

  /**
   * The value, as stored. A position holding a link to another document comes
   * back as `{"@link": <address>}`, which reaches the model as that
   * document's handle token.
   */
  value: unknown;

  /**
   * The label of what was read. The prompt loop moves it into the run's
   * model context and keeps it off the model-facing output.
   */
  cfc: { version: 1; observedLabel?: IFCLabel };
}

export interface ReadValueToolErrorOutput {
  outputId: string;
  status: "error";
  message: string;
}

export type ReadValueToolOutput =
  | ReadValueToolSuccessOutput
  | ReadValueToolErrorOutput;

/** The sink a read value is released to, named in a release refusal. */
const READ_VALUE_SINK = "read_value";

/**
 * Whether the position `select` names under `link` lands in a derived
 * document no run has derived. A piece's derived fields live in `computed:`
 * documents its run writes, so until the piece has run somewhere the store
 * holds no record of one, and a read there finds nothing however real the
 * path is. A position this cannot settle — one the read ceiling withholds,
 * or in a space the run may not read — is left to the measured read, which
 * says what stopped it.
 */
const landsUnderived = async (
  runtime: Runtime,
  link: NormalizedFullLink,
  select: readonly string[],
  sessionSpace: MemorySpace,
  foreignSpaces: HarnessForeignSpaces,
): Promise<boolean> => {
  try {
    const selected = runtime.getCellFromLink({
      ...link,
      path: [...link.path, ...select],
      schema: undefined,
    });
    await selected.pull();
    const at = selected.resolveAsCell().getAsNormalizedFullLink();
    if (
      entityKindOfIdString(at.id) !== "computed" ||
      !admitsFabricReference(at.space, sessionSpace, foreignSpaces)
    ) {
      return false;
    }
    const document = runtime.getCellFromLink({
      ...at,
      path: [],
      schema: undefined,
    });
    await document.pull();
    return document.getRaw() === undefined;
  } catch {
    return false;
  }
};

/**
 * The confidentiality atom types `cell` carries, for a refusal to name. A
 * label that cannot be read names nothing.
 */
const confidentialityAtoms = (cell: Cell<unknown> | undefined): string[] =>
  cell === undefined ? [] : [
    ...new Set(
      disclosedCfcLabels(cfcLabelViewForCellFailClosedWithStatus(cell).view)
        .flatMap((label) => label.confidentiality.flat()),
    ),
  ];

export const readValueToolDescriptor: HarnessToolDescriptor = {
  toolId: "read_value",
  title: "Read Value",
  description:
    "Return the value behind a described handle token this run holds, as stored, with a position linking to another document returned as that document's handle token.",
  effectClass: "read",
  inputSchema: {
    type: "object",
    properties: {
      token: {
        type: "string",
        description: "A handle token of the form cfh:a:<suffix>.",
      },
      select: {
        type: "string",
        description: "A path within the value, such as items/0/title.",
      },
    },
    required: ["token"],
    additionalProperties: false,
  } satisfies JSONSchema,
  outputSchema: {
    type: "object",
    properties: {
      outputId: { type: "string" },
      status: { enum: ["ok", "error"] },
      token: { type: "string" },
      value: {},
      message: { type: "string" },
    },
    required: ["outputId", "status"],
    additionalProperties: false,
  } satisfies JSONSchema,
  tags: ["fabric", "handle", "read"],
};

export const readValueTool: HarnessToolDefinition<
  ReadValueToolInput,
  ReadValueToolOutput
> = {
  descriptor: readValueToolDescriptor,
  async invoke(context, input) {
    const outputId = context.nextOutputId("read_value");
    const fail = (message: string): ReadValueToolErrorOutput => ({
      outputId,
      status: "error",
      message: scrubBareFabricIdentifiers(message),
    });
    const handle = typeof input.token === "string" ? input.token.trim() : "";
    if (handle.length === 0) {
      return fail("read_value requires a handle token");
    }
    // A token reaches a tool as the address it stands for, so holding the
    // handle is what tells a delegated reference from a composed one.
    const table = context.handleTable;
    const entry = table === undefined
      ? undefined
      : resolveHandleToken(table, handle) ?? resolveHandleRef(table, handle);
    if (entry === undefined || entry.capability !== undefined) {
      return fail("read_value can only read a handle this run holds");
    }
    if (entry.described !== true) {
      return fail(
        `describe it first: run describe_handle on ${entry.token}, then read_value`,
      );
    }
    const select = typeof input.select === "string"
      ? input.select.split("/").filter((segment) => segment.length > 0)
      : [];

    const session = await sessionPieces("read_value", context);
    if (!session.ok) return fail(session.message);
    const { pieces } = session;
    const space = pieces.getSpace();
    let link;
    try {
      link = parseLLMFriendlyLink(
        entry.ref.startsWith("/") ? entry.ref : `/${entry.ref}`,
        space,
      );
    } catch {
      return fail("read_value can only read a handle this run holds");
    }
    if (!admitsFabricReference(link.space, space, session.foreignSpaces)) {
      return fail(
        "read_value can only read this run's space or one the run was admitted to",
      );
    }

    const { runtime } = pieces;
    const releaseTx = runtime.edit();
    let value: unknown;
    let refusal: string | undefined;
    let observedLabel: IFCLabel | undefined;
    let measured: Cell<unknown> | undefined;
    try {
      // A derived value is the piece's to produce, so a read that lands where
      // no run has produced it runs the piece, as `call_verb` does, and reads
      // what the run derives. Only a piece can be run: a handle on the
      // derived document itself names no piece, and says so.
      if (
        await landsUnderived(
          runtime,
          link,
          select,
          space,
          session.foreignSpaces,
        )
      ) {
        const piece = runtime.getCellFromLink({
          ...link,
          path: [],
          schema: undefined,
        });
        await piece.sync();
        if (getPatternIdentityRef(piece) === undefined) {
          return fail(
            `${entry.token} is a value its piece derives, and it holds none until that piece runs; read it through the piece's handle, which runs the piece`,
          );
        }
        // Running the piece commits what it derives and fires what its
        // builtins send, so it waits on the authorization a side effect
        // needs, even though the read itself does not.
        if (context.sideEffectsAuthorized !== true) {
          return fail(
            `${entry.token} holds a value its piece derives, and the piece has not run; running it is a side effect this run is not authorized for. A run under a direct command reads it, which runs the piece`,
          );
        }
        await runtime.startWithCommit(piece);
        await runtime.idle();
      }
      // A link at the position itself is followed, so a piece's field reads
      // as the value it aliases. Links within that value stay links. The
      // position is pulled before it is resolved: a resolution stops at a
      // document this replica has not loaded yet, which every link the
      // selected path crosses can be.
      const selected = runtime.getCellFromLink({
        ...link,
        path: [...link.path, ...select],
        schema: undefined,
      }).withTx(releaseTx);
      measured = selected;
      await selected.pull();
      const read = selected.resolveAsCell();
      measured = read;
      // Following the link widens nothing: the value it lands on must be in
      // a space the run may read, as the handle's own space had to be.
      const at = read.getAsNormalizedFullLink();
      if (!admitsFabricReference(at.space, space, session.foreignSpaces)) {
        return fail(
          "read_value can only read this run's space or one the run was admitted to",
        );
      }
      await read.pull();
      const denied = runtime.storageManager.authorizationError?.(link.space);
      if (denied !== undefined) return fail(denied.message);
      const raw = read.getRaw();
      if (raw === undefined) {
        return fail(`${entry.token} holds nothing at that path`);
      }
      value = asSerializableValue(raw);
      for (const path of storedLinkPaths(raw)) {
        const target = runtime.getCellFromLink({
          ...at,
          path: [...at.path, ...path.map(String)],
        }).withTx(releaseTx).resolveAsCell().getAsNormalizedFullLink();
        value = replacedAt(value, path, {
          "@link": createLLMFriendlyLink(target, space),
        });
      }
      const releaseGateRejects = runtime.cfcEnforcementMode !== "disabled" &&
        runtime.cfcEnforcementMode !== "observe";
      refusal = releaseGateRejects
        ? describeSinkReleaseRefusal(releaseTx, releaseTx, READ_VALUE_SINK, [])
          ?.reason
        : undefined;
      const { confidentiality } = collectConsumedLabel(releaseTx);
      observedLabel = confidentiality.length > 0
        ? { confidentiality: [...confidentiality] }
        : undefined;
    } catch (error) {
      // The session's read ceiling withholds a value before any release is
      // measured, and binds every reader the session runs, so the refusal
      // says which limit held rather than offering a route around it.
      if (error instanceof CfcReadCeilingError) {
        const atoms = confidentialityAtoms(measured).join(", ");
        return fail(
          `the value was withheld: its label${
            atoms === "" ? "" : ` (${atoms})`
          } is above this session's read ceiling; describe_handle lists the labels ${entry.token} carries`,
        );
      }
      return fail(
        `read_value could not read ${entry.token}: ${errorMessage(error)}`,
      );
    } finally {
      releaseTx.abort("read_value release measurement");
    }
    if (refusal !== undefined) {
      return fail(
        `the value was withheld: what it carries is above this run's release ceiling (${refusal}). delegate_task can hand ${entry.token} to a subagent that reads it and returns what the task needs.`,
      );
    }
    return {
      outputId,
      status: "ok",
      token: entry.token,
      value,
      cfc: {
        version: 1,
        ...(observedLabel !== undefined ? { observedLabel } : {}),
      },
    };
  },
};
