/**
 * Client half of the voice transcription proxy, for the mobile app.
 *
 * Posts a recording to the connected environment's `/api/voice` routes. The
 * audio is sent as a raw body, which is what the server expects and what
 * `expo-file-system` uploads natively, so the clip never has to be marshalled
 * through JavaScript as base64.
 */
import { File } from "expo-file-system";

export interface VoiceEnvironmentConnection {
  readonly httpBaseUrl: string;
  readonly bearerToken: string | null;
}

export interface VoiceHealth {
  readonly configured: boolean;
  readonly model?: string;
}

function endpointUrl(httpBaseUrl: string, path: string): string {
  return new URL(path, httpBaseUrl.endsWith("/") ? httpBaseUrl : `${httpBaseUrl}/`).toString();
}

function authHeaders(connection: VoiceEnvironmentConnection): Record<string, string> {
  return connection.bearerToken ? { authorization: `Bearer ${connection.bearerToken}` } : {};
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
 * Whether the environment has a speech-to-text backend. Answers not-configured
 * on any failure so a probe error hides the microphone rather than surfacing an
 * error the user cannot act on.
 */
export async function fetchVoiceHealth(
  connection: VoiceEnvironmentConnection,
): Promise<VoiceHealth> {
  try {
    const response = await fetch(endpointUrl(connection.httpBaseUrl, "api/voice/health"), {
      method: "GET",
      headers: authHeaders(connection),
    });
    if (!response.ok) return { configured: false };

    const body = (await response.json()) as VoiceHealth;
    return { configured: body.configured === true, ...(body.model ? { model: body.model } : {}) };
  } catch {
    return { configured: false };
  }
}

export class VoiceTranscriptionError extends Error {}

/**
 * Uploads a recording from its on-device file URI and resolves to the
 * transcript. The recorder's container type travels as `Content-Type` so the
 * server can give the backend a filename it will demux.
 */
export async function transcribeRecording(input: {
  readonly connection: VoiceEnvironmentConnection;
  readonly fileUri: string;
  readonly contentType: string;
}): Promise<string> {
  const audio = await new File(input.fileUri).arrayBuffer();
  const response = await fetch(endpointUrl(input.connection.httpBaseUrl, "api/voice/transcribe"), {
    method: "POST",
    headers: { ...authHeaders(input.connection), "content-type": input.contentType },
    body: audio,
  });

  if (!response.ok) {
    throw new VoiceTranscriptionError(await readErrorMessage(response));
  }

  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
}
