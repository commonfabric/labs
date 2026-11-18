/**
 * The shell's startup sequence, with everything it touches passed in, so that
 * the order of its steps can be held by a test. `src/index.ts` calls it with
 * the real page.
 */

import type { Identity } from "@commonfabric/identity";

import type { DeviceLinkFragment } from "./device-link.ts";
import type { LoomPairingFragment } from "./loom-pairing.ts";
import { ROOT_KEY } from "./root-key.ts";

/** What boot reads of the key store: the stored root identity, if any. */
export interface RootKeyReader {
  /** Reads the identity stored under `name`, if there is one. */
  get(name: string): Promise<Identity | void>;
}

/** What boot needs of the root element before it is published. */
export interface BootRoot<S> {
  /** The key store, handed over once it is open. */
  keyStore: S | undefined;

  /** Signs the shell in as `identity`. */
  setIdentity(identity: Identity): Promise<void>;
}

/** Everything {@link bootShell} touches. */
export interface ShellBootDependencies<S, R> {
  /** Reads a device link out of the address and scrubs it. */
  consumeDeviceLinkFragment(): DeviceLinkFragment;

  /** Acts on a device link; never throws. */
  handleDeviceLink(
    link: Exclude<DeviceLinkFragment, { kind: "absent" }>,
    opts?: { reloadOnReplace?: boolean },
  ): Promise<void>;

  /** Reads a Loom pairing link out of the address and scrubs it. */
  consumeLoomPairingFragment(): LoomPairingFragment;

  /** Acts on a Loom pairing link; never throws. */
  handleLoomPairingLink(
    link: Exclude<LoomPairingFragment, { kind: "absent" }>,
    opts?: { reloadOnAccept?: boolean },
  ): Promise<void>;

  /** Where `hashchange` fires. */
  window: Pick<EventTarget, "addEventListener">;

  /** Registers the service worker, where the browser has one. */
  navigator: { serviceWorker?: { register(url: string): unknown } };

  /** Logged as `NAME=value` lines, so a console says which build runs. */
  environment: Record<string, unknown>;

  /** Starts fetching the deployment description. */
  prefetchDeployment(): void;

  /** Installs the `commonfabric.*` host-toggle console commands. */
  setupHostToggles(): void;

  /** Finds the root element in the page, or `null` when there is none. */
  findRoot(): R | null;

  /** Opens the browser key store. */
  openKeyStore(): Promise<S>;

  /** Installs `Navigation` on the root element. */
  startNavigation(root: R): void;

  /** Publishes the root element as `globalThis.app`. */
  publish(root: R): void;
}

/**
 * Starts the shell. Rejects when the page has no root element.
 *
 * Call it before awaiting anything: it reads and scrubs the device-link and
 * pairing fragments synchronously, before its own first await, so that a
 * secret in the address never survives into session history, a bookmark, or
 * a synced tab.
 */
export async function bootShell<S extends RootKeyReader, R extends BootRoot<S>>(
  deps: ShellBootDependencies<S, R>,
): Promise<void> {
  // Device-link login: /#k=<base64url 32-byte BIP39 entropy>. An interim
  // pre-key-delegation pairing flow; delete when delegation lands.
  const deviceLink = deps.consumeDeviceLinkFragment();

  // Loom pairing: /#pair=<code>[&loom=<Loom URL>]. Scrubbed at once for the
  // same reason, though a code is one-time and expires in ten minutes.
  const loomPairingLink = deps.consumeLoomPairingFragment();

  // Handle a scan while the app is ALREADY loaded at the QR's target URL. The
  // QR deliberately points at the page the user bookmarked as mobile Loom, so
  // re-scanning it is a same-document fragment navigation: no reload fires,
  // the read above never re-runs, and the secret would sit unscrubbed in the
  // address bar. `hashchange` is the only signal for that case. On an accepted
  // REPLACE the running app still holds the old identity, so reload to
  // re-bootstrap cleanly (the fragment is already scrubbed, so the reload is
  // clean and cannot loop).
  deps.window.addEventListener("hashchange", () => {
    const rescan = deps.consumeDeviceLinkFragment();
    if (rescan.kind === "absent") return;
    void deps.handleDeviceLink(rescan, { reloadOnReplace: true });
  });

  // The same for a pairing link opened while the app is loaded. A stored key
  // takes effect only on a reload, whether or not someone was signed in.
  deps.window.addEventListener("hashchange", () => {
    const link = deps.consumeLoomPairingFragment();
    if (link.kind === "absent") return;
    void deps.handleLoomPairingLink(link, { reloadOnAccept: true });
  });

  deps.navigator.serviceWorker?.register("/sw.js");

  for (const [name, value] of Object.entries(deps.environment)) {
    console.log(`${name}=${value}`);
  }
  // Started now, so that a page served without its deployment asks the API
  // URL for it while the rest of the shell starts.
  deps.prefetchDeployment();
  deps.setupHostToggles();

  const root = deps.findRoot();
  if (!root) throw new Error("No root view found.");

  // Runs BEFORE the key store opens: `handleDeviceLink()` writes `ROOT_KEY`
  // straight into the key store so that the read below picks the new identity
  // up. Routing it through `setIdentity()` instead would throw whenever a
  // DIFFERENT identity is already active — precisely the re-pair case this
  // exists for. It never throws, so a failed pairing degrades to a normal boot
  // rather than skipping the key store and `Navigation` entirely.
  if (deviceLink.kind !== "absent") {
    await deps.handleDeviceLink(deviceLink);
  }

  // Before the key store opens for the same reason, and likewise never throws.
  if (loomPairingLink.kind !== "absent") {
    await deps.handleLoomPairingLink(loomPairingLink);
  }

  // Hands the key store to the root element, and restores a logged-in session
  // from the stored root identity when there is one.
  const keyStore = await deps.openKeyStore();
  root.keyStore = keyStore;
  const identity = await keyStore.get(ROOT_KEY);
  if (identity) await root.setIdentity(identity);

  deps.startNavigation(root);

  // `globalThis.app` is the integration-driver readiness boundary. Publishing
  // it before `Navigation` is installed lets a driver change the view while
  // boot is awaiting the key store, only for `Navigation`'s initial URL apply
  // to overwrite that newer view when boot resumes.
  deps.publish(root);
}
