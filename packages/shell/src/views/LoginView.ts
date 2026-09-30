import { css, html } from "lit";
import { property, state } from "lit/decorators.js";

import { Identity, KeyStore, PassKey } from "@commonfabric/identity";

import { BaseView } from "./BaseView.ts";
import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
  type AuthMethod,
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

/**
 * Signing in with a code from a Loom. A login method, but not a stored
 * credential: the key it brings is stored as a key-file credential.
 */
const LOOM_PAIRING = "loom-pairing" as const;

type LoginMethod = AuthMethod | typeof LOOM_PAIRING;

// Internal auth events for LoginView
type AuthEventType =
  | "passkey-register"
  | "passkey-authenticate"
  | "passphrase-generate"
  | "passphrase-authenticate"
  | "clear-stored-credential";

interface AuthEventDetail {
  type: AuthEventType;
  data?: {
    descriptor?: PublicKeyCredentialDescriptor;
  } | {
    mnemonic?: string;
  };
}

const AUTH_EVENT = "auth-event";

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
  @property({ attribute: false })
  private accessor keyStore: KeyStore | undefined = undefined;

  #availableMethods: AuthMethod[] = [];

  override connectedCallback() {
    super.connectedCallback();
    this.#checkAvailableMethods();
    this.addEventListener(AUTH_EVENT, this.#onAuthEvent as EventListener);
  }

  override disconnectedCallback() {
    this.removeEventListener(AUTH_EVENT, this.#onAuthEvent as EventListener);
    super.disconnectedCallback();
  }

  #checkAvailableMethods() {
    const methods: AuthMethod[] = [];

    // Check if passkeys are available (not on localhost, WebAuthn available)
    const isPasskeyAvailable = globalThis.location.hostname !== "localhost" &&
      globalThis.PublicKeyCredential !== undefined;

    if (isPasskeyAvailable) {
      methods.push(AUTH_METHOD_PASSKEY);
    }

    // Passphrase and key files are always available.
    methods.push(AUTH_METHOD_PASSPHRASE);
    methods.push(AUTH_METHOD_KEYFILE);

    this.#availableMethods = methods;

    // If only one method available, pre-select it
    if (methods.length === 1) {
      this.method = methods[0];
    }
  }

  #getKeyStore(): KeyStore {
    if (this.keyStore) {
      return this.keyStore;
    }
    throw new Error("Keystore not set.");
  }

  #dispatchAuthEvent(
    type: AuthEventType,
    data?: { mnemonic?: string } | {
      descriptor?: PublicKeyCredentialDescriptor;
    },
  ) {
    this.dispatchEvent(
      new CustomEvent(AUTH_EVENT, {
        detail: { type, data },
        bubbles: false, // Don't bubble up - auth events are internal
        composed: false,
      }),
    );
  }

  #onAuthEvent = async (event: Event) => {
    const e = event as CustomEvent<AuthEventDetail>;
    e.stopPropagation(); // Ensure event doesn't bubble up

    const { type, data } = e.detail;
    const descriptor = data && "descriptor" in data
      ? data.descriptor
      : undefined;
    try {
      switch (type) {
        case "passkey-register":
          await this.#handlePasskeyRegister();
          break;
        case "passkey-authenticate":
          await this.#handlePasskeyAuthenticate(descriptor);
          break;
        case "passphrase-generate":
          await this.#handlePassphraseGenerate();
          break;
        case "passphrase-authenticate":
          if (!data || !("mnemonic" in data) || !data.mnemonic) {
            throw new Error("Invalid mnemonic.");
          }
          await this.#handlePassphraseAuthenticate(data.mnemonic);
          break;
        case "clear-stored-credential":
          this.#handleClearStoredCredential();
          break;
      }
    } catch (error) {
      console.error("[LoginView] Auth event error:", error);
      this.error = error instanceof Error
        ? error.message
        : "Authentication failed";
    }
  };

  //
  // Auth event handlers
  //

  async #handlePasskeyRegister() {
    this.isProcessing = true;
    this.error = null;

    try {
      const passkey = await PassKey.create(
        "Common Fabric User",
        "commonfabricuser",
      );
      const identity = await passkey.createRootKey();

      // Save identity to keyStore
      const keyStore = this.#getKeyStore();
      if (keyStore) {
        await keyStore.set(ROOT_KEY, identity);
      }

      // Send identity to root
      this.command({ type: "set-identity", identity });
      this.registrationSuccess = true;
    } catch (e) {
      console.error("[LoginView] Passkey register error:", e);
      this.error = e instanceof Error
        ? e.message
        : "Passkey registration failed";
      this.flow = null;
      this.method = null;
    } finally {
      this.isProcessing = false;
    }
  }

  async #handlePasskeyAuthenticate(
    descriptor?: PublicKeyCredentialDescriptor,
  ) {
    this.isProcessing = true;
    this.error = null;

    try {
      const passkey = await PassKey.get({
        allowCredentials: descriptor ? [descriptor] : [],
      });
      const identity = await passkey.createRootKey();

      // Save identity to keyStore
      const keyStore = this.#getKeyStore();
      if (keyStore) {
        await keyStore.set(ROOT_KEY, identity);
      }

      // Store credential info for future logins
      const credential = createPasskeyCredential(passkey.id());
      saveCredential(credential);
      this.storedCredential = credential;

      // Send identity to root
      this.command({ type: "set-identity", identity });
    } catch (e) {
      console.error("[LoginView] Passkey authenticate error:", e);
      this.error = e instanceof Error
        ? e.message
        : "Passkey authentication failed";
    } finally {
      this.isProcessing = false;
    }
  }

  async #handlePassphraseGenerate() {
    this.isProcessing = true;
    this.error = null;

    try {
      const [, mnemonic] = await Identity.generateMnemonic();
      this.mnemonic = mnemonic;
    } catch (e) {
      console.error("[LoginView] Passphrase generate error:", e);
      this.error = e instanceof Error
        ? e.message
        : "Failed to generate passphrase";
    } finally {
      this.isProcessing = false;
    }
  }

  async #handlePassphraseAuthenticate(mnemonic: string) {
    this.isProcessing = true;
    this.error = null;

    try {
      const identity = await Identity.fromMnemonic(mnemonic);

      // Save identity to keyStore
      const keyStore = this.#getKeyStore();
      if (keyStore) {
        await keyStore.set(ROOT_KEY, identity);
      }

      // Store credential indicator if not already stored
      if (!this.storedCredential) {
        const credential = createPassphraseCredential();
        saveCredential(credential);
        this.storedCredential = credential;
      }

      // Send identity to root
      this.command({ type: "set-identity", identity });
    } catch (e) {
      console.error("[LoginView] Passphrase authenticate error:", e);
      this.error = e instanceof Error ? e.message : "Invalid passphrase";
    } finally {
      this.isProcessing = false;
    }
  }

  async #handleKeyFileImport(file: File) {
    this.isProcessing = true;
    this.error = null;

    try {
      const identity = await Identity.fromPkcs8(
        new Uint8Array(await file.arrayBuffer()),
      );

      const keyStore = this.#getKeyStore();
      if (keyStore) {
        await keyStore.set(ROOT_KEY, identity);
      }

      const credential = createKeyFileCredential(identity.did());
      saveCredential(credential);
      this.storedCredential = credential;

      this.command({ type: "set-identity", identity });
    } catch (e) {
      console.error("[LoginView] Key file import error:", e);
      this.error = e instanceof Error ? e.message : "Could not import key file";
    } finally {
      this.isProcessing = false;
    }
  }

  async #handleLoomPairing(code: string, loomUrl: string) {
    this.isProcessing = true;
    this.pairingError = null;

    try {
      const identity = await pairWithLoom({ code, loomUrl });

      const keyStore = this.#getKeyStore();
      if (keyStore) {
        await keyStore.set(ROOT_KEY, identity);
      }

      rememberKeyFileCredential(identity);
      this.storedCredential = getStoredCredential();

      this.command({ type: "set-identity", identity });
    } catch (e) {
      console.error("[LoginView] Loom pairing error:", e);
      this.pairingError = e instanceof Error
        ? e.message
        : "Could not pair with Loom";
    } finally {
      this.isProcessing = false;
    }
  }

  #handleClearStoredCredential() {
    clearStoredCredential();
    this.storedCredential = null;
  }

  #handleRegister() {
    if (this.method === AUTH_METHOD_PASSKEY) {
      this.#dispatchAuthEvent("passkey-register");
    } else if (this.method === AUTH_METHOD_PASSPHRASE) {
      this.#dispatchAuthEvent("passphrase-generate");
    }
  }

  #handleLogin(passphrase?: string) {
    console.log("[LoginView] Handling login:", {
      method: this.method,
      hasPassphrase: !!passphrase,
      hasStoredCredential: !!this.storedCredential,
    });

    if (this.method === AUTH_METHOD_PASSKEY) {
      const descriptor = getPublicKeyCredentialDescriptor(
        this.storedCredential,
      );
      this.#dispatchAuthEvent("passkey-authenticate", { descriptor });
    } else if (passphrase) {
      this.#dispatchAuthEvent("passphrase-authenticate", {
        mnemonic: passphrase,
      });
    }
  }

  async #copyToClipboard() {
    if (this.mnemonic) {
      await navigator.clipboard.writeText(this.mnemonic);
      this.copied = true;
      setTimeout(() => this.copied = false, 2000);
    }
  }

  #renderInitial() {
    if (this.storedCredential) {
      const isPassphrase =
        this.storedCredential.method === AUTH_METHOD_PASSPHRASE;
      const isKeyFile = this.storedCredential.method === AUTH_METHOD_KEYFILE;
      const isPasskeyAvailable = this.#availableMethods.includes(
        AUTH_METHOD_PASSKEY,
      );
      const storedLabel = isPassphrase
        ? "Passphrase"
        : isKeyFile
        ? `Imported Key (${this.storedCredential.id.slice(-8)})`
        : `Passkey (${this.storedCredential.id.slice(-4)})`;

      return html`
        ${!isPassphrase
          ? html`
            <div class="login-row">
              <x-button
                variant="primary"
                @click="${() => this.#handleQuickUnlock()}"
              >
                🔒 Login with ${storedLabel}
              </x-button>
              <x-button
                class="delete-button"
                @click="${() => {
                  this.#dispatchAuthEvent("clear-stored-credential");
                }}"
                title="Remove saved credential"
              >
                🗑️
              </x-button>
            </div>
          `
          : html`
            <x-button
              variant="primary"
              @click="${() => this.#handleQuickUnlock()}"
            >
              🔒 Login with ${storedLabel}
            </x-button>
          `} ${isPassphrase && isPasskeyAvailable
          ? html`
            <x-button @click="${() => {
              this.flow = "login";
              this.method = AUTH_METHOD_PASSKEY;
              this.#handleLogin();
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

  async #handleQuickUnlock() {
    if (!this.storedCredential) return;

    this.method = this.storedCredential.method;
    this.flow = "login";

    if (this.storedCredential.method === AUTH_METHOD_PASSKEY) {
      this.#handleLogin();
    } else if (this.storedCredential.method === AUTH_METHOD_KEYFILE) {
      this.isProcessing = true;
      this.error = null;

      try {
        const identity = await this.#getKeyStore().get(ROOT_KEY);
        if (!identity) {
          this.#handleClearStoredCredential();
          this.flow = null;
          this.method = null;
          this.error =
            "Stored key file is no longer available. Please re-import it.";
          return;
        }

        this.command({ type: "set-identity", identity });
      } catch (e) {
        console.error("[LoginView] Key file unlock error:", e);
        this.error = e instanceof Error
          ? e.message
          : "Could not unlock stored key file";
      } finally {
        this.isProcessing = false;
      }
    }
  }

  #renderMethodSelection() {
    // Pairing signs in as an identity that already exists, so it is offered
    // for login and not for registration.
    const methods: LoginMethod[] = this.flow === "login"
      ? [...this.#availableMethods, LOOM_PAIRING]
      : this.#availableMethods;
    return html`
      <h2>${this.flow === "login" ? "Login with" : "Register with"}</h2>
      <div class="method-list">
        ${methods.map((method) =>
          html`
            <x-button
              test-id="${method === AUTH_METHOD_PASSKEY
                ? "use-passkey"
                : method === AUTH_METHOD_PASSPHRASE
                ? "use-passphrase"
                : method === LOOM_PAIRING
                ? "pair-with-loom"
                : "import-cli-key"}"
              @click="${() => this.#handleMethodSelect(method)}"
            >
              ${method === AUTH_METHOD_PASSKEY
                ? "🔑 Use Passkey"
                : method === AUTH_METHOD_PASSPHRASE
                ? "📝 Use Passphrase"
                : method === LOOM_PAIRING
                ? "🔗 Pair with Loom"
                : "📁 Import CLI Key"}
            </x-button>
          `
        )}
      </div>
      <x-button @click="${() => {
        this.flow = null;
        this.method = null;
      }}">
        ← Back
      </x-button>
    `;
  }

  #handleMethodSelect(method: LoginMethod) {
    this.method = method;
    if (method === AUTH_METHOD_KEYFILE || method === LOOM_PAIRING) {
      return;
    }
    if (this.flow === "register" && method === AUTH_METHOD_PASSKEY) {
      this.#handleRegister();
    } else if (this.flow === "login" && method === AUTH_METHOD_PASSKEY) {
      this.#handleLogin();
    }
  }

  #renderPassphraseAuth() {
    if (this.flow === "register") {
      if (this.mnemonic) {
        return this.#renderMnemonicDisplay();
      }
      return html`
        <x-button variant="primary" test-id="generate-passphrase" @click="${() =>
          this.#handleRegister()}">
          🔑 Generate Passphrase
        </x-button>
        <x-button @click="${() => {
          this.flow = null;
          this.method = null;
        }}">
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
      <x-button @click="${() => {
        this.flow = null;
        this.method = null;
      }}">
        ← Back
      </x-button>
    `;
  }

  #handlePassphraseLogin = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const formData = new FormData(form);
    const passphrase = formData.get("passphrase") as string;
    this.#handleLogin(passphrase);
  };

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
      <x-button @click="${() => {
        this.flow = null;
        this.method = null;
      }}">
        ← Back
      </x-button>
    `;
  }

  #handleKeyFileSubmit = (e: Event) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const file = new FormData(form).get("keyfile");
    if (!(file instanceof File) || file.size === 0) {
      this.error = "Select a key file to import.";
      return;
    }
    void this.#handleKeyFileImport(file);
  };

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
      <x-button @click="${() => {
        this.flow = null;
        this.method = null;
        this.pairingError = null;
      }}">
        ← Back
      </x-button>
    `;
  }

  #handleLoomPairingSubmit = async (e: Event) => {
    e.preventDefault();
    const fields = (e.target as HTMLFormElement).elements;
    const field = (name: string) =>
      (fields.namedItem(name) as HTMLInputElement | null)?.value ?? "";
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
    await this.#handleLoomPairing(code, loomUrl);
  };

  #renderMnemonicDisplay() {
    return html`
      <div class="message success">
        <p>Your Secret Recovery Phrase:</p>
      </div>
      <div class="mnemonic-display">
        <v-box>
          <textarea rows="7" name="mnemonic-text">${this.mnemonic ||
            ""}</textarea>
          <x-button
            class="copy-button"
            @click="${this.#copyToClipboard}"
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
        @click="${() => {
          // User has saved the mnemonic, now authenticate with it
          if (this.mnemonic) {
            this.#handleLogin(this.mnemonic);
          }
          this.mnemonic = null;
        }}"
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
      ? this.#renderMnemonicDisplay()
      : this.registrationSuccess
      ? this.#renderSuccess()
      : this.flow === null
      ? this.#renderInitial()
      : this.method === null
      ? this.#renderMethodSelection()
      : this.method === AUTH_METHOD_PASSPHRASE
      ? this.#renderPassphraseAuth()
      : this.method === AUTH_METHOD_KEYFILE
      ? this.#renderKeyFileImport()
      : this.method === LOOM_PAIRING
      ? this.#renderLoomPairing()
      : this.method === AUTH_METHOD_PASSKEY
      ? html`
        <div class="loading">
          <p>Please follow the browser's prompts to continue...</p>
        </div>
      `
      : "";

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
