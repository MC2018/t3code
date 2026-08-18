import { afterEach, describe, expect, it } from "vite-plus/test";

import { audioFileName, readSttBackend, readTranscript } from "./transcriptionRoute.ts";

const STT_ENV_KEYS = [
  "T3CODE_STT_URL",
  "T3CODE_STT_MODEL",
  "T3CODE_STT_API_KEY",
  "T3CODE_STT_LANGUAGE",
  "T3CODE_STT_TIMEOUT_MS",
] as const;

afterEach(() => {
  for (const key of STT_ENV_KEYS) delete process.env[key];
});

describe("readSttBackend", () => {
  it("reports no backend when the url is unset or blank", () => {
    expect(readSttBackend()).toBeUndefined();

    process.env.T3CODE_STT_URL = "   ";
    expect(readSttBackend()).toBeUndefined();
  });

  it("trims trailing slashes so the endpoint path joins cleanly", () => {
    process.env.T3CODE_STT_URL = "http://127.0.0.1:8000/v1//";
    expect(readSttBackend()?.baseUrl).toBe("http://127.0.0.1:8000/v1");
  });

  it("defaults the model and timeout", () => {
    process.env.T3CODE_STT_URL = "http://127.0.0.1:8000/v1";
    const backend = readSttBackend();
    expect(backend?.model).toBe("Systran/faster-whisper-small.en");
    expect(backend?.timeoutMs).toBe(120_000);
    expect(backend?.apiKey).toBeUndefined();
    expect(backend?.language).toBeUndefined();
  });

  it("ignores a timeout that is not a positive number", () => {
    process.env.T3CODE_STT_URL = "http://127.0.0.1:8000/v1";
    process.env.T3CODE_STT_TIMEOUT_MS = "not-a-number";
    expect(readSttBackend()?.timeoutMs).toBe(120_000);

    process.env.T3CODE_STT_TIMEOUT_MS = "-5";
    expect(readSttBackend()?.timeoutMs).toBe(120_000);
  });

  it("carries the configured overrides through", () => {
    process.env.T3CODE_STT_URL = "https://api.openai.com/v1";
    process.env.T3CODE_STT_MODEL = "whisper-1";
    process.env.T3CODE_STT_API_KEY = "sk-test";
    process.env.T3CODE_STT_LANGUAGE = "en";
    process.env.T3CODE_STT_TIMEOUT_MS = "5000";

    expect(readSttBackend()).toEqual({
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      apiKey: "sk-test",
      language: "en",
      timeoutMs: 5000,
    });
  });
});

describe("audioFileName", () => {
  it("maps recording containers to the extension the backend demuxes on", () => {
    expect(audioFileName("audio/webm;codecs=opus")).toBe("recording.webm");
    expect(audioFileName("audio/mp4")).toBe("recording.m4a");
    expect(audioFileName("audio/ogg; codecs=opus")).toBe("recording.ogg");
    expect(audioFileName("AUDIO/MPEG")).toBe("recording.mp3");
  });

  it("falls back to webm for unknown types", () => {
    expect(audioFileName("application/octet-stream")).toBe("recording.webm");
    expect(audioFileName("")).toBe("recording.webm");
  });
});

describe("readTranscript", () => {
  it("reads and trims the text field", () => {
    expect(readTranscript({ text: "  hello there  " })).toBe("hello there");
  });

  it("accepts a bare string body", () => {
    expect(readTranscript(" hello ")).toBe("hello");
  });

  it("answers empty for bodies without usable text", () => {
    expect(readTranscript({})).toBe("");
    expect(readTranscript({ text: 42 })).toBe("");
    expect(readTranscript(null)).toBe("");
  });
});
