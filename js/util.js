/**
 * ============================================================================
 * AbuNashmi's Mafia — shared utilities
 * ============================================================================
 *
 * Small, dependency-free helpers used by the transport and the UI layer.
 *
 * The sanitisers here are the app's only defence against hostile *text*, and
 * they are deliberately allowlist-shaped: they strip a defined class of
 * dangerous code points rather than trying to escape a defined class of
 * dangerous syntax. Everything downstream renders with `textContent`, so the
 * sanitisers exist to keep the game readable and well-behaved (no bidi
 * reordering, no control-character smuggling), not to compensate for
 * `innerHTML`.
 */

/* ========================================================================== */
/* Randomness                                                                  */
/* ========================================================================== */

/**
 * Cryptographically random lowercase hex.
 *
 * Public ids and seat tokens must be unguessable — a predictable public id
 * would let one player impersonate another by reconnecting as them.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cryptographically random base64url, no padding.
 * @param {number} bytes
 * @returns {string}
 */
export function randomToken(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ========================================================================== */
/* Room codes                                                                  */
/* ========================================================================== */

/**
 * The code alphabet.
 *
 * I, L, O, 0 and 1 are omitted because a room code is read aloud, copied off a
 * whiteboard and typed on a phone — precisely the conditions under which those
 * five characters are confused for one another. 31 symbols over 6 positions is
 * still ~8.9e8 possibilities.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/** @returns {string} a fresh room code */
export function makeRoomCode() {
  const buf = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * Normalise what a player typed into a code.
 *
 * Uppercase, then keep only characters the generator can actually emit.
 * Dropping is the right behaviour rather than folding: because I, L, O, 0 and
 * 1 are never produced, a typed one of those is always a misreading, and
 * guessing which symbol it "really" was would have to guess between two
 * candidates that are both impossible. The caller sees a short result and can
 * tell the player the code is wrong, which is more honest than silently
 * connecting them to a different room.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeRoomCode(raw) {
  let out = '';
  for (const ch of String(raw ?? '').toUpperCase()) {
    if (CODE_ALPHABET.includes(ch)) out += ch;
  }
  return out;
}

/** @param {string} code */
export function isValidRoomCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/* ========================================================================== */
/* Text sanitising                                                             */
/* ========================================================================== */

/**
 * Code points stripped from a display name.
 *
 *   U+0000–U+001F, U+007F–U+009F  C0 and C1 control characters
 *   U+200B                        zero-width space — invisible, so it can pad
 *                                 a name out to a length it does not have
 *   U+200E, U+200F                left/right-to-left marks
 *   U+202A–U+202E                 bidi embedding and override
 *   U+2066–U+2069                 bidi isolates
 *   U+061C                        Arabic letter mark
 *
 * The bidi characters are the interesting ones: they let a name reorder the
 * text around it, so a player could make the table read as though somebody
 * else were speaking. Zero-width joiner and non-joiner (U+200C, U+200D) are
 * deliberately KEPT — Persian and Arabic names use them meaningfully, and
 * emoji sequences need the joiner.
 */
const DANGEROUS = /[\u0000-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/g;

export const NAME_MAX = 24;
export const CHAT_MAX = 400;

/**
 * Clean a display name.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeName(raw) {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(DANGEROUS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

/**
 * Clean a chat message or last words. Newlines survive (up to a few), because
 * people write in paragraphs; everything else that could misbehave does not.
 *
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeChat(raw) {
  return String(raw ?? '')
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, CHAT_MAX);
}

/**
 * Is this string something a player could actually be called? Rejects empty
 * and whitespace-only names after sanitising.
 * @param {string} name
 */
export function isUsableName(name) {
  return sanitizeName(name).length >= 1;
}

/* ========================================================================== */
/* Formatting                                                                  */
/* ========================================================================== */

/**
 * Milliseconds as a clock, rounded up so a timer shows "1" for the whole of
 * its final second rather than flickering to "0" a moment early.
 *
 * @param {number} ms
 * @returns {string} e.g. "0:07"
 */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format a duration in whole seconds for a progress bar's accessible label.
 * @param {number} ms
 */
export function secondsOf(ms) {
  return Math.max(0, Math.ceil(ms / 1000));
}

/**
 * A stable, non-identifying colour index for a player, so the same person
 * keeps the same accent in the chat and the player list without the colour
 * encoding anything about their role.
 *
 * @param {string} id
 * @param {number} buckets
 */
export function colorIndexFor(id, buckets = 6) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return Math.abs(h) % buckets;
}

/**
 * Ordinal for a round number — "1st night", "2nd night". Handles the teens
 * correctly, which the naive `n % 10` version does not.
 * @param {number} n
 */
export function ordinal(n) {
  const v = Math.abs(n) % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (v % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/* ========================================================================== */
/* Commit-reveal deal proof                                                    */
/* ========================================================================== */

/**
 * SHA-256 as lowercase hex.
 *
 * Used for the commit-reveal proof: at the deal the host publishes
 * `sha256(nonce + roleMap)`; at the end it publishes the nonce and the map.
 * Anyone can verify the hash matches, which proves the roles were fixed
 * *before* the first card was turned rather than invented to fit the outcome.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical serialisation for the deal proof. Sorting the keys is essential:
 * two hosts with the same deal must produce the same string, or the proof
 * would depend on object insertion order.
 *
 * @param {string} nonce
 * @param {Record<string,string>} rolesByPublicId
 * @returns {string}
 */
export function canonicalDeal(nonce, rolesByPublicId) {
  const pairs = Object.keys(rolesByPublicId)
    .sort()
    .map((id) => `${id}:${rolesByPublicId[id]}`);
  return `${nonce}|${pairs.join(',')}`;
}

/* ========================================================================== */
/* Misc                                                                        */
/* ========================================================================== */

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Resolve after `ms`, cancellable via the returned object's `cancel()`. */
export function delay(ms) {
  let id = null;
  let cancelled = false;
  const promise = new Promise((resolve) => {
    id = setTimeout(() => {
      if (!cancelled) resolve();
    }, ms);
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      if (id != null) clearTimeout(id);
    },
  };
}

/** A monotonically increasing id, for DOM keying and effect ordering. */
let uidCounter = 0;
export function uid(prefix = 'u') {
  uidCounter += 1;
  return `${prefix}${uidCounter}`;
}

/** Text that is safe to place in a `title` or `aria-label`. */
export function safeLabel(text) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 200);
}
