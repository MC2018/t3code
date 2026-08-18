/**
 * Push-to-talk dictation for the mobile composer.
 *
 * Records with expo-audio and uploads the clip to the connected environment,
 * which transcribes it on the host machine. Recording happens on the phone;
 * the model runs on whatever hardware the server has.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from "expo-audio";

import { transcribeRecording, type VoiceEnvironmentConnection } from "./voiceApi";

/**
 * Speech does not benefit from stereo or a high bit rate, and the clip is
 * uploaded over whatever connection the phone has, so mono LOW_QUALITY keeps
 * uploads small. The backend resamples to 16 kHz regardless.
 */
const DICTATION_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.LOW_QUALITY,
  numberOfChannels: 1,
};

/** Matches the .m4a container the presets record into. */
const DICTATION_CONTENT_TYPE = "audio/mp4";

export type VoiceInputState = "idle" | "recording" | "transcribing";

export interface VoiceInputController {
  readonly state: VoiceInputState;
  readonly toggle: () => void;
}

export function useVoiceInput(input: {
  readonly connection: VoiceEnvironmentConnection | null;
  readonly onTranscript: (text: string) => void;
  readonly onError: (message: string) => void;
}): VoiceInputController {
  const [state, setState] = useState<VoiceInputState>("idle");
  const recorder = useAudioRecorder(DICTATION_RECORDING_OPTIONS);

  const unmountedRef = useRef(false);
  const busyRef = useRef(false);

  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const start = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        inputRef.current.onError("Microphone access was denied.");
        return;
      }
      // iOS records at a usable level only once the session is in a recording
      // mode; without this the clip comes back silent.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      await recorder.prepareToRecordAsync();
      recorder.record();
      if (!unmountedRef.current) setState("recording");
    } catch (error) {
      if (!unmountedRef.current) setState("idle");
      inputRef.current.onError(error instanceof Error ? error.message : String(error));
    } finally {
      busyRef.current = false;
    }
  }, [recorder]);

  const stop = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await recorder.stop();
      const fileUri = recorder.uri;
      // Releasing the recording mode lets normal playback volume return on iOS.
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);

      const connection = inputRef.current.connection;
      if (fileUri === null || connection === null) {
        if (!unmountedRef.current) setState("idle");
        inputRef.current.onError("That recording could not be read.");
        return;
      }

      if (!unmountedRef.current) setState("transcribing");
      const text = await transcribeRecording({
        connection,
        fileUri,
        contentType: DICTATION_CONTENT_TYPE,
      });

      if (unmountedRef.current) return;
      if (text.length === 0) {
        inputRef.current.onError("No speech was detected.");
        return;
      }
      inputRef.current.onTranscript(text);
    } catch (error) {
      if (!unmountedRef.current) {
        inputRef.current.onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      busyRef.current = false;
      if (!unmountedRef.current) setState("idle");
    }
  }, [recorder]);

  const toggle = useCallback(() => {
    if (state === "recording") void stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  return { state, toggle };
}
