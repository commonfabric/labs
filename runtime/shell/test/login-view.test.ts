// deno-lint-ignore-file cf-imports/no-inline-module-import -- the view's module
// graph reaches @commonfabric/ui, whose components extend a bare HTMLElement as
// they load, so it can only load once the test has installed one.

import { encodeBase64 } from "@std/encoding/base64";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { Identity } from "@commonfabric/identity";

import {
  AUTH_METHOD_KEYFILE,
  AUTH_METHOD_PASSKEY,
  AUTH_METHOD_PASSPHRASE,
  type StoredCredential,
} from "../src/lib/credentials.ts";
import type { Command } from "../src/views/BaseView.ts";
import type { XLoginView } from "../src/views/LoginView.ts";
import { installBrowserGlobals } from "./browser-globals.ts";
import { templateListenerOn, templateMarkup } from "./lit-template-markup.ts";

/** The key a stand-in authenticator's PRF output turns into. */
const PASSKEY_SEED = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

/** A saved passkey's id, base64url for the bytes 1, 2, 3, 4. */
const SAVED_PASSKEY_ID = "AQIDBA";

/** A view under test, and what it has done to the world around it. */
interface Mounted {
  view: XLoginView;
  /** What the key store holds, by name. */
  keys: Map<string, Identity>;
  /** The DIDs the view asked the root view to sign in as. */
  signedIn: string[];
}

/** What `navigator.credentials` was asked, and how it answered. */
interface Authenticator {
  creates: CredentialCreationOptions[];
  gets: CredentialRequestOptions[];
}

/** What an input of a submitted form holds. */
type Field = { value?: string; files?: File[] };

/** An input of a submitted form, standing in for `HTMLInputElement`. */
class StandInInput {
  readonly value: string;
  readonly files: File[];

  constructor({ value = "", files = [] }: Field) {
    this.value = value;
    this.files = files;
  }
}

/** A submitted form, standing in for `HTMLFormElement`. */
class StandInForm {
  /** The form's controls, by name. */
  readonly elements: { namedItem(name: string): unknown };

  constructor(controls: Record<string, unknown>) {
    this.elements = { namedItem: (name) => controls[name] ?? null };
  }
}

describe("LoginView", () => {
  let LoginView: typeof XLoginView;
  let storage: Map<string, string>;
  const restores: (() => void)[] = [];

  /** Installs `value` as the global `name` until the case ends. */
  function setGlobal(name: string, value: unknown): void {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
    restores.push(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }

  /** Starts the case on a page at `href`, with nothing saved. */
  async function openPage(href: string): Promise<void> {
    restores.push(installBrowserGlobals(href));
    setGlobal("HTMLFormElement", StandInForm);
    setGlobal("HTMLInputElement", StandInInput);
    storage = new Map();
    setGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    ({ XLoginView: LoginView } = await import("../src/views/LoginView.ts"));
  }

  /**
   * Moves the page to a host where passkeys are offered, with an
   * authenticator whose passkeys yield `PASSKEY_SEED`. `fail`, when given,
   * is what the authenticator rejects with instead.
   */
  async function withPasskeys(fail?: unknown): Promise<Authenticator> {
    await openPage("https://shell.test/");
    setGlobal("PublicKeyCredential", class {});
    const authenticator: Authenticator = { creates: [], gets: [] };
    const credential = (prf: object) => ({
      id: "bmV3LXBhc3NrZXk",
      getClientExtensionResults: () => ({ prf }),
    });
    Object.defineProperty(navigator, "credentials", {
      value: {
        create: (options: CredentialCreationOptions) => {
          authenticator.creates.push(options);
          return fail === undefined
            ? Promise.resolve(credential({
              enabled: true,
              results: { first: PASSKEY_SEED },
            }))
            : Promise.reject(fail);
        },
        get: (options: CredentialRequestOptions) => {
          authenticator.gets.push(options);
          return fail === undefined
            ? Promise.resolve(credential({ results: { first: PASSKEY_SEED } }))
            : Promise.reject(fail);
        },
      },
    });
    return authenticator;
  }

  /**
   * Builds a view as the app would, with `saved` as the credential this
   * browser remembers and `rootKey` in its key store.
   */
  function mount(
    { saved, rootKey }: { saved?: StoredCredential; rootKey?: Identity } = {},
  ): Mounted {
    if (saved) storage.set("storedCredential", JSON.stringify(saved));
    const keys = new Map<string, Identity>();
    if (rootKey) keys.set("$ROOT_KEY", rootKey);
    const view = new LoginView();
    view.keyStore = {
      get: (name) => Promise.resolve(keys.get(name)),
      set: (name, identity) => {
        keys.set(name, identity);
        return Promise.resolve(undefined);
      },
    };
    const signedIn: string[] = [];
    view.addEventListener("shell-command", (e) => {
      const command: Command = (e as CustomEvent<Command>).detail;
      if (command.type === "set-identity") {
        signedIn.push(command.identity?.did() ?? "");
      }
    });
    return { view, keys, signedIn };
  }

  function markup(view: XLoginView): string {
    return templateMarkup(view.render());
  }

  /** Clicks the button holding `text`, and waits for what it starts. */
  async function click(view: XLoginView, text: string): Promise<void> {
    await templateListenerOn(view.render(), "click", view, "x-button", text)(
      new Event("click"),
    );
  }

  /** The inputs of a form, by name. */
  type Fields = Record<string, Field>;

  /** A submit event from `form`. */
  function submitEventFrom(form: StandInForm): Event {
    const event = new Event("submit", { cancelable: true });
    Object.defineProperty(event, "target", { value: form });
    return event;
  }

  /** A submit event from a form whose inputs are `fields`. */
  function submitEvent(fields: Fields): Event {
    return submitEventFrom(
      new StandInForm(
        Object.fromEntries(
          Object.entries(fields).map(([name, field]) => [
            name,
            new StandInInput(field),
          ]),
        ),
      ),
    );
  }

  /**
   * Submits the form holding `text`, its inputs holding `fields`, and waits
   * for what that starts.
   */
  async function submit(
    view: XLoginView,
    text: string,
    fields: Fields,
  ): Promise<void> {
    const event = submitEvent(fields);
    await templateListenerOn(view.render(), "submit", view, "form", text)(
      event,
    );
    expect(event.defaultPrevented).toBe(true);
  }

  /** The DID the person whose recovery phrase is `mnemonic` signs in as. */
  async function didOfPhrase(mnemonic: string): Promise<string> {
    return (await Identity.fromMnemonic(mnemonic)).did();
  }

  function savedCredential(): StoredCredential | null {
    return JSON.parse(storage.get("storedCredential") ?? "null");
  }

  afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
  });

  describe("on localhost", () => {
    beforeEach(() => openPage("http://localhost:8000/common-knowledge"));

    describe("render()", () => {
      it("shows only a wait for storage until the key store arrives", () => {
        const { view } = mount();
        view.keyStore = undefined;

        const shown = markup(view);

        expect(shown).toContain("Preparing secure storage...");
        expect(shown).not.toContain('test-id="register-new-key"');
      });

      it("offers registering and logging in when nothing is saved", () => {
        const shown = markup(mount().view);

        expect(shown).toContain("➕ Register");
        expect(shown).toContain("🔒 Login");
        expect(shown).not.toContain("Login with");
        expect(shown).not.toContain("Pair with Loom");
      });

      it("names a saved key file by the end of its DID, and offers a passphrase instead", () => {
        const shown = markup(
          mount({
            saved: { id: "did:key:z6MkABCDEFGH", method: AUTH_METHOD_KEYFILE },
          }).view,
        );

        expect(shown).toContain("Login with Imported Key (ABCDEFGH)");
        expect(shown).toContain("Login w/ Passphrase");
        expect(shown).toContain('title="Remove saved credential"');
      });

      it("offers no other method beside a saved passphrase where passkeys are not offered", () => {
        const shown = markup(
          mount({ saved: { id: "tag", method: AUTH_METHOD_PASSPHRASE } }).view,
        );

        expect(shown).toContain("Login with Passphrase");
        expect(shown).not.toContain("Login w/ Passkey");
        expect(shown).not.toContain("Login w/ Passphrase");
        expect(shown).not.toContain('title="Remove saved credential"');
      });

      it("lists no passkey among the methods on `localhost`", async () => {
        const { view } = mount();
        await click(view, "➕ Register");

        const shown = markup(view);

        expect(shown).toContain("Register with");
        expect(shown).toContain('test-id="use-passphrase"');
        expect(shown).toContain('test-id="import-cli-key"');
        expect(shown).not.toContain('test-id="use-passkey"');
        expect(shown).not.toContain('test-id="pair-with-loom"');
      });
    });

    describe("registering with a passphrase", () => {
      it("signs in with the generated phrase once the person has saved it", async () => {
        const { view, keys, signedIn } = mount();
        await click(view, "➕ Register");
        await click(view, "📝 Use Passphrase");
        await click(view, "🔑 Generate Passphrase");

        const shown = markup(view);
        expect(shown).toContain("Your Secret Recovery Phrase:");
        const mnemonic = /name="mnemonic-text">([^<]*)</.exec(shown)![1];
        expect(mnemonic.split(" ").length).toBeGreaterThanOrEqual(12);
        expect(signedIn).toEqual([]);

        await click(view, "I've Saved It - Continue");

        const did = await didOfPhrase(mnemonic);
        expect(signedIn).toEqual([did]);
        expect(keys.get("$ROOT_KEY")?.did()).toBe(did);
        expect(savedCredential()?.method).toBe(AUTH_METHOD_PASSPHRASE);
        expect(markup(view)).not.toContain("Your Secret Recovery Phrase:");
      });

      it("copies the phrase, and says so for two seconds", async () => {
        using time = new FakeTime();
        const copied: string[] = [];
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: (text: string) => {
              copied.push(text);
              return Promise.resolve();
            },
          },
        });
        const { view } = mount();
        await click(view, "➕ Register");
        await click(view, "📝 Use Passphrase");
        await click(view, "🔑 Generate Passphrase");
        const mnemonic = /name="mnemonic-text">([^<]*)</.exec(markup(view))![1];

        await click(view, "📋 Copy");

        expect(copied).toEqual([mnemonic]);
        expect(markup(view)).toContain("✓ Copied");
        time.tick(1999);
        expect(markup(view)).toContain("✓ Copied");
        time.tick(1);
        expect(markup(view)).toContain("📋 Copy");
        expect(markup(view)).not.toContain("✓ Copied");
      });

      it("says nothing was copied when the clipboard refuses the phrase", async () => {
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: () => Promise.reject(new Error("Not allowed.")),
          },
        });
        const { view } = mount();
        await click(view, "➕ Register");
        await click(view, "📝 Use Passphrase");
        await click(view, "🔑 Generate Passphrase");

        await click(view, "📋 Copy");

        expect(markup(view)).toContain("📋 Copy");
        expect(markup(view)).not.toContain("✓ Copied");
      });
    });

    describe("logging in with a passphrase", () => {
      it("signs in as the phrase's identity, and saves that a passphrase was used", async () => {
        const [identity, mnemonic] = await Identity.generateMnemonic();
        const { view, keys, signedIn } = mount();
        await click(view, "🔒 Login");
        await click(view, "📝 Use Passphrase");

        await submit(view, 'name="passphrase"', {
          passphrase: { value: mnemonic },
        });

        expect(signedIn).toEqual([identity.did()]);
        expect(keys.get("$ROOT_KEY")?.did()).toBe(identity.did());
        expect(savedCredential()?.method).toBe(AUTH_METHOD_PASSPHRASE);
      });

      it("keeps a credential that was already saved", async () => {
        const [identity, mnemonic] = await Identity.generateMnemonic();
        const saved = { id: "did:key:z6MkSaved", method: AUTH_METHOD_KEYFILE };
        const { view, signedIn } = mount({ saved });
        await click(view, "Login w/ Passphrase");

        await submit(view, 'name="passphrase"', {
          passphrase: { value: mnemonic },
        });

        expect(signedIn).toEqual([identity.did()]);
        expect(savedCredential()).toEqual(saved);
      });

      it("asks for the phrase of a saved passphrase credential", async () => {
        const { view, signedIn } = mount({
          saved: { id: "tag", method: AUTH_METHOD_PASSPHRASE },
        });

        await click(view, "Login with Passphrase");

        expect(markup(view)).toContain('name="passphrase"');
        expect(signedIn).toEqual([]);
      });

      it("does nothing for an empty passphrase", async () => {
        const { view, keys, signedIn } = mount();
        await click(view, "🔒 Login");
        await click(view, "📝 Use Passphrase");

        await submit(view, 'name="passphrase"', { passphrase: { value: "" } });

        expect(signedIn).toEqual([]);
        expect(keys.size).toBe(0);
        expect(markup(view)).toContain('name="passphrase"');
      });

      it("shows why a phrase did not sign in", async () => {
        const { view, keys, signedIn } = mount();
        await click(view, "🔒 Login");
        await click(view, "📝 Use Passphrase");

        await submit(view, 'name="passphrase"', {
          passphrase: { value: "not a recovery phrase" },
        });

        expect(signedIn).toEqual([]);
        expect(keys.size).toBe(0);
        expect(savedCredential()).toBe(null);
        expect(markup(view)).toContain('<div class="error">');
        expect(markup(view)).not.toContain('name="passphrase"');

        await click(view, "← Back");

        expect(markup(view)).not.toContain('<div class="error">');
        expect(markup(view)).toContain('name="passphrase"');
      });

      it("shows progress until the key is stored", async () => {
        const [identity, mnemonic] = await Identity.generateMnemonic();
        const { view, signedIn } = mount();
        const storing = Promise.withResolvers<void>();
        const stored = Promise.withResolvers<undefined>();
        view.keyStore = {
          get: () => Promise.resolve(undefined),
          set: () => {
            storing.resolve();
            return stored.promise;
          },
        };
        await click(view, "🔒 Login");
        await click(view, "📝 Use Passphrase");

        const submitted = submit(view, 'name="passphrase"', {
          passphrase: { value: mnemonic },
        });
        await storing.promise;

        expect(markup(view)).toContain(
          "Please follow the browser's prompts to continue...",
        );
        expect(signedIn).toEqual([]);

        stored.resolve(undefined);
        await submitted;

        expect(signedIn).toEqual([identity.did()]);
        expect(markup(view)).not.toContain("Please follow the browser's");
      });

      it("shows an error rather than signing in when the key store has gone", async () => {
        const [, mnemonic] = await Identity.generateMnemonic();
        const { view, signedIn } = mount();
        const keyStore = view.keyStore;
        await click(view, "🔒 Login");
        await click(view, "📝 Use Passphrase");
        const submitPassphrase = templateListenerOn(
          view.render(),
          "submit",
          view,
          "form",
          'name="passphrase"',
        );

        view.keyStore = undefined;
        await submitPassphrase(
          submitEvent({ passphrase: { value: mnemonic } }),
        );
        view.keyStore = keyStore;

        expect(signedIn).toEqual([]);
        expect(markup(view)).toContain("Keystore not set.");

        await click(view, "← Back");

        expect(markup(view)).toContain('name="passphrase"');
      });
    });

    describe("importing a key file", () => {
      it("signs in as the file's key, and saves it as a key-file credential", async () => {
        const pkcs8 = await Identity.generatePkcs8();
        const did = (await Identity.fromPkcs8(pkcs8)).did();
        const { view, keys, signedIn } = mount();
        await click(view, "🔒 Login");
        await click(view, "📁 Import CLI Key");

        await submit(view, 'name="keyfile"', {
          keyfile: { files: [new File([new Uint8Array(pkcs8)], "me.key")] },
        });

        expect(signedIn).toEqual([did]);
        expect(keys.get("$ROOT_KEY")?.did()).toBe(did);
        expect(savedCredential()).toEqual({
          id: did,
          method: AUTH_METHOD_KEYFILE,
        });
      });

      it("asks for a file when none is chosen, or the one chosen is empty", async () => {
        for (const files of [[], [new File([], "empty.key")]]) {
          const { view, signedIn } = mount();
          await click(view, "🔒 Login");
          await click(view, "📁 Import CLI Key");

          await submit(view, 'name="keyfile"', { keyfile: { files } });

          expect(signedIn).toEqual([]);
          expect(markup(view)).toContain("Select a key file to import.");
          expect(markup(view)).not.toContain('name="keyfile"');

          await click(view, "← Back");

          expect(markup(view)).not.toContain('<div class="error">');
          expect(markup(view)).toContain('name="keyfile"');
        }
      });

      it("asks for a file when the form holds no single file input of that name", async () => {
        const { view, signedIn } = mount();
        await click(view, "🔒 Login");
        await click(view, "📁 Import CLI Key");
        const submitKeyFile = templateListenerOn(
          view.render(),
          "submit",
          view,
          "form",
          'name="keyfile"',
        );

        // Two controls named alike are a list, not an input.
        await submitKeyFile(
          submitEventFrom(new StandInForm({ keyfile: [new StandInInput({})] })),
        );

        expect(signedIn).toEqual([]);
        expect(markup(view)).toContain("Select a key file to import.");
      });

      it("shows why a file did not import", async () => {
        const { view, keys, signedIn } = mount();
        await click(view, "🔒 Login");
        await click(view, "📁 Import CLI Key");

        await submit(view, 'name="keyfile"', {
          keyfile: { files: [new File(["not a key"], "me.key")] },
        });

        expect(signedIn).toEqual([]);
        expect(keys.size).toBe(0);
        expect(savedCredential()).toBe(null);
        expect(markup(view)).toContain('<div class="error">');

        await click(view, "← Back");

        expect(markup(view)).toContain('name="keyfile"');
      });
    });

    describe("unlocking a saved key file", () => {
      const saved = { id: "did:key:z6MkSaved", method: AUTH_METHOD_KEYFILE };

      it("signs in as the key the key store holds", async () => {
        const rootKey = await Identity.generate();
        const { view, signedIn } = mount({ saved, rootKey });

        await click(view, "Login with Imported Key");

        expect(signedIn).toEqual([rootKey.did()]);
        expect(markup(view)).not.toContain('<div class="error">');
      });

      it("forgets the credential, and says to import the file again, when the key store has lost the key", async () => {
        const { view, signedIn } = mount({ saved });

        await click(view, "Login with Imported Key");

        expect(signedIn).toEqual([]);
        expect(savedCredential()).toBe(null);
        expect(markup(view)).toContain(
          "Stored key file is no longer available. Please re-import it.",
        );

        await click(view, "← Back");

        expect(markup(view)).toBe(markup(mount().view));
        expect(markup(view)).toContain("➕ Register");
      });

      it("shows why the key store could not be read", async () => {
        const { view, signedIn } = mount({ saved });
        view.keyStore = {
          get: () => Promise.reject(new Error("The database is closed.")),
          set: () => Promise.resolve(undefined),
        };

        await click(view, "Login with Imported Key");

        expect(signedIn).toEqual([]);
        expect(savedCredential()).toEqual(saved);
        expect(markup(view)).toContain("The database is closed.");

        await click(view, "← Back");

        expect(markup(view)).toContain("Login with Imported Key");
      });

      it("forgets the credential when asked to", async () => {
        const { view, signedIn } = mount({ saved });

        await click(view, 'title="Remove saved credential"');

        expect(signedIn).toEqual([]);
        expect(savedCredential()).toBe(null);
        expect(markup(view)).not.toContain("Login with Imported Key");
        expect(markup(view)).toContain("➕ Register");
      });
    });

    describe("moving between screens", () => {
      // Each route reaches a screen with a way back, by the labels clicked.
      const routes: Record<string, string[]> = {
        "registration's methods": ["➕ Register"],
        "login's methods": ["🔒 Login"],
        "passphrase generation": ["➕ Register", "📝 Use Passphrase"],
        "the passphrase form": ["🔒 Login", "📝 Use Passphrase"],
        "the key-file form": ["🔒 Login", "📁 Import CLI Key"],
        "the pairing form": ["🔒 Login", "🔗 Pair with Loom"],
      };

      for (const [screen, labels] of Object.entries(routes)) {
        it(`returns from ${screen} to the first screen`, async () => {
          const { view } = mount();
          const first = markup(view);
          for (const label of labels) await click(view, label);
          expect(markup(view)).not.toBe(first);

          await click(view, "← Back");

          expect(markup(view)).toBe(first);
        });
      }
    });

    describe("pairing with a Loom", () => {
      /**
       * Installs a `fetch` that returns `response` and records request
       * bodies.
       */
      function withLoom(response: () => Response): string[] {
        const requests: string[] = [];
        setGlobal("fetch", (_url: unknown, init?: RequestInit) => {
          requests.push(String(init?.body ?? ""));
          return Promise.resolve(response());
        });
        return requests;
      }

      it("signs in as the identity a pairing code redeems", async () => {
        const pkcs8 = await Identity.generatePkcs8();
        const did = (await Identity.fromPkcs8(pkcs8)).did();
        const requests = withLoom(() =>
          new Response(
            JSON.stringify({ pkcs8Base64: encodeBase64(pkcs8), did }),
          )
        );
        const { view, keys, signedIn } = mount();
        await click(view, "🔒 Login");
        await click(view, "🔗 Pair with Loom");
        expect(markup(view)).toContain("http://localhost:9900");

        await submit(view, 'name="pairing-code"', {
          "pairing-code": { value: "7kq2m xh4rd" },
          "loom-url": { value: "http://127.0.0.1:9950/" },
        });

        expect(JSON.parse(requests[0]).code).toBe("7KQ2MXH4RD");
        expect(keys.get("$ROOT_KEY")?.did()).toBe(did);
        expect(signedIn).toEqual([did]);
        expect(savedCredential()).toEqual({
          id: did,
          method: AUTH_METHOD_KEYFILE,
        });
      });

      it("opens the pairing form from a saved credential", async () => {
        const { view } = mount({
          saved: { id: "did:key:z6Mkstored", method: AUTH_METHOD_KEYFILE },
        });

        await click(view, "🔗 Pair with Loom");

        expect(markup(view)).toContain('name="pairing-code"');
      });

      it("shows progress while the code is redeemed", async () => {
        const responded = Promise.withResolvers<Response>();
        const requested = Promise.withResolvers<void>();
        setGlobal("fetch", () => {
          requested.resolve();
          return responded.promise;
        });
        const { view } = mount();
        await click(view, "🔒 Login");
        await click(view, "🔗 Pair with Loom");

        const submitted = submit(view, 'name="pairing-code"', {
          "pairing-code": { value: "7KQ2M-XH4RD" },
          "loom-url": { value: "http://127.0.0.1:9950" },
        });
        await requested.promise;

        expect(markup(view)).toContain("Pairing with Loom...");

        responded.resolve(new Response("{}", { status: 403 }));
        await submitted;

        expect(markup(view)).not.toContain("Pairing with Loom...");
      });

      it("shows why a code did not sign in, and drops that on the way back", async () => {
        const requests = withLoom(() =>
          new Response(JSON.stringify({ hint: "Make a new code." }), {
            status: 403,
          })
        );
        const { view, keys } = mount();
        await click(view, "🔒 Login");
        await click(view, "🔗 Pair with Loom");
        const loomUrl = "http://127.0.0.1:9950";

        await submit(view, 'name="pairing-code"', {
          "pairing-code": { value: "nope" },
          "loom-url": { value: loomUrl },
        });
        expect(markup(view)).toContain("ten letters");

        await submit(view, 'name="pairing-code"', {
          "pairing-code": { value: "7KQ2M-XH4RD" },
          "loom-url": { value: "ftp://x" },
        });
        expect(markup(view)).toContain("Loom's address");
        expect(requests).toEqual([]);

        await submit(view, 'name="pairing-code"', {
          "pairing-code": { value: "7KQ2M-XH4RD" },
          "loom-url": { value: loomUrl },
        });
        expect(markup(view)).toContain("Make a new code.");
        expect(keys.size).toBe(0);

        await click(view, "← Back");
        await click(view, "🔒 Login");
        await click(view, "🔗 Pair with Loom");
        expect(markup(view)).not.toContain("Make a new code.");
      });
    });
  });

  describe("where passkeys are offered", () => {
    it("registers a passkey and signs in with the key it yields", async () => {
      const authenticator = await withPasskeys();
      const did = (await Identity.fromRaw(PASSKEY_SEED)).did();
      const { view, keys, signedIn } = mount();
      await click(view, "➕ Register");

      await click(view, "🔑 Use Passkey");

      expect(authenticator.creates.length).toBe(1);
      expect(signedIn).toEqual([did]);
      expect(keys.get("$ROOT_KEY")?.did()).toBe(did);
      expect(savedCredential()).toBe(null);
      expect(markup(view)).toContain("✓ Passkey successfully registered!");

      await click(view, "🔒 Continue to Login");

      expect(markup(view)).not.toContain("successfully registered!");
    });

    it("shows why the authenticator could not register a passkey", async () => {
      await withPasskeys(new Error("The operation was aborted."));
      const { view, keys, signedIn } = mount();
      await click(view, "➕ Register");

      await click(view, "🔑 Use Passkey");

      expect(signedIn).toEqual([]);
      expect(keys.size).toBe(0);
      expect(markup(view)).toContain("The operation was aborted.");

      await click(view, "← Back");

      expect(markup(view)).toBe(markup(mount().view));
    });

    it("logs in with any passkey, and saves the one used", async () => {
      const authenticator = await withPasskeys();
      const did = (await Identity.fromRaw(PASSKEY_SEED)).did();
      const { view, keys, signedIn } = mount();
      await click(view, "🔒 Login");

      await click(view, "🔑 Use Passkey");

      expect(authenticator.gets[0].publicKey?.allowCredentials).toEqual([]);
      expect(signedIn).toEqual([did]);
      expect(keys.get("$ROOT_KEY")?.did()).toBe(did);
      expect(savedCredential()).toEqual({
        id: "bmV3LXBhc3NrZXk",
        method: AUTH_METHOD_PASSKEY,
      });
    });

    it("unlocks with only the saved passkey", async () => {
      const authenticator = await withPasskeys();
      const did = (await Identity.fromRaw(PASSKEY_SEED)).did();
      const { view, signedIn } = mount({
        saved: { id: SAVED_PASSKEY_ID, method: AUTH_METHOD_PASSKEY },
      });

      await click(view, "Login with Passkey (IDBA)");

      expect(authenticator.gets[0].publicKey?.allowCredentials).toEqual([
        { id: new Uint8Array([1, 2, 3, 4]), type: "public-key" },
      ]);
      expect(signedIn).toEqual([did]);
    });

    it("offers a passkey beside a saved passphrase", async () => {
      const authenticator = await withPasskeys();
      const did = (await Identity.fromRaw(PASSKEY_SEED)).did();
      const { view, signedIn } = mount({
        saved: { id: "tag", method: AUTH_METHOD_PASSPHRASE },
      });

      await click(view, "Login w/ Passkey");

      expect(authenticator.gets.length).toBe(1);
      expect(signedIn).toEqual([did]);
    });

    it("shows a generic failure when the authenticator rejects with something other than an error", async () => {
      await withPasskeys("NotAllowed");
      const { view, signedIn } = mount();
      await click(view, "🔒 Login");

      await click(view, "🔑 Use Passkey");

      expect(signedIn).toEqual([]);
      expect(savedCredential()).toBe(null);
      expect(markup(view)).toContain("Passkey authentication failed");

      await click(view, "← Back");

      expect(markup(view)).toBe(markup(mount().view));
    });

    it("leads back to the first screen after a saved passkey fails to unlock", async () => {
      await withPasskeys(new Error("The operation was aborted."));
      const { view } = mount({
        saved: { id: SAVED_PASSKEY_ID, method: AUTH_METHOD_PASSKEY },
      });
      const first = markup(view);

      await click(view, "Login with Passkey (IDBA)");
      expect(markup(view)).toContain("The operation was aborted.");

      await click(view, "← Back");

      expect(markup(view)).toBe(first);
    });
  });
});
