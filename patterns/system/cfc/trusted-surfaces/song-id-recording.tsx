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

export const TRUSTED_SONG_ID_RECORDING_SURFACE =
  "TrustedSongIdRecordingSurface";

const RECORD_SONG_ID_ACTION = "TrustedRecordSongId";

export const recordTrustedSongId = handler<
  void,
  {
    songHint: Writable<string>;
    identifiedSongId: Writable<string>;
  }
>((_, { songHint, identifiedSongId }) => {
  const normalized = songHint.get().trim().toLowerCase().replace(/\s+/g, "-");
  identifiedSongId.set(
    normalized ? `Mock song id: ${normalized}` : "Mock song id: unavailable",
  );
});

export interface TrustedSongIdRecordingSurfaceInput {
  songHint: Writable<string>;
  identifiedSongId: Writable<string>;
}

export interface TrustedSongIdRecordingSurfaceOutput {
  [NAME]: string;
  [UI]: VNode;
  identifiedSongId: TrustedActionWrite<
    string,
    typeof recordTrustedSongId,
    typeof RECORD_SONG_ID_ACTION,
    typeof TRUSTED_SONG_ID_RECORDING_SURFACE
  >;
  recordSongId: Stream<void>;
}

export const TrustedSongIdRecordingSurface = pattern<
  TrustedSongIdRecordingSurfaceInput,
  TrustedSongIdRecordingSurfaceOutput
>(({ songHint, identifiedSongId }) => {
  const recordSongId = recordTrustedSongId({
    songHint,
    identifiedSongId,
  });

  return {
    [NAME]: computed(() => "Trusted Song ID Recording Surface"),
    [UI]: (
      <cf-card
        id="trusted-song-id-recording-surface"
        data-ui-pattern={TRUSTED_SONG_ID_RECORDING_SURFACE}
        data-ui-event-integrity={TRUSTED_SONG_ID_RECORDING_SURFACE}
      >
        <cf-vstack slot="content" gap="3">
          <cf-heading level={3}>Trusted song ID recording</cf-heading>
          <cf-card data-ui-disclosure-kind="trusted-song-id-recording-disclosure">
            <cf-vstack slot="content" gap="1">
              <cf-label>
                Record only the song identification result, not raw audio.
              </cf-label>
            </cf-vstack>
          </cf-card>
          <cf-label>Mock classifier input</cf-label>
          <cf-label>{songHint}</cf-label>
          <cf-button
            data-ui-action={RECORD_SONG_ID_ACTION}
            onClick={recordSongId}
          >
            Record song ID
          </cf-button>
          <cf-card>
            <cf-vstack slot="content" gap="2">
              <cf-label>Identified song</cf-label>
              <div id="trusted-song-id-result">{identifiedSongId}</div>
            </cf-vstack>
          </cf-card>
        </cf-vstack>
      </cf-card>
    ),
    identifiedSongId,
    recordSongId,
  };
});
