/**
 * Input cells: references supplied by the operator or retained from a
 * completed session turn that named a piece. They exist in the fabric before
 * the run starts. Each becomes a handle-table entry at run start. The handle
 * names a cell to a model that cannot hold addresses, so the run's
 * inputs reach the model as tokens from its first turn. The values stay in
 * their cells; what the model receives is a token and the host-supplied
 * name for it. This is the calling convention the CT-2066 demonstration
 * rests on — a prompt that never holds a literal value cannot inline one by
 * accident, and cannot pass one on by accident either.
 *
 * Like a well-known grant, an input cell discloses nothing by itself: the
 * address stays trusted-side in the handle table, `describe_handle` answers
 * shape, and reading anything behind the token means running a pattern over
 * it. An input cell names a task target, so
 * one that cannot be minted — an unparseable reference, or one targeting
 * an unadmitted space — fails the run out loud rather than proceeding without
 * it.
 *
 * A cell may also be named the way a person sees it named — a piece's slug,
 * alone or qualified by its space — and the session resolves that name to an
 * address before minting. A surface holding a rendered piece holds its name
 * and not the id behind it, so the alternative to resolving here is every such
 * surface deriving fabric ids of its own, which is one copy of the runtime's
 * addressing rules per client.
 */

import { type MemorySpace, validateSlug } from "@commonfabric/runner";
import { AGENT_INPUT_NAME_PATTERN } from "@commonfabric/runner/agent-run";
import {
  admitsFabricReference,
  type HarnessForeignSpaces,
} from "./foreign-spaces.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  parseHandleRef,
} from "./handle-table.ts";
import type { HarnessHandleTable } from "./contracts/handle-table.ts";
import type {
  HarnessInputCell,
  HarnessInputCellSpec,
} from "./contracts/input-cells.ts";

export type {
  HarnessInputCell,
  HarnessInputCellSpec,
} from "./contracts/input-cells.ts";

/**
 * A handle's name is the whole of what a model is told the token stands for,
 * so it is held to a shape that cannot smuggle structure: word characters and
 * hyphens. Connector connection identities have their own name grammar in
 * `well-known-grants.ts`.
 */
export const HANDLE_NAME_PATTERN = AGENT_INPUT_NAME_PATTERN;

/** A parsed `--input-cell` argument. */
export interface ParsedInputCellArgument {
  name: string;
  ref: string;
}

/**
 * A piece named the way a person sees it named, rather than by the address
 * behind it: `pattern:<space>/<slug>`, or the bare `<slug>` meaning a piece in
 * the session's own space. It is what a surface holding a rendered piece has —
 * a pane in the Weaver holds this pair and nothing else, because the id a
 * piece sits at never crosses to a client — and resolving it is the session's
 * job rather than that surface's, since only the session holds the space.
 *
 * Scoped to pieces. A pane may show any cell in a space, and the general case
 * is CT-2319's; a slug names a piece or it names nothing, which is what lets
 * this resolve through `resolvePieceAddress` with no new vocabulary.
 */
export interface NamedPieceAddress {
  /**
   * The space the address names, absent when the address named none. A named
   * space is checked against the session's own: named addresses resolve there.
   */
  spaceName?: string;

  /** The slug, already held to `validateSlug`. */
  slug: string;
}

/**
 * Reads `ref` as a {@link NamedPieceAddress}, or answers `undefined` when it is
 * not one and belongs to the entity-URI grammar instead. The two shapes are
 * disjoint by construction rather than by precedence: an entity URI carries a
 * scheme colon, a slug may hold neither `:` nor `/`, and `pattern:` is the one
 * prefix read as a space-qualified name.
 *
 * `piece:` is deliberately not read here. It is the retired spelling for this
 * concept product-wide, and accepting it would put a second name for one thing
 * into a grammar whose whole purpose is that a surface and a session agree on
 * what was meant.
 *
 * @throws Error naming the defect when `ref` is shaped like a named address —
 * a `pattern:` prefix, or a bare word — but does not spell one.
 */
export const parseNamedPieceAddress = (
  ref: string,
): NamedPieceAddress | undefined => {
  if (ref.startsWith("pattern:")) {
    const rest = ref.slice("pattern:".length);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) {
      throw new Error(
        `\`${ref}\` is not a piece address; spell it pattern:<space>/<slug>`,
      );
    }
    const spaceName = rest.slice(0, slash);
    const slug = rest.slice(slash + 1);
    if (slug.includes("/")) {
      throw new Error(
        `\`${ref}\` names more than one path segment after its space; a piece address is pattern:<space>/<slug>`,
      );
    }
    return { spaceName, slug: validateSlug(slug) };
  }
  if (ref.includes(":") || ref.includes("/")) {
    return undefined;
  }
  return { slug: validateSlug(ref) };
};

/**
 * Holds a named address to the space it may name: the session's own, or none
 * at all. A surface cannot see which space a console runs against, so naming
 * another one is a mistake to report. Foreign attachments need a reference
 * carrying an operator-admitted DID.
 *
 * `spaceName` is the space's NAME, which is what an address carries; the
 * `MemorySpace` a mint checks a reference against is its DID, and the two are
 * never compared to each other.
 *
 * @throws Error naming both spaces.
 */
export const checkNamedPieceAddressSpace = (
  address: NamedPieceAddress,
  spaceName: string | undefined,
): void => {
  if (
    address.spaceName === undefined || spaceName === undefined ||
    address.spaceName === spaceName
  ) {
    return;
  }
  throw new Error(
    `piece address names space \`${address.spaceName}\`, and this session runs in \`${spaceName}\`; only pieces in the session's own space can be attached`,
  );
};

/**
 * Holds one input cell to the rule its handle is minted under: the name is
 * model-facing text of a fixed shape, and the reference is either a link
 * naming an entity (`of:` or `computed:`) or a named piece address
 * (`pattern:<space>/<slug>`, or a bare slug) — and, when the session's
 * `space` or `spaceName` is known, admitted by the session. The grammar and
 * the mint both run this, so a reference the mint would refuse is refused
 * wherever it first arrives, before a run exists to spend on it. Both spaces
 * are known only at the mint, from the live session; a surface parsing
 * operator input passes neither.
 *
 * What is NOT checked here is whether the space holds the slug a named
 * address names. That is a fact about the fabric rather than about the text,
 * so it belongs where a session can answer it — {@link mintInputCellHandles},
 * whose failure is the turn's, loud and naming the slug.
 *
 * @throws Error naming the input cell and the defect.
 */
export const checkInputCellSpec = (
  spec: HarnessInputCellSpec,
  space?: MemorySpace,
  spaceName?: string,
  foreignSpaces?: HarnessForeignSpaces,
): void => {
  if (!HANDLE_NAME_PATTERN.test(spec.name)) {
    throw new Error(
      `--input-cell name must match ${HANDLE_NAME_PATTERN}, got \`${spec.name}\``,
    );
  }
  // A named address is checked as far as a string can be checked — its slug is
  // well formed, and the space it names is this session's. Whether the space
  // HOLDS that slug is not a fact about the text, so it is not decided here:
  // it is decided at the mint, where the session that can answer it is.
  let address;
  try {
    address = parseNamedPieceAddress(spec.ref);
  } catch (error) {
    throw new Error(
      `--input-cell \`${spec.name}\` reference does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (address !== undefined) {
    try {
      checkNamedPieceAddressSpace(address, spaceName);
    } catch (error) {
      throw new Error(
        `--input-cell \`${spec.name}\` ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return;
  }
  let link;
  try {
    link = parseHandleRef(spec.ref);
  } catch (error) {
    throw new Error(
      `--input-cell \`${spec.name}\` reference does not parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    space !== undefined &&
    !admitsFabricReference(link.space, space, foreignSpaces)
  ) {
    throw new Error(
      `--input-cell \`${spec.name}\` reference targets another space; the operator must admit its DID and host with --fabric-foreign-spaces`,
    );
  }
};

/**
 * Parses one `--input-cell` argument of the form `<name>=<link>`, holding
 * the pair to {@link checkInputCellSpec}. Neither a cell's shape nor its
 * labels are stated here: both live on the cell in the fabric, and
 * `describe_handle` answers from there — one source of truth, on the cell,
 * rather than an operator's account of it.
 *
 * @throws Error naming the defect when the argument does not fit the
 * grammar; the caller surfaces it as a usage error before any run starts.
 */
export const parseInputCellArgument = (
  raw: string,
): ParsedInputCellArgument => {
  const eq = raw.indexOf("=");
  if (eq <= 0) {
    throw new Error(
      `--input-cell must be <name>=<link>, got \`${raw}\``,
    );
  }
  const name = raw.slice(0, eq).trim();
  const ref = raw.slice(eq + 1).trim();
  if (ref.length === 0) {
    throw new Error(`--input-cell \`${name}\` names no reference`);
  }
  if (ref.includes(";")) {
    const option = ref.slice(ref.indexOf(";") + 1).trim();
    throw new Error(
      `--input-cell \`${name}\` carries an option \`${option}\`; the flag takes none — a cell's shape and labels live on the cell in the fabric`,
    );
  }
  const spec = { name, ref };
  checkInputCellSpec(spec);
  return spec;
};

/**
 * The session's foreign-space admission, local space name, and resolver for
 * named piece attachments. Plain references need no named-piece resolution.
 */
export interface InputCellSessionResolution {
  /** Operator admission snapshot from the Fabric session. */
  foreignSpaces?: HarnessForeignSpaces;

  /** The session's space, by name. */
  spaceName?: string;

  /**
   * Resolves one slug in the session's space to the piece id it names.
   * `resolvePieceAddress` is what production passes; the parameter exists so
   * the grammar and the mint are testable without a fabric session.
   */
  resolvePiece?: (slug: string) => Promise<string>;
}

/**
 * The reference a spec mints under: its own, or — for a named piece address —
 * the entity URI the session resolved that name to.
 *
 * A slug the space does not hold fails HERE rather than at the surface that
 * sent it. That is the same rule every input cell already runs under: a
 * reference that passes the grammar and cannot be minted fails the turn rather
 * than starting it without what the caller attached. The surface cannot know
 * what a space holds, and asking it to would be asking it to keep a copy of
 * the space's registry.
 *
 * @throws Error naming the slug and what the session said about it.
 */
const resolvedInputCellRef = async (
  spec: HarnessInputCellSpec,
  session: InputCellSessionResolution,
): Promise<string> => {
  const address = parseNamedPieceAddress(spec.ref);
  if (address === undefined) {
    return spec.ref;
  }
  if (session.resolvePiece === undefined) {
    throw new Error(
      `--input-cell \`${spec.name}\` names the piece \`${address.slug}\`, which needs a fabric session to resolve; configure --fabric-space`,
    );
  }
  // A QUALIFIED ADDRESS IS RESOLVED IN THIS SPACE OR NOT AT ALL. The
  // resolution below asks the session, which knows one space, so a space
  // this side cannot check the name of is one the address cannot be
  // honoured against: the same slug in another space is a different piece,
  // and answering with this space's would hand back a cell nobody asked
  // for. A space configured by `did:key` has no name, which is exactly
  // when this fires.
  if (address.spaceName !== undefined && session.spaceName === undefined) {
    throw new Error(
      `--input-cell \`${spec.name}\` names space \`${address.spaceName}\`, and this session's space has no name to check that against; name the space, or attach the piece by reference`,
    );
  }
  let pieceId: string;
  try {
    pieceId = await session.resolvePiece(address.slug);
  } catch (error) {
    throw new Error(
      `--input-cell \`${spec.name}\` names the piece \`${address.slug}\`, which this space does not hold: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return `/of:${pieceId}`;
};

/**
 * Mints a handle for each input cell into `table` (or a fresh table salted
 * with `runId`), returning the extended table and the records for run state.
 * Every cell is held to {@link checkInputCellSpec} against `space` and the
 * operator's foreign-space admission map before anything is recorded.
 *
 * A cell spelled as a named piece address is resolved through `session`
 * first, so what is minted is always an entity URI: the handle table holds one
 * kind of reference however the caller spelled it, and the run-state record of
 * an input cell is the address it actually names.
 *
 * @throws Error naming the failing input cell on a duplicate name, an
 * unparseable reference, a reference into an unadmitted space, or a named piece
 * address this space does not hold.
 */
export const mintInputCellHandles = async (
  table: HarnessHandleTable | undefined,
  runId: string,
  specs: readonly HarnessInputCellSpec[],
  space: MemorySpace,
  session: InputCellSessionResolution = {},
): Promise<{ table: HarnessHandleTable; inputCells: HarnessInputCell[] }> => {
  let current = table ?? createHarnessHandleTable(runId);
  const inputCells: HarnessInputCell[] = [];
  const names = new Set<string>();
  for (const spec of specs) {
    // Checked here, not only at parse: a library caller reaches this mint
    // without the CLI grammar, and only the live session knows the space.
    checkInputCellSpec(spec, space, session.spaceName, session.foreignSpaces);
    if (names.has(spec.name)) {
      throw new Error(`--input-cell names \`${spec.name}\` twice`);
    }
    names.add(spec.name);
    const ref = await resolvedInputCellRef(spec, session);
    const minted = await mintAddressHandle(current, ref);
    current = minted.table;
    // The record carries the entry's canonical spelling, not the operator's
    // raw one, so the run-state record and the table entry agree on one ref.
    const entry = current.entries.find(
      (candidate) => candidate.token === minted.token,
    )!;
    inputCells.push({ name: spec.name, token: minted.token, ref: entry.ref });
  }
  return { table: current, inputCells };
};

/**
 * The context message announcing `inputCells` to the model: one line per
 * input cell, pairing the token with its host-supplied attachment name or
 * session-confirmed slug. An empty list explicitly records that this run has
 * no input-cell attachments; conversation history may still identify a target.
 */
export const inputCellsContextMessage = (
  inputCells: readonly HarnessInputCell[],
): string => {
  if (inputCells.length === 0) {
    return "No input cells are attached for this run. A piece unambiguously selected in the conversation can still be the target; granted registry or connector references are not attachments.";
  }
  return [
    "Input cells for this run:",
    ...inputCells.map((cell) => `- ${cell.token} — ${cell.name}`),
    "You cannot read what an input cell holds. Wire it into run_pattern `inputs` to compute over it, or into any other tool input that accepts a handle; use describe_handle to see its shape.",
  ].join("\n");
};
