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
import { bootShell } from "./lib/boot.ts";
import { handleDeviceLink } from "./lib/device-link-login.ts";
import { consumeDeviceLinkFragment } from "./lib/device-link.ts";
import {
  API_URL,
  COMMIT_SHA,
  ENVIRONMENT,
  shellDeployment,
} from "./lib/env.ts";
import { setupHostToggles } from "./lib/host-toggles.ts";
import { handleLoomPairingLink } from "./lib/loom-pairing-login.ts";
import { consumeLoomPairingFragment } from "./lib/loom-pairing.ts";

import "./components/index.ts";
import "./views/index.ts";

import { KeyStore } from "@commonfabric/identity";

import { Navigation } from "./lib/navigation.ts";
import type { XRootView } from "./views/RootView.ts";

import { publishShellApp } from "./globals.ts";

// Nothing is awaited before this call, so the address fragments that
// `bootShell()` scrubs before its first await never outlive module evaluation.
await bootShell<KeyStore, XRootView>({
  consumeDeviceLinkFragment,
  handleDeviceLink,
  consumeLoomPairingFragment,
  handleLoomPairingLink,
  window: globalThis,
  navigator,
  environment: { ENVIRONMENT, API_URL, COMMIT_SHA },
  prefetchDeployment: () => shellDeployment.prefetch(),
  setupHostToggles,
  findRoot: () => document.querySelector<XRootView>("x-root-view"),
  openKeyStore: () => KeyStore.open(),
  startNavigation: (root) => new Navigation(root),
  publish: publishShellApp,
});
