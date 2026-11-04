import { fabricFromJsonValue } from "@commonfabric/data-model/codecs";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import { DID, Identity } from "@commonfabric/identity";
import { AppView } from "@commonfabric/navigation";

/**
 * An identity as it crosses the integration-test page boundary: its key pair
 * in the `FabricValue` JSON encoding. A string, that boundary carrying only
 * what JSON can express.
 */
export type SerializedIdentity = string;

// Primary application state.
export interface AppState {
  identity?: Identity;
  view: AppView;
  apiUrl: URL;
  config: AppStateConfig;
}

export interface AppStateConfig {
  showShellPieceListView?: boolean;
  showDebuggerView?: boolean;
  showSidebar?: boolean;
}

export type AppStateConfigKey = keyof AppStateConfig;

// A config key names a field the display toggles record actually has. A
// `shell-command` event arrives as an untyped DOM event, so the key it carries
// is checked here before it reaches the record.
export function isAppStateConfigKey(
  value: unknown,
): value is AppStateConfigKey {
  if (typeof value !== "string") return false;
  switch (value) {
    case "showShellPieceListView":
    case "showDebuggerView":
    case "showSidebar":
      return true;
  }
  return false;
}

/**
 * The application state as it crosses the integration-test page boundary,
 * which carries only what JSON can express.
 */
export type AppStateSerialized = Omit<AppState, "identity" | "apiUrl"> & {
  /**
   * The DID of the identity the state holds, where it holds one.
   *
   * An identity appears here as its DID rather than as itself. That is what a
   * reader on the far side wants -- it is what names an identity in a
   * comparison and in a message -- and it is a public string, where the
   * identity's key material is a secret that a key pair holding `CryptoKey`
   * handles cannot produce at all.
   */
  identityDid?: DID;

  /** The API URL, as a string, `URL` being no more JSON than an identity is. */
  apiUrl: string;
};

// The application root, as everything outside the root element sees it.
// `Navigation` reads and writes the view through this, and the shell publishes
// its root element on `globalThis.app` under this type so integration tests
// can drive the page from outside. `XRootView` implements it. Declaring it
// here keeps `Navigation` and the integration-test harness clear of the root
// element's import graph.
export interface ShellApp {
  state(): AppState;
  serialize(): AppStateSerialized;
  getRuntimeSpaceDID(): DID | undefined;
  setView(view: AppView): Promise<void>;
  setIdentity(
    id: Identity | SerializedIdentity | undefined,
  ): Promise<void>;
  setConfig(key: AppStateConfigKey, value: boolean): Promise<void>;
}

/**
 * Turns either form an identity arrives in — a live `Identity`, or the encoded
 * key pair that crosses the integration-test page boundary — into the
 * `Identity` application state holds.
 */
export async function resolveIdentity(
  id: Identity | SerializedIdentity | undefined,
): Promise<Identity | undefined> {
  if (id === undefined) return undefined;
  if (id instanceof Identity) return id;
  // From the seed rather than from the pair itself: this page picks its own
  // ed25519 implementation, as it does for every identity it mints.
  return await Identity.fromRaw(
    keyPairFromSerialized(id).privateKeyBytes.slice(),
  );
}

/**
 * Decodes a {@link SerializedIdentity}, which is what the integration harness
 * sends a page to log it in.
 *
 * @throws If the encoding is well-formed and decodes to something other than a
 *   key pair.
 */
function keyPairFromSerialized(id: SerializedIdentity): FabricKeyPair {
  const keyPair = fabricFromJsonValue(id);

  if (!(keyPair instanceof FabricKeyPair)) {
    throw new Error("Serialized identity is not a key pair.");
  }

  return keyPair;
}

// One identity replaces another only by way of a logged-out state. Clearing
// the identity is always allowed.
export function assertIdentityChangeAllowed(
  current: Identity | undefined,
  next: Identity | undefined,
): void {
  if (next && current && current.did() !== next.did()) {
    throw new Error(
      "Cannot change identity while logged in. Clear identity first.",
    );
  }
}

export function createAppState(
  initial: Pick<AppState, "view" | "apiUrl" | "identity"> & {
    config?: AppStateConfig;
  },
): AppState {
  return Object.assign({}, initial, { config: initial.config ?? {} });
}

export function clone(state: AppState): AppState {
  return Object.assign({}, state, {
    config: Object.assign({}, state.config),
    view: Object.assign({}, state.view),
  });
}

export function serialize(
  state: AppState,
): AppStateSerialized {
  const { identity, apiUrl, ...other } = state;
  const out = other as unknown as AppStateSerialized;
  out.identityDid = identity?.did();
  out.apiUrl = apiUrl.toString();
  return out;
}
