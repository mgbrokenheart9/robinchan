/**
 * One shared AudioContext for Robinchan's voice, plus a player that reports
 * its own clock every frame.
 *
 * Browsers only let an AudioContext start from a user gesture. The chat reply
 * arrives seconds after the Send click, well outside that gesture, so
 * `unlockAudio()` is called synchronously in the submit handler to create
 * and resume the context while the gesture is still live; playback later
 * reuses it.
 */

let ctx: AudioContext | null = null;

export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    /* No Web Audio — speech just won't play; text still shows. */
  }
}

export type Playback = {
  /** Resolves when the clip ends or is stopped. */
  done: Promise<void>;
  stop: () => void;
};

/**
 * Plays `audio` and calls `onFrame` about 30 times a second with the
 * seconds elapsed on the audio clock and the current loudness (0..1, RMS).
 * Driving the caller off the audio clock — not wall time — is what keeps the
 * text and the mouth in step with what's actually coming out of the speaker.
 */
export async function playAudio(
  audio: AudioBuffer | ArrayBuffer,
  onFrame?: (elapsedSec: number, level: number) => void,
): Promise<Playback> {
  unlockAudio();
  const context = ctx;
  if (!context) return { done: Promise.resolve(), stop: () => {} };
  if (context.state === 'suspended') await context.resume();

  const buffer =
    audio instanceof AudioBuffer ? audio : await context.decodeAudioData(audio.slice(0));

  const source = context.createBufferSource();
  source.buffer = buffer;
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  analyser.connect(context.destination);

  const samples = new Float32Array(analyser.fftSize);
  // What's audible lags what's been scheduled by the output latency; reveal
  // text against what the listener actually hears.
  const latency = context.outputLatency || context.baseLatency || 0;
  let startAt = 0;
  let stopped = false;

  const pump = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    onFrame?.(Math.max(0, context.currentTime - startAt - latency), Math.sqrt(sum / samples.length));
  };

  // A timer rather than requestAnimationFrame: rAF pauses whenever the page
  // isn't painting (an embedded or partly hidden view), and the text reveal
  // should keep following the audio regardless. ~30 Hz is plenty for both
  // the mouth and the text.
  let timer = 0;
  const done = new Promise<void>((resolve) => {
    source.onended = () => {
      window.clearInterval(timer);
      onFrame?.(buffer.duration, 0);
      resolve();
    };
  });

  startAt = context.currentTime;
  source.start();
  pump();
  timer = window.setInterval(pump, 33);

  return {
    done,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        source.stop();
      } catch {
        /* Already ended. */
      }
    },
  };
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
