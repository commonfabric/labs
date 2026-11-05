# Form System Internals

Contributor documentation for the `cf-form` write-gate system. For the
pattern-author-facing view (usage, create/edit modes, the copy trap), see
[`docs/common/components/COMPONENTS.md`](../../../docs/common/components/COMPONENTS.md#cf-form).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ cf-form (provides FormContext)                              │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │ cf-input    │  │ cf-select   │  │ cf-checkbox │         │
│  │             │  │             │  │             │         │
│  │ FormField   │  │ FormField   │  │ FormField   │         │
│  │ Controller  │  │ Controller  │  │ Controller  │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│        │                │                │                  │
│        └────────────────┼────────────────┘                  │
│                         │                                   │
│               registerField() / getValue()                  │
│                         │                                   │
│                    ┌────▼────┐                              │
│                    │ submit  │ → validate all → flush all   │
│                    └─────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

`cf-form` provides `FormContext` to descendant fields via Lit context. On submit
it validates all fields, flushes buffers to bound cells, and emits `cf-submit`.
On reset it restores all fields to their initial cell values.

## Creating Form-Compatible Components

To make a custom component work with cf-form, use `FormFieldController`:

```typescript
// In a component file, e.g.
// runtime/ui/src/v2/components/my-custom-input/my-custom-input.ts
import { BaseElement } from "../../core/base-element.ts";
import { createStringCellController } from "../../core/cell-controller.ts";
import { createFormFieldController } from "../../core/form-field-controller.ts";

export class MyCustomInput extends BaseElement {
  // 1. Create a cell controller for the value
  private _cellController = createStringCellController(this, {
    timing: { strategy: "debounce", delay: 300 },
  });

  // 2. Create a form field controller that wraps the cell controller
  private _formField = createFormFieldController<string>(this, {
    cellController: this._cellController,
    validate: () => ({
      valid: this.checkValidity(),
      message: this.validationMessage,
    }),
  });

  // 3. Use formField for getValue/setValue
  private getValue(): string {
    return this._formField.getValue();
  }

  private setValue(value: string): void {
    this._formField.setValue(value);
  }

  // 4. Register with form in firstUpdated (after cell binding)
  override firstUpdated() {
    this._cellController.bind(this.value, stringSchema);
    this._formField.register(this.name); // Pass field name for form submission
  }

  // 5. Cleanup is automatic via ReactiveController
}
```

### FormFieldController API

```typescript
interface FormFieldControllerOptions<T> {
  // The cell controller managing the underlying reactive value
  cellController: CellControllerLike<T>;

  // Validation function for this field (called before form submit)
  validate?: () => ValidationResult;
}

class FormFieldController<T> {
  // Get value (returns buffer if in form, else cell value)
  getValue(): T;

  // Set value (buffers if in form, else writes to cell)
  setValue(value: T): void;

  // Register with form (call in firstUpdated after cell binding)
  register(name?: string): void;

  // Check if this field is inside a cf-form
  inFormContext: boolean;
}
```

## Validation

Fields use HTML5 constraint validation by default. Custom validation can be
provided via the `validate` option in FormFieldController:

```typescript
private _formField = createFormFieldController<string>(this, {
  cellController: this._cellController,
  validate: () => {
    // Custom validation logic
    if (this.getValue().length < 3) {
      return { valid: false, message: "Must be at least 3 characters" };
    }
    return { valid: true };
  },
});
```

## File Organization

```
runtime/ui/src/v2/
├── core/
│   ├── cell-controller.ts      # Cell reactivity
│   └── form-field-controller.ts # Form buffering abstraction
│
└── components/
    └── form/
        ├── form-context.ts     # FormContext interface
        ├── cf-form.ts          # Form element
        └── index.ts            # Exports
```

## Key Design Decisions

### Why buffer instead of draft cells?

Simpler implementation. Each field manages a plain value buffer rather than
creating temporary cell structures. The cell system handles reactivity; the form
system just gates when writes flush.

### Why FormFieldController instead of a mixin?

Controllers compose better with existing architecture. Components already use
CellController; FormFieldController layers on top without inheritance
complexity.

### Why deferred buffer initialization?

Avoids race conditions. Cell updates are batched, so reading the cell value
during component initialization may return stale data. By deferring buffer
initialization and falling back to cell value, edit mode works correctly.
