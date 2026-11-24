// First, so that the document it installs is there when Lit loads.
import { mount, settle } from "../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { ReactiveElement } from "lit";

import { CFForm } from "../components/form/index.ts";
import type { ValidationResult } from "../components/form/form-context.ts";
import {
  type CellControllerLike,
  createFormFieldController,
  FormFieldController,
} from "./form-field-controller.ts";

/**
 * A cell controller holding `value`, which records what it is asked to do. A
 * bound cell's writes wait for the test to confirm or fail them.
 */
class FakeCellController implements CellControllerLike<string | undefined> {
  /** Every `setValue()` and confirmed cell write, in order. */
  readonly log: string[] = [];
  /** What settles each cell write still waiting, in order. */
  readonly pending: PromiseWithResolvers<void>[] = [];
  #value: string | undefined;
  #bound: boolean;

  constructor(value: string | undefined, { bound = true } = {}) {
    this.#value = value;
    this.#bound = bound;
  }

  getValue(): string | undefined {
    return this.#value;
  }

  setValue(value: string | undefined): void {
    this.log.push(`setValue ${value}`);
    this.#value = value;
  }

  flush(): void {
    this.log.push("flush");
  }

  getCell() {
    if (!this.#bound) return null;
    return {
      setStrict: async (value: string | undefined) => {
        const write = Promise.withResolvers<void>();
        this.pending.push(write);
        await write.promise;
        this.log.push(`setStrict ${value}`);
        this.#value = value;
      },
    };
  }

  /** Confirms every cell write waiting. */
  confirmWrites(): void {
    for (const write of this.pending.splice(0)) write.resolve();
  }
}

/** A form field built on a {@link FormFieldController}, as a component is. */
class Field extends ReactiveElement {
  readonly formField: FormFieldController<string | undefined>;
  updates = 0;

  constructor(
    readonly cell: FakeCellController,
    validate?: () => ValidationResult,
  ) {
    super();
    this.formField = createFormFieldController(this, {
      cellController: cell,
      validate,
    });
  }

  protected override firstUpdated(): void {
    this.formField.register();
  }

  protected override updated(): void {
    this.updates++;
  }
}
customElements.define("form-field-controller-field", Field);

/** A field on `cell`, mounted on its own. */
const standalone = (cell: FakeCellController) => mount(new Field(cell));

/** A field on `cell`, mounted in a `cf-form`, and the form's events. */
async function inForm(
  cell: FakeCellController,
  validate?: () => ValidationResult,
) {
  const form = new CFForm();
  const field = new Field(cell, validate);
  form.append(field);
  await mount(form);
  await field.updateComplete;
  const events: { type: string; detail: unknown }[] = [];
  for (const type of ["cf-submit", "cf-form-invalid"]) {
    form.addEventListener(type, (event) => {
      if (event instanceof CustomEvent) {
        events.push({ type, detail: event.detail });
      }
    });
  }
  return { form, field, events };
}

describe("FormFieldController", () => {
  afterEach(() => document.body.replaceChildren());

  describe("outside a form", () => {
    it("is not in a form context", async () => {
      const field = await standalone(new FakeCellController("a"));
      expect(field.formField.inFormContext).toBe(false);
    });

    it("reads and writes through the cell controller", async () => {
      const cell = new FakeCellController("a");
      const field = await standalone(cell);
      field.formField.setValue("b");
      expect(cell.log).toEqual(["setValue b"]);
      expect(field.formField.getValue()).toBe("b");
    });

    describe("commit()", () => {
      it("flushes the cell controller, then settles once the cell write is confirmed", async () => {
        const cell = new FakeCellController("a");
        const field = await standalone(cell);
        let settled = false;
        const committing = field.formField.commit().then(() => settled = true);
        await settle();
        expect(settled).toBe(false);
        expect(cell.log).toEqual(["flush"]);

        cell.confirmWrites();
        await committing;
        expect(cell.log).toEqual(["flush", "setStrict a"]);
      });

      it("rejects with the cell write's failure", async () => {
        const cell = new FakeCellController("a");
        const field = await standalone(cell);
        const committing = field.formField.commit();
        await settle();
        cell.pending[0].reject(new Error("commit refused"));
        await expect(committing).rejects.toThrow("commit refused");
      });

      it("writes through `setValue()` where no cell is bound", async () => {
        const cell = new FakeCellController("a", { bound: false });
        const field = await standalone(cell);
        await field.formField.commit();
        expect(cell.log).toEqual(["flush", "setValue a"]);
      });
    });
  });

  describe("in a `cf-form`", () => {
    it("is in a form context", async () => {
      const { field } = await inForm(new FakeCellController("a"));
      expect(field.formField.inFormContext).toBe(true);
    });

    it("buffers a value set, leaving the cell controller untouched", async () => {
      const cell = new FakeCellController("a");
      const { field } = await inForm(cell);
      const updates = field.updates;
      field.formField.setValue("b");
      await field.updateComplete;
      expect(field.formField.getValue()).toBe("b");
      expect(cell.getValue()).toBe("a");
      expect(cell.log).toEqual([]);
      expect(field.updates).toBe(updates + 1);
    });

    it("reads the cell controller's value until a value is buffered", async () => {
      const { field } = await inForm(new FakeCellController("a"));
      expect(field.formField.getValue()).toBe("a");
    });

    it("writes nothing on `commit()`, leaving the edit buffered for the form", async () => {
      const cell = new FakeCellController("a");
      const { field } = await inForm(cell);
      field.formField.setValue("b");
      await field.formField.commit();
      expect(cell.log).toEqual([]);
      expect(field.formField.getValue()).toBe("b");
    });

    describe("a submission", () => {
      it("writes the buffered value to the cell, and fires `cf-submit` once it is confirmed", async () => {
        const cell = new FakeCellController("a");
        const { form, field, events } = await inForm(cell);
        field.formField.setValue("b");
        form.submit();
        await settle();
        expect(events).toEqual([]);

        cell.confirmWrites();
        await settle();
        expect(cell.log).toEqual(["setStrict b"]);
        expect(events.map((event) => event.type)).toEqual(["cf-submit"]);
      });

      it("writes the cell controller's value where nothing is buffered", async () => {
        const cell = new FakeCellController("a");
        const { form } = await inForm(cell);
        form.submit();
        await settle();
        cell.confirmWrites();
        await settle();
        expect(cell.log).toEqual(["setStrict a"]);
      });

      it("writes through `setValue()` where no cell is bound", async () => {
        const cell = new FakeCellController("a", { bound: false });
        const { form, field } = await inForm(cell);
        field.formField.setValue("b");
        form.submit();
        await settle();
        expect(cell.log).toEqual(["setValue b"]);
      });

      it("makes the value written the one a reset restores", async () => {
        const cell = new FakeCellController("a", { bound: false });
        const { form, field } = await inForm(cell);
        field.formField.setValue("b");
        form.submit();
        await settle();
        cell.setValue("c");
        form.reset();
        expect(cell.getValue()).toBe("b");
      });

      it("finds a field valid where it gives no validation", async () => {
        const cell = new FakeCellController("a");
        const { form, events } = await inForm(cell);
        form.submit();
        await settle();
        cell.confirmWrites();
        await settle();
        expect(events.map((event) => event.type)).toEqual(["cf-submit"]);
      });

      it("fires `cf-form-invalid` with the field's validation, and writes nothing", async () => {
        const cell = new FakeCellController("");
        const { form, field, events } = await inForm(
          cell,
          () => ({ valid: false, message: "Required" }),
        );
        form.submit();
        await settle();
        expect(events).toEqual([{
          type: "cf-form-invalid",
          detail: { errors: [{ element: field, message: "Required" }] },
        }]);
        expect(cell.pending).toEqual([]);
      });

      it("writes nothing for a field taken out of the form", async () => {
        const cell = new FakeCellController("a");
        const { form, field } = await inForm(cell);
        field.formField.setValue("b");
        field.remove();
        form.submit();
        await settle();
        expect(cell.pending).toEqual([]);
        expect(cell.log).toEqual([]);
      });
    });

    describe("a reset", () => {
      it("restores the value the field held when it registered, and drops the buffer", async () => {
        const cell = new FakeCellController("a");
        const { form, field } = await inForm(cell);
        cell.setValue("b");
        field.formField.setValue("c");
        const updates = field.updates;
        form.reset();
        await field.updateComplete;
        expect(cell.log).toEqual(["setValue b", "setValue a"]);
        expect(field.formField.getValue()).toBe("a");
        expect(field.updates).toBe(updates + 1);
      });

      it("writes nothing where the field held no value when it registered", async () => {
        const cell = new FakeCellController(undefined);
        const { form, field } = await inForm(cell);
        field.formField.setValue("b");
        form.reset();
        expect(cell.log).toEqual([]);
        expect(field.formField.getValue()).toBeUndefined();
      });
    });

    describe("register()", () => {
      it("keeps the value a reset restores from the first registration", async () => {
        const cell = new FakeCellController("a");
        const { form, field } = await inForm(cell);
        cell.setValue("b");
        field.formField.register();
        form.reset();
        expect(cell.getValue()).toBe("a");
      });
    });

    describe("clearBuffer()", () => {
      it("drops the buffered value, and makes the cell controller's value the one a reset restores", async () => {
        const cell = new FakeCellController("a");
        const { form, field } = await inForm(cell);
        field.formField.setValue("b");
        cell.setValue("c");
        field.formField.clearBuffer();
        expect(field.formField.getValue()).toBe("c");

        cell.setValue("d");
        form.reset();
        expect(cell.getValue()).toBe("c");
      });
    });
  });
});
