import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildCompositionPlan,
  buildFfconcat,
  FrameRecorder,
  parsePresentationConfig,
  PresentationSession,
  type RecordedFrame,
} from "../presentation/mod.ts";
import type { ScreencastFrame } from "../astral-adapter.ts";
import { Page } from "../page.ts";

Deno.test("parsePresentationConfig stays disabled without an output directory", () => {
  assertEquals(parsePresentationConfig({}), { enabled: false });
});

Deno.test("Page runs the navigation hook after goto and reload", async () => {
  const navigations: string[] = [];
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(options: { url: string }): Promise<{ loaderId?: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: ({ url }) => {
      navigations.push(url);
      return Promise.resolve({});
    },
  };
  const astralPage = {
    timeout: 0,
    reload: () => {
      navigations.push("reload");
      return Promise.resolve();
    },
    unsafelyGetCelestialBindings: () => celestial,
  };
  const page = new Page(
    astralPage as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  let hookCalls = 0;
  page.addAfterNavigationHook(() => {
    hookCalls++;
  });

  await page.goto("https://example.test/");
  await page.reload();

  assertEquals(navigations, ["https://example.test/", "reload"]);
  assertEquals(hookCalls, 2);
});

Deno.test("Page runs every navigation hook, and stops one that is removed", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(options: { url: string }): Promise<{ loaderId?: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => Promise.resolve({}),
  };
  const astralPage = {
    timeout: 0,
    reload: () => Promise.resolve(),
    unsafelyGetCelestialBindings: () => celestial,
  };
  const page = new Page(
    astralPage as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  const order: string[] = [];
  page.addAfterNavigationHook(() => {
    order.push("first");
  });
  const removeSecond = page.addAfterNavigationHook(() => {
    order.push("second");
  });

  await page.goto("https://example.test/");
  removeSecond();
  await page.reload();

  assertEquals(order, ["first", "second", "first"]);
});

Deno.test("Page skips a navigation hook removed while an earlier one waits", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(options: { url: string }): Promise<{ loaderId?: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => Promise.resolve({}),
  };
  const astralPage = {
    timeout: 0,
    reload: () => Promise.resolve(),
    unsafelyGetCelestialBindings: () => celestial,
  };
  const page = new Page(
    astralPage as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  const order: string[] = [];
  // Holds the second hook's remover, which the first hook calls while this
  // navigation's run is between the two.
  const second = { remove: () => {} };
  page.addAfterNavigationHook(async () => {
    order.push("first");
    await Promise.resolve();
    second.remove();
  });
  second.remove = page.addAfterNavigationHook(() => {
    order.push("second");
  });

  await page.goto("https://example.test/");

  assertEquals(order, ["first"]);
});

Deno.test("Page navigation does not depend on Astral's retry wrapper", async () => {
  const navigationCalls: unknown[] = [];
  const lifecycleCalls: unknown[] = [];
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(
        options: unknown,
      ): Promise<Record<string, never>>;
      navigate(
        options: unknown,
      ): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled(options) {
      lifecycleCalls.push(options);
      return Promise.resolve({});
    },
    navigate(options) {
      navigationCalls.push(options);
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: {
            frameId: "frame",
            loaderId: "loader",
            name: "networkAlmostIdle",
            timestamp: 0,
          },
        }),
      );
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const astralPage = {
    timeout: 0,
    goto: () => {
      throw new Error("RetryError: Retrying exceeded the maxAttempts (5).");
    },
    unsafelyGetCelestialBindings: () => celestial,
  };
  const page = new Page(
    astralPage as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  let hookCalls = 0;
  page.addAfterNavigationHook(() => {
    hookCalls++;
  });

  await page.goto("https://example.test/next", {
    referrer: "https://example.test/previous",
  });

  assertEquals(navigationCalls, [{
    url: "https://example.test/next",
    referrer: "https://example.test/previous",
  }]);
  assertEquals(lifecycleCalls, [{ enabled: true }, { enabled: false }]);
  assertEquals(hookCalls, 1);
});

Deno.test("Page navigation ignores unrelated lifecycle events", async () => {
  let navigationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    navigationStarted = resolve;
  });
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      navigationStarted();
      return Promise.resolve({ frameId: "frame", loaderId: "target" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  let completed = false;
  const navigation = page.goto("https://example.test/").then(() => {
    completed = true;
  });
  await started;

  celestial.dispatchEvent(
    new CustomEvent("Page.lifecycleEvent", {
      detail: { loaderId: "other", name: "networkAlmostIdle" },
    }),
  );
  celestial.dispatchEvent(
    new CustomEvent("Page.lifecycleEvent", {
      detail: { loaderId: "target", name: "load" },
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(completed, false);

  celestial.dispatchEvent(
    new CustomEvent("Page.lifecycleEvent", {
      detail: { loaderId: "target", name: "networkAlmostIdle" },
    }),
  );
  await navigation;
  assertEquals(completed, true);
});

Deno.test("Page navigation maps the explicit load option", async () => {
  const lifecycleNames: string[] = [];
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      lifecycleNames.push("load");
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "load" },
        }),
      );
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await page.goto("https://example.test/load", { waitUntil: "load" });

  assertEquals(lifecycleNames, ["load"]);
});

Deno.test("Page navigation accepts DOMContentLoaded by default", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "DOMContentLoaded" },
        }),
      );
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await page.goto("https://example.test/");
});

Deno.test("Page navigation rejects when its browser session detaches", async () => {
  let navigationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    navigationStarted = resolve;
  });
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      navigationStarted();
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  const navigation = page.goto("https://example.test/");
  await started;
  celestial.dispatchEvent(
    new CustomEvent("Inspector.detached", {
      detail: { reason: "target closed" },
    }),
  );

  await assertRejects(
    () => navigation,
    Error,
    "Browser session detached during navigation: target closed",
  );
});

Deno.test("Page navigation cleans up after its frame detaches", async () => {
  let navigationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    navigationStarted = resolve;
  });
  const lifecycleStates: boolean[] = [];
  const removedListeners: string[] = [];
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(
        options: { enabled: boolean },
      ): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  const removeEventListener = celestial.removeEventListener.bind(celestial);
  celestial.removeEventListener = (type, callback, options) => {
    removedListeners.push(type);
    removeEventListener(type, callback, options);
  };
  celestial.Page = {
    setLifecycleEventsEnabled: ({ enabled }) => {
      lifecycleStates.push(enabled);
      return Promise.resolve({});
    },
    navigate: () => {
      navigationStarted();
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  const navigation = page.goto("https://example.test/");
  await started;
  celestial.dispatchEvent(
    new CustomEvent("Page.frameDetached", {
      detail: { frameId: "frame" },
    }),
  );

  await assertRejects(
    () => navigation,
    Error,
    "Navigation frame was detached.",
  );
  assertEquals(lifecycleStates, [true, false]);
  assertEquals(removedListeners, [
    "Page.lifecycleEvent",
    "Page.frameDetached",
    "Page.frameStoppedLoading",
    "Page.frameNavigated",
    "Inspector.detached",
  ]);
});

Deno.test("Page detects an early frame detachment without a loader", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      celestial.dispatchEvent(
        new CustomEvent("Page.frameDetached", {
          detail: { frameId: "frame" },
        }),
      );
      return Promise.resolve({ frameId: "frame" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await assertRejects(
    () => page.goto("https://example.test/"),
    Error,
    "Navigation frame was detached.",
  );
});

Deno.test("Page rejects when its frame stops before becoming ready", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "init" },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.frameStoppedLoading", {
          detail: { frameId: "frame" },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "DOMContentLoaded" },
        }),
      );
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await assertRejects(
    () => page.goto("https://example.test/"),
    Error,
    "Navigation frame stopped loading before it became ready.",
  );
});

Deno.test("Page rejects when another loader supersedes navigation", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      celestial.dispatchEvent(
        new CustomEvent("Page.frameNavigated", {
          detail: {
            frame: { id: "frame", loaderId: "loader" },
            type: "Navigation",
          },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.frameNavigated", {
          detail: {
            frame: { id: "frame", loaderId: "replacement" },
            type: "Navigation",
          },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "DOMContentLoaded" },
        }),
      );
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await assertRejects(
    () => page.goto("https://example.test/"),
    Error,
    "Navigation was superseded by another document.",
  );
});

Deno.test("Page accepts readiness before its frame stops", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "DOMContentLoaded" },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.frameStoppedLoading", {
          detail: { frameId: "frame" },
        }),
      );
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await page.goto("https://example.test/");
});

Deno.test("Page ignores terminal signals from the previous document", async () => {
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      celestial.dispatchEvent(
        new CustomEvent("Page.frameStoppedLoading", {
          detail: { frameId: "frame" },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.frameNavigated", {
          detail: {
            frame: { id: "frame", loaderId: "previous" },
            type: "Navigation",
          },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "init" },
        }),
      );
      celestial.dispatchEvent(
        new CustomEvent("Page.lifecycleEvent", {
          detail: { loaderId: "loader", name: "DOMContentLoaded" },
        }),
      );
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await page.goto("https://example.test/");
});

Deno.test("Page preserves a navigation command failure after detachment", async () => {
  let navigationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    navigationStarted = resolve;
  });
  let rejectNavigation!: (error: Error) => void;
  const navigationResult = new Promise<never>((_resolve, reject) => {
    rejectNavigation = reject;
  });
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<never>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      navigationStarted();
      return navigationResult;
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );
  const navigation = page.goto("https://example.test/");
  await started;
  celestial.dispatchEvent(
    new CustomEvent("Inspector.detached", {
      detail: { reason: "target closed" },
    }),
  );
  rejectNavigation(new Error("Navigation command disconnected."));

  await assertRejects(
    () => navigation,
    Error,
    "Navigation command disconnected.",
  );
});

Deno.test("Page preserves navigation failures when cleanup fails", async () => {
  let lifecycleCall = 0;
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<never>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => {
      lifecycleCall++;
      return lifecycleCall === 1
        ? Promise.resolve({})
        : Promise.reject(new Error("Lifecycle cleanup failed."));
    },
    navigate: () => Promise.reject(new Error("Navigation failed.")),
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  await assertRejects(
    () => page.goto("https://example.test/"),
    Error,
    "Navigation failed.",
  );
});

Deno.test("Page serializes overlapping navigation calls", async () => {
  const loaderIds = ["first", "second"];
  const navigationCalls: string[] = [];
  let firstNavigationStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    firstNavigationStarted = resolve;
  });
  let secondNavigationStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => {
    secondNavigationStarted = resolve;
  });
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      const loaderId = loaderIds[navigationCalls.length];
      navigationCalls.push(loaderId);
      if (loaderId === "first") firstNavigationStarted();
      if (loaderId === "second") secondNavigationStarted();
      return Promise.resolve({ frameId: "frame", loaderId });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  const first = page.goto("https://example.test/first");
  const second = page.goto("https://example.test/second");
  await firstStarted;
  celestial.dispatchEvent(
    new CustomEvent("Page.lifecycleEvent", {
      detail: { loaderId: "first", name: "networkAlmostIdle" },
    }),
  );
  await first;
  await secondStarted;
  celestial.dispatchEvent(
    new CustomEvent("Page.lifecycleEvent", {
      detail: { loaderId: "second", name: "networkAlmostIdle" },
    }),
  );
  await second;

  assertEquals(navigationCalls, ["first", "second"]);
});

Deno.test("Page serializes reload behind navigation", async () => {
  const operations: string[] = [];
  let navigationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    navigationStarted = resolve;
  });
  let reloadStarted!: () => void;
  const reloading = new Promise<void>((resolve) => {
    reloadStarted = resolve;
  });
  const celestial = new EventTarget() as EventTarget & {
    Page: {
      setLifecycleEventsEnabled(): Promise<Record<string, never>>;
      navigate(): Promise<{ frameId: string; loaderId: string }>;
    };
  };
  celestial.Page = {
    setLifecycleEventsEnabled: () => Promise.resolve({}),
    navigate: () => {
      operations.push("goto");
      navigationStarted();
      return Promise.resolve({ frameId: "frame", loaderId: "loader" });
    },
  };
  const page = new Page(
    {
      timeout: 0,
      reload: () => {
        operations.push("reload");
        reloadStarted();
        return Promise.resolve();
      },
      unsafelyGetCelestialBindings: () => celestial,
    } as unknown as ConstructorParameters<typeof Page>[0],
    { timeout: 10 },
  );

  const navigation = page.goto("https://example.test/");
  const reload = page.reload();
  await started;
  celestial.dispatchEvent(
    new CustomEvent("Page.lifecycleEvent", {
      detail: { loaderId: "loader", name: "networkAlmostIdle" },
    }),
  );
  await navigation;
  await reloading;
  await reload;

  assertEquals(operations, ["goto", "reload"]);
});

Deno.test("parsePresentationConfig supplies deterministic defaults", () => {
  const config = parsePresentationConfig({
    CF_DEMO_OUTPUT_DIR: "/tmp/demo",
  });
  assertEquals(config.enabled, true);
  if (!config.enabled) throw new Error("expected enabled config");
  assertEquals(config.outputDir, "/tmp/demo");
  assertEquals(config.videoFileName, "demo.mp4");
  assertEquals(config.viewport, { width: 1280, height: 720 });
  assertEquals(config.typingDelayMs, 55);
  assertEquals(config.cursorTravelMs, 350);
  assertEquals(config.postResultHoldMs, 800);
  assertEquals(config.jpegQuality, 85);
});

Deno.test("parsePresentationConfig names and validates the output video", () => {
  const config = parsePresentationConfig({
    CF_DEMO_OUTPUT_DIR: "/tmp/demo",
    CF_DEMO_NAME: "lunch-poll-vote",
  });
  if (!config.enabled) throw new Error("expected enabled config");
  assertEquals(config.videoFileName, "lunch-poll-vote.mp4");
  assertThrows(
    () =>
      parsePresentationConfig({
        CF_DEMO_OUTPUT_DIR: "/tmp/demo",
        CF_DEMO_NAME: "../escape",
      }),
    Error,
    "safe filename stem",
  );
});

Deno.test("parsePresentationConfig validates numeric overrides", () => {
  assertThrows(
    () =>
      parsePresentationConfig({
        CF_DEMO_OUTPUT_DIR: "/tmp/demo",
        CF_DEMO_VIEWPORT: "wide",
      }),
    Error,
    "CF_DEMO_VIEWPORT",
  );
});

Deno.test("buildFfconcat preserves variable durations and repeats final frame", () => {
  const frames: RecordedFrame[] = [
    frame("frames/000001.jpg", 0, 0.4),
    frame("frames/000002.jpg", 400, 1.1),
    frame("frames/000003.jpg", 1500, 0.8),
  ];
  assertEquals(
    buildFfconcat(frames),
    [
      "ffconcat version 1.0",
      "file 'frames/000001.jpg'",
      "duration 0.400000",
      "file 'frames/000002.jpg'",
      "duration 1.100000",
      "file 'frames/000003.jpg'",
      "duration 0.800000",
      "file 'frames/000003.jpg'",
      "",
    ].join("\n"),
  );
});

Deno.test("buildFfconcat rejects an empty recording", () => {
  assertThrows(
    () => buildFfconcat([]),
    Error,
    "no frames",
  );
});

Deno.test("buildCompositionPlan creates deterministic one through four participant layouts", () => {
  assertEquals(buildCompositionPlan(["alice"]), {
    width: 1280,
    height: 720,
    filter:
      "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black[vout]",
    outputLabel: "vout",
  });

  const two = buildCompositionPlan(["alice", "bob"]);
  assertEquals({ width: two.width, height: two.height }, {
    width: 2560,
    height: 720,
  });
  assertStringIncludes(two.filter, "hstack=inputs=2:shortest=1[vout]");

  const three = buildCompositionPlan(["alice", "bob", "carol"]);
  assertEquals({ width: three.width, height: three.height }, {
    width: 2560,
    height: 1440,
  });
  assertStringIncludes(three.filter, "xstack=inputs=4");
  assertStringIncludes(three.filter, "color=c=black:s=1280x720");
  assertStringIncludes(three.filter, "shortest=1[vout]");

  const four = buildCompositionPlan(["a", "b", "c", "d"]);
  assertStringIncludes(four.filter, "layout=0_0|1280_0|0_720|1280_720");
});

Deno.test("buildCompositionPlan rejects more than four participants", () => {
  assertThrows(
    () => buildCompositionPlan(["a", "b", "c", "d", "e"]),
    Error,
    "at most four",
  );
});

Deno.test("FrameRecorder acknowledges immediately and preserves variable timing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let now = 100;
    const page = new FakeScreencastPage();
    const writes: string[] = [];
    const recorder = new FrameRecorder(page, {
      participantDir: dir,
      id: "alice",
      label: "Alice",
      color: "#7c3aed",
      quality: 85,
      viewport: { width: 1280, height: 720 },
      finalHoldMs: 800,
      clock: { now: () => now },
      writeFile: async (path) => {
        await Promise.resolve();
        writes.push(path);
      },
    });
    await recorder.start();
    page.emit(screencastFrame(1));
    assertEquals(page.acknowledged, [1]);
    now = 600;
    page.emit(screencastFrame(2));
    now = 700;
    const manifest = await recorder.stop();
    assertEquals(writes.length, 2);
    assertEquals(manifest.frames.map((item) => item.durationSeconds), [
      0.5,
      0.8,
    ]);
    assertEquals(manifest.captureStartedAtMs, 100);
    assertEquals(manifest.captureEndedAtMs, 700);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("FrameRecorder waits for late acknowledgment failures", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let rejectAcknowledgement!: (reason: Error) => void;
    const page = new FakeScreencastPage();
    page.acknowledge = () =>
      new Promise<void>((_resolve, reject) => {
        rejectAcknowledgement = reject;
      });
    const recorder = new FrameRecorder(page, {
      participantDir: dir,
      id: "alice",
      label: "Alice",
      color: "#7c3aed",
      quality: 85,
      viewport: { width: 1280, height: 720 },
      finalHoldMs: 800,
      writeFile: () => Promise.resolve(),
    });
    await recorder.start();
    page.emit(screencastFrame(1));
    const stopping = recorder.stop();
    rejectAcknowledgement(new Error("CDP closed"));

    await assertRejects(
      () => stopping,
      Error,
      "failed to acknowledge screencast frame",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PresentationSession serializes manifests and records failed steps", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const session = new PresentationSession({
      enabled: true,
      outputDir: dir,
      videoFileName: "demo.mp4",
      viewport: { width: 1280, height: 720 },
      typingDelayMs: 55,
      cursorTravelMs: 350,
      cursorSettleMs: 150,
      clickPulseMs: 180,
      postResultHoldMs: 0,
      jpegQuality: 85,
      keepFrames: false,
    });
    await Promise.all(
      Array.from({ length: 8 }, () => session.writeManifest()),
    );
    await assertRejects(
      () =>
        session.step(
          "failing action",
          () => Promise.reject(new Error("expected failure")),
        ),
      Error,
      "expected failure",
    );
    const manifest = JSON.parse(
      await Deno.readTextFile(`${dir}/manifest.json`),
    );
    assertEquals(manifest.status, "test-failed");
    assertEquals(manifest.steps[0].failed, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

function frame(
  path: string,
  recordedAtMs: number,
  durationSeconds: number,
): RecordedFrame {
  return {
    sequence: 1,
    path,
    recordedAtMs,
    durationSeconds,
    width: 1280,
    height: 720,
  };
}

class FakeScreencastPage {
  listener?: (frame: ScreencastFrame) => void;
  acknowledged: number[] = [];
  acknowledge: (sessionId: number) => Promise<void> = () => Promise.resolve();

  startScreencast(): Promise<void> {
    return Promise.resolve();
  }

  stopScreencast(): Promise<void> {
    return Promise.resolve();
  }

  acknowledgeScreencastFrame(sessionId: number): Promise<void> {
    this.acknowledged.push(sessionId);
    return this.acknowledge(sessionId);
  }

  onScreencastFrame(
    listener: (frame: ScreencastFrame) => void,
  ): () => void {
    this.listener = listener;
    return () => this.listener = undefined;
  }

  emit(frame: ScreencastFrame): void {
    this.listener?.(frame);
  }
}

function screencastFrame(sessionId: number): ScreencastFrame {
  return {
    sessionId,
    data: btoa("jpeg"),
    metadata: {
      offsetTop: 0,
      pageScaleFactor: 1,
      deviceWidth: 1280,
      deviceHeight: 720,
      scrollOffsetX: 0,
      scrollOffsetY: 0,
      timestamp: sessionId,
    },
  };
}
