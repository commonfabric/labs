import { assert, handler, pattern, TESTS } from "commonfabric";
import {
  BatchPhotoUploadJobExample,
  CalendarAvailabilityPolicyExample,
  DocumentExportJobExample,
  SongIdentificationRecordingExample,
} from "./process-examples.tsx";

type SongSuite = ReturnType<typeof SongIdentificationRecordingExample>;
type PolicySuite = ReturnType<typeof CalendarAvailabilityPolicyExample>;
type JobSuite = ReturnType<typeof BatchPhotoUploadJobExample>;
type ExportSuite = ReturnType<typeof DocumentExportJobExample>;

const runSong = handler<void, { suite: SongSuite }>((_, { suite }) => {
  suite.triggerDecoy.send();
  suite.recordSongId?.send();
});

const runPolicy = handler<void, { suite: PolicySuite }>((_, { suite }) => {
  suite.triggerDecoy.send();
  suite.saveSharePolicy?.send();
});

const runJob = handler<void, { suite: JobSuite }>((_, { suite }) => {
  suite.triggerDecoy.send();
  suite.startJob?.send();
  suite.cancelJob?.send();
});

const runExportJob = handler<void, { suite: ExportSuite }>((_, { suite }) => {
  suite.triggerDecoy.send();
  suite.startJob?.send();
});

export default pattern(() => {
  const song = SongIdentificationRecordingExample({});
  const policy = CalendarAvailabilityPolicyExample({});
  const photoJob = BatchPhotoUploadJobExample({});
  const exportJob = DocumentExportJobExample({});

  const assert_song_id_only = assert(() =>
    song.decoyStatus ===
      "Host raw-audio shortcut did not authorize recording; only song ID can be written." &&
    song.identifiedSongId!.includes("Mock song id")
  );

  const assert_policy_saved = assert(() =>
    policy.decoyStatus ===
      "Host full-calendar shortcut did not save policy; trusted surface scopes the contribution." &&
    policy.savedSharePolicy!.includes("free/busy windows only")
  );

  const assert_photo_job_visible_and_cancelable = assert(() =>
    photoJob.decoyStatus ===
      "Host all-photo shortcut did not authorize the job; the trusted job stays visible and cancelable." &&
    photoJob.jobStatus === "Cancelled" &&
    photoJob.jobAuthorization!.includes("Batch photo upload") &&
    photoJob.jobCancellation!.includes("Batch photo upload")
  );

  const assert_document_export_authorized = assert(() =>
    exportJob.decoyStatus ===
      "Host one-click export did not authorize the job; the trusted job surface controls export." &&
    exportJob.jobStatus === "Running" &&
    exportJob.jobAuthorization!.includes("Document export")
  );

  return {
    [TESTS]: [
      { action: runSong({ suite: song }) },
      { assertion: assert_song_id_only },
      { action: runPolicy({ suite: policy }) },
      { assertion: assert_policy_saved },
      { action: runJob({ suite: photoJob }) },
      { assertion: assert_photo_job_visible_and_cancelable },
      { action: runExportJob({ suite: exportJob }) },
      { assertion: assert_document_export_authorized },
    ],
    song,
    policy,
    photoJob,
    exportJob,
  };
});
