import "core-js/proposals/explicit-resource-management";
import "core-js/proposals/async-explicit-resource-management";
import "@commonfabric/ui";

// Statically imported, deliberately. A dynamic `await import()` here pushes
// the navigation and app-state modules into esbuild's lazy `__esm` wrappers,
// and esbuild then emits one of those wrappers as a NON-async function
// containing a top-level await — a bundle that is a SyntaxError, so the whole
// shell fails to load.
// (`node --check dist/scripts/index.js` catches it; the type checker and the
// unit tests do not.) There was nothing to gain either way: the shell's
// `index` entry sets `splitting: false`, so esbuild inlines dynamic imports
// rather than emitting a chunk.
import { handleDeviceLink } from "./lib/device-link-login.ts";
import { consumeDeviceLinkFragment } from "./lib/device-link.ts";
import { API_URL, COMMIT_SHA, ENVIRONMENT } from "./lib/env.ts";
import { setupHostToggles } from "./lib/host-toggles.ts";

import "./components/index.ts";
import "./views/index.ts";

import { KeyStore } from "@commonfabric/identity";

import { Navigation } from "./lib/navigation.ts";
import { ROOT_KEY } from "./lib/root-key.ts";
import type { XRootView } from "./views/RootView.ts";

import { publishShellApp } from "./globals.ts";

// Device-link login: /#k=<base64url 32-byte BIP39 entropy>.
// Read and scrubbed FIRST, synchronously, before any await — so the secret
// never survives into session history, a bookmark, or iCloud tab sync.
// Interim pre-key-delegation pairing flow; delete when delegation lands.
const deviceLink = consumeDeviceLinkFragment();

// Handle a scan while the app is ALREADY loaded at the QR's target URL. The QR
// deliberately points at the page the user bookmarked as mobile Loom, so
// re-scanning it is a same-document fragment navigation: no reload fires, the
// module-eval read above never re-runs, and the secret would sit unscrubbed in
// the address bar. `hashchange` is the only signal for that case. On an
// accepted REPLACE the running app still holds the old identity, so reload to
// re-bootstrap cleanly (the fragment is already scrubbed, so the reload is
// clean and cannot loop).
globalThis.addEventListener("hashchange", () => {
  const rescan = consumeDeviceLinkFragment();
  if (rescan.kind === "absent") return;
  void handleDeviceLink(rescan, { reloadOnReplace: true });
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

console.log(`ENVIRONMENT=${ENVIRONMENT}`);
console.log(`API_URL=${API_URL}`);
console.log(`COMMIT_SHA=${COMMIT_SHA}`);
setupHostToggles();

const root = document.querySelector<XRootView>("x-root-view");
if (!root) throw new Error("No root view found.");

// Opens the browser key store, hands it to the root element, and restores a
// logged-in session from the stored root identity when there is one.
async function initializeKeys(app: XRootView): Promise<void> {
  const keyStore = await KeyStore.open();
  app.keyStore = keyStore;
  const identity = await keyStore.get(ROOT_KEY);
  if (identity) await app.setIdentity(identity);
}

// Runs BEFORE initializeKeys: handleDeviceLink writes ROOT_KEY straight into
// the KeyStore so the normal boot below picks the new identity up. Routing it
// through XRootView.setIdentity instead would throw whenever a DIFFERENT
// identity is already active — precisely the re-pair case this exists for. It
// never throws, so a failed pairing degrades to a normal boot rather than
// skipping initializeKeys and Navigation entirely.
if (deviceLink.kind !== "absent") {
  await handleDeviceLink(deviceLink);
}

await initializeKeys(root);

const _navigation = new Navigation(root);

// `globalThis.app` is the integration-driver readiness boundary. Publishing
// it before Navigation is installed lets a driver change the view while this
// module is awaiting the KeyStore, only for Navigation's initial URL apply to
// overwrite that newer view when bootstrap resumes.
publishShellApp(root);
