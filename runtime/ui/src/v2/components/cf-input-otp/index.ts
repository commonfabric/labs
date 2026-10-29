import { CFInputOTP } from "./cf-input-otp.ts";

if (!customElements.get("cf-input-otp")) {
  customElements.define("cf-input-otp", CFInputOTP);
}

export type { CFInputOTP as CFInputOTPElement } from "./cf-input-otp.ts";

export { CFInputOTP };
