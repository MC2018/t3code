# Fork notes

This is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) carrying local changes that
upstream does not have. This file is fork-only and never exists upstream, so it will not conflict.

## What this fork adds

**Dictation.** A microphone in the composer footer records audio and sends it to an
OpenAI-compatible speech-to-text backend configured on the server, so a phone on the tailnet
transcribes using this machine's hardware. User-facing setup is in
[docs/user/dictation.md](./docs/user/dictation.md).

**Dictation on mobile.** The same feature in the React Native app, recording with `expo-audio` and
uploading to the same server endpoint. This is the one part that costs a native rebuild: `expo-audio`
is a native dependency, so it changes the Expo fingerprint and a rebase means a new APK rather than
an OTA update.

**Multi-repository workspaces.** Projects containing several git repositories can see per-repository
changes, checkpoints, and a repository-scoped diff panel, instead of only the workspace root. Merged
from the `multi-repo-changes` branch.

Note that `fix/review-workspace-roots` is intentionally **not** merged. It is the standalone,
upstream-worthy subset of those fixes, rewritten for a PR against upstream rather than cherry-picked,
so it conflicts with the feature branch that already solves the same thing through the repository
discovery service. Keep it for upstreaming; do not merge it here.

The work is deliberately concentrated in new files so rebases stay cheap. Only these upstream files
are touched:

| File                                                  | Change                                                |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `apps/server/src/http.ts`                             | `authenticateRawRouteWithScope` made exported         |
| `apps/server/src/server.ts`                           | import + two entries in `makeRoutesLayer`             |
| `apps/web/src/environments/primary/httpLayer.ts`      | `isSameOriginBrowserPrimary` made exported            |
| `apps/web/src/components/chat/ChatComposer.tsx`       | imports, two hook calls, and the button in the footer |
| `docs/README.md`                                      | one index line                                        |
| `apps/mobile/package.json`                            | adds `expo-audio`                                     |
| `apps/mobile/app.config.ts`                           | microphone permission (see note below)                |
| `apps/mobile/src/components/AppSymbol.tsx`            | adds the `mic` symbol                                 |
| `apps/mobile/src/features/threads/ThreadComposer.tsx` | imports, hook calls, and the toolbar button           |

Everything else lives in files upstream does not have:

- `apps/server/src/voice/` — the transcription proxy route and its tests
- `apps/web/src/voice/` — recording hook, availability probe, API client
- `apps/web/src/components/chat/ComposerVoiceButton.tsx`
- `apps/mobile/src/features/voice/` — recording hook, availability probe, API client
- `docs/user/dictation.md`

## Two mobile traps worth remembering

iOS exposes a single `NSMicrophoneUsageDescription`, and Expo's permission plugins treat
`microphonePermission: false` as _delete that key_. Upstream passes `false` from both `expo-camera`
and `expo-image-picker`, so either one silently strips the description and iOS terminates the app on
the first recording. All three plugins now share one `MICROPHONE_USAGE_DESCRIPTION` constant.

Separately, `expo-audio@56.0.13`'s own plugin builds its iOS permissions plugin but never assigns the
result back to `config`, so its `microphonePermission` option does nothing. Do not rely on it; the
Android `RECORD_AUDIO` permission it adds does work.

If a rebase conflicts, it will almost always be `ChatComposer.tsx`. The composer footer's right-hand
action group is the anchor; re-place `<ComposerVoiceButton />` just before
`<ComposerFooterPrimaryActions />` and the rest follows.

## Updating from upstream

```bash
git fetch upstream
git rebase upstream/main
```

Resolve conflicts, then rebuild. Check whether upstream has added dictation of its own before
carrying these commits forward — the point is to drop this fork when that happens.

## Building and running

```bash
pnpm install
pnpm build
node apps/server/dist/bin.mjs
```

The server serves the web client from `apps/web/dist` when run from the monorepo, so a single
`pnpm build` covers both halves.

To run this build instead of the managed runtime, point the service unit's `ExecStart` at
`apps/server/dist/bin.mjs` and set the speech-to-text variables alongside it:

```ini
ExecStart=/path/to/node /home/mcdesktop/Repositories/T3/t3code/apps/server/dist/bin.mjs
Environment=T3CODE_STT_URL=http://127.0.0.1:8000/v1
Environment=T3CODE_STT_MODEL=Systran/faster-whisper-small.en
```

Note that a fork build does not auto-update, which is the trade: upstream changes arrive when you
rebase and rebuild, not on their release schedule.
