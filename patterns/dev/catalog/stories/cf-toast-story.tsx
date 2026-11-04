import { action, NAME, pattern, UI, type VNode, Writable } from "commonfabric";

// deno-lint-ignore no-empty-interface
interface ToastStoryInput {}
export interface ToastStoryOutput {
  [NAME]: string;
  [UI]: VNode;
  controls: VNode;
}

export default pattern<ToastStoryInput, ToastStoryOutput>(() => {
  const showDefault = new Writable(false);
  const showSuccess = new Writable(false);
  const showError = new Writable(false);
  const showWarning = new Writable(false);
  const showAction = new Writable(false);

  return {
    [NAME]: "cf-toast Story",
    [UI]: (
      <div style={{ padding: "1rem" }}>
        <cf-vstack gap="3">
          <cf-heading level={5}>Toast Variants</cf-heading>
          <cf-hstack gap="2">
            <cf-button
              color="neutral"
              variant="outline"
              onClick={action(() => showDefault.set(true))}
            >
              Default
            </cf-button>
            <cf-button
              color="neutral"
              variant="outline"
              onClick={action(() => showSuccess.set(true))}
            >
              Success
            </cf-button>
            <cf-button
              color="neutral"
              variant="outline"
              onClick={action(() => showError.set(true))}
            >
              Error
            </cf-button>
            <cf-button
              color="neutral"
              variant="outline"
              onClick={action(() => showWarning.set(true))}
            >
              Warning
            </cf-button>
            <cf-button
              color="primary"
              variant="solid"
              onClick={action(() => showAction.set(true))}
            >
              With Action
            </cf-button>
          </cf-hstack>
        </cf-vstack>

        <cf-toast-provider position="bottom">
          <cf-toast
            open={showDefault}
            status="info"
            duration={4000}
            oncf-toast-dismiss={action(() => showDefault.set(false))}
          >
            This is a default notification.
          </cf-toast>
          <cf-toast
            open={showSuccess}
            status="success"
            duration={4000}
            oncf-toast-dismiss={action(() => showSuccess.set(false))}
          >
            Changes saved successfully.
          </cf-toast>
          <cf-toast
            open={showError}
            status="error"
            duration={0}
            dismissible
            oncf-toast-dismiss={action(() => showError.set(false))}
          >
            Connection lost. Retrying...
          </cf-toast>
          <cf-toast
            open={showWarning}
            status="warning"
            duration={4000}
            oncf-toast-dismiss={action(() => showWarning.set(false))}
          >
            Storage almost full.
          </cf-toast>
          <cf-toast
            open={showAction}
            status="success"
            duration={5000}
            oncf-toast-dismiss={action(() => showAction.set(false))}
          >
            Wish sent.
            <cf-button
              slot="action"
              color="neutral"
              variant="outline"
              size="sm"
            >
              View
            </cf-button>
          </cf-toast>
        </cf-toast-provider>
      </div>
    ),
    controls: <></>,
  };
});
