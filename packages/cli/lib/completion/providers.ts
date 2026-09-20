// deno-lint-ignore-file cf-imports/no-inline-module-import -- a completion
// request runs between two keystrokes, so each provider loads only what its own
// candidates need.

/**
 * Live candidate providers — the half of completion that reads real state.
 *
 * Every provider resolves its fabric context from the half-typed line first and
 * the environment second, which is what lets
 * `cf piece call -s other-space --cell <TAB>` list the pieces of `other-space`
 * rather than whatever `CF_SPACE`-shaped default the shell happens to carry.
 *
 * Failure is always silent and always empty. A completion request runs while
 * the user is mid-keystroke: an unreachable server, an expired key, or a
 * malformed piece id must produce no candidates, never a stack trace pasted
 * into the command line.
 */

import type { Candidate } from "./static.ts";
import type { CompletionLine } from "./line.ts";
import { longName } from "./line.ts";
import { absPath } from "../utils.ts";
import {
  normalizeLLMFriendlyRef,
  splitArgumentSuffix,
} from "../llm-friendly-ref.ts";
import { parseScopedIdSegment } from "@commonfabric/runner/shared";
import type { PieceConfig, SpaceConfig } from "../piece.ts";
import ports from "@commonfabric/ports" with { type: "json" };

/** A directive tells the shell to complete something only it can do well. */
export type Directive =

  /** Hand off to the shell's own file completion, filtered by glob. */
  | { readonly kind: "files"; readonly glob?: string }
  /** Hand off to the shell's directory completion. */
  | { readonly kind: "dirs" }
  /** Suppress the trailing space, so a path can be continued with `/`. */
  | { readonly kind: "nospace" };

export interface ProviderResult {
  readonly candidates: readonly Candidate[];
  readonly directives: readonly Directive[];
}

const NOTHING: ProviderResult = { candidates: [], directives: [] };

function values(candidates: readonly Candidate[]): ProviderResult {
  return { candidates, directives: [] };
}

function directive(...directives: Directive[]): ProviderResult {
  return { candidates: [], directives };
}

/**
 * Resolve the fabric connection the half-typed line refers to.
 *
 * Mirrors the precedence `parseSpaceOptions` applies at execution time — line
 * options beat environment, and `--url` supplies api-url plus space together —
 * but never throws: an incomplete line yields `null`, meaning "no live
 * candidates", not an error.
 */
export function resolveSpaceContext(
  line: CompletionLine,
  embeddedSpace?: string,
): SpaceConfig | null {
  const url = line.options.get("url");
  const identity = line.options.get("identity") ??
    Deno.env.get("CF_IDENTITY");
  if (!identity) return null;

  let apiUrl = line.options.get("api-url") ?? Deno.env.get("CF_API_URL");
  // A reference carrying a space DID supplies one the line did not name, which
  // is what `parsePieceOptions` does with the same reference. Where the line
  // named a space it wins, and a mismatch between the two is settled by the
  // command rather than here: completion offers candidates, it does not judge.
  let space = line.options.get("space") ?? embeddedSpace;

  if (url) {
    try {
      const parsed = new URL(url);
      apiUrl = `${parsed.protocol}//${parsed.host}`;
      space = parsed.pathname.split("/").filter(Boolean)[0];
    } catch {
      return null;
    }
  }

  if (!apiUrl || !space) return null;

  try {
    return {
      apiUrl,
      space,
      identity: absPath(identity),
      // Completion reserves stdout for candidates. `jsonOutput` is how the
      // runtime is told stdout is machine-readable: it routes status lines
      // that would otherwise `console.log` (the navigateTo notice in
      // `loadPieces`) to stderr, where the shell function discards them.
      // Without it such a line would be offered to the user as a candidate.
      jsonOutput: true,
    };
  } catch {
    return null;
  }
}

/**
 * The target the line names, in whichever spelling it was written: the
 * `--cell`/`--piece` flag, a positional reference, or the piece a `--url`
 * carries. Cliffy keys the flag by its leading name, so one lookup answers
 * for both of its spellings.
 */
function writtenPieceRef(line: CompletionLine): string | undefined {
  const piece = line.options.get("cell") ?? line.address;
  if (piece) return piece;
  const url = line.options.get("url");
  if (!url) return undefined;
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[1];
  } catch {
    return undefined;
  }
}

/**
 * Same as `resolveSpaceContext`, plus the target the line already names —
 * parsed through the same grammar the command's own intake parses it with.
 *
 * `normalizeLLMFriendlyRef` reads the reference: the embedded space, the
 * `@scope` qualifier, an embedded path, and the `#argument` member that selects
 * the arguments cell the way `--input` does. What it does not recognize falls
 * through to the alias grammar, `id[#argument][@scope]`. Every spelling the
 * command's intake accepts has to reach one of the two readings: a word taken
 * verbatim as a piece id resolves to a listing call that cannot succeed, and
 * so to a slot that silently offers nothing.
 *
 * A malformed reference is `null` rather than a throw: the caller is a
 * provider, and a half-typed word is the normal state of one.
 */
export function resolvePieceContext(line: CompletionLine): PieceConfig | null {
  const written = writtenPieceRef(line);
  if (!written) return null;

  let ref;
  try {
    ref = normalizeLLMFriendlyRef(written, {
      space: line.options.get("space"),
    });
  } catch {
    return null;
  }

  if (!ref) {
    let bare;
    let alias;
    try {
      bare = splitArgumentSuffix(written);
      alias = parseScopedIdSegment(bare.target);
    } catch {
      return null;
    }
    const space = resolveSpaceContext(line);
    if (!space) return null;
    return {
      ...space,
      piece: alias.id,
      ...(alias.scope && { pieceScope: alias.scope }),
      ...(bare.input && { pieceInput: true }),
    };
  }

  const space = resolveSpaceContext(line, ref.embeddedSpace);
  if (!space) return null;
  return {
    ...space,
    piece: ref.pieceId,
    ...(ref.scope && { pieceScope: ref.scope }),
    ...(ref.path.length > 0 && { piecePath: ref.path }),
    ...(ref.input && { pieceInput: true }),
  };
}

/**
 * What the `--cell` slot accepts: every slug the space's index records, then
 * every piece id.
 *
 * Both are values the flag takes, and the slug is the readable half of that
 * vocabulary — so it leads, and the opaque id follows.
 */
async function pieceCandidates(line: CompletionLine): Promise<ProviderResult> {
  const config = resolveSpaceContext(line);
  if (!config) return NOTHING;
  const { listPieces, listSpaceSlugs } = await import("../piece.ts");
  const [pieces, slugs] = await Promise.all([
    listPieces(config),
    listSpaceSlugs(config),
  ]);
  return values([
    ...shapeSlugCandidates(slugs, pieces),
    ...shapePieceCandidates(pieces),
  ]);
}

/** Just the slugs, for the positional that takes one and nothing else. */
async function slugCandidates(line: CompletionLine): Promise<ProviderResult> {
  const config = resolveSpaceContext(line);
  if (!config) return NOTHING;
  const { listPieces, listSpaceSlugs } = await import("../piece.ts");
  const [pieces, slugs] = await Promise.all([
    listPieces(config),
    listSpaceSlugs(config),
  ]);
  return values(shapeSlugCandidates(slugs, pieces));
}

/** Listing shape used by `shapePieceCandidates`, structural so tests need no runtime. */
export interface PieceListingLike {
  readonly id: string;
  readonly name?: string;
  readonly patternRef?: { readonly symbol?: string } | null;
}

/** Listing shape used by `shapeSlugCandidates`, structural for the same reason. */
export interface SlugListingLike {
  readonly slug: string;
  readonly piece?: string;
}

/**
 * Label pieces for the annotation column: the piece's own name reads best, and
 * the pattern symbol is the fallback for a piece never given one. A piece that
 * failed to load still lists — its id is exactly what an operator reaches for
 * completion to recover.
 */
export function shapePieceCandidates(
  pieces: readonly PieceListingLike[],
): Candidate[] {
  return pieces.map((piece) => ({
    value: piece.id,
    description: piece.name ?? piece.patternRef?.symbol ?? undefined,
  }));
}

/**
 * Label slugs so they are not read as ids. The annotation says what the value
 * is and, where the slug resolves to a piece the listing named, what it points
 * at — which is the question a caller choosing between two slugs is asking.
 *
 * A slug whose target failed to resolve still lists: it is a name the space
 * records and the flag accepts, and completion is not the surface that decides
 * whether it still points anywhere.
 */
export function shapeSlugCandidates(
  slugs: readonly SlugListingLike[],
  pieces: readonly PieceListingLike[],
): Candidate[] {
  const named = new Map(
    pieces.map((piece) => [piece.id, piece.name ?? piece.patternRef?.symbol]),
  );
  return slugs.map((entry) => {
    const name = entry.piece ? named.get(entry.piece) : undefined;
    return {
      value: entry.slug,
      description: name ? `slug for ${name}` : "slug",
    };
  });
}

/** Callables (handlers and streams) exposed by the line's `--cell`. */
async function callableCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const config = resolvePieceContext(line);
  if (!config) return NOTHING;
  const { listPieceCallables } = await import("../piece.ts");
  const listing = await listPieceCallables(config);
  return values(shapeVerbCandidates(listing.verbs));
}

/** Verb shape used by `shapeVerbCandidates`, structural so tests need no runtime. */
export interface VerbListingLike {
  readonly name: string;
  readonly kind: string;

  /** The author's doc comment on the verb, where the listing carries one. */
  readonly description?: string;

  /** A UI affordance rather than a headless verb. Hidden by `cf piece verbs`. */
  readonly tier?: string;

  /** `@deprecated` on the verb. Hidden by `cf piece verbs`. */
  readonly deprecated?: boolean;
}

/**
 * Callables, annotated with what the author said the verb is FOR.
 *
 * `cf piece verbs` prints that sentence under each row and it is the one a
 * verb's help page opens with, so it is what the annotation column is for. The
 * kind is a two-value fact that rarely decides anything at the prompt, and it
 * is the fallback where the author documented nothing — never derived from the
 * name, which would report a caller's own word back as documentation.
 *
 * A wrapper or deprecated verb is marked. `cf piece verbs` holds both back
 * unless `--all` and says how many it held; completion offers them, because
 * both are callable and a name that works should be reachable. What is not
 * defensible is the two surfaces disagreeing silently, and the mark is the
 * cheapest way to agree: it keeps the name reachable while saying what it is.
 */
export function shapeVerbCandidates(
  verbs: readonly VerbListingLike[],
): Candidate[] {
  return verbs.map((verb) => {
    // Both marks, in the order and the join `cf piece verbs` renders them
    // with. They can coexist, and picking one would put the two surfaces back
    // into the silent disagreement this item is about.
    const marks = [
      ...(verb.tier === "wrapper" ? ["wrapper"] : []),
      ...(verb.deprecated === true ? ["deprecated"] : []),
    ].join(",");
    const said = verb.description?.split("\n")[0].trim();
    const body = said && said.length > 0 ? said : verb.kind;
    return {
      value: verb.name,
      description: marks ? `[${marks}] ${body}` : body,
    };
  });
}

/**
 * Keys reachable one level below the path already typed.
 *
 * Completion happens per path segment: `items/<TAB>` reads `items` and offers
 * its keys, so a deep path is walked rather than guessed. `nospace` keeps the
 * cursor attached to the value so the next `/` continues the same word.
 */
async function cellPathCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const config = resolvePieceContext(line);
  if (!config) return NOTHING;

  const { parentPath, prefix } = splitPathPrefix(line.word);
  const { listCellKeys } = await import("../cell-listing.ts");
  const keys = await listCellKeys(config, parentPath, {
    // `#argument` on the target and `--input` as a flag are two spellings of
    // one selection, so both reach the arguments cell here.
    input: line.flags.has("input") || config.pieceInput === true,
  });
  if (keys.length === 0) return NOTHING;

  return {
    candidates: keys.map((key) => ({ value: `${prefix}${key}` })),
    directives: [{ kind: "nospace" }],
  };
}

/**
 * Split the word being typed into the parent path to read and the prefix each
 * candidate must carry, so the shell replaces the whole token.
 *
 * `items/0/ti` reads `items/0` and offers `items/0/title`: the prefix is what
 * keeps a completed deep path from collapsing to its last segment.
 */
export function splitPathPrefix(
  typed: string,
): { parentPath: string; prefix: string } {
  const cut = typed.lastIndexOf("/");
  if (cut === -1) return { parentPath: "", prefix: "" };
  const parentPath = typed.slice(0, cut);
  return { parentPath, prefix: `${parentPath}/` };
}

/**
 * Commands whose `--select`/`--schema` names positions in the value at the
 * target the line already gives.
 *
 * `call` and `exec` shape a VERB's result instead, whose vocabulary is the
 * verb's `outputSchema` rather than the piece's root — reading the root there
 * would offer plausible names for a different value, which is worse than
 * offering none. `wish` shapes what its query resolved to, and resolving a
 * wish commits a cell to the space: a Tab must not write.
 */
const PROJECTION_SOURCE_COMMANDS: readonly string[] = [
  "cell get",
  // The superseded top-level spelling, which still completes its own options
  // for a caller who has not migrated.
  "get",
];

/**
 * Field paths into the value a read returns, for `--select` and `--schema`.
 *
 * The grammar is its own and is not the cell-path grammar: a list splits on
 * `,` and a path on `.`, where a cell path walks `/`. A segment ending in `@`
 * asks for that position's address rather than its value, and a bare `@` asks
 * the read for its own — so both spellings of a position are offered.
 *
 * The vocabulary needs no request the slot does not already have: the value
 * being projected is the one at the piece and path the line names, which is
 * what `cf cell get` would read.
 */
function projectionFieldCandidates(
  flag: "select" | "schema",
): (line: CompletionLine) => Promise<ProviderResult> {
  return async (line) => {
    // `--schema` reads a JSON Schema or an `@file` as well as this list, and
    // both are recognized by their first character. Neither is a field path.
    if (flag === "schema" && /^[@{]/.test(line.word)) return NOTHING;

    const config = resolvePieceContext(line);
    if (!config) return NOTHING;

    const { list, path, prefix, atElementStart } = splitSelectPrefix(line.word);
    const { getCellValue } = await import("../piece.ts");
    const { parseCellPath } = await import("@commonfabric/runner");
    const value = await getCellValue(
      config,
      [
        ...(config.piecePath ?? []),
        ...(line.positionals[0] ? parseCellPath(line.positionals[0]) : []),
      ],
      { input: line.flags.has("input") || config.pieceInput === true },
    );

    // Everything the position could name, including the bare address suffix
    // wherever an element begins — then held to what the flag's own parser
    // accepts. Which spellings are reserved is not a rule worth restating:
    // `--select true` is refused while `revision,true` is a field, and
    // `--schema @` is an empty file path while `revision,@` is the suffix.
    // Round-tripping is what keeps the offered set and the accepted set one.
    const candidates = await acceptedProjections(
      shapeProjectionCandidates(
        descendProjection(value, path),
        `${list}${prefix}`,
        { self: atElementStart },
      ),
      flag,
    );
    if (candidates.length === 0) return NOTHING;
    // A field path continues with `.` or `,`, so hold the cursor in place the
    // way a cell path does.
    return { candidates, directives: [{ kind: "nospace" }] };
  };
}

/**
 * The candidates the flag's own parser accepts, written as the whole argument
 * they would become.
 *
 * A completion is a spelling a caller may stop at, so the bar is the one every
 * other slot here is held to: the command takes it. The two flags read the
 * same field list and reserve different spellings around it — `--select true`
 * is refused while `revision,true` is a field, `--schema @` is an empty file
 * path while `revision,@` is the suffix — and both sets of rules live in
 * `lib/cell-selection.ts`, so they are asked rather than mirrored.
 */
export async function acceptedProjections(
  candidates: readonly Candidate[],
  flag: "select" | "schema",
): Promise<Candidate[]> {
  const { parseSelectProjection, parseSelectionProjection } = await import(
    "../cell-selection.ts"
  );
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = flag === "select"
        ? parseSelectProjection(candidate.value)
        : await parseSelectionProjection(candidate.value);
      // Parsing is not enough: `--schema true` succeeds and means the boolean
      // JSON Schema, not a field of that name. The parser reports which
      // reading it took, and only the field-list one is what this slot offers.
      if (parsed.kind === "concise") accepted.push(candidate);
    } catch {
      // A spelling this flag refuses is not a candidate for it.
    }
  }
  return accepted;
}

/**
 * Split the projection word being typed into the part each candidate must
 * carry back and the path already closed within the element being typed.
 *
 * `notes@,settings.the` is one closed element, then `settings.` closed within
 * the element under the cursor: the candidates are `notes@,settings.theme` and
 * its address spelling, because the shell replaces the whole word.
 */
export function splitSelectPrefix(typed: string): {
  /** Elements already closed, trailing comma included. */
  list: string;

  /** Segments already closed within the element being typed. */
  path: string[];

  /** Those segments as written, trailing dot included. */
  prefix: string;

  /** Whether nothing has been typed yet in this element. */
  atElementStart: boolean;
} {
  const comma = typed.lastIndexOf(",");
  const list = comma === -1 ? "" : typed.slice(0, comma + 1);
  const element = typed.slice(list.length);
  const dot = element.lastIndexOf(".");
  const prefix = dot === -1 ? "" : element.slice(0, dot + 1);
  return {
    list,
    // A closed segment may carry the address marker — `topic@.title` marks
    // `topic` and projects `title` — so the marker is stripped for the walk
    // and kept in the prefix the candidate carries back. Descending a literal
    // `topic@` would find no such property and offer nothing.
    path: prefix ? prefix.slice(0, -1).split(".").map(segmentName) : [],
    prefix,
    atElementStart: element.length === 0,
  };
}

/**
 * The field a written segment names: the trailing address marker is not part
 * of it, and `\@` is an escaped `@` that is. Mirrors `parseConciseSegment`,
 * which is what the command reads a segment with.
 */
function segmentName(segment: string): string {
  const escaped = "\\@";
  const marked = segment.endsWith("@") && !segment.endsWith(escaped);
  return (marked ? segment.slice(0, -1) : segment).replaceAll(escaped, "@");
}

/**
 * The value a projection path names, read the way a projection reads it: a
 * list is element-wise across an array, so a segment below one names a field
 * of each element rather than an index. `--select items.0.title` is refused
 * for exactly that reason.
 */
export function descendProjection(
  value: unknown,
  path: readonly string[],
): unknown {
  let current = value;
  for (const name of path) current = descendOne(current, name);
  return current;
}

/**
 * One segment of that walk. An array is descended through however many layers
 * it has, because a projection is element-wise at every one of them:
 * `matrix.nested.leaf` reads through `[[{nested: {leaf}}]]`, so a walk that
 * unwrapped a single layer would offer `nested` and then nothing.
 */
function descendOne(value: unknown, name: string): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => descendOne(element, name));
  }
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[name];
}

/**
 * A name a concise field path can carry. `parseConciseSegment` holds a segment
 * to an identifier grammar, and a trailing `@` in a name would be read as the
 * address suffix — the escape that writes one needs shell quoting to survive,
 * so such a key is left out rather than offered in a form that does not work.
 */
function isWritableFieldName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$@-]*$/.test(name) && !name.endsWith("@");
}

/**
 * The positions one level below a projection path: an array contributes its
 * elements' fields rather than its indices, and a leaf contributes nothing.
 */
export function projectionKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    const seen: string[] = [];
    for (const element of value) {
      for (const key of projectionKeys(element)) {
        if (!seen.includes(key)) seen.push(key);
      }
    }
    return seen;
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/**
 * Both spellings of every position below `value`, each carrying `prefix` so
 * the shell replaces the whole word.
 */
export function shapeProjectionCandidates(
  value: unknown,
  prefix: string,
  options: { self?: boolean } = {},
): Candidate[] {
  const candidates: Candidate[] = [];
  if (options.self) {
    candidates.push({
      value: `${prefix}@`,
      description: "the read source's address",
    });
  }
  for (const key of projectionKeys(value).filter(isWritableFieldName)) {
    candidates.push({ value: `${prefix}${key}` });
    candidates.push({
      value: `${prefix}${key}@`,
      description: "its address",
    });
  }
  return candidates;
}

/**
 * A `pieceId/path/to/field` token, completed in both halves.
 *
 * Before the `/` the candidates are what a `--cell` takes — the space's slugs
 * and its piece ids; after it they are that piece's cell keys, so one slot
 * spans two vocabularies. `nospace` holds the cursor at the separator, which
 * continues the same word.
 */
async function pieceWithPathCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const typed = line.word;
  const cut = typed.indexOf("/");
  if (cut === -1) {
    const pieces = await pieceCandidates(line);
    // A link endpoint continues with `/`, so hold the cursor in place.
    return { candidates: pieces.candidates, directives: [{ kind: "nospace" }] };
  }

  const config = resolveSpaceContext(line);
  if (!config) return NOTHING;
  const pieceId = typed.slice(0, cut);
  const { parentPath } = splitPathPrefix(typed.slice(cut + 1));

  const { listCellKeys } = await import("../cell-listing.ts");
  const keys = await listCellKeys({ ...config, piece: pieceId }, parentPath);
  if (keys.length === 0) return NOTHING;

  const prefix = pieceWithPathPrefix(pieceId, parentPath);
  return {
    candidates: keys.map((key) => ({ value: `${prefix}${key}` })),
    directives: [{ kind: "nospace" }],
  };
}

/**
 * Prefix a `pieceId/path` candidate carries, so the shell replaces the whole
 * token. The empty parent path is the case that matters: `id//key` would be a
 * different, invalid reference.
 */
export function pieceWithPathPrefix(
  pieceId: string,
  parentPath: string,
): string {
  return parentPath ? `${pieceId}/${parentPath}/` : `${pieceId}/`;
}

/**
 * Spaces this machine already knows about, discovered from the local memory-v2
 * SQLite stores that `cf inspect` reads. There is no server-side space index to
 * query, so an operator who has touched a space locally gets its DID completed
 * and everyone else gets nothing rather than a wrong guess.
 *
 * `--space` accepts a name or a DID, and the DB basename is the DID, so these
 * candidates are directly usable.
 */
async function spaceCandidates(): Promise<ProviderResult> {
  const { discoverSpaceDbs } = await import("@commonfabric/state-inspector");
  const spaces = discoverSpaceDbs()
    // Most-recently written first: the space being worked on ranks top.
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  // One space can have a DB under more than one cache root (a worktree's and
  // the checkout's). They are distinct files but the same space, and a
  // repeated DID in the candidate list is pure noise.
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const space of spaces) {
    if (seen.has(space.did)) continue;
    seen.add(space.did);
    candidates.push({ value: space.did, description: "local space db" });
  }
  return values(candidates);
}

/**
 * Entities in the space a positional already names, as `cf inspect entities`
 * lists them: the label reads, the id is what the next positional takes.
 *
 * The listing covers the view the command will read rather than the space's
 * default one, which is what `entityListingView` works out from the line.
 *
 * Local stores only. `--remote` fetches a snapshot over the network before it
 * can list anything, which is a round trip a keystroke should not start — so a
 * line that names one is answered by `namesRemote` instead. Every caller is an
 * `inspect` subcommand, which is what makes that check belong here.
 */
async function entityCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  if (namesRemote(line)) return NOTHING;
  const token = line.positionals[0];
  if (!token) return NOTHING;
  const { listEntityModels, listScopes, openSpace, resolveSpace } =
    await import("@commonfabric/state-inspector");
  const space = openSpace(await resolveSpace(token));
  try {
    const view = entityListingView(line);
    const scopes = view.allScopes
      ? listScopes(space, { branch: view.branch }).map((scope) => scope.raw)
      : [view.scope];
    // No limit of its own: the set is what `cf inspect entities` would list
    // with no `--limit`, so a completed id is one that command names too. The
    // listing reports its own extent, and a capped one is still every
    // candidate this slot can honestly offer.
    //
    // `listScopes` sorts the space scope first, so an entity written in more
    // than one scope keeps the label its space-scope value reconstructs to.
    const seen = new Set<string>();
    const entities: EntityListingLike[] = [];
    for (const scope of scopes) {
      for (
        const entity of listEntityModels(space, { branch: view.branch, scope })
          .entities
      ) {
        if (seen.has(entity.id)) continue;
        seen.add(entity.id);
        entities.push(entity);
      }
    }
    return values(shapeEntityCandidates(entities));
  } finally {
    space.close();
  }
}

/**
 * The view of a space an inspect line's entity slot has to cover: the branch,
 * and either the one scope the command reads or every scope it reads across.
 *
 * A command that declares `--scope` reads one, the line's or the listing's own
 * default. `cf inspect overlay` declares none and reports an entity's value in
 * EVERY scope, so a slot completed from the default scope alone would hide the
 * per-user and per-session entities that command exists to show.
 *
 * Separated from the read so a test can assert the view without a space DB.
 */
export function entityListingView(
  line: CompletionLine,
): { branch?: string; scope?: string; allScopes: boolean } {
  return {
    branch: line.options.get("branch"),
    scope: line.options.get("scope"),
    allScopes: line.path.join(" ") === "inspect overlay",
  };
}

/** Entity shape used by `shapeEntityCandidates`, structural so tests need no DB. */
export interface EntityListingLike {
  readonly id: string;
  readonly label?: string;
  readonly kind?: string;
}

/**
 * Label entities the way `cf inspect entities` does: the reconstructed label
 * reads, and the kind says what sort of thing it is where no label was found.
 */
export function shapeEntityCandidates(
  entities: readonly EntityListingLike[],
): Candidate[] {
  return entities.map((entity) => ({
    value: entity.id,
    description: entity.label && entity.label !== "(piece)"
      ? entity.label
      : entity.kind,
  }));
}

/**
 * The wish targets `cf wish --help` enumerates: the profile ones, which
 * resolve against the identity's home space, and the space-relative ones.
 *
 * A hand-maintained list, because the vocabulary is the wish builtin's rather
 * than the command tree's and nothing on the tree carries it. The help text is
 * where it is documented and where it is kept in step.
 */
export function wishTargetCandidates(): ProviderResult {
  return values([
    { value: "#profile", description: "the viewer's active profile object" },
    { value: "#profileName", description: "its live display name" },
    { value: "#profileAvatar", description: "its avatar" },
    { value: "#profileBio", description: "its owner-authored bio" },
    { value: "#profileSpace", description: "its own space cell" },
    { value: "#favorites", description: "space-relative" },
    { value: "#journal", description: "space-relative" },
    { value: "#learned", description: "space-relative" },
    { value: "#mentionable", description: "space-relative" },
    { value: "#pieceRegistry", description: "space-relative" },
    { value: "/", description: "the space's root" },
  ]);
}

/** `cf wish --scope`: three names, plus any space DID. */
async function wishScopeCandidates(): Promise<ProviderResult> {
  const spaces = await spaceCandidates();
  return values([
    { value: "~", description: "favorites" },
    { value: ".", description: "the current space" },
    { value: "profile", description: "profile elements" },
    ...spaces.candidates,
  ]);
}

/**
 * Whether the line puts `cf inspect` in remote mode.
 *
 * `--remote` is a global option on `inspect`, and it decides where the space
 * comes from: `openByToken` resolves the token through the REMOTE's own
 * listing and opens the snapshot it fetches, so a locally discovered DID and
 * the entities of a local DB are candidates the command rejects. Its value is
 * optional, so the flag reaches the line as an option when written
 * `--remote=<url>` and as a bare flag otherwise, and both spellings count.
 *
 * Completion answers nothing there rather than listing the remote, which is a
 * network round trip a keystroke must not start. The slot stays decided, and
 * is decided as empty — the same disposition `inspect pull` carries.
 */
function namesRemote(line: CompletionLine): boolean {
  return line.options.has("remote") || line.flags.has("remote");
}

/**
 * An option's provider, and the command paths it answers on.
 *
 * `commands` is absent on a provider that answers wherever the option is
 * declared, and carries the paths of one restricted by {@link onlyOn}. The
 * gate reads it: a key alone says which option was decided about, and only the
 * paths say on which commands.
 */
export type OptionProvider =
  & ((line: CompletionLine) => Promise<ProviderResult>)
  & { readonly commands?: readonly string[] };

/**
 * Restrict a provider to the commands whose option of that name means this.
 *
 * The option table is keyed by long name alone, and a name can mean two things
 * on two commands: `--from` is a file on `space clone` and a sequence number on
 * `inspect diff`, `--scope` is a wish search scope and an inspect scope key.
 * Offering the wrong set is worse than offering none, so the provider says
 * where it applies.
 */
function onlyOn(
  commands: readonly string[],
  provider: (line: CompletionLine) => Promise<ProviderResult>,
): OptionProvider {
  const paths = new Set(commands);
  const scoped = (line: CompletionLine) =>
    paths.has(line.path.join(" ")) ? provider(line) : Promise.resolve(NOTHING);
  return Object.assign(scoped, { commands });
}

/** The commands whose `--root` is the directory their sources resolve against. */
const ROOT_DIRECTORY_COMMANDS: readonly string[] = [
  "check",
  "piece new",
  // Both mounts of `set-home`: the superseded one keeps completing its own
  // flags for a caller who has not migrated, it is only never suggested.
  "piece set-home",
  "space set-home",
  "piece setsrc",
  "piece survey",
  "test",
];

/** Every command whose `--root` this table answers, in both meanings. */
const ROOT_COMMANDS: readonly string[] = [
  ...ROOT_DIRECTORY_COMMANDS,
  "inspect graph",
];

/**
 * `--root` by what it names: a source directory on the commands that resolve
 * imports and authored paths against one, and on `cf inspect graph` the entity
 * whose neighborhood the graph is drawn around.
 *
 * The graph's root is a node id, so it takes what the entity positionals take,
 * read from the space the command already names.
 */
function rootCandidates(line: CompletionLine): Promise<ProviderResult> {
  return line.path.join(" ") === "inspect graph"
    ? entityCandidates(line)
    : Promise.resolve(directive({ kind: "dirs" }));
}

/** Agent runs named by stable record id, discovered through the home wish. */
async function agentRunCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const identity = line.options.get("identity") ?? Deno.env.get("CF_IDENTITY");
  const apiUrl = line.options.get("api-url") ?? Deno.env.get("CF_API_URL");
  if (!identity || !apiUrl) return NOTHING;
  const { readAgentRuns } = await import("../agent-inspection.ts");
  const runs = await readAgentRuns({ identity: absPath(identity), apiUrl });
  return values(runs.map((run) => ({
    value: run.id,
    description: `${run.state}: ${run.task}`,
  })));
}

/** API URLs worth offering: the environment's, plus the local dev server. */
function apiUrlCandidates(): ProviderResult {
  const candidates: Candidate[] = [];
  const fromEnv = Deno.env.get("CF_API_URL");
  if (fromEnv) candidates.push({ value: fromEnv, description: "CF_API_URL" });
  const local = `http://localhost:${ports.toolshed}`;
  if (local !== fromEnv) {
    candidates.push({ value: local, description: "local toolshed" });
  }
  return values(candidates);
}

/** Pattern sources are `.tsx`; the shell filters and handles directories. */
function patternFiles(): Promise<ProviderResult> {
  return Promise.resolve(directive({ kind: "files", glob: "*.tsx" }));
}

/**
 * Option values by long name. A name absent here falls through to the shell's
 * own file completion only when the option is path-shaped.
 */
const OPTION_VALUE_PROVIDERS: Readonly<Record<string, OptionProvider>> = {
  // `--piece` is a deprecated name for the same option, and Cliffy keys it by
  // the leading one, so this entry serves both spellings.
  cell: pieceCandidates,
  select: onlyOn(
    PROJECTION_SOURCE_COMMANDS,
    projectionFieldCandidates("select"),
  ),
  schema: onlyOn(
    PROJECTION_SOURCE_COMMANDS,
    projectionFieldCandidates("schema"),
  ),
  space: () => spaceCandidates(),
  "api-url": () => Promise.resolve(apiUrlCandidates()),
  // `--remote` takes what `--api-url` takes: the toolshed to read from.
  remote: () => Promise.resolve(apiUrlCandidates()),
  identity: () => Promise.resolve(directive({ kind: "files", glob: "*.key" })),
  // `cf agent runner`: the toolshed it sits beside, the host-owned Loom tool
  // configuration it reads, and the directory its runs' workspaces go under.
  "local-api-url": () => Promise.resolve(apiUrlCandidates()),
  "loom-retrieval-config": () =>
    Promise.resolve(directive({ kind: "files", glob: "*.json" })),
  "work-root": () => Promise.resolve(directive({ kind: "dirs" })),
  // A source directory on the commands that compile one, and an entity on
  // `inspect graph`.
  root: onlyOn(ROOT_COMMANDS, rootCandidates),
  test: patternFiles,
  // A data file has no fixed extension; the shell's own file completion is the
  // only honest candidate set.
  datafile: () => Promise.resolve(directive({ kind: "files" })),
  // A clone directory on `space clone`, and a sequence number on `inspect
  // diff`.
  to: onlyOn(
    ["space clone"],
    () => Promise.resolve(directive({ kind: "dirs" })),
  ),
  // `--list` names a piece to survey or repair instead of a collection, so it
  // takes what `--cell` takes. Scoped, because a `--list` elsewhere would
  // mean something else entirely.
  list: onlyOn(["piece survey", "piece repair"], pieceCandidates),
  // `cf piece survey --validator` reads a JSON-schema file.
  validator: () => Promise.resolve(directive({ kind: "files" })),
  // `cf piece survey --diff` reads the plan an earlier survey wrote.
  diff: onlyOn(
    ["piece survey"],
    () => Promise.resolve(directive({ kind: "files" })),
  ),
  // `cf piece repair --fixer` names a TypeScript module whose default export
  // is the transform; `--plan` reads the rows a survey wrote.
  fixer: () => Promise.resolve(directive({ kind: "files", glob: "*.ts" })),
  plan: () => Promise.resolve(directive({ kind: "files" })),
  // `cf inspect --dir` is an extra directory to search for space DBs.
  dir: () => Promise.resolve(directive({ kind: "dirs" })),
  // `cf inspect html --out` and `cf check --output` write a file.
  out: () => Promise.resolve(directive({ kind: "files" })),
  output: () => Promise.resolve(directive({ kind: "files" })),
  // The remaining path-shaped values: two artifacts `cf test` writes, and the
  // state file `cf fuse mount` passes to its child.
  "pattern-coverage-dir": () => Promise.resolve(directive({ kind: "dirs" })),
  "timing-measures-out": () => Promise.resolve(directive({ kind: "files" })),
  "cfc-writeback-state": () => Promise.resolve(directive({ kind: "files" })),
  // A snapshot file on `space clone`, and a sequence number on `inspect diff`.
  from: onlyOn(
    ["space clone"],
    () => Promise.resolve(directive({ kind: "files" })),
  ),
  // A hashtag search scope on `wish`, and a scope key on `inspect`.
  scope: onlyOn(["wish"], () => wishScopeCandidates()),
};

/** `cf inspect` subcommands whose first positional opens a local space. */
const INSPECT_SPACE_COMMANDS: readonly string[] = [
  "churn",
  "commits",
  "conflicts",
  "diff",
  "entities",
  "graph",
  "history",
  "hot",
  "html",
  "overlay",
  "operations",
  "piece",
  "scopes",
  "summary",
  "timeline",
  "users",
  "value-at",
];

/** Those of them whose next positional is an entity within that space. */
const INSPECT_ENTITY_COMMANDS: readonly string[] = [
  "conflicts",
  "converge",
  "diff",
  "history",
  "overlay",
  "operations",
  "piece",
  "timeline",
  "value-at",
];

/**
 * Positional providers, keyed by `<command path>:<argument name>`. The command
 * path disambiguates arguments that share a name across commands — `path` means
 * a cell path under `cf cell get` but a filesystem path elsewhere.
 */
const ARGUMENT_PROVIDERS: Readonly<
  Record<string, (line: CompletionLine) => Promise<ProviderResult>>
> = {
  "agent show:run": agentRunCandidates,
  "agent cancel:run": agentRunCandidates,
  "cell get-label:path": cellPathCandidates,
  "piece get-label:path": cellPathCandidates,
  "cell set-label:path": cellPathCandidates,
  "piece set-label:path": cellPathCandidates,
  "piece call:callable": callableCandidates,
  "call:callable": callableCandidates,
  // The first positional of `cf cell get`/`cf cell set` is a cell path unless the caller
  // writes a canonical address there, and an address is pasted rather than
  // completed — so the path candidates serve the slot either way.
  "cell get:addressOrPath": cellPathCandidates,
  "get:addressOrPath": cellPathCandidates,
  "cell get:path": cellPathCandidates,
  "get:path": cellPathCandidates,
  "cell set:addressOrPath": cellPathCandidates,
  "set:addressOrPath": cellPathCandidates,
  "cell set:path": cellPathCandidates,
  "set:path": cellPathCandidates,
  "piece link:source": pieceWithPathCandidates,
  "piece link:target": pieceWithPathCandidates,
  // Naming an existing slug re-points it, which is the case completion helps
  // with; a slug being coined for the first time is a word nothing can offer.
  "piece set-slug:slug": slugCandidates,
  // A slug redirects to a cell, which is a piece and a path inside it — the
  // spelling that points a name at a collection. Same grammar as a link
  // endpoint, so the same candidates.
  "piece set-slug:source": pieceWithPathCandidates,
  "piece new:main": patternFiles,
  "piece setsrc:main": patternFiles,
  "check:files": patternFiles,
  "test:paths": patternFiles,
  "view:file": () => Promise.resolve(directive({ kind: "files" })),
  "exec:mountedFile": () => Promise.resolve(directive({ kind: "files" })),
  "id did:keypath": () =>
    Promise.resolve(directive({ kind: "files", glob: "*.key" })),
  "piece set-home:main": patternFiles,
  "space set-home:main": patternFiles,
  "piece getsrc:outpath": () => Promise.resolve(directive({ kind: "files" })),
  "deps update:file": () => Promise.resolve(directive({ kind: "files" })),
  "fuse mount:mountpoint": () => Promise.resolve(directive({ kind: "dirs" })),
  "fuse unmount:mountpoint": () => Promise.resolve(directive({ kind: "dirs" })),
  "wish:target": () => Promise.resolve(wishTargetCandidates()),
  // `inspect pull` names a space on the REMOTE, resolved through
  // `resolveRemoteDid` against the remote's own listing, so a locally
  // discovered DID is a candidate the command rejects. Listing the remote is a
  // network round trip a keystroke must not start, which leaves this slot
  // nothing honest to offer — decided, and decided as empty.
  "inspect pull:space": () => Promise.resolve(NOTHING),
  // `cf space` and `cf inspect` name a space positionally rather than through
  // `--space`. Both read the same local stores, so both take the same
  // candidates.
  "space clone:space": () => spaceCandidates(),
  "space fingerprint:space": () => spaceCandidates(),
  // `verify`/`reset` take a clone directory built by `space clone`.
  "space verify:dir": () => Promise.resolve(directive({ kind: "dirs" })),
  "space reset:dir": () => Promise.resolve(directive({ kind: "dirs" })),
  ...inspectSpaceProviders(),
  ...inspectEntityProviders(),
};

/**
 * Every `cf inspect` subcommand that names a space positionally.
 *
 * Generated from the list rather than written out, because the set is one
 * fact — "the inspect subcommands that open a space" — and eighteen table
 * entries repeating it is eighteen places for the nineteenth to be forgotten.
 */
function inspectSpaceProviders(): Record<
  string,
  (line: CompletionLine) => Promise<ProviderResult>
> {
  const entries: Record<
    string,
    (line: CompletionLine) => Promise<ProviderResult>
  > = {};
  for (const command of INSPECT_SPACE_COMMANDS) {
    entries[`inspect ${command}:space`] = (line) =>
      namesRemote(line) ? Promise.resolve(NOTHING) : spaceCandidates();
  }
  return entries;
}

/** The same, for the `<entity>` that follows a space on some of them. */
function inspectEntityProviders(): Record<
  string,
  (line: CompletionLine) => Promise<ProviderResult>
> {
  const entries: Record<
    string,
    (line: CompletionLine) => Promise<ProviderResult>
  > = {};
  for (const command of INSPECT_ENTITY_COMMANDS) {
    entries[`inspect ${command}:entity`] = entityCandidates;
  }
  return entries;
}

/**
 * What both provider tables answer, as command paths.
 *
 * For the gate that asks whether every slot has been decided about. Both keys
 * are derivable from the same command tree `resolveCompletionLine` walks, so
 * the drift between the tree and these tables is machine-detectable — in both
 * directions, since an entry matching no slot is the same subtraction run the
 * other way.
 *
 * An option maps to the command paths its provider answers on, or to `null`
 * where it answers on every command declaring it. A scoped provider answers
 * nothing off its paths, so a key alone would report those commands as decided
 * when what they get is silence.
 */
export function completionProviderKeys(): {
  readonly options: ReadonlyMap<string, readonly string[] | null>;
  readonly arguments: ReadonlySet<string>;
} {
  const options = new Map<string, readonly string[] | null>();
  for (const [name, provider] of Object.entries(OPTION_VALUE_PROVIDERS)) {
    options.set(name, provider.commands ?? null);
  }
  return {
    options,
    arguments: new Set(Object.keys(ARGUMENT_PROVIDERS)),
  };
}

/**
 * Run the provider for the line's slot.
 *
 * Any provider failure degrades to no candidates: completion must never
 * interrupt typing with an error, and a silent empty list is the honest signal
 * that live data was unavailable.
 */
export async function liveCandidates(
  line: CompletionLine,
): Promise<ProviderResult> {
  const slot = line.slot;
  if (!slot) return NOTHING;

  let provider:
    | ((line: CompletionLine) => Promise<ProviderResult>)
    | undefined;

  if (slot.kind === "option-value") {
    provider = OPTION_VALUE_PROVIDERS[longName(slot.option)];
  } else if (slot.kind === "argument") {
    provider = ARGUMENT_PROVIDERS[
      `${line.path.join(" ")}:${slot.argument.name}`
    ];
  }

  if (!provider) return NOTHING;

  try {
    return await provider(line);
  } catch {
    return NOTHING;
  }
}
