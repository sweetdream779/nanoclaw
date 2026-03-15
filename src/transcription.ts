import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  process.env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-medium.bin');
const WHISPER_LANG = process.env.WHISPER_LANG || '';

const FALLBACK_MESSAGE = '[Voice Message - transcription unavailable]';

/**
 * Transcribe an audio buffer using local whisper.cpp.
 * Expects ffmpeg and whisper-cli to be available in PATH.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
): Promise<string | null> {
  if (!audioBuffer || audioBuffer.length === 0) return null;

  const tmpDir = os.tmpdir();
  const id = `nanoclaw-voice-${Date.now()}`;
  const tmpOgg = path.join(tmpDir, `${id}.ogg`);
  const tmpWav = path.join(tmpDir, `${id}.wav`);

  try {
    fs.writeFileSync(tmpOgg, audioBuffer);

    // Convert ogg/opus to 16kHz mono WAV (required by whisper.cpp)
    await execFileAsync(
      'ffmpeg',
      ['-i', tmpOgg, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', tmpWav],
      { timeout: 30_000 },
    );

    const { stdout } = await execFileAsync(
      WHISPER_BIN,
      [
        '-m',
        WHISPER_MODEL,
        '-f',
        tmpWav,
        '--no-timestamps',
        '-nt',
        ...(WHISPER_LANG ? ['-l', WHISPER_LANG] : []),
      ],
      { timeout: 60_000 },
    );

    const transcript = stdout.trim();
    if (!transcript) return null;

    logger.info(
      { chars: transcript.length, transcript },
      'Transcribed voice message',
    );
    return transcript;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    for (const f of [tmpOgg, tmpWav]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort cleanup */
      }
    }
  }
}

/**
 * Transcribe an audio buffer, returning a user-facing string.
 * Returns the transcript or a fallback placeholder on failure.
 */
export async function transcribeVoiceMessage(
  audioBuffer: Buffer,
): Promise<string> {
  const transcript = await transcribeAudio(audioBuffer);
  return transcript || FALLBACK_MESSAGE;
}
