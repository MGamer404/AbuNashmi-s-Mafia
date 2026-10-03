/**
 * Role definitions for the classic four-role Mafia game.
 *
 * This module is deliberately free of display text. Anything the player reads
 * comes from i18n.js keyed by the role id, so adding Arabic never means
 * touching game logic.
 */

/** @typedef {'VILLAGER'|'MAFIA'|'DOCTOR'|'DETECTIVE'} Role */

export const ROLE = Object.freeze({
  VILLAGER: 'VILLAGER',
  MAFIA: 'MAFIA',
  DOCTOR: 'DOCTOR',
  DETECTIVE: 'DETECTIVE',
});

export const TEAM = Object.freeze({
  TOWN: 'TOWN',
  MAFIA: 'MAFIA',
});

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 20;

/**
 * Static per-role facts. `wakesAt` is the night phase this role acts in; it is
 * also the phase the engine skips when nobody alive holds the role.
 */
export const ROLE_META = Object.freeze({
  VILLAGER: {
    id: 'VILLAGER',
    team: TEAM.TOWN,
    wakesAt: null,
    /** CSS custom property holding this role's accent colour. */
    accent: '--c-town',
  },
  MAFIA: {
    id: 'MAFIA',
    team: TEAM.MAFIA,
    wakesAt: 'NIGHT_MAFIA',
    accent: '--c-mafia',
  },
  DOCTOR: {
    id: 'DOCTOR',
    team: TEAM.TOWN,
    wakesAt: 'NIGHT_DOCTOR',
    accent: '--c-doctor',
  },
  DETECTIVE: {
    id: 'DETECTIVE',
    team: TEAM.TOWN,
    wakesAt: 'NIGHT_DETECTIVE',
    accent: '--c-detective',
  },
});

export const ALL_ROLES = Object.freeze(Object.keys(ROLE_META));

export function teamOf(role) {
  return ROLE_META[role]?.team ?? TEAM.TOWN;
}

export function isMafia(role) {
  return role === ROLE.MAFIA;
}

/**
 * How many Mafia a table of `n` gets.
 *
 * The ramp keeps the Mafia a minority that grows with the table while never
 * letting them reach parity at the deal. At 5-6 players one Mafia is standard
 * house rules; beyond that it scales roughly one per four seats.
 *
 * @param {number} n
 * @returns {number}
 */
export function mafiaCountFor(n) {
  if (n <= 6) return 1;
  if (n <= 10) return 2;
  if (n <= 14) return 3;
  if (n <= 18) return 4;
  return 5;
}

/**
 * Build the role list (as an array, to be shuffled) for a table of `n`.
 *
 * Order is intentionally NOT mafia-first or any other meaningful grouping —
 * but it does not matter, because the caller shuffles. Keeping the
 * construction order independent of seat order is what makes a shuffle the
 * only thing that can correlate role with seat.
 *
 * @param {number} n
 * @param {number} [mafiaOverride] explicit mafia count, validated
 * @returns {Role[]}
 */
export function composeRoleList(n, mafiaOverride) {
  const mafia = clampMafiaCount(n, mafiaOverride);

  // Two special town roles plus at least one plain Villager, so the town is
  // never a pure wall of power roles (which makes for a dull deduction game).
  const roles = [];
  for (let i = 0; i < mafia; i++) roles.push(ROLE.MAFIA);
  roles.push(ROLE.DOCTOR, ROLE.DETECTIVE);
  while (roles.length < n) roles.push(ROLE.VILLAGER);

  return roles.slice(0, n);
}

/**
 * Clamp a requested Mafia count to something playable for this table size.
 *
 * Legal range: at least 1, and at most one fewer than the number of town
 * seats minus the two power roles — i.e. the Mafia must never start at or
 * above parity, or the game is over before the first night.
 *
 * @param {number} n
 * @param {number} [requested]
 * @returns {number}
 */
export function clampMafiaCount(n, requested) {
  const auto = mafiaCountFor(n);
  if (requested == null || !Number.isFinite(requested)) return auto;

  // Town must retain the Doctor, the Detective, and at least one Villager
  // beyond the Mafia, and the Mafia must stay strictly below parity.
  const maxByParity = Math.max(1, Math.floor((n - 1) / 2));
  const maxByPowerRoles = Math.max(1, n - 3);

  return Math.max(1, Math.min(Math.round(requested), maxByParity, maxByPowerRoles));
}

/**
 * Is this table size playable?
 * @param {number} n
 */
export function isPlayableSize(n) {
  return Number.isInteger(n) && n >= MIN_PLAYERS && n <= MAX_PLAYERS;
}
