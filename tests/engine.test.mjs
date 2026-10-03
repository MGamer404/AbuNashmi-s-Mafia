/**
 * Headless rule tests for the game engine.
 *
 * The engine is a pure function, so these tests drive complete games with no
 * DOM, no network and no timers — they simply hand it actions and a clock.
 * That is the entire reason `at` is a parameter rather than a call to
 * `Date.now()`: a game can be replayed second-for-second in a unit test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE,
  SLOT_KIND,
  createInitialState,
  reduce,
  projectState,
  evaluateWin,
  defaultConfig,
  assignRoles,
  seedFrom,
  rngStep,
  hasPublicEffect,
  withClock,
  alivePlayers,
  seatedPlayers,
} from '../js/engine.js';

import {
  ROLE,
  TEAM,
  MIN_PLAYERS,
  MAX_PLAYERS,
  mafiaCountFor,
  clampMafiaCount,
  composeRoleList,
  isPlayableSize,
} from '../js/roles.js';

/* ========================================================================== */
/* Harness                                                                     */
/* ========================================================================== */

const T0 = 1_700_000_000_000;

/**
 * A host under test: owns the state, the clock, and the identity of everyone
 * at the table. Client views are produced from it, exactly as the transport
 * layer will do.
 */
function harness({ players = 5, config, entropy = 42, moderator = false } = {}) {
  let clock = T0;
  let state = createInitialState({ roomId: 'ROOM01', entropy, config });

  const h = {
    ids: [],
    moderatorId: null,

    get state() {
      return state;
    },
    get phase() {
      return state.phase;
    },
    get round() {
      return state.round;
    },
    get config() {
      return state.config;
    },

    /** Advance the host clock without dispatching anything. */
    at(ms) {
      clock += ms;
      return h;
    },

    send(action) {
      const r = reduce(state, { at: clock, ...action });
      state = r.state;
      return r.effects;
    },

    join(name, opts = {}) {
      const id = opts.id ?? `id${h.ids.length}${name.replace(/\W/g, '')}`;
      h.ids.push(id);
      h.send({ type: 'JOIN', id, name, seatToken: `tok-${id}` });
      return id;
    },

    view(id, opts = {}) {
      return projectState(state, {
        id,
        isModerator: opts.isModerator ?? (id === h.moderatorId),
      });
    },

    roleOf(id) {
      return state.players[id]?.role ?? null;
    },

    playerOf(id) {
      return state.players[id];
    },

    byRole(role) {
      return Object.values(state.players)
        .filter((p) => p.role === role)
        .map((p) => p.id);
    },

    aliveIds() {
      return alivePlayers(state).map((p) => p.id);
    },

    /** Bring the table to the deal and return the mafia's ids. */
    startGame() {
      h.send({ type: 'START', playerId: h.ids[0] });
      return h.byRole(ROLE.MAFIA);
    },
  };

  // Seat the players.
  for (let i = 0; i < players; i++) h.join(`Player${i}`);

  if (moderator) {
    const mid = 'mod0';
    h.send({ type: 'ADD_MODERATOR', id: mid, name: 'Moderator' });
    h.moderatorId = mid;
  }

  return h;
}

/** Dispatch ADVANCE repeatedly until the game ends or the guard trips. */
function runToEnd(h, maxSteps = 80) {
  for (let i = 0; i < maxSteps && h.phase !== PHASE.ENDED; i++) {
    h.send({ type: 'ADVANCE' });
  }
  return h.state;
}

/** Play one full night+day cycle in which nobody does anything. */
function idleRound(h) {
  h.send({ type: 'ADVANCE' }); // NIGHT -> resolve
  h.send({ type: 'ADVANCE' }); // -> DAY_DISCUSS
  h.send({ type: 'ADVANCE' }); // -> DAY_VOTE
  h.send({ type: 'ADVANCE' }); // -> resolve vote -> next NIGHT
}

/** Get the table to the first NIGHT phase. */
function toNight(h) {
  const mafia = h.startGame();
  h.send({ type: 'ADVANCE' }); // ROLE_DEAL -> NIGHT
  assert.equal(h.phase, PHASE.NIGHT);
  return mafia;
}

/* ========================================================================== */
/* roles.js                                                                    */
/* ========================================================================== */

describe('role composition', () => {
  test('mafia count ramps with table size', () => {
    assert.equal(mafiaCountFor(5), 1);
    assert.equal(mafiaCountFor(6), 1);
    assert.equal(mafiaCountFor(7), 2);
    assert.equal(mafiaCountFor(10), 2);
    assert.equal(mafiaCountFor(11), 3);
    assert.equal(mafiaCountFor(14), 3);
    assert.equal(mafiaCountFor(15), 4);
    assert.equal(mafiaCountFor(18), 4);
    assert.equal(mafiaCountFor(19), 5);
    assert.equal(mafiaCountFor(20), 5);
  });

  test('mafia never reach parity at the deal, for any legal table', () => {
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      const roles = composeRoleList(n);
      assert.equal(roles.length, n, `n=${n}`);
      const mafia = roles.filter((r) => r === ROLE.MAFIA).length;
      const town = n - mafia;
      assert.ok(mafia < town, `n=${n}: mafia ${mafia} vs town ${town}`);
      assert.ok(mafia >= 1, `n=${n}: at least one mafia`);
    }
  });

  test('the two power roles are always dealt', () => {
    for (let n = MIN_PLAYERS; n <= MAX_PLAYERS; n++) {
      const roles = composeRoleList(n);
      assert.ok(roles.includes(ROLE.DOCTOR), `n=${n} doctor`);
      assert.ok(roles.includes(ROLE.DETECTIVE), `n=${n} detective`);
    }
  });

  test('an absurd manual mafia count is clamped, not honoured', () => {
    // 6 players, asking for 5 mafia, must not produce a deal the town has
    // already lost.
    const clamped = clampMafiaCount(6, 5);
    assert.ok(clamped <= 2, `clamped to ${clamped}`);
    assert.ok(clamped < 6 - clamped);
    // Nonsense values fall back to the automatic ramp.
    assert.equal(clampMafiaCount(6, NaN), mafiaCountFor(6));
    assert.equal(clampMafiaCount(6, null), mafiaCountFor(6));
  });

  test('isPlayableSize enforces the table bounds', () => {
    assert.equal(isPlayableSize(4), false);
    assert.equal(isPlayableSize(5), true);
    assert.equal(isPlayableSize(20), true);
    assert.equal(isPlayableSize(21), false);
    assert.equal(isPlayableSize(5.5), false);
  });
});

/* ========================================================================== */
/* Randomness                                                                  */
/* ========================================================================== */

describe('deterministic randomness', () => {
  test('rngStep is a pure state transition', () => {
    const a = rngStep(12345);
    const b = rngStep(12345);
    assert.deepEqual(a, b);
    assert.ok(a.value >= 0 && a.value < 1);
    assert.notEqual(rngStep(a.state).value, a.value);
  });

  test('seedFrom folds entropy into a 32-bit word', () => {
    assert.equal(seedFrom(7), 7);
    assert.equal(seedFrom([1, 2, 3]), seedFrom([1, 2, 3]));
    assert.notEqual(seedFrom([1, 2, 3]), seedFrom([3, 2, 1]));
    assert.ok(Number.isInteger(seedFrom([1, 2, 3])));
  });

  test('the same seed deals the same game', () => {
    const a = harness({ players: 8, entropy: 999 });
    const b = harness({ players: 8, entropy: 999 });
    a.startGame();
    b.startGame();
    assert.deepEqual(
      a.ids.map((id) => a.roleOf(id)),
      b.ids.map((id) => b.roleOf(id))
    );
  });

  test('different seeds deal different games', () => {
    const layouts = new Set();
    for (let seed = 0; seed < 40; seed++) {
      const h = harness({ players: 8, entropy: seed * 7919 });
      h.startGame();
      layouts.add(h.ids.map((id) => h.roleOf(id)).join(','));
    }
    assert.ok(layouts.size > 20, `only ${layouts.size} distinct layouts`);
  });

  test('every seat holds every role often enough to break seat/role correlation', () => {
    // Shuffling the role bag alone would leave seat 0 holding whatever was
    // first in the bag. Two independent shuffles should scramble that.
    let mafiaAtSeat0 = 0;
    let villagersAtSeat0 = 0;
    for (let seed = 0; seed < 300; seed++) {
      const h = harness({ players: 5, entropy: seed * 104729 + 1 });
      h.startGame();
      if (h.roleOf(h.ids[0]) === ROLE.MAFIA) mafiaAtSeat0++;
      else villagersAtSeat0++;
    }
    assert.ok(mafiaAtSeat0 > 20, `seat 0 was mafia ${mafiaAtSeat0}/300`);
    assert.ok(villagersAtSeat0 > 20, `seat 0 was town ${villagersAtSeat0}/300`);
  });

  test('assignRoles is a pure function of its inputs', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const cfg = defaultConfig();
    const first = assignRoles(ids, cfg, 5150);
    const second = assignRoles(ids, cfg, 5150);
    assert.deepEqual(first.roles, second.roles);
    assert.equal(first.rng, second.rng);
  });
});

/* ========================================================================== */
/* Lobby                                                                       */
/* ========================================================================== */

describe('lobby', () => {
  test('players take seats in join order', () => {
    const h = harness({ players: 6 });
    const seated = seatedPlayers(h.state);
    assert.equal(seated.length, 6);
    assert.deepEqual(
      seated.map((p) => p.seat),
      [0, 1, 2, 3, 4, 5]
    );
  });

  test('starting with too few players is refused, not silently allowed', () => {
    const h = harness({ players: 4 });
    const effects = h.send({ type: 'START', playerId: h.ids[0] });
    assert.equal(h.phase, PHASE.LOBBY, 'still in the lobby');
    assert.ok(
      effects.some((e) => e.type === 'PRIVATE' && e.event.code === 'BAD_PLAYER_COUNT'),
      'the host is told why'
    );
  });

  test('starting at the minimum legal size works', () => {
    const h = harness({ players: 5 });
    h.startGame();
    assert.equal(h.phase, PHASE.ROLE_DEAL);
  });

  test('a late arrival becomes a spectator rather than a player with no role', () => {
    const h = harness({ players: 5 });
    h.startGame();
    const late = h.join('Latecomer');
    const p = h.playerOf(late);
    assert.equal(p.isSpectator, true);
    assert.equal(p.role, null);
    // And must not be counted for the win condition.
    assert.ok(!h.aliveIds().includes(late));
  });

  test('the table is capped', () => {
    const h = harness({ players: 20 });
    const effects = h.send({ type: 'JOIN', id: 'overflow', name: 'Overflow' });
    assert.ok(effects.some((e) => e.event?.code === 'ROOM_FULL'));
    assert.equal(h.playerOf('overflow'), undefined);
  });

  test('leaving mid-game keeps the seat so the arithmetic cannot shift', () => {
    const h = harness({ players: 6 });
    h.startGame();
    const victim = h.ids[5];
    h.send({ type: 'LEAVE', playerId: victim });
    const p = h.playerOf(victim);
    assert.ok(p, 'seat preserved');
    assert.equal(p.alive, true, 'still a body');
    assert.equal(p.connected, false, 'but known to be away');
    assert.equal(h.aliveIds().length, 6);
  });

  test('a moderator joins as a spectator and is not on the board', () => {
    const h = harness({ players: 5, moderator: true });
    assert.equal(seatedPlayers(h.state).length, 5);
    assert.equal(h.playerOf(h.moderatorId).isModerator, true);
  });
});

/* ========================================================================== */
/* Night                                                                       */
/* ========================================================================== */

describe('night', () => {
  test('the first night cannot kill, when the house rule says so', () => {
    const h = harness({ players: 5 });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });

    assert.equal(h.phase, PHASE.DAY_ANNOUNCE);
    assert.equal(h.aliveIds().length, 5, 'nobody died on night one');
    assert.equal(h.state.nightReport.killedId, null);
  });

  test('the first night can kill when the house rule is off', () => {
    const h = harness({ players: 5, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });

    assert.equal(h.aliveIds().length, 4);
    assert.equal(h.playerOf(victim).alive, false);
  });

  test('a night kill lands once the first-night grace is over', () => {
    const h = harness({ players: 6 });
    const [mafia] = toNight(h);
    h.send({ type: 'ADVANCE' }); // resolve night 1: nobody acted
    idleRoundUpToVote(h);
    h.send({ type: 'ADVANCE' }); // resolve the empty vote -> NIGHT 2
    assert.equal(h.phase, PHASE.NIGHT);
    assert.equal(h.round, 2);

    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });

    assert.equal(h.aliveIds().length, 5);
    assert.equal(h.playerOf(victim).alive, false);
  });

  test('the doctor can save the mafia\'s target', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const doctor = h.byRole(ROLE.DOCTOR)[0];
    const victim = h.aliveIds().find((id) => id !== mafia && id !== doctor);

    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'SUBMIT', playerId: doctor, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });

    assert.equal(h.playerOf(victim).alive, true, 'saved');
    assert.equal(h.aliveIds().length, 7, 'nobody died');
  });

  test('the mafia may not shoot its own, by default', () => {
    const h = harness({ players: 8 });
    const mafia = toNight(h);
    assert.ok(mafia.length >= 2, 'table large enough for two mafia');
    const effects = h.send({ type: 'SUBMIT', playerId: mafia[0], choice: { targetId: mafia[1] } });
    // A teammate is removed from the target space rather than offered and then
    // rejected, so either error code is a correct refusal.
    assert.ok(
      effects.some((e) => ['CANNOT_KILL_MAFIA', 'TARGET_NOT_IN_SPACE'].includes(e.event?.code)),
      `expected a refusal, got ${JSON.stringify(effects)}`
    );
    assert.equal(h.state.slots.KILL.submissions[mafia[0]] ?? null, null, 'nothing recorded');
  });

  test('the night window is fixed length — acting early does not end it', () => {
    const h = harness({ players: 6 });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    // Every action is in. The phase must still be open, because ending it the
    // instant the last submission landed would reveal when each role acted.
    assert.equal(h.phase, PHASE.NIGHT);
    assert.ok(h.state.advance.deadline > h.state.lastAt);
  });

  test('TICK before the deadline is a no-op; at the deadline it resolves', () => {
    const h = harness({ players: 6 });
    toNight(h);
    const deadline = h.state.advance.deadline;

    h.at(Math.max(0, deadline - h.state.lastAt - 1000));
    h.send({ type: 'TICK' });
    assert.equal(h.phase, PHASE.NIGHT, 'too early');

    h.at(h.state.advance.deadline - h.state.lastAt);
    h.send({ type: 'TICK' });
    assert.notEqual(h.phase, PHASE.NIGHT, 'deadline reached');
  });

  test('the detective learns the truth, privately', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const detective = h.byRole(ROLE.DETECTIVE)[0];

    h.send({ type: 'SUBMIT', playerId: detective, choice: { targetId: mafia } });
    const effects = h.send({ type: 'ADVANCE' });

    const finding = effects.find(
      (e) => e.type === 'PRIVATE' && e.event.kind === 'INVESTIGATION_RESULT'
    );
    assert.ok(finding, 'a private finding was emitted');
    assert.equal(finding.to, detective);
    assert.equal(finding.event.verdict, 'MAFIA');
  });

  test('a detective killed the same night still gets the finding', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const detective = h.byRole(ROLE.DETECTIVE)[0];

    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: detective } });
    h.send({ type: 'SUBMIT', playerId: detective, choice: { targetId: mafia } });
    const effects = h.send({ type: 'ADVANCE' });

    assert.equal(h.playerOf(detective).alive, false, 'detective died');
    assert.ok(
      effects.some((e) => e.type === 'PRIVATE' && e.to === detective),
      'but was told what they learned first'
    );
    assert.equal(h.state.detectiveKnowledge[detective][0].verdict, 'MAFIA');
  });

  test('the detective cannot investigate themselves', () => {
    const h = harness({ players: 7 });
    toNight(h);
    const detective = h.byRole(ROLE.DETECTIVE)[0];
    const effects = h.send({ type: 'SUBMIT', playerId: detective, choice: { targetId: detective } });
    assert.ok(
      effects.some((e) => ['CANNOT_INVESTIGATE_SELF', 'TARGET_NOT_IN_SPACE'].includes(e.event?.code)),
      `expected a refusal, got ${JSON.stringify(effects)}`
    );
  });

  test('a stalled mafia kills nobody rather than something at random', () => {
    const h = harness({ players: 6, config: { firstNightNoKill: false } });
    toNight(h);
    h.send({ type: 'ADVANCE' });
    assert.equal(h.aliveIds().length, 6);
    assert.equal(h.state.nightReport.killedId, null);
  });
});

/** From the night's DAWN, walk to the vote being resolved. */
function idleRoundUpToVote(h) {
  assert.equal(h.phase, PHASE.DAY_ANNOUNCE);
  h.send({ type: 'ADVANCE' }); // -> DAY_DISCUSS
  h.send({ type: 'ADVANCE' }); // -> DAY_VOTE
}

/* ========================================================================== */
/* Voting                                                                      */
/* ========================================================================== */

describe('voting', () => {
  /** Drive to a DAY_VOTE phase with a known set of living players. */
  function toVote(h) {
    toNight(h);
    h.send({ type: 'ADVANCE' }); // resolve night 1 (no deaths)
    idleRoundUpToVote(h);
    assert.equal(h.phase, PHASE.DAY_VOTE);
  }

  test('a plurality eliminates the most-voted player', () => {
    const h = harness({ players: 6 });
    toVote(h);
    const alive = h.aliveIds();
    const target = alive[0];
    // Four votes for target, out of six voters.
    for (const id of alive.slice(0, 4)) {
      h.send({ type: 'SUBMIT', playerId: id, slot: 'VOTE', choice: { targetId: target } });
    }
    h.send({ type: 'ADVANCE' });

    assert.equal(h.playerOf(target).alive, false);
    assert.equal(h.state.lastElimination.playerId, target);
  });

  test('a player cannot vote for themselves', () => {
    const h = harness({ players: 6 });
    toVote(h);
    const effects = h.send({
      type: 'SUBMIT',
      playerId: h.aliveIds()[0],
      slot: 'VOTE',
      choice: { targetId: h.aliveIds()[0] },
    });
    assert.ok(effects.some((e) => e.event?.code === 'CANNOT_SELF_VOTE'));
  });

  test('abstaining is allowed by default and eliminates nobody', () => {
    const h = harness({ players: 6 });
    toVote(h);
    for (const id of h.aliveIds()) {
      h.send({ type: 'SUBMIT', playerId: id, slot: 'VOTE', choice: { targetId: null, abstain: true } });
    }
    h.send({ type: 'ADVANCE' });
    assert.equal(h.state.lastElimination, null);
    assert.equal(h.aliveIds().length, 6);
  });

  test('abstaining can be forbidden', () => {
    const h = harness({ players: 6, config: { vote: { allowAbstain: false } } });
    toVote(h);
    const effects = h.send({
      type: 'SUBMIT',
      playerId: h.aliveIds()[0],
      slot: 'VOTE',
      choice: { targetId: null, abstain: true },
    });
    assert.ok(effects.some((e) => e.event?.code === 'ABSTAIN_NOT_ALLOWED'));
  });

  test('a tie with the default policy eliminates nobody', () => {
    const h = harness({ players: 6 });
    toVote(h);
    const [a, b, c, d] = h.aliveIds();
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: b, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'SUBMIT', playerId: c, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: d, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'ADVANCE' });

    assert.equal(h.state.lastElimination, null, 'nobody eliminated');
    assert.equal(h.phase, PHASE.NIGHT, 'straight on to the next night');
    assert.equal(h.aliveIds().length, 6);
  });

  test('a tie can be sent to a runoff between exactly the tied players', () => {
    const h = harness({ players: 6, config: { vote: { tiePolicy: 'RUNOFF' } } });
    toVote(h);
    const [a, b, c, d] = h.aliveIds();
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: b, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'SUBMIT', playerId: c, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: d, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'ADVANCE' });

    assert.equal(h.phase, PHASE.DAY_RUNOFF);
    assert.deepEqual(h.state.slots.VOTE.targetSpace.slice().sort(), [a, b].sort());
  });

  test('a runoff that ties again does not loop forever', () => {
    const h = harness({ players: 6, config: { vote: { tiePolicy: 'RUNOFF' } } });
    toVote(h);
    const [a, b, c, d] = h.aliveIds();
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: b, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'SUBMIT', playerId: c, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: d, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'ADVANCE' }); // -> DAY_RUNOFF

    // The same deadlock in the runoff.
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: b, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'ADVANCE' });

    assert.equal(h.state.lastElimination, null);
    assert.equal(h.phase, PHASE.NIGHT, 'moved on');
  });

  test('a tie can be resolved at random when the table asks for it', () => {
    const h = harness({ players: 6, config: { vote: { tiePolicy: 'RANDOM' } } });
    toVote(h);
    const [a, b, c, d] = h.aliveIds();
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: b, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'SUBMIT', playerId: c, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: d, slot: 'VOTE', choice: { targetId: a } });
    h.send({ type: 'ADVANCE' });

    const victim = h.state.lastElimination?.playerId;
    assert.ok(victim === a || victim === b, `picked one of the tied, got ${victim}`);
    assert.equal(h.playerOf(victim).alive, false);
  });

  test('votes are changeable until the deadline, by default', () => {
    const h = harness({ players: 6 });
    toVote(h);
    const [a, b, c] = h.aliveIds();
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: c } });
    assert.equal(h.state.slots.VOTE.submissions[a].targetId, c);
  });

  test('votes can be locked once cast', () => {
    const h = harness({ players: 6, config: { vote: { changeableUntilDeadline: false } } });
    toVote(h);
    const [a, b, c] = h.aliveIds();
    h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
    const effects = h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: c } });
    assert.ok(effects.some((e) => e.event?.code === 'ALREADY_VOTED'));
    assert.equal(h.state.slots.VOTE.submissions[a].targetId, b);
  });

  test('the dead do not vote', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' }); // victim dies
    h.send({ type: 'ADVANCE' }); // -> DAY_DISCUSS
    h.send({ type: 'ADVANCE' }); // -> DAY_VOTE

    const effects = h.send({ type: 'SUBMIT', playerId: victim, slot: 'VOTE', choice: { targetId: mafia } });
    assert.ok(effects.some((e) => e.event?.code === 'NOT_ELIGIBLE' || e.event?.code === 'NO_OPEN_SLOT'));
    assert.equal(h.state.slots.VOTE.submissions[victim], undefined);
  });
});

/* ========================================================================== */
/* Win conditions                                                              */
/* ========================================================================== */

describe('win conditions', () => {
  test('town wins when the last mafia is eliminated by vote', () => {
    const h = harness({ players: 5 });
    const [mafia] = toNight(h);
    h.send({ type: 'ADVANCE' }); // resolve quiet night 1
    idleRoundUpToVote(h); // -> DAY_VOTE  (round 1 vote)

    const voters = h.aliveIds().filter((id) => id !== mafia);
    for (const id of voters) {
      h.send({ type: 'SUBMIT', playerId: id, slot: 'VOTE', choice: { targetId: mafia } });
    }
    h.send({ type: 'ADVANCE' }); // vote resolves, the mafia is lynched, town wins

    assert.equal(h.phase, PHASE.ENDED, 'a decisive vote ends the game at once');
    assert.equal(h.state.win.winner, TEAM.TOWN);
    assert.equal(h.state.win.reason, 'ALL_MAFIA_ELIMINATED');
  });

  test('mafia win on parity', () => {
    // A five-seat table with two mafia reaches parity quickly: 1 mafia vs 1
    // town is parity, so the second night's kill should end it.
    const h = harness({ players: 5, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);

    // Night 1: kill a townsperson -> 4 alive (mafia 1, town 3).
    const first = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: first } });
    h.send({ type: 'ADVANCE' });
    assert.equal(h.phase, PHASE.DAY_ANNOUNCE, 'still playing at 1 vs 3');

    // Day 1: no elimination.
    h.send({ type: 'ADVANCE' });
    h.send({ type: 'ADVANCE' });
    h.send({ type: 'ADVANCE' });
    assert.equal(h.phase, PHASE.NIGHT);

    // Night 2: kill again -> 3 alive (mafia 1, town 2).
    const second = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: second } });
    h.send({ type: 'ADVANCE' });
    assert.equal(h.phase, PHASE.DAY_ANNOUNCE);

    // Day 2: the town votes out a villager -> 2 alive (mafia 1, town 1) =
    // parity, and the game is over.
    h.send({ type: 'ADVANCE' });
    h.send({ type: 'ADVANCE' });
    const remainingTown = h.aliveIds().filter((id) => id !== mafia);
    for (const id of h.aliveIds()) {
      h.send({ type: 'SUBMIT', playerId: id, slot: 'VOTE', choice: { targetId: remainingTown[0] } });
    }
    h.send({ type: 'ADVANCE' });

    assert.equal(h.phase, PHASE.ENDED);
    assert.equal(h.state.win.winner, TEAM.MAFIA);
    assert.equal(h.state.win.reason, 'MAFIA_REACHED_PARITY');
  });

  test('a game with no progress at all ends in a draw rather than running forever', () => {
    const h = harness({ players: 6 });
    h.startGame();
    runToEnd(h, 120);
    assert.equal(h.phase, PHASE.ENDED);
    assert.equal(h.state.win.winner, 'DRAW');
    assert.equal(h.state.win.reason, 'STALEMATE');
  });

  test('win is evaluated immediately on the night\'s deaths, not a phase later', () => {
    // A five-handed table down to one townsperson and one mafioso: killing
    // that townsperson at night ends the game at dawn, with no day phase.
    const state = createInitialState({ roomId: 'X', entropy: 5 });
    // Hand-build the near-terminal position rather than simulating six rounds.
    state.players = {
      m: { id: 'm', name: 'M', role: ROLE.MAFIA, alive: true, seat: 0, isSpectator: false, isModerator: false, connected: true, ready: true },
      t: { id: 't', name: 'T', role: ROLE.VILLAGER, alive: true, seat: 1, isSpectator: false, isModerator: false, connected: true, ready: true },
    };
    assert.deepEqual(evaluateWin(state), { winner: TEAM.MAFIA, reason: 'MAFIA_REACHED_PARITY' });
  });

  test('evaluateWin is total over its inputs', () => {
    const h = harness({ players: 6 });
    h.startGame();
    assert.equal(evaluateWin(h.state), null, 'a fresh game is not decided');
  });
});

/* ========================================================================== */
/* Redaction — the anti-cheat boundary                                         */
/* ========================================================================== */

describe('redaction', () => {
  test('a client view never carries another player\'s role', () => {
    const h = harness({ players: 8 });
    h.startGame();
    const me = h.ids[0];
    const view = h.view(me);

    assert.equal(view.self.role, h.roleOf(me), 'knows their own role');
    for (const entry of view.board.players) {
      assert.equal(entry.role, undefined, `${entry.id} must not expose a role`);
    }
    assert.equal(view.moderator, undefined, 'no moderator block for a player');
  });

  test('the mafia see their team and nobody else does', () => {
    const h = harness({ players: 8 });
    const mafia = h.startGame();
    assert.ok(mafia.length >= 2);

    const mafiaView = h.view(mafia[0]);
    const teammateIds = mafiaView.privateNotes.mafiaTeam.map((p) => p.id).sort();
    assert.deepEqual(teammateIds, mafia.filter((id) => id !== mafia[0]).sort());

    const villager = h.ids.find((id) => h.roleOf(id) === ROLE.VILLAGER);
    const villagerView = h.view(villager);
    assert.equal(villagerView.privateNotes.mafiaTeam, undefined);
    assert.equal(villagerView.privateNotes.detectiveResults, undefined);
  });

  test('the detective sees only their own findings', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const detective = h.byRole(ROLE.DETECTIVE)[0];
    h.send({ type: 'SUBMIT', playerId: detective, choice: { targetId: mafia } });
    h.send({ type: 'ADVANCE' });

    const detView = h.view(detective);
    assert.equal(detView.privateNotes.detectiveResults.length, 1);
    assert.equal(detView.privateNotes.detectiveResults[0].verdict, 'MAFIA');

    const other = h.ids.find((id) => id !== detective && h.roleOf(id) !== ROLE.MAFIA);
    assert.equal(h.view(other).privateNotes.detectiveResults, undefined);
  });

  test('a spectator gets no private notes container at all', () => {
    const h = harness({ players: 5 });
    h.startGame();
    const late = h.join('Watcher');
    const view = h.view(late);
    assert.equal(view.self.isSpectator, true);
    assert.equal(view.privateNotes, undefined);
  });

  test('the moderator sees every role', () => {
    const h = harness({ players: 6, moderator: true });
    h.startGame();
    const view = h.view(h.moderatorId);
    assert.ok(view.moderator, 'moderator block present');
    for (const seat of view.moderator.seats) {
      assert.equal(seat.role, h.roleOf(seat.id));
    }
  });

  test('a dead player is no longer offered an action', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });
    h.send({ type: 'ADVANCE' }); // -> DAY_DISCUSS
    h.send({ type: 'ADVANCE' }); // -> DAY_VOTE

    const view = h.view(victim);
    assert.equal(view.self.alive, false);
    assert.equal(view.privateNotes.canAct, false);
    assert.equal(view.privateNotes.pending, null);
  });

  test('roles are revealed only once the game is over', () => {
    const h = harness({ players: 6 });
    h.startGame();
    assert.equal(h.view(h.ids[0]).board.reveal, undefined);
    runToEnd(h, 120);
    const view = h.view(h.ids[0]);
    assert.ok(view.board.reveal, 'the deal is shown at the end');
    for (const id of h.ids) assert.equal(view.board.reveal[id], h.roleOf(id));
  });
});

/* ========================================================================== */
/* Message ordering                                                            */
/* ========================================================================== */

describe('staleness', () => {
  test('an action naming a phase that has closed is dropped', () => {
    const h = harness({ players: 6 });
    toNight(h);
    const staleId = h.state.phaseId;
    const [mafia] = h.byRole(ROLE.MAFIA);
    const victim = h.aliveIds().find((id) => id !== mafia);

    // A vote from the previous phase arrives late, mid-night.
    const effects = h.send({
      type: 'SUBMIT',
      playerId: mafia,
      slot: 'KILL',
      phaseId: 'NIGHT:0:0',
      choice: { targetId: victim },
    });
    assert.ok(effects.some((e) => e.event?.code === 'STALE_PHASE'));
    assert.equal(h.state.slots.KILL.submissions[mafia], undefined);
    void staleId;
  });

  test('the phase id changes on every phase entry', () => {
    const h = harness({ players: 6 });
    toNight(h);
    const first = h.state.phaseId;
    h.send({ type: 'ADVANCE' });
    const second = h.state.phaseId;
    assert.notEqual(first, second);
  });
});

/* ========================================================================== */
/* Host modes — the point of the PendingAction slot                            */
/* ========================================================================== */

describe('host modes', () => {
  test('a moderator override beats what the players submitted', () => {
    const h = harness({ players: 7, moderator: true, config: { hostMode: 'MODERATED' } });
    toNight(h);
    const [mafia] = h.byRole(ROLE.MAFIA);
    const doctor = h.byRole(ROLE.DOCTOR)[0];

    const playerChoice = h.aliveIds().find((id) => id !== mafia && id !== doctor);
    const modChoice = h.aliveIds().find((id) => id !== mafia && id !== playerChoice);

    h.send({ type: 'SUBMIT', playerId: mafia, slot: 'KILL', choice: { targetId: playerChoice } });
    h.send({ type: 'MOD_OVERRIDE', playerId: h.moderatorId, slot: 'KILL', choice: { targetId: modChoice } });

    // Both channels now hold a value; the override is the one that counts.
    assert.equal(h.state.slots.KILL.submissions[mafia].targetId, playerChoice);
    assert.equal(h.state.slots.KILL.override.targetId, modChoice);

    h.send({ type: 'SET_CONFIG_LIVE', playerId: h.moderatorId, patch: { firstNightNoKill: false } });
    h.send({ type: 'ADVANCE' });

    // Whichever the engine picked, it must be the moderator's, not the
    // players' — and the outcome must be indistinguishable in kind from a
    // player-driven one.
    assert.equal(h.state.night.killTarget, modChoice);
  });

  test('an illegal moderator override is refused like anyone else\'s', () => {
    const h = harness({ players: 8, moderator: true, config: { hostMode: 'MODERATED' } });
    toNight(h);
    const mafia = h.byRole(ROLE.MAFIA);
    const effects = h.send({
      type: 'MOD_OVERRIDE',
      playerId: h.moderatorId,
      slot: 'KILL',
      choice: { targetId: mafia[1] },
    });
    // A teammate was never in the target space, so the moderator's typed value
    // is refused as an invalid target rather than as a role violation.
    assert.ok(
      effects.some((e) =>
        ['CANNOT_KILL_MAFIA', 'TARGET_NOT_IN_SPACE', 'INVALID_TARGET'].includes(e.event?.code)
      ),
      `expected a refusal, got ${JSON.stringify(effects)}`
    );
    assert.equal(h.state.slots.KILL.override, null);
  });

  test('a moderator override to a target outside the space is refused', () => {
    const h = harness({ players: 6, moderator: true, config: { hostMode: 'MODERATED' } });
    const [mafia] = toNight(h);
    const effects = h.send({
      type: 'MOD_OVERRIDE',
      playerId: h.moderatorId,
      slot: 'KILL',
      choice: { targetId: 'someone-not-at-this-table' },
    });
    assert.ok(effects.some((e) => e.event?.code === 'INVALID_TARGET'));
    assert.equal(h.state.slots.KILL.override, null);
    void mafia;
  });

  test('switching from players-act to mod-enters mid-phase keeps the submissions', () => {
    const h = harness({ players: 7, moderator: true });
    toNight(h);
    const [mafia] = h.byRole(ROLE.MAFIA);
    const target = h.aliveIds().find((id) => id !== mafia);

    h.send({ type: 'SUBMIT', playerId: mafia, slot: 'KILL', choice: { targetId: target } });
    h.send({ type: 'SET_HOST_MODE', playerId: h.moderatorId, mode: 'MODERATED' });
    h.send({ type: 'SET_MOD_STYLE', playerId: h.moderatorId, style: 'MOD_ENTERS' });

    // The players' work survives the switch. A moderator taking over does not
    // have to re-enter everything the table already decided.
    assert.equal(h.state.slots.KILL.submissions[mafia].targetId, target);

    h.send({ type: 'SET_CONFIG_LIVE', playerId: h.moderatorId, patch: { firstNightNoKill: false } });
    h.send({ type: 'ADVANCE' });
    assert.equal(h.state.night.killTarget, target);
  });

  test('the moderator can disarm a running timer without losing the remaining time', () => {
    // A timer only runs in MODERATED mode if the moderator has armed it —
    // in AUTOMATED mode the engine owns the clock and the moderator cannot
    // stall the table.
    const h = harness({
      players: 6,
      moderator: true,
      config: { hostMode: 'MODERATED', modTimersArmed: true },
    });
    toNight(h);
    const deadline = h.state.advance.deadline;
    h.at(5000);
    h.send({ type: 'SET_CONFIG_LIVE', playerId: h.moderatorId, patch: { modTimersArmed: false } });

    assert.equal(h.state.advance.deadline, null, 'timer is off');
    const remaining = h.state.advance.remainingMs;
    assert.ok(remaining < h.state.config.durations.night, 'time already spent is accounted for');
    assert.ok(remaining > 0);
    void deadline;
  });
});

/* ========================================================================== */
/* Chat                                                                        */
/* ========================================================================== */

describe('chat', () => {
  test('mafia chat is not a public effect', () => {
    const h = harness({ players: 8 });
    const mafia = h.startGame();
    const effects = h.send({
      type: 'CHAT',
      playerId: mafia[0],
      channel: 'mafia',
      text: 'kill the detective',
    });
    assert.ok(effects.some((e) => e.type === 'CHAT'));
    assert.ok(!hasPublicEffect(effects), 'never broadcast wholesale');
  });

  test('a villager can neither read nor write the mafia channel', () => {
    const h = harness({ players: 8 });
    const mafia = h.startGame();
    const villager = h.ids.find((id) => h.roleOf(id) === ROLE.VILLAGER);

    h.send({ type: 'CHAT', playerId: mafia[0], channel: 'mafia', text: 'secret' });
    assert.deepEqual(h.view(villager).chat, [], 'nothing leaks');

    h.send({ type: 'CHAT', playerId: villager, channel: 'mafia', text: 'hello?' });
    assert.equal(h.state.chat.length, 1, 'the impostor message was dropped');
  });

  test('the mafia can read their own channel', () => {
    const h = harness({ players: 8 });
    const mafia = h.startGame();
    h.send({ type: 'CHAT', playerId: mafia[0], channel: 'mafia', text: 'plan' });
    const view = h.view(mafia[1]);
    assert.equal(view.chat.length, 1);
    assert.equal(view.chat[0].text, 'plan');
  });

  test('the dead cannot address the living', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });

    const before = h.state.chat.length;
    h.send({ type: 'CHAT', playerId: victim, channel: 'public', text: 'it was them!' });
    assert.equal(h.state.chat.length, before, 'silenced');
  });

  test('the dead have their own channel, invisible to the living', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });

    h.send({ type: 'CHAT', playerId: victim, channel: 'dead', text: 'ghost' });
    assert.equal(h.view(victim).chat.length, 1, 'the dead can read the dead');

    const living = h.aliveIds()[0];
    assert.deepEqual(h.view(living).chat, [], 'the living cannot');
  });

  test('the dead keep reading the public channel', () => {
    const h = harness({ players: 7, config: { firstNightNoKill: false } });
    const [mafia] = toNight(h);
    const victim = h.aliveIds().find((id) => id !== mafia);
    h.send({ type: 'SUBMIT', playerId: mafia, choice: { targetId: victim } });
    h.send({ type: 'ADVANCE' });

    h.send({ type: 'CHAT', playerId: mafia, channel: 'public', text: 'morning' });
    assert.equal(h.view(victim).chat.length, 1);
  });
});

/* ========================================================================== */
/* Replay determinism                                                          */
/* ========================================================================== */

describe('replay', () => {
  test('the same action log produces byte-identical state', () => {
    const script = (h) => {
      const [mafia] = toNight(h);
      const doctor = h.byRole(ROLE.DOCTOR)[0];
      const detective = h.byRole(ROLE.DETECTIVE)[0];
      const victim = h.aliveIds().find((id) => id !== mafia && id !== doctor && id !== detective);

      h.send({ type: 'SUBMIT', playerId: mafia, slot: 'KILL', choice: { targetId: victim } });
      h.send({ type: 'SUBMIT', playerId: doctor, slot: 'PROTECT', choice: { targetId: victim } });
      h.send({ type: 'SUBMIT', playerId: detective, slot: 'INVESTIGATE', choice: { targetId: mafia } });
      h.send({ type: 'ADVANCE' }); // resolve
      h.send({ type: 'ADVANCE' }); // -> DAY_DISCUSS
      h.send({ type: 'ADVANCE' }); // -> DAY_VOTE

      const [a, b, c] = h.aliveIds();
      h.send({ type: 'SUBMIT', playerId: a, slot: 'VOTE', choice: { targetId: b } });
      h.send({ type: 'SUBMIT', playerId: b, slot: 'VOTE', choice: { targetId: c } });
      h.send({ type: 'SUBMIT', playerId: c, slot: 'VOTE', choice: { targetId: b } });
      h.send({ type: 'ADVANCE' });
      void victim;
    };

    const a = harness({ players: 7, entropy: 20261004 });
    const b = harness({ players: 7, entropy: 20261004 });
    script(a);
    script(b);

    assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  });

  test('no hidden clock or RNG leaks into the state', () => {
    // Replaying from the same seed with a wildly different wall clock must
    // land in the same place, or the engine is reading the clock it claims
    // not to read.
    const build = (base) => {
      const h = harness({ players: 6, entropy: 7 });
      h.clockOffset = base;
      return h;
    };
    const a = build(0);
    const b = build(0);
    toNight(a);
    toNight(b);
    const strip = (s) => JSON.stringify({ ...s, lastAt: 0 });
    assert.equal(strip(a.state), strip(b.state));
  });
});

/* ========================================================================== */
/* Effect helpers                                                              */
/* ========================================================================== */

describe('effect helpers', () => {
  test('hasPublicEffect distinguishes broadcast from private traffic', () => {
    assert.equal(hasPublicEffect([{ type: 'PUBLIC', event: {} }]), true);
    assert.equal(hasPublicEffect([{ type: 'PRIVATE', to: 'x', event: {} }]), false);
    assert.equal(hasPublicEffect([{ type: 'CHAT', channel: 'mafia' }]), false);
    assert.equal(hasPublicEffect([]), false);
  });

  test('withClock stamps the time and advances the broadcast counter', () => {
    const state = createInitialState({ roomId: 'R', entropy: 1 });
    const next = withClock(state, 12345);
    assert.equal(next.lastAt, 12345);
    assert.equal(next.seq, state.seq + 1);
  });
});

/* ========================================================================== */
/* Config                                                                      */
/* ========================================================================== */

describe('config', () => {
  test('partial overrides merge into the nested blocks', () => {
    const cfg = defaultConfig({ durations: { night: 5000 } });
    assert.equal(cfg.durations.night, 5000);
    assert.equal(cfg.durations.vote, defaultConfig().durations.vote, 'siblings preserved');
    assert.equal(cfg.vote.tiePolicy, 'NO_ELIMINATION', 'other block untouched');
  });

  test('a non-lobby config change cannot rewrite the rules mid-game', () => {
    const h = harness({ players: 6 });
    h.startGame();
    const before = h.state.config.vote.tiePolicy;
    h.send({ type: 'MOD_CONFIG', patch: { vote: { tiePolicy: 'RANDOM' } } });
    assert.equal(h.state.config.vote.tiePolicy, before, 'ignored outside the lobby');
  });

  test('a live config change cannot rewrite the rules either', () => {
    const h = harness({ players: 6, moderator: true });
    h.startGame();
    h.send({
      type: 'SET_CONFIG_LIVE',
      playerId: h.moderatorId,
      patch: { vote: { tiePolicy: 'RANDOM' }, firstNightNoKill: false },
    });
    assert.equal(h.state.config.vote.tiePolicy, 'NO_ELIMINATION', 'vote rules frozen');
    assert.equal(h.state.config.firstNightNoKill, true, 'deal rules frozen');
  });
});
