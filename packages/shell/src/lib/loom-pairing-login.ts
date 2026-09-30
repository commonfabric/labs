/**
 * Signs the shell in with a Loom pairing code: redeem, ask the person when the
 * link calls for it, and store the key.
 *
 * The login screen's form and a `#pair=` link both come through here. Like
 * the device-link flow, the link path writes `ROOT_KEY` into the KeyStore
 * rather than going through `XRootView.setIdentity`, which refuses to change
 * an active identity, and runs at bootstrap, before the normal boot reads the
 * KeyStore.
 */

import { Identity, KeyStore } from "@commonfabric/identity";

import {
  createKeyFileCredential,
  saveCredential,
  type StoredCredential,
} from "./credentials.ts";
import {
  isLocalLoom,
  LoomPairingError,
  type LoomPairingFragment,
  type LoomPairingRequest,
  type RedeemedKey,
  redeemPairingCode,
} from "./loom-pairing.ts";
import { ROOT_KEY } from "./root-key.ts";
import "../views/LoomPairingView.ts";

/**
 * Result of a pairing-link login.
 *
 * Only `accepted` changed the stored key, which is what tells a caller whose
 * app is already booted that it has to reload.
 */
export type LoomPairingOutcome =
  | "accepted"
  | "already-signed-in"
  | "cancelled";

/**
 * Redeem `request` and return the identity the Loom handed over.
 *
 * @throws LoomPairingError when the Loom refuses the code or cannot be
 *   reached, or when what it returned is not a key for the DID it named.
 */
export async function pairWithLoom(
  request: LoomPairingRequest,
  redeem: (request: LoomPairingRequest) => Promise<RedeemedKey> = (r) =>
    redeemPairingCode(r, describeThisDevice()),
): Promise<Identity> {
  const { pkcs8, did } = await redeem(request);
  let identity: Identity;
  try {
    identity = await Identity.fromPkcs8(pkcs8);
  } catch (error) {
    throw new LoomPairingError(
      "invalid-response",
      `Loom at ${request.loomUrl} returned a key this browser cannot read.`,
      { cause: error },
    );
  }
  if (did !== null && did !== identity.did()) {
    throw new LoomPairingError(
      "invalid-response",
      `Loom at ${request.loomUrl} returned a key for a different identity ` +
        "than the one it named.",
    );
  }
  return identity;
}

/** What the person is asked before a pairing link signs them in. */
export interface LoomPairingQuestion {
  /** Origin of the Loom the code is for. */
  loomUrl: string;

  /** DID signed in on this device, or null when nobody is. */
  currentDid: string | null;

  /** DID the link would sign in as, or null when not yet redeemed. */
  incomingDid: string | null;
}

/**
 * Sign in with a pairing request that arrived in a link.
 *
 * How much is asked turns on where the Loom is. A Loom on this computer mints
 * codes only for this computer, so its link signs in at once when nobody is
 * signed in; when someone is, the person is asked before the code is redeemed,
 * since a redeem spends the code and the Loom records this browser as holding
 * the key. A Loom anywhere else may be someone else's, and its link could sign
 * this browser in as them. So its code is redeemed first and the person is
 * always asked, shown the Loom and the identity it handed over.
 *
 * @throws LoomPairingError as `pairWithLoom()` does.
 */
export async function runLoomPairingLogin(
  request: LoomPairingRequest,
  deps: {
    confirm?: (question: LoomPairingQuestion) => Promise<boolean>;
    pair?: (request: LoomPairingRequest) => Promise<Identity>;
    // KeyStore is IndexedDB-backed, which `deno test` lacks, so a test passes
    // a double holding the two methods used.
    openKeyStore?: () => Promise<Pick<KeyStore, "get" | "set">>;
    saveCredential?: (credential: StoredCredential) => void;
  } = {},
): Promise<LoomPairingOutcome> {
  const confirm = deps.confirm ?? confirmWithUser;
  const pair = deps.pair ?? ((r: LoomPairingRequest) => pairWithLoom(r));
  const keyStore = await (deps.openKeyStore ?? (() => KeyStore.open()))();
  const save = deps.saveCredential ?? saveCredential;

  const existing = await keyStore.get(ROOT_KEY);
  const currentDid = existing ? existing.did() : null;
  const local = isLocalLoom(request.loomUrl);
  const question = { loomUrl: request.loomUrl, currentDid, incomingDid: null };
  if (local && currentDid !== null && !await confirm(question)) {
    return "cancelled";
  }

  const identity = await pair(request);
  if (currentDid === identity.did()) return "already-signed-in";
  if (!local && !await confirm({ ...question, incomingDid: identity.did() })) {
    return "cancelled";
  }

  await keyStore.set(ROOT_KEY, identity);
  // A key-file credential is what quick unlock reads the KeyStore for, which
  // is where this key now lives.
  save(createKeyFileCredential(identity.did()));
  return "accepted";
}

/**
 * Drive one pairing link end to end: sign in, or say why not.
 *
 * Never throws. An uncaught error on the bootstrap path would skip the normal
 * key initialization and leave the shell with no view, and a failure the
 * person is not told about is indistinguishable from the link doing nothing,
 * since the scrub has already taken it out of the address bar.
 */
export async function handleLoomPairingLink(
  link: Exclude<LoomPairingFragment, { kind: "absent" }>,
  opts: {
    /**
     * True when the app is already booted (the `hashchange` path), so a
     * stored key only takes effect after a reload. False at startup, where
     * the boot that follows reads it.
     */
    reloadOnAccept?: boolean;

    reload?: () => void;
    report?: (message: string) => Promise<void>;
    login?: (request: LoomPairingRequest) => Promise<LoomPairingOutcome>;
  } = {},
): Promise<void> {
  const report = opts.report ?? reportLoomPairingFailure;
  const login = opts.login ??
    ((request: LoomPairingRequest) => runLoomPairingLogin(request));
  const reload = opts.reload ?? (() => globalThis.location.reload());
  try {
    if (link.kind === "malformed") {
      await report(
        "The pairing code in this link is incomplete or damaged. Show a new " +
          "code on the Mac that runs Loom and try again.",
      );
      return;
    }
    const outcome = await login(link.request);
    if (outcome === "accepted" && opts.reloadOnAccept) reload();
  } catch (error) {
    console.error("[loom-pairing] pairing failed", error);
    try {
      await report(
        error instanceof LoomPairingError
          ? error.message
          : "Something went wrong while pairing with Loom.",
      );
    } catch {
      // The reporter itself failed; continue booting rather than hanging.
    }
  }
}

/** The device the Loom records this browser as. */
export function describeThisDevice(): { name: string; platform: string } {
  const host = globalThis.location?.host ?? "";
  return {
    name: host ? `Common Fabric shell at ${host}` : "Common Fabric shell",
    platform: "web",
  };
}

/** Ask `question` in the pairing dialog. */
export function confirmWithUser(
  question: LoomPairingQuestion,
): Promise<boolean> {
  const view = document.createElement("x-loom-pairing-view");
  view.question = question;
  return showUntilAnswered(view);
}

/** Tell the person a pairing link did not sign them in, and why. */
export async function reportLoomPairingFailure(
  message: string,
): Promise<void> {
  const view = document.createElement("x-loom-pairing-view");
  view.failure = message;
  await showUntilAnswered(view);
}

/** Insert `view`, and remove it once the person answers. */
async function showUntilAnswered(
  view: HTMLElementTagNameMap["x-loom-pairing-view"],
): Promise<boolean> {
  // Listening before inserting, so no answer can arrive unheard.
  const answered = new Promise<boolean>((resolve) => {
    view.addEventListener(
      "loom-pairing-result",
      (event) => resolve(Boolean((event as CustomEvent).detail?.accepted)),
      { once: true },
    );
  });
  document.body.appendChild(view);
  try {
    return await answered;
  } finally {
    view.remove();
  }
}
