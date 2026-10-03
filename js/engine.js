/**
 * ============================================================================
 * AbuNashmi's Mafia — game engine
 * ============================================================================
 *
 * A single pure reducer, `reduce(state, action) -> { state, effects }`.
 *
 * Three properties this module guarantees, and which the rest of the app is
 * built to rely on:
 *
 *   1. PURITY. No DOM, no network, no Date.now(), no Math.random(). Time
 *      arrives on every action as `action.at`; randomness comes from a seeded
 *      PRNG whose state lives in `state.rng`. A game therefore replays
 *      identically from (initialState, actionLog), which is what makes the
 *      rule set testable headlessly under `node --test`.
 *
 *   2. ONE CODE PATH FOR BOTH HOST MODES. Every decision — the mafia's kill,
 *      the doctor's save, the detective's investigation, the day vote — is a
 *      `PendingAction` slot that collects player submissions and/or a
 *      moderator override and then collapses to a single `Resolution`. All
 *      downstream rules read only the Resolution. The engine structurally
 *      cannot tell whether a human tapped a button or a moderator typed it
 *      in, so "players act", "mod enters everything", and switching between
 *      them mid-phase require no special cases in the rules.
 *
 *   3. REDACTION IS A BOUNDARY, NOT A LAYER. `projectState(state, viewer)`
 *      builds an ALLOWLIST view per viewer. Secret data (roles other than
 *      your own, the mafia team, detective findings) is not "hidden" — it is
 *      never placed in the payload. A cheating client with devtools open
 *      finds nothing, because nothing secret was ever sent to it.
 */

import {
  ROLE,
  TEAM,
  isMafia,
  composeRoleList,
  clampMafiaCount,
  isPlayableSize,
  MIN_PLAYERS,
  MAX_PLAYERS,
} from './roles.js';

export { ROLE, TEAM, MIN_PLAYERS, MAX_PLAYERS };

/* ========================================================================== */
/* Phases                                                                      */
/* ========================================================================== */

/**
 * The full phase vocabulary.
 *
 * `TRANSIENT` phases are never observed by a client: they are entered and
 * resolved within a single `reduce` call, chained by `settle()`. They exist
 * because naming an intermediate step makes the rules readable and testable,
 * not because anything can stop there.
 */
export const PHASE = Object.freeze({
  LOBBY: 'LOBBY',
  ROLE_DEAL: 'ROLE_DEAL',
  NIGHT: 'NIGHT',
  NIGHT_RESOLVE: 'NIGHT_RESOLVE',
  CHECK_WIN: 'CHECK_WIN',
  DAY_ANNOUNCE: 'DAY_ANNOUNCE',
  DAY_DISCUSS: 'DAY_DISCUSS',
  DAY_VOTE: 'DAY_VOTE',
  DAY_RUNOFF: 'DAY_RUNOFF',
  DAY_ELIMINATE: 'DAY_ELIMINATE',
  LAST_WORDS: 'LAST_WORDS',
  ENDED: 'ENDED',
});

const TRANSIENT = new Set([PHASE.NIGHT_RESOLVE, PHASE.CHECK_WIN, PHASE.DAY_ELIMINATE]);

/**
 * Transient phases that still need the slots they were handed. `NIGHT_RESOLVE`
 * reads the three night slots and `CHECK_WIN` sits between a resolution and
 * whatever follows it, so clearing slots on entry to either would discard the
 * players' decisions at the exact moment they are about to be counted.
 */
const CARRIES_SLOTS = new Set([PHASE.NIGHT_RESOLVE, PHASE.CHECK_WIN]);

/** Phases rendered in the night palette. */
const NIGHT_PHASES = new Set([PHASE.ROLE_DEAL, PHASE.NIGHT, PHASE.NIGHT_RESOLVE]);

export const SLOT_KIND = Object.freeze({
  KILL: 'KILL',
  PROTECT: 'PROTECT',
  INVESTIGATE: 'INVESTIGATE',
  VOTE: 'VOTE',
});

/** The three night decision slots, in the order a moderator walks them. */
export const NIGHT_SLOTS = Object.freeze(['KILL', 'PROTECT', 'INVESTIGATE']);

/* ========================================================================== */
/* Configuration                                                               */
/* ========================================================================== */

/**
 * Every debated house rule is a config flag rather than a branch in the code,
 * so the rules stay a single readable path.
 *
 * @param {object} [overrides]
 */
export function defaultConfig(overrides = {}) {
  const base = {
    /** 'AUTOMATED' — the engine drives phases on timers. 'MODERATED' — a human referee does. */
    hostMode: 'AUTOMATED',
    /** Within MODERATED: 'PLAYERS_ACT' or 'MOD_ENTERS'. Switchable live. */
    modStyle: 'PLAYERS_ACT',
    /** In MODERATED, whether the moderator has armed a phase timer. */
    modTimersArmed: false,

    /** null = derive from table size via mafiaCountFor(). */
    mafiaCount: null,

    firstNightNoKill: true,
    allowMafiaKillMafia: false,
    allowDoctorSelfProtect: true,
    /** When false, protecting the same player two nights running is illegal. */
    allowDoctorRepeatProtect: false,
    /** 'NO_KILL' | 'RANDOM_VICTIM' — what happens if the mafia stall past the deadline. */
    mafiaNoSubmit: 'NO_KILL',
    /** Announce a successful save as such, or leave it behind "nobody died". */
    revealSave: false,
    revealOnElimination: false,
    revealDetectiveOnDeath: false,
    deadCanChat: true,
    chatEnabled: true,
    /** Stream vote counts during the window, or reveal only the final tally. */
    liveTally: false,
    /** Consecutive no-progress rounds before the game is declared a draw. */
    maxStalemateRounds: 3,

    durations: {
      deal: 6000,
      night: 30000,
      announce: 8000,
      discuss: 120000,
      vote: 60000,
      runoff: 30000,
      lastWords: 30000,
    },

    vote: {
      allowSelfVote: false,
      allowAbstain: true,
      changeableUntilDeadline: true,
      /** 'PLURALITY' | 'ABSOLUTE' */
      majorityRule: 'PLURALITY',
      /** 'PUBLIC' (who voted for whom) | 'SECRET' (tally only) */
      voteVisibility: 'PUBLIC',
      /** 'NO_ELIMINATION' | 'RUNOFF' | 'RANDOM' */
      tiePolicy: 'NO_ELIMINATION',
      /** 'ALL' | 'NON_TIED' — who may vote in a runoff. */
      runoffVoters: 'ALL',
    },
  };

  // One level of deep merge is enough for the two nested blocks, and keeps a
  // partial override (e.g. only durations.vote) working.
  return {
    ...base,
    ...overrides,
    durations: { ...base.durations, ...(overrides.durations || {}) },
    vote: { ...base.vote, ...(overrides.vote || {}) },
  };
}

/* ========================================================================== */
/* Deterministic randomness                                                    */
/* ========================================================================== */

/**
 * mulberry32, expressed as a pure state transition rather than a closure so
 * the generator state can live inside the serializable game state.
 *
 * @param {number} rng  current 32-bit state
 * @returns {{ state: number, value: number }} next state and a float in [0,1)
 */
export function rngStep(rng) {
  const next = (rng + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/**
 * Fold caller-supplied entropy into a single 32-bit PRNG seed.
 *
 * The host supplies this from `crypto.getRandomValues`, so the seed is drawn
 * from 128+ bits of CSPRNG output and is not guessable — while a test can
 * supply a fixed array and get a perfectly reproducible deal.
 *
 * @param {ArrayLike<number>|number} entropy
 * @returns {number}
 */
export function seedFrom(entropy) {
  if (typeof entropy === 'number' && Number.isFinite(entropy)) return entropy >>> 0;
  const arr = Array.from(entropy ?? [0x9e3779b9]);
  if (arr.length === 0) return 0x9e3779b9;
  let h = 0x811c9dc5;
  for (const word of arr) {
    h = Math.imul(h ^ (word >>> 0), 0x01000193) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

/**
 * Fisher-Yates driven by the engine PRNG. Returns a new array; never mutates.
 *
 * @template T
 * @param {T[]} items
 * @param {number} rng
 * @returns {{ array: T[], rng: number }}
 */
function shuffle(items, rng) {
  const array = items.slice();
  let state = rng;
  for (let i = array.length - 1; i > 0; i--) {
    const step = rngStep(state);
    state = step.state;
    const j = Math.floor(step.value * (i + 1));
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return { array, rng: state };
}

/** Pick one element, consuming PRNG state. Returns null for an empty list. */
function pickOne(items, rng) {
  if (!items || items.length === 0) return { value: null, rng };
  const step = rngStep(rng);
  return { value: items[Math.floor(step.value * items.length)], rng: step.state };
}

/* ========================================================================== */
/* State construction                                                          */
/* ========================================================================== */

/**
 * @typedef {object} Player
 * @property {string} id           opaque public id (crypto-random hex)
 * @property {string} name
 * @property {string|null} seatToken  secret reconnect credential — never projected
 * @property {string|null} role
 * @property {boolean} alive
 * @property {boolean} connected
 * @property {number} seat         join order, used only for stable board ordering
 * @property {boolean} isModerator
 * @property {boolean} isSpectator
 * @property {boolean} ready
 * @property {string|null} lastWords
 */

const EMPTY_SLOTS = () => ({ KILL: null, PROTECT: null, INVESTIGATE: null, VOTE: null });

/**
 * Build the LOBBY state. This is the only place external services are wired
 * in — `reduce` itself never touches the outside world.
 *
 * @param {object} opts
 * @param {string} opts.roomId
 * @param {ArrayLike<number>|number} [opts.entropy]
 * @param {object} [opts.config]
 * @returns {GameState}
 */
export function createInitialState({ roomId, entropy, config } = {}) {
  return {
    version: 1,
    roomId: roomId ?? '',
    config: defaultConfig(config),

    phase: PHASE.LOBBY,
    round: 0,
    /** Unique per phase entry; every decision echoes it so stale and
     *  out-of-order messages from flaky Wi-Fi are rejected, not applied. */
    phaseId: 'LOBBY:0:0',
    phaseSeq: 0,
    /** Only meaningful while phase === CHECK_WIN: where to go if nobody won. */
    gateNext: null,

    /** Insertion-ordered map of players keyed by public id. */
    players: {},

    slots: EMPTY_SLOTS(),

    night: { killTarget: null, protectTarget: null, investigate: null, deaths: [], saved: false },
    nightReport: null,
    lastVote: null,
    lastElimination: null,
    pendingElimination: null,
    pendingRunoff: null,
    lastWordsFor: null,

    /** Per-detective findings. Never leaves the host except to that detective. */
    detectiveKnowledge: {},
    /** Per-doctor most recent save, to enforce the no-repeat rule. */
    doctorHistory: {},

    lastRoundProgress: { nightDeath: false, elimination: false },
    stalemate: 0,
    win: null,

    dealProof: { commitment: null, nonce: null, rolesByPublicId: null },

    chat: [],
    chatSeq: 0,
    announcement: null,
    log: [],

    /** Monotonic broadcast counter the transport stamps onto every view. */
    seq: 0,
    epoch: 1,
    /** Host wall clock at the last applied action, so views can report serverNow. */
    lastAt: 0,

    rng: seedFrom(entropy),
  };
}

/* ========================================================================== */
/* Small pure predicates over state                                            */
/* ========================================================================== */

/** @returns {Player[]} living seated players, in stable seat order */
export function alivePlayers(state) {
  return Object.values(state.players)
    .filter((p) => p.alive && !p.isSpectator && !p.isModerator)
    .sort((a, b) => a.seat - b.seat);
}

/** @returns {Player[]} everyone in a seat (excludes moderators and spectators) */
export function seatedPlayers(state) {
  return Object.values(state.players)
    .filter((p) => !p.isSpectator && !p.isModerator)
    .sort((a, b) => a.seat - b.seat);
}

/** Living players holding a role. For MAFIA this returns every living mafioso. */
function livingWithRole(state, role) {
  return alivePlayers(state).filter((p) => p.role === role);
}

function getPlayer(state, id) {
  return state.players[id] ?? null;
}

/** Public ids in stable seat order. Board order never reflects role. */
function boardOrder(state) {
  return seatedPlayers(state).map((p) => p.id);
}

/* ========================================================================== */
/* PendingAction slots — the unification point                                 */
/* ========================================================================== */

/**
 * @typedef {object} Choice
 * @property {string|null} targetId  null encodes abstain / no action
 * @property {boolean} [abstain]
 */

/**
 * @typedef {object} PendingAction
 * @property {string} kind
 * @property {string} phaseId
 * @property {string[]} eligible
 * @property {string[]} targetSpace
 * @property {Record<string, Choice>} submissions
 * @property {Choice|null} override
 * @property {'PLURALITY'|'SINGLE'} aggregate
 * @property {'OVERRIDE_FIRST'|'OVERRIDE_ONLY'|'PLAYERS_ONLY'} resolvePolicy
 * @property {'OPEN'|'RESOLVED'} status
 * @property {Resolution|null} resolution
 */

function openSlot({ kind, phaseId, eligible, targetSpace, aggregate = 'SINGLE' }) {
  return {
    kind,
    phaseId,
    eligible: eligible.slice(),
    targetSpace: targetSpace.slice(),
    submissions: {},
    override: null,
    aggregate,
    // OVERRIDE_FIRST is the default for every slot. It makes a moderator's
    // typed value win over stale taps, and — crucially — lets a moderator
    // flip from "mod enters everything" to "players act" mid-phase without
    // discarding whatever the players already submitted.
    resolvePolicy: 'OVERRIDE_FIRST',
    status: 'OPEN',
    resolution: null,
  };
}

/** Count submissions per target. */
function tallyOf(slot) {
  /** @type {Record<string, number>} */
  const tally = {};
  for (const choice of Object.values(slot.submissions)) {
    if (!choice || choice.targetId == null) continue;
    tally[choice.targetId] = (tally[choice.targetId] || 0) + 1;
  }
  return tally;
}

/**
 * Reduce many submissions to one choice.
 *
 * For SINGLE-aggregate slots (doctor, detective) there is exactly one eligible
 * actor, so this is simply their submission. For PLURALITY (the mafia, the day
 * vote) it is the mode, with ties broken by the seeded PRNG — deterministic
 * and replayable, rather than dependent on arrival order. Arrival-order
 * tie-breaking would leak: with a single mafioso, the kill resolving the
 * instant the last message arrived would identify who was deciding.
 */
function aggregateSubmissions(slot, rng) {
  const tally = tallyOf(slot);
  const entries = Object.entries(tally);

  if (entries.length === 0) return { choice: null, tally, rng };
  if (slot.aggregate === 'SINGLE') {
    const first = Object.values(slot.submissions)[0];
    return { choice: first ?? null, tally, rng };
  }

  const max = Math.max(...entries.map(([, n]) => n));
  const leaders = entries.filter(([, n]) => n === max).map(([id]) => id);
  if (leaders.length === 1) return { choice: { targetId: leaders[0] }, tally, rng };

  const picked = pickOne(leaders, rng);
  return { choice: { targetId: picked.value }, tally, rng: picked.rng };
}

/**
 * Collapse a slot's submissions and override into a single Resolution.
 *
 * This is the function that makes the two input channels indistinguishable
 * downstream: after it runs, nothing in the engine can observe whether the
 * decision came from a tap, a moderator, or both.
 *
 * @returns {{ resolution: Resolution, rng: number }}
 */
export function resolvePending(slot, rng) {
  if (slot.status === 'RESOLVED') return { resolution: slot.resolution, rng };

  const agg = aggregateSubmissions(slot, rng);
  rng = agg.rng;

  let choice = null;
  switch (slot.resolvePolicy) {
    case 'OVERRIDE_ONLY':
      // The players are not being asked this phase; only the moderator speaks.
      choice = slot.override ?? null;
      break;
    case 'PLAYERS_ONLY':
      // The table is driving; a leftover moderator value is ignored.
      choice = agg.choice;
      break;
    case 'OVERRIDE_FIRST':
    default:
      // The default. A moderator's word beats the players', but their silence
      // must NOT beat it — otherwise every player-submitted action in the game
      // is silently discarded the moment no override is set.
      choice = slot.override ?? agg.choice;
      break;
  }

  const hadInput = Object.keys(slot.submissions).length > 0 || Boolean(slot.override);
  return {
    resolution: {
      targetId: choice ? choice.targetId : null,
      outcome: choice?.targetId != null ? 'CHOSEN' : hadInput ? 'ABSTAIN' : 'NO_ACTION',
      tally: agg.tally,
      authors: { players: Object.keys(slot.submissions), mod: Boolean(slot.override) },
    },
    rng,
  };
}

function closeSlot(slot, resolution) {
  return { ...slot, status: 'RESOLVED', resolution };
}

/* ========================================================================== */
/* Advance policy                                                              */
/* ========================================================================== */

/**
 * How a phase ends. `deadline` is an absolute host timestamp held in state;
 * the runtime owns the actual setTimeout and merely dispatches TICK. That
 * keeps the reducer pure, and makes an in-flight timer a plain number that can
 * be cancelled or re-armed atomically when the host mode changes mid-phase.
 */
function makeAdvance({ mechanism, durationMs = 0, at }) {
  return {
    mechanism, // 'AUTO_ON_TIMER' | 'WAIT_FOR_MOD' | 'MANUAL'
    durationMs,
    deadline: mechanism === 'AUTO_ON_TIMER' ? at + durationMs : null,
    remainingMs: durationMs,
    enteredAt: at,
  };
}

function armTimer(advance, at) {
  if (advance.deadline != null) return advance;
  return { ...advance, deadline: at + advance.remainingMs };
}

function disarmTimer(advance, at) {
  if (advance.deadline == null) return advance;
  return { ...advance, remainingMs: Math.max(0, advance.deadline - at), deadline: null };
}

/* ========================================================================== */
/* Phase entry                                                                 */
/* ========================================================================== */

/**
 * Set up a phase: id, slots, advance policy, and any entry effects. Purely a
 * state transformation — it never recurses. `enterPhase` wraps it with
 * `settle` so transient phases chain.
 */
function beginPhase(state, phase, at, effects) {
  let next = { ...state, phase, phaseSeq: state.phaseSeq + 1 };

  // NIGHT increments the round, so do it before the phase id is derived or the
  // id would name the round that just finished.
  if (phase === PHASE.NIGHT) next.round = state.round + 1;

  next.phaseId = `${phase}:${next.round}:${next.phaseSeq}`;
  if (!CARRIES_SLOTS.has(phase)) next.slots = EMPTY_SLOTS();
  next.gateNext = null;
  // `pendingElimination` is the baton between the vote and the (transient)
  // DAY_ELIMINATE phase, so it must survive that hop. It is cleared by
  // resolveElimination itself, and defensively at night, where a leftover
  // value from a previous round would be meaningless.
  if (phase === PHASE.NIGHT || phase === PHASE.LOBBY || phase === PHASE.ENDED) {
    next.pendingElimination = null;
  }

  const auto = next.config.hostMode === 'AUTOMATED';
  const d = next.config.durations;
  const pid = next.phaseId;
  const board = boardOrder(next);

  switch (phase) {
    case PHASE.LOBBY:
    case PHASE.ENDED:
      next.advance = makeAdvance({ mechanism: 'MANUAL', at });
      break;

    case PHASE.ROLE_DEAL:
      next.advance = auto
        ? makeAdvance({ mechanism: 'AUTO_ON_TIMER', durationMs: d.deal, at })
        : makeAdvance({ mechanism: 'WAIT_FOR_MOD', durationMs: d.deal, at });
      break;

    case PHASE.NIGHT: {
      next.night = { killTarget: null, protectTarget: null, investigate: null, deaths: [], saved: false };
      next.nightReport = null;
      next.lastElimination = null;
      next.pendingRunoff = null;
      next.lastWordsFor = null;

      // The stalemate counter only advances on a genuinely unproductive round,
      // and resets the moment anything happens — so a quiet first night cannot
      // accumulate toward an unintended draw.
      if (next.round > 1) {
        const p = next.lastRoundProgress;
        next.stalemate = p.nightDeath || p.elimination ? 0 : next.stalemate + 1;
      }
      next.lastRoundProgress = { nightDeath: false, elimination: false };

      const mafia = livingWithRole(next, ROLE.MAFIA);
      const doctor = livingWithRole(next, ROLE.DOCTOR);
      const detective = livingWithRole(next, ROLE.DETECTIVE);

      if (mafia.length > 0) {
        const targets = board.filter((id) => {
          const p = getPlayer(next, id);
          if (!p?.alive) return false;
          if (next.config.allowMafiaKillMafia) return true;
          return !isMafia(p.role);
        });
        next.slots.KILL = openSlot({
          kind: SLOT_KIND.KILL,
          phaseId: pid,
          eligible: mafia.map((p) => p.id),
          targetSpace: targets,
          aggregate: 'PLURALITY',
        });
      }

      if (doctor.length > 0) {
        const doctorId = doctor[0].id;
        const lastProtect = next.doctorHistory[doctorId] ?? null;
        // An illegal target is removed from the space rather than rejected on
        // submit, so the doctor's picker simply does not offer it.
        const targets = board.filter((id) => {
          const p = getPlayer(next, id);
          if (!p?.alive) return false;
          if (!next.config.allowDoctorSelfProtect && id === doctorId) return false;
          if (!next.config.allowDoctorRepeatProtect && id === lastProtect) return false;
          return true;
        });
        next.slots.PROTECT = openSlot({
          kind: SLOT_KIND.PROTECT,
          phaseId: pid,
          eligible: [doctorId],
          targetSpace: targets,
          aggregate: 'SINGLE',
        });
      }

      if (detective.length > 0) {
        const detectiveId = detective[0].id;
        next.slots.INVESTIGATE = openSlot({
          kind: SLOT_KIND.INVESTIGATE,
          phaseId: pid,
          eligible: [detectiveId],
          targetSpace: board.filter((id) => getPlayer(next, id)?.alive && id !== detectiveId),
          aggregate: 'SINGLE',
        });
      }

      effects.push({ type: 'PUBLIC', event: { kind: 'PHASE', phase, round: next.round, night: true } });

      // A FIXED-LENGTH window, deliberately not shortened when everyone has
      // acted. If the night ended the instant the last mafioso submitted, the
      // end time alone would identify who was still deciding. A moderator may
      // still advance early — they are the trust root and it is their call.
      next.advance = auto
        ? makeAdvance({ mechanism: 'AUTO_ON_TIMER', durationMs: d.night, at })
        : makeAdvance({
            mechanism: next.config.modTimersArmed ? 'AUTO_ON_TIMER' : 'WAIT_FOR_MOD',
            durationMs: d.night,
            at,
          });
      break;
    }

    case PHASE.NIGHT_RESOLVE:
    case PHASE.CHECK_WIN:
    case PHASE.DAY_ELIMINATE:
      next.advance = makeAdvance({ mechanism: 'MANUAL', at });
      break;

    case PHASE.DAY_ANNOUNCE:
      effects.push({ type: 'PUBLIC', event: { kind: 'PHASE', phase, round: next.round, night: false } });
      next.advance = auto
        ? makeAdvance({ mechanism: 'AUTO_ON_TIMER', durationMs: d.announce, at })
        : makeAdvance({ mechanism: 'WAIT_FOR_MOD', durationMs: d.announce, at });
      break;

    case PHASE.DAY_DISCUSS:
      next.advance = auto
        ? makeAdvance({ mechanism: 'AUTO_ON_TIMER', durationMs: d.discuss, at })
        : makeAdvance({ mechanism: 'WAIT_FOR_MOD', durationMs: d.discuss, at });
      break;

    case PHASE.DAY_VOTE: {
      const voters = alivePlayers(next).map((p) => p.id);
      next.slots.VOTE = openSlot({
        kind: SLOT_KIND.VOTE,
        phaseId: pid,
        eligible: voters,
        targetSpace: board.filter((id) => getPlayer(next, id)?.alive),
        aggregate: 'PLURALITY',
      });
      next.advance = auto
        ? makeAdvance({ mechanism: 'AUTO_ON_TIMER', durationMs: d.vote, at })
        : makeAdvance({
            mechanism: next.config.modTimersArmed ? 'AUTO_ON_TIMER' : 'WAIT_FOR_MOD',
            durationMs: d.vote,
            at,
          });
      break;
    }

    case PHASE.DAY_RUNOFF: {
      const tied = next.pendingRunoff ?? [];
      const alive = alivePlayers(next).map((p) => p.id);
      const voters =
        next.config.vote.runoffVoters === 'NON_TIED'
          ? alive.filter((id) => !tied.includes(id))
          : alive;
      next.slots.VOTE = openSlot({
        kind: SLOT_KIND.VOTE,
        phaseId: pid,
        eligible: voters,
        targetSpace: tied,
        aggregate: 'PLURALITY',
      });
      next.advance = auto
        ? makeAdvance({ mechanism: 'AUTO_ON_TIMER', durationMs: d.runoff, at })
        : makeAdvance({ mechanism: 'WAIT_FOR_MOD', durationMs: d.runoff, at });
      break;
    }

    case PHASE.LAST_WORDS:
      next.advance = auto
        ? makeAdvance({ mechanism: 'AUTO_ON_TIMER', durationMs: d.lastWords, at })
        : makeAdvance({ mechanism: 'WAIT_FOR_MOD', durationMs: d.lastWords, at });
      break;

    default:
      next.advance = makeAdvance({ mechanism: 'MANUAL', at });
  }

  return { state: next, effects };
}

/* ========================================================================== */
/* Transient settlement                                                        */
/* ========================================================================== */

/**
 * Run through transient phases until the machine rests somewhere a client can
 * observe, or the game ends.
 *
 * `gateNext` is how CHECK_WIN knows where to resume. It is set by whoever
 * entered the gate (night resolution resumes at dawn; an elimination resumes
 * at the next night) and cleared by `beginPhase`, so the loop can never
 * re-enter the gate.
 */
function settle(state, at, effects) {
  let current = state;
  let guard = 0;

  while (TRANSIENT.has(current.phase) && guard++ < 32) {
    if (current.phase === PHASE.NIGHT_RESOLVE) {
      const r = resolveNight(current, at, effects);
      current = r.state;
      effects = r.effects;
      continue;
    }

    if (current.phase === PHASE.DAY_ELIMINATE) {
      const r = resolveElimination(current, at, effects);
      current = r.state;
      effects = r.effects;
      continue;
    }

    // CHECK_WIN
    const win = evaluateWin(current);
    if (win) return endGame(current, win, at, effects);

    const nextPhase = current.gateNext ?? PHASE.NIGHT;
    const r = beginPhase(current, nextPhase, at, effects);
    current = r.state;
    effects = r.effects;
  }

  return { state: current, effects };
}

/** Stamp the terminal state: the deal is revealed and no slot is left open. */
function endGame(state, win, at, effects) {
  const ended = {
    ...state,
    win,
    phase: PHASE.ENDED,
    phaseSeq: state.phaseSeq + 1,
    gateNext: null,
    pendingElimination: null,
  };
  ended.phaseId = `${PHASE.ENDED}:${ended.round}:${ended.phaseSeq}`;
  ended.slots = EMPTY_SLOTS();
  ended.advance = makeAdvance({ mechanism: 'MANUAL', at });
  effects.push({ type: 'GAME_OVER', win });
  return { state: ended, effects };
}

/** Set up `phase`, then settle through anything transient. */
function enterPhase(state, phase, at, effects = []) {
  const r = beginPhase(state, phase, at, effects);
  return settle(r.state, at, r.effects);
}

/**
 * Enter the CHECK_WIN gate with an explicit resume phase, and settle — a win
 * is decided here and now, not one scheduler tick later.
 */
function toCheckWin(state, gateNext, at, effects) {
  const r = beginPhase(state, PHASE.CHECK_WIN, at, effects);
  return settle({ ...r.state, gateNext }, at, r.effects);
}

/* ========================================================================== */
/* Night resolution                                                            */
/* ========================================================================== */

/**
 * Resolve the night. The order is fixed and deliberate:
 *
 *   1. freeze every slot
 *   2. resolve KILL
 *   3. resolve PROTECT
 *   4. deliver the INVESTIGATE finding privately
 *   5. compute deaths
 *   6. apply the first-night-no-kill override
 *   7. hand off to the win gate
 *
 * Investigation resolves before deaths, so a detective killed the same night
 * still receives the finding they earned.
 */
function resolveNight(state, at, effects) {
  let next = state;
  let rng = next.rng;

  // --- kill ---------------------------------------------------------------
  let killSlot = next.slots.KILL;
  let killTarget = null;
  if (killSlot) {
    const r = resolvePending(killSlot, rng);
    rng = r.rng;
    killTarget = r.resolution.targetId;

    // A stalled mafia produces a defined outcome rather than an implicit one.
    if (killTarget == null && next.config.mafiaNoSubmit === 'RANDOM_VICTIM') {
      const space = killSlot.targetSpace.filter((id) => getPlayer(next, id)?.alive);
      const picked = pickOne(space, rng);
      rng = picked.rng;
      killTarget = picked.value;
    }
    killSlot = closeSlot(killSlot, {
      ...r.resolution,
      targetId: killTarget,
      outcome: killTarget != null ? 'CHOSEN' : 'NO_KILL',
    });
  }

  // --- protect ------------------------------------------------------------
  let protectSlot = next.slots.PROTECT;
  let protectTarget = null;
  if (protectSlot) {
    const r = resolvePending(protectSlot, rng);
    rng = r.rng;
    protectTarget = r.resolution.targetId;
    protectSlot = closeSlot(protectSlot, r.resolution);
  }

  // --- investigate --------------------------------------------------------
  let investigateSlot = next.slots.INVESTIGATE;
  let finding = null;
  if (investigateSlot) {
    const r = resolvePending(investigateSlot, rng);
    rng = r.rng;
    investigateSlot = closeSlot(investigateSlot, r.resolution);
    const detectiveId = investigateSlot.eligible[0];
    const targetId = r.resolution.targetId;
    if (detectiveId && targetId) {
      const target = getPlayer(next, targetId);
      const verdict = target && isMafia(target.role) ? 'MAFIA' : 'NOT_MAFIA';
      finding = { detectiveId, targetId, verdict, round: next.round };
      effects.push({
        type: 'PRIVATE',
        to: detectiveId,
        event: { kind: 'INVESTIGATION_RESULT', targetId, verdict, round: next.round },
      });
    }
  }

  // --- deaths -------------------------------------------------------------
  const firstNightPass = next.round === 1 && next.config.firstNightNoKill;
  const saved = killTarget != null && protectTarget === killTarget;
  const killed = killTarget != null && !saved && !firstNightPass ? killTarget : null;

  const players = { ...next.players };
  const deaths = [];
  if (killed) {
    const victim = players[killed];
    if (victim?.alive) {
      players[killed] = { ...victim, alive: false };
      deaths.push(killed);
      effects.push({ type: 'PUBLIC', event: { kind: 'DEATH', playerId: killed, cause: 'NIGHT' } });
    }
  }

  const doctorHistory = { ...next.doctorHistory };
  if (protectSlot?.eligible[0]) doctorHistory[protectSlot.eligible[0]] = protectTarget;

  const detectiveKnowledge = { ...next.detectiveKnowledge };
  if (finding) {
    detectiveKnowledge[finding.detectiveId] = [
      ...(detectiveKnowledge[finding.detectiveId] || []),
      { round: finding.round, targetId: finding.targetId, verdict: finding.verdict },
    ];
  }

  next = {
    ...next,
    players,
    doctorHistory,
    detectiveKnowledge,
    rng,
    slots: { ...EMPTY_SLOTS(), KILL: killSlot, PROTECT: protectSlot, INVESTIGATE: investigateSlot },
    night: { killTarget, protectTarget, investigate: finding, deaths, saved },
    nightReport: {
      round: next.round,
      killedId: killed,
      // A save is announced only when the table opted in. Otherwise it is
      // indistinguishable from a mafia no-show — which is exactly the
      // ambiguity the Doctor's role depends on.
      saved: next.config.revealSave ? saved : false,
      noKillNight: firstNightPass,
    },
    lastRoundProgress: { ...next.lastRoundProgress, nightDeath: deaths.length > 0 },
  };

  // Win is evaluated immediately after deaths, so a game whose last mafioso
  // died at night cannot leak into a day phase they did not earn.
  return toCheckWin(next, PHASE.DAY_ANNOUNCE, at, effects);
}

/* ========================================================================== */
/* Vote resolution and elimination                                             */
/* ========================================================================== */

function resolveVote(state, at, effects) {
  const slot = state.slots.VOTE;
  if (!slot) return enterPhase(state, PHASE.DAY_ELIMINATE, at, effects);

  const r = resolvePending(slot, state.rng);
  const closed = closeSlot(slot, r.resolution);
  const tally = r.resolution.tally;

  let next = { ...state, rng: r.rng, slots: { ...EMPTY_SLOTS(), VOTE: closed }, lastVote: tally };

  const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const top = entries.length ? entries[0][1] : 0;
  const leaders = entries.filter(([, n]) => n === top).map(([id]) => id);

  effects.push({ type: 'PUBLIC', event: { kind: 'VOTE_CLOSED', tally, leaders } });

  // Nobody voted, or everyone abstained.
  if (leaders.length === 0 || top === 0) {
    next.lastElimination = null;
    return enterPhase(next, PHASE.DAY_ELIMINATE, at, effects);
  }

  if (leaders.length > 1) {
    const policy = next.config.vote.tiePolicy;
    // A runoff that ties again falls through to the configured policy rather
    // than looping forever.
    if (policy === 'RUNOFF' && state.phase !== PHASE.DAY_RUNOFF) {
      next.pendingRunoff = leaders;
      effects.push({ type: 'PUBLIC', event: { kind: 'VOTE_TIED', tied: leaders, tally } });
      return enterPhase(next, PHASE.DAY_RUNOFF, at, effects);
    }
    if (policy === 'RANDOM') {
      const picked = pickOne(leaders, next.rng);
      next = { ...next, rng: picked.rng, pendingElimination: picked.value };
      return enterPhase(next, PHASE.DAY_ELIMINATE, at, effects);
    }
    // NO_ELIMINATION — including a runoff that tied again.
    next.lastElimination = null;
    return enterPhase(next, PHASE.DAY_ELIMINATE, at, effects);
  }

  next.pendingElimination = leaders[0];
  return enterPhase(next, PHASE.DAY_ELIMINATE, at, effects);
}

/**
 * Apply a pending elimination, or record that the day produced none. Either
 * way control passes to the win gate, resuming at the next night.
 */
function resolveElimination(state, at, effects) {
  const id = state.pendingElimination ?? null;
  let next = { ...state, pendingElimination: null };

  const victim = id ? next.players[id] : null;
  if (!victim || !victim.alive) {
    next = {
      ...next,
      lastElimination: null,
      lastRoundProgress: { ...next.lastRoundProgress, elimination: false },
    };
    return toCheckWin(next, PHASE.NIGHT, at, effects);
  }

  next = {
    ...next,
    players: { ...next.players, [id]: { ...victim, alive: false } },
    lastElimination: { playerId: id, role: next.config.revealOnElimination ? victim.role : null },
    lastRoundProgress: { ...next.lastRoundProgress, elimination: true },
    lastWordsFor: id,
  };

  effects.push({ type: 'PUBLIC', event: { kind: 'DEATH', playerId: id, cause: 'VOTE' } });

  // If that vote decided the game, it is over. Last words are for a game that
  // carries on — the terminal reveal already shows everything the table wants
  // to know, so holding the room in a eulogy would only delay the scoreboard.
  const win = evaluateWin(next);
  if (win) return endGame(next, win, at, effects);

  const r = beginPhase(next, PHASE.LAST_WORDS, at, effects);
  return { state: r.state, effects: r.effects };
}

/* ========================================================================== */
/* Win conditions                                                              */
/* ========================================================================== */

/**
 * @typedef {object} WinResult
 * @property {'TOWN'|'MAFIA'|'DRAW'} winner
 * @property {string} reason
 */

/**
 * Evaluated immediately on every death and again at the CHECK_WIN gate.
 *
 * Checking only at phase boundaries would let a game continue into a day phase
 * after the final mafioso already died at night — the losing side would get
 * one more turn they had not earned.
 *
 * @returns {WinResult|null}
 */
export function evaluateWin(state) {
  const alive = alivePlayers(state);
  const mafia = alive.filter((p) => isMafia(p.role));
  const town = alive.filter((p) => !isMafia(p.role));

  if (mafia.length === 0) return { winner: TEAM.TOWN, reason: 'ALL_MAFIA_ELIMINATED' };
  if (mafia.length >= town.length) return { winner: TEAM.MAFIA, reason: 'MAFIA_REACHED_PARITY' };
  if (state.stalemate >= state.config.maxStalemateRounds) return { winner: 'DRAW', reason: 'STALEMATE' };
  return null;
}

/* ========================================================================== */
/* Role assignment                                                             */
/* ========================================================================== */

/**
 * Deal roles to seats.
 *
 * Two independent shuffles, which is the point: shuffling the role bag alone
 * would still let an attacker who knows the construction order correlate a
 * seat with a role. Shuffling the seat order independently breaks that, so
 * players[0] is not "the mafia" even to someone who read this source.
 *
 * @param {string[]} playerIds in seat order
 * @param {object} config
 * @param {number} rng
 * @returns {{ roles: Record<string,string>, rng: number }}
 */
export function assignRoles(playerIds, config, rng) {
  const bag = shuffle(composeRoleList(playerIds.length, config.mafiaCount), rng);
  const seats = shuffle(playerIds, bag.rng);

  const roles = {};
  for (let i = 0; i < seats.array.length; i++) roles[seats.array[i]] = bag.array[i];
  return { roles, rng: seats.rng };
}

/* ========================================================================== */
/* Redaction                                                                   */
/* ========================================================================== */

/**
 * The anti-cheat boundary.
 *
 * Builds an ALLOWLIST projection for one viewer. Anything not explicitly
 * copied here does not exist on that client, so a player with devtools open
 * has nothing to read. Allowlisting rather than deleting is deliberate: a
 * blacklist silently starts leaking the day someone adds a new secret field
 * and forgets to add a matching deletion for it.
 *
 * @param {GameState} state
 * @param {object} viewer  resolved by the HOST from its connection map — never
 *                         from anything the client claimed about itself
 * @returns {object} the client view
 */
export function projectState(state, viewer) {
  const isMod = Boolean(viewer?.isModerator);
  const me = viewer?.id ? state.players[viewer.id] : null;
  const role = me?.role ?? null;
  const alive = me?.alive ?? false;
  const ended = state.phase === PHASE.ENDED;

  const view = {
    v: 1,
    roomId: state.roomId,
    epoch: state.epoch,
    seq: state.seq,
    serverNow: state.lastAt,
    phase: state.phase,
    phaseId: state.phaseId,
    isNight: NIGHT_PHASES.has(state.phase),
    round: state.round,
    phaseEndsAt: state.advance?.deadline ?? null,
    advance: state.advance
      ? {
          mechanism: state.advance.mechanism,
          durationMs: state.advance.durationMs,
          remainingMs: state.advance.remainingMs,
          enteredAt: state.advance.enteredAt,
        }
      : null,

    config: {
      hostMode: state.config.hostMode,
      modStyle: state.config.modStyle,
      mafiaCount: clampMafiaCount(seatedPlayers(state).length, state.config.mafiaCount),
      playerCount: seatedPlayers(state).length,
      firstNightNoKill: state.config.firstNightNoKill,
      chatEnabled: state.config.chatEnabled,
      deadCanChat: state.config.deadCanChat,
      liveTally: state.config.liveTally,
      revealOnElimination: state.config.revealOnElimination,
      vote: { ...state.config.vote },
    },

    self: {
      id: me?.id ?? null,
      name: me?.name ?? '',
      role,
      alive,
      connected: me?.connected ?? false,
      isModerator: Boolean(me?.isModerator),
      isSpectator: me ? me.isSpectator : true,
      ready: Boolean(me?.ready),
    },

    board: {
      players: seatedPlayers(state).map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        // A role is attached only when the table chose to reveal it early, or
        // once the game is over.
        role: ended || (state.config.revealOnElimination && !p.alive) ? p.role : undefined,
      })),
      nightReport: state.nightReport,
      lastElimination: state.lastElimination,
      lastVote: state.config.vote.voteVisibility === 'PUBLIC' ? state.lastVote : null,
      tally: state.lastVote,
      announcement: state.announcement,
      lastWordsFor: state.lastWordsFor,
      reveal: ended ? Object.fromEntries(seatedPlayers(state).map((p) => [p.id, p.role])) : undefined,
      dealProof: ended ? state.dealProof : undefined,
    },

    chat: state.config.chatEnabled ? state.chat.filter((m) => canSeeChannel(state, viewer, m)) : [],
  };

  // ---- per-viewer secrets ----
  // `privateNotes` is absent entirely for a spectator, so there is no container
  // to inspect even if a client goes looking.
  if (me && !me.isSpectator) {
    const notes = { canAct: alive && !ended && !me.isModerator };

    if (isMafia(role)) {
      // Mafia must know each other to coordinate. They must never learn the
      // Doctor or the Detective.
      notes.mafiaTeam = seatedPlayers(state)
        .filter((p) => isMafia(p.role) && p.id !== me.id)
        .map((p) => ({ id: p.id, name: p.name, alive: p.alive }));
    }
    if (role === ROLE.DETECTIVE) {
      notes.detectiveResults = (state.detectiveKnowledge[me.id] || []).map((f) => ({
        round: f.round,
        targetId: f.targetId,
        verdict: f.verdict,
      }));
    }
    if (role === ROLE.DOCTOR) {
      notes.doctorLastProtectedId = state.doctorHistory[me.id] ?? null;
    }

    notes.pending = projectOwnSlot(state, me);
    view.privateNotes = notes;
  }

  if (isMod) view.moderator = projectModerator(state);

  return view;
}

/** The one slot this viewer may act on right now, plus its legal targets. */
function projectOwnSlot(state, me) {
  for (const slot of Object.values(state.slots)) {
    if (!slot || slot.status !== 'OPEN' || !slot.eligible.includes(me.id)) continue;
    return {
      kind: slot.kind,
      phaseId: slot.phaseId,
      targetSpace: slot.targetSpace.slice(),
      myChoice: slot.submissions[me.id] ?? null,
      // Submission *counts* are public; submission *contents* are not.
      submittedCount: Object.keys(slot.submissions).length,
      eligibleCount: slot.eligible.length,
    };
  }
  return null;
}

/** Which chat channels may this viewer read? */
function canSeeChannel(state, viewer, message) {
  if (viewer?.isModerator) return true;
  const me = viewer?.id ? state.players[viewer.id] : null;
  if (!me) return message.channel === 'public';

  switch (message.channel) {
    case 'public':
      // The dead keep reading the public channel; they simply cannot post.
      return true;
    case 'mafia':
      return isMafia(me.role);
    case 'dead':
      return !me.alive;
    default:
      return false;
  }
}

/**
 * The moderator's full-secret projection. Rendered only on the moderator's own
 * client — the role map never traverses the network when host === moderator,
 * which is the default arrangement.
 */
function projectModerator(state) {
  const slots = {};
  for (const [key, slot] of Object.entries(state.slots)) {
    if (!slot) continue;
    slots[key] = {
      kind: slot.kind,
      phaseId: slot.phaseId,
      status: slot.status,
      eligible: slot.eligible.slice(),
      targetSpace: slot.targetSpace.slice(),
      submissions: Object.fromEntries(
        Object.entries(slot.submissions).map(([k, v]) => [k, v?.targetId ?? null])
      ),
      override: slot.override ? slot.override.targetId : null,
      resolution: slot.resolution,
    };
  }

  return {
    seats: seatedPlayers(state).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      alive: p.alive,
      connected: p.connected,
      ready: p.ready,
      submitted: Object.values(state.slots).some(
        (s) => s && s.status === 'OPEN' && s.eligible.includes(p.id) && s.submissions[p.id] != null
      ),
    })),
    slots,
    detectiveKnowledge: state.detectiveKnowledge,
    doctorHistory: state.doctorHistory,
    night: state.night,
    lastVote: state.lastVote,
    pendingElimination: state.pendingElimination,
    lastWordsFor: state.lastWordsFor,
    stalemate: state.stalemate,
    win: state.win,
    advance: state.advance,
  };
}

/* ========================================================================== */
/* The reducer                                                                 */
/* ========================================================================== */

/**
 * @param {GameState} state
 * @param {object} action  every action carries `at` (host epoch ms)
 * @returns {{ state: GameState, effects: Effect[] }}
 */
export function reduce(state, action) {
  const at = Number.isFinite(action?.at) ? action.at : state.lastAt;
  const effects = [];
  state = { ...state, lastAt: at };

  switch (action.type) {
    /* ---------------------------------------------------------------- lobby */
    case 'JOIN': {
      // Joining after the deal makes you a spectator. Promoting someone
      // mid-game would hand out a role the table never accounted for.
      const asSpectator = Boolean(action.asSpectator) || state.phase !== PHASE.LOBBY;
      if (asSpectator) {
        const p = makePlayer(action, state, { isSpectator: true, isModerator: false });
        return {
          state: { ...state, players: { ...state.players, [p.id]: p } },
          effects: [{ type: 'PUBLIC', event: { kind: 'SPECTATOR_JOINED', playerId: p.id, name: p.name } }],
        };
      }
      if (seatedPlayers(state).length >= MAX_PLAYERS) {
        return { state, effects: [{ type: 'PRIVATE', to: action.id, event: { kind: 'ERROR', code: 'ROOM_FULL' } }] };
      }
      const p = makePlayer(action, state, {});
      return {
        state: { ...state, players: { ...state.players, [p.id]: p } },
        effects: [{ type: 'PUBLIC', event: { kind: 'PLAYER_JOINED', playerId: p.id, name: p.name } }],
      };
    }

    case 'ADD_MODERATOR': {
      const p = makePlayer(action, state, { isSpectator: true, isModerator: true });
      return {
        state: { ...state, players: { ...state.players, [p.id]: p } },
        effects: [{ type: 'PUBLIC', event: { kind: 'MODERATOR_JOINED', playerId: p.id, name: p.name } }],
      };
    }

    case 'LEAVE': {
      const p = getPlayer(state, action.playerId);
      if (!p) return { state, effects };
      if (state.phase === PHASE.LOBBY) {
        const players = { ...state.players };
        delete players[action.playerId];
        return {
          state: { ...state, players },
          effects: [{ type: 'PUBLIC', event: { kind: 'PLAYER_LEFT', playerId: action.playerId } }],
        };
      }
      // Mid-game a departure keeps the seat: roles are already dealt, and
      // removing a body would silently change the win arithmetic.
      return {
        state: { ...state, players: { ...state.players, [action.playerId]: { ...p, connected: false } } },
        effects: [{ type: 'PUBLIC', event: { kind: 'PLAYER_DISCONNECTED', playerId: action.playerId } }],
      };
    }

    case 'RECONNECT': {
      const p = getPlayer(state, action.playerId);
      if (!p) {
        return { state, effects: [{ type: 'PRIVATE', to: action.peerId, event: { kind: 'ERROR', code: 'NO_SUCH_SEAT' } }] };
      }
      return {
        state: { ...state, players: { ...state.players, [action.playerId]: { ...p, connected: true } } },
        effects: [{ type: 'PUBLIC', event: { kind: 'PLAYER_RECONNECTED', playerId: action.playerId } }],
      };
    }

    case 'SET_READY': {
      const p = getPlayer(state, action.playerId);
      if (!p) return { state, effects };
      const ready = Boolean(action.ready);
      return {
        state: { ...state, players: { ...state.players, [action.playerId]: { ...p, ready } } },
        effects: [{ type: 'PUBLIC', event: { kind: 'READY', playerId: action.playerId, ready } }],
      };
    }

    /* ---------------------------------------------------------------- start */
    case 'START': {
      if (state.phase !== PHASE.LOBBY) return { state, effects };
      const seated = seatedPlayers(state);
      if (!isPlayableSize(seated.length)) {
        return {
          state,
          effects: [{ type: 'PRIVATE', to: action.playerId, event: { kind: 'ERROR', code: 'BAD_PLAYER_COUNT' } }],
        };
      }
      const dealt = assignRoles(seated.map((p) => p.id), state.config, state.rng);
      const players = { ...state.players };
      for (const [id, role] of Object.entries(dealt.roles)) players[id] = { ...players[id], role };

      const next = {
        ...state,
        players,
        rng: dealt.rng,
        dealProof: { commitment: null, nonce: null, rolesByPublicId: { ...dealt.roles } },
      };
      return enterPhase(next, PHASE.ROLE_DEAL, at, effects);
    }

    case 'SET_DEAL_COMMITMENT': {
      return {
        state: { ...state, dealProof: { ...state.dealProof, commitment: action.commitment, nonce: action.nonce } },
        effects,
      };
    }

    /* ------------------------------------------------------------ decisions */
    case 'SUBMIT': {
      const guard = guardSlot(state, action);
      if (guard.error) {
        return { state, effects: [privateError(action.playerId, guard.error)] };
      }
      const { slotKey, slot } = guard;

      const illegal = checkChoice(state, slot, action.playerId, action.choice);
      if (illegal) return { state, effects: [privateError(action.playerId, illegal)] };

      // "Changeable until the deadline" is per-room; when off, the first vote
      // a player casts is the one that counts.
      if (slot.submissions[action.playerId] && !isChangeable(state, slot)) {
        return { state, effects: [privateError(action.playerId, 'ALREADY_VOTED')] };
      }

      const updated = { ...slot, submissions: { ...slot.submissions, [action.playerId]: action.choice } };
      return {
        state: { ...state, slots: { ...state.slots, [slotKey]: updated } },
        effects: [{ type: 'PRIVATE', to: action.playerId, event: { kind: 'SUBMITTED', kindOf: slot.kind } }],
      };
    }

    case 'RETRACT': {
      const guard = guardSlot(state, action);
      if (guard.error) return { state, effects };
      const { slotKey, slot } = guard;
      if (!isChangeable(state, slot)) return { state, effects };
      const submissions = { ...slot.submissions };
      delete submissions[action.playerId];
      return { state: { ...state, slots: { ...state.slots, [slotKey]: { ...slot, submissions } } }, effects };
    }

    /* --------------------------------------------------- moderator controls */
    case 'MOD_OVERRIDE': {
      const slot = state.slots[action.slot];
      if (!slot) return { state, effects };
      const targetId = action.choice?.targetId ?? null;

      if (targetId != null) {
        if (!slot.targetSpace.includes(targetId)) {
          // A typo'd target must not silently become a legal action.
          return { state, effects: [privateError(action.playerId, 'INVALID_TARGET')] };
        }
        // The moderator is bound by the same rules as a player, so "mod enters
        // everything" cannot bypass a core constraint. For a vote they speak
        // for the table rather than casting one ballot, hence the null actor.
        const actor = slot.kind === SLOT_KIND.VOTE ? null : slot.eligible[0];
        const illegal = checkChoice(state, slot, actor, { targetId });
        if (illegal) return { state, effects: [privateError(action.playerId, illegal)] };
      }

      return {
        state: { ...state, slots: { ...state.slots, [action.slot]: { ...slot, override: { targetId } } } },
        effects: [{ type: 'MOD_ACTION', actor: action.playerId, slot: action.slot, targetId }],
      };
    }

    case 'MOD_CLEAR_OVERRIDE': {
      const slot = state.slots[action.slot];
      if (!slot) return { state, effects };
      return {
        state: { ...state, slots: { ...state.slots, [action.slot]: { ...slot, override: null } } },
        effects: [],
      };
    }

    case 'MOD_CONFIG': {
      // In the lobby, a full config replacement is fine.
      if (state.phase !== PHASE.LOBBY) return { state, effects };
      return { state: { ...state, config: defaultConfig({ ...state.config, ...action.patch }) }, effects };
    }

    case 'SET_CONFIG_LIVE': {
      // Mid-game, only the flags that cannot invalidate a decision already on
      // the table are settable: how the phase ends, and how it is narrated.
      const allowed = {};
      for (const key of ['modTimersArmed', 'chatEnabled', 'deadCanChat', 'liveTally', 'revealOnElimination', 'modStyle']) {
        if (key in (action.patch || {})) allowed[key] = action.patch[key];
      }
      if (action.patch?.vote) {
        allowed.vote = {};
        for (const key of ['voteVisibility', 'liveTally']) {
          if (key in action.patch.vote) allowed.vote[key] = action.patch.vote[key];
        }
      }
      const config = defaultConfig({ ...state.config, ...allowed });
      let next = { ...state, config };

      if (next.advance && 'modTimersArmed' in allowed) {
        if (allowed.modTimersArmed) {
          next.advance = armTimer(next.advance, at);
          if (next.advance.deadline != null) effects.push({ type: 'SET_TIMER', deadline: next.advance.deadline });
        } else if (next.config.hostMode === 'MODERATED') {
          next.advance = disarmTimer(next.advance, at);
          effects.push({ type: 'CLEAR_TIMER' });
        }
      }
      return { state: next, effects };
    }

    case 'SET_HOST_MODE': {
      const config = defaultConfig({ ...state.config, hostMode: action.mode });
      let next = { ...state, config };

      // Switching policy is a state edit, never a rebuild: the slot contents
      // are preserved, so a moderator can take over mid-phase without losing
      // whatever the players already decided.
      if (next.advance) {
        if (action.mode === 'MODERATED' && !config.modTimersArmed) {
          next.advance = disarmTimer(next.advance, at);
          effects.push({ type: 'CLEAR_TIMER' });
        } else if (action.mode === 'AUTOMATED') {
          next.advance =
            next.advance.deadline == null && next.advance.mechanism === 'WAIT_FOR_MOD'
              ? { ...next.advance, mechanism: 'AUTO_ON_TIMER' }
              : next.advance;
          next.advance = armTimer(next.advance, at);
          if (next.advance.deadline != null) effects.push({ type: 'SET_TIMER', deadline: next.advance.deadline });
        }
      }
      effects.push({ type: 'PUBLIC', event: { kind: 'HOST_MODE', mode: action.mode } });
      return { state: next, effects };
    }

    case 'SET_MOD_STYLE': {
      const config = defaultConfig({ ...state.config, modStyle: action.style });
      effects.push({ type: 'PUBLIC', event: { kind: 'MOD_STYLE', style: action.style } });
      return { state: { ...state, config }, effects };
    }

    case 'SET_ADVANCE_POLICY': {
      if (!state.advance) return { state, effects };
      let advance = { ...state.advance };
      if (action.durationMs != null) advance.durationMs = action.durationMs;

      if (action.armed) {
        advance.mechanism = 'AUTO_ON_TIMER';
        advance.remainingMs = action.durationMs ?? advance.remainingMs;
        advance = armTimer(advance, at);
        if (advance.deadline != null) effects.push({ type: 'SET_TIMER', deadline: advance.deadline });
      } else {
        advance = disarmTimer(advance, at);
        advance.mechanism = state.config.hostMode === 'AUTOMATED' ? 'AUTO_ON_TIMER' : 'WAIT_FOR_MOD';
        effects.push({ type: 'CLEAR_TIMER' });
      }
      return { state: { ...state, advance }, effects };
    }

    /* ------------------------------------------------------------- the flow */
    case 'ADVANCE':
      return advanceFrom(state, at, effects);

    case 'TICK': {
      const deadline = state.advance?.deadline;
      if (deadline == null || at < deadline) return { state, effects };
      return advanceFrom(state, at, effects);
    }

    case 'FORCE_PHASE':
      // Moderator escape hatch, for when the table wants to skip ahead.
      if (!action.phase) return { state, effects };
      return enterPhase(state, action.phase, at, effects);

    /* ---------------------------------------------------------------- chat */
    case 'CHAT': {
      if (!state.config.chatEnabled) return { state, effects };
      const p = getPlayer(state, action.playerId);
      if (!p) return { state, effects };

      const channel = action.channel ?? 'public';
      const allowed = canPostTo(state, p, channel);
      if (!allowed) return { state, effects };

      const message = {
        seq: state.chatSeq + 1,
        from: p.id,
        name: p.name,
        text: action.text,
        channel,
        round: state.round,
        ts: at,
      };
      return {
        state: { ...state, chat: [...state.chat, message].slice(-200), chatSeq: state.chatSeq + 1 },
        // Deliberately NOT a PUBLIC effect: the transport projects per viewer,
        // and marking a mafia message public would be exactly the leak this
        // whole design exists to prevent.
        effects: [{ type: 'CHAT', channel, message }],
      };
    }

    /* ---------------------------------------------------------- last words */
    case 'LAST_WORDS': {
      if (state.phase !== PHASE.LAST_WORDS) return { state, effects };
      const p = getPlayer(state, action.playerId);
      if (!p) return { state, effects };
      const text = String(action.text ?? '').slice(0, 300);
      return {
        state: { ...state, players: { ...state.players, [action.playerId]: { ...p, lastWords: text } } },
        effects: [{ type: 'PUBLIC', event: { kind: 'LAST_WORDS', playerId: action.playerId, text } }],
      };
    }

    case 'SKIP_LAST_WORDS':
      if (state.phase !== PHASE.LAST_WORDS) return { state, effects };
      return advanceFrom(state, at, effects);

    /* ------------------------------------------------------------- rematch */
    case 'REMATCH': {
      if (state.phase !== PHASE.ENDED) return { state, effects };
      const players = {};
      for (const [id, p] of Object.entries(state.players)) {
        players[id] = { ...p, role: null, alive: true, ready: false, lastWords: null };
      }
      const fresh = createInitialState({ roomId: state.roomId, entropy: action.entropy, config: state.config });
      return {
        state: {
          ...fresh,
          players,
          epoch: state.epoch + 1,
          seq: state.seq,
          chat: state.chat,
          chatSeq: state.chatSeq,
          lastAt: at,
        },
        effects: [{ type: 'PUBLIC', event: { kind: 'REMATCH' } }],
      };
    }

    default:
      return { state, effects };
  }
}

/* ========================================================================== */
/* Reducer helpers                                                             */
/* ========================================================================== */

function privateError(to, code) {
  return { type: 'PRIVATE', to, event: { kind: 'ERROR', code } };
}

/** May this player post to this channel? */
function canPostTo(state, player, channel) {
  if (player.isModerator) return true;
  switch (channel) {
    case 'mafia':
      return isMafia(player.role);
    case 'dead':
      return !player.alive && state.config.deadCanChat;
    case 'public':
      // The living speak to the living. A dead player who keeps talking to the
      // living is still playing, which is not what "eliminated" means.
      return player.alive;
    default:
      return false;
  }
}

function makePlayer(action, state, { isSpectator = false, isModerator = false } = {}) {
  const seat = Object.values(state.players).reduce((m, p) => Math.max(m, p.seat), -1) + 1;
  return {
    id: action.id,
    name: action.name ?? '',
    seatToken: action.seatToken ?? null,
    role: null,
    alive: true,
    connected: true,
    seat,
    isModerator,
    isSpectator,
    ready: false,
    lastWords: null,
  };
}

/**
 * Find the open slot an action is aimed at, rejecting anything stale.
 *
 * Matching `phaseId` is what makes out-of-order WebRTC delivery harmless: a
 * vote that arrives after the vote closed names a phase that no longer exists,
 * so it is dropped rather than applied to the next one.
 */
function guardSlot(state, action) {
  const open = Object.entries(state.slots).filter(([, s]) => s && s.status === 'OPEN');
  if (open.length === 0) return { error: 'NO_OPEN_SLOT' };

  const entry = action.slot
    ? open.find(([k]) => k === action.slot)
    : open.find(([, s]) => s.eligible.includes(action.playerId));
  if (!entry) return { error: 'NO_OPEN_SLOT' };

  const [slotKey, slot] = entry;
  if (action.phaseId && action.phaseId !== slot.phaseId) return { error: 'STALE_PHASE' };
  if (!slot.eligible.includes(action.playerId)) return { error: 'NOT_ELIGIBLE' };
  return { slotKey, slot };
}

/**
 * Rule legality for one choice, independent of who produced it.
 *
 * @returns {string|null} an error code, or null when legal
 */
function checkChoice(state, slot, playerId, choice) {
  const targetId = choice?.targetId ?? null;

  if (targetId == null) {
    if (slot.kind === SLOT_KIND.VOTE && !state.config.vote.allowAbstain) return 'ABSTAIN_NOT_ALLOWED';
    return null;
  }
  if (!slot.targetSpace.includes(targetId)) return 'TARGET_NOT_IN_SPACE';

  const target = getPlayer(state, targetId);
  if (!target?.alive) return 'TARGET_DEAD';

  switch (slot.kind) {
    case SLOT_KIND.KILL:
      if (!state.config.allowMafiaKillMafia && isMafia(target.role)) return 'CANNOT_KILL_MAFIA';
      break;
    case SLOT_KIND.PROTECT:
      if (!state.config.allowDoctorSelfProtect && targetId === slot.eligible[0]) return 'CANNOT_SELF_PROTECT';
      if (!state.config.allowDoctorRepeatProtect && state.doctorHistory[slot.eligible[0]] === targetId) {
        return 'CANNOT_REPEAT_PROTECT';
      }
      break;
    case SLOT_KIND.INVESTIGATE:
      if (targetId === slot.eligible[0]) return 'CANNOT_INVESTIGATE_SELF';
      break;
    case SLOT_KIND.VOTE:
      // `playerId` is null when a moderator is setting the table's verdict,
      // which is not a personal ballot and so is not subject to the self-vote
      // rule that binds individual voters.
      if (playerId != null) {
        if (!state.config.vote.allowSelfVote && targetId === playerId) return 'CANNOT_SELF_VOTE';
        if (!slot.eligible.includes(playerId)) return 'NOT_ELIGIBLE';
      }
      break;
    default:
      break;
  }
  return null;
}

function isChangeable(state, slot) {
  if (slot.kind === SLOT_KIND.VOTE) return state.config.vote.changeableUntilDeadline;
  // Night actions are always revisable until the window closes — there is no
  // reason to lock a mafioso into the first target they tapped.
  return true;
}

/**
 * Move the machine on from wherever it is. This is the single place the
 * transition table lives.
 */
function advanceFrom(state, at, effects) {
  switch (state.phase) {
    case PHASE.ROLE_DEAL:
      return enterPhase(state, PHASE.NIGHT, at, effects);

    case PHASE.NIGHT:
      return enterPhase(state, PHASE.NIGHT_RESOLVE, at, effects);

    case PHASE.DAY_ANNOUNCE:
      return enterPhase(state, PHASE.DAY_DISCUSS, at, effects);

    case PHASE.DAY_DISCUSS:
      return enterPhase(state, PHASE.DAY_VOTE, at, effects);

    case PHASE.DAY_VOTE:
    case PHASE.DAY_RUNOFF:
      return resolveVote(state, at, effects);

    case PHASE.LAST_WORDS:
      return toCheckWin(state, PHASE.NIGHT, at, effects);

    default:
      return { state, effects };
  }
}

/* ========================================================================== */
/* Effect helpers                                                              */
/* ========================================================================== */

export function hasPublicEffect(effects) {
  return effects.some((e) => e.type === 'PUBLIC');
}

/** Stamp the wall clock, so projections can report serverNow. */
export function withClock(state, at) {
  return { ...state, lastAt: at, seq: state.seq + 1 };
}
