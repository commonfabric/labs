import { CFForm } from "./cf-form.ts";

if (!customElements.get("cf-form")) {
  customElements.define("cf-form", CFForm);
}

export type { CFForm as CFFormElement } from "./cf-form.ts";

export { CFForm };

// Re-export form context types and utilities
export {
  type FieldRegistration,
  type FormContext,
  formContext,
  type ValidationResult,
} from "./form-context.ts";
