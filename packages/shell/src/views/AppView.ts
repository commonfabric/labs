import { type DID, KeyStore } from "@commonfabric/identity";
import {
  isAppViewEqual,
  isEmbeddedView,
  isViewingDefaultPatternView,
  replaceNavigation,
  spaceViewRef,
  updatePageTitle,
  urlToAppView,
} from "@commonfabric/navigation";
import { type NameSchema, stringSchema } from "@commonfabric/runner/schemas";
import { parseCellReference } from "@commonfabric/runner/shared";
import { slugIdForSpace, validateSlug } from "@commonfabric/runner/slugs";
import {
  type Cancel,
  type ErrorNotification,
  type FavoritePieceAddress,
  NAME,
  PieceHandle,
} from "@commonfabric/runtime-client";
import { Task, TaskStatus } from "@lit/task";
import { css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";

import { CellEventTarget, CellUpdateEvent } from "../lib/cell-event-target.ts";
import { DebuggerController } from "../lib/debugger-controller.ts";
import { GlobalShortcutsController } from "../lib/global-shortcuts-controller.ts";
import { prepareNamedSpace } from "../lib/named-space.ts";
import {
  RuntimeInternals,
  type SlugReferenceRefusal,
  type SlugReferenceTarget,
} from "../lib/runtime.ts";
import { BaseView, createDefaultAppState } from "./BaseView.ts";
import type { LoadError } from "./BodyView.ts";

/**
 * Which fields of a resolution the view's state depends on.
 *
 * Every field of {@link SlugReferenceTarget} is classified here, and the
 * `satisfies` is what makes that exhaustive: a field added to that type
 * without a line here does not compile, so the omission that this key's
 * earlier versions kept making cannot be written. Classifying one `false` is
 * a decision a reviewer sees rather than an absence nobody notices.
 *
 * - `pieceId` — which piece is rendered.
 * - `scope` — which document that piece is; one id in two scopes is two.
 * - `pathAfter` — the segments the walk left unspent, which decide whether
 *   the reference's member named anything.
 * - `refusal` — always absent on this arm, where it marks the landing rather
 *   than carrying anything. Including a constant would say nothing.
 */
const SEMANTIC_RESOLUTION_FIELDS = {
  pieceId: true,
  scope: true,
  pathAfter: true,
  refusal: false,
} as const satisfies Record<keyof Required<SlugReferenceTarget>, boolean>;

/**
 * Which fields of a refusal the view's state depends on, classified and
 * closed the same way.
 *
 * - `code` — which refusal it is. A closed set, and the outcomes read
 *   differently: an unbound name and a collection missing a member are
 *   different things to be told, so collapsing them into one value leaves a
 *   reader on the wrong message about the wrong thing.
 * - `message` — its wording, which is derived from the code and the
 *   reference. The reference is fixed for one watch, so the message adds
 *   nothing the code does not already separate, and keying on prose is what
 *   made a message that varied read as the reference having moved.
 */
const SEMANTIC_REFUSAL_FIELDS = {
  code: true,
  message: false,
} as const satisfies Record<
  keyof SlugReferenceRefusal["refusal"],
  boolean
>;

/**
 * How one resolution is compared against the last: the fields
 * {@link SEMANTIC_RESOLUTION_FIELDS} marks as decisive, in a fixed order.
 *
 * A key naming a subset of what the view derives calls two different answers
 * the same, and the state built from the older one stands under the newer.
 * Reading every field off the answer instead would cure that and buy a second
 * fault: a field that varies per resolution and means nothing would reload
 * the view on every poll. Projecting an explicitly classified set has neither
 * — a new field cannot be silently omitted, because it does not compile, and
 * cannot be silently included, because someone has to write which it is.
 */
function slugResolutionKey(
  landed: SlugReferenceTarget | SlugReferenceRefusal,
): string {
  return landed.refusal
    ? project("refusal", landed.refusal, SEMANTIC_REFUSAL_FIELDS)
    : project("target", landed, SEMANTIC_RESOLUTION_FIELDS);
}

/** The decisive fields of `answer`, in a fixed order, under `arm`. */
function project<T extends object>(
  arm: string,
  answer: T,
  semantic: Record<keyof T, boolean>,
): string {
  const fields = (Object.keys(semantic) as (keyof T)[]).sort();
  return JSON.stringify([
    arm,
    ...fields
      .filter((field) => semantic[field])
      .map((field) => [field, answer[field]]),
  ]);
}

/**
 * A reference a page address carries: the slug at its head, the member it
 * selects where it names one, and the space both are read in.
 *
 * The runtime is not part of one. Which piece a reference names is a question
 * about the space, and a replacement runtime asks it of that same space — so
 * a hand-off leaves what the address names untouched, and the piece already
 * reached stays on screen across the hand-off.
 */
interface SlugReference {
  /** The space the reference is read in. */
  readonly space: DID;

  /** The name at the head of the reference. */
  readonly slug: string;

  /** The member the reference selects, where it names one. */
  readonly member: string | undefined;
}

/** Whether `a` and `b` are the same reference. */
function sameSlugReference(a: SlugReference, b: SlugReference): boolean {
  return a.space === b.space && a.slug === b.slug && a.member === b.member;
}

/**
 * What the view makes of where `reference` landed: the landing itself, or a
 * refusal naming the member where the landing left that member unspent.
 *
 * A slug naming a piece at its root spends no member, and the resolution hands
 * the member back. The member then names nothing in that piece, as a member a
 * collection does not hold names nothing in the collection, so it is refused
 * the same way. The selection and the watch both read a resolution through
 * here, so the answer one records as shown is the answer the other compares.
 */
function answerFor(
  reference: SlugReference,
  landed: SlugReferenceTarget | SlugReferenceRefusal,
): SlugReferenceTarget | SlugReferenceRefusal {
  if (landed.refusal || landed.pathAfter.length === 0) return landed;
  return {
    refusal: {
      code: "not-collection",
      message:
        `no member ${landed.pathAfter.join("/")} in ${reference.slug}, ` +
        "which names a piece rather than a collection",
    },
  };
}

/**
 * One live watch on a slug reference: the reference, the runtime it is read
 * through, and everything whose lifetime is this watch's — the subscription
 * it opens, the poll it schedules, and the pair of flags that keep its
 * re-resolutions to one at a time.
 *
 * The reference and the runtime are every input the watch is built from, so
 * comparing them is what decides whether a running watch already covers what
 * the view now addresses.
 *
 * A callback arriving after a view change checks itself by identity against
 * the watch the view is running, so replacing the watch invalidates every
 * callback still holding the old one. What such a callback writes it writes
 * on the watch it holds, which is what keeps one watch's state out of every
 * other watch's reach.
 */
class SlugWatch {
  /** The runtime the reference is read through. */
  readonly rt: RuntimeInternals;

  /** The reference this watch follows. */
  readonly reference: SlugReference;

  /** Cancels the subscription on the slug document, once it is open. */
  cancel: Cancel | undefined = undefined;

  /** The re-resolution poll, once it is scheduled. */
  pollInterval: ReturnType<typeof setInterval> | undefined = undefined;

  /** Whether a re-resolution is running; a watch runs one at a time. */
  refreshRunning = false;

  /** Whether something asked to re-resolve while one was running. */
  refreshRequested = false;

  /** Constructs a watch on `reference`, read through `rt`. */
  constructor(rt: RuntimeInternals, reference: SlugReference) {
    this.rt = rt;
    this.reference = reference;
  }

  /** Stops this watch, cancelling its subscription and clearing its poll. */
  stop(): void {
    this.cancel?.();
    this.cancel = undefined;
    if (this.pollInterval !== undefined) {
      globalThis.clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
  }
}

/** What one run of the selection came to show, and for which reference. */
interface ShownResolution {
  /** The reference the run that recorded this was resolving. */
  readonly reference: SlugReference;

  /** What that run reached, or `undefined` where it reached nothing. */
  readonly answer: SlugReferenceTarget | SlugReferenceRefusal | undefined;
}

/**
 * The origin a reference is opened under when it is read as a page. Only the
 * path is read, so which origin this is decides nothing.
 */
const PAGE_ORIGIN = "http://page.invalid";

/**
 * Whether both readers of `reference` read it as member `member` of the
 * collection `slug` in `space`: the cell reference grammar, which `cf` reads
 * it through, and `urlToAppView`, which opens it as a page under this shell's
 * origin.
 *
 * Each reader rewrites spellings the other keeps. The grammar refuses a space
 * name holding a character it reserves. A page URL percent-encodes some
 * characters and resolves dot segments, and the page reader takes an escaped
 * `@` at the head of the space for the space's mark. A name rewritten on the
 * way in comes back out naming another space.
 */
function readsBackAs(
  reference: string,
  space: string,
  slug: string,
  member: string,
): boolean {
  // Each reader is asked rather than restated, so neither has a copy of its
  // rules here to fall out of step with.
  try {
    const cited = parseCellReference(reference);
    const citesMember = cited.space === space && cited.id === slug &&
      cited.member === undefined && cited.scope === undefined &&
      cited.pin === undefined && cited.path.length === 1 &&
      cited.path[0] === member;
    if (!citesMember) return false;
  } catch {
    return false;
  }
  const named = spaceViewRef(space, undefined);
  if (!named) return false;
  return isAppViewEqual(
    urlToAppView(new URL(`${PAGE_ORIGIN}${reference}`)),
    { ...named, pieceSlug: slug, pieceMember: member },
  );
}

export class XAppView extends BaseView {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
    }

    .shell-container {
      display: flex;
      flex-direction: column;
      height: 100%;
      background-color: var(--shell-surface);
    }

    .content-area {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background-color: var(--shell-surface);
      min-height: 0; /* Important for flex children */
      isolation: isolate; /* Contain pattern z-indexes */
    }
  `;

  @property({ attribute: false })
  accessor app = createDefaultAppState();

  @property({ attribute: false })
  accessor rt: RuntimeInternals | undefined = undefined;

  /** The space the current view addresses — view state from RootView. */
  @property({ attribute: false })
  accessor space: DID | undefined = undefined;

  @property({ attribute: false })
  accessor keyStore: KeyStore | undefined = undefined;

  @property({ attribute: false })
  accessor spaceLoadError: LoadError | undefined = undefined;

  @property({ attribute: false })
  accessor runtimeLoadErrors: readonly ErrorNotification[] = [];

  @property({ attribute: false })
  accessor preserveRuntimeErrorsForNextViewChange: (() => void) | undefined =
    undefined;

  @state()
  accessor pieceTitle: string | undefined = undefined;

  @property({ attribute: false })
  private accessor titleSubscription: CellEventTarget<string> | undefined =
    undefined;

  @state()
  private accessor _slugRevision = 0;

  /** The watch on the reference the view addresses, while it has one. */
  #slugWatch: SlugWatch | undefined = undefined;

  /**
   * The answer the view is SHOWING and the reference it answers: the
   * resolution whose piece is on screen, or whose refusal is the error on
   * screen, under the address that reached it. Undefined before the first run
   * of the selection reports; the answer within it is undefined where a run
   * reached nothing to show, a load that could not finish among them.
   *
   * One fact, not several about one thing. What was resolved, whether it was
   * applied, which piece it reached, and which answer is newest are all read
   * off this — so there is no second slot for one of them to disagree with,
   * and a re-resolution asks one question: is this what the view is showing?
   * A no is the whole of the work to do, whether the reference moved, a
   * member arrived, a refusal changed, or a load failed and left the view on
   * something else.
   *
   * Written only by {@link XAppView.#markShown}, and only from the answer the
   * writer itself resolved — never from whatever is current when it finishes,
   * which is how a slow load came to claim a newer answer's identity. Its
   * lifetime is the view's display rather than any watch's, so a watch
   * stopping leaves it standing and the selection is what moves it on.
   *
   * That lifetime is what the reference is here for. Only the selection moves
   * this on, and it reports only for an address that names a reference — so
   * between an address changing and the run for the new one reporting, this
   * carries the OLD address's answer while nothing is on screen. Its two
   * readers ask different questions of it there, and the reference is what
   * separates them. {@link XAppView.#resolveAgainst} asks whether the answer
   * just resolved is the one the view is showing, which the reference does
   * not decide: a piece already on screen wants no reload however the view
   * came to be showing it. {@link XAppView.#shownPieceId} asks what the
   * address the view now carries has come to show, and answers for no other.
   */
  #shownResolution: ShownResolution | undefined = undefined;

  #selectedPatternTargetId: string | undefined = undefined;

  /**
   * Whether the member the view carries named a member of a collection, as
   * the last resolution answered. A citation is offered on this rather than
   * on the view alone, so a segment that named nothing is never cited as
   * though it named the piece on screen.
   */
  #namedAMember = false;

  /**
   * The revision the slug watch bumps to make the selection run again, which
   * a test reads to tell a reload from a resolution that changed nothing.
   */
  get accessForTestingOnly(): { readonly slugRevision: number } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      get slugRevision() {
        return outerThis._slugRevision;
      },
    };
  }

  #debuggerController = new DebuggerController(this);
  #keyboard = new GlobalShortcutsController(this);

  _spaceRootPattern = new Task(this, {
    task: async (
      [app, rt, space],
    ): Promise<
      | PieceHandle<NameSchema>
      | undefined
    > => {
      if (!rt || !space) return;
      try {
        await prepareNamedSpace(app, rt, space);
        // The space home renders the root, so there it has to run. A
        // piece-focused view reads NOTHING from it — so it is not fetched
        // at all, and none of what the root's result reaches is demanded.
        // On a space whose root reaches a large piece, that demand is the
        // dominant cost of opening any piece in the space.
        if (!isViewingDefaultPatternView(app.view)) return;
        return await rt.getSpaceRootPattern(space);
      } catch (err) {
        if (!rt.signal.aborted) {
          console.error("[AppView] Failed to load space root pattern:", err);
        }
        throw err;
      }
    },
    args: () => [this.app, this.rt, this.space],
  });

  /**
   * Whether the one-shot `?path=` deep link has been delivered; set after the
   * first send so slug re-resolutions and task reruns never re-fire it.
   */
  #openPathDelivered = false;

  /** Deliver a `?path=` deep link into the loaded piece, once.
   *
   * Opt-in by contract: the piece must export an `openPath` stream on its
   * result (e.g. Mobile Loom opens the given cabinet path in its page
   * viewer). Pieces without the stream are untouched — the field simply
   * goes undelivered. Fire-and-forget; a failed send must never affect
   * pattern loading. */
  #maybeDeliverOpenPath(pattern: PieceHandle<NameSchema>): void {
    if (this.#openPathDelivered) return;
    const view = this.app?.view;
    if (!view || !("openPath" in view) || !view.openPath) return;
    const data = pattern.cell().get() as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object" || !("openPath" in data)) return;
    this.#openPathDelivered = true;
    (pattern.cell() as unknown as {
      key(k: string): { send(v: unknown): Promise<void> };
    })
      .key("openPath")
      .send({ path: view.openPath });
  }

  _selectedPattern = new Task(this, {
    task: async (
      [app, rt, space],
      { signal },
    ): Promise<
      | PieceHandle<NameSchema>
      | undefined
    > => {
      if (!rt || !space) return;
      this.#selectedPatternTargetId = undefined;
      // Cleared before the resolution rather than after it: what the last
      // reference turned out to be says nothing about this one, and a
      // citation offered in between would be the previous answer standing
      // under the current address.
      this.#namedAMember = false;
      try {
        await prepareNamedSpace(app, rt, space);
        if ("pieceSlug" in app.view && app.view.pieceSlug) {
          // The reference is resolved before the piece is asked for, because
          // which piece a slug names is a question about the space and not
          // about the piece: a slug into a collection names the member the
          // path after it selects, and one into a piece at any other depth
          // names the piece that holds it.
          const member = "pieceMember" in app.view
            ? app.view.pieceMember
            : undefined;
          // Segments past a member are refused from the address alone. Only
          // the member is read out of an address, so what follows it names
          // nothing whatever the slug turns out to name. No reference is
          // watched for such an address, so there is no answer to record.
          const extraPath = "pieceExtraPath" in app.view
            ? app.view.pieceExtraPath
            : undefined;
          if (extraPath !== undefined) {
            throw new Error(
              `no piece at ${extraPath} after member ${member} in ` +
                `${app.view.pieceSlug}, since nothing past a member resolves`,
            );
          }
          // This run's own address, held for as long as the run takes: what
          // it reports is what THIS reference reached, and the address may
          // have moved on by the time it reports.
          const reference: SlugReference = {
            space,
            slug: app.view.pieceSlug,
            member,
          };
          let landed: SlugReferenceTarget | SlugReferenceRefusal;
          try {
            landed = answerFor(
              reference,
              await rt.resolveSlug(space, app.view.pieceSlug, member),
            );
          } catch (error) {
            // Around the resolution alone, for the reason the load below
            // carries its own wrapper: the outer catch also takes the
            // refusal's throw, and recording nothing there would undo the
            // mark that refusal just made. A fault here is the one throw in
            // the run that reaches no answer at all, and without the mark the
            // piece the view was already showing stands as this reference's
            // answer — so a later resolution reaching that same piece is no
            // news, and the view never leaves the error it is on.
            this.#markShown(reference, undefined, signal);
            throw error;
          }
          if (signal.aborted) return;
          if (landed.refusal) {
            // A refusal is the reference's answer, and the load-error surface
            // is where a reader is told it, in the refusal's own words. That
            // surface IS the view showing this answer, so it is shown before
            // it is thrown.
            this.#markShown(reference, landed, signal);
            throw new Error(landed.refusal.message);
          }
          const { pieceId, scope } = landed;
          // `answerFor()` refuses a landing that leaves the member unspent, so
          // a member carried this far named one.
          this.#namedAMember = member !== undefined;
          this.#selectedPatternTargetId = pieceId;
          let pattern: PieceHandle<NameSchema>;
          try {
            pattern = await rt.getPattern(space, pieceId, { scope });
          } catch (error) {
            // Around the load alone. The run's outer catch also takes the
            // refusal's own throw, and recording nothing there would undo
            // the mark a refusal just made — leaving every poll to re-resolve
            // an answer the view is already showing.
            this.#markShown(reference, undefined, signal);
            throw error;
          }
          // `landed` and not whatever is current: this run finished THIS
          // answer, and saying so with another's identity is how a slow load
          // came to claim a newer answer was on screen.
          this.#markShown(reference, landed, signal);
          if (!signal.aborted) this.#maybeDeliverOpenPath(pattern);
          return pattern;
        }
        if ("pieceId" in app.view && app.view.pieceId) {
          const scope = app.view.pieceScope ?? "space";
          const target = await rt.getPattern(space, app.view.pieceId, {
            start: false,
            scope,
          });
          if (signal.aborted) return;
          this.#selectedPatternTargetId = target.id();
          const pattern = await rt.getPattern(space, app.view.pieceId, {
            scope,
          });
          const slug = scope === "space" && !app.view.piecePath?.length
            ? await rt.getSlug(space, app.view.pieceId)
            : undefined;
          if (!signal.aborted && slug) {
            this.#replacePieceUrlWithSlug(app.view, slug);
          }
          if (!signal.aborted) this.#maybeDeliverOpenPath(pattern);
          return pattern;
        }
      } catch (error) {
        if (!signal.aborted && !rt.signal.aborted) {
          console.error("[AppView] Failed to load selected piece:", error);
        }
        throw error;
      }
    },
    // _slugRevision is a rerun trigger only — keep it after the
    // destructured args.
    args: () => [this.app, this.rt, this.space, this._slugRevision],
  });

  /**
   * Task deriving the active pattern from completed task values, so child
   * views never receive an in-flight or stale selection.
   */
  _patterns = new Task(this, {
    task: function (
      [
        app,
        spaceRootPatternValue,
        spaceRootPatternStatus,
        selectedPatternValue,
        selectedPatternStatus,
      ],
    ): {
      activePattern: PieceHandle<NameSchema> | undefined;
    } {
      const spaceRootPattern = spaceRootPatternStatus === TaskStatus.COMPLETE
        ? spaceRootPatternValue
        : undefined;
      // The "active" pattern is the main pattern to be rendered.
      // This may be the same as the space root pattern, unless we're
      // in a view that specifies a different pattern to use.
      const useSpaceRootAsActive =
        !("pieceId" in app.view && app.view.pieceId) &&
        !("pieceSlug" in app.view && app.view.pieceSlug);
      const activePattern = useSpaceRootAsActive
        ? spaceRootPattern
        : selectedPatternStatus === TaskStatus.COMPLETE
        ? selectedPatternValue
        : undefined;
      return { activePattern };
    },
    args: () => [
      this.app,
      this._spaceRootPattern.value,
      this._spaceRootPattern.status,
      this._selectedPattern.value,
      this._selectedPattern.status,
    ],
  });

  #syncSlugSubscription() {
    const rt = this.rt;
    const reference = this.#addressedReference;
    // Every input the watch is built from is compared, the runtime among
    // them: a reference reads the same and reaches a different answer under a
    // replacement runtime, and two members of one collection are two
    // references reaching two pieces.
    const running = this.#slugWatch;
    if (
      running && running.rt === rt && reference &&
      sameSlugReference(running.reference, reference)
    ) {
      return;
    }
    this.#stopSlugWatch();
    if (!rt || !reference) return;

    const watch = new SlugWatch(rt, reference);
    this.#slugWatch = watch;
    rt.getSlugCell(reference.space, reference.slug).then(async (cell) => {
      if (!this.#isCurrentSlugWatch(watch)) return;

      // Asks like every later resolution, and needs no flag saying it is
      // the first: the selection marks what the view came to SHOW, so an
      // answer matching that returns early however it arrived. One that
      // differs — because the member landed while this subscription was
      // still opening — reloads a view that would otherwise sit on the
      // failure forever.
      await this.#refreshSlugTarget(watch);
      if (!this.#isCurrentSlugWatch(watch)) return;

      // Re-resolving is what notices anything at all, and the measurement
      // is in `packages/runtime-client/test/backends/slug-resolve.test.ts`:
      // the subscription below wakes for no write this view cares about, so
      // every case the shell has to follow arrives on this interval. Two of
      // those cases are separately real, and neither is closed by the other
      // — a slug repointed at a different piece, and a member whose target
      // gains the pattern identity that MAKES it a piece, which no watch on
      // a value sees because the read set follows values.
      //
      // So the interval is unconditional. Bounding it to the states the
      // subscription does not cover is bounding it to all of them.
      //
      // TODO(slug-watch-wake): Bound this to the refused states once a watch
      // on a slug wakes when the slug is repointed and when a member's target
      // becomes a piece.
      watch.pollInterval = globalThis.setInterval(() => {
        void this.#refreshSlugTarget(watch);
      }, 1000);

      let sawInitialCallback = false;
      watch.cancel = cell.subscribe(() => {
        if (!sawInitialCallback) {
          sawInitialCallback = true;
          return;
        }
        void this.#refreshSlugTarget(watch);
      });
    }).catch((error) => {
      if (!this.#isCurrentSlugWatch(watch)) return;
      if (rt.signal.aborted) {
        // Drop the watch so a replacement runtime for the same reference
        // subscribes instead of matching the stale one.
        this.#stopSlugWatch();
        return;
      }
      console.error("[AppView] Failed to watch slug cell:", error);
    });
  }

  /**
   * Stop the watch the view is running, and leave it with none.
   *
   * A watch owns what is watch-scoped; the view owns what is displayed. The
   * piece the stopped watch resolved is on screen until something replaces
   * it, so {@link XAppView.#shownResolution} goes on naming it, and the
   * selection is what moves that on.
   */
  #stopSlugWatch() {
    const watch = this.#slugWatch;
    this.#slugWatch = undefined;
    watch?.stop();
  }

  /**
   * The reference the view's address names, where it names one.
   *
   * The address is the one source of a reference: a watch is built for what
   * it names, and a recorded answer is held against what it names. Both read
   * it through here, so the two cannot disagree about what the address says.
   *
   * An address carrying segments past its member names none. The selection
   * refuses it from the address alone, so there is nothing to watch and no
   * answer to hold against it.
   */
  get #addressedReference(): SlugReference | undefined {
    const space = this.space;
    const view = this.app.view;
    if (!space || !("pieceSlug" in view) || !view.pieceSlug) return undefined;
    if ("pieceExtraPath" in view && view.pieceExtraPath) return undefined;
    return {
      space,
      slug: view.pieceSlug,
      member: "pieceMember" in view ? view.pieceMember : undefined,
    };
  }

  /**
   * Record that the view has come to show `answer` for `reference`, or
   * nothing for it where the run reached nothing to show.
   *
   * The only writer of {@link XAppView.#shownResolution}, and it takes the
   * signal of the run that resolved `answer` so a run the view has moved on
   * from cannot report what it finished as what is on screen. `reference` is
   * that same run's, for the same reason.
   *
   * Every outcome of a run is reported through here — the piece it loaded,
   * the refusal it was given, and the load it could not finish. That is what
   * lets one comparison stand for all of them: an outcome that wrote nothing
   * would leave the answer before it standing as though it were still what
   * the view had settled on.
   */
  #markShown(
    reference: SlugReference,
    answer: SlugReferenceTarget | SlugReferenceRefusal | undefined,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return;
    this.#shownResolution = { reference, answer };
  }

  /**
   * The piece the view is showing, when the reference its address names
   * reached one.
   *
   * A record made under another address is the answer to a question this
   * address did not ask, so it names no piece here — which leaves the window
   * before the run for a new address reports with no piece to name at all.
   */
  get #shownPieceId(): string | undefined {
    const shown = this.#shownResolution;
    const addressed = this.#addressedReference;
    if (!shown || !addressed) return undefined;
    if (!sameSlugReference(shown.reference, addressed)) return undefined;
    const answer = shown.answer;
    return answer && !answer.refusal ? answer.pieceId : undefined;
  }

  /** Whether `watch` is still the watch this view is running. */
  #isCurrentSlugWatch(watch: SlugWatch): boolean {
    return this.#slugWatch === watch;
  }

  /**
   * Re-resolve the reference `watch` follows, and ask the selection to run
   * again when the answer is not what the view is showing.
   *
   * One at a time. A resolution slower than the poll's interval would
   * otherwise have a second issued behind it, and two answers in flight is
   * the whole of the ordering problem — which is newer, and may an older one
   * still be applied. Running one and coalescing whatever asked meanwhile
   * removes the question instead of guarding it: there is never a second
   * answer to compare against, and a wake that arrives mid-flight still gets
   * its resolution, immediately after.
   *
   * The pair of flags that serializes this lives on `watch`, so a run
   * finishing after the view has moved on releases the turn it took and reads
   * the request coalesced behind it, both of them its own.
   */
  async #refreshSlugTarget(watch: SlugWatch): Promise<void> {
    if (!this.#isCurrentSlugWatch(watch)) return;
    if (watch.refreshRunning) {
      watch.refreshRequested = true;
      return;
    }
    watch.refreshRunning = true;
    try {
      await this.#resolveAgainst(watch);
    } finally {
      watch.refreshRunning = false;
    }
    if (!watch.refreshRequested) return;
    watch.refreshRequested = false;
    await this.#refreshSlugTarget(watch);
  }

  /** One re-resolution: ask, and reload the view when the answer differs. */
  async #resolveAgainst(watch: SlugWatch): Promise<void> {
    let landed: SlugReferenceTarget | SlugReferenceRefusal;
    try {
      landed = answerFor(
        watch.reference,
        await watch.rt.resolveSlug(
          watch.reference.space,
          watch.reference.slug,
          watch.reference.member,
        ),
      );
    } catch (error) {
      if (watch.rt.signal.aborted) {
        // The runtime this subscription polls was disposed (logout,
        // teardown, worker replacement) — stop polling it; a new runtime
        // re-subscribes via #syncSlugSubscription.
        if (this.#isCurrentSlugWatch(watch)) this.#stopSlugWatch();
        return;
      }
      // Not a refusal — those arrive as an answer — but a fault in asking: a
      // transport that dropped, a document that would not decode. It says
      // nothing about where the reference points, so what the view shows
      // stands and the load path is what reports the fault to a reader.
      console.error("[AppView] Failed to re-resolve a slug reference:", error);
      return;
    }
    if (!this.#isCurrentSlugWatch(watch)) return;
    // The one question, asked of the answer the selection recorded and not of
    // the reference beside it: a piece already on screen wants no reload
    // however the view came to be showing it. A difference covers every
    // reason the view could be behind — the reference moved, a member
    // arrived, a refusal changed, a load failed and left the view on an error
    // — because each of them is the same fact: what the view settled on is
    // not this. That holds because every outcome of a run is recorded, a load
    // that could not finish among them; an outcome that recorded nothing
    // would leave the answer before it reading as settled, and the retry it
    // needs would never be asked for.
    const shown = this.#shownResolution?.answer;
    if (shown && slugResolutionKey(shown) === slugResolutionKey(landed)) return;
    this.#handleSlugCellUpdate(watch);
  }

  #handleSlugCellUpdate(watch: SlugWatch) {
    const addressed = this.#addressedReference;
    if (
      this.rt !== watch.rt || !addressed ||
      !sameSlugReference(addressed, watch.reference)
    ) {
      return;
    }

    this._slugRevision++;
  }

  #setTitleSubscription(activePiece?: PieceHandle<NameSchema>) {
    if (!activePiece) {
      if (this.titleSubscription) {
        this.titleSubscription.removeEventListener(
          "update",
          this.#onPieceTitleChange,
        );
      }
      this.titleSubscription = undefined;
      this.pieceTitle = "Untitled";
    } else {
      const cell = activePiece.cell().key(NAME).asSchema<string>(stringSchema);
      if (
        this.titleSubscription && cell.equals(this.titleSubscription.cell())
      ) {
        return;
      }
      this.titleSubscription = new CellEventTarget(cell);
      try {
        this.pieceTitle = cell.get();
      } catch {
        // Cell not synced yet
        this.pieceTitle = undefined;
      }
    }
  }

  #onPieceTitleChange = (e: Event) => {
    const event = e as CellUpdateEvent<string | undefined>;
    this.pieceTitle = event.detail ?? "";
  };

  #replacePieceUrlWithSlug(view: typeof this.app.view, slug: string) {
    try {
      validateSlug(slug);
    } catch {
      return;
    }
    if (!("pieceId" in view)) return;
    this.preserveRuntimeErrorsForNextViewChange?.();
    const { pieceId: _replaced, pieceMember: _dropped, ...rest } = view;
    this.#replaceView({ ...rest, pieceSlug: slug });
  }

  /**
   * Ask for `view` in place of the one showing, which is how an address the
   * shell settles differently from the one asked for is written back.
   *
   * Only what the caller changed is different: what a view is being read as
   * — embedded, or carrying a `?path=` deep link — outlives a correction to
   * what it names, and rebuilding a view from the fields a caller remembered
   * is how the rest of it goes missing.
   */
  #replaceView(view: typeof this.app.view) {
    replaceNavigation(view);
  }

  #isRecreatingSpaceRootPattern = false;

  #handleRecreateSpaceRootPattern = async (e: Event) => {
    const done = (e as CustomEvent).detail?.done as (() => void) | undefined;
    if (!this.rt || !this.space) {
      done?.();
      return;
    }
    if (this.#isRecreatingSpaceRootPattern) return;
    this.#isRecreatingSpaceRootPattern = true;
    try {
      await this.rt.recreateSpaceRootPattern(this.space);
      this._spaceRootPattern.run();
    } catch (err) {
      console.error("[AppView] Failed to recreate pattern:", err);
    } finally {
      this.#isRecreatingSpaceRootPattern = false;
      done?.();
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener(
      "recreate-space-root-pattern",
      this.#handleRecreateSpaceRootPattern,
    );
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener(
      "recreate-space-root-pattern",
      this.#handleRecreateSpaceRootPattern,
    );
    this.#stopSlugWatch();
  }

  override updated(changedProperties: Map<string, unknown>) {
    super.updated(changedProperties);

    if (changedProperties.has("pieceTitle")) {
      updatePageTitle(this.pieceTitle ?? "");
    }

    if (changedProperties.has("titleSubscription")) {
      const current = this.titleSubscription;
      const prev = changedProperties.get(
        "titleSubscription",
      ) as CellEventTarget<string | undefined> | undefined;
      if (prev) {
        prev.removeEventListener("update", this.#onPieceTitleChange);
      }
      if (current) {
        current.addEventListener("update", this.#onPieceTitleChange);
      }
    }

    // Update debugger controller with runtime
    if (changedProperties.has("rt") && this.rt) {
      this.#debuggerController.setRuntime(this.rt);
    }

    // Update debugger visibility from app state
    if (changedProperties.has("app")) {
      this.#debuggerController.setVisibility(
        this.app.config.showDebuggerView ?? false,
      );
    }

    if (
      changedProperties.has("app") || changedProperties.has("rt") ||
      changedProperties.has("space")
    ) {
      this.#syncSlugSubscription();
    }
  }

  /**
   * Returns the active pattern's id. Always defers to the loaded active
   * pattern for the id, but until that loads, uses an id in the view if
   * available.
   */
  #getActivePatternId(): string | undefined {
    const activePattern = this._patterns.value?.activePattern;
    if (activePattern) return activePattern.id();
    if ("pieceId" in this.app.view && this.app.view.pieceId) {
      return this.app.view.pieceId;
    }
    if ("pieceSlug" in this.app.view && this.app.view.pieceSlug) {
      return this.space
        ? slugIdForSpace(this.space, this.app.view.pieceSlug)
        : this.app.view.pieceSlug;
    }
  }

  /**
   * The whole address of the piece on screen — its space, its id there, and
   * the scope that id resolves in — taken from the loaded pattern's own cell,
   * which is the thing that was reached and so carries all three.
   *
   * Undefined until that pattern loads. The two placeholders
   * `#getActivePatternId()` falls back to carry an id and no scope, and an id
   * under a guessed scope addresses whichever document the guess lands on.
   */
  #getActivePieceAddress(): FavoritePieceAddress | undefined {
    const activePattern = this._patterns.value?.activePattern;
    if (!activePattern) return;
    const ref = activePattern.cell().ref();
    return { space: ref.space, pieceId: activePattern.id(), scope: ref.scope };
  }

  /**
   * How the piece this view addresses is cited from anywhere:
   * `//<space>/<collection>/<member>`, the cell reference grammar's fully
   * qualified form, which depends on no binding of the reader's. `cf` reads
   * it, and so does this shell's `urlToAppView`, which opens it as the page
   * `/<space>/<collection>/<member>`. A pattern's `cellFromUrl` does not: it
   * wants an entity id where the collection's name sits. Only a member of a
   * named collection has one — a piece reached by identity carries its own, a
   * collection's name with no member after it names no piece at all, and a
   * segment the walk did not spend named nothing to cite.
   *
   * The space is written as the view names it: a space name derives its DID
   * for everyone, so a name travels as far as the DID does and reads better
   * where it lands. Where either reader would take the reference for another
   * address, as {@link readsBackAs} decides, the space is written as the DID
   * the view's space resolved to instead.
   *
   * A member is written as the address the page was opened at carries it, and
   * a member the two readers read differently is cited by nothing. The
   * readers differ on a member name carrying a JSON Pointer escape — `a~1b`
   * reaches the grammar as `a/b` — and on one a URL path rewrites, and
   * neither escaping settles it: the token that reaches the grammar as `a~1b`
   * reaches the page as `a~01b`. Such a name is outside the grammar a
   * collection holds its members to, and the alternative for one is an
   * address that names a different member of the same collection.
   */
  #getPieceReference(): string | undefined {
    if (!this.#namedAMember) return;
    const view = this.app.view;
    if (!("pieceSlug" in view) || !view.pieceSlug) return;
    const member = "pieceMember" in view ? view.pieceMember : undefined;
    if (!member) return;
    const named = "spaceName" in view
      ? view.spaceName
      : "spaceDid" in view
      ? view.spaceDid
      : undefined;
    for (const space of [named, this.space]) {
      if (!space) continue;
      const reference = `//${space}/${view.pieceSlug}/${member}`;
      if (readsBackAs(reference, space, view.pieceSlug, member)) {
        return reference;
      }
    }
    return undefined;
  }

  #getRuntimeLoadError(): LoadError | undefined {
    const event = this.runtimeLoadErrors.findLast((candidate) =>
      this.#runtimeErrorMatchesView(candidate)
    );
    if (!event) return;

    return {
      kind: event.pieceId && !isViewingDefaultPatternView(this.app.view)
        ? "piece"
        : "space",
      error: event,
    };
  }

  #runtimeErrorMatchesView(event: ErrorNotification): boolean {
    if (!event.space || event.space !== this.space) return false;

    const isDefaultView = isViewingDefaultPatternView(this.app.view);
    const reportedPieceId = event.pieceId?.replace(/^of:/, "");
    if (reportedPieceId) {
      const addressedPieceIds = isDefaultView
        ? [this._spaceRootPattern.value?.id()]
        : "pieceSlug" in this.app.view
        ? [
          this.#shownPieceId ?? this.#selectedPatternTargetId ??
            (this._selectedPattern.status === TaskStatus.COMPLETE
              ? this._selectedPattern.value?.id()
              : undefined),
        ]
        : [
          this._selectedPattern.status === TaskStatus.COMPLETE
            ? this._selectedPattern.value?.id()
            : undefined,
          this.#selectedPatternTargetId,
          "pieceId" in this.app.view ? this.app.view.pieceId : undefined,
        ];
      const knownPieceIds = addressedPieceIds.filter((id) => id !== undefined);
      if (
        knownPieceIds.length > 0 &&
        !knownPieceIds.some((id) => id?.replace(/^of:/, "") === reportedPieceId)
      ) {
        return false;
      }
      if (
        knownPieceIds.length === 0
      ) {
        return false;
      }
    }

    return true;
  }

  override render() {
    const config = this.app.config ?? {};
    const { activePattern } = this._patterns.value ?? {};
    const embedded = isEmbeddedView(this.app.view);
    const isViewingDefaultPattern = isViewingDefaultPatternView(this.app.view);
    const patternLoadError: LoadError | undefined = isViewingDefaultPattern
      ? this._spaceRootPattern.status === TaskStatus.ERROR
        ? { kind: "space", error: this._spaceRootPattern.error }
        : undefined
      : this._selectedPattern.status === TaskStatus.ERROR
      ? { kind: "piece", error: this._selectedPattern.error }
      : undefined;
    const loadError = this.spaceLoadError ?? patternLoadError;
    const runtimeLoadError = loadError
      ? undefined
      : this.#getRuntimeLoadError();
    this.#setTitleSubscription(activePattern);

    const authenticated = html`
      <x-body-view
        .rt="${this.rt}"
        .space="${this.space}"
        .activePattern="${activePattern}"
        .piecePath="${"piecePath" in this.app.view
          ? this.app.view.piecePath ?? []
          : []}"
        .loadError="${loadError}"
        .runtimeError="${runtimeLoadError}"
        .showShellPieceListView="${config.showShellPieceListView ?? false}"
        .showSidebar="${config.showSidebar ?? false}"
        .embedded="${embedded}"
      ></x-body-view>
    `;
    const unauthenticated = html`
      <x-login-view .keyStore="${this.keyStore}"></x-login-view>
    `;

    const pieceId = this.#getActivePatternId();
    const spaceName = this.app && "spaceName" in this.app.view
      ? this.app.view.spaceName
      : this.app && "builtin" in this.app.view &&
          this.app.view.builtin === "home"
      ? "<home>"
      : undefined;
    const spaceDid = this.app && "spaceDid" in this.app.view
      ? this.app.view.spaceDid
      : undefined;
    const content = this.app?.identity ? authenticated : unauthenticated;
    return html`
      <div class="shell-container">
        ${embedded ? nothing : html`
          <x-header-view
            .isLoggedIn="${!!this.app.identity}"
            .spaceName="${spaceName}"
            .spaceDid="${spaceDid}"
            .rt="${this.rt}"
            .space="${this.space}"
            .keyStore="${this.keyStore}"
            .pieceTitle="${this.pieceTitle}"
            .pieceId="${pieceId}"
            .pieceAddress="${this.#getActivePieceAddress()}"
            .pieceReference="${this.#getPieceReference()}"
            .isViewingDefaultPattern="${isViewingDefaultPattern}"
            .showDebuggerView="${config.showDebuggerView ?? false}"
          ></x-header-view>
        `}
        <div class="content-area">
          ${content}
        </div>
      </div>
      ${this.app.identity && !embedded
        ? html`
          <x-debugger-view
            .visible="${this.#debuggerController.isVisible()}"
            .telemetryMarkers="${this.#debuggerController
              .getTelemetryMarkers()}"
            .debuggerController="${this.#debuggerController}"
          ></x-debugger-view>
        `
        : ""}
    `;
  }
}

globalThis.customElements.define("x-app-view", XAppView);
