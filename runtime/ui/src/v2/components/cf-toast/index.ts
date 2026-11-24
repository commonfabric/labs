import { CFToast } from "./cf-toast.ts";
import { CFToastProvider } from "./cf-toast-provider.ts";

if (!customElements.get("cf-toast")) {
  customElements.define("cf-toast", CFToast);
}

if (!customElements.get("cf-toast-provider")) {
  customElements.define("cf-toast-provider", CFToastProvider);
}

export type { CFToast as CFToastElement } from "./cf-toast.ts";
export type { CFToastProvider as CFToastProviderElement } from "./cf-toast-provider.ts";

export { CFToast, CFToastProvider };
