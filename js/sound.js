/**
 * Synthesised sound effects.
 *
 * Every cue is generated with the Web Audio API rather than shipped as an
 * audio file. Two reasons: the repo stays free of binary assets (and of the
 * licensing questions that come with them), and there is no decode latency
 * on the first play — which matters because the very first sound a player
 * hears is the card deal, and a stutter there ruins the moment.
 *
 * iOS Safari will not let an AudioContext start outside a user gesture, so
 * nothing is created until `unlock()` is called from a real tap.
 */

const STORAGE_KEY = 'mafia.sound.muted';

/** @type {AudioContext | null} */
let ctx = null;
/** @type {GainNode | null} */
let master = null;
let muted = false;
let unlocked = false;

try {
  muted = localStorage.getItem(STORAGE_KEY) === '1';
} catch {
  /* Private-mode Safari throws on localStorage. Sound default is fine. */
}

function ensureContext() {
  if (ctx) return ctx;
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.5;
  master.connect(ctx.destination);
  return ctx;
}

/**
 * Called from the first genuine user gesture. Safe to call repeatedly.
 * Also resumes a context that the browser suspended when the tab was hidden.
 */
export function unlock() {
  const c = ensureContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  unlocked = true;
}

export function isMuted() {
  return muted;
}

export function setMuted(next) {
  muted = Boolean(next);
  try {
    localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* non-fatal */
  }
  if (master && ctx) {
    // Ramp rather than set, so toggling does not click.
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(muted ? 0 : 0.5, ctx.currentTime, 0.02);
  }
}

export function toggleMuted() {
  setMuted(!muted);
  return muted;
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A single enveloped oscillator note.
 * @param {object} o
 * @param {number} o.freq        starting frequency, Hz
 * @param {number} [o.freqEnd]   glide target, Hz (defaults to freq)
 * @param {number} o.dur         seconds
 * @param {OscillatorType} [o.type]
 * @param {number} [o.gain]      peak gain, 0..1
 * @param {number} [o.delay]     seconds to wait before the note starts
 */
function tone({ freq, freqEnd, dur, type = 'sine', gain = 0.3, delay = 0 }) {
  const c = ensureContext();
  if (!c || !master || muted) return;

  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const env = c.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (freqEnd && freqEnd !== freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  }

  // Fast attack, exponential decay — reads as a "pluck" rather than a beep.
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.2));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(env).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/**
 * Filtered noise burst — used for whooshes and impacts.
 * @param {object} o
 * @param {number} o.dur
 * @param {number} [o.gain]
 * @param {number} [o.filterFrom]  Hz, lowpass sweep start
 * @param {number} [o.filterTo]    Hz, lowpass sweep end
 * @param {number} [o.delay]
 */
function noise({ dur, gain = 0.25, filterFrom = 4000, filterTo = 400, delay = 0 }) {
  const c = ensureContext();
  if (!c || !master || muted) return;

  const t0 = c.currentTime + delay;
  const frames = Math.max(1, Math.floor(c.sampleRate * dur));
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    // Linear fade baked into the source so the tail is clean even if the
    // filter sweep finishes early.
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }

  const src = c.createBufferSource();
  src.buffer = buffer;

  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(filterFrom, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), t0 + dur);

  const env = c.createGain();
  env.gain.setValueAtTime(gain, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter).connect(env).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** A short arpeggio — the building block for the "good news" cues. */
function arpeggio(freqs, { step = 0.09, dur = 0.34, type = 'triangle', gain = 0.22 } = {}) {
  freqs.forEach((f, i) => tone({ freq: f, dur, type, gain, delay: i * step }));
}

/* -------------------------------------------------------------------------- */
/* Cues                                                                        */
/* -------------------------------------------------------------------------- */

export const sfx = {
  /** Soft UI tick for ordinary button presses. */
  tap() {
    tone({ freq: 660, freqEnd: 880, dur: 0.06, type: 'triangle', gain: 0.12 });
  },

  /** A card sliding off the deck: a filtered whoosh with a papery top. */
  deal(index = 0) {
    // Slight pitch variation per card so a 12-card deal does not sound like a
    // machine gun repeating one sample.
    const n = index % 6;
    noise({ dur: 0.22, gain: 0.2, filterFrom: 5200 + n * 320, filterTo: 900 });
    tone({ freq: 300 + n * 24, freqEnd: 190, dur: 0.14, type: 'sine', gain: 0.1 });
  },

  /** The flip of your own card — the most important sound in the game. */
  flip() {
    noise({ dur: 0.16, gain: 0.22, filterFrom: 6000, filterTo: 1400 });
    tone({ freq: 520, freqEnd: 780, dur: 0.2, type: 'triangle', gain: 0.16 });
  },

  /** Night falls: a low descending swell. */
  night() {
    tone({ freq: 320, freqEnd: 96, dur: 1.5, type: 'sine', gain: 0.26 });
    tone({ freq: 160, freqEnd: 62, dur: 1.9, type: 'sine', gain: 0.2, delay: 0.05 });
    noise({ dur: 1.3, gain: 0.1, filterFrom: 900, filterTo: 140 });
  },

  /** Day breaks: a rising major triad. */
  day() {
    arpeggio([392, 494, 587], { step: 0.1, dur: 0.7, gain: 0.2 });
  },

  /** A vote landing on a target — a dry thunk. */
  vote() {
    tone({ freq: 240, freqEnd: 150, dur: 0.12, type: 'square', gain: 0.13 });
  },

  /** A kill resolving at night. */
  kill() {
    noise({ dur: 0.5, gain: 0.34, filterFrom: 2400, filterTo: 90 });
    tone({ freq: 150, freqEnd: 44, dur: 0.7, type: 'sawtooth', gain: 0.2 });
  },

  /** A save — the kill noise inverted into something warm. */
  save() {
    arpeggio([523, 659, 784, 1047], { step: 0.07, dur: 0.5, gain: 0.18 });
  },

  /** The player's own elimination. Descending minor line. */
  eliminated() {
    arpeggio([392, 330, 262, 196], { step: 0.12, dur: 0.6, type: 'sine', gain: 0.24 });
  },

  /** Town victory. */
  townWins() {
    arpeggio([523, 659, 784, 1047, 1319], { step: 0.11, dur: 0.9, gain: 0.22 });
  },

  /** Mafia victory. Menacing, minor. */
  mafiaWins() {
    arpeggio([220, 262, 208, 175], { step: 0.16, dur: 1.1, type: 'sawtooth', gain: 0.16 });
  },

  /** Draw / stalemate. */
  draw() {
    tone({ freq: 330, dur: 0.9, type: 'sine', gain: 0.16 });
    tone({ freq: 311, dur: 1.0, type: 'sine', gain: 0.16, delay: 0.02 });
  },

  /** Someone joined the lobby. */
  join() {
    tone({ freq: 740, freqEnd: 990, dur: 0.16, type: 'sine', gain: 0.15 });
  },

  /** Error or rejected action. */
  error() {
    tone({ freq: 200, freqEnd: 140, dur: 0.28, type: 'square', gain: 0.16 });
  },

  /** The countdown warning in the last few seconds of a phase. */
  tick(urgent = false) {
    tone({
      freq: urgent ? 1100 : 800,
      dur: 0.07,
      type: 'square',
      gain: urgent ? 0.16 : 0.1,
    });
  },
};
