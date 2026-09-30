/**
 * Reading the source facts a piece records: the pattern it runs, the origin it
 * tracks, the history metadata it carries, and its authored source files.
 *
 * An origin is the source URL a piece remembers: either a `system:` ref naming
 * a pattern this deployment serves, or a fabric `cf:` URL.
 * `docs/specs/piece-source-lifecycle.md` is the design of record.
 */

import { isDID } from "@commonfabric/identity/did";
import {
  type Cell,
  fabricAuthorityMatchesSpaceHost,
  type FabricRef,
  formatFabricRef,
  getPatternIdentityRef,
  getPatternRepository,
  getPatternSource,
  getPieceReconciliation,
  getPieceSourceRevisions,
  type MemorySpace,
  NAME,
  normalizePatternSource,
  parseFabricRef,
  type PieceReconciliation,
  type ReconcileOutcome,
  resolveSystemPatternSource,
  type Runtime,
  type RuntimeProgram,
  spaceHostFromFabricAuthority,
} from "@commonfabric/runner";
import {
  entityKindOfIdString,
  stripEntityUriScheme,
  uriSchemeForEntityKind,
} from "@commonfabric/runner/entity-kind";
import { nameSchema } from "@commonfabric/runner/schemas";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * How an origin URL resolves.
 *
 * - `system`: a pattern this deployment's toolshed serves from its patterns
 *   directory, which a new release of the deployment can replace.
 * - `fabric-piece`: a stable, mutable fabric entity whose current pattern the
 *   origin names.
 * - `fabric-pattern`: exact content-addressed pattern source, either named
 *   directly or fixed by a trailing pin.
 */
export type PieceOriginKind = "system" | "fabric-piece" | "fabric-pattern";

export interface PieceOrigin {
  /** The canonical origin URL. */
  url: string;

  kind: PieceOriginKind;

  /**
   * The URL as it was recorded on the piece, when normalization changed it. A
   * `system:` ref becomes the absolute route it addresses, so the recorded
   * form is kept for display.
   */
  recorded?: string;
}

/** Everything the source surfaces read off one piece. */
export interface PieceSourceState {
  space: MemorySpace;
  pieceId: string;
  name?: string;

  /** The exact executable export the piece runs. */
  pattern?: { identity: string; symbol: string };

  /** The identity whose complete setup state was installed. */
  setupPattern?: { identity: string; symbol: string };

  /** The pattern identity an in-place update replaced, when one did. */
  displacedPattern?: { identity: string; symbol: string; displacedAt?: number };

  /** The active origin, absent when the piece is detached. */
  origin?: PieceOrigin;

  /**
   * A recorded source string no resolver can follow, with why. A piece
   * carrying one is neither following nor detached: it holds something a
   * person can read and repair.
   */
  unusableOrigin?: { recorded: string; reason: string };

  /**
   * What following the active origin last did. Absent when nothing has
   * reconciled this piece against its origin.
   */
  reconciliation?: PieceReconciliation;

  /** Descriptive repository locator; never followed. */
  repository?: string;

  /** The canonical entry filename of the retained source, when readable. */
  entry?: string;

  /** The authored source files of the current pattern, when readable. */
  files: { name: string; contents: string }[];

  /** Names among `files` that carry data rather than code. */
  dataFiles?: string[];

  /** Ordered, append-only source and origin states accepted by the piece. */
  history: PieceSourceRevisionState[];

  currentRevisionId?: string;
}

export interface PieceSourceRevisionState {
  revisionId: string;
  timestamp: number;
  pattern: { identity: string; symbol: string };
  origin?: PieceOrigin;
  operation:
    | "baseline"
    | "create"
    | "edit"
    | "origin-update"
    | "detach"
    | "revert"
    | "follow"
    | "repoint";
  selectedRevisionId?: string;
}

/**
 * Resolve the piece's origin and adopt its current source when it has moved.
 *
 * This runs when a user opens a piece. A candidate from an origin this
 * deployment does not gate the releases of has to prove itself first;
 * `SourceReconciler` carries which origins those are, and why.
 */
export function reconcilePieceSource(
  runtime: Runtime,
  piece: Cell<unknown>,
): Promise<ReconcileOutcome> {
  return runtime.sourceReconciler.reconcile(piece);
}

export class PieceOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PieceOriginError";
  }
}

/** The identity a fabric ref pins, when the ref is immutable. */
function pinnedPatternIdentity(ref: FabricRef): string | undefined {
  if (ref.pin !== undefined) return ref.pin;
  return ref.ref.kind === "uri" && ref.ref.scheme === "pattern"
    ? ref.ref.hash
    : undefined;
}

export interface ResolvedPieceOriginSource {
  program: RuntimeProgram;
  pattern: { identity?: string; symbol: string };
}

type StableFabricRef = FabricRef & {
  ref: Extract<FabricRef["ref"], { kind: "uri" }>;
};

/** Make a relative fabric origin keep its meaning in another space. */
export function qualifyFabricOrigin(
  recorded: string,
  sourceSpace: MemorySpace,
): string {
  const ref = parseFabricRef(recorded);
  return ref === undefined || ref.space !== undefined
    ? recorded
    : formatFabricRef({ ...ref, space: sourceSpace });
}

/**
 * Resolves an origin now, returning the authored program and selected export a
 * repoint transition should apply.
 *
 * `self` names the piece the origin is being resolved for. A mutable fabric
 * origin naming that piece is rejected: a piece that follows itself supplies
 * its own next source, and there is no source outside it for either end of
 * that loop to adopt.
 */
export async function resolvePieceOriginSource(
  runtime: Runtime,
  destinationSpace: MemorySpace,
  recorded: string,
  historicalSymbol: string,
  options: { self?: { space: MemorySpace; pieceId: string } } = {},
): Promise<ResolvedPieceOriginSource> {
  const origin = classifyOrigin(runtime, destinationSpace, recorded);
  if (origin.kind === "system") {
    const program = await runtime.harness.resolve(
      new HttpProgramResolver(
        origin.url,
        (input, init) =>
          runtime.fetch(input, {
            ...init,
            cache: "no-cache",
          }),
      ),
    );
    return {
      program: { ...program, mainExport: historicalSymbol },
      pattern: { symbol: historicalSymbol },
    };
  }

  const ref = parseFabricRef(origin.url)!;
  if (ref.subpath !== undefined) {
    throw new PieceOriginError("piece source subpaths are not supported");
  }
  if (ref.ref.kind === "slug") {
    throw new PieceOriginError(
      "piece origins require a stable fabric entity or pattern reference",
    );
  }
  const stableRef = ref as StableFabricRef;
  if (ref.space !== undefined && !isDID(ref.space)) {
    throw new PieceOriginError(
      "piece origins require an explicit space DID",
    );
  }
  const sourceSpace = ref.space === undefined
    ? destinationSpace
    : ref.space as MemorySpace;

  // Before the host below is registered, because registering it changes the
  // route the space resolves through: a reference this call is going to
  // refuse must not leave that behind.
  const pinned = pinnedPatternIdentity(stableRef);
  const self = options.self;
  if (
    pinned === undefined && self !== undefined &&
    sourceSpace === self.space && namesEntity(stableRef, self.pieceId)
  ) {
    throw new PieceOriginError("a piece cannot follow itself");
  }

  if (ref.host !== undefined) {
    const routedUrl = new URL(
      runtime.mappedHostFor(sourceSpace) ??
        runtime.hostForSpace(sourceSpace),
    );
    const explicitRoute = spaceHostFromFabricAuthority(ref.host, {
      useLoopbackHttp: routedUrl.protocol === "http:",
    });
    const matchesCurrentRoute =
      (routedUrl.protocol === "http:" || routedUrl.protocol === "https:") &&
      fabricAuthorityMatchesSpaceHost(ref.host, routedUrl.origin);
    if (!matchesCurrentRoute) {
      if (sourceSpace !== destinationSpace) {
        throw new PieceOriginError(
          `the cross-space host ${ref.host} is not an accepted route for ${sourceSpace}`,
        );
      }
      if (!runtime.registerSpaceHost(sourceSpace, explicitRoute.toString())) {
        throw new PieceOriginError(
          `the host ${ref.host} is not available for ${sourceSpace}`,
        );
      }
    }
  }

  const pattern = pinned === undefined
    ? await mutableFabricOriginPattern(runtime, sourceSpace, stableRef)
    : { identity: pinned, symbol: historicalSymbol };
  if (pattern === undefined) {
    throw new PieceOriginError(
      `${origin.url} does not currently resolve to a piece pattern`,
    );
  }

  const program = await runtime.patternManager
    .getPatternSourceProgramByIdentity(
      pattern.identity,
      sourceSpace,
      destinationSpace,
    );
  if (program === undefined) {
    throw new PieceOriginError(
      `source for ${pattern.identity} is not available`,
    );
  }
  return {
    program: { ...program, mainExport: pattern.symbol },
    pattern,
  };
}

/**
 * Whether a stable fabric reference names the entity `pieceId` addresses. The
 * id can arrive as a bare tagged hash or as its schemed URI, so both are
 * reduced to the kind and hash the reference carries.
 */
function namesEntity(ref: StableFabricRef, pieceId: string): boolean {
  return uriSchemeForEntityKind(entityKindOfIdString(pieceId)) ===
      ref.ref.scheme &&
    stripEntityUriScheme(pieceId) === `fid1:${ref.ref.hash}`;
}

async function mutableFabricOriginPattern(
  runtime: Runtime,
  sourceSpace: MemorySpace,
  ref: StableFabricRef,
): Promise<{ identity: string; symbol: string } | undefined> {
  const target: Cell<unknown> = runtime.getCellFromEntityId(
    sourceSpace,
    `${ref.ref.scheme}:fid1:${ref.ref.hash}`,
  );
  await target.sync();
  return getPatternIdentityRef(target);
}

/**
 * Classify a recorded source string as an origin.
 *
 * A `system:` ref, and the toolshed-relative path that is the legacy shape
 * system roots were stamped with, both resolve against the host accepted for
 * `space`, so the origin that leaves this function is always absolute. An
 * unusable string throws rather than becoming a silently inert origin.
 */
export function classifyOrigin(
  runtime: Runtime,
  space: MemorySpace,
  recorded: string,
): PieceOrigin {
  const source = recorded.trim();
  if (source.length === 0) {
    throw new PieceOriginError("origin is empty");
  }

  // The fabric parser decides whether this is a fabric URL: it returns undefined
  // for anything that is not one, and throws for a fabric URL it cannot read. A
  // malformed one reports as an unusable origin like any other unusable string,
  // rather than as a parser error from a layer below.
  let ref;
  try {
    ref = parseFabricRef(source);
  } catch (cause) {
    throw new PieceOriginError(
      `${source} is not a usable fabric URL: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (ref !== undefined) {
    return {
      url: source,
      kind: pinnedPatternIdentity(ref) === undefined
        ? "fabric-piece"
        : "fabric-pattern",
    };
  }

  // A `system:` ref names a pattern this deployment's toolshed serves. It
  // carries the absolute route it resolves to, keeping the ref itself as the
  // recorded form so the panel shows what the piece actually stores.
  const systemRoute = resolveSystemPatternSource(source);
  if (systemRoute !== undefined) {
    return systemOrigin(
      new URL(systemRoute, runtime.hostForSpace(space)),
      source,
    );
  }

  if (source.startsWith("/")) {
    const host = new URL(runtime.hostForSpace(space));
    const resolved = new URL(source, host);
    // A rooted path names a file on the host serving this space, and several
    // strings that begin with a slash do not. `//elsewhere/x` is one;
    // `/\elsewhere/x` is another, because the URL parser reads a backslash as
    // a separator. Both read as local and resolve somewhere else, and nothing
    // follows either, so a piece that accepted one would be left in the state
    // this lifecycle exists to prevent: an origin reported as fine that no
    // reconciliation will ever reach.
    //
    // What settles it is where the string actually resolved, not how it was
    // spelled. A guard written against the spellings would have to grow one
    // arm per trick the parser knows.
    if (resolved.origin !== host.origin) {
      throw new PieceOriginError(
        `${source} resolves to ${resolved.origin}, not the host serving ` +
          `this space; write the URL out if that is what you meant`,
      );
    }
    // Resolving to this host is not enough. The path also has to name a file
    // under the patterns route, because that route is the only thing this
    // deployment serves as a program; any other path answers with whatever the
    // site returns for it. `normalizePatternSource` yields the `system:` ref
    // when the path names such a file and the input unchanged when it does
    // not, which is the same test reconciliation applies before rewriting it.
    if (normalizePatternSource(source, host) === source) {
      throw new PieceOriginError(
        `${source} addresses nothing under the patterns route`,
      );
    }
    return systemOrigin(resolved, source);
  }

  // The reasons below match `classifyPieceOriginString` word for word. The two
  // classifiers answer different questions, and a test holds them to the same
  // boundary; saying the same thing about a string neither can follow is what
  // makes a panel's explanation and a reconciliation's refusal one answer.
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new PieceOriginError(`${source} is not an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new PieceOriginError(`${source} names no program`);
  }

  // The absolute spelling of a patterns-route locator on the host serving this
  // space is the same file a `system:` ref names, and reconciliation rewrites
  // it to that ref. It has to classify as followable here too, or the panel
  // would call an origin unusable that reconciliation goes on following.
  if (normalizePatternSource(source, runtime.hostForSpace(space)) !== source) {
    return systemOrigin(url, source);
  }

  // Anything else absolute names an endpoint outside this deployment. A piece
  // follows what the deployment serves and what the fabric holds, so such a
  // string names no origin at all.
  throw new PieceOriginError(
    `${source} is an external endpoint, which is not a source origin`,
  );
}

/**
 * A deployment-served origin at its canonical route URL, keeping the recorded
 * string whenever canonicalizing changed it — a `system:` ref, and the rooted
 * path that is the spelling those carried before the scheme existed. The panel
 * shows the recorded form beside the canonical one, so what a piece stores
 * stays visible.
 */
function systemOrigin(url: URL, recorded: string): PieceOrigin {
  return {
    url: url.href,
    kind: "system",
    ...(url.href === recorded ? {} : { recorded }),
  };
}

/**
 * Accept a source URL a person typed, returning the string to record as the
 * active origin.
 *
 * Classification decides which kind of origin the string is and rejects one no
 * resolver can follow. On top of that, an origin may not carry credentials: a
 * piece's origin is readable by everyone who can read the piece, and an
 * authenticated fetch supplies its credential through a separately protected
 * capability.
 */
export function acceptEnteredOrigin(
  runtime: Runtime,
  space: MemorySpace,
  entered: string,
): string {
  const recorded = entered.trim();
  const origin = classifyOrigin(runtime, space, recorded);
  if (carriesCredentials(origin.url)) {
    throw new PieceOriginError("a source URL may not carry credentials");
  }
  return recorded;
}

/**
 * Whether a URL carries user information. A fabric URL with an authority can,
 * the same as any other; one with no authority parses with both fields empty.
 * Classification returns either a URL the parser has already accepted or a
 * `cf:` reference, so parsing here cannot fail.
 */
function carriesCredentials(url: string): boolean {
  const parsed = new URL(url);
  return parsed.username !== "" || parsed.password !== "";
}

/**
 * The active origin recorded on `piece`, or undefined when it is detached.
 * A recorded string this runtime cannot classify is reported as detached: it
 * names no place the source can be resolved from.
 */
export function readPieceOrigin(
  runtime: Runtime,
  piece: Cell<unknown>,
): PieceOrigin | undefined {
  const recorded = getPatternSource(piece);
  if (recorded === undefined) return undefined;
  try {
    return classifyOrigin(runtime, piece.space, recorded);
  } catch {
    return undefined;
  }
}

/** Read source metadata already present in the local replica. */
export function readPieceSourceMetadata(
  runtime: Runtime,
  piece: Cell<unknown>,
): PieceSourceState {
  const pattern = getPatternIdentityRef(piece);
  const state: PieceSourceState = {
    space: piece.space,
    pieceId: piece.getAsNormalizedFullLink().id,
    files: [],
    history: [],
  };
  const name = piece.asSchema(nameSchema).get()?.[NAME];
  if (typeof name === "string") state.name = name;
  if (pattern !== undefined) state.pattern = pattern;
  const setupPattern = piece.getMetaRaw("patternSetupIdentity");
  if (isPatternRef(setupPattern)) state.setupPattern = setupPattern;
  const displaced = readDisplacedPattern(piece.getMetaRaw("displacedPattern"));
  if (displaced !== undefined) state.displacedPattern = displaced;
  const recordedOrigin = getPatternSource(piece);
  if (recordedOrigin !== undefined) {
    try {
      state.origin = classifyOrigin(runtime, piece.space, recordedOrigin);
    } catch (error) {
      // Every string it cannot classify leaves `classifyOrigin` as a
      // PieceOriginError, so there is no other shape to read a reason from.
      state.unusableOrigin = {
        recorded: recordedOrigin,
        reason: (error as PieceOriginError).message,
      };
    }
  }
  const reconciliation = getPieceReconciliation(piece);
  if (reconciliation !== undefined) state.reconciliation = reconciliation;
  const repository = getPatternRepository(piece);
  if (repository !== undefined) state.repository = repository;
  const revisions = getPieceSourceRevisions(piece);
  state.history = revisions.map((revision) => {
    const historyOrigin = revision.origin === undefined
      ? undefined
      : tryClassifyOrigin(runtime, piece.space, revision.origin);
    if (
      historyOrigin !== undefined &&
      revision.recordedOrigin !== undefined
    ) {
      historyOrigin.recorded = revision.recordedOrigin;
    }
    return {
      revisionId: revision.revisionId,
      timestamp: revision.timestamp,
      pattern: revision.pattern,
      ...(historyOrigin === undefined ? {} : { origin: historyOrigin }),
      operation: revision.operation,
      ...(revision.selectedRevisionId === undefined
        ? {}
        : { selectedRevisionId: revision.selectedRevisionId }),
    };
  });
  const currentRevisionId = revisions.at(-1)?.revisionId;
  if (currentRevisionId !== undefined) {
    state.currentRevisionId = currentRevisionId;
  }
  const currentRevision = revisions.at(-1);
  if (
    state.origin !== undefined &&
    currentRevision?.origin === state.origin.url &&
    currentRevision.recordedOrigin !== undefined
  ) {
    state.origin.recorded = currentRevision.recordedOrigin;
  }
  return state;
}

/** Read every source fact a piece carries, with its authored source files. */
export async function readPieceSourceState(
  runtime: Runtime,
  piece: Cell<unknown>,
): Promise<PieceSourceState> {
  await piece.sync();
  const state = readPieceSourceMetadata(runtime, piece);
  if (state.pattern !== undefined) {
    const program = await runtime.patternManager
      .getPatternSourceProgramByIdentity(
        state.pattern.identity,
        piece.space,
      );
    if (program !== undefined) {
      state.entry = program.main;
      state.files = sortSourceFiles(program.files, program.main);
      if (program.dataFiles !== undefined) state.dataFiles = program.dataFiles;
    }
  }
  return state;
}

export interface PieceSourceRevisionSource {
  pattern: { identity: string; symbol: string };
  files: { name: string; contents: string }[];

  /** Names among `files` that carry data rather than code. */
  dataFiles?: string[];
}

/** Read the retained authored files for one recorded source revision. */
export async function readPieceSourceRevision(
  runtime: Runtime,
  piece: Cell<unknown>,
  revisionId: string,
): Promise<PieceSourceRevisionSource> {
  await piece.sync();
  const revision = getPieceSourceRevisions(piece).find((candidate) =>
    candidate.revisionId === revisionId
  );
  if (revision === undefined) {
    throw new PieceOriginError(`source revision ${revisionId} was not found`);
  }
  const program = await runtime.patternManager
    .getPatternSourceProgramByIdentity(
      revision.pattern.identity,
      piece.space,
    );
  return {
    pattern: revision.pattern,
    files: program === undefined
      ? []
      : sortSourceFiles(program.files, program.main),
    ...(program?.dataFiles === undefined
      ? {}
      : { dataFiles: program.dataFiles }),
  };
}

function tryClassifyOrigin(
  runtime: Runtime,
  space: MemorySpace,
  recorded: string,
): PieceOrigin | undefined {
  try {
    return classifyOrigin(runtime, space, recorded);
  } catch {
    return undefined;
  }
}

function isPatternRef(
  value: unknown,
): value is { identity: string; symbol: string } {
  return isObjectOrArray(value) &&
    typeof (value as { identity?: unknown }).identity === "string" &&
    typeof (value as { symbol?: unknown }).symbol === "string";
}

/**
 * The pattern an in-place update replaced, from the `displacedPattern` meta
 * that `applyPieceSourceTransition` and the default-root roll-forward heal
 * write. Its timestamp is optional.
 */
function readDisplacedPattern(
  value: unknown,
): PieceSourceState["displacedPattern"] {
  if (!isPatternRef(value)) return undefined;
  const displacedAt = (value as { displacedAt?: unknown }).displacedAt;
  return {
    identity: value.identity,
    symbol: value.symbol,
    ...(typeof displacedAt === "number" ? { displacedAt } : {}),
  };
}

/** Entry file first, then the rest by filename. */
function sortSourceFiles(
  files: { name: string; contents: string }[],
  entry: string,
): { name: string; contents: string }[] {
  return [...files].sort((a, b) => {
    if (a.name === entry) return -1;
    if (b.name === entry) return 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
