// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFOAuth, type OAuthData, type OAuthWindow } from "./index.ts";

const ORIGIN = "https://app.test";

/**
 * A window that answers each request with the next response the test queued,
 * opens a popup the test can close, and runs a timer only when the test ticks
 * it.
 */
class FakeWindow implements OAuthWindow {
  readonly location = { origin: ORIGIN };
  readonly sent: { url: string; method?: string; body: unknown }[] = [];
  readonly responses: Response[] = [];
  readonly opened: string[][] = [];
  readonly listeners = new Set<(event: MessageEvent) => void>();
  readonly timers = new Map<number, { handler: () => void; timeout: number }>();
  popup: { closed: boolean } | null = { closed: false };
  /** Resolves when a popup is next asked for. */
  popupOpened = Promise.withResolvers<void>();
  #nextTimer = 1;

  fetch(url: string, init: RequestInit): Promise<Response> {
    this.sent.push({
      url,
      method: init.method,
      body: JSON.parse(String(init.body)),
    });
    const response = this.responses.shift();
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error("no response queued"));
  }

  open(url: string, target: string, features: string) {
    this.opened.push([url, target, features]);
    this.popupOpened.resolve();
    this.popupOpened = Promise.withResolvers<void>();
    return this.popup;
  }

  addEventListener(_type: "message", listener: (event: MessageEvent) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent) => void,
  ) {
    this.listeners.delete(listener);
  }

  setInterval(handler: () => void, timeout: number): number {
    const id = this.#nextTimer++;
    this.timers.set(id, { handler, timeout });
    return id;
  }

  clearInterval(id: number): void {
    this.timers.delete(id);
  }

  /** Queues a response of `status` carrying `body` as JSON. */
  respond(body: unknown, status = 200): void {
    this.responses.push(new Response(JSON.stringify(body), { status }));
  }

  /** Delivers a message from `origin` to every listener. */
  post(data: unknown, origin = ORIGIN): void {
    for (const listener of [...this.listeners]) {
      listener(new MessageEvent("message", { data, origin }));
    }
  }

  /** Runs every timer once. */
  tick(): void {
    for (const { handler } of [...this.timers.values()]) handler();
  }
}

const AUTH_CELL_ID = JSON.stringify(createMockCellHandle({}).ref());

/** A mounted element over `window`, bound to a cell holding `auth`. */
function oauthElement(
  window = new FakeWindow(),
  auth?: OAuthData,
  properties: Partial<CFOAuth> = {},
) {
  const element = Object.assign(new CFOAuth(window), {
    auth: createMockCellHandle(auth),
    loginEndpoint: "/api/integrations/test-oauth/login",
    ...properties,
  });
  return mount(element);
}

const part = <T extends HTMLElement = HTMLElement>(
  element: CFOAuth,
  selector: string,
) => element.shadowRoot!.querySelector<T>(selector);

const button = (element: CFOAuth) =>
  part<HTMLButtonElement>(element, "button.oauth-button")!;

/** The text of the element's part matching `selector`, if it shows one. */
const text = (element: CFOAuth, selector: string) =>
  part(element, selector)?.textContent?.trim();

/** Starts signing in and waits until the popup is open. */
async function signIn(element: CFOAuth, window: FakeWindow) {
  window.respond({ url: "https://provider.test/authorize" });
  await element.handleClick();
  await element.updateComplete;
}

/** Delivers a message, and waits for what the element shows to update. */
async function post(
  element: CFOAuth,
  window: FakeWindow,
  data: unknown,
  origin?: string,
) {
  window.post(data, origin);
  await element.updateComplete;
}

describe("CFOAuth", () => {
  afterEach(() => document.body.replaceChildren());

  it("is registered as `cf-oauth`", () => {
    expect(customElements.get("cf-oauth")).toBe(CFOAuth);
  });

  describe("rendering", () => {
    it("shows an authenticate button in the brand color when signed out", async () => {
      const element = await oauthElement(new FakeWindow(), {}, {
        providerLabel: "Airtable",
        brandColor: "#ff0000",
      });

      expect(button(element).textContent?.trim()).toBe(
        "Authenticate with Airtable",
      );
      expect(button(element).style.backgroundColor).toBe("#ff0000");
      expect(button(element).classList.contains("logout")).toBe(false);
      expect(part(element, ".user-info")).toBeNull();
      expect(part(element, ".status-message")).toBeNull();
    });

    it("shows the user and a logout button when the cell holds a token", async () => {
      const element = await oauthElement(new FakeWindow(), {
        accessToken: "token",
        user: { email: "a@b.test", name: "Ada", picture: "https://p.test/a" },
      });

      expect(part(element, "img.profile-picture")?.getAttribute("src")).toBe(
        "https://p.test/a",
      );
      expect(text(element, ".user-name")).toBe("Ada");
      expect(text(element, ".user-email")).toBe("a@b.test");
      expect(button(element).textContent?.trim()).toBe("Logout");
      expect(button(element).classList.contains("logout")).toBe(true);
    });

    it("shows the email as the name, and no picture, when the user has neither", async () => {
      const element = await oauthElement(new FakeWindow(), {
        accessToken: "token",
        user: { email: "a@b.test", name: "", picture: "" },
      });

      expect(part(element, "img")).toBeNull();
      expect(text(element, ".user-name")).toBe("a@b.test");
    });

    it("reads the token from the field it is told to", async () => {
      const element = await oauthElement(new FakeWindow(), {
        accessToken: "token",
        user: { email: "a@b.test", name: "Ada", picture: "" },
      }, { tokenField: "token" });

      expect(button(element).textContent?.trim()).toBe(
        "Authenticate with OAuth",
      );
      expect(part(element, ".user-info")).toBeNull();
    });

    it("shows a signed-out button while the cell holds nothing", async () => {
      const element = await oauthElement();

      expect(button(element).textContent?.trim()).toBe(
        "Authenticate with OAuth",
      );
    });
  });

  describe("signing in", () => {
    it("asks the login endpoint for a URL and opens it in a popup on a click", async () => {
      const window = new FakeWindow();
      const element = await oauthElement(window, {}, {
        scopes: ["read", "write"],
      });
      window.respond({ url: "https://provider.test/authorize" });

      button(element).click();
      await element.updateComplete;
      expect(text(element, ".status-message")).toBe(
        "Initiating OAuth flow...",
      );
      expect(button(element).textContent?.trim()).toBe("Processing...");
      expect(button(element).disabled).toBe(true);
      await window.popupOpened.promise;
      await element.updateComplete;

      expect(window.sent).toEqual([{
        url: "/api/integrations/test-oauth/login",
        method: "POST",
        body: { authCellId: AUTH_CELL_ID, scopes: ["read", "write"] },
      }]);
      expect(window.opened).toEqual([[
        "https://provider.test/authorize",
        "_blank",
        "width=800,height=800,left=200,top=200",
      ]]);
      expect(text(element, ".status-message")).toBe("Opening OAuth window...");
      expect(window.listeners.size).toBe(1);
      expect([...window.timers.values()].map((timer) => timer.timeout))
        .toEqual([500]);
    });

    it("sends nothing when asked again while signing in", async () => {
      const window = new FakeWindow();
      const element = await oauthElement(window);
      await signIn(element, window);

      await element.handleClick();

      expect(window.sent.length).toBe(1);
      expect(window.opened.length).toBe(1);
    });

    it("shows the endpoint's failure and opens nothing", async () => {
      const window = new FakeWindow();
      const element = await oauthElement(window);
      window.respond({}, 500);

      await element.handleClick();
      await element.updateComplete;

      expect(text(element, ".status-message")).toBe(
        "Error: HTTP error! status: 500",
      );
      expect(window.opened).toEqual([]);
      expect(button(element).disabled).toBe(false);
    });

    it("shows that the popup was blocked and stops listening", async () => {
      const window = new FakeWindow();
      window.popup = null;
      const element = await oauthElement(window);

      await signIn(element, window);

      expect(text(element, ".status-message")).toBe(
        "Popup blocked by browser. Please allow popups and try again.",
      );
      expect(window.listeners.size).toBe(0);
      expect(window.timers.size).toBe(0);
      expect(button(element).disabled).toBe(false);
    });
  });

  describe("the popup's answer", () => {
    it("shows success and stops listening on the popup's callback", async () => {
      const window = new FakeWindow();
      const element = await oauthElement(window);
      await signIn(element, window);

      await post(element, window, {
        type: "oauth-callback",
        result: { success: true },
      });

      expect(text(element, ".status-message")).toBe(
        "Authentication successful!",
      );
      expect(element.authResult).toEqual({ success: true });
      expect(window.listeners.size).toBe(0);
      expect(window.timers.size).toBe(0);
      expect(button(element).disabled).toBe(false);
    });

    for (
      const [result, shown] of [
        [
          { success: false, error: "access_denied" },
          "Authentication failed: access_denied",
        ],
        [{ success: false }, "Authentication failed: Unknown error"],
      ] as const
    ) {
      it(`shows "${shown}" on a failed callback`, async () => {
        const window = new FakeWindow();
        const element = await oauthElement(window);
        await signIn(element, window);

        await post(element, window, { type: "oauth-callback", result });

        expect(text(element, ".status-message")).toBe(shown);
      });
    }

    it("ignores a message from another origin, and one that is not the callback", async () => {
      const window = new FakeWindow();
      const element = await oauthElement(window);
      await signIn(element, window);

      await post(element, window, {
        type: "oauth-callback",
        result: { success: true },
      }, "https://evil.test");
      await post(element, window, { type: "something-else" });
      await post(element, window, null);

      expect(text(element, ".status-message")).toBe("Opening OAuth window...");
      expect(element.authResult).toBeNull();
      expect(window.listeners.size).toBe(1);
    });

    it("shows that the popup closed without an answer, and stops watching it", async () => {
      const window = new FakeWindow();
      const element = await oauthElement(window);
      await signIn(element, window);

      window.tick();
      await element.updateComplete;
      expect(text(element, ".status-message")).toBe("Opening OAuth window...");
      expect(window.timers.size).toBe(1);

      window.popup!.closed = true;
      window.tick();
      await element.updateComplete;

      expect(text(element, ".status-message")).toBe(
        "OAuth window closed. Authentication may not have completed.",
      );
      expect(window.timers.size).toBe(0);
      expect(window.listeners.size).toBe(0);
      expect(button(element).disabled).toBe(false);
    });

    it("stops listening and watching when disconnected", async () => {
      const window = new FakeWindow();
      const element = await oauthElement(window);
      await signIn(element, window);

      element.remove();

      expect(window.listeners.size).toBe(0);
      expect(window.timers.size).toBe(0);
    });
  });

  describe("signing out", () => {
    it("writes empty credentials under the token field on a logout click", async () => {
      const element = await oauthElement(new FakeWindow(), {
        token: "token",
        user: { email: "a@b.test", name: "Ada", picture: "" },
      }, { tokenField: "token" });
      expect(button(element).textContent?.trim()).toBe("Logout");

      button(element).click();

      expect(writesSent(element.auth)).toEqual([
        expect.objectContaining({
          type: "cell:set",
          value: {
            token: "",
            tokenType: "",
            scope: [],
            expiresIn: 0,
            expiresAt: 0,
            refreshToken: "",
            user: { email: "", name: "", picture: "" },
          },
        }),
      ]);
    });

    it("shows the authenticate button once signed out", async () => {
      const element = await oauthElement(new FakeWindow(), {
        accessToken: "token",
        user: { email: "a@b.test", name: "Ada", picture: "" },
      });

      await element.handleLogout();
      await element.updateComplete;

      expect(button(element).textContent?.trim()).toBe(
        "Authenticate with OAuth",
      );
      expect(part(element, ".user-info")).toBeNull();
    });
  });
});
