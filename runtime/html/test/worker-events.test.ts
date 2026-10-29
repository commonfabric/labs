/**
 * Tests for VDOM event serialization.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  $conn,
  CellHandle,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import {
  type DomEventMessage,
  isDomEventMessage,
  serializeEvent,
} from "../src/main/events.ts";

/** A handle standing in for a bound one; only its ref and class are read. */
function makeHandle(): CellHandle {
  return new CellHandle(
    { [$conn]: () => ({}) } as unknown as RuntimeClient,
    { id: "of:fid1:abc", space: "did:key:z6Mk", scope: "space", path: [] },
  );
}

// Mock Event class for testing (Deno doesn't have full DOM by default)
class MockEvent {
  type: string;
  target: unknown;
  isTrusted: boolean;

  constructor(
    type: string,
    init?: { target?: unknown; isTrusted?: boolean },
  ) {
    this.type = type;
    this.target = init?.target;
    this.isTrusted = init?.isTrusted ?? false;
  }
}

class MockKeyboardEvent extends MockEvent {
  key: string;
  code: string;
  repeat: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;

  constructor(
    type: string,
    init: {
      key?: string;
      code?: string;
      repeat?: boolean;
      altKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      target?: unknown;
    } = {},
  ) {
    super(type, init);
    this.key = init.key ?? "";
    this.code = init.code ?? "";
    this.repeat = init.repeat ?? false;
    this.altKey = init.altKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }
}

class MockMouseEvent extends MockEvent {
  button: number;
  buttons: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;

  constructor(
    type: string,
    init: {
      button?: number;
      buttons?: number;
      altKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      shiftKey?: boolean;
      target?: unknown;
    } = {},
  ) {
    super(type, init);
    this.button = init.button ?? 0;
    this.buttons = init.buttons ?? 0;
    this.altKey = init.altKey ?? false;
    this.ctrlKey = init.ctrlKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
  }
}

class MockInputEvent extends MockEvent {
  inputType: string;
  data: string | null;

  constructor(
    type: string,
    init: {
      inputType?: string;
      data?: string | null;
      target?: unknown;
    } = {},
  ) {
    super(type, init);
    this.inputType = init.inputType ?? "";
    this.data = init.data ?? null;
  }
}

class MockCustomEvent extends MockEvent {
  detail: unknown;

  constructor(
    type: string,
    init: {
      detail?: unknown;
      target?: unknown;
    } = {},
  ) {
    super(type, init);
    this.detail = init.detail;
  }
}

Deno.test("events - isDomEventMessage", async (t) => {
  await t.step("returns true for valid DomEventMessage", () => {
    const message: DomEventMessage = {
      type: "dom-event",
      handlerId: 1,
      event: { type: "click" },
      nodeId: 42,
    };
    assertEquals(isDomEventMessage(message), true);
  });

  await t.step("returns false for null", () => {
    assertEquals(isDomEventMessage(null), false);
  });

  await t.step("returns false for non-object", () => {
    assertEquals(isDomEventMessage("string"), false);
    assertEquals(isDomEventMessage(42), false);
  });

  await t.step("returns false for wrong type", () => {
    assertEquals(isDomEventMessage({ type: "other" }), false);
  });

  await t.step("returns false for missing handlerId", () => {
    assertEquals(
      isDomEventMessage({ type: "dom-event", event: {}, nodeId: 1 }),
      false,
    );
  });

  await t.step("returns false for missing event", () => {
    assertEquals(
      isDomEventMessage({ type: "dom-event", handlerId: 1, nodeId: 1 }),
      false,
    );
  });

  await t.step("returns false for missing nodeId", () => {
    assertEquals(
      isDomEventMessage({ type: "dom-event", handlerId: 1, event: {} }),
      false,
    );
  });
});

Deno.test("events - serializeEvent", async (t) => {
  await t.step("serializes basic event type", () => {
    const event = new MockEvent("click") as unknown as Event;
    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "click");
  });

  await t.step("carries a bound `value` as the link to its cell", () => {
    // The case this arm exists for: `cf-input`, `cf-tabs` and `cf-calendar`
    // each declare `value` as `CellHandle<string> | string`, and a bound one
    // holds the handle the applicator installed.
    const handle = makeHandle();
    const event = new MockEvent("input", {
      target: { value: handle },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.value, handle.toSigilLink());
  });

  await t.step("refuses a value that merely defines a `toJSON()`", () => {
    // The whole of "no wide-open `toJSON()`": a cell is recognized by its
    // class, and something that only knows how to render itself as JSON is not
    // one. `value` is the property with no scalar to fall back on, so nothing
    // catches this short of the refusal.
    const speaksForItself = new (class {
      toJSON() {
        return { "/": { "link@1": { id: "of:fid1:abc" } } };
      }
    })();
    const event = new MockEvent("input", {
      target: { value: speaksForItself },
    }) as unknown as Event;

    assertThrows(() => serializeEvent(event), Error, "Cannot yet carry");
  });

  await t.step("carries a circular target value through untouched", () => {
    // A value with cycles is a `FabricValue`, so it crosses as one. Whether it
    // can be carried further is the encoding's question at the crossing, and
    // nothing here walks a value looking for one.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const event = new MockEvent("input", {
      target: { value: circular },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.value, circular as FabricValue);
  });

  await t.step("names a value that refuses even to be described", () => {
    // The refusal has to say what it refused, and `String()` reaches for
    // `toString` and `valueOf`, which an object made with `Object.create(null)`
    // has neither of. A fixed token stands in, so the refusal does not fail in
    // turn from inside its own message.
    const bare = Object.create(null);
    const event = new MockEvent("input", {
      target: { value: bare },
    }) as unknown as Event;

    assertThrows(() => serializeEvent(event), Error, "/unconvertible");
  });

  await t.step("captures trusted provenance", () => {
    const event = new MockEvent("click", {
      isTrusted: true,
    }) as unknown as Event;
    const serialized = serializeEvent(event);
    assertEquals(serialized.provenance, {
      origin: "dom",
      trusted: true,
    });
  });

  await t.step("captures data-ui markers from composed event paths", () => {
    // A click on the button in a component's shadow tree, as the listener on
    // the component's host receives it: retargeted to the host, with the
    // shadow tree's nodes first on the composed path.

    const control = {
      dataset: {
        uiAction: "TrustedSaveTitle",
        ordinaryHandlerData: "preserved",
      },
    };
    const event = new MockEvent("click", {
      isTrusted: true,
      target: control,
    }) as MockEvent & { composedPath: () => unknown[] };
    event.composedPath = () => [
      { dataset: { cfButton: "" } },
      control,
      {
        dataset: {
          uiPattern: "TrustedSaveSurface",
          uiEventIntegrity: "TrustedSaveSurface",
        },
      },
    ];

    const serialized = serializeEvent(
      event as unknown as Event,
      control as unknown as EventTarget,
    );

    assertEquals(serialized.target?.dataset, {
      uiAction: "TrustedSaveTitle",
      ordinaryHandlerData: "preserved",
    });
    assertEquals(serialized.provenance, {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "TrustedSaveSurface",
        eventIntegrity: ["TrustedSaveSurface"],
        uiContractDataset: {
          uiAction: "TrustedSaveTitle",
        },
      },
    });
  });

  await t.step(
    "captures no data-ui markers from nodes between the target and the listener",
    () => {
      // The listener sits on an ancestor of the surface, as one a pattern
      // binds on its own element around a trusted surface does.

      const wrapper = { dataset: {} };
      const event = new MockEvent("click", {
        isTrusted: true,
        target: { dataset: { uiAction: "TrustedSaveTitle" } },
      }) as MockEvent & { composedPath: () => unknown[] };
      event.composedPath = () => [
        event.target,
        {
          dataset: {
            uiPattern: "TrustedSaveSurface",
            uiEventIntegrity: "TrustedSaveSurface",
          },
        },
        wrapper,
      ];

      const serialized = serializeEvent(
        event as unknown as Event,
        wrapper as unknown as EventTarget,
      );

      expect(serialized.provenance).toStrictEqual({
        origin: "dom",
        trusted: true,
      });
    },
  );

  await t.step(
    "captures no data-ui markers for an event serialized without a bound node",
    () => {
      const event = new MockEvent("click", {
        isTrusted: true,
        target: {
          dataset: {
            uiAction: "TrustedSaveTitle",
            uiPattern: "TrustedSaveSurface",
            uiEventIntegrity: "TrustedSaveSurface",
          },
        },
      }) as MockEvent & { composedPath: () => unknown[] };
      event.composedPath = () => [event.target];

      const serialized = serializeEvent(event as unknown as Event);

      expect(serialized.provenance).toStrictEqual({
        origin: "dom",
        trusted: true,
      });
    },
  );

  await t.step("serializes keyboard event properties", () => {
    const event = new MockKeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      repeat: false,
      altKey: true,
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "keydown");
    assertEquals(serialized.key, "Enter");
    assertEquals(serialized.code, "Enter");
    assertEquals(serialized.repeat, false);
    assertEquals(serialized.altKey, true);
    assertEquals(serialized.ctrlKey, false);
    assertEquals(serialized.metaKey, true);
    assertEquals(serialized.shiftKey, false);
  });

  await t.step("serializes mouse event properties", () => {
    const event = new MockMouseEvent("click", {
      button: 0,
      buttons: 1,
      shiftKey: true,
    }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "click");
    assertEquals(serialized.button, 0);
    assertEquals(serialized.buttons, 1);
    assertEquals(serialized.shiftKey, true);
  });

  await t.step("serializes input event properties", () => {
    const event = new MockInputEvent("input", {
      inputType: "insertText",
      data: "a",
    }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "input");
    assertEquals(serialized.inputType, "insertText");
    assertEquals(serialized.data, "a");
  });

  await t.step("serializes target properties", () => {
    const target = {
      name: "myInput",
      value: "hello",
      checked: true,
      selected: false,
      selectedIndex: 2,
    };
    const event = new MockEvent("change", { target }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.target?.name, "myInput");
    assertEquals(serialized.target?.value, "hello");
    assertEquals(serialized.target?.checked, true);
    assertEquals(serialized.target?.selected, false);
    assertEquals(serialized.target?.selectedIndex, 2);
  });

  await t.step("serializes dataset", () => {
    const target = {
      dataset: { foo: "bar", baz: "qux" },
    };
    const event = new MockEvent("click", { target }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.target?.dataset?.foo, "bar");
    assertEquals(serialized.target?.dataset?.baz, "qux");
  });

  await t.step("serializes a multiple-select target's chosen options", () => {
    // `serializeEvent` recognizes the option list by its DOM type, so the test
    // has to supply that type: Deno has no DOM, and the global is what the
    // production check reads.
    class TestHTMLCollection extends Array<{ value: string }> {}
    const globals = globalThis as { HTMLCollection?: unknown };
    const savedHTMLCollection = globals.HTMLCollection;
    globals.HTMLCollection = TestHTMLCollection;
    try {
      const selectedOptions = TestHTMLCollection.from([
        { value: "a" },
        { value: "c" },
      ]);
      const target = { value: "a", selectedOptions };
      const event = new MockEvent("change", { target }) as unknown as Event;

      const serialized = serializeEvent(event);
      assertEquals(serialized.target?.selectedOptions, [
        { value: "a" },
        { value: "c" },
      ]);
    } finally {
      globals.HTMLCollection = savedHTMLCollection;
    }
  });

  await t.step("serializes custom event detail", () => {
    const event = new MockCustomEvent("custom", {
      detail: { message: "hello", count: 42 },
    }) as unknown as Event;

    const serialized = serializeEvent(event);
    assertEquals(serialized.type, "custom");
    assertEquals((serialized.detail as { message: string }).message, "hello");
    assertEquals((serialized.detail as { count: number }).count, 42);
  });

  await t.step("omits an event property whose type is not the DOM's", () => {
    // `SerializedEvent` declares `key` a `string`. What is read is a property of
    // whatever object was dispatched, so the copy checks rather than trusts, and
    // a value of some other type is left out instead of landing in a field that
    // cannot hold it.
    const event = new MockEvent("keydown") as unknown as Event;
    (event as unknown as Record<string, unknown>).key = { not: "a string" };

    const serialized = serializeEvent(event);

    assertEquals("key" in serialized, false);
  });

  await t.step("carries a cell-bound target property as the link to it", () => {
    // A bound property holds the handle the applicator installed, and what
    // crosses is the link that reaches the cell. `cf-tab` declares `selected` a
    // `boolean` and can still be handed a cell for it, which is why every
    // target property is `T | SigilLink` rather than `T`.
    const handle = makeHandle();
    const event = new MockEvent("cf-tab-select", {
      target: { selected: handle },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.selected, handle.toSigilLink());
  });

  await t.step("does not take a `toJSON()` of its own for a cell", () => {
    // The recognition is by class. Something merely offering a `toJSON()` is
    // not a cell, so `selected` is judged by its scalar, which it fails.
    const notAHandle = new (class {
      toJSON() {
        return { "/": { "link@1": { id: "of:fid1:abc" } } };
      }
    })();
    const event = new MockEvent("cf-tab-select", {
      target: { selected: notAHandle },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.selected, undefined);
  });

  await t.step("omits a target property that fails its own scalar", () => {
    const event = new MockEvent("input", {
      target: { name: 42, value: "kept" },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.name, undefined);
    assertEquals(serialized.target?.value, "kept");
  });

  await t.step(
    "carries a `bigint` in a detail rather than losing the detail",
    () => {
      // The whole detail used to go: a `bigint` throws out of `JSON.stringify()`,
      // and what answered was a description of the value it was handed rather
      // than of the member that could not be rendered.
      const event = new MockCustomEvent("custom", {
        detail: { message: "hello", count: 42n },
      }) as unknown as Event;

      const serialized = serializeEvent(event);

      assertEquals(serialized.detail, { message: "hello", count: 42n });
    },
  );

  await t.step("carries a `bigint` exposed as a target's value", () => {
    // Quieter than losing a detail and worse for it: this used to arrive as the
    // string `"42"`, which a handler has no way to tell from a real one.
    const event = new MockEvent("input", {
      target: { value: 42n },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.target?.value, 42n);
  });

  await t.step("carries a `CellHandle` handed over as a whole detail", () => {
    // The one way a handle reaches the general conversion: a target property is
    // checked for one before delegating, so this is a component emitting a
    // handle as the detail itself rather than inside a record.
    const handle = makeHandle();
    const event = new MockCustomEvent("custom", {
      detail: handle,
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals(serialized.detail, handle.toSigilLink());
  });

  await t.step("carries a `FabricBytes` in a detail as its own bytes", () => {
    // A fabric primitive's state is not enumerable properties, so the round
    // trip rendered one as `{}`.
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const event = new MockCustomEvent("custom", {
      detail: { blob: bytes },
    }) as unknown as Event;

    const serialized = serializeEvent(event);

    assertEquals((serialized.detail as { blob: unknown }).blob, bytes);
  });

  await t.step(
    "hands on a detail the crossing will refuse, unfabricated",
    () => {
      // `cf-error` carries an `Error`, and `cf-code-editor` alone raises six. Its
      // top layer is a plain record, so it crosses this seam; the member with no
      // fabric form is the producer's bug and is named by the encoding, which is
      // where a deep check here would have reached the same verdict at the cost
      // of a walk on every correct value.
      //
      // What matters is the half this seam owns: the value is handed on as it
      // was, not rendered into an empty record that a handler cannot tell from
      // real data.
      const error = new Error("boom");
      const event = new MockCustomEvent("cf-error", {
        detail: { error, message: "upload failed" },
      }) as unknown as Event;

      const serialized = serializeEvent(event);

      assertEquals((serialized.detail as { error: unknown }).error, error);
      assertThrows(
        () => realmFromFabricValue(serialized.detail!),
        Error,
        "Cannot encode instance",
      );
    },
  );

  await t.step("omits undefined properties", () => {
    const event = new MockEvent("click") as unknown as Event;
    const serialized = serializeEvent(event);

    // Should only have type
    assertEquals(Object.keys(serialized), ["type"]);
  });
});
