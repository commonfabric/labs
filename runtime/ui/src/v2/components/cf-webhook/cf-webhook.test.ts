/**
 * A webhook whose configuration the worker refuses is shown as withheld, not
 * as a webhook that was never made: offering to create one in its place would
 * replace a configuration that may exist.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import {
  createMockCellHandle,
  holdReads,
  pushRefusal,
} from "../../test-utils/mock-cell-handle.ts";
import { CFWebhook, type WebhookConfig } from "./cf-webhook.ts";

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

  it("shows a configuration it could not read as such, with nothing to create, and reads it again on Retry", async () => {
    const element = new CFWebhook();
    const config = createMockCellHandle<WebhookConfig | null>();
    const answer = holdReads(config);
    element.config = config;
    element.updated(new Map([["config", undefined]]));
    const time = new FakeTime();
    try {
      answer(new Error("the connection dropped the read"));
      await time.runMicrotasks();

      const failed = element.render();
      expect(JSON.stringify(failed)).toContain("could not be read");
      expect(JSON.stringify(failed)).not.toContain("Create Webhook");

      // The Retry control's handler, the one the failed state renders.
      const retry = handlersIn(failed);
      expect(retry).toHaveLength(1);
      retry[0]();
      await time.runMicrotasks();
    } finally {
      time.restore();
    }

    // The read again found the cell holding nothing: a webhook to create.
    expect(JSON.stringify(element.render())).toContain("Create Webhook");
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
});

/** The event handlers a rendered template binds, nested templates included. */
function handlersIn(rendered: unknown): Array<() => void> {
  const found: Array<() => void> = [];
  const visit = (value: unknown) => {
    if (typeof value === "function") {
      found.push(() => Reflect.apply(value, undefined, []));
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (
      value !== null && typeof value === "object" && "values" in value
    ) {
      visit(value.values);
    }
  };
  visit(rendered);
  return found;
}
