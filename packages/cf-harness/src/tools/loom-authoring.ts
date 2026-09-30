/**
 * Composes durable Loom collections through a host-owned command transport.
 * Pattern Instance addresses are resolved from held tokens on the trusted side;
 * model-visible inspection describes layout without granting new cell handles.
 */

import { getPatternIdentityRef } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { pieceId } from "@commonfabric/piece";
import type { JSONSchema } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { parseHandleRef, resolveHandleToken } from "../handle-table.ts";
import {
  executeLoomAuthoringCommand,
  type LoomAuthoringCommand,
} from "../loom-authoring.ts";
import type { HarnessToolContext, HarnessToolDefinition } from "./types.ts";

/** A requested addition, with one ordinary reference or one held pattern token. */
export interface LoomComposeComponent {
  /** A typed non-Fabric object reference, validated by the Loom host. */
  ref?: string;

  /** A held whole Pattern Instance address, resolved by the host. */
  pattern_token?: string;

  /** Human-facing component label. */
  title?: string;

  /** Whether to place this component on stage. */
  stage?: boolean;

  /** Whether to focus this component. */
  focus?: boolean;
}

/** One logical composition; retries retain every field and the request key. */
export interface LoomComposeToolInput {
  /** Stable key chosen for this logical request, retained across retries. */
  request_id: string;

  /** Title when creating a collection. */
  title?: string;

  /** Ordered additions to the collection. */
  components: LoomComposeComponent[];

  /** Existing Loom to extend; absence creates a new collection. */
  loom_id?: string;

  /** Version guard for an existing Loom. */
  expected_version?: number;
}

/** An exact inspection target or an optional authoring-context override. */
export interface LoomReadToolInput {
  /** Canonical Loom identifier supplied by a person or a previous receipt. */
  loom_id?: string;
}

/** A tool observation whose success always originates at the configured host. */
export type LoomAuthoringToolOutput =
  | { outputId: string; status: "ok"; [key: string]: unknown }
  | {
    outputId: string;
    status: "error";
    message: string;
    mayHaveCommitted: boolean;
    code?: string;
  };

/** Helper for projection, which recognizes decoded JSON objects. */
const record = (value: unknown): Record<string, unknown> =>
  isObjectNotArray(value) ? value as Record<string, unknown> : {};

/** Helper for projection, which picks named fields without expanding a schema. */
const pick = (value: unknown, keys: readonly string[]) => {
  const source = record(value);
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((
      key,
    ) => [key, source[key]]),
  );
};

/**
 * Helper for evidence projection, which omits displacement title fallbacks:
 * the daemon may use an unlabelled component's raw Pattern Instance reference.
 */
const projectReceipt = (value: unknown) => ({
  ...pick(value, [
    "loom_id",
    "request_id",
    "version",
    "created",
    "component_ids",
    "operation_ids",
  ]),
  displaced: Array.isArray(record(value).displaced)
    ? (record(value).displaced as unknown[]).map((item) =>
      pick(item, ["component_id"])
    )
    : [],
});

/**
 * Helper for inspection, which describes existing layout without returning
 * renderer URLs, resolver internals, or cell references the run does not hold.
 */
const projectManifest = (value: unknown) => {
  const manifest = record(value);
  return {
    ...pick(manifest, [
      "loom_id",
      "title",
      "version",
      "archived",
      "starred",
      "staged",
      "focused",
    ]),
    components: Array.isArray(manifest.components)
      ? manifest.components.map((item: unknown) => {
        const component = record(item);
        const ref = record(component.subject).ref;
        const kind = typeof ref === "string" ? ref.split(":", 1)[0] : undefined;
        return {
          ...pick(component, ["component_id", "title"]),
          ...(kind !== undefined
            ? { reference_kind: kind === "piece" ? "pattern" : kind }
            : {}),
        };
      })
      : [],
  };
};

/**
 * Helper for composition, which accepts only held whole Pattern Instances in
 * the session's own space. Restricted skill handles never grant composition.
 */
const patternReference = async (
  context: HarnessToolContext,
  token: string,
): Promise<string> => {
  const entry = context.handleTable === undefined
    ? undefined
    : resolveHandleToken(context.handleTable, token);
  if (entry === undefined || entry.capability !== undefined) {
    throw new Error("Use a general Pattern Instance token this run holds.");
  }
  if (context.getFabricSession === undefined) {
    throw new Error("Pattern Instance composition requires a Fabric session.");
  }
  const { pieces } = await context.getFabricSession();
  const space = pieces.getSpace();
  const link = parseHandleRef(entry.ref);
  if (
    (link.space !== undefined && link.space !== space) ||
    link.path.length > 0 || link.scope !== "space"
  ) {
    throw new Error("Use a whole Pattern Instance in this run's own space.");
  }
  const cell = pieces.runtime.getCellFromLink({
    ...link,
    space,
    schema: undefined,
  });
  await cell.sync();
  const id = pieceId(cell);
  if (id === undefined || getPatternIdentityRef(cell) === undefined) {
    throw new Error("The held token does not identify a Pattern Instance.");
  }
  return `pattern:${space}/${id}`;
};

/** Helper for deployment binding, which normalizes an HTTP API base URL. */
const apiBase = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash
    ) return undefined;
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
};

/**
 * Helper for context, which admits at most 32 successful host deployments
 * bound to this Fabric session and verified as whole Pattern Instances.
 * Canonical links enter the prompt loop's persisted handle projection.
 */
const deployedPatterns = async (
  context: HarnessToolContext,
  value: unknown,
): Promise<{ pattern_token: string }[]> => {
  const receipts = record(value).receipts;
  const target = context.fabricSessionTarget;
  const api = apiBase(target?.apiUrl);
  if (
    !Array.isArray(receipts) || context.getFabricSession === undefined ||
    target === undefined || api === undefined
  ) return [];
  const output: { pattern_token: string }[] = [];
  const seen = new Set<string>();
  for (const candidate of receipts.slice(0, 32)) {
    const receipt = record(candidate);
    if (
      receipt.schema !== "loom-deployed-pattern-v1" ||
      apiBase(receipt.api_url) !== api ||
      typeof receipt.piece_id !== "string" ||
      !/^fid1:[A-Za-z0-9_-]{43}$/.test(receipt.piece_id)
    ) continue;
    try {
      const { pieces } = await context.getFabricSession();
      const space = pieces.getSpace();
      if (receipt.space !== target.space && receipt.space !== space) continue;
      if (seen.has(receipt.piece_id)) continue;
      seen.add(receipt.piece_id);
      const cell = pieces.runtime.getCellFromLink({
        ...parseHandleRef(`/of:${receipt.piece_id}`),
        space,
        schema: undefined,
      });
      await cell.sync();
      if (
        pieceId(cell) !== receipt.piece_id ||
        getPatternIdentityRef(cell) === undefined
      ) continue;
      const link = createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space);
      const held = context.handleTable?.entries.filter((entry) => {
        const address = parseHandleRef(entry.ref);
        return address.id === `of:${receipt.piece_id}` &&
          address.path.length === 0 && address.scope === "space" &&
          (address.space === undefined || address.space === space);
      }) ?? [];
      if (held.some((entry) => entry.capability !== undefined)) continue;
      output.push({ pattern_token: held[0]?.token ?? link });
    } catch {
      // Unavailable deployment cells do not prevent ordinary Loom recovery.
    }
  }
  return output;
};

/**
 * Helper for the three tools, which projects only their public observation.
 * A started host command settles even when the model turn is cancelled; a
 * receipt reports that settlement, and unreadable outcomes remain uncertain.
 */
const invoke = async (
  context: HarnessToolContext,
  command: LoomAuthoringCommand,
  input: LoomComposeToolInput | LoomReadToolInput,
): Promise<LoomAuthoringToolOutput> => {
  const outputId = context.nextOutputId(command.replaceAll(".", "_"));
  const fail = (
    message: string,
    mayHaveCommitted = false,
  ): LoomAuthoringToolOutput => ({
    outputId,
    status: "error",
    message,
    mayHaveCommitted,
  });
  if (context.loomAuthoring === undefined) {
    return fail("This run has no host Loom authoring configuration.");
  }
  if (context.signal?.aborted) {
    return fail("The turn was cancelled before the host command.");
  }
  let args: Record<string, unknown> = { ...input };
  if (command === "loom.compose") {
    const components = record(input).components;
    if (
      !Array.isArray(components) || components.length < 1 ||
      components.length > 100
    ) {
      return fail("Composition requires 1–100 components.");
    }
    const normalized: Record<string, unknown>[] = [];
    for (const value of components) {
      const item = record(value);
      if (
        Object.keys(item).some((key) =>
          !["ref", "pattern_token", "title", "stage", "focus"].includes(key)
        )
      ) {
        return fail(
          "A component accepts a reference, title, stage, and focus only.",
        );
      }
      if ((item.ref !== undefined) === (item.pattern_token !== undefined)) {
        return fail("Give each component exactly one ref or pattern_token.");
      }
      if (item.pattern_token !== undefined) {
        if (typeof item.pattern_token !== "string") {
          return fail("A pattern_token must be a held token.");
        }
        try {
          const ref = await patternReference(context, item.pattern_token);
          const { pattern_token: _token, ...rest } = item;
          normalized.push({ ...rest, ref });
        } catch {
          return fail(
            "Use a held, unrestricted whole Pattern Instance in this run's own space.",
          );
        }
      } else {
        if (
          typeof item.ref !== "string" ||
          !/^(page|artifact|url|person|thread|moment|loom|wish|intention|chat|run):/
            .test(item.ref)
        ) {
          return fail(
            "Use a supported typed Loom object reference; Pattern Instances require pattern_token.",
          );
        }
        normalized.push(item);
      }
    }
    args = { ...args, components: normalized };
  }
  if (context.signal?.aborted) {
    return fail("The turn was cancelled before the host command.");
  }
  const response = await executeLoomAuthoringCommand(
    context.loomAuthoring,
    command,
    args,
    context.hostProcessRunner,
  );
  if (response.status === "error") {
    if (response.code !== undefined) {
      const recovery = response.code === "version-conflict"
        ? "Inspect the target's current version, then reconsider the change. A revised composition uses a new request_id."
        : response.code === "request-conflict"
        ? "This request_id already names different committed arguments. Recover the original receipt with loom_authoring_context or replay its original arguments; use a new key only for new work."
        : "Correct the command's target or input fields before submitting it again.";
      return { ...fail(recovery), code: response.code };
    }

    // Transport errors may quote internal references. The tool's retry contract
    // is sufficient to recover without disclosing those host-only details.
    return fail(
      response.mayHaveCommitted
        ? "The host did not return verifiable commit evidence. Retry the identical composition with the same request_id; do not claim it failed to commit."
        : "The host rejected the command. Check its target and input fields.",
      response.mayHaveCommitted,
    );
  }
  const result = response.result;
  if (command === "loom.compose") {
    return {
      outputId,
      status: "ok",
      kind: "loom-authored",
      receipt: projectReceipt(result.receipt),
      replayed: result.replayed,
      displaced: result.replayed === true
        ? []
        : projectReceipt(result.receipt).displaced,
      current_version: record(result.manifest).version,
    };
  }
  if (command === "loom.inspect") {
    return {
      outputId,
      status: "ok",
      kind: "manifest",
      manifest: projectManifest(result.manifest),
    };
  }
  return {
    outputId,
    status: "ok",
    kind: "authoring-context",
    historical: true,
    ...pick(result, ["run_scoped", "truncated"]),
    bound_loom: result.bound_loom === null ? null : pick(result.bound_loom, [
      "loom_id",
      "version",
      "archived",
      "source",
      "available",
    ]),
    authored: (result.authored as unknown[]).map((entry) => ({
      receipt: projectReceipt(record(entry).receipt),
    })),
    deployed_patterns: await deployedPatterns(
      context,
      result.deployed_patterns,
    ),
  };
};

/** An exact durable Loom identifier; targets never change the host's identity. */
const targetSchema: JSONSchema = {
  type: "string",
  pattern: "^loom-[a-f0-9]{16}$",
};

/** Composes a collection with a host-verified durable receipt. */
export const loomComposeTool: HarnessToolDefinition<
  LoomComposeToolInput,
  LoomAuthoringToolOutput
> = {
  descriptor: {
    toolId: "loom_compose",
    title: "Compose Loom",
    effectClass: "write",
    description:
      "Create or extend a durable Loom collection of existing objects and held Pattern Instances. Choose one logical request_id and retain every argument on retry. Inspect an existing target before extending it with expected_version. A receipt proves a commit, not that every component renders. Report only the current displaced component ids; receipt.displaced is historical and a replay performs no new displacement.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["request_id", "components"],
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string" },
        loom_id: targetSchema,
        expected_version: { type: "integer", minimum: 1 },
        components: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              ref: {
                type: "string",
                description:
                  "An existing page:, artifact:, url:, person:, thread:, moment:, loom:, wish:, intention:, chat:, or run: reference. The host validates its grammar and binding. Mutually exclusive with pattern_token.",
              },
              pattern_token: {
                type: "string",
                description:
                  "A held cfh:a: token naming a whole Pattern Instance; mutually exclusive with ref.",
              },
              title: { type: "string" },
              stage: { type: "boolean" },
              focus: { type: "boolean" },
            },
          },
        },
      },
    },
    tags: ["loom"],
  },
  invoke: (context, input) => invoke(context, "loom.compose", input),
};

/** Inspects the target's current layout without granting its referenced cells. */
export const loomInspectTool: HarnessToolDefinition<
  LoomReadToolInput,
  LoomAuthoringToolOutput
> = {
  descriptor: {
    toolId: "loom_inspect",
    title: "Inspect Loom",
    effectClass: "read",
    description:
      "Read the current version and layout of one exact Loom before extending it. Component metadata grants no Pattern Instance handles and does not prove live rendering.",
    inputSchema: {
      type: "object",
      properties: { loom_id: targetSchema },
      required: ["loom_id"],
      additionalProperties: false,
    },
    tags: ["loom"],
  },
  invoke: (context, input) => invoke(context, "loom.inspect", input),
};

/** Reads bounded historical receipts and a separate explicitly bound target. */
export const loomAuthoringContextTool: HarnessToolDefinition<
  LoomReadToolInput,
  LoomAuthoringToolOutput
> = {
  descriptor: {
    toolId: "loom_authoring_context",
    title: "Loom Authoring Context",
    effectClass: "read",
    description:
      "Recover up to 32 historical receipts for this host-owned run identity and its separately bound Loom. Successful Pattern deployments from this run can provide held pattern_token values for loom_compose. History is not newly authored work and never selects an implicit target. An explicit loom_id overrides only the context target. Inspect the exact chosen target before editing.",
    inputSchema: {
      type: "object",
      properties: { loom_id: targetSchema },
      additionalProperties: false,
    },
    tags: ["loom"],
  },
  invoke: (context, input) => invoke(context, "loom.authoring-context", input),
};
