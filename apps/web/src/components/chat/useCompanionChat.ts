'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Mood } from '@/components/live2d/expressions';
import { base64ToArrayBuffer, unlockAudio } from '@/lib/audio';
import type { ChatResponseBody } from '@/lib/chat';
import { sendChat } from '@/lib/sendChat';

export type ChatPhase = 'idle' | 'thinking' | 'speaking';

export type Speaker = (audio: ArrayBuffer, onProgress: (elapsedSec: number) => void) => Promise<void>;

export type ChatNote = { tone: 'info' | 'error'; text: string };

const GREETING =
  "Hi! I'm Robinchan. Ask me what's moving, what a filing means, or how an order would work, and I'll explain it in plain words.";

export const VOICE_STORAGE_KEY = 'robinchan.voice';

/** Typewriter speed when there's no audio to follow. */
const TYPE_MS = 32;

/**
 * One conversation with Robinchan.
 *
 * Each turn: POST `/api/chat` → switch her expression to the reply's mood →
 * play the ElevenLabs clip through the Live2D stage (which drives her mouth)
 * while revealing the bubble text off the clip's per-character timestamps.
 * Without audio — voice muted, or TTS unavailable — the text types out on its
 * own and her mouth stays idle.
 *
 * Only the latest turn is ever allowed to write to the bubble: sending again
 * mid-reply cuts the old one off rather than letting two replies interleave.
 *
 * The thread itself is the shared one (`lib/chatStore`): what's said here
 * is there in the companion on Heat, Portfolio and Trade, and the other way
 * round (Trade-Heat-Portfolio §2: one chat, one history).
 */
export function useCompanionChat({
  speak,
  stopSpeaking,
  onMood,
}: {
  speak: Speaker;
  stopSpeaking: () => void;
  onMood: (mood: Mood) => void;
}) {
  const [shown, setShown] = useState(GREETING);
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const [note, setNote] = useState<ChatNote | null>(null);
  const [lastUser, setLastUser] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);

  const turnRef = useRef(0);
  const typeTimer = useRef<number | null>(null);
  // Always call the stage's latest callbacks from inside an in-flight turn.
  const stage = useRef({ speak, stopSpeaking, onMood });
  useEffect(() => {
    stage.current = { speak, stopSpeaking, onMood };
  });

  // Mute is a per-viewer preference: read after mount so SSR and first paint
  // agree, and wrapped because storage can be blocked.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(VOICE_STORAGE_KEY) === 'off') setVoiceOn(false);
    } catch {
      /* Storage unavailable — keep voice on. */
    }
  }, []);

  const stopTyping = useCallback(() => {
    if (typeTimer.current !== null) window.clearInterval(typeTimer.current);
    typeTimer.current = null;
  }, []);

  const interrupt = useCallback(() => {
    stopTyping();
    stage.current.stopSpeaking();
  }, [stopTyping]);

  useEffect(() => interrupt, [interrupt]);

  const toggleVoice = useCallback(() => {
    setVoiceOn((on) => {
      const next = !on;
      try {
        window.localStorage.setItem(VOICE_STORAGE_KEY, next ? 'on' : 'off');
      } catch {
        /* Not persisted; applies for this visit. */
      }
      if (!next) stage.current.stopSpeaking();
      return next;
    });
  }, []);

  const typeOut = useCallback(
    (text: string, turn: number) =>
      new Promise<void>((resolve) => {
        stopTyping();
        const chars = Array.from(text);
        let i = 0;
        typeTimer.current = window.setInterval(() => {
          if (turn !== turnRef.current) {
            stopTyping();
            resolve();
            return;
          }
          i += 1;
          setShown(chars.slice(0, i).join(''));
          if (i >= chars.length) {
            stopTyping();
            resolve();
          }
        }, TYPE_MS);
      }),
    [stopTyping],
  );

  const send = useCallback(
    async (input: string) => {
      const message = input.trim();
      if (!message) return;

      // Must run inside the click/submit gesture, before any await, or the
      // browser won't let her speak when the reply lands.
      if (voiceOn) unlockAudio();

      const turn = ++turnRef.current;
      interrupt();
      setLastUser(message);
      setNote(null);
      setPhase('thinking');

      let data: ChatResponseBody;
      try {
        // The shared thread records both lines; the page context tells the
        // server she's on her own stage.
        data = await sendChat(message, { context: { page: 'robinchan' }, voice: voiceOn });
      } catch (err) {
        if (turn !== turnRef.current) return;
        setPhase('idle');
        setNote({
          tone: 'error',
          text: err instanceof Error ? err.message : 'Something went wrong. Try again.',
        });
        return;
      }

      if (turn !== turnRef.current) return;

      stage.current.onMood(data.mood);
      if (data.voiceNote) setNote({ tone: 'info', text: `${data.voiceNote} Showing text only.` });
      setPhase('speaking');
      setShown('');

      let spoke = false;
      if (data.voice) {
        const reveal = revealer(data.reply, data.voice.alignment);
        try {
          await stage.current.speak(base64ToArrayBuffer(data.voice.audio), (elapsed) => {
            if (turn === turnRef.current) setShown(reveal(elapsed));
          });
          spoke = true;
        } catch (err) {
          console.error('[chat] voice playback failed', err);
          if (turn === turnRef.current) {
            setNote({ tone: 'info', text: "Her voice couldn't play here. Showing text only." });
          }
        }
      }
      if (!spoke && turn === turnRef.current) await typeOut(data.reply, turn);

      if (turn !== turnRef.current) return;
      setShown(data.reply);
      setPhase('idle');
    },
    [interrupt, typeOut, voiceOn],
  );

  return { shown, phase, note, lastUser, voiceOn, toggleVoice, send };
}

/**
 * Maps audio time → how much of the reply has been spoken.
 *
 * ElevenLabs reports the start time of every character it read. The text
 * sent to it is the reply itself, so the counts normally line up one-to-one;
 * if the provider normalised anything and they drift, the position is scaled
 * across so the reveal still finishes exactly when the audio does.
 */
export function revealer(
  text: string,
  alignment: { chars: string[]; starts: number[] },
): (elapsed: number) => string {
  const chars = Array.from(text);
  const { starts } = alignment;
  if (!starts.length) return () => text;

  return (elapsed) => {
    // `starts` is ascending — count the characters that have begun.
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((starts[mid] ?? Infinity) <= elapsed) lo = mid + 1;
      else hi = mid;
    }
    const spoken =
      starts.length === chars.length ? lo : Math.round((lo / starts.length) * chars.length);
    return chars.slice(0, spoken).join('');
  };
}
