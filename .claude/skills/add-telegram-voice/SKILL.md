---
name: add-telegram-voice
description: Add voice message transcription to Telegram using local whisper.cpp. Automatically transcribes Telegram voice notes so the agent can read and respond to them. Runs entirely on-device — no API key, no network, no cost.
---

# Add Telegram Voice Transcription

Adds automatic voice message transcription to NanoClaw's Telegram channel using local whisper.cpp (via `whisper-cli`). When a voice note arrives, it is downloaded via the Telegram Bot API, converted to WAV with ffmpeg, transcribed with whisper.cpp, and delivered to the agent as `[Voice: <transcript>]`.

**Runs entirely on-device** — no API key, no network calls, no cost.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep 'transcribeVoiceMessage' src/channels/telegram.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

### Check Telegram is installed

```bash
test -f src/channels/telegram.ts && echo "TELEGRAM_OK" || echo "TELEGRAM_MISSING"
```

If missing, run `/add-telegram` first.

### Check dependencies

```bash
whisper-cli --help >/dev/null 2>&1 && echo "WHISPER_OK" || echo "WHISPER_MISSING"
ffmpeg -version >/dev/null 2>&1 && echo "FFMPEG_OK" || echo "FFMPEG_MISSING"
```

If missing, install via Homebrew:

```bash
brew install whisper-cpp ffmpeg
```

**Note:** The Homebrew package is `whisper-cpp`, but the CLI binary it installs is `whisper-cli`.

### Check for model file

```bash
ls data/models/ggml-*.bin 2>/dev/null || echo "NO_MODEL"
```

If no model exists, download the base model (148MB, good balance of speed and accuracy):

```bash
mkdir -p data/models
curl -L -o data/models/ggml-base.bin "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
```

For better accuracy at the cost of speed, use `ggml-small.bin` (466MB) or `ggml-medium.bin` (1.5GB).

## Phase 2: Apply Code Changes

### Create transcription module

Create `src/transcription.ts` with these functions:

- `transcribeAudio(buffer: Buffer): Promise<string | null>` — writes buffer to temp `.ogg`, converts to 16kHz mono WAV via ffmpeg, runs `whisper-cli` with the model, returns transcript or null
- `transcribeVoiceMessage(buffer: Buffer): Promise<string>` — wraps `transcribeAudio`, returns transcript or fallback `[Voice Message - transcription unavailable]`

Environment variables:
- `WHISPER_BIN` (default: `whisper-cli`)
- `WHISPER_MODEL` (default: `data/models/ggml-base.bin`)

### Update Telegram voice handler

In `src/channels/telegram.ts`:

1. Add import: `import { transcribeVoiceMessage } from '../transcription.js'`
2. Replace the `message:voice` handler:
   - Download voice file via `ctx.api.getFile()` + HTTPS (same pattern as photo/PDF handlers)
   - Call `transcribeVoiceMessage(buffer)`
   - Store message with content `[Voice: <transcript>]`
   - Fall back to `storeNonText(ctx, '[Voice message]')` on error

### Validate

```bash
npm run build
npx vitest run src/channels/telegram.test.ts
```

## Phase 3: Verify

### Ensure launchd PATH includes Homebrew

The NanoClaw launchd service runs with a restricted PATH. `whisper-cli` and `ffmpeg` need `/opt/homebrew/bin/` (Apple Silicon) or `/usr/local/bin/` (Intel).

Check:

```bash
grep -A1 'PATH' ~/Library/LaunchAgents/com.nanoclaw.plist
```

If `/opt/homebrew/bin` is missing, add it to the PATH value in the plist, then reload:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Test

Send a voice note to the bot in Telegram. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i -E "voice|transcri|whisper"
```

Look for:
- `Transcribed voice message` — successful transcription
- `whisper.cpp transcription failed` — check model path, ffmpeg, or PATH
- `Failed to transcribe Telegram voice` — download or processing error

## Configuration

Environment variables (optional, set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_BIN` | `whisper-cli` | Path to whisper.cpp binary |
| `WHISPER_MODEL` | `data/models/ggml-base.bin` | Path to GGML model file |

## Troubleshooting

### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `whisper-cli` and `ffmpeg` are installed: `which whisper-cli ffmpeg`
2. Check model file exists: `ls data/models/ggml-base.bin`
3. Test manually:
   ```bash
   ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -f wav /tmp/test.wav -y
   whisper-cli -m data/models/ggml-base.bin -f /tmp/test.wav --no-timestamps -nt
   ```

### Transcription works in dev but not as service

The launchd plist PATH likely doesn't include `/opt/homebrew/bin`. See "Ensure launchd PATH includes Homebrew" in Phase 3.

### Slow transcription

The base model processes ~30s of audio in <1s on M1+. If slower, check CPU usage. For faster results, use `ggml-tiny.bin` (75MB). For better accuracy, use `ggml-small.bin` or `ggml-medium.bin`.

### Wrong language

whisper.cpp auto-detects language. To force a language, set `WHISPER_LANG` in `.env` and add `-l ${WHISPER_LANG}` to the whisper-cli args in `src/transcription.ts`.
