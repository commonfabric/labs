import { NAME, pattern, UI, type VNode } from "commonfabric";
import MobileAppDemo from "../../../examples/mobile-app-demo/mobile-app-demo.tsx";

// deno-lint-ignore no-empty-interface
interface VignetteMobileAppInput {}
export interface VignetteMobileAppOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<VignetteMobileAppInput, VignetteMobileAppOutput>(() => {
  const demo = MobileAppDemo({});

  return {
    [NAME]: "Vignette: Mobile App",
    [UI]: <>{demo}</>,
    controls: <></>,
  };
});
