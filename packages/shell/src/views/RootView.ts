import { debugStr } from "@commonfabric/data-model";
import { type DID, type Identity, KeyStore } from "@commonfabric/identity";
import { resolveSpaceDid, RuntimeInternals } from "@commonfabric/lib-shell";
import {
  AppView,
  isAppViewEqual,
  isViewingDefaultPatternView,
  navigate,
} from "@commonfabric/navigation";
import {
  type ErrorNotification,
  type EventAttentionNotice,
  type RuntimeClient,
  RuntimeErrorCode,
} from "@commonfabric/runtime-client";
import {
  presenceUrlContext,
  runtimeContext,
  spaceContext,
} from "@commonfabric/ui";
import { provide } from "@lit/context";
import { Task, TaskStatus } from "@lit/task";
import { css, html, PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import {
  AppState,
  AppStateConfigKey,
  AppStateSerialized,
  assertIdentityChangeAllowed,
  clone,
  isAppStateConfigKey,
  resolveIdentity,
  serialize,
  type SerializedIdentity,
  ShellApp,
} from "../lib/app-state.ts";
import {
  clearRuntimeDebugGlobals,
  type CommonfabricDebugState,
  exposeCommonfabricGlobals,
} from "../lib/debug-utils.ts";
import {
  COMMIT_SHA,
  ENVIRONMENT,
  EXPERIMENTAL,
  PRESENCE_URL,
} from "../lib/env.ts";
import { runtimeHostFlags } from "../lib/host-toggles.ts";
import { type BrowserTelemetry, initBrowserOtel } from "../lib/otel.ts";
import { shouldRecreateRuntime } from "../lib/runtime-lifecycle.ts";
import {
  getThemePreference,
  type ThemePreference,
} from "../lib/theme-preference.ts";
import {
  BaseView,
  type Command,
  createDefaultAppState,
  SHELL_COMMAND,
} from "./BaseView.ts";
import type { LoadError } from "./BodyView.ts";

function getCommonfabricGlobal(): typeof globalThis & {
  commonfabric?: CommonfabricDebugState;
} {
  return globalThis as typeof globalThis & {
    commonfabric?: CommonfabricDebugState;
  };
}

const eventAttentionNoticeKey = (
  notice: Pick<EventAttentionNotice, "space" | "sidecarId" | "eventId" | "seq">,
): string =>
  JSON.stringify([notice.space, notice.sidecarId, notice.eventId, notice.seq]);

// The root element for the shell application.
//
// Derives `RuntimeInternals` for the application from its `AppState`, and owns
// every write to that state. A child element asks for a change by firing a
// `Command` as a `SHELL_COMMAND` event; the shell's `Navigation`, the key
// bootstrap and the integration harness call the methods directly.
export class XRootView extends BaseView implements ShellApp {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100dvh;
      overflow: hidden;
    }

    #body {
      height: 100%;
      width: 100%;
    }

    #event-attention {
      position: fixed;
      z-index: 1000;
      right: 1rem;
      bottom: 1rem;
      display: grid;
      gap: 0.75rem;
      width: min(24rem, calc(100vw - 2rem));
      max-height: calc(100dvh - 2rem);
      overflow-y: auto;
      pointer-events: none;
    }

    .attention-card {
      pointer-events: auto;
      padding: 1rem;
      border: 1px solid
        var(--shell-divider, var(--cf-theme-color-border, #111));
      border-radius: 0.75rem;
      color: var(--font-color, var(--cf-theme-color-text, #111));
      background: var(--shell-surface, var(--cf-theme-color-surface, #fff));
      box-shadow: 0 0.5rem 1.5rem rgb(0 0 0 / 18%);
    }

    .attention-card h2 {
      margin: 0 0 0.375rem;
      font-size: 1rem;
    }

    .attention-card p {
      margin: 0 0 0.75rem;
      line-height: 1.35;
    }

    .attention-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
    }
  `;

  @state()
  accessor app = createDefaultAppState();

  @state()
  private accessor _themePreference: ThemePreference = getThemePreference();

  @state()
  private accessor _spaceResolutionError: LoadError | undefined = undefined;

  @state()
  private accessor _runtimeLoadErrors: readonly ErrorNotification[] = [];

  @state()
  private accessor _eventAttention: readonly EventAttentionNotice[] = [];

  @state()
  private accessor _resolvingAttention = new Map<string, symbol>();

  #eventAttentionMutation = 0;
  #eventAttentionMutationVersions = new Map<
    DID,
    Map<string, number>
  >();
  #eventAttentionRefreshOwners = new Map<DID, symbol>();

  /**
   * Generation counter which invalidates callbacks from replaced workers. A
   * coded compiler-load error can arrive through either a request reply or an
   * asynchronous runtime error; only the currently-owned worker may trigger
   * one replacement.
   */
  #runtimeGeneration = 0;

  #preserveRuntimeErrorsForNextViewChange = false;

  readonly preserveRuntimeErrorsForNextViewChange = (): void => {
    this.#preserveRuntimeErrorsForNextViewChange = true;
  };

  readonly _handleRuntimeError = (
    event: ErrorNotification,
    generation = this.#runtimeGeneration,
  ): void => {
    console.error("[RuntimeClient Error]", event);
    if (generation !== this.#runtimeGeneration) {
      return;
    }

    if (event.code !== RuntimeErrorCode.CompilerStackLoadFailed) {
      if (!event.space || event.space !== this.space) return;
      const sameContext = (candidate: ErrorNotification) =>
        candidate.space === event.space &&
        candidate.pieceId === event.pieceId &&
        candidate.patternId === event.patternId;
      this._runtimeLoadErrors = [
        ...this._runtimeLoadErrors.filter((candidate) =>
          !sameContext(candidate)
        ).slice(-19),
        event,
      ];
      return;
    }

    // A failed module URL is cached as failed in this worker's module map.
    // RuntimeInternals.dispose() asks the worker to flush pending storage writes
    // before terminating it; the replacement gets a fresh module map and can
    // retry the compiler chunk when the user retries the operation.
    this._runtimeLoadErrors = [];
    this.#runtimeGeneration++;
    this.#rt.run([this.app]);
  };

  @property()
  accessor keyStore: KeyStore | undefined = undefined;

  @provide({ context: runtimeContext })
  @state()
  private accessor runtime: RuntimeClient | undefined = undefined;

  @provide({ context: spaceContext })
  @state()
  private accessor space: DID | undefined = undefined;

  @provide({ context: presenceUrlContext })
  @state()
  private accessor presenceUrl: string | undefined = PRESENCE_URL?.href;

  /**
   * The runtime task, which runs when `AppState` changes and determines if a
   * new `RuntimeInternals` must be created — only when identity or host
   * (`apiUrl`) change; one runtime serves every space. This is run manually,
   * from `updated()` and after a worker replacement, because we want to
   * compare to previous values, leaving this task responsible for cleaning up
   * previous runtimes, and creating a new one.
   */
  #rt = new Task<[AppState | undefined], RuntimeInternals | undefined>(
    this,
    {
      // Do not define `args` -- this is run in "manual mode",
      // or manually triggered from parsing `AppState` in `updated()`
      // to determine if we need to dispose or recreate a runtime,
      // whereas in a task we don't have access to necessary info
      // like previous app state.
      task: async ([app]: [AppState | undefined], { signal }) => {
        const generation = ++this.#runtimeGeneration;
        this._runtimeLoadErrors = [];
        const previous = this.#rt.value;
        if (previous) {
          this.runtime?.off(
            "eventneedsattention",
            this._handleEventNeedsAttention,
          );
          previous.dispose().catch(console.error);
        }
        this._eventAttention = [];
        this.#eventAttentionMutationVersions.clear();
        this.#eventAttentionRefreshOwners.clear();

        if (!app || !app.identity) {
          // Clear the runtime when no app state. The space belongs to the
          // view, and #syncViewSpace has already cleared it for the same
          // change that took the identity away.
          this.runtime = undefined;
          this.#telemetry = undefined;
          clearRuntimeDebugGlobals(getCommonfabricGlobal());
          return undefined;
        }

        // Browser OpenTelemetry (Phase 3): self-gated + lazy — returns null
        // (and imports no OTel SDK) unless telemetryEnabled is set. Attributes
        // use the identity's DID and the currently resolved space; the runtime
        // (and this sink) outlives navigations, so #syncViewSpace keeps the
        // sink's space.did current via setSpace.
        const userDid = app.identity.did();
        const telemetry = await initBrowserOtel({
          apiUrl: app.apiUrl,
          userDid,
          spaceDid: this.space ?? userDid,
          environment: ENVIRONMENT,
        });
        this.#telemetry = telemetry ?? undefined;

        const rt = await RuntimeInternals.create({
          identity: app.identity,
          apiUrl: app.apiUrl,
          experimental: EXPERIMENTAL,
          // Select the deployed shell's immutable worker asset graph. Source
          // runs keep the explicit mutable /scripts URL below.
          clientVersion: COMMIT_SHA,
          // A source-run shell serves its worker graph from /scripts even when
          // COMMIT_SHA identifies the checkout. Only deployed builds use the
          // immutable /builds/<sha>/ namespace selected by RuntimeInternals.
          workerUrl: ENVIRONMENT === "development"
            ? new URL("/scripts/worker-runtime.js", globalThis.location.href)
            : undefined,
          onError: (event) => this._handleRuntimeError(event, generation),
          // Per-profile dogfood toggles: worker-console forwarding and the
          // Epic H3a render ceiling (see lib/host-toggles.ts).
          ...runtimeHostFlags(),
          // lib-shell emits address-shaped targets ({spaceDid, pieceId});
          // mapNavigationView (src/lib/navigation.ts) maps a DID back to the
          // human-readable spaceName URL at the Navigation layer.
          navigate,
          // Purely additive; null when telemetry is disabled.
          telemetry: telemetry ?? undefined,
        });

        if (signal.aborted) {
          // A newer creation replaced this one. Drop what this one built and
          // leave the space alone: which space the view addresses does not
          // depend on which runtime creation won.
          rt.dispose().catch(console.error);
          this.runtime = undefined;
          clearRuntimeDebugGlobals(getCommonfabricGlobal());
          return;
        }

        // Update the provided runtime; `space` is view state, resolved
        // from app.view in willUpdate() independent of the runtime's life.
        this.runtime = rt.runtime();
        this.runtime.on(
          "eventneedsattention",
          this._handleEventNeedsAttention,
        );
        if (this.space !== undefined) {
          void this.#refreshEventAttention(this.space, generation);
        }

        // Expose the runtime and cell debug utilities for console use
        // (e.g. commonfabric.rt.setLoggerLevel("debug")).
        exposeCommonfabricGlobals(
          getCommonfabricGlobal(),
          this.runtime,
          () => this.runtime,
          () => this.space as DID,
        );

        return rt;
      },
    },
  );

  /**
   * The runtime task, its generation counter, and the unload handler, which
   * a test drives directly.
   */
  get accessForTestingOnly(): {
    readonly onBeforeUnload: (event: BeforeUnloadEvent) => void;
    rt: Task<[AppState | undefined], RuntimeInternals | undefined>;
    readonly runtimeGeneration: number;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      onBeforeUnload: this.#onBeforeUnload,
      get rt() {
        return outerThis.#rt;
      },
      set rt(value) {
        outerThis.#rt = value;
      },
      get runtimeGeneration() {
        return outerThis.#runtimeGeneration;
      },
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // A Lit element can be detached and reattached without rebuilding its
    // worker runtime. Reinstall the live notice listener that disconnect
    // removes; off-first keeps repeated connects idempotent.
    this.runtime?.off("eventneedsattention", this._handleEventNeedsAttention);
    this.runtime?.on("eventneedsattention", this._handleEventNeedsAttention);
    this.addEventListener(SHELL_COMMAND, this.onCommand);
    document.addEventListener(
      "theme-preference-changed",
      this.#onThemeChanged,
    );
    globalThis.addEventListener("beforeunload", this.#onBeforeUnload);
  }

  override disconnectedCallback(): void {
    this.runtime?.off("eventneedsattention", this._handleEventNeedsAttention);
    this.removeEventListener(SHELL_COMMAND, this.onCommand);
    document.removeEventListener(
      "theme-preference-changed",
      this.#onThemeChanged,
    );
    globalThis.removeEventListener("beforeunload", this.#onBeforeUnload);
    super.disconnectedCallback();
  }

  /**
   * Handler for `beforeunload`. A page teardown (reload, tab close, external
   * navigation) terminates the runtime worker, dropping any commit the server
   * has not yet confirmed. The worker mirrors its pending-commit state to
   * `RuntimeClient.hasPendingWrites` on every transition, so this synchronous
   * check is current; while writes are unconfirmed, this asks the browser to
   * confirm leaving instead of silently losing them. Commits confirm quickly
   * (typically well under a second), so the prompt only appears in the narrow
   * window a reload would actually lose data.
   */
  #onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (this.runtime?.hasPendingWrites()) {
      event.preventDefault();
    }
  };

  /**
   * Points `space` at the space the new view addresses. This runs before
   * render, not in `updated()`, so no render ever pairs a view with the space
   * of the view it replaced. `XAppView` reads the view and the space together
   * and treats a space name that disagrees with a space DID as an error.
   */
  protected override willUpdate(changedProperties: PropertyValues<this>): void {
    if (changedProperties.has("app")) {
      const previousView = changedProperties.get("app")?.view;
      if (!previousView || !isAppViewEqual(previousView, this.app.view)) {
        if (!this.#preserveRuntimeErrorsForNextViewChange) {
          this._runtimeLoadErrors = [];
        }
        this.#preserveRuntimeErrorsForNextViewChange = false;
      }
      this.#syncViewSpace(this.app);
    }
  }

  protected override updated(changedProperties: PropertyValues<this>): void {
    if (!changedProperties.has("app")) {
      return;
    }
    const previous = changedProperties.get("app");
    const current = this.app;

    // If the first set, or if removed, run
    const flipState = (!previous && current) ||
      !current;

    const stateChanged = !!previous &&
      shouldRecreateRuntime(previous, current);

    if (flipState || stateChanged) {
      this.#rt.run([current]);
    }
  }

  /**
   * The active browser telemetry sink (`undefined` when telemetry is disabled
   * or there is no runtime); kept only so `space.did` attribution can track
   * navigation.
   */
  #telemetry: BrowserTelemetry | undefined;

  /**
   * The name the current lookup was started for, while the view addresses its
   * space by name. Navigating within that name keeps the space already
   * resolved, and keeps a lookup still in flight running. A lookup that fails
   * clears this, so a later navigation to the same name tries again.
   */
  #resolvedSpaceName: string | undefined;

  /** Token which invalidates a resolution a newer navigation has superseded. */
  #resolveSpaceToken = 0;

  #spaceResolution: Promise<void> | undefined;

  /**
   * Returns a promise which resolves once the space the current view
   * addresses is known. A view that names its space resolves that name
   * asynchronously, and addresses no space until the name lands.
   */
  spaceResolved(): Promise<void> {
    return this.#spaceResolution ?? Promise.resolve();
  }

  /**
   * Derives the view's space DID — view state, independent of the runtime's
   * lifecycle. Every path assigns synchronously except a space named by the
   * view, which has to be looked up.
   */
  #syncViewSpace(app: AppState | undefined): void {
    const identity = app?.identity;
    const view = app?.view;
    if (identity && view && "spaceName" in view) {
      // The name alone decides the space: a named space's key is derived from
      // the name and a fixed passphrase, so every identity on one name
      // addresses the same space. A change of identity leaves the answer
      // alone. The home view below is the case that does turn on identity,
      // and it recomputes on every change.
      if (view.spaceName === this.#resolvedSpaceName) return;
      this.#resolveNamedSpace(identity, view.spaceName);
      return;
    }

    this._spaceResolutionError = undefined;
    this.#resolvedSpaceName = undefined;
    this.#spaceResolution = undefined;
    let space: DID | undefined;
    if (identity && view) {
      if ("builtin" in view) {
        space = view.builtin === "home" ? identity.did() : undefined;
      } else if ("spaceDid" in view) {
        space = view.spaceDid;
      }
    }
    this.#setSpace(space, ++this.#resolveSpaceToken);
  }

  #resolveNamedSpace(identity: Identity, spaceName: string): void {
    const token = ++this.#resolveSpaceToken;
    this._spaceResolutionError = undefined;
    this.#resolvedSpaceName = spaceName;
    // The lookup is asynchronous, so the view addresses no space until it
    // completes. The space of the view being replaced is not it.
    this.#setSpace(undefined, token);
    this.#spaceResolution = resolveSpaceDid(identity, spaceName).then(
      (space) => this.#setSpace(space, token),
      (error) => {
        console.error("[RootView] Failed to resolve space name:", error);
        if (token !== this.#resolveSpaceToken) return;
        this._spaceResolutionError = { kind: "space", error };
        this.#resolvedSpaceName = undefined;
        this.#setSpace(undefined, token);
      },
    );
  }

  #setSpace(space: DID | undefined, token: number): void {
    if (token !== this.#resolveSpaceToken || space === this.space) return;
    const previousSpace = this.space;
    this.space = space;
    this._eventAttention = [];
    if (previousSpace !== undefined) {
      this.#eventAttentionMutationVersions.delete(previousSpace);
      this.#eventAttentionRefreshOwners.delete(previousSpace);
    }
    // Keep browser OTel span attribution in sync with the resolved space —
    // the telemetry sink lives across navigations.
    this.#telemetry?.setSpace(space);
    if (space !== undefined) {
      void this.#refreshEventAttention(space, this.#runtimeGeneration);
    }
  }

  readonly _handleEventNeedsAttention = (
    notice: EventAttentionNotice,
  ): void => {
    if (notice.space !== this.space) return;
    const key = eventAttentionNoticeKey(notice);
    this.#noteEventAttentionMutation(notice.space, key);
    this._eventAttention = [
      ...this._eventAttention.filter((candidate) =>
        eventAttentionNoticeKey(candidate) !== key
      ),
      notice,
    ];
  };

  #noteEventAttentionMutation(space: DID, key: string): void {
    const versions = this.#eventAttentionMutationVersions.get(space) ??
      new Map<string, number>();
    versions.set(key, ++this.#eventAttentionMutation);
    this.#eventAttentionMutationVersions.set(space, versions);
  }

  async #refreshEventAttention(space: DID, generation: number): Promise<void> {
    const runtime = this.runtime;
    if (runtime === undefined) return;
    const owner = Symbol(space);
    const startedAt = this.#eventAttentionMutation;
    this.#eventAttentionRefreshOwners.set(space, owner);
    try {
      const notices = await runtime.listEventAttention(space);
      if (
        generation !== this.#runtimeGeneration || runtime !== this.runtime ||
        space !== this.space ||
        this.#eventAttentionRefreshOwners.get(space) !== owner
      ) return;
      const currentByKey = new Map(
        this._eventAttention.filter((notice) => notice.space === space).map(
          (notice) => [eventAttentionNoticeKey(notice), notice] as const,
        ),
      );
      const reconciled = new Map(
        notices.map((notice) =>
          [eventAttentionNoticeKey(notice), notice] as const
        ),
      );
      for (
        const [key, version]
          of this.#eventAttentionMutationVersions.get(space) ?? []
      ) {
        if (version <= startedAt) continue;
        const current = currentByKey.get(key);
        if (current === undefined) reconciled.delete(key);
        else reconciled.set(key, current);
      }
      this._eventAttention = [
        ...this._eventAttention.filter((notice) => notice.space !== space),
        ...reconciled.values(),
      ];
    } catch (error) {
      if (
        generation === this.#runtimeGeneration && runtime === this.runtime &&
        space === this.space &&
        this.#eventAttentionRefreshOwners.get(space) === owner
      ) {
        console.error("[RootView] Failed to load event attention:", error);
      }
    } finally {
      if (this.#eventAttentionRefreshOwners.get(space) === owner) {
        this.#eventAttentionRefreshOwners.delete(space);
        this.#eventAttentionMutationVersions.delete(space);
      }
    }
  }

  readonly _resolveEventAttention = async (
    notice: EventAttentionNotice,
    action: "retry" | "dismiss",
  ): Promise<void> => {
    const runtime = this.runtime;
    if (runtime === undefined) return;
    const key = eventAttentionNoticeKey(notice);
    if (this._resolvingAttention.has(key)) return;
    const request = Symbol(key);
    this._resolvingAttention = new Map(this._resolvingAttention).set(
      key,
      request,
    );
    try {
      await runtime.resolveEventAttention(notice, action);
      this._eventAttention = this._eventAttention.filter((candidate) =>
        eventAttentionNoticeKey(candidate) !== key
      );
      this.#noteEventAttentionMutation(notice.space, key);
    } catch (error) {
      console.error(`[RootView] Failed to ${action} event:`, error);
    } finally {
      if (this._resolvingAttention.get(key) === request) {
        const resolving = new Map(this._resolvingAttention);
        resolving.delete(key);
        this._resolvingAttention = resolving;
      }
    }
  };

  #onThemeChanged = (e: Event) => {
    this._themePreference = (e as CustomEvent).detail;
  };

  /**
   * Handler for command events. An event handler cannot await, so a command
   * that fails after its first suspension point reports as an unhandled
   * rejection.
   */
  onCommand = (e: Event) => {
    void this.#runCommand((e as CustomEvent<Command>).detail);
  };

  #runCommand(command: Command): Promise<void> {
    switch (command.type) {
      case "set-view":
        return this.setView(command.view);
      case "set-identity":
        return this.setIdentity(command.identity);
      case "set-config":
        return this.setConfig(command.key, command.value);
    }
    throw new Error(
      debugStr`Received a non-command: $quote,long${command}`,
    );
  }

  state(): AppState {
    return clone(this.app);
  }

  /**
   * Returns the application state in the JSON-shaped form that survives the
   * page boundary the integration harness reads across.
   */
  serialize(): AppStateSerialized {
    return serialize(this.state());
  }

  setView(view: AppView): Promise<void> {
    const next = clone(this.app);
    next.view = view;
    // Addressing a piece hands the main view area to that piece, so the
    // shell's own piece list closes on the way.
    if (!isViewingDefaultPatternView(view)) {
      next.config.showShellPieceListView = false;
    }
    return this.#commit(next, "set-view");
  }

  async setIdentity(
    id: Identity | SerializedIdentity | undefined,
  ): Promise<void> {
    const identity = await resolveIdentity(id);
    assertIdentityChangeAllowed(this.app.identity, identity);
    const next = clone(this.app);
    next.identity = identity;
    await this.#commit(next, "set-identity");
  }

  setConfig(key: AppStateConfigKey, value: boolean): Promise<void> {
    if (!isAppStateConfigKey(key)) {
      throw new Error(`Invalid config key: ${key}`);
    }
    const next = clone(this.app);
    next.config[key] = value;
    return this.#commit(next, `set-config ${key}=${value}`);
  }

  /**
   * Adopts the next application state and resolves once the render it triggers
   * has landed.
   */
  #commit(next: AppState, description: string): Promise<void> {
    this.app = next;
    if (ENVIRONMENT !== "production") {
      const time = (globalThis.performance.now() / 1000).toFixed(3);
      console.log(`[app] ${time}s ${description}`, next);
    }
    return this.updateComplete.then((_) => undefined);
  }

  getRuntimeSpaceDID(): DID | undefined {
    return this.space;
  }

  override render() {
    const loadError: LoadError | undefined = this._spaceResolutionError ??
      (this.#rt.status === TaskStatus.ERROR
        ? { kind: "space", error: this.#rt.error }
        : undefined);
    return html`
      <cf-theme .theme="${{ colorScheme: this._themePreference }}">
        <x-app-view
          .app="${this.app}"
          .keyStore="${this.keyStore}"
          .rt="${this.#rt.value}"
          .space="${this.space}"
          .spaceLoadError="${loadError}"
          .runtimeLoadErrors="${this._runtimeLoadErrors}"
          .preserveRuntimeErrorsForNextViewChange="${this
            .preserveRuntimeErrorsForNextViewChange}"
        ></x-app-view>
        ${this._eventAttention.length === 0 ? undefined : html`
          <aside
            id="event-attention"
            role="status"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Events needing attention"
          >
            ${this._eventAttention.map((notice) => {
              const key = eventAttentionNoticeKey(notice);
              const resolving = this._resolvingAttention.has(key);
              return html`
                <section class="attention-card">
                  <h2>Event needs attention</h2>
                  <p>${notice.reason}</p>
                  <div class="attention-actions">
                    <cf-button
                      variant="outline"
                      ?disabled="${resolving}"
                      @click="${() =>
                        this._resolveEventAttention(notice, "dismiss")}"
                    >Dismiss</cf-button>
                    ${notice.retryable !== false
                      ? html`
                        <cf-button
                          ?disabled="${resolving}"
                          @click="${() =>
                            this._resolveEventAttention(notice, "retry")}"
                        >Retry</cf-button>
                      `
                      : undefined}
                  </div>
                </section>
              `;
            })}
          </aside>
        `}
      </cf-theme>
    `;
  }
}

globalThis.customElements.define("x-root-view", XRootView);
