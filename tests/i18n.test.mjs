/**
 * ============================================================================
 * i18n tests
 * ============================================================================
 *
 * The engine tests prove the game is fair. These prove the game is *readable*
 * in both languages, which is the one class of bug a headless engine test can
 * never catch: a key that exists in English and was forgotten in Arabic renders
 * as the raw key `hint.DAY_VOTE` on an Arabic player's screen, and the English
 * test suite passes the whole time.
 *
 * The parity checks here are cheap and they are the reason the Arabic build
 * cannot silently rot.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  LANGS,
  DEFAULT_LANG,
  getLang,
  dir,
  t,
  allKeys,
  dictionaryFor,
  translatorFor,
  isolate,
  setLang,
} from '../js/i18n.js';

const EN = dictionaryFor('en');
const AR = dictionaryFor('ar');

/** Every `{placeholder}` a string mentions. */
function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('dictionaries', () => {
  test('both languages are registered', () => {
    assert.deepEqual([...LANGS], ['en', 'ar']);
    assert.equal(DEFAULT_LANG, 'en');
    assert.ok(EN && AR);
  });

  test('every key in one language exists in the other', () => {
    const enKeys = Object.keys(EN).sort();
    const arKeys = Object.keys(AR).sort();

    const missingInAr = enKeys.filter((k) => !(k in AR));
    const missingInEn = arKeys.filter((k) => !(k in EN));

    assert.deepEqual(missingInAr, [], `missing from Arabic: ${missingInAr.join(', ')}`);
    assert.deepEqual(missingInEn, [], `missing from English: ${missingInEn.join(', ')}`);
  });

  test('allKeys() is the union of both', () => {
    const union = new Set([...Object.keys(EN), ...Object.keys(AR)]);
    assert.equal(allKeys().length, union.size);
  });

  test('no translation is empty or whitespace', () => {
    for (const lang of LANGS) {
      const dict = dictionaryFor(lang);
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(typeof value, 'string', `${lang}:${key} is not a string`);
        assert.ok(value.trim().length > 0, `${lang}:${key} is empty`);
      }
    }
  });

  test('a key uses the same placeholders in both languages', () => {
    // The failure this prevents: English "Killed: {name}" translated as
    // Arabic "قُتل" with the placeholder dropped, so an Arabic player reads a
    // sentence with no name in it — plausible enough that nobody reports it.
    const mismatched = [];
    for (const key of allKeys()) {
      const en = placeholders(EN[key]);
      const ar = placeholders(AR[key]);
      if (en.join(',') !== ar.join(',')) {
        mismatched.push(`${key}: en[${en}] vs ar[${ar}]`);
      }
    }
    assert.deepEqual(mismatched, [], mismatched.join('\n'));
  });

  test('a key keeps the same {placeholder} spelling, not a reordered one', () => {
    const bad = [];
    for (const key of allKeys()) {
      const en = new Set(placeholders(EN[key]));
      const ar = new Set(placeholders(AR[key]));
      for (const name of en) if (!ar.has(name)) bad.push(`${key}: ar is missing {${name}}`);
    }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
});

describe('lookup', () => {
  test('a missing key returns the key itself, not an empty string', () => {
    // The engine relies on this: a visible raw key is a bug report, an empty
    // label is a mystery.
    assert.equal(t('no.such.key.exists'), 'no.such.key.exists');
  });

  test('interpolation substitutes every supplied placeholder', () => {
    assert.equal(t('error.BAD_PLAYER_COUNT', { min: 5, max: 20 }), 'A game needs between 5 and 20 players.');
  });

  test('an unsupplied placeholder is left in place rather than blanked', () => {
    const out = t('error.BAD_PLAYER_COUNT', { min: 5 });
    assert.ok(out.includes('{max}'));
    assert.ok(out.includes('5'));
  });

  test('translatorFor is bound to its language, not the current one', () => {
    const ar = translatorFor('ar');
    setLang('en');
    assert.equal(ar('team.TOWN'), AR['team.TOWN']);
    assert.notEqual(ar('team.TOWN'), EN['team.TOWN']);
  });

  test('dir() follows the language', () => {
    assert.equal(dir('en'), 'ltr');
    assert.equal(dir('ar'), 'rtl');
    assert.equal(dir(getLang()), 'ltr');
  });
});

describe('bidi isolation', () => {
  test('isolate wraps in FSI/PDI', () => {
    // U+2068 FIRST STRONG ISOLATE … U+2069 POP DIRECTIONAL ISOLATE. Without
    // these, a Latin name dropped into an Arabic sentence reorders the words
    // around it and the sentence reads backwards.
    const wrapped = isolate('Alice');
    assert.equal(wrapped, '⁨Alice⁩');
    assert.equal([...wrapped][0], '⁨');
    assert.equal([...wrapped].at(-1), '⁩');
  });
});

describe('every key the UI asks for exists', () => {
  // The families the UI builds dynamically. Listing them here means a typo in
  // a template literal — `hint.NIGHT.Dectective` — fails the suite instead of
  // reaching a player's screen.
  const PHASES = [
    'LOBBY',
    'ROLE_DEAL',
    'NIGHT',
    'DAY_ANNOUNCE',
    'DAY_DISCUSS',
    'DAY_VOTE',
    'DAY_RUNOFF',
    'LAST_WORDS',
    'ENDED',
  ];
  const ROLES = ['MAFIA', 'DOCTOR', 'DETECTIVE', 'VILLAGER'];
  const TEAMS = ['TOWN', 'MAFIA', 'DRAW'];
  const SLOTS = ['KILL', 'PROTECT', 'INVESTIGATE', 'VOTE'];
  const VERDICTS = ['MAFIA', 'NOT_MAFIA'];
  const REASONS = ['ALL_MAFIA_ELIMINATED', 'MAFIA_REACHED_PARITY', 'STALEMATE'];
  const CONN = ['connecting', 'connected', 'reconnecting', 'disconnected'];
  const MOD_STEPS = ['SLEEP', 'MAFIA', 'DOCTOR', 'DETECTIVE'];

  const families = [
    ...PHASES.map((p) => `phase.${p}`),
    // Only these four phases prompt the table. `hint.<other phase>` is
    // deliberately absent, and the UI uses an allowlist to match — see
    // HINT_PHASES in js/ui.js.
    ...['DAY_DISCUSS', 'DAY_VOTE', 'DAY_RUNOFF', 'LAST_WORDS'].map((p) => `hint.${p}`),
    ...ROLES.map((r) => `hint.NIGHT.${r.toLowerCase()}`),
    ...ROLES.map((r) => `role.${r}`),
    ...ROLES.map((r) => `role.${r}.desc`),
    ...TEAMS.map((x) => `team.${x}`),
    ...SLOTS.map((s) => `slot.${s}`),
    ...VERDICTS.map((v) => `verdict.${v}`),
    ...REASONS.map((r) => `end.reason.${r}`),
    ...CONN.map((c) => `conn.${c}`),
    ...MOD_STEPS.map((s) => `mod.step.${s}`),
    ...['AUTOMATED', 'MODERATED'].map((m) => `mod.mode.${m}`),
    ...['AUTOMATED', 'MODERATED'].map((m) => `mod.mode.${m}.desc`),
    ...['PLAYERS_ACT', 'MOD_ENTERS'].map((s) => `mod.style.${s}`),
    ...['PLAYERS_ACT', 'MOD_ENTERS'].map((s) => `mod.style.${s}.desc`),
    'end.townWins',
    'end.mafiaWins',
    'end.draw',
    'chat.public',
    'chat.mafia',
    'chat.dead',
    'vote.abstain',
    'vote.cast',
    'vote.change',
  ];

  test('no family member is missing from either dictionary', () => {
    const missing = [];
    for (const key of families) {
      if (!(key in EN)) missing.push(`en:${key}`);
      if (!(key in AR)) missing.push(`ar:${key}`);
    }
    assert.deepEqual(missing, [], missing.join('\n'));
  });

  test('a sampled key from each family resolves to real text', () => {
    for (const key of families) {
      assert.notEqual(t(key), key, `unresolved key: ${key}`);
    }
  });
});
