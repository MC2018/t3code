/**
 * Voice transcription proxy.
 *
 * Forwards recorded audio from any client to an OpenAI-compatible speech-to-text
 * backend running alongside the server, so a phone on the tailnet transcribes on
 * the host machine's hardware rather than its own. The backend is configured with
 * environment variables because it is a property of the machine the server runs
 * on, not of the user or the thread.
 *
 * @module VoiceTranscriptionRoute
 */
import * as Effect from "effect/Effect";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";

import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { authenticateRawRouteWithScope } from "../http.ts";

export const VOICE_TRANSCRIBE_PATH = "/api/voice/transcribe";
export const VOICE_HEALTH_PATH = "/api/voice/health";

const DEFAULT_STT_MODEL = "Systran/faster-whisper-small.en";
const DEFAULT_TIMEOUT_MS = 120_000;
/** Whisper backends reject long uploads anyway; fail fast instead of streaming 100MB to them. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * Extension the backend uses to pick a demuxer. Whisper servers sniff the
 * filename, so an unknown container must still arrive with a plausible one.
 */
const EXTENSION_BY_MIME_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mp4", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/flac", "flac"],
];

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

interface SttBackend {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string | undefined;
  readonly language: string | undefined;
  readonly timeoutMs: number;
}

/**
 * Reads the configured backend, or undefined when the host has not set one up.
 * Read per request so a restart of the STT container does not require a restart
 * of the server to pick up a new URL.
 */
export function readSttBackend(): SttBackend | undefined {
  const baseUrl = readEnv("T3CODE_STT_URL");
  if (baseUrl === undefined) return undefined;

  const timeoutMs = Number(readEnv("T3CODE_STT_TIMEOUT_MS"));
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model: readEnv("T3CODE_STT_MODEL") ?? DEFAULT_STT_MODEL,
    apiKey: readEnv("T3CODE_STT_API_KEY"),
    language: readEnv("T3CODE_STT_LANGUAGE"),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

export function audioFileName(contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const match = EXTENSION_BY_MIME_PREFIX.find(([prefix]) => mime === prefix);
  return `recording.${match?.[1] ?? "webm"}`;
}

function transcriptionFormData(
  audio: ArrayBuffer,
  contentType: string,
  backend: SttBackend,
): FormData {
  const formData = new FormData();
  formData.append("file", new Blob([audio], { type: contentType }), audioFileName(contentType));
  formData.append("model", backend.model);
  if (backend.language !== undefined) {
    formData.append("language", backend.language);
  }
  return formData;
}

/** Backend transcripts arrive as `{ text }`; tolerate a bare string body too. */
export function readTranscript(body: unknown): string {
  if (typeof body === "string") return body.trim();
  if (typeof body === "object" && body !== null && "text" in body) {
    const text = (body as { text: unknown }).text;
    if (typeof text === "string") return text.trim();
  }
  return "";
}

/**
 * Reports whether the host has an STT backend configured, so clients can hide
 * the microphone rather than offer a control that always fails.
 */
export const voiceHealthRouteLayer = HttpRouter.add(
  "GET",
  VOICE_HEALTH_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const backend = readSttBackend();
    return HttpServerResponse.jsonUnsafe({
      configured: backend !== undefined,
      model: backend?.model,
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

/**
 * Accepts raw audio bytes (the recording's container type travels in
 * `Content-Type`) and answers with the transcript. The body is raw rather than
 * multipart so the server, not the client, decides which model runs.
 */
export const voiceTranscriptionRouteLayer = HttpRouter.add(
  "POST",
  VOICE_TRANSCRIBE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);

    const backend = readSttBackend();
    if (backend === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: "No speech-to-text backend configured. Set T3CODE_STT_URL." },
        { status: 503 },
      );
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const contentType = request.headers["content-type"] ?? "audio/webm";
    // A body that fails to read is indistinguishable from an empty one here, and
    // both mean the same thing to the caller: there is nothing to transcribe.
    const audio = yield* request.arrayBuffer.pipe(Effect.orElseSucceed(() => new ArrayBuffer(0)));

    if (audio.byteLength === 0) {
      return HttpServerResponse.jsonUnsafe({ error: "No audio uploaded." }, { status: 400 });
    }
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      return HttpServerResponse.jsonUnsafe({ error: "Recording is too long." }, { status: 413 });
    }

    const httpClient = yield* HttpClient.HttpClient;

    return yield* httpClient
      .post(`${backend.baseUrl}/audio/transcriptions`, {
        headers: backend.apiKey ? { authorization: `Bearer ${backend.apiKey}` } : {},
        body: HttpBody.formData(transcriptionFormData(audio, contentType, backend)),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.map(readTranscript),
        // One line per dictation, and the only view a self-hosted operator gets
        // into whether the backend actually heard anything.
        Effect.tap((text) =>
          Effect.logInfo("Voice transcription completed", {
            contentType,
            audioBytes: audio.byteLength,
            transcriptLength: text.length,
          }),
        ),
        Effect.map((text) => HttpServerResponse.jsonUnsafe({ text })),
        Effect.timeout(backend.timeoutMs),
        Effect.tapError((cause) =>
          Effect.logWarning("Voice transcription failed", { cause, baseUrl: backend.baseUrl }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.jsonUnsafe(
            { error: "The speech-to-text backend did not answer." },
            { status: 502 },
          ),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
