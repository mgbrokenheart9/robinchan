import 'server-only';

/**
 * ElevenLabs text-to-speech, using the `with-timestamps` endpoint.
 *
 * The plain endpoint only returns audio; this one also returns when each
 * character starts being spoken. The client reveals the bubble text off those
 * timestamps against the audio clock, which is what keeps the words on screen
 * in step with her voice instead of racing ahead on a fixed typewriter speed.
 */

export type SpokenReply = {
  /** base64 MP3 */
  audio: string;
  mime: 'audio/mpeg';
  /** Per-character start times, in seconds, for the text that was spoken. */
  alignment: { chars: string[]; starts: number[] };
};

export type VoiceResult = { ok: true; voice: SpokenReply } | { ok: false; reason: string };

export function voiceConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

type TimestampPayload = {
  audio_base64?: string;
  alignment?: { characters?: string[]; character_start_times_seconds?: number[] } | null;
  detail?: { code?: string; status?: string; message?: string } | string;
};

export async function synthesize(text: string): Promise<VoiceResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: 'Voice is not configured on the server.' };

  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || '21m00Tcm4TlvDq8ikWAM';
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2';

  let response: Response;
  try {
    response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    return { ok: false, reason: 'The voice service could not be reached.' };
  }

  const payload = (await response.json().catch(() => ({}))) as TimestampPayload;

  if (!response.ok || !payload.audio_base64) {
    const detail = typeof payload.detail === 'object' ? payload.detail : undefined;
    const code = detail?.code ?? detail?.status;
    console.warn(
      `[chat] ElevenLabs ${response.status}: ${code ?? ''} ${detail?.message ?? payload.detail ?? ''}`.trim(),
    );
    return {
      ok: false,
      reason:
        code === 'quota_exceeded'
          ? 'Voice is paused: the ElevenLabs character quota is used up.'
          : response.status === 401
            ? 'Voice is paused: ElevenLabs rejected the server API key.'
            : `Voice is unavailable right now (${response.status}).`,
    };
  }

  return {
    ok: true,
    voice: {
      audio: payload.audio_base64,
      mime: 'audio/mpeg',
      alignment: {
        chars: payload.alignment?.characters ?? [],
        starts: payload.alignment?.character_start_times_seconds ?? [],
      },
    },
  };
}
