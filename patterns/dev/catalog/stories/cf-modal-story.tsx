import { action, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

import {
  Controls,
  SelectControl,
  SwitchControl,
} from "../ui/controls/index.ts";

// deno-lint-ignore no-empty-interface
interface ModalStoryInput {}
export interface ModalStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ModalStoryInput, ModalStoryOutput>(() => {
  const dialogOpen = new Writable(false);
  const sheetOpen = new Writable(false);
  const size = new Writable<"sm" | "md" | "lg" | "full">("md");
  const dismissible = new Writable(true);
  const grabber = new Writable(true);
  const detent = new Writable<"auto" | "half" | "full">("auto");

  const openDialog = action(() => dialogOpen.set(true));
  const closeDialog = action(() => dialogOpen.set(false));
  const openSheet = action(() => sheetOpen.set(true));
  const closeSheet = action(() => sheetOpen.set(false));

  return {
    [NAME]: "cf-modal Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <cf-hstack gap="3">
          <cf-button color="primary" variant="solid" onClick={openDialog}>
            Open Dialog
          </cf-button>
          <cf-button color="neutral" variant="outline" onClick={openSheet}>
            Open Sheet
          </cf-button>
        </cf-hstack>

        <cf-modal
          $open={dialogOpen}
          presentation="dialog"
          size={size}
          dismissible={dismissible}
        >
          <div slot="header">
            <cf-heading level={4}>Dialog Modal</cf-heading>
          </div>
          <cf-vstack gap="2">
            <span>This is a centered dialog modal.</span>
            <span style="color: var(--cf-theme-color-text-muted); font-size: 0.875rem;">
              Uses fade + scale animation. Width controlled by the size
              attribute.
            </span>
          </cf-vstack>
          <div slot="footer">
            <cf-hstack gap="2" justify="end">
              <cf-button
                color="neutral"
                variant="outline"
                onClick={closeDialog}
              >
                Cancel
              </cf-button>
              <cf-button color="primary" variant="solid" onClick={closeDialog}>
                Confirm
              </cf-button>
            </cf-hstack>
          </div>
        </cf-modal>

        <cf-modal
          $open={sheetOpen}
          presentation="sheet"
          grabber={grabber}
          detent={detent}
          dismissible={dismissible}
        >
          <div slot="header">
            <cf-heading level={4}>Sheet Modal</cf-heading>
          </div>
          <cf-vstack gap="2">
            <span>This is a bottom sheet modal.</span>
            <span style="color: var(--cf-theme-color-text-muted); font-size: 0.875rem;">
              Slides up from bottom with iOS-style animation. Height controlled
              by the detent attribute.
            </span>
          </cf-vstack>
          <div slot="footer">
            <cf-hstack gap="2" justify="end">
              <cf-button color="neutral" variant="outline" onClick={closeSheet}>
                Cancel
              </cf-button>
              <cf-button color="primary" variant="solid" onClick={closeSheet}>
                Done
              </cf-button>
            </cf-hstack>
          </div>
        </cf-modal>
      </div>
    ),
    controls: (
      <Controls>
        <>
          <SelectControl
            label="size"
            description="Dialog width preset"
            defaultValue="md"
            value={size}
            items={[
              { label: "Small", value: "sm" },
              { label: "Medium", value: "md" },
              { label: "Large", value: "lg" },
              { label: "Full", value: "full" },
            ]}
          />
          <SelectControl
            label="detent"
            description="Sheet max height"
            defaultValue="auto"
            value={detent}
            items={[
              { label: "Auto", value: "auto" },
              { label: "Half", value: "half" },
              { label: "Full", value: "full" },
            ]}
          />
          <SwitchControl
            label="grabber"
            description="Show drag-handle indicator on sheet"
            defaultValue="true"
            checked={grabber}
          />
          <SwitchControl
            label="dismissible"
            description="Allow closing via backdrop click or Escape"
            defaultValue="true"
            checked={dismissible}
          />
        </>
      </Controls>
    ),
  };
});
