/**
 * Client half of the voice transcription proxy.
 *
 * Talks to the primary environment's `/api/voice` routes with plain `fetch`
 * rather than the Effect client, because the payload is an opaque audio blob and
 * the caller is a React hook that wants a promise. Authentication mirrors
 * `makePrimaryEnvironmentHttpLayer`: same-origin browsers ride the session
 * cookie, everyone else carries the desktop bearer token.
 */
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { isSameOriginBrowserPrimary } from "../environments/primary/httpLayer";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";

export interface VoiceHealth {
  readonly configured: boolean;
  readonly model?: string;
}

async function authorizedRequestInit(init: RequestInit): Promise<RequestInit> {
  if (isSameOriginBrowserPrimary()) {
    return { ...init, credentials: "include" };
  }

  const bearerToken = await readDesktopPrimaryBearerToken();
  return {
    ...init,
    credentials: "omit",
    headers: {
      ...init.headers,
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
  };
}

/** Reads a JSON `{ error }` body, falling back to the status for empty responses. */
async function readErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (body !== null && typeof body.error === "string" && body.error.length > 0) {
    return body.error;
  }
  return `Transcription failed (${response.status}).`;
}

/**
 * Whether the environment has a speech-to-text backend. Returns not-configured
 * on any failure so a probe error hides the microphone instead of surfacing an
 * error the user cannot act on.
 */
export async function fetchVoiceHealth(signal?: AbortSignal): Promise<VoiceHealth> {
  try {
    const response = await fetch(
      resolvePrimaryEnvironmentHttpUrl("/api/voice/health"),
      await authorizedRequestInit({ method: "GET", ...(signal ? { signal } : {}) }),
    );
    if (!response.ok) return { configured: false };

    const body = (await response.json()) as VoiceHealth;
    return { configured: body.configured === true, ...(body.model ? { model: body.model } : {}) };
  } catch {
    return { configured: false };
  }
}

export class VoiceTranscriptionError extends Error {}

/**
 * Uploads a recording and resolves to its transcript. The blob's container type
 * travels as `Content-Type`; the server picks the model and the filename.
 */
export async function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/voice/transcribe"),
    await authorizedRequestInit({
      method: "POST",
      headers: { "content-type": audio.type || "audio/webm" },
      body: audio,
      ...(signal ? { signal } : {}),
    }),
  );

  if (!response.ok) {
    throw new VoiceTranscriptionError(await readErrorMessage(response));
  }

  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
}
