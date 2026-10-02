/**
 * A webhook whose configuration the worker refuses is shown as withheld, not
 * as a webhook that was never made: offering to create one in its place would
 * replace a configuration that may exist.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  createMockCellHandle,
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
