// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import {
  CFPlaidLink,
  loadPlaidLink,
  type PlaidAuthData,
  type PlaidLink,
  type PlaidLinkConfig,
  type ScriptDocument,
} from "./index.ts";

/** One request a {@link FakeEnvironment} was sent. */
interface SentRequest {
  readonly url: string;
  readonly method?: string;
  readonly body: unknown;
}

/**
 * The network and Plaid SDK an element reaches, answering each request with
 * the next response the test queued, and recording what Link was asked.
 */
class FakeEnvironment {
  readonly sent: SentRequest[] = [];
  readonly responses: Response[] = [];
  readonly configs: PlaidLinkConfig[] = [];
  readonly opened: number[] = [];
  readonly destroyed: number[] = [];
  /** Resolves when Link is next opened. */
  linkOpened = Promise.withResolvers<void>();
  readonly plaid: PlaidLink = {
    create: (config) => {
      const handler = this.configs.push(config);
      return {
        open: () => {
          this.opened.push(handler);
          this.linkOpened.resolve();
          this.linkOpened = Promise.withResolvers<void>();
        },
        destroy: () => this.destroyed.push(handler),
      };
    },
  };
  loadPlaid: () => Promise<PlaidLink> = () => Promise.resolve(this.plaid);

  fetch = (url: string, init: RequestInit): Promise<Response> => {
    this.sent.push({
      url,
      method: init.method,
      body: JSON.parse(String(init.body)),
    });
    const response = this.responses.shift();
    return response
      ? Promise.resolve(response)
      : Promise.reject(new Error("no response queued"));
  };

  /** Queues a response of `status` carrying `body` as JSON. */
  respond(body: unknown, status = 200): void {
    this.responses.push(new Response(JSON.stringify(body), { status }));
  }
}

const AUTH_CELL_ID = JSON.stringify(createMockCellHandle({}).ref());

const AUTH: PlaidAuthData = {
  items: [{
    accessToken: "access",
    itemId: "item-1",
    institutionId: "ins_1",
    institutionName: "First Bank",
    accounts: [{
      accountId: "acc-1",
      name: "Checking",
      mask: "1234",
      type: "depository",
      subtype: "",
      balances: {
        available: 1234.5,
        current: null,
        limit: null,
        isoCurrencyCode: "EUR",
        unofficialCurrencyCode: null,
      },
    }],
    products: ["transactions"],
    consentExpirationTime: null,
    lastUpdated: "2026-01-02T03:04:05Z",
    lastSyncCursor: null,
  }],
};

/**
 * An element over `environment`, bound to `auth`, mounted and given the turn
 * its SDK load takes to show.
 */
async function plaidElement(
  environment = new FakeEnvironment(),
  auth: PlaidAuthData = AUTH,
) {
  const element = new CFPlaidLink(environment);
  element.auth = createMockCellHandle(auth);
  await mount(element);
  await element.updateComplete;
  return element;
}

const part = <T extends HTMLElement = HTMLElement>(
  element: CFPlaidLink,
  selector: string,
) => element.shadowRoot!.querySelector<T>(selector);

const connectButton = (element: CFPlaidLink) =>
  part<HTMLButtonElement>(element, ".connect-button")!;

/** What the element's status message says, or `undefined` with none. */
const status = (element: CFPlaidLink) =>
  part(element, ".status-message")?.textContent?.trim();

/** Connects through Link up to the point Link has opened. */
async function openLink(element: CFPlaidLink, environment: FakeEnvironment) {
  environment.respond({ linkToken: "link-token" });
  await element.handleConnectClick();
  await element.updateComplete;
  return environment.configs.at(-1)!;
}

describe("cf-plaid-link", () => {
  afterEach(() => document.body.replaceChildren());

  describe("loadPlaidLink()", () => {
    // A script added to the real document would be fetched from Plaid's CDN,
    // so each case hands the function a document of its own.

    /** A document of its own, and the scripts added to it, in order. */
    function scriptDocument() {
      const appended: HTMLScriptElement[] = [];
      const scripts: ScriptDocument = {
        createElement: () => document.createElement("script"),
        head: {
          appendChild: (node: Node) => {
            if (node instanceof HTMLScriptElement) appended.push(node);
          },
        },
      };
      return { document: scripts, appended };
    }

    it("returns the SDK already installed without touching the document", async () => {
      const plaid = new FakeEnvironment().plaid;
      const { document, appended } = scriptDocument();

      expect(await loadPlaidLink(document, { Plaid: plaid })).toBe(plaid);
      expect(appended.length).toBe(0);
    });

    it("adds Plaid's script and returns the SDK it installs once loaded", async () => {
      const plaid = new FakeEnvironment().plaid;
      const scope: { Plaid?: PlaidLink } = {};
      const { document, appended } = scriptDocument();

      const loaded = loadPlaidLink(document, scope);
      scope.Plaid = plaid;
      appended[0].dispatchEvent(new Event("load"));

      expect(await loaded).toBe(plaid);
      expect(appended.length).toBe(1);
      expect(appended[0].src).toBe(
        "https://cdn.plaid.com/link/v2/stable/link-initialize.js",
      );
      expect(appended[0].async).toBe(true);
    });

    it("shares one script between loads asked for while it is loading", async () => {
      const plaid = new FakeEnvironment().plaid;
      const scope: { Plaid?: PlaidLink } = {};
      const { document, appended } = scriptDocument();

      const first = loadPlaidLink(document, scope);
      const second = loadPlaidLink(document, scope);
      scope.Plaid = plaid;
      appended[0].dispatchEvent(new Event("load"));

      expect(await first).toBe(plaid);
      expect(await second).toBe(plaid);
      expect(appended.length).toBe(1);
    });

    it("rejects when the script fails to load", async () => {
      const { document, appended } = scriptDocument();

      const waiting = loadPlaidLink(document, {});
      appended[0].dispatchEvent(new Event("error"));

      await expect(waiting).rejects.toThrow("Failed to load Plaid Link script");
      expect(appended.length).toBe(1);
    });

    it("adds the script afresh after a failed load, and returns the SDK it installs", async () => {
      const plaid = new FakeEnvironment().plaid;
      const scope: { Plaid?: PlaidLink } = {};
      const { document, appended } = scriptDocument();
      const failed = loadPlaidLink(document, scope);
      appended[0].dispatchEvent(new Event("error"));
      await expect(failed).rejects.toThrow("Failed to load Plaid Link script");

      const retried = loadPlaidLink(document, scope);
      scope.Plaid = plaid;
      appended[1].dispatchEvent(new Event("load"));

      expect(await retried).toBe(plaid);
      expect(appended.length).toBe(2);
    });
  });

  describe("CFPlaidLink", () => {
    it("is registered as `cf-plaid-link`", () => {
      expect(customElements.get("cf-plaid-link")).toBe(CFPlaidLink);
    });

    describe("loading the SDK", () => {
      it("shows a disabled loading button until the SDK loads", async () => {
        const environment = new FakeEnvironment();
        environment.loadPlaid = () => new Promise(() => {});

        const element = await plaidElement(environment);

        expect(connectButton(element).textContent?.trim()).toBe(
          "Loading Plaid...",
        );
        expect(connectButton(element).disabled).toBe(true);
      });

      it("shows an enabled connect button once the SDK loads", async () => {
        const element = await plaidElement();

        expect(connectButton(element).textContent?.trim()).toBe(
          "Connect Bank Account",
        );
        expect(connectButton(element).disabled).toBe(false);
      });

      it("uses the SDK the page already installed by default", async () => {
        const previous = globalThis.Plaid;
        globalThis.Plaid = new FakeEnvironment().plaid;
        try {
          const element = new CFPlaidLink();
          await mount(element);
          await element.updateComplete;

          expect(connectButton(element).disabled).toBe(false);
        } finally {
          globalThis.Plaid = previous;
        }
      });

      it("shows that the SDK failed to load", async () => {
        const environment = new FakeEnvironment();
        environment.loadPlaid = () => Promise.reject(new Error("offline"));

        const element = await plaidElement(environment);

        expect(status(element)).toBe(
          "Failed to load Plaid Link. Please refresh and try again.",
        );
        expect(connectButton(element).disabled).toBe(true);
      });
    });

    describe("connecting", () => {
      it("sends nothing and says to wait when asked before the SDK loads", async () => {
        const environment = new FakeEnvironment();
        environment.loadPlaid = () => new Promise(() => {});
        const element = await plaidElement(environment);

        await element.handleConnectClick();
        await element.updateComplete;

        expect(environment.sent).toEqual([]);
        expect(status(element)).toBe(
          "Plaid Link is still loading, please wait...",
        );
      });

      it("asks for a link token and opens Link with it on a click", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        element.products = ["transactions", "auth"];
        environment.respond({ linkToken: "link-token" });

        connectButton(element).click();
        await element.updateComplete;
        expect(status(element)).toBe("Creating link session...");
        expect(connectButton(element).textContent?.trim()).toBe(
          "Processing...",
        );
        expect(connectButton(element).disabled).toBe(true);
        await environment.linkOpened.promise;

        expect(environment.sent).toEqual([{
          url: "/api/integrations/plaid-oauth/create-link-token",
          method: "POST",
          body: {
            authCellId: AUTH_CELL_ID,
            products: ["transactions", "auth"],
          },
        }]);
        expect(environment.configs.map((config) => config.token)).toEqual([
          "link-token",
        ]);
        expect(environment.opened).toEqual([1]);
      });

      it("closes the Link it opened before opening another", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);

        await openLink(element, environment);
        expect(environment.destroyed).toEqual([]);
        await openLink(element, environment);

        expect(environment.destroyed).toEqual([1]);
        expect(environment.opened).toEqual([1, 2]);
      });

      it("closes the Link it opened when disconnected", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        await openLink(element, environment);

        element.remove();
        document.body.append(element);
        element.remove();

        expect(environment.destroyed).toEqual([1]);
      });

      it("shows the server's failure and opens nothing", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        environment.respond({}, 500);

        await element.handleConnectClick();
        await element.updateComplete;

        expect(status(element)).toBe("Error: HTTP error! status: 500");
        expect(connectButton(element).disabled).toBe(false);
        expect(environment.configs).toEqual([]);
      });

      it("shows that no link token came back and opens nothing", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        environment.respond({});

        await element.handleConnectClick();
        await element.updateComplete;

        expect(status(element)).toBe(
          "Error: No link token received from server",
        );
        expect(environment.configs).toEqual([]);
      });
    });

    describe("Link's callbacks", () => {
      for (
        const [event, metadata, shown] of [
          ["OPEN", {}, "Link opened..."],
          [
            "SELECT_INSTITUTION",
            { institution_name: "First Bank" },
            "Connecting to First Bank...",
          ],
          ["SELECT_INSTITUTION", {}, "Connecting to bank..."],
          ["SUBMIT_CREDENTIALS", {}, "Verifying credentials..."],
          ["TRANSITION_VIEW", {}, "Creating link session..."],
        ] as const
      ) {
        it(`shows "${shown}" on Link's \`${event}\` event`, async () => {
          const environment = new FakeEnvironment();
          const element = await plaidElement(environment);
          const config = await openLink(element, environment);

          config.onEvent(event, metadata);
          await element.updateComplete;

          expect(status(element)).toBe(shown);
        });
      }

      for (
        const [error, shown] of [
          [{ error_message: "bad creds" }, "Authentication failed: bad creds"],
          [
            { display_message: "try later" },
            "Authentication failed: try later",
          ],
          [{}, "Authentication failed: Unknown error"],
          [null, "Authentication cancelled"],
        ] as const
      ) {
        it(`shows "${shown}" when Link exits`, async () => {
          const environment = new FakeEnvironment();
          const element = await plaidElement(environment);
          const config = await openLink(element, environment);

          config.onExit(error, {});
          await element.updateComplete;

          expect(status(element)).toBe(shown);
          expect(connectButton(element).disabled).toBe(false);
        });
      }

      it("exchanges the public token Link succeeds with", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        const config = await openLink(element, environment);
        environment.respond({ ok: true });

        await config.onSuccess("public-token", {});
        await element.updateComplete;

        expect(environment.sent.at(-1)).toEqual({
          url: "/api/integrations/plaid-oauth/exchange-token",
          method: "POST",
          body: { publicToken: "public-token", authCellId: AUTH_CELL_ID },
        });
        expect(status(element)).toBe("Bank account connected successfully!");
        expect(connectButton(element).disabled).toBe(false);
      });

      it("shows the exchange's failure", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        const config = await openLink(element, environment);
        environment.respond({}, 502);

        const exchanged = config.onSuccess("public-token", {});
        await element.updateComplete;
        expect(status(element)).toBe("Exchanging token...");
        await exchanged;
        await element.updateComplete;

        expect(status(element)).toBe("Error: HTTP error! status: 502");
        expect(connectButton(element).disabled).toBe(false);
      });
    });

    describe("connected accounts", () => {
      it("shows each connected bank and its accounts", async () => {
        const element = await plaidElement();

        const text = (selector: string) =>
          part(element, selector)?.textContent?.trim();
        expect(text(".connected-accounts h3")).toBe("Connected Bank Accounts");
        expect(text(".bank-header h4")).toBe("First Bank");
        expect(text(".account-name")).toBe("Checking");
        expect(text(".account-mask")).toBe("****1234");
        expect(text(".account-type")).toBe("depository");
        expect(
          [...element.shadowRoot!.querySelectorAll(".balance-amount")].map(
            (amount) => amount.textContent?.trim(),
          ),
        ).toEqual(["€1,234.50", "N/A"]);
        expect(text(".last-updated")).toBe(
          `Last updated: ${new Date("2026-01-02T03:04:05Z").toLocaleString()}`,
        );
      });

      it("shows no connected banks when the cell holds none", async () => {
        const element = await plaidElement(new FakeEnvironment(), {
          items: [],
        });

        expect(part(element, ".connected-accounts")).toBeNull();
      });

      it("formats an amount without a currency as dollars", () => {
        const element = new CFPlaidLink(new FakeEnvironment());

        expect(element.formatCurrency(12, null)).toBe("$12.00");
      });

      it("asks to remove a bank on its remove button's click", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        environment.respond({});

        part(element, ".remove-button")!.click();
        await element.updateComplete;

        expect(status(element)).toBe("Removing bank connection...");
        expect(
          part<HTMLButtonElement>(element, ".remove-button")!.disabled,
        ).toBe(true);
        expect(environment.sent).toEqual([{
          url: "/api/integrations/plaid-oauth/remove-item",
          method: "POST",
          body: { authCellId: AUTH_CELL_ID, itemId: "item-1" },
        }]);
      });

      it("shows that the bank was removed", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        environment.respond({});

        await element.handleRemoveAccount("item-1");
        await element.updateComplete;

        expect(status(element)).toBe("Bank connection removed successfully");
        expect(
          part<HTMLButtonElement>(element, ".remove-button")!.disabled,
        ).toBe(false);
      });

      it("shows the removal's failure", async () => {
        const environment = new FakeEnvironment();
        const element = await plaidElement(environment);
        environment.respond({}, 404);

        await element.handleRemoveAccount("item-1");
        await element.updateComplete;

        expect(status(element)).toBe("Error: HTTP error! status: 404");
        expect(
          part<HTMLButtonElement>(element, ".remove-button")!.disabled,
        ).toBe(false);
      });
    });
  });
});
