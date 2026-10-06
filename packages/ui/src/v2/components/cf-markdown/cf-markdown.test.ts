import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  createMockCellHandle,
  pushRefusal,
  pushUpdate,
} from "../../test-utils/mock-cell-handle.ts";
import { CFMarkdown } from "./index.ts";

describe("cf-markdown", () => {
  // What the component renders is covered by cf-markdown.browser.test.ts, which
  // runs in a browser and asserts against the DOM the component built.

  it("is defined", () => {
    expect(CFMarkdown).toBeDefined();
  });

  it("creates an element instance", () => {
    expect(new CFMarkdown()).toBeInstanceOf(CFMarkdown);
  });

  it("starts with empty content", () => {
    expect(new CFMarkdown().content).toBe("");
  });

  it("starts in the default variant", () => {
    expect(new CFMarkdown().variant).toBe("default");
  });

  it("starts with streaming off", () => {
    expect(new CFMarkdown().streaming).toBe(false);
  });

  it("accepts the inverse variant", () => {
    const element = new CFMarkdown();
    element.variant = "inverse";
    expect(element.variant).toBe("inverse");
  });

  it("accepts streaming", () => {
    const element = new CFMarkdown();
    element.streaming = true;
    expect(element.streaming).toBe(true);
  });

  it("reads content from a string", () => {
    const element = new CFMarkdown();
    element.content = "test content";

    expect((element as any)._getContentValue()).toBe("test content");
  });

  it("reads empty content from a null content property", () => {
    const element = new CFMarkdown();
    element.content = null as any;

    expect((element as any)._getContentValue()).toBe("");
  });

  describe("Cell integration", () => {
    // Note: Full Cell integration testing requires real CellImpl instances
    // which are complex to mock. These tests verify the component's
    // subscription management logic with manual _unsubscribe manipulation.

    it("has no subscription before content is bound", () => {
      expect((new CFMarkdown() as any)._unsubscribe).toBeNull();
    });

    it("drops its subscription on disconnect", () => {
      const element = new CFMarkdown();

      // Simulate having a subscription
      let cleaned = false;
      (element as any)._unsubscribe = () => {
        cleaned = true;
      };

      element.disconnectedCallback();

      expect(cleaned).toBe(true);
      expect((element as any)._unsubscribe).toBeNull();
    });

    it("drops the old subscription when the content property changes", () => {
      const element = new CFMarkdown();

      // Simulate having an old subscription
      let oldCleaned = false;
      (element as any)._unsubscribe = () => {
        oldCleaned = true;
      };

      element.content = "new content";
      (element as any).willUpdate(new Map([["content", "old content"]]));

      expect(oldCleaned).toBe(true);
      // No new subscription for string content
      expect((element as any)._unsubscribe).toBeNull();
    });

    it("shows the placeholder for content the worker refuses, and renders again", () => {
      const element = new CFMarkdown();
      const cell = createMockCellHandle<string>("shown before the seal");
      let requestUpdates = 0;
      element.requestUpdate = (() => {
        requestUpdates++;
      }) as typeof element.requestUpdate;
      element.content = cell;
      (element as any).willUpdate(new Map([["content", "old content"]]));
      const before = requestUpdates;

      pushRefusal(cell);

      expect(requestUpdates).toBe(before + 1);
      expect((element as any)._getContentValue()).toBe(
        "Content hidden by policy",
      );
    });

    it("syncs uncached cell content on first bind", async () => {
      const element = new CFMarkdown();
      const cell = createMockCellHandle<string>(undefined as any);
      let syncCalls = 0;
      let requestUpdates = 0;

      (cell as any).sync = () => {
        syncCalls++;
        pushUpdate(cell, "loaded from sync");
        return Promise.resolve("loaded from sync");
      };
      element.requestUpdate = (() => {
        requestUpdates++;
      }) as typeof element.requestUpdate;

      element.content = cell;
      (element as any).willUpdate(new Map([["content", "old content"]]));
      await Promise.resolve();

      expect(syncCalls).toBe(1);
      expect((element as any)._getContentValue()).toBe("loaded from sync");
      expect(requestUpdates).toBeGreaterThan(0);
    });
  });
});
