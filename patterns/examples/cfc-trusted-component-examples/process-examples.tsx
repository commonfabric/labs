import {
  computed,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  TrustedLongRunningJobSurface,
  TrustedSharePolicySurface,
  TrustedSongIdRecordingSurface,
} from "../../system/cfc/trusted-surfaces/mod.ts";

export type ProcessExampleOutput = {
  [NAME]: string;
  [UI]: VNode;
  decoyStatus: string;
  songHint?: string;
  identifiedSongId?: string;
  policyAudience?: string;
  policyScope?: string;
  savedSharePolicy?: string;
  jobName?: string;
  jobStatus?: string;
  jobAuthorization?: string;
  jobCancellation?: string;
  recordSongId?: Stream<void>;
  saveSharePolicy?: Stream<void>;
  startJob?: Stream<void>;
  cancelJob?: Stream<void>;
  triggerDecoy: Stream<void>;
};

const setDecoyStatus = handler<
  void,
  { decoyStatus: Writable<string>; message: string }
>((_, { decoyStatus, message }) => {
  decoyStatus.set(message);
});

export const SongIdentificationRecordingExample = pattern<
  Record<PropertyKey, never>,
  ProcessExampleOutput
>(() => {
  const songHint = new Writable("Hum from captured microphone buffer");
  const identifiedSongId = new Writable("");
  const decoyStatus = new Writable("Raw-audio host shortcut is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message:
      "Host raw-audio shortcut did not authorize recording; only song ID can be written.",
  });
  const trusted = TrustedSongIdRecordingSurface({
    songHint,
    identifiedSongId,
  });

  return {
    [NAME]: computed(() => "Song Identification Recording"),
    [UI]: (
      <cf-screen title="Song Identification Recording">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted recording host</cf-heading>
              <cf-label>
                The host mocks the audio capture pipeline, but the trusted
                surface only records the derived song identifier.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Record raw audio</cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    songHint,
    identifiedSongId,
    decoyStatus,
    recordSongId: trusted.recordSongId,
    triggerDecoy,
  };
});

export const CalendarAvailabilityPolicyExample = pattern<
  Record<PropertyKey, never>,
  ProcessExampleOutput
>(() => {
  const policyAudience = new Writable("calendar:project-sync participants");
  const policyScope = new Writable("free/busy windows only");
  const savedSharePolicy = new Writable("");
  const decoyStatus = new Writable("Full-calendar host shortcut is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message:
      "Host full-calendar shortcut did not save policy; trusted surface scopes the contribution.",
  });
  const trusted = TrustedSharePolicySurface({
    policyAudience,
    policyScope,
    savedSharePolicy,
  });

  return {
    [NAME]: computed(() => "Calendar Availability Policy"),
    [UI]: (
      <cf-screen title="Calendar Availability Policy">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted scheduling host</cf-heading>
              <cf-label>
                The host frames this as scheduling convenience, while the
                trusted policy surface restricts the process to availability
                contribution.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Share full calendar
              </cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    policyAudience,
    policyScope,
    savedSharePolicy,
    decoyStatus,
    saveSharePolicy: trusted.saveSharePolicy,
    triggerDecoy,
  };
});

export const BatchPhotoUploadJobExample = pattern<
  Record<PropertyKey, never>,
  ProcessExampleOutput
>(() => {
  const jobName = new Writable("Batch photo upload: selected album");
  const jobStatus = new Writable("Idle");
  const jobAuthorization = new Writable("");
  const jobCancellation = new Writable("");
  const decoyStatus = new Writable("All-photo upload host shortcut is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message:
      "Host all-photo shortcut did not authorize the job; the trusted job stays visible and cancelable.",
  });
  const trusted = TrustedLongRunningJobSurface({
    jobName,
    jobStatus,
    jobAuthorization,
    jobCancellation,
  });

  return {
    [NAME]: computed(() => "Batch Photo Upload Job"),
    [UI]: (
      <cf-screen title="Batch Photo Upload Job">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted photo host</cf-heading>
              <cf-label>
                The process is modeled as a visible long-running job with
                trusted authorization and cancellation.
              </cf-label>
              <cf-button onClick={triggerDecoy}>Upload all photos</cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    jobName,
    jobStatus,
    jobAuthorization,
    jobCancellation,
    decoyStatus,
    startJob: trusted.startJob,
    cancelJob: trusted.cancelJob,
    triggerDecoy,
  };
});

export const DocumentExportJobExample = pattern<
  Record<PropertyKey, never>,
  ProcessExampleOutput
>(() => {
  const jobName = new Writable("Document export: redacted bundle");
  const jobStatus = new Writable("Idle");
  const jobAuthorization = new Writable("");
  const jobCancellation = new Writable("");
  const decoyStatus = new Writable("One-click export host shortcut is idle.");
  const triggerDecoy = setDecoyStatus({
    decoyStatus,
    message:
      "Host one-click export did not authorize the job; the trusted job surface controls export.",
  });
  const trusted = TrustedLongRunningJobSurface({
    jobName,
    jobStatus,
    jobAuthorization,
    jobCancellation,
  });

  return {
    [NAME]: computed(() => "Document Export Job"),
    [UI]: (
      <cf-screen title="Document Export Job">
        <cf-vstack gap="3" style={{ padding: "1rem" }}>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-heading level={3}>Untrusted document host</cf-heading>
              <cf-label>
                The export process is explicit, visible, and cancelable instead
                of an ambient host-side side effect.
              </cf-label>
              <cf-button onClick={triggerDecoy}>
                Export without trusted job
              </cf-button>
              <div>{decoyStatus}</div>
            </cf-vstack>
          </cf-card>
          {trusted}
        </cf-vstack>
      </cf-screen>
    ),
    jobName,
    jobStatus,
    jobAuthorization,
    jobCancellation,
    decoyStatus,
    startJob: trusted.startJob,
    cancelJob: trusted.cancelJob,
    triggerDecoy,
  };
});

const EXAMPLE_TITLES = [
  "Song Identification Recording",
  "Calendar Availability Policy",
  "Batch Photo Upload Job",
  "Document Export Job",
] as const;

export default pattern<Record<PropertyKey, never>>(() => ({
  [NAME]: computed(() => "Process Trusted Component Examples"),
  [UI]: (
    <cf-screen title="Process Trusted Component Examples">
      <cf-vstack gap="3" style={{ padding: "1rem" }}>
        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-heading level={2}>Process-oriented trusted UI demos</cf-heading>
            <cf-label>
              These untrusted hosts model processes rather than single release
              buttons: derived song-ID recording, scoped availability policy,
              and visible long-running jobs.
            </cf-label>
            <cf-label>
              The gallery currently exposes {EXAMPLE_TITLES.length}{" "}
              example patterns.
            </cf-label>
          </cf-vstack>
        </cf-card>
        <cf-card>
          <cf-vstack slot="content" gap="2">
            <cf-heading level={3}>Catalog</cf-heading>
            {EXAMPLE_TITLES.map((title, index) => (
              <div>
                {index + 1}. {title}
              </div>
            ))}
          </cf-vstack>
        </cf-card>
        <div>{SongIdentificationRecordingExample({})}</div>
        <div>{CalendarAvailabilityPolicyExample({})}</div>
        <div>{BatchPhotoUploadJobExample({})}</div>
        <div>{DocumentExportJobExample({})}</div>
      </cf-vstack>
    </cf-screen>
  ),
  exampleCount: EXAMPLE_TITLES.length,
}));
