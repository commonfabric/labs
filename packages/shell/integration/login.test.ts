import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { env, waitForCondition } from "@commonfabric/integration";

import { ShellIntegration } from "../../integration/shell-utils.ts";
import { clickPierce, pierce } from "./shadow-dom.ts";

const { FRONTEND_URL } = env;

describe("shell login tests", () => {
  // Tests the manual logging in via passphrase. Other tests should use the
  // `shell.login(identity)` utility to directly provide an identity.

  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("waits for key store before showing login controls", async () => {
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: "common-knowledge" },
    });

    const result = await page.evaluate(async () => {
      await customElements.whenDefined("x-login-view");

      const login = document.createElement("x-login-view") as HTMLElement & {
        keyStore?: unknown;
        updateComplete: Promise<unknown>;
      };
      document.body.append(login);
      await login.updateComplete;

      const snapshot = () => {
        const root = login.shadowRoot;
        return {
          hasLoading: root?.textContent?.includes(
            "Preparing secure storage...",
          ) ?? false,
          hasRegister: !!root?.querySelector('[test-id="register-new-key"]'),
        };
      };

      const beforeKeyStore = snapshot();
      login.keyStore = {
        get: () => Promise.resolve(undefined),
        set: () => Promise.resolve(undefined),
        clear: () => Promise.resolve(undefined),
      };
      await login.updateComplete;
      const afterKeyStore = snapshot();
      login.remove();

      return { beforeKeyStore, afterKeyStore };
    });

    assert(result.beforeKeyStore.hasLoading);
    assert(!result.beforeKeyStore.hasRegister);
    assert(!result.afterKeyStore.hasLoading);
    assert(result.afterKeyStore.hasRegister);
  });

  it("logs in while the app is still unpublished", async () => {
    // The shell publishes `globalThis.app` at the end of its bootstrap, after
    // the key store opens and Navigation is installed, so a driver that
    // navigates or reloads and logs in straight away can arrive before the app
    // is published. The property installed below is that window with the timing
    // taken out of it: the first read of `globalThis.app` returns `undefined`,
    // and announces publication in the next microtask. Every later read returns
    // the root element.

    const identity = await Identity.generate({ implementation: "noble" });
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: "common-knowledge" },
    });

    await page.evaluate(() => {
      let published: unknown = globalThis.app;
      let unread = true;
      Object.defineProperty(globalThis, "app", {
        configurable: true,
        get() {
          if (!unread) return published;
          unread = false;
          queueMicrotask(() => {
            globalThis.dispatchEvent(new Event("cf-shell-ready"));
          });
          return undefined;
        },
        set(value: unknown) {
          published = value;
        },
      });
    });

    await shell.login(identity);

    const state = await shell.state();
    assertEquals(state?.identityDid, identity.did());
  });

  it("can create a new user via passphrase", async () => {
    const page = shell.page();
    const spaceName = "common-knowledge";

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName },
    });

    const state = await shell.state();
    assert(state);
    assert(
      (state.view as { spaceName: string }).spaceName === "common-knowledge",
    );

    await clickPierce(page, '[test-id="register-new-key"]');
    await pierce(page, '[test-id="use-passphrase"]');

    await clickPierce(page, '[test-id="use-passphrase"]');
    await pierce(page, '[test-id="generate-passphrase"]');

    await clickPierce(page, '[test-id="generate-passphrase"]');
    await pierce(page, '[test-id="passphrase-continue"]');

    await clickPierce(page, '[test-id="passphrase-continue"]');

    await waitForCondition(
      page,
      (probe, name) =>
        probe.collect(".header-space").some((el) =>
          probe.deepText(el).trim() === name
        ),
      { args: [spaceName] },
    );
  });
});
