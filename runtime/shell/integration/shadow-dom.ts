import { waitForCondition } from "@commonfabric/integration";
import type { Page } from "@commonfabric/integration";

export function pierce(page: Page, selector: string) {
  return page.waitForSelector(selector, { strategy: "pierce" });
}

export async function clickPierce(
  page: Page,
  selector: string,
): Promise<void> {
  // Wait until a rendered, enabled click target for `selector` exists, then
  // click it once. The last rendered match across shadow roots wins; if that
  // host wraps a shadow <button> the button is the target and must be enabled.
  // The waiter re-evaluates on DOM mutations and resolves the moment a target
  // is ready, rather than re-running the scan from the test process on a fixed
  // interval.
  await waitForCondition(page, (probe, targetSelector) => {
    function findClickableHost(
      root: Document | ShadowRoot,
    ): HTMLElement | null {
      const matches: HTMLElement[] = [];

      for (const match of root.querySelectorAll(targetSelector)) {
        if (match instanceof HTMLElement && probe.isRendered(match)) {
          matches.push(match);
        }
      }

      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) {
          const nested = findClickableHost(el.shadowRoot);
          if (nested) {
            matches.push(nested);
          }
        }
      }

      return matches.at(-1) ?? null;
    }

    const host = findClickableHost(document);
    if (!host) {
      return false;
    }

    const button = host.shadowRoot?.querySelector("button");
    if (button instanceof HTMLButtonElement) {
      if (button.disabled || !probe.isRendered(button)) {
        return false;
      }
      button.click();
      return true;
    }

    if (!probe.isRendered(host)) {
      return false;
    }

    host.click();
    return true;
  }, { args: [selector] });
}
