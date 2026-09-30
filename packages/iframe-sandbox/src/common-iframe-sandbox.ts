import { css, html, LitElement, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { createRef, Ref, ref } from "lit/directives/ref.js";
import { type FabricBridge, FabricBridgeHost } from "./bridge.ts";
import { GuestSessions } from "./guest-sessions.ts";
import * as IPC from "./ipc.ts";
import OuterFrame from "./outer-frame.ts";

type CommonIframeLoadState = "" | "loading" | "loaded";

// @summary A sandboxed iframe to execute arbitrary scripts.
// @tag common-iframe-sandbox
// @prop {string} src - String representation of HTML content to load within an iframe.
// @prop bridge - Explicit resources made available to the guest.
// @event {CustomEvent} common-iframe-error - An error from the iframe.
// @event {CustomEvent} load - The iframe was successfully loaded.
export class CommonIframeSandboxElement extends LitElement {
  get src() {
    return this.#src;
  }

  @property()
  set src(value: string) {
    const previousValue = this.#src;
    this.#src = value;
    this.requestUpdate("src", previousValue);
  }

  get bridge(): FabricBridge | undefined {
    return this.#bridge;
  }

  @property({ attribute: false })
  set bridge(value: FabricBridge | undefined) {
    const previousValue = this.#bridge;
    this.#bridge = value;
    this.requestUpdate("bridge", previousValue);
  }

  @property({ attribute: "load-state", reflect: true })
  accessor loadState: CommonIframeLoadState = "";

  /**
   * Where the outer frame loads from, or `undefined` to inline its document
   * as `srcdoc`.
   *
   * A `srcdoc` document inherits the policy container of the page embedding
   * it, so the embedding page's Content Security Policy applies inside the
   * frame alongside the frame's own. A page whose policy refuses inline script
   * therefore refuses the outer frame's script and every guest's, and the
   * sandbox never loads. A document loaded from a URL takes its policy from
   * its own response instead, so a host that keeps such a policy serves the
   * outer frame itself and names it here.
   *
   * The document at the URL is the host's to serve: `outer-frame-script.js`
   * as its script, under a policy that admits what the guest needs, which the
   * guest's `srcdoc` frame inherits in turn. With no `data-host-origin` on the
   * script, the host's origin is taken to be the one the document was served
   * from, so a host serving it from another origin says which origin it is on
   * that attribute.
   *
   * It is the host's to set: the outer frame is what stands between the
   * guest and the page. So it is a property with no attribute, which keeps
   * it out of reach of HTML, and whoever holds the element answers for what
   * they assign. `cf-iframe` holds this one inside its shadow tree and
   * assigns what the runtime the host provided says, and nothing else.
   *
   * A change replaces the frame, and the guest with it, whether it is from
   * inlined to served, the other way, or from one URL to another: the
   * document is loaded again into the frame that results.
   */
  @property({ attribute: false })
  accessor outerFrameUrl: string | undefined = undefined;

  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #ddd;
    }
  `;

  #src = "";
  #bridge: FabricBridge | undefined;

  /** The capability sessions on offer to the loaded guest. */
  #guestSessions = new GuestSessions<FabricBridgeHost>();

  /**
   * The frame this element renders, held so the guest can be reached through
   * it.
   */
  readonly #iframeRef: Ref<HTMLIFrameElement> = createRef();

  /**
   * The outer-frame window whose `ready` this element last acted on, once one
   * has. Its identity is what tells a frame that has been replaced from the
   * one already in hand: detaching the element discards the frame's browsing
   * context, so the frame reattaching brings is a different window.
   */
  #readyWindow: Window | undefined;

  /**
   * The frame, the window whose readiness was last acted on, and the
   * outer-ready step, which a test drives directly: it asserts the
   * outer-ready refusal where the refusal is made, since a frame reports
   * itself ready exactly once, from a window nothing outside this element
   * can speak for.
   */
  get accessForTestingOnly(): {
    readonly iframeRef: Ref<HTMLIFrameElement>;
    readonly readyWindow: Window | undefined;
    onOuterReady(source: Window): void;
  } {
    // deno-lint-ignore no-this-alias
    const outerThis = this;
    return {
      iframeRef: this.#iframeRef,
      get readyWindow() {
        return outerThis.#readyWindow;
      },
      onOuterReady: (source) => this.#onOuterReady(source),
    };
  }

  /**
   * Handles the outer frame reporting itself ready, which it does on its own
   * load. That is once for an element that stays where it is, and again each
   * time the frame reloads -- which detaching the element and reattaching it
   * across a turn of the event loop does, a move within one leaving the frame
   * alone. The guest documents in between are each announced by their own load
   * rather than by this.
   *
   * Whatever the previous frame held went with it, so this lets go of that
   * guest and loads `src` into the new frame. With no `src` there is nothing
   * to load and nothing loaded, which is what the load state then says; the
   * next assignment to one does the loading.
   *
   * `source` is the window that reported it, and a second report from the one
   * already in hand is refused: a frame says this once, so hearing it twice
   * from the same window is this element's model of the frame's lifetime being
   * wrong rather than a frame having been replaced.
   */
  #onOuterReady(source: Window) {
    if (source === this.#readyWindow) {
      throw new Error(`common-iframe-sandbox: Already initialized.`);
    }
    this.#readyWindow = source;
    this.#releaseGuest();
    if (this.src) {
      this.#loadInnerDoc();
    } else {
      this.loadState = "";
    }
  }

  /**
   * Offers the loaded guest one end of a fresh channel and takes the other.
   * Each document is its own realm, so each gets a port of its own. Whether
   * this offer reaches a new document or one already holding a port -- which
   * refuses it -- is settled by which session the guest's requests arrive on;
   * `GuestSessions` holds what that leaves undecided.
   */
  #openGuestPort() {
    // The guest is the inner frame, which is a frame of the outer one. A
    // cross-origin frame is unreachable for anything but this: indexed access
    // and `postMessage`, which is what a transfer rides.
    const guestWindow = this.#iframeRef.value?.contentWindow?.frames[0];
    if (!guestWindow) {
      console.error("common-iframe-sandbox: No guest frame to open a port to.");
      return;
    }

    const channel = new MessageChannel();
    this.#guestSessions.offer(
      new FabricBridgeHost(
        this.bridge ?? { resources: {} },
        channel.port1,
        (session) => this.#guestSessions.retireBefore(session),
      ),
    );
    guestWindow.postMessage(IPC.GUEST_PORT_ORDERED, "*");
    guestWindow.postMessage(IPC.GUEST_PORT_HANDOFF, "*", [channel.port2]);
  }

  /** Handles a message from the outer frame. */
  #onMessage = (event: MessageEvent) => {
    if (event.source !== this.#iframeRef.value?.contentWindow) {
      return;
    }

    if (!IPC.isIPCGuestMessage(event.data)) {
      console.error(
        "common-iframe-sandbox: Malformed message from guest.",
        event.data,
      );
      return;
    }

    const outerMessage: IPC.IPCGuestMessage = event.data;

    switch (outerMessage.type) {
      case IPC.IPCGuestMessageType.Load: {
        this.#openGuestPort();
        this.loadState = "loaded";
        this.dispatchEvent(new CustomEvent("load"));
        return;
      }
      case IPC.IPCGuestMessageType.OuterError: {
        console.error(
          "common-iframe-sandbox: Error from outer frame:",
          outerMessage.data,
        );
        return;
      }
      case IPC.IPCGuestMessageType.GuestError: {
        // The guest raised this outside its port, and the outer frame passed
        // it along without reading it, so this is the first look anything has
        // had at it.
        const raised = outerMessage.data;
        if (IPC.isGuestFlush(raised)) {
          // Everything the relay carried ahead of this marker has been
          // handled, which is what the acknowledgement asserts. A marker
          // cannot say which session its guest holds, so every session on
          // offer carries the answer; the nonce sees to it that only the
          // guest that posted this marker acts on one.
          for (const session of this.#guestSessions.offered) {
            session.acknowledgeFlush(raised.nonce);
          }
        } else if (IPC.isGuestPortRequest(raised)) {
          // While a document is loading, the request may come from the one
          // being replaced, and the load report still to come hands the new
          // one its port.
          if (this.loadState === "loaded") this.#openGuestPort();
        } else if (IPC.isGuestAlarm(raised)) {
          this.#dispatchGuestError(raised.data);
        } else {
          console.error(
            "common-iframe-sandbox: Unreadable alarm from guest.",
            raised,
          );
        }
        return;
      }
      case IPC.IPCGuestMessageType.Ready: {
        this.#onOuterReady(event.source as Window);
        return;
      }
    }
  };

  /**
   * Dispatches `common-iframe-error` for an error the guest raised, by either
   * of the routes one can arrive on.
   */
  #dispatchGuestError(
    { description, source, lineno, colno, stacktrace }: IPC.GuestError,
  ) {
    this.dispatchEvent(
      new CustomEvent("common-iframe-error", {
        detail: {
          description,
          message: description,
          source,
          lineno,
          colno,
          stacktrace,
          stack: stacktrace,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  /**
   * Lets go of the current guest, if there is one: its subscriptions are
   * cancelled, each against the context it was taken out against, and its port
   * is closed. Called where a guest stops being this
   * element's, which is when one is asked to be replaced and when the frame
   * holding it has gone.
   */
  #releaseGuest() {
    this.#guestSessions.closeAll();
  }

  /**
   * Asks the outer frame to load `src`, letting go of the guest being replaced
   * before asking rather than once the replacement arrives. What that guest
   * sends over the interval between the two reaches a closed port, which is
   * the whole of what this end can promise about a document still running in a
   * frame it has asked to be rid of.
   */
  #loadInnerDoc() {
    this.loadState = "loading";
    this.#releaseGuest();
    this.#toOuterFrame({
      type: IPC.IPCHostMessageType.LoadDocument,
      data: this.src,
    });
  }

  /** Sends `message` to the outer frame. */
  #toOuterFrame(message: IPC.IPCHostMessage) {
    this.#iframeRef.value?.contentWindow?.postMessage(message, "*");
  }

  /** The outer frame's message listener, as `globalThis` holds it. */
  #boundOnMessage = this.#onMessage.bind(this);

  /** @inheritDoc */
  override connectedCallback() {
    super.connectedCallback();
    globalThis.addEventListener("message", this.#boundOnMessage);
  }

  /** @inheritDoc */
  override disconnectedCallback() {
    super.disconnectedCallback();
    globalThis.removeEventListener("message", this.#boundOnMessage);
    queueMicrotask(() => {
      if (!this.isConnected) this.#releaseGuest();
    });
  }

  /**
   * Reloads on a change to `src` or `bridge`, once the frame is ready; until
   * then `#onOuterReady` does the first load. Reacting here rather than in the
   * setters folds a batch of changes into one load: assigning both properties
   * asks for one document, carrying both new values, rather than reloading
   * the old document under the new bridge on the way.
   */
  protected override updated(changed: PropertyValues) {
    super.updated(changed);
    if (changed.has("outerFrameUrl")) {
      // The render this follows replaced the frame, so the window whose
      // readiness was acted on is gone and its guest with it. The frame that
      // took its place reports itself ready once it loads, and that loads
      // `src`; until then there is nothing to ask anything of.
      this.#readyWindow = undefined;
      this.#releaseGuest();
      this.loadState = "";
      return;
    }
    if (!this.#readyWindow) return;
    if (changed.has("src") || (changed.has("bridge") && this.src)) {
      this.#loadInnerDoc();
    }
  }

  /**
   * Renders the outer frame, from `outerFrameUrl` or inlined.
   *
   * The frame is keyed by where it loads from, so a change of that replaces
   * the element rather than navigating it, and `updated()` can take the
   * window it had as gone. A frame that was navigated instead would keep its
   * window: a `ready` its old document had already posted would be taken for
   * the new one's, and the new one's own would then be refused as a second
   * from a window already in hand.
   */
  override render() {
    const url = this.outerFrameUrl;
    return keyed(
      url,
      url === undefined
        ? html`
          <iframe
            ${ref(this.#iframeRef)}
            allow="clipboard-write"
            sandbox="allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox"
            .srcdoc="${OuterFrame}"
            height="100%"
            width="100%"
            style="border: none;"
          ></iframe>
        `
        : html`
          <iframe
            ${ref(this.#iframeRef)}
            allow="clipboard-write"
            sandbox="allow-scripts allow-pointer-lock allow-popups allow-popups-to-escape-sandbox"
            src="${url}"
            height="100%"
            width="100%"
            style="border: none;"
          ></iframe>
        `,
    );
  }
}

customElements.define("common-iframe-sandbox", CommonIframeSandboxElement);
