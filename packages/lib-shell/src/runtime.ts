import type { CellScope } from "@commonfabric/api";
import { createSession, DID, Identity, Session } from "@commonfabric/identity";
import { CFC_CONCEPT_KIND, cfcAtom } from "@commonfabric/api/cfc";
import type { FabricPlainObject } from "@commonfabric/data-model";
import { entityRefFromString } from "@commonfabric/data-model/cell-rep";
import { navigate } from "@commonfabric/navigation";
import { slugIdForSpace } from "@commonfabric/runner/slugs";
import { NameSchema } from "@commonfabric/runner/schemas";
import {
  attachOptionsFrom,
  CellHandle,
  FavoritesManager,
  PieceHandle,
  type PieceSourceView,
  Program,
  RuntimeClient,
  RuntimeClientEvents,
  RuntimeClientOptions,
  RuntimeTelemetryMarkerResult,
  type RuntimeTransport,
} from "@commonfabric/runtime-client";
import { WebWorkerRuntimeTransport } from "@commonfabric/runtime-client/transports/web-worker";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("lib-shell.runtime", {
  enabled: false,
  level: "debug",
});

const identityLogger = getLogger("lib-shell.identity", {
  enabled: false,
  level: "debug",
});

/**
 * The worker's experimental-flag declaration — the runtime-client protocol's
 * own record, not a copy: a host-side copy that lagged the protocol silently
 * dropped whichever flag it omitted, reverting the worker to that flag's
 * default while the host ran the other arm.
 */
export type ExperimentalRuntimeFlags = NonNullable<
  RuntimeClientOptions["experimental"]
>;

export type RuntimeCfcEnforcementMode = NonNullable<
  RuntimeClientOptions["cfcEnforcementMode"]
>;

export type RuntimeCfcFlowLabelsMode = NonNullable<
  RuntimeClientOptions["cfcFlowLabels"]
>;

export type RuntimeTrustSnapshot = NonNullable<
  RuntimeClientOptions["trustSnapshot"]
>;

export type RuntimeRenderConfidentialityCeiling = NonNullable<
  RuntimeClientOptions["renderConfidentialityCeiling"]
>;

/**
 * The §8.10.6 initial display-sink release ceiling (Epic H3a/H3b,
 * docs/history/plans/cfc-future-work-implementation.md): what a display surface
 * admits when no authored policy covers it. The audience of a display sink
 * is the acting user, so the identity/personal-space principal forms naming
 * exactly that audience are admissible by construction. Shared `Space(...)`
 * principals are NOT listed here — they resolve to the acting user via the
 * verified `HasRole` exchange rules at the render boundary (H3b), so the
 * runner-side resolver admits them without widening this static ceiling.
 *
 * Tighten-only evolution (spec §8.10.6): removing an entry needs no
 * ceremony; admitting a new atom family or caveat kind is a release
 * decision that needs authored policy or verified authority.
 */
export function defaultRenderConfidentialityCeiling(
  actingUser: DID,
): RuntimeRenderConfidentialityCeiling {
  return {
    // Acting-user identity atoms: the audience of a display sink is the
    // acting user, so atoms naming exactly that audience are admissible by
    // construction (spec §8.10.6). Both the §15.2 principal atom objects
    // (`User`, `PersonalSpace`) and the legacy DID-string form are listed —
    // the ceiling is a set, and every entry names exactly this audience.
    atoms: [
      cfcAtom.user(actingUser),
      cfcAtom.personalSpace(actingUser),
      actingUser,
    ],
    // Influence-class caveat kinds, whose canonical display release is the
    // rendered-disclosure rule (§8.10.5). Deliberately excludes
    // PromptInjectionRiskUnscreened: a material-risk kind that keeps its
    // ordinary discharge evidence (screening), not display disclosure.
    caveatKinds: [
      // The canonical influence-class concept id.
      CFC_CONCEPT_KIND.PromptInfluence,
      // Short-form alias minted by shipped example patterns
      // (cfc-spec-gallery, cfc-trusted-component-examples) and matched by
      // the cf-cfc-label disclosure UI.
      "prompt-influence",
    ],
  };
}

export type RuntimeNavigationTarget = { spaceDid: DID; pieceId: string };

export type RuntimeInternalsCallbacks = {
  navigate?: (target: RuntimeNavigationTarget) => void;
  onConsole?: (event: RuntimeClientEvents["console"][0]) => void;
  onError?: (event: RuntimeClientEvents["error"][0]) => void;
};

/**
 * Optional telemetry sink for the client marker stream. When provided (browser
 * OTel enabled), each marker is forwarded here IN ADDITION to the existing debug
 * handling. Structurally matches the browser OTel bridge returned by
 * packages/shell/src/lib/otel.ts, so this package pulls in no OTel code — the
 * embedder owns SDK setup and passes the sink in. Absent = zero added work.
 */
export interface RuntimeTelemetrySink {
  handleMarker(marker: RuntimeTelemetryMarkerResult): void;
  shutdown(): void | Promise<void>;
}

export type RuntimeInternalsCreateOptions = RuntimeInternalsCallbacks & {
  identity: Identity;
  apiUrl: URL;

  /**
   * Optional map from space DIDs to HTTP or HTTPS origins, forwarded to the
   * worker. Spaces absent from the map resolve to `apiUrl`, the default host.
   */
  spaceHostMap?: Record<string, string>;

  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;

  /**
   * Flow-label propagation dial (S16). Shell hosts default to "persist"
   * (Epic H2): derive the per-tx conservative join and write it as a
   * `derived` label component on every value write.
   */
  cfcFlowLabels?: RuntimeCfcFlowLabelsMode;

  /**
   * Populate the default render confidentiality ceiling. Defaults to on:
   * the worker's display sinks gate labeled values against the §8.10.6
   * profile for the acting identity, and author-supplied render-boundary
   * declassification is denied. `false` opts a host out, which renders
   * labeled content ungated.
   */
  cfcRenderCeiling?: boolean;

  /**
   * The trust the worker runs against. Its `actingPrincipal` is the identity
   * the runtime acts as, which is also the audience the render ceiling admits
   * when `cfcRenderCeiling` is on. Omit it to send one naming the session
   * identity; pass `null` to send none, which leaves the worker to build its
   * own, naming the session identity as well. A supplied snapshot without an
   * `actingPrincipal` leaves transaction trust unnamed; rendering falls back
   * to the session identity as its audience.
   */
  trustSnapshot?: RuntimeTrustSnapshot | null;

  /**
   * This shell build's identifier (normally `COMMIT_SHA`). Deployed builds use
   * it to select the immutable `/builds/<clientVersion>/` worker asset graph.
   */
  clientVersion?: string;

  /**
   * When true, forward the worker runtime's console output to the main
   * thread so it reaches devtools and integration-test console capture.
   * Off by default.
   */
  forwardWorkerConsole?: boolean;

  /**
   * When true, the worker runtime instruments pattern compiles for statement
   * coverage; the integration harness pulls the accumulated hits at teardown.
   * Test/CI only, off by default. See docs/development/COVERAGE.md.
   */
  patternCoverage?: boolean;

  /**
   * When true, the worker's remote storage overlaps watch-refresh round trips
   * up to a bounded window instead of strict single-flight
   * (`experimentalConcurrentWatchRefresh`). Dogfood flag, default off; fixed at
   * StorageManager.open time so it takes effect on the next runtime (reload).
   */
  concurrentWatchRefresh?: boolean;

  /**
   * Override the runtime worker URL. By default, deployed builds use the
   * immutable `/builds/<clientVersion>/` asset namespace while local builds
   * fall back to `/scripts/worker-runtime.js`.
   *
   * Ignored when `transport` supplies the connection, there being no worker to
   * address.
   */
  workerUrl?: URL;

  /**
   * The connection to the runtime's worker. Absent, this page spawns a
   * dedicated worker of its own and connects to that, which is what a page
   * with no runtime around it does.
   *
   * Supplied, the embedder has already made the connection and this page
   * speaks over it. How -- a port a family root's page transferred, a channel
   * a native shell relays -- is the embedder's to know and nothing here reads.
   */
  transport?: RuntimeTransport;

  /**
   * Join the runtime already running behind `transport` rather than standing
   * one up. It says which client this page is: the one whose initialization
   * settles the runtime's identity and security posture, or one attaching to a
   * runtime whose posture is already settled and which it asserts rather than
   * declares.
   *
   * Only meaningful with `transport`: a worker this page spawned has no
   * runtime to attach to.
   */
  attach?: boolean;

  getBuildHash?: () => Promise<string | undefined>;

  /**
   * Optional telemetry sink (browser OTel bridge). Purely additive and gated by
   * the embedder: when omitted, no telemetry work happens.
   */
  telemetry?: RuntimeTelemetrySink;
};

/** {@link fetchBuildHash}'s module-level memo. */
let buildHashPromise: Promise<string | undefined> | undefined;

/**
 * Fetch the worker bundle hash from the build manifest. This cache-busts the
 * mutable root worker URL used by local/legacy builds. Deployed shell builds
 * use their immutable `/builds/<sha>/` namespace instead.
 *
 * Cached — the hash doesn't change within a page session, so the manifest is
 * fetched at most once.
 */
export function fetchBuildHash(): Promise<string | undefined> {
  if (!buildHashPromise) {
    buildHashPromise = (async () => {
      try {
        const resp = await fetch(
          new URL("/build-manifest.json", globalThis.location.origin),
          { cache: "no-store" },
        );
        if (resp.ok) {
          const manifest = await resp.json();
          // Key must match the worker entry's `out` path in felt.config.ts.
          return manifest["scripts/worker-runtime.js"] as string | undefined;
        }
      } catch {
        // Manifest not available — compilation cache disabled
      }
      return undefined;
    })();
  }
  return buildHashPromise;
}

/**
 * The URL this page's runtime worker is loaded from.
 *
 * Production deploys retain each complete module graph under its commit SHA.
 * Keeping the entry and all of its relative split chunks in that same
 * immutable namespace prevents a later root deployment from deleting a chunk
 * that a long-lived page still needs. An explicit `workerUrl` (local
 * development) or an absent `clientVersion` retains the mutable root URL and
 * its manifest cache-buster.
 *
 * {@link RuntimeInternals.create} calls this for the worker it spawns. It is
 * exported for the page that spawns one and then hands ports to it: such a
 * page holds the transport itself, and must reach the same URL doing so.
 */
export async function resolveWorkerUrl(
  options: {
    workerUrl?: URL;
    clientVersion?: string;
    getBuildHash?: () => Promise<string | undefined>;
  } = {},
): Promise<URL> {
  const { workerUrl, clientVersion, getBuildHash = fetchBuildHash } = options;
  const immutableBuildId = workerUrl === undefined && clientVersion
    ? clientVersion
    : undefined;
  const resolved = workerUrl ?? new URL(
    immutableBuildId
      ? `/builds/${
        encodeURIComponent(immutableBuildId)
      }/scripts/worker-runtime.js`
      : "/scripts/worker-runtime.js",
    globalThis.location.origin,
  );
  if (!immutableBuildId) {
    const buildHash = await getBuildHash();
    if (buildHash) resolved.searchParams.set("v", buildHash);
  }
  return resolved;
}

export function createRuntimeClientOptions({
  session,
  apiUrl,
  spaceHostMap,
  experimental,
  cfcEnforcementMode = "enforce-strict",
  // Epic H2 (docs/history/plans/cfc-future-work-implementation.md): shell hosts run the
  // flow-label dial at "persist" — the per-tx conservative join is derived AND
  // written as a `derived` label component on every value write. This
  // activates inv-9 (flow-path confidentiality) in real shell deployments:
  // reading labeled data and writing a derived value no longer launders the
  // label away. Safe to persist because re-derivation is idempotent (SC-11:
  // an unchanged label writes no envelope — see prepare.ts) so a rerun that
  // reads the same inputs does not churn the ["cfc"] doc; replace-on-overwrite
  // (§8.12.8) keeps the derived component tracking the current value rather
  // than ratcheting forever. H1 shipped "observe" as the measurement stage.
  cfcFlowLabels = "persist",
  // The §8.10.6 display ceiling, on by default. The worker resolves shared
  // `Space` labels through verified reader membership before the reconciler
  // fits them against the acting user's identity atoms and the admitted
  // influence-class caveat kinds. Author-supplied render declassification is
  // denied, and labels that still do not fit the ceiling stay blocked. The
  // shell's per-profile `commonfabric.cfcRenderCeiling(false)` toggle opts a
  // browser profile back out.
  cfcRenderCeiling = true,
  trustSnapshot,
  forwardWorkerConsole,
  patternCoverage,
  concurrentWatchRefresh,
}: {
  session: Session;
  apiUrl: URL;
  spaceHostMap?: Record<string, string>;
  experimental?: ExperimentalRuntimeFlags;
  cfcEnforcementMode?: RuntimeCfcEnforcementMode;
  cfcFlowLabels?: RuntimeCfcFlowLabelsMode;
  cfcRenderCeiling?: boolean;
  trustSnapshot?: RuntimeTrustSnapshot | null;
  forwardWorkerConsole?: boolean;
  patternCoverage?: boolean;
  concurrentWatchRefresh?: boolean;
}) {
  // The identity the runtime renders as. A delegated host names it in its own
  // trust snapshot; a snapshot that names nobody leaves the session identity
  // as the render audience, the fallback the worker's own resolver applies to
  // the same field in `runtime-processor.ts`.
  const actingPrincipal = trustSnapshot?.actingPrincipal ?? session.as.did();
  const resolvedTrustSnapshot = trustSnapshot === undefined
    ? { id: `principal:${actingPrincipal}`, actingPrincipal }
    : trustSnapshot ?? undefined;

  return {
    apiUrl,
    spaceHostMap,
    identity: session.as,
    spaceIdentity: session.spaceIdentity,
    spaceDid: session.space,
    spaceName: session.spaceName,
    experimental,
    cfcEnforcementMode,
    cfcFlowLabels,
    ...(cfcRenderCeiling
      ? {
        renderDeclassificationPolicy: "deny" as const,
        // A display sink's audience is the identity the runtime renders as.
        renderConfidentialityCeiling: defaultRenderConfidentialityCeiling(
          actingPrincipal,
        ),
      }
      : {}),
    trustSnapshot: resolvedTrustSnapshot,
    forwardWorkerConsole,
    patternCoverage,
    concurrentWatchRefresh,
  };
}

/** One loaded piece, and whether the load started it. */
interface PatternCacheEntry {
  promise: Promise<PieceHandle<NameSchema>>;
  started: boolean;
}

/** Where a slug reference lands, as a page address can carry it. */
export interface SlugReferenceTarget {
  /** The piece the reference reached, in the routing form of its id. */
  pieceId: string;

  /**
   * The scope the piece's document sits in. A member reached through a link
   * into a narrower scope is a piece like any other, and its id addresses it
   * only alongside this — which is why it is carried rather than assumed.
   */
  scope: CellScope;

  /**
   * What is left of the reference after that piece. Empty where a member
   * named a member; the member itself where the slug named a piece at its
   * root, whose address does not include it — an address the caller has to
   * settle before citing what it is showing.
   */
  pathAfter: string[];

  /** Absent, which is what distinguishes a landing from a refusal. */
  refusal?: undefined;
}

/**
 * Why a slug reference reached no piece. A name nobody bound, or a member a
 * collection does not hold, is an answer to the question asked rather than a
 * fault, and a caller tells the two apart by which of these it gets.
 */
export interface SlugReferenceRefusal {
  refusal: {
    /** Which refusal it is, as the runner's slug resolution names them. */
    code: string;

    /** What to tell a reader, naming the collection and member it knows. */
    message: string;
  };
}

/**
 * RuntimeInternals bundles all resources bound to an identity/host pair:
 * ONE runtime serving all of that identity's spaces over one worker.
 * There is no bound/current space — a space is just part of an address,
 * like an id, and every space-scoped method names it explicitly. (The
 * "current space" of the old one-piece-at-a-time shell is view state,
 * owned by the embedder.)
 */
export class RuntimeInternals extends EventTarget {
  #client: RuntimeClient;
  #disposed = false;
  #favorites: FavoritesManager;
  #callbacks: RuntimeInternalsCallbacks;

  /** Cached space roots, with whether the cached one was STARTED: a
   * started root also answers a caller that only reads its exports, while
   * one resolved without starting does not answer a caller that needs it
   * running. */
  #spaceRootPatterns: Map<
    DID,
    { pattern: Promise<PieceHandle<NameSchema>>; started: boolean }
  > = new Map();
  /**
   * Loaded pieces, nested space → scope → id: a piece's whole address, held
   * as the three things it is. One id in two scopes is two documents, and an
   * id carries colons of its own (`of:fid1:…` beside `fid1:…`), so an
   * address flattened into one string is one a reader has to take apart
   * again — and taking it apart is what answered about one piece and evicted
   * another. Nested, there is nothing to parse: a lookup walks to the entry
   * and an eviction deletes from the map it sits in.
   *
   * An entry carries whether the load was STARTED: a started piece answers a
   * caller that only reads it, while one loaded without starting does not
   * answer a caller that needs it running.
   */
  #patternCache: Map<
    DID,
    Map<CellScope, Map<string, PatternCacheEntry>>
  > = new Map();
  // TODO(runtime-worker-refactor)
  #telemetryMarkers: RuntimeTelemetryMarkerResult[] = [];

  /** Optional OTel sink (browser telemetry enabled). Inert when `undefined`. */
  #telemetrySink?: RuntimeTelemetrySink;

  constructor(
    client: RuntimeClient,
    callbacks: RuntimeInternalsCallbacks = {},
    telemetry?: RuntimeTelemetrySink,
  ) {
    super();
    this.#client = client;
    this.#callbacks = callbacks;
    this.#telemetrySink = telemetry;
    this.#favorites = new FavoritesManager(client);
    this.#client.on("console", this.#onConsole);
    this.#client.on("navigaterequest", this.#onNavigateRequest);
    this.#client.on("error", this.#onError);
    this.#client.on("telemetry", this.#onTelemetry);
  }

  /**
   * How many spaces the pattern cache is holding levels for, which a test
   * reads to check that an eviction left none behind.
   */
  get accessForTestingOnly(): { readonly patternCacheSize: number } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get patternCacheSize() {
        return outerThis.#patternCache.size;
      },
    };
  }

  runtime(): RuntimeClient {
    return this.#client;
  }

  telemetry(): RuntimeTelemetryMarkerResult[] {
    return this.#telemetryMarkers;
  }

  favorites(): FavoritesManager {
    this.#check();
    return this.#favorites;
  }

  /**
   * Creates a piece in the given space, `options.argument` being the record of
   * inputs it is created with. `options.cause` derives its identity within
   * the space: repeated calls reapply setup to the same piece.
   */
  async createPiece<T>(
    space: DID,
    source: URL | Program | string,
    options?: { argument?: FabricPlainObject; run?: boolean; cause?: string },
  ): Promise<PieceHandle<T>> {
    this.#check();
    const piece = await this.#client.createPiece<T>(source, space, options);
    if (!piece) {
      throw new Error("Could not create piece");
    }
    return piece;
  }

  /**
   * A piece's source state: the pattern it runs, the origin it tracks, the
   * history metadata it carries, and its authored source files. `scope`
   * completes the id into a document address and defaults to the space.
   */
  getPieceSource(
    space: DID,
    pieceId: string,
    scope?: CellScope,
  ): Promise<PieceSourceView> {
    this.#check();
    return this.#client.getPieceSource(pieceId, space, scope);
  }

  getPiecesListCell<T>(space: DID): Promise<CellHandle<T[]>> {
    this.#check();
    return this.#client.getPiecesListCell<T>(space);
  }

  /**
   * The space's root pattern. `start` defaults to true, which a view that
   * renders the root needs; pass false to read its exports without running
   * it.
   */
  getSpaceRootPattern(
    space: DID,
    options: { start?: boolean } = {},
  ): Promise<PieceHandle<NameSchema>> {
    this.#check();
    const start = options.start ?? true;
    const cached = this.#spaceRootPatterns.get(space);
    if (cached && (cached.started || !start)) return cached.pattern;
    const pattern = this.#client.getSpaceRootPattern(space, { start });
    const entry = { pattern, started: start };
    this.#spaceRootPatterns.set(space, entry);
    // Evict on rejection: a transient failure (unreachable host, authz)
    // must not poison the space for the runtime's lifetime.
    pattern.catch(() => {
      if (this.#spaceRootPatterns.get(space) === entry) {
        this.#spaceRootPatterns.delete(space);
      }
    });
    return pattern;
  }

  resolveSpaceName(name: string): Promise<DID> {
    this.#check();
    return this.#client.resolveSpaceName(name);
  }

  async recreateSpaceRootPattern(space: DID): Promise<PieceHandle<NameSchema>> {
    this.#check();
    // Clear cached pattern since we're recreating it
    this.#spaceRootPatterns.delete(space);
    const pattern = await this.#client.recreateSpaceRootPattern(space);
    this.#spaceRootPatterns.set(space, {
      pattern: Promise.resolve(pattern),
      started: true,
    });
    return pattern;
  }

  /**
   * Get a piece's handle. By default this also STARTS the piece
   * (instantiates its pattern in the worker) — appropriate for the piece
   * about to be displayed. Pass `start: false` for read-only consumers
   * (e.g. listing piece names): the persisted result cell is synced and
   * readable without paying pattern instantiation for every piece
   * (starting every registered piece on reload cost about ten seconds of
   * dependency collection, either during reload or on the first interaction).
   *
   * Cached per (space, scope, id) — a pattern's whole address. A cache entry
   * created with `start: false` is upgraded (re-fetched with start) when a
   * starting caller asks for the same pattern.
   */
  getPattern(
    space: DID,
    id: string,
    options?: { start?: boolean; scope?: CellScope },
  ): Promise<PieceHandle<NameSchema>> {
    this.#check();
    const start = options?.start ?? true;
    // One id in two scopes is two documents, so a caller that named no scope
    // asks about the space's.
    const scope = options?.scope ?? "space";
    const byId = this.#patternCacheSlot(space, scope);
    const cached = byId.get(id);
    if (cached && (cached.started || !start)) {
      return cached.promise;
    }
    const promise = (async () => {
      const piece = await this.#client.getPiece<NameSchema>(
        id,
        space,
        start,
        scope,
      );
      if (!piece) {
        throw new Error(`Pattern not found: ${id}`);
      }
      return piece;
    })();
    const entry: PatternCacheEntry = { promise, started: start };
    byId.set(id, entry);
    // Evict on rejection so the next request retries.
    promise.catch(() => {
      if (byId.get(id) === entry) this.#dropPattern(space, scope, id);
    });
    return promise;
  }

  /**
   * Drop every cached load of `id` in `space`, whatever scope it was loaded
   * in. A caller naming a piece to invalidate knows the piece, not which
   * scope some other caller reached it through, and an entry left behind is
   * a stale piece handed to the next reader.
   *
   * Reached by walking the address rather than by matching a spelling of it.
   */
  invalidatePattern(space: DID, id: string): void {
    for (const scope of [...this.#patternCache.get(space)?.keys() ?? []]) {
      this.#dropPattern(space, scope, id);
    }
  }

  /**
   * Drop one loaded piece, and any level of the cache it was the last thing
   * in. A nested map holds a level per address component, so a level left
   * empty is a space or a scope the runtime goes on holding for a piece it
   * no longer has — and a run of failed lookups is a run of them.
   */
  #dropPattern(space: DID, scope: CellScope, id: string): void {
    const byScope = this.#patternCache.get(space);
    const byId = byScope?.get(scope);
    if (!byScope || !byId) return;
    byId.delete(id);
    if (byId.size > 0) return;
    byScope.delete(scope);
    if (byScope.size === 0) this.#patternCache.delete(space);
  }

  /** The map holding what `space` has loaded in `scope`, created on demand. */
  #patternCacheSlot(
    space: DID,
    scope: CellScope,
  ): Map<string, PatternCacheEntry> {
    let byScope = this.#patternCache.get(space);
    if (!byScope) {
      byScope = new Map();
      this.#patternCache.set(space, byScope);
    }
    let byId = byScope.get(scope);
    if (!byId) {
      byId = new Map();
      byScope.set(scope, byId);
    }
    return byId;
  }

  async refreshPattern(
    space: DID,
    id: string,
  ): Promise<PieceHandle<NameSchema>> {
    this.invalidatePattern(space, id);
    return await this.getPattern(space, id);
  }

  async getSlugCell(space: DID, slug: string): Promise<CellHandle<unknown>> {
    this.#check();
    return await this.#client.getCell(
      space,
      entityRefFromString(slugIdForSpace(space, slug)),
    );
  }

  /**
   * The name the piece answers to, where it has one. `scope` completes the id
   * into a document address and defaults to the space.
   */
  async getSlug(
    space: DID,
    id: string,
    scope?: CellScope,
  ): Promise<string | undefined> {
    this.#check();
    return await this.#client.getPieceSlug(id, space, scope);
  }

  /**
   * Where a slug reference lands. Not cached and not started — `getPattern`
   * on the id this answers with is what does both, and keying that cache on
   * the piece rather than on the reference is what lets a reference reaching
   * a new piece load it.
   *
   * A name nobody bound, and a member a collection does not hold, come back
   * as a {@link SlugReferenceRefusal} rather than as a throw: they answer the
   * question asked, and a caller that cannot tell them from a transport fault
   * reports "ask again" for a name that will never resolve.
   *
   * @throws When the piece sits outside the space asked about. Only the id
   *   and the scope travel on to `getPattern`, which takes the space from the
   *   view, so a reference reaching another space is refused here in those
   *   terms rather than reported as a piece that does not exist.
   * @throws When the resolution itself fails — a transport fault, a document
   *   that will not decode.
   */
  async resolveSlug(
    space: DID,
    slug: string,
    member?: string,
  ): Promise<SlugReferenceTarget | SlugReferenceRefusal> {
    this.#check();
    const landed = await this.#client.resolveSlug(slug, space, member);
    if (landed.refusal) return { refusal: landed.refusal };
    const reached = landed.piece.cell().ref();
    if (reached.space !== space) {
      throw new Error(
        `Slug reference "${slug}" reaches a piece in space ${reached.space}, ` +
          `and this view addresses ${space}.`,
      );
    }
    return {
      pieceId: landed.piece.id(),
      scope: reached.scope,
      pathAfter: landed.pathAfter,
    };
  }

  /**
   * Removes the piece from the space's registry, returning whether this call
   * removed it. `scope` completes the id into a document address and defaults
   * to the space.
   */
  async removePiece(
    space: DID,
    id: string,
    scope?: CellScope,
  ): Promise<boolean> {
    this.#check();
    return await this.#client.removePiece(id, space, scope);
  }

  async synced(space: DID): Promise<void> {
    this.#check();
    await this.#client.synced(space);
  }

  /** See RuntimeClient.registerSpaceHost — the site-table v0 hint API. */
  async registerSpaceHost(space: DID, host: string): Promise<boolean> {
    this.#check();
    return await this.#client.registerSpaceHost(space, host);
  }

  async idle(): Promise<void> {
    this.#check();
    await this.#client.idle();
  }

  async uploadBlob(options: {
    space: DID;
    contentType: string;
    body: Uint8Array | ArrayBufferLike;
    suffix?: string;
  }): Promise<{ id: string; url: string }> {
    this.#check();
    return await this.#client.uploadBlob(options);
  }

  /**
   * The runtime's lifetime signal. It aborts when this runtime is disposed.
   * Consumers observe it to stop polling/subscribing and to recognize that a
   * disposal-raced operation was cancelled rather than failed.
   */
  get signal(): AbortSignal {
    return this.#client.signal;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    // Flush + tear down telemetry first so buffered spans aren't dropped on
    // runtime replacement/logout. Guarded — telemetry must never break disposal.
    if (this.#telemetrySink) {
      try {
        await this.#telemetrySink.shutdown();
      } catch (e) {
        console.error("[RuntimeInternals] telemetry sink shutdown failed:", e);
      }
      this.#telemetrySink = undefined;
    }
    await this.#client.dispose();
  }

  async #waitForNavigationConvergence(space: DID): Promise<void> {
    this.#check();
    await this.#client.idle();
    await this.#client.synced(space);
  }

  #onConsole = (e: RuntimeClientEvents["console"][0]) => {
    if (this.#callbacks.onConsole) {
      this.#callbacks.onConsole(e);
      return;
    }
    const { metadata, method, args } = e;
    if (metadata?.pieceId) {
      console.log(`Piece(${metadata.pieceId}) [${method}]:`, ...args);
    } else {
      console.log(`Console [${method}]:`, ...args);
    }
  };

  #onNavigateRequest = (
    e: RuntimeClientEvents["navigaterequest"][0],
  ) => {
    void this.#handleNavigateRequest(e);
  };

  async #handleNavigateRequest(
    e: RuntimeClientEvents["navigaterequest"][0],
  ): Promise<void> {
    const { cell } = e;
    // `CellHandle.id()` is the full schemed URI; routing pieceIds are bare
    // (the `PieceHandle.id()` convention) — URLs and the pieceId protocol
    // fields expect the `of:`-stripped form.
    const pieceId = cell.id().replace(/^of:/, "");
    logger.log("navigate", `Navigating to piece: ${pieceId}`);

    try {
      await this.#waitForNavigationConvergence(cell.space());
    } catch (error) {
      // A disposal race (logout, worker replacement) abandons convergence
      // cleanly; a genuine failure is logged. Either way navigation is
      // abandoned, and the rejection never escapes as unhandled.
      if (!this.#disposed) {
        console.error(
          "[RuntimeInternals] Navigation convergence failed:",
          error,
        );
      }
      return;
    }

    // The target is an address: (space, piece). Mapping a space DID back
    // to a human-readable view (e.g. a spaceName URL) is the embedder's
    // view-state concern, handled in its navigate callback.
    (this.#callbacks.navigate ?? navigate)({
      spaceDid: cell.space(),
      pieceId,
    });
  }

  #onError = (event: RuntimeClientEvents["error"][0]) => {
    if (this.#callbacks.onError) {
      this.#callbacks.onError(event);
      return;
    }
    console.error("[RuntimeClient Error]", event);
  };

  #onTelemetry = (marker: RuntimeTelemetryMarkerResult) => {
    this.#telemetryMarkers.push(marker);
    this.dispatchEvent(new CustomEvent("telemetryupdate"));
    // Additionally translate the marker into OTel spans/metrics when a sink is
    // attached (browser telemetry enabled). Guarded so a bridge error never
    // disrupts the existing debug telemetry pipeline.
    if (this.#telemetrySink) {
      try {
        this.#telemetrySink.handleMarker(marker);
      } catch (e) {
        console.error(
          "[RuntimeInternals] telemetry sink handleMarker failed:",
          e,
        );
      }
    }
  };

  #check() {
    if (this.#disposed) {
      throw new Error("RuntimeInternals disposed.");
    }
  }

  static async create({
    identity,
    apiUrl,
    spaceHostMap,
    experimental,
    cfcEnforcementMode,
    cfcFlowLabels,
    cfcRenderCeiling,
    trustSnapshot,
    clientVersion,
    forwardWorkerConsole,
    patternCoverage,
    concurrentWatchRefresh,
    getBuildHash = fetchBuildHash,
    workerUrl,
    transport,
    attach = false,
    navigate,
    onConsole,
    onError,
    telemetry,
  }: RuntimeInternalsCreateOptions): Promise<RuntimeInternals> {
    if (attach && !transport) {
      throw new Error(
        "`attach` needs a `transport`: a worker this page spawns has no " +
          "runtime to attach to.",
      );
    }

    // One runtime per identity: the worker session is always the
    // identity's home session. Spaces — including derived named spaces —
    // are addressed per call; nothing is bound at creation.
    const session: Session = await createSession({
      identity,
      spaceDid: identity.did(),
    });

    // Log user identity for debugging
    identityLogger.log(
      "identity",
      `[Identity] User DID: ${identity.did()}`,
    );

    const clientOptions = createRuntimeClientOptions({
      session,
      apiUrl,
      spaceHostMap,
      experimental,
      cfcEnforcementMode,
      cfcFlowLabels,
      cfcRenderCeiling,
      trustSnapshot,
      forwardWorkerConsole,
      patternCoverage,
      concurrentWatchRefresh,
    });

    const connection = transport ??
      await WebWorkerRuntimeTransport.connect({
        workerUrl: await resolveWorkerUrl({
          workerUrl,
          clientVersion,
          getBuildHash,
        }),
      });
    const client = attach
      ? await RuntimeClient.attach(
        connection,
        attachOptionsFrom(clientOptions),
      )
      : await RuntimeClient.initialize(connection, clientOptions);

    // Expose a usable RuntimeInternals immediately. Callers that need
    // storage/piece-manager convergence should await `rt.synced(space)`
    // explicitly.
    return new RuntimeInternals(
      client,
      { navigate, onConsole, onError },
      telemetry,
    );
  }
}

/**
 * Resolve a named space to its DID (the derived space key) without
 * touching any runtime. "Current space" is embedder view state; this is
 * the one piece of derivation embedders need to translate a
 * human-readable space name into an address.
 */
export async function resolveSpaceDid(
  identity: Identity,
  spaceName: string,
): Promise<DID> {
  const session = await createSession({ identity, spaceName });
  return session.space;
}
