import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  type TrustedActionWrite,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

export const TRUSTED_LONG_RUNNING_JOB_SURFACE = "TrustedLongRunningJobSurface";

const AUTHORIZE_LONG_RUNNING_JOB_ACTION = "TrustedAuthorizeLongRunningJob";
const CANCEL_LONG_RUNNING_JOB_ACTION = "TrustedCancelLongRunningJob";

export const authorizeTrustedLongRunningJob = handler<
  void,
  {
    jobName: Writable<string>;
    jobStatus: Writable<string>;
    jobAuthorization: Writable<string>;
  }
>((_, { jobName, jobStatus, jobAuthorization }) => {
  const name = jobName.get().trim() || "job";
  jobStatus.set("Running");
  jobAuthorization.set(`Authorized long-running job: ${name}`);
});

export const cancelTrustedLongRunningJob = handler<
  void,
  {
    jobName: Writable<string>;
    jobStatus: Writable<string>;
    jobCancellation: Writable<string>;
  }
>((_, { jobName, jobStatus, jobCancellation }) => {
  const name = jobName.get().trim() || "job";
  jobStatus.set("Cancelled");
  jobCancellation.set(`Cancelled long-running job: ${name}`);
});

export interface TrustedLongRunningJobSurfaceInput {
  jobName: Writable<string>;
  jobStatus: Writable<string>;
  jobAuthorization: Writable<string>;
  jobCancellation: Writable<string>;
}

export interface TrustedLongRunningJobSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  jobAuthorization: TrustedActionWrite<
    string,
    typeof authorizeTrustedLongRunningJob,
    typeof AUTHORIZE_LONG_RUNNING_JOB_ACTION,
    typeof TRUSTED_LONG_RUNNING_JOB_SURFACE
  >;
  jobCancellation: TrustedActionWrite<
    string,
    typeof cancelTrustedLongRunningJob,
    typeof CANCEL_LONG_RUNNING_JOB_ACTION,
    typeof TRUSTED_LONG_RUNNING_JOB_SURFACE
  >;
  startJob: Stream<void>;
  cancelJob: Stream<void>;
}

export const TrustedLongRunningJobSurface = pattern<
  TrustedLongRunningJobSurfaceInput,
  TrustedLongRunningJobSurfaceOutput
>(
  ({ jobName, jobStatus, jobAuthorization, jobCancellation }) => {
    const startJob = authorizeTrustedLongRunningJob({
      jobName,
      jobStatus,
      jobAuthorization,
    });
    const cancelJob = cancelTrustedLongRunningJob({
      jobName,
      jobStatus,
      jobCancellation,
    });

    return {
      [NAME]: computed(() => "Trusted Long Running Job Surface"),
      [UI]: (
        <cf-card
          id="trusted-long-running-job-surface"
          data-ui-pattern={TRUSTED_LONG_RUNNING_JOB_SURFACE}
          data-ui-event-integrity={TRUSTED_LONG_RUNNING_JOB_SURFACE}
        >
          <cf-vstack slot="content" gap="3">
            <cf-heading level={3}>Trusted long-running job</cf-heading>
            <cf-card data-ui-disclosure-kind="trusted-long-running-job-disclosure">
              <cf-vstack slot="content" gap="1">
                <cf-label>
                  Keep the job visible and cancelable while the trusted kernel
                  authorizes it.
                </cf-label>
              </cf-vstack>
            </cf-card>
            <cf-vgroup gap="sm">
              <cf-label for="trusted-job-name">Job name</cf-label>
              <cf-input
                id="trusted-job-name"
                $value={jobName}
                placeholder="Bulk export"
              />
            </cf-vgroup>
            <cf-hstack gap="2" wrap>
              <cf-button
                data-ui-action={AUTHORIZE_LONG_RUNNING_JOB_ACTION}
                onClick={startJob}
              >
                Authorize job
              </cf-button>
              <cf-button
                data-ui-action={CANCEL_LONG_RUNNING_JOB_ACTION}
                onClick={cancelJob}
              >
                Cancel job
              </cf-button>
            </cf-hstack>
            <cf-card>
              <cf-vstack slot="content" gap="2">
                <cf-label>Current status</cf-label>
                <div id="trusted-job-status">{jobStatus}</div>
                <cf-label>Authorization</cf-label>
                <div id="trusted-job-authorization">{jobAuthorization}</div>
                <cf-label>Cancellation</cf-label>
                <div id="trusted-job-cancellation">{jobCancellation}</div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-card>
      ),
      jobAuthorization,
      jobCancellation,
      startJob,
      cancelJob,
    };
  },
);
