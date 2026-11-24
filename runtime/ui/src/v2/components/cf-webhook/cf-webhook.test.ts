/**
 * A webhook whose configuration the worker refuses is shown as withheld, not
 * as a webhook that was never made: offering to create one in its place would
 * replace a configuration that may exist.
 */

// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  countSubscriptions,
  createMockCellHandle,
  holdReads,
  pushRefusal,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFWebhook, type WebhookConfig } from "./index.ts";

describe("cf-webhook", () => {
  it("offers to create a webhook where none is configured", () => {
    const element = new CFWebhook();
    element.config = createMockCellHandle<WebhookConfig | null>(null);

    const html = JSON.stringify(element.render());

    expect(html).toContain("Create Webhook");
  });

  it("offers nothing to create while the worker has not answered for the configuration", () => {
    const element = new CFWebhook();
    element.config = createMockCellHandle<WebhookConfig | null>();

    const html = JSON.stringify(element.render());

    expect(html).not.toContain("Create Webhook");
  });

  it("shows a configuration the worker refuses as withheld, with nothing to create", () => {
    const element = new CFWebhook();
    const config = createMockCellHandle<WebhookConfig | null>({
      url: "https://example.invalid/api/webhooks/1",
      secret: "a secret",
    });
    element.config = config;
    pushRefusal(config);

    const html = JSON.stringify(element.render());

    expect(html).toContain("Content hidden by policy");
    expect(html).not.toContain("Create Webhook");
    expect(html).not.toContain("a secret");
  });

  describe("mounted", () => {
    const CONFIG: WebhookConfig = {
      url: "https://example.invalid/api/webhooks/wh_1",
      secret: "token-abcd",
    };

    let time: FakeTime;
    let fetched: Array<{ url: string; init?: RequestInit }>;
    let respond: (url: string) => Promise<Response>;
    let fetchStub: Stub;

    beforeEach(() => {
      time = new FakeTime();
      fetched = [];
      respond = () => Promise.resolve(Response.json({}));
      fetchStub = stub(
        globalThis,
        "fetch",
        (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          fetched.push({ url, init });
          return respond(url);
        },
      );
    });

    afterEach(() => {
      document.body.replaceChildren();
      fetchStub.restore();
      time.restore();
    });

    /** A webhook named `name`, with the inbox and configuration given. */
    async function webhookWith(
      config: CellHandle<WebhookConfig | null> | undefined,
      name = "Push events",
      inbox: CellHandle<unknown> | null = createMockCellHandle<unknown>(
        undefined,
        { id: "of:inbox", space: "did:key:space" },
      ),
    ) {
      const element = new CFWebhook();
      element.name = name;
      if (inbox) element.inbox = inbox;
      if (config) element.config = config;
      return await mount(element);
    }

    /** Waits for a request the element sent to be answered and shown. */
    async function answered(element: CFWebhook) {
      await time.runMicrotasks();
      await element.updateComplete;
    }

    const text = (element: CFWebhook) =>
      element.shadowRoot!.textContent!.replace(/\s+/g, " ").trim();

    const alert = (element: CFWebhook) =>
      element.shadowRoot!.querySelector('[role="alert"]')?.textContent
        ?.trim();

    const button = (element: CFWebhook) =>
      element.shadowRoot!.querySelector<HTMLElement>("cf-button")!;

    describe("render()", () => {
      it("shows a configured webhook's name, its URL and token masked, and a Delete button", async () => {
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(CONFIG),
        );
        expect(element.shadowRoot!.querySelector(".name")?.textContent).toBe(
          "Push events",
        );
        const viewers = [
          ...element.shadowRoot!.querySelectorAll("cf-secret-viewer"),
        ];
        expect(viewers.map((viewer) => viewer.getAttribute("label"))).toEqual(
          ["Webhook URL", "Bearer Token"],
        );
        expect(viewers.map((viewer) => Reflect.get(viewer, "value"))).toEqual(
          [CONFIG.url, CONFIG.secret],
        );
        expect(
          viewers.map((viewer) => viewer.getAttribute("trailing-chars")),
        ).toEqual(["8", "4"]);
        expect(button(element).textContent?.trim()).toBe("Delete");
      });

      it("offers to create a webhook whose configuration lacks a secret", async () => {
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>({
            url: CONFIG.url,
            secret: "",
          }),
        );
        expect(text(element)).toBe("Create Webhook");
      });

      it("follows the configuration as it changes", async () => {
        const config = createMockCellHandle<WebhookConfig | null>(null);
        const element = await webhookWith(config);
        pushUpdate(config, CONFIG);
        await element.updateComplete;
        expect(button(element).textContent?.trim()).toBe("Delete");
      });

      it("shows a configuration it could not read as such, with nothing to create, and reads it again on Retry", async () => {
        const config = createMockCellHandle<WebhookConfig | null>();
        const answer = holdReads(config);
        const element = await webhookWith(config);
        answer(new Error("the connection dropped the read"));
        await answered(element);

        expect(alert(element)).toBe(
          "The webhook configuration could not be read.",
        );
        expect(text(element)).not.toContain("Create Webhook");

        button(element).click();
        await answered(element);
        // The read again found the cell holding nothing: a webhook to create.
        expect(alert(element)).toBeUndefined();
        expect(text(element)).toBe("Create Webhook");
      });

      it("shows a configuration the worker refuses to read as withheld", async () => {
        const config = createMockCellHandle<WebhookConfig | null>();
        const answer = holdReads(config);
        const element = await webhookWith(config);
        expect(text(element)).toBe("Loading…");

        answer({ refused: { refusedBy: "display-ceiling" } });
        await answered(element);
        expect(text(element)).toBe("Content hidden by policy");
        expect(alert(element)).toBeUndefined();
      });
    });

    describe("Create Webhook", () => {
      it("registers the inbox and configuration under the name", async () => {
        const inbox = createMockCellHandle<unknown>(undefined, {
          id: "of:inbox",
          space: "did:key:space",
        });
        const config = createMockCellHandle<WebhookConfig | null>(null);
        const element = await webhookWith(config, "Push events", inbox);
        let answer!: (response: Response) => void;
        respond = () => new Promise((resolve) => answer = resolve);

        button(element).click();
        await element.updateComplete;
        expect(text(element)).toBe("Creating...");
        expect(button(element).hasAttribute("disabled")).toBe(true);
        expect(fetched).toHaveLength(1);
        expect(fetched[0].url).toBe("/api/webhooks");
        expect(fetched[0].init?.method).toBe("POST");
        expect(JSON.parse(String(fetched[0].init?.body))).toEqual({
          name: "Push events",
          cellLink: inbox.toWireString(),
          confidentialCellLink: config.toWireString(),
        });

        answer(Response.json({ id: "wh_1" }));
        await answered(element);
        expect(text(element)).toBe("Create Webhook");
        expect(button(element).hasAttribute("disabled")).toBe(false);
        expect(alert(element)).toBeUndefined();
      });

      it("sends one request for clicks made while one is under way", async () => {
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(null),
        );
        button(element).click();
        button(element).click();
        await answered(element);
        expect(fetched).toHaveLength(1);
      });

      it("shows what is missing, and sends nothing, without a name", async () => {
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(null),
          "",
        );
        button(element).click();
        await element.updateComplete;
        expect(alert(element)).toBe(
          "Missing required properties: name, inbox, config",
        );
        expect(fetched).toEqual([]);
      });

      it("shows the error the server gives", async () => {
        respond = () =>
          Promise.resolve(Response.json({ error: "No such space" }, {
            status: 403,
          }));
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(null),
        );
        button(element).click();
        await answered(element);
        expect(alert(element)).toBe("No such space");
        expect(text(element)).toContain("Create Webhook");
      });

      it("shows the HTTP status for a failure the server does not explain", async () => {
        respond = () =>
          Promise.resolve(new Response("Bad gateway", { status: 502 }));
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(null),
        );
        button(element).click();
        await answered(element);
        expect(alert(element)).toBe("HTTP 502");
      });

      it("shows a generic message for a failure that is not an `Error`", async () => {
        respond = () => Promise.reject("offline");
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(null),
        );
        button(element).click();
        await answered(element);
        expect(alert(element)).toBe("Failed to create webhook");
      });
    });

    describe("Delete", () => {
      it("unregisters the webhook in the inbox's space, then clears the configuration", async () => {
        const config = createMockCellHandle<WebhookConfig | null>(CONFIG);
        const element = await webhookWith(config);
        let answer!: (response: Response) => void;
        respond = () => new Promise((resolve) => answer = resolve);

        button(element).click();
        await element.updateComplete;
        expect(button(element).textContent?.trim()).toBe("...");
        expect(fetched).toHaveLength(1);
        expect(fetched[0].url).toBe(
          "/api/webhooks/wh_1?space=did%3Akey%3Aspace",
        );
        expect(fetched[0].init?.method).toBe("DELETE");
        expect(writesSent(config)).toEqual([]);

        answer(Response.json({}));
        await answered(element);
        expect(writesSent(config).map((write) => write.value)).toEqual([
          null,
        ]);
        expect(text(element)).toBe("Create Webhook");
      });

      it("takes the webhook's id from the end of a URL it cannot parse", async () => {
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>({
            url: "hooks/wh_2",
            secret: CONFIG.secret,
          }),
          "Push events",
          null,
        );
        button(element).click();
        await answered(element);
        expect(fetched.map((request) => request.url)).toEqual([
          "/api/webhooks/wh_2?space=",
        ]);
      });

      it("sends nothing for a URL with no id at its end", async () => {
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>({
            url: "https://example.invalid/api/webhooks/",
            secret: CONFIG.secret,
          }),
        );
        button(element).click();
        await answered(element);
        expect(fetched).toEqual([]);
        expect(button(element).textContent?.trim()).toBe("Delete");
      });

      it("sends nothing once the worker refuses the configuration", async () => {
        const config = createMockCellHandle<WebhookConfig | null>(CONFIG);
        const element = await webhookWith(config);
        const shown = button(element);
        pushRefusal(config);
        shown.click();
        await answered(element);
        expect(fetched).toEqual([]);
        expect(text(element)).toBe("Content hidden by policy");
      });

      it("sends one request for clicks made while one is under way", async () => {
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(CONFIG),
        );
        button(element).click();
        button(element).click();
        await answered(element);
        expect(fetched).toHaveLength(1);
      });

      it("shows the error the server gives, and keeps the configuration", async () => {
        respond = () =>
          Promise.resolve(Response.json({ error: "Not yours" }, {
            status: 403,
          }));
        const config = createMockCellHandle<WebhookConfig | null>(CONFIG);
        const element = await webhookWith(config);
        button(element).click();
        await answered(element);
        expect(alert(element)).toBe("Not yours");
        expect(writesSent(config)).toEqual([]);
        expect(button(element).textContent?.trim()).toBe("Delete");
      });

      it("shows the HTTP status for a failure the server does not explain", async () => {
        respond = () => Promise.resolve(new Response("", { status: 500 }));
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(CONFIG),
        );
        button(element).click();
        await answered(element);
        expect(alert(element)).toBe("HTTP 500");
      });

      it("shows a generic message for a failure that is not an `Error`", async () => {
        respond = () => Promise.reject("offline");
        const element = await webhookWith(
          createMockCellHandle<WebhookConfig | null>(CONFIG),
        );
        button(element).click();
        await answered(element);
        expect(alert(element)).toBe("Failed to delete webhook");
      });
    });

    describe("disconnected", () => {
      it("stops following the configuration", async () => {
        const config = createMockCellHandle<WebhookConfig | null>(null);
        const element = await webhookWith(config);
        element.remove();
        pushUpdate(config, CONFIG);
        await element.updateComplete;
        expect(text(element)).toBe("Create Webhook");
      });

      it("subscribes to nothing, and reads nothing, for a configuration given while out of the document", async () => {
        const element = await webhookWith(undefined);
        element.remove();
        const config = createMockCellHandle<WebhookConfig | null>();
        const subscriptions = countSubscriptions(config);
        holdReads(config);

        element.config = config;
        await element.updateComplete;
        expect(subscriptions).toEqual({ live: 0, reads: 0 });

        document.body.append(element);
        expect(subscriptions).toEqual({ live: 1, reads: 1 });
        element.remove();
        expect(subscriptions).toEqual({ live: 0, reads: 1 });
      });

      it("follows the configuration again once reconnected", async () => {
        const config = createMockCellHandle<WebhookConfig | null>(null);
        const element = await webhookWith(config);
        element.remove();
        document.body.append(element);
        await element.updateComplete;
        pushUpdate(config, CONFIG);
        await element.updateComplete;
        expect(button(element).textContent?.trim()).toBe("Delete");
      });
    });
  });
});
