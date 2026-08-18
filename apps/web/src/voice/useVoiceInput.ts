/**
 * Push-to-talk dictation for the composer.
 *
 * Records the microphone, uploads the clip to the environment's transcription
 * proxy, and hands the transcript back through `onTranscript`. Recording happens
 * on whichever device holds the microphone; transcription happens wherever the
 * server runs, which is the point — a phone dictates using the host's hardware.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { transcribeAudio } from "./voiceApi";

/**
 * Ordered by preference. Chrome and Firefox take the first entry; iOS Safari
 * below 18.4 has no WebM encoder and falls through to MP4.
 */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
] as const;

/** Clips this small are a mis-tap rather than speech, and waste a round trip. */
const MIN_CLIP_BYTES = 800;

export type VoiceInputState = "idle" | "recording" | "transcribing";

export interface VoiceInputController {
  readonly state: VoiceInputState;
  readonly toggle: () => void;
}

function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      // isTypeSupported throws rather than returning false on some iOS builds.
    }
  }
  return undefined;
}

export function isVoiceCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices?.getUserMedia !== undefined &&
    typeof MediaRecorder !== "undefined"
  );
}

function describeMicrophoneError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was denied.";
  }
  if (name === "NotFoundError") {
    return "No microphone was found.";
  }
  return error instanceof Error ? error.message : String(error);
}

export function useVoiceInput(
  onTranscript: (text: string) => void,
  onError: (message: string) => void,
): VoiceInputController {
  const [state, setState] = useState<VoiceInputState>("idle");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  // Set when the recording should be thrown away rather than transcribed:
  // an explicit cancel, or the composer unmounting mid-clip.
  const discardedRef = useRef(false);
  const unmountedRef = useRef(false);
  const startingRef = useRef(false);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  const releaseMicrophone = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      discardedRef.current = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current) return;
    if (recorderRef.current !== null && recorderRef.current.state !== "inactive") return;
    startingRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (unmountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      discardedRef.current = false;
      chunksRef.current = [];

      const mimeType = pickSupportedMimeType();
      const recorder =
        mimeType === undefined
          ? new MediaRecorder(stream)
          : new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        releaseMicrophone();
        recorderRef.current = null;

        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (discardedRef.current) {
          if (!unmountedRef.current) setState("idle");
          return;
        }

        const clip = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (clip.size < MIN_CLIP_BYTES) {
          setState("idle");
          onErrorRef.current("That recording was too short.");
          return;
        }

        setState("transcribing");
        void transcribeAudio(clip)
          .then((text) => {
            if (unmountedRef.current || discardedRef.current) return;
            if (text.length === 0) {
              onErrorRef.current("No speech was detected.");
              return;
            }
            onTranscriptRef.current(text);
          })
          .catch((error: unknown) => {
            if (unmountedRef.current || discardedRef.current) return;
            onErrorRef.current(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            if (!unmountedRef.current) setState("idle");
          });
      };

      recorder.start();
      setState("recording");
    } catch (error) {
      recorderRef.current = null;
      releaseMicrophone();
      if (!unmountedRef.current) {
        setState("idle");
        onErrorRef.current(describeMicrophoneError(error));
      }
    } finally {
      startingRef.current = false;
    }
  }, [releaseMicrophone]);

  /**
   * Guarded on the recorder's own state rather than React's, so a double tap
   * cannot call stop() on an already-inactive recorder.
   */
  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== "inactive") recorder.stop();
  }, []);

  const toggle = useCallback(() => {
    if (state === "recording") stop();
    else if (state === "idle") void start();
  }, [state, start, stop]);

  return { state, toggle };
}
