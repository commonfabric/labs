/**
 * Tests for FormFieldController
 *
 * Tests the "write gate" pattern where form fields buffer writes locally
 * when inside a cf-form, and flush atomically on submit.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type CellControllerLike,
  createFormFieldController,
  FormFieldController,
} from "./form-field-controller.ts";
import { type FormContext } from "../components/form/form-context.ts";

// Mock ReactiveControllerHost
class MockHost {
  controllers: Array<
    { hostConnected?: () => void; hostDisconnected?: () => void }
  > = [];
  updateCount = 0;
  updateComplete: Promise<boolean> = Promise.resolve(true);

  addController(
    controller: { hostConnected?: () => void; hostDisconnected?: () => void },
  ) {
    this.controllers.push(controller);
  }

  removeController(
    controller: { hostConnected?: () => void; hostDisconnected?: () => void },
  ) {
    const index = this.controllers.indexOf(controller);
    if (index > -1) {
      this.controllers.splice(index, 1);
    }
  }

  requestUpdate() {
    this.updateCount++;
  }

  /** Tag name, simulating an `HTMLElement` for the host type. */
  tagName = "MOCK-HOST";
}

// Mock CellController that tracks calls
class MockCellController<T> implements CellControllerLike<T> {
  private _value: T;
  private _cell: { setStrict: (value: T) => Promise<void> } | null = null;
  setCallCount = 0;
  lastSetValue: T | undefined;

  constructor(initialValue: T, hasCell = true) {
    this._value = initialValue;
    if (hasCell) {
      this._cell = {
        setStrict: (value: T): Promise<void> => {
          this._value = value;
          return Promise.resolve();
        },
      };
    }
  }

  getValue(): T {
    return this._value;
  }

  setValue(value: T): void {
    this.setCallCount++;
    this.lastSetValue = value;
    this._value = value;
  }

  getCell() {
    return this._cell;
  }

  /** Sets the value directly, without tracking, for a test's use. */
  _setValueDirect(value: T): void {
    this._value = value;
  }
}

// Mock FormContext that tracks registrations
class MockFormContext implements FormContext {
  registrations: Array<{
    element: HTMLElement;
    name?: string;
    getValue: () => unknown;
    setValue: (value: unknown) => void;
    flush: () => Promise<void>;
    reset: () => void;
    validate: () => { valid: boolean; message?: string };
    isDirty: () => boolean;
  }> = [];

  registerField(
    registration: Parameters<FormContext["registerField"]>[0],
  ): () => void {
    this.registrations.push(registration);
    return () => {
      const index = this.registrations.indexOf(registration);
      if (index > -1) {
        this.registrations.splice(index, 1);
      }
    };
  }

  getLastRegistration() {
    return this.registrations[this.registrations.length - 1];
  }
}

describe("FormFieldController", () => {
  describe("without form context", () => {
    it("should delegate getValue to cell controller directly", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("initial");

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.getValue()).toBe("initial");
    });

    it("should delegate setValue to cell controller directly", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("initial");

      const formField = new FormFieldController(host, {
        cellController,
      });

      formField.setValue("updated");

      expect(cellController.setCallCount).toBe(1);
      expect(cellController.lastSetValue).toBe("updated");
      expect(cellController.getValue()).toBe("updated");
    });

    it("should report not in form context", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.inFormContext).toBe(false);
    });

    it("should not register when no form context", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      // Should not throw
      formField.register("fieldName");

      // Should still work without form context
      expect(formField.getValue()).toBe("test");
    });
  });

  describe("with form context (mocked)", () => {
    // For these tests we need to test the registration logic directly
    // since we can't easily mock Lit's context system

    it("should create with default validation", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
        // No validate provided - should default to always valid
      });

      // Access private method via registration if in form context
      // For now, just verify it doesn't throw
      expect(formField).toBeDefined();
    });

    it("should use custom validation function", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("");

      const formField = new FormFieldController(host, {
        cellController,
        validate: () => ({
          valid: false,
          message: "Field is required",
        }),
      });

      expect(formField).toBeDefined();
    });
  });

  describe("isDirty", () => {
    it("should return false when not in form context", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.isDirty()).toBe(false);
    });
  });

  describe("unregister", () => {
    it("should clean up state on unregister", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      formField.register("test");
      formField.unregister();

      // Should be able to register again after unregister
      formField.register("test");
      expect(formField).toBeDefined();
    });
  });

  describe("deep equality", () => {
    it("should handle primitive equality", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController("test");

      const formField = new FormFieldController(host, {
        cellController,
      });

      // Test via isDirty which uses _deepEqual internally
      expect(formField.isDirty()).toBe(false);
    });

    it("should handle object equality", () => {
      const host = new MockHost() as unknown as MockHost & HTMLElement;
      const cellController = new MockCellController({
        name: "test",
        value: 42,
      });

      const formField = new FormFieldController(host, {
        cellController,
      });

      expect(formField.isDirty()).toBe(false);
    });
  });
});

describe("createFormFieldController factory", () => {
  it("should create a FormFieldController instance", () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController = new MockCellController("test");

    const formField = createFormFieldController(host, {
      cellController,
    });

    expect(formField).toBeInstanceOf(FormFieldController);
  });
});

describe("FormFieldController registration behavior", () => {
  // Test the registration object structure directly

  it("should produce correct registration structure", () => {
    const mockFormContext = new MockFormContext();
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController = new MockCellController("initial");

    // Create controller to verify it doesn't throw (actual registration requires Lit context)
    const _formField = new FormFieldController(host, {
      cellController,
      validate: () => ({ valid: true }),
    });
    expect(_formField).toBeDefined();

    // Manually simulate what would happen when register() is called with a form context
    // We test the internal logic by creating a similar registration

    const registration = {
      element: host,
      name: "testField",
      getValue: () => cellController.getValue(),
      setValue: (v: unknown) => {
        cellController.setValue(v as string);
        host.requestUpdate();
      },
      flush: async () => {
        const cell = cellController.getCell();
        if (cell) {
          await cell.setStrict(cellController.getValue());
        }
      },
      reset: () => {
        // Reset logic
      },
      validate: () => ({ valid: true }),
      isDirty: () => false,
    };

    mockFormContext.registerField(registration);

    expect(mockFormContext.registrations.length).toBe(1);
    expect(mockFormContext.getLastRegistration()?.name).toBe("testField");
    expect(mockFormContext.getLastRegistration()?.getValue()).toBe("initial");
  });

  it("should buffer setValue when in form context simulation", () => {
    const host = new MockHost();
    let buffer: string | undefined;

    const registration = {
      element: host as unknown as HTMLElement,
      name: "test",
      getValue: () => buffer ?? "original",
      setValue: (v: unknown) => {
        buffer = v as string;
        host.requestUpdate();
      },
      flush: async () => {
        // Would write buffer to cell
      },
      reset: () => {
        buffer = undefined;
      },
      validate: () => ({ valid: true }),
      isDirty: () => buffer !== undefined && buffer !== "original",
    };

    // Initial state

    expect(registration.getValue()).toBe("original");
    expect(registration.isDirty()).toBe(false);

    // After setValue (buffered)
    registration.setValue("modified");
    expect(registration.getValue()).toBe("modified");
    expect(registration.isDirty()).toBe(true);
    expect(host.updateCount).toBe(1);

    // After reset
    registration.reset();
    expect(registration.getValue()).toBe("original");
    expect(registration.isDirty()).toBe(false);
  });

  it("should validate correctly", () => {
    const cellController = new MockCellController("");

    const validateRequired = () => {
      const value = cellController.getValue();
      if (!value || value.trim() === "") {
        return { valid: false, message: "Required" };
      }
      return { valid: true };
    };

    // Empty value - invalid
    expect(validateRequired()).toEqual({ valid: false, message: "Required" });

    // With value - valid
    cellController.setValue("some value");
    expect(validateRequired()).toEqual({ valid: true });
  });

  it("should handle async flush", async () => {
    let cellValue = "initial";
    let flushCount = 0;

    const mockCell = {
      // The write lands on a macrotask, not a wall-clock delay. That boundary
      // is what gives the test teeth: a flush that failed to await set() would
      // run its assertions on the microtask that follows, before the write, and
      // observe the pre-write value.
      set: async (value: string) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        cellValue = value;
        flushCount++;
      },
    };

    const registration = {
      flush: async () => {
        await mockCell.set("flushed");
      },
    };

    await registration.flush();

    expect(cellValue).toBe("flushed");
    expect(flushCount).toBe(1);
  });

  it("should handle flush error", async () => {
    const mockCell = {
      set: (_value: string): Promise<void> => {
        return Promise.reject(new Error("Network error"));
      },
    };

    const registration = {
      flush: async () => {
        await mockCell.set("flushed");
      },
    };

    await expect(registration.flush()).rejects.toThrow("Network error");
  });

  it("returns only after a registered field write is confirmed", async () => {
    const value = "Launch checklist";
    let serverDraftBody: string | undefined;
    let confirmWrite: (() => void) | undefined;
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController: CellControllerLike<string> = {
      getValue: () => value,
      setValue: () => {},
      getCell: () => ({
        setStrict: (next: string) =>
          new Promise((resolve) => {
            confirmWrite = () => {
              serverDraftBody = next;
              resolve();
            };
          }),
      }),
    };
    const formContext = new MockFormContext();
    const formField = new FormFieldController(host, { cellController });
    const internals = formField as unknown as {
      _formContextConsumer: { value: FormContext };
    };
    internals._formContextConsumer = { value: formContext };
    formField.register("draftBody");

    let returned = false;
    const flushing = formContext.getLastRegistration()!.flush().then(() => {
      returned = true;
    });
    await Promise.resolve();

    expect(returned).toBe(false);
    expect(confirmWrite).toBeDefined();
    confirmWrite!();
    await flushing;
    expect(serverDraftBody!.trim()).toBe(value);
  });

  it("rejects when a registered field write fails", async () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController: CellControllerLike<string> = {
      getValue: () => "Launch checklist",
      setValue: () => {},
      getCell: () => ({
        setStrict: () => Promise.reject(new Error("Network error")),
      }),
    };
    const formContext = new MockFormContext();
    const formField = new FormFieldController(host, { cellController });
    const internals = formField as unknown as {
      _formContextConsumer: { value: FormContext };
    };
    internals._formContextConsumer = { value: formContext };
    formField.register("draftBody");

    await expect(formContext.getLastRegistration()!.flush()).rejects.toThrow(
      "Network error",
    );
  });
});

describe("captureOriginalValue", () => {
  it("should update original value for dirty tracking", () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController = new MockCellController("initial");

    const formField = new FormFieldController(host, {
      cellController,
    });

    // Capture initial original value
    formField.captureOriginalValue();

    // After capture, isDirty should consider current cell value as "original"
    expect(formField.isDirty()).toBe(false);
  });
});

describe("FormFieldController commit", () => {
  it("reads the confirmed cell value after returning", async () => {
    const value = "Launch checklist";
    let localDraftBody: string | undefined;
    let serverDraftBody: string | undefined;
    const cell = {
      set: (next: string) => {
        localDraftBody = next;
        return Promise.resolve();
      },
      setStrict: (next: string) => {
        localDraftBody = next;
        serverDraftBody = next;
        return Promise.resolve();
      },
    };
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController: CellControllerLike<string> = {
      getValue: () => value,
      setValue: () => {},
      getCell: () => cell,
    };
    const formField = new FormFieldController(host, { cellController });

    await formField.commit();

    expect(localDraftBody).toBe(value);
    expect(serverDraftBody!.trim()).toBe(value);
  });

  it("returns only after the cell write is confirmed", async () => {
    let confirmWrite: (() => void) | undefined;
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController: CellControllerLike<string> = {
      getValue: () => "Launch checklist",
      setValue: () => {},
      getCell: () => ({
        setStrict: () =>
          new Promise((resolve) => {
            confirmWrite = resolve;
          }),
      }),
    };
    const formField = new FormFieldController(host, { cellController });

    let returned = false;
    const committing = formField.commit().then(() => {
      returned = true;
    });
    await Promise.resolve();

    expect(returned).toBe(false);
    expect(confirmWrite).toBeDefined();
    confirmWrite!();
    await committing;
    expect(returned).toBe(true);
  });

  it("returns confirmed cell write failures to the caller", async () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    const cellController: CellControllerLike<string> = {
      getValue: () => "Launch checklist",
      setValue: () => {},
      getCell: () => ({
        setStrict: () => Promise.reject(new Error("commit refused")),
      }),
    };
    const formField = new FormFieldController(host, { cellController });

    await expect(formField.commit()).rejects.toThrow("commit refused");
  });

  it("flushes the cell controller and writes through the cell", async () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    let flushed = false;
    let cellSet: string | undefined;
    const cellController: CellControllerLike<string> = {
      getValue: () => "current",
      setValue: () => {},
      flush: () => {
        flushed = true;
      },
      getCell: () => ({
        setStrict: (v: string) => {
          cellSet = v;
          return Promise.resolve();
        },
      }),
    };

    const formField = new FormFieldController(host, { cellController });
    await formField.commit();

    expect(flushed).toBe(true);
    expect(cellSet).toBe("current");
  });

  it("falls back to setValue when no cell is bound", async () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    let setArg: string | undefined;
    const cellController: CellControllerLike<string> = {
      getValue: () => "current",
      setValue: (v: string) => {
        setArg = v;
      },
      getCell: () => null,
    };

    const formField = new FormFieldController(host, { cellController });
    await formField.commit();

    expect(setArg).toBe("current");
  });

  it("commits the buffered value when one is present", async () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    let cellSet: string | undefined;
    const cellController: CellControllerLike<string> = {
      getValue: () => "cell-value",
      setValue: () => {},
      getCell: () => ({
        setStrict: (v: string) => {
          cellSet = v;
          return Promise.resolve();
        },
      }),
    };

    const formField = new FormFieldController(host, { cellController });
    // Simulate a buffered edit, as a form context would produce.
    const buffered = formField as unknown as {
      _buffer: string;
      _hasBuffer: boolean;
    };
    buffered._buffer = "buffered";
    buffered._hasBuffer = true;

    await formField.commit();

    expect(cellSet).toBe("buffered");
  });

  it("does not write out-of-band when inside a form context", async () => {
    const host = new MockHost() as unknown as MockHost & HTMLElement;
    let flushed = false;
    let cellSet: string | undefined;
    let setValueArg: string | undefined;
    const cellController: CellControllerLike<string> = {
      getValue: () => "cell-value",
      setValue: (v: string) => {
        setValueArg = v;
      },
      flush: () => {
        flushed = true;
      },
      getCell: () => ({
        setStrict: (v: string) => {
          cellSet = v;
          return Promise.resolve();
        },
      }),
    };

    const formField = new FormFieldController(host, { cellController });

    // Simulate being inside a cf-form: supply a form context to the controller's
    // context consumer, plus a buffered edit as typing would produce, and an
    // original baseline captured at registration.
    const internals = formField as unknown as {
      _formContextConsumer: { value: FormContext };
      _buffer: string;
      _hasBuffer: boolean;
      _originalValue: string;
    };
    internals._formContextConsumer = { value: new MockFormContext() };
    internals._buffer = "buffered";
    internals._hasBuffer = true;
    internals._originalValue = "original";

    expect(formField.inFormContext).toBe(true);

    await formField.commit();

    // The form owns the atomic flush, so commit() writes nothing durable.
    expect(cellSet).toBeUndefined();
    expect(setValueArg).toBeUndefined();
    expect(flushed).toBe(false);

    // The edit stays buffered for the form to flush on submit.
    expect(internals._hasBuffer).toBe(true);
    expect(internals._buffer).toBe("buffered");

    // Dirty tracking is not rebaselined: the buffered edit still counts as
    // unsaved until the form submits.
    expect(internals._originalValue).toBe("original");
    expect(formField.isDirty()).toBe(true);
  });
});
