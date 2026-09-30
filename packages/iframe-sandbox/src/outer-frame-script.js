// deno-coverage-ignore-file -- runs only in a browser, as text inlined into a document.
// @ts-check

/**
 * The outer frame's own script: it loads each document the host asks for into
 * an inner frame of its own, reports each such load back to the host, and
 * forwards what the guest posts outside its port. Plain JavaScript, because
 * the browser runs this text as it stands: `outer-frame.ts` inlines it into
 * the document it assembles, on a `<script>` element whose `data-host-origin`
 * attribute carries the host's origin, and a host that serves the outer frame
 * from a URL of its own (`outerFrameUrl`) serves it as it stands.
 */

const HOST_ORIGIN = hostOrigin();
const HOST_WINDOW = globalThis.parent;

/**
 * The frame holding the guest, once the host has asked for a document. Each
 * document gets a frame of its own; see `loadDocument()`.
 *
 * @type {HTMLIFrameElement | null}
 */
let inner = null;

globalThis.addEventListener("message", onMessage);
globalThis.addEventListener("error", onOuterError);

toHost({ type: "ready" });

/**
 * Handles a message from either neighbor: the guest below or the host above.
 *
 * @param {MessageEvent} e
 */
function onMessage(e) {
  // Anything the guest posts here is forwarded without being read. It has a
  // port for every capability operation, so this route carries only a guest
  // reporting that it could not use that port.
  if (inner && e.source === inner.contentWindow) {
    toHost({ type: "guest-error", data: e.data });
    return;
  }

  if (e.source !== HOST_WINDOW || e.origin !== HOST_ORIGIN) {
    return;
  }

  if (e.data && e.data.type === "load-document") {
    loadDocument(e.data.data);
  }
}

/**
 * Loads `html` as the guest, in a fresh frame that replaces the one before
 * it. Removing a frame discards its browsing context, and with it any load
 * still in flight, so the document that ends up loaded is the one asked for
 * last however closely the requests follow one another. A frame given two
 * `srcdoc`s within a few milliseconds does not promise that: Chrome 152
 * commits the first document and drops the second.
 *
 * @param {string} html
 */
function loadDocument(html) {
  if (inner) {
    inner.remove();
  }
  inner = document.createElement("iframe");
  inner.setAttribute("allow", "clipboard-write");
  inner.setAttribute(
    "sandbox",
    "allow-popups allow-popups-to-escape-sandbox allow-scripts allow-modals",
  );
  inner.addEventListener("load", onInnerLoad);
  inner.srcdoc = html;
  document.body.appendChild(inner);
}

/**
 * Handles the guest frame's document having loaded. The host takes this as
 * its cue to hand the new document a port: a fresh document is a fresh realm,
 * and the port the previous one held died with it.
 */
function onInnerLoad() {
  toHost({ type: "load" });
}

/**
 * Reports an error raised in this frame to the host.
 *
 * @param {ErrorEvent} event
 */
function onOuterError({ message, filename, lineno, colno, error }) {
  // Not all browsers can directly send the `ErrorEvent` object, and the one
  // named `error` does not survive the crossing with its class, so what goes
  // is what reads back.
  toHost({
    type: "outer-error",
    data: {
      message,
      filename,
      lineno,
      colno,
      error: error && error.stack ? error.stack : String(error),
    },
  });
}

/**
 * Returns the host's origin. The assembly in `outer-frame.ts` places it on
 * this script's element, which is the only place a `srcdoc` document can get
 * it from: its URL is `about:srcdoc`. A document the host serves from a URL
 * of its own (`outerFrameUrl`) may leave the attribute off, and the
 * host's origin is then the one the document was served from.
 *
 * `location` names the URL even in a sandboxed frame, whose own origin is
 * opaque.
 *
 * @returns {string}
 */
function hostOrigin() {
  const origin = document.currentScript?.dataset.hostOrigin;
  if (origin) {
    return origin;
  }
  const served = new URL(location.href);
  if (served.protocol === "https:" || served.protocol === "http:") {
    return served.origin;
  }
  throw new Error("The outer frame's script needs `data-host-origin`.");
}

/**
 * Posts `data` to the host.
 *
 * @param {unknown} data
 */
function toHost(data) {
  HOST_WINDOW.postMessage(data, HOST_ORIGIN);
}
