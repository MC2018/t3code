# Dictation

T3 Code can turn speech into composer text. Recording happens on whatever device you are holding;
transcription happens on the machine running the server. Dictating from a phone therefore uses the
host machine's CPU or GPU, and the audio never leaves your network.

The microphone appears in the composer footer, next to the send button, once the server has a
speech-to-text backend configured. Transcripts are appended to the draft rather than sent, so you
always read what was heard before the agent does.

## Set up a backend

T3 Code does not bundle a speech-to-text model. It talks to any server that implements the
OpenAI-compatible `/audio/transcriptions` endpoint — [Speaches](https://speaches.ai),
`faster-whisper-server`, LocalAI, or OpenAI itself.

Point the server at your backend with `T3CODE_STT_URL`, then restart it:

| Variable                | Required | Description                                                                                                                    |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `T3CODE_STT_URL`        | yes      | Base URL of the backend, including any version prefix, e.g. `http://127.0.0.1:8000/v1`. Leave it unset to hide the microphone. |
| `T3CODE_STT_MODEL`      | no       | Model the backend should load. Defaults to `Systran/faster-whisper-small.en`.                                                  |
| `T3CODE_STT_API_KEY`    | no       | Sent as a bearer token. Only needed for hosted backends.                                                                       |
| `T3CODE_STT_LANGUAGE`   | no       | Forces a language instead of letting the model detect one.                                                                     |
| `T3CODE_STT_TIMEOUT_MS` | no       | How long to wait for a transcript. Defaults to 120000.                                                                         |

Clients never see these values and never contact the backend directly, so the backend can stay bound
to localhost.

## Use the GPU

A CPU build of Whisper transcribes roughly three times faster than real time, which is enough to feel
like a wait. A GPU build is effectively instant for normal dictation, so prefer a CUDA image if the
host has a supported card. With Speaches that means running the CUDA image rather than the CPU one:

```
docker run --gpus all -p 127.0.0.1:8000:8000 ghcr.io/speaches-ai/speaches:latest-cuda
```

Larger models also become practical on a GPU. `Systran/faster-whisper-large-v3` is noticeably more
accurate than the small English model, particularly for names and technical terms.

## Requirements

Browsers only grant microphone access on a secure origin. Reaching the server over HTTPS or on
`localhost` works; reaching it over a plain-HTTP LAN address does not, and the microphone stays
hidden. [Remote access](./remote-access.md) covers setting up an HTTPS origin.

Dictation is available in the web and desktop clients. The mobile app records through a different
audio stack and is not supported yet.
