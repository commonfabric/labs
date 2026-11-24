import { css, html } from "lit";
import { property, state } from "lit/decorators.js";

import { Identity, type KeyStore, PassKey } from "@commonfabric/identity";

import { BaseView } from "./BaseView.ts";
import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
  clearStoredCredential,
  createKeyFileCredential,
  createPasskeyCredential,
  createPassphraseCredential,
  getPublicKeyCredentialDescriptor,
  getStoredCredential,
  saveCredential,
  type StoredCredential,
} from "../lib/credentials.ts";
import {
  availableAuthMethods,
  type LoginMethod,
  LOOM_PAIRING,
  methodsForFlow,
  storedCredentialLabel,
} from "../lib/login-methods.ts";
import {
  pairWithLoom,
  rememberKeyFileCredential,
} from "../lib/loom-pairing-login.ts";
import {
  DEFAULT_LOOM_URL,
  normalizeLoomUrl,
  normalizePairingCode,
} from "../lib/loom-pairing.ts";
import { ROOT_KEY } from "../lib/root-key.ts";
import "../components/VBox.ts";

type AuthFlow = "register" | "login";

/** The button choosing each method. */
const METHOD_BUTTONS: Record<LoginMethod, { testId: string; label: string }> = {
  [AUTH_METHOD_PASSKEY]: { testId: "use-passkey", label: "🔑 Use Passkey" },
  [AUTH_METHOD_PASSPHRASE]: {
    testId: "use-passphrase",
    label: "📝 Use Passphrase",
  },
  [AUTH_METHOD_KEYFILE]: {
    testId: "import-cli-key",
    label: "📁 Import CLI Key",
  },
  [LOOM_PAIRING]: { testId: "pair-with-loom", label: "🔗 Pair with Loom" },
};

/**
 * The input named `name` in the form `e` was submitted from, or `null` where
 * the form holds no single input of that name.
 */
function submittedInput(e: Event, name: string): HTMLInputElement | null {
  const control = e.target instanceof HTMLFormElement
    ? e.target.elements.namedItem(name)
    : null;
  return control instanceof HTMLInputElement ? control : null;
}

export class XLoginView extends BaseView {
  static override styles = css`
    /* The document-level border-box reset doesn't pierce the shadow root;
      without this, width: 100% + padding (.auth-action-container) overflows
      the viewport horizontally on mobile. */
    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    :host {
      display: flex;
      width: 100%;
      height: 100%;
      overflow-y: auto;
      font-family: var(--font-primary);
    }

    .login-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      /* Auto margins center the card when it fits but — unlike
        align-items/justify-content centering — keep the overflow
        reachable by scrolling when the viewport is shorter than
        the card (e.g. the recovery-phrase screen on mobile). */
      margin: auto;
      padding: 1rem 0;
    }

    .auth-action-container {
      width: 100%;
      max-width: 600px;
      padding: 2rem;
      background: var(--shell-surface);
      border: var(--border-width, 2px) solid var(--border-color, #000);
    }

    .logo-container {
      display: flex;
      justify-content: center;
      margin-bottom: 2rem;
    }

    .logo {
      width: 80px;
      height: 80px;
    }

    .method-list button {
      text-align: left;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    input,
    textarea {
      width: 100%;
      padding: 0.75rem 1rem;
      margin-bottom: 0.5rem;
      font-family: var(--font-primary);
      font-size: 1rem;
      color: var(--font-color);
      border: var(--border-width, 2px) solid var(--border-color, #000);
      background: var(--shell-surface);
    }

    textarea {
      resize: none;
      min-height: 4rem;
    }

    .message {
      padding: 1rem;
      margin-bottom: 1rem;
      background-color: #f5f5f5;
    }

    .message p {
      margin: 0;
    }

    .error {
      padding: 1rem;
      margin-bottom: 1rem;
      background-color: #fee;
      border-left: 4px solid #f00;
      color: #800;
    }

    .success {
      background-color: #efe;
      border-left: 4px solid #0a0;
      color: #080;
    }

    .mnemonic-display {
      position: relative;
      margin-bottom: 1rem;
      padding: 1rem;
      background-color: #f5f5f5;
      border: var(--border-width, 2px) solid var(--border-color, #000);
    }

    [name="mnemonic-text"] {
      font-family: monospace;
      font-size: 1rem;
      line-height: 1.5;
      word-break: break-word;
    }

    .info-text {
      font-size: 0.875rem;
      color: #666;
      margin-bottom: 1rem;
    }

    h2 {
      margin: 0 0 1rem 0;
      font-size: 1.25rem;
    }

    .login-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 0.5rem;
    }

    .login-row [variant="primary"] {
      flex: 1;
      margin-bottom: 0;
    }

    .delete-button {
      width: auto;
      min-width: 3rem;
      padding: 0.75rem;
      margin-bottom: 0;
      flex-shrink: 0;
    }

    .loading {
      text-align: center;
      padding: 2rem;
    }

    .stored-credential-info {
      font-size: 0.875rem;
      color: #666;
    }
  `;

  @state()
  private accessor flow: AuthFlow | null = null;
  @state()
  private accessor method: LoginMethod | null = null;
  @state()
  private accessor error: string | null = null;
  @state()
  private accessor mnemonic: string | null = null;
  @state()
  private accessor isProcessing = false;
  @state()
  private accessor registrationSuccess = false;
  @state()
  private accessor storedCredential: StoredCredential | null =
    getStoredCredential();
  @state()
  private accessor copied = false;
  /** Why the last pairing attempt failed, shown beside the pairing form. */
  @state()
  private accessor pairingError: string | null = null;
  /** Where signing in keeps the root identity; the view waits for it. */
  @property({ attribute: false })
  accessor keyStore: Pick<KeyStore, "get" | "set"> | undefined = undefined;

  #availableMethods = availableAuthMethods(
    globalThis.location.hostname,
    globalThis.PublicKeyCredential !== undefined,
  );

  #getKeyStore(): Pick<KeyStore, "get" | "set"> {
    if (this.keyStore) {
      return this.keyStore;
    }
    throw new Error("Keystore not set.");
  }

  //
  // Signing in
  //

  /**
   * Runs `task` with the view showing its progress. Returns why `task` failed,
   * as the error's message or else as `fallback`, or `null` if it succeeded.
   */
  async #attempt(
    fallback: string,
    task: () => Promise<void>,
  ): Promise<string | null> {
    this.isProcessing = true;
    try {
      await task();
      return null;
    } catch (e) {
      console.error(`[LoginView] ${fallback}:`, e);
      return e instanceof Error ? e.message : fallback;
    } finally {
      this.isProcessing = false;
    }
  }

  /** Keeps `identity` as the root key, which signing in as it reads. */
  async #keepRootKey(identity: Identity): Promise<void> {
    await this.#getKeyStore().set(ROOT_KEY, identity);
  }

  /** Hands `identity` to the root view, which signs in as it. */
  #signIn(identity: Identity) {
    this.command({ type: "set-identity", identity });
  }

  /** Saves `credential` as the one quick unlock offers. */
  #rememberCredential(credential: StoredCredential) {
    saveCredential(credential);
    this.storedCredential = credential;
  }

  // A passkey and a saved key file have no form of their own, so a failure to
  // sign in with one leaves the error over the first screen, which the error's
  // way back then shows.

  async #registerPasskey() {
    this.error = await this.#attempt(
      "Passkey registration failed",
      async () => {
        const passkey = await PassKey.create(
          "Common Fabric User",
          "commonfabricuser",
        );
        const identity = await passkey.createRootKey();
        await this.#keepRootKey(identity);
        this.#signIn(identity);
      },
    );
    if (this.error) this.#back();
    else this.registrationSuccess = true;
  }

  async #loginWithPasskey() {
    const descriptor = getPublicKeyCredentialDescriptor(this.storedCredential);
    this.error = await this.#attempt(
      "Passkey authentication failed",
      async () => {
        const passkey = await PassKey.get({
          allowCredentials: descriptor ? [descriptor] : [],
        });
        const identity = await passkey.createRootKey();
        await this.#keepRootKey(identity);
        this.#rememberCredential(createPasskeyCredential(passkey.id()));
        this.#signIn(identity);
      },
    );
    if (this.error) this.#back();
  }

  async #generatePassphrase() {
    this.error = await this.#attempt(
      "Failed to generate passphrase",
      async () => {
        [, this.mnemonic] = await Identity.generateMnemonic();
      },
    );
  }

  async #loginWithPassphrase(mnemonic: string) {
    this.error = await this.#attempt("Invalid passphrase", async () => {
      const identity = await Identity.fromMnemonic(mnemonic);
      await this.#keepRootKey(identity);
      if (!this.storedCredential) {
        this.#rememberCredential(createPassphraseCredential());
      }
      this.#signIn(identity);
    });
  }

  async #importKeyFile(file: File) {
    this.error = await this.#attempt("Could not import key file", async () => {
      const identity = await Identity.fromPkcs8(
        new Uint8Array(await file.arrayBuffer()),
      );
      await this.#keepRootKey(identity);
      this.#rememberCredential(createKeyFileCredential(identity.did()));
      this.#signIn(identity);
    });
  }

  async #pairWithLoom(code: string, loomUrl: string) {
    this.pairingError = await this.#attempt(
      "Could not pair with Loom",
      async () => {
        const identity = await pairWithLoom({ code, loomUrl });
        await this.#keepRootKey(identity);
        rememberKeyFileCredential(identity);
        this.storedCredential = getStoredCredential();
        this.#signIn(identity);
      },
    );
  }

  /** Signs in with the saved `credential`, or asks for its passphrase. */
  async #quickUnlock(credential: StoredCredential) {
    this.method = credential.method;
    this.flow = "login";

    if (this.method === AUTH_METHOD_PASSKEY) {
      await this.#loginWithPasskey();
    } else if (this.method === AUTH_METHOD_KEYFILE) {
      this.error = await this.#attempt(
        "Could not unlock stored key file",
        async () => {
          const identity = await this.#getKeyStore().get(ROOT_KEY);
          if (!identity) {
            this.#forgetCredential();
            throw new Error(
              "Stored key file is no longer available. Please re-import it.",
            );
          }
          this.#signIn(identity);
        },
      );
      if (this.error) this.#back();
    }
  }

  #forgetCredential() {
    clearStoredCredential();
    this.storedCredential = null;
  }

  //
  // Moving between screens
  //

  /** Returns to the first screen, leaving whatever flow was under way. */
  #back = () => {
    this.flow = null;
    this.method = null;
    this.pairingError = null;
  };

  /** Chooses `method`, starting a passkey's sign-in straight away. */
  async #selectMethod(method: LoginMethod) {
    this.method = method;
    if (method !== AUTH_METHOD_PASSKEY) return;
    if (this.flow === "register") {
      await this.#registerPasskey();
    } else {
      await this.#loginWithPasskey();
    }
  }

  #handlePassphraseLogin = async (e: Event) => {
    e.preventDefault();
    const passphrase = submittedInput(e, "passphrase")?.value;
    if (passphrase) await this.#loginWithPassphrase(passphrase);
  };

  #handleKeyFileSubmit = async (e: Event) => {
    e.preventDefault();
    const file = submittedInput(e, "keyfile")?.files?.[0];
    if (!file || file.size === 0) {
      this.error = "Select a key file to import.";
      return;
    }
    await this.#importKeyFile(file);
  };

  #handleLoomPairingSubmit = async (e: Event) => {
    e.preventDefault();
    const field = (name: string) => submittedInput(e, name)?.value ?? "";
    const code = normalizePairingCode(field("pairing-code"));
    const loomUrl = normalizeLoomUrl(field("loom-url"));
    if (!code) {
      this.pairingError =
        "A pairing code is ten letters and digits, like 7KQ2M-XH4RD.";
      return;
    }
    if (!loomUrl) {
      this.pairingError = `Enter Loom's address, like ${DEFAULT_LOOM_URL}.`;
      return;
    }
    await this.#pairWithLoom(code, loomUrl);
  };

  /** Signs in with the phrase the person has just saved. */
  #handleMnemonicSaved = async () => {
    const mnemonic = this.mnemonic;
    this.mnemonic = null;
    if (mnemonic) await this.#loginWithPassphrase(mnemonic);
  };

  /** Copies `mnemonic`, and says so for two seconds once it is copied. */
  async #copyToClipboard(mnemonic: string) {
    try {
      await navigator.clipboard.writeText(mnemonic);
    } catch (e) {
      console.error("[LoginView] Could not copy the passphrase:", e);
      return;
    }
    this.copied = true;
    setTimeout(() => this.copied = false, 2000);
  }

  //
  // Rendering
  //

  #renderInitial() {
    const credential = this.storedCredential;
    if (credential) {
      const isPassphrase = credential.method === AUTH_METHOD_PASSPHRASE;
      const isPasskeyAvailable = this.#availableMethods.includes(
        AUTH_METHOD_PASSKEY,
      );
      const storedLabel = storedCredentialLabel(credential);

      return html`
        ${!isPassphrase
          ? html`
            <div class="login-row">
              <x-button
                variant="primary"
                @click="${() => this.#quickUnlock(credential)}"
              >
                🔒 Login with ${storedLabel}
              </x-button>
              <x-button
                class="delete-button"
                @click="${() => this.#forgetCredential()}"
                title="Remove saved credential"
              >
                🗑️
              </x-button>
            </div>
          `
          : html`
            <x-button
              variant="primary"
              @click="${() => this.#quickUnlock(credential)}"
            >
              🔒 Login with ${storedLabel}
            </x-button>
          `} ${isPassphrase && isPasskeyAvailable
          ? html`
            <x-button @click="${() => {
              this.flow = "login";
              return this.#selectMethod(AUTH_METHOD_PASSKEY);
            }}">
              🔑 Login w/ Passkey
            </x-button>
          `
          : !isPassphrase
          ? html`
            <x-button @click="${() => {
              this.flow = "login";
              this.method = AUTH_METHOD_PASSPHRASE;
            }}">
              🔑 Login w/ Passphrase
            </x-button>
          `
          : null}

        <x-button test-id="pair-with-loom" @click="${() => {
          this.flow = "login";
          this.method = LOOM_PAIRING;
        }}">
          🔗 Pair with Loom
        </x-button>

        <x-button test-id="register-new-key" @click="${() =>
          this.flow = "register"}">
          ➕ Register New Key
        </x-button>
      `;
    }

    return html`
      <x-button variant="primary" test-id="register-new-key" @click="${() =>
        this.flow = "register"}">
        ➕ Register
      </x-button>
      <x-button variant="primary" @click="${() => this.flow = "login"}">
        🔒 Login
      </x-button>
    `;
  }

  #renderMethodSelection(flow: AuthFlow) {
    return html`
      <h2>${flow === "login" ? "Login with" : "Register with"}</h2>
      <div class="method-list">
        ${methodsForFlow(flow, this.#availableMethods).map((method) =>
          html`
            <x-button
              test-id="${METHOD_BUTTONS[method].testId}"
              @click="${() => this.#selectMethod(method)}"
            >
              ${METHOD_BUTTONS[method].label}
            </x-button>
          `
        )}
      </div>
      <x-button @click="${this.#back}">
        ← Back
      </x-button>
    `;
  }

  #renderPassphraseAuth() {
    if (this.flow === "register") {
      return html`
        <x-button variant="primary" test-id="generate-passphrase" @click="${() =>
          this.#generatePassphrase()}">
          🔑 Generate Passphrase
        </x-button>
        <x-button @click="${this.#back}">
          ← Back
        </x-button>
      `;
    }

    return html`
      <form @submit="${this.#handlePassphraseLogin}">
        <input
          type="password"
          name="passphrase"
          placeholder="Enter your passphrase"
          autocomplete="current-password"
          required
        />
        <x-button type="submit" variant="primary">
          🔒 Login
        </x-button>
      </form>
      <x-button @click="${this.#back}">
        ← Back
      </x-button>
    `;
  }

  #renderKeyFileImport() {
    return html`
      <form @submit="${this.#handleKeyFileSubmit}">
        <input
          type="file"
          name="keyfile"
          accept=".key, .pem, text/plain, application/x-pem-file"
          required
        />
        <p class="info-text">
          Select a PKCS8/PEM key generated by the cf CLI. Importing stores this
          private key in this browser's IndexedDB.
        </p>
        <x-button type="submit" variant="primary">
          📁 Import Key
        </x-button>
      </form>
      <x-button @click="${this.#back}">
        ← Back
      </x-button>
    `;
  }

  #renderLoomPairing() {
    return html`
      <form @submit="${this.#handleLoomPairingSubmit}">
        ${this.pairingError
          ? html`
            <div class="error">${this.pairingError}</div>
          `
          : null}
        <input
          type="text"
          name="pairing-code"
          placeholder="XXXXX-XXXXX"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck="false"
          required
        />
        <input
          type="url"
          name="loom-url"
          value="${DEFAULT_LOOM_URL}"
          placeholder="${DEFAULT_LOOM_URL}"
          required
        />
        <p class="info-text">
          On the Mac that runs Loom, open Weaver Settings &gt; Pair a device (or
          run <code>loom identity pair</code>) and enter the code within ten
          minutes. This browser then holds your Loom identity in its IndexedDB.
        </p>
        <x-button type="submit" variant="primary">
          🔗 Pair
        </x-button>
      </form>
      <x-button @click="${this.#back}">
        ← Back
      </x-button>
    `;
  }

  #renderMnemonicDisplay(mnemonic: string) {
    return html`
      <div class="message success">
        <p>Your Secret Recovery Phrase:</p>
      </div>
      <div class="mnemonic-display">
        <v-box>
          <textarea rows="7" name="mnemonic-text">${mnemonic}</textarea>
          <x-button
            class="copy-button"
            @click="${() => this.#copyToClipboard(mnemonic)}"
          >
            ${this.copied ? "✓ Copied" : "📋 Copy"}
          </x-button>
        </v-box>
      </div>
      <p class="info-text">
        ⚠️ Keep this secret, it's your password.
      </p>
      <x-button
        variant="primary"
        test-id="passphrase-continue"
        @click="${this.#handleMnemonicSaved}"
      >
        🔒 I've Saved It - Continue
      </x-button>
    `;
  }

  #renderSuccess() {
    return html`
      <div class="success">
        <p>✓ ${this.method === AUTH_METHOD_PASSKEY
          ? "Passkey"
          : this.method === AUTH_METHOD_KEYFILE
          ? "Key file"
          : "Passphrase"} successfully registered!</p>
      </div>
      <x-button
        variant="primary"
        @click="${() => {
          this.registrationSuccess = false;
          this.flow = "login";
        }}"
      >
        🔒 Continue to Login
      </x-button>
    `;
  }

  override render() {
    const content = !this.keyStore
      ? html`
        <div class="loading">
          <p>Preparing secure storage...</p>
        </div>
      `
      : this.error
      ? html`
        <div class="error">
          ${this.error}
        </div>
        <x-button @click="${() => this.error = null}">
          ← Back
        </x-button>
      `
      : this.isProcessing
      ? html`
        <div class="loading">
          <p>${this.method === LOOM_PAIRING
            ? "Pairing with Loom..."
            : "Please follow the browser's prompts to continue..."}</p>
        </div>
      `
      : this.mnemonic
      ? this.#renderMnemonicDisplay(this.mnemonic)
      : this.registrationSuccess
      ? this.#renderSuccess()
      : this.flow === null
      ? this.#renderInitial()
      : this.method === null
      ? this.#renderMethodSelection(this.flow)
      : this.method === AUTH_METHOD_PASSPHRASE
      ? this.#renderPassphraseAuth()
      : this.method === AUTH_METHOD_KEYFILE
      ? this.#renderKeyFileImport()
      : this.method === LOOM_PAIRING
      ? this.#renderLoomPairing()
      : html`
        <div class="loading">
          <p>Please follow the browser's prompts to continue...</p>
        </div>
      `;

    return html`
      <div class="login-container">
        <div class="logo-container">
          <cf-logo
            background-color="black"
            shape-color="white"
            width="100"
            height="100"
          ></cf-logo>
        </div>

        <div class="auth-action-container">
          ${content}
        </div>
      </div>
    `;
  }
}

globalThis.customElements.define("x-login-view", XLoginView);
