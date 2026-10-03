/**
 * ============================================================================
 * AbuNashmi's Mafia — peer-to-peer transport
 * ============================================================================
 *
 * GitHub Pages serves static files and nothing else, so there is no server to
 * run the game. The host's own browser is therefore the server: it owns the
 * single authoritative game state, applies every action through `reduce`, and
 * sends each peer a projection built for that peer alone. PeerJS is used only
 * for signalling — once a data channel is open, game traffic never touches a
 * third party.
 *
 * The trust model, stated plainly:
 *
 *   - THE HOST IS THE ROOT. Identity, roles and the clock all originate there.
 *     A client cannot declare who it is, what it can do, or when a phase ends.
 *   - IDENTITY IS HOST-DERIVED. On a peer's first hello the host mints a
 *     public id and a seat token. The token is the only thing that lets a peer
 *     resume its seat after a network drop, and it never leaves that peer's
 *     device.
 *   - VIEWS ARE ALLOWLISTED. `projectState` decides what each peer may know,
 *     so a hostile client that never leaves a data channel cannot ask for more.
 *
 * The room code doubles as the peer id, which is what removes the need for any
 * lookup service: knowing the code is knowing where to connect.
 */

import { reduce, projectState, createInitialState } from './engine.js';
import { makeRoomCode, sanitizeName, isUsableName, randomHex, randomToken } from './util.js';

/** Bumped whenever the wire format changes; mismatched peers are refused. */
export const PROTOCOL = 1;

/**
 * Peer ids are globally scoped on the public PeerJS broker, so this prefix
 * keeps a six-letter room code from colliding with an unrelated application's
 * id. Plain letters, digits and hyphens only — the broker rejects anything
 * else.
 */
const PEER_PREFIX = 'anmafia1-';

/** @param {string} roomCode */
export function peerIdFor(roomCode) {
  return `${PEER_PREFIX}${roomCode}`;
}

const SESSION_KEY = (code) => `mafia.session.${code}`;

/** Largest message we will parse, in characters. */
const MAX_MESSAGE = 64 * 1024;

const CONNECT_TIMEOUT = 15000;

/**
 * Actions the host will only accept from a peer it has itself seated as
 * moderator.
 *
 * Gating here is the whole point of the trust model: the reducer deliberately
 * has no opinion about who is asking, so this set — checked by the host
 * against host-held identity, never against anything the message claims — is
 * the boundary that does.
 */
const MODERATOR_ACTIONS = new Set([
  'ADVANCE',
  'FORCE_PHASE',
  'MOD_OVERRIDE',
  'MOD_CLEAR_OVERRIDE',
  'MOD_CONFIG',
  'SET_CONFIG_LIVE',
  'SET_HOST_MODE',
  'SET_MOD_STYLE',
  'SET_ADVANCE_POLICY',
  'REMATCH',
]);

export { MODERATOR_ACTIONS };

/* ========================================================================== */
/* Resume credentials                                                          */
/* ========================================================================== */

/**
 * Read this browser's seat credentials for a room.
 *
 * `sessionStorage`, not `localStorage`: the credential should die with the tab,
 * so closing the game genuinely leaves the table rather than leaving a
 * reconnect token lying around on a shared machine.
 *
 * @param {string} roomCode
 * @returns {{publicId: string, seatToken: string}|null}
 */
export function loadSession(roomCode) {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY(roomCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.publicId === 'string' && typeof parsed?.seatToken === 'string') return parsed;
  } catch {
    /* Corrupt or unavailable storage simply means "start a new seat". */
  }
  return null;
}

export function saveSession(roomCode, publicId, seatToken) {
  try {
    sessionStorage.setItem(SESSION_KEY(roomCode), JSON.stringify({ publicId, seatToken }));
  } catch {
    /* Private mode: the player still plays, they just cannot auto-resume. */
  }
}

export function clearSession(roomCode) {
  try {
    sessionStorage.removeItem(SESSION_KEY(roomCode));
  } catch {
    /* Nothing to do. */
  }
}

/* ========================================================================== */
/* Shared plumbing                                                             */
/* ========================================================================== */

/**
 * A tiny emitter. Sessions emit `view`, `status` and `error`; the UI and the
 * main module subscribe rather than the session reaching into the DOM.
 */
class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        // A broken listener must not take the session down with it.
        console.error(`[mafia] ${event} listener failed`, err);
      }
    }
  }
}

function peerLib() {
  const P = globalThis.Peer;
  if (!P) throw new Error('PeerJS failed to load — vendor/peerjs.min.js is missing.');
  return P;
}

/**
 * Parse an inbound data-channel message defensively. Anything malformed is
 * dropped rather than thrown: a peer sending garbage is a peer, not a crash.
 */
function readMessage(data) {
  if (typeof data === 'string') {
    if (data.length > MAX_MESSAGE) return null;
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  // PeerJS also hands us Blobs/ArrayBuffers if the other side used `send` on a
  // binary payload. This protocol is text-only, so anything else is noise.
  return null;
}

function send(conn, message) {
  try {
    if (conn?.open) conn.send(JSON.stringify(message));
  } catch {
    /* A send on a dying channel is expected during reconnects. */
  }
}

/* ========================================================================== */
/* Host                                                                        */
/* ========================================================================== */

/**
 * The authoritative peer. Everything that matters happens here: it deals the
 * roles, applies the actions, runs the clock and decides what each peer is
 * allowed to see.
 */
export class HostSession extends Emitter {
  /**
   * @param {object} opts
   * @param {string} [opts.roomCode]
   * @param {string} opts.name            the host's own display name
   * @param {'moderator'|'player'} opts.role
   * @param {object} [opts.config]
   * @param {ArrayLike<number>} [opts.entropy]
   */
  constructor({ roomCode, name, role, config, entropy } = {}) {
    super();

    this.roomCode = roomCode || makeRoomCode();
    this.isModeratorHost = role === 'moderator';
    this.state = createInitialState({ roomId: this.roomCode, config, entropy });

    /** public id -> the live connection that speaks for it. */
    this.byPublicId = new Map();
    /** PeerJS connection id -> public id, so a 'close' can find its seat. */
    this.connSeat = new Map();

    this.peer = null;
    this.closed = false;
    this.timer = null;
    this.scheduledFor = null;

    // The host is a participant too, and goes through exactly the same
    // reducer as everyone else — there is no privileged "host path".
    this.selfId = randomHex(8);
    this.selfToken = randomToken(32);
    this.state = this._apply({
      type: this.isModeratorHost ? 'ADD_MODERATOR' : 'JOIN',
      id: this.selfId,
      name: sanitizeName(name) || (this.isModeratorHost ? 'Moderator' : 'Host'),
      seatToken: this.selfToken,
    });

    saveSession(this.roomCode, this.selfId, this.selfToken);
  }

  /** The host's own view — built by the same redaction boundary as any peer. */
  get view() {
    return projectState(this.state, {
      id: this.selfId,
      isModerator: this.isModeratorHost,
    });
  }

  /** Open the lobby on the signalling broker. @returns {Promise<void>} */
  async open() {
    const Peer = peerLib();
    this.emit('status', 'connecting');

    return new Promise((resolve, reject) => {
      const peer = new Peer(peerIdFor(this.roomCode), { debug: 0 });
      this.peer = peer;

      let settled = false;
      const fail = (code, err) => {
        if (settled) return;
        settled = true;
        this.emit('error', code);
        reject(err || new Error(code));
      };

      peer.on('open', () => {
        if (settled) return;
        settled = true;
        this.emit('status', 'connected', { roomCode: this.roomCode });
        this._publish();
        resolve();
      });

      peer.on('connection', (conn) => this._adopt(conn));

      peer.on('error', (err) => {
        const code = err?.type === 'unavailable-id' ? 'ROOM_CLOSED' : 'NOT_CONNECTED';
        if (!settled) fail(code, err);
        else this.emit('error', code);
      });

      peer.on('disconnected', () => {
        // The broker dropped us but the game is still running. Try to
        // re-register the same id so new players can still find the room.
        if (!this.closed && this.peer) {
          this.emit('status', 'reconnecting');
          try {
            this.peer.reconnect();
          } catch {
            /* Give up quietly; existing channels keep working either way. */
          }
        }
      });
    });
  }

  /** Wire up one inbound peer connection and wait for its hello. */
  _adopt(conn) {
    conn.on('data', (raw) => this._onData(conn, raw));
    conn.on('close', () => this._forget(conn));
    conn.on('error', () => this._forget(conn));
  }

  _forget(conn) {
    const publicId = this.connSeat.get(conn.peer);
    this.connSeat.delete(conn.peer);
    // Only clear the seat if this connection is still the current one for it:
    // a reconnect can hand the same seat a newer connection, and the older
    // connection's close event must not evict its replacement.
    if (publicId && this.byPublicId.get(publicId) === conn) {
      this.byPublicId.delete(publicId);
      // A departure mid-game keeps the seat but marks the player away, so the
      // win arithmetic cannot silently shift.
      this._apply({ type: 'LEAVE', playerId: publicId });
    }
  }

  _onData(conn, raw) {
    const msg = readMessage(raw);
    if (!msg) return;

    if (msg.t === 'hello') return this._onHello(conn, msg);

    if (msg.t === 'action') {
      const publicId = this.connSeat.get(conn.peer);
      if (!publicId) return; // hello first, always
      const action = msg.action;
      if (!action || typeof action.type !== 'string') return;
      const seated = this.state.players[publicId];
      this._dispatchAs(publicId, action, Boolean(seated?.isModerator));
      return;
    }
  }

  /**
   * Admit a peer.
   *
   * Note what the client is allowed to assert here: a name, and — on its first
   * connection only — a preference to moderate. It is not allowed to assert a
   * public id, a role, or a seat. Those come from the host.
   */
  _onHello(conn, msg) {
    if (msg.v !== PROTOCOL) {
      send(conn, { t: 'oops', code: 'WRONG_VERSION' });
      setTimeout(() => conn.close(), 50);
      return;
    }

    // --- resume an existing seat -------------------------------------------
    if (typeof msg.publicId === 'string' && typeof msg.seatToken === 'string') {
      const player = this.state.players[msg.publicId];
      if (player && player.seatToken && player.seatToken === msg.seatToken) {
        this.connSeat.set(conn.peer, msg.publicId);
        this.byPublicId.set(msg.publicId, conn);
        this._apply({ type: 'RECONNECT', playerId: msg.publicId });
        send(conn, {
          t: 'welcome',
          v: PROTOCOL,
          publicId: msg.publicId,
          seatToken: msg.seatToken,
          epoch: this.state.epoch,
        });
        this._publish();
        return;
      }
      // A bad token is not a hard failure: it just means "new seat". The peer
      // keeps its old seat token on its own device and can try again.
    }

    // --- a fresh seat -------------------------------------------------------
    const name = sanitizeName(msg.name);
    if (!isUsableName(name)) {
      send(conn, { t: 'oops', code: 'NAME_REQUIRED' });
      return;
    }
    if (this._nameTaken(name)) {
      send(conn, { t: 'oops', code: 'NAME_TAKEN' });
      return;
    }

    const publicId = randomHex(8);
    const seatToken = randomToken(32);

    // Exactly one moderator per table, and only before the deal. The host
    // sees who claimed it in the lobby and can remove them.
    const wantsModerator = msg.asModerator === true;
    const moderatorSeated = Object.values(this.state.players).some((p) => p.isModerator);
    const asModerator = wantsModerator && !moderatorSeated && this.state.phase === 'LOBBY';

    this.connSeat.set(conn.peer, publicId);
    this.byPublicId.set(publicId, conn);

    this._apply({
      type: asModerator ? 'ADD_MODERATOR' : 'JOIN',
      id: publicId,
      name,
      seatToken,
    });

    send(conn, { t: 'welcome', v: PROTOCOL, publicId, seatToken, epoch: this.state.epoch });
    this._publish();
  }

  _nameTaken(name) {
    const target = name.toLowerCase();
    return Object.values(this.state.players).some((p) => p.name.toLowerCase() === target);
  }

  /** Apply an action the host itself originated. */
  dispatch(action) {
    this._dispatchAs(this.selfId, action, this.isModeratorHost);
  }

  /**
   * Apply an action on behalf of a peer.
   *
   * The public id is supplied by the host's own connection map, never by the
   * message, so a peer cannot act as somebody else by editing its payload.
   */
  _dispatchAs(publicId, action, isModerator = false) {
    const stamped = { ...action, playerId: publicId, at: Date.now() };
    // Moderator-only actions are gated here, at the trust boundary.
    if (MODERATOR_ACTIONS.has(stamped.type) && !isModerator) return;
    this._apply(stamped);
  }

  _apply(action) {
    const { state } = reduce(this.state, action);
    this.state = state;
    this._syncTimer();
    this._publish();
    return state;
  }

  /** Send every connected peer (and the host's own UI) a fresh projection. */
  _publish() {
    // Bump the monotonic counter FIRST, so the host's own view carries the same
    // seq as the ones on the wire and the local UI can be ordered against them.
    this.state = { ...this.state, seq: this.state.seq + 1 };

    this.emit('view', this.view);

    for (const [publicId, conn] of this.byPublicId) {
      const player = this.state.players[publicId];
      const view = projectState(this.state, {
        id: publicId,
        isModerator: Boolean(player?.isModerator),
      });
      send(conn, { t: 'view', v: PROTOCOL, view });
    }
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const conn of this.byPublicId.values()) send(conn, { t: 'bye', code: 'ROOM_CLOSED' });
    try {
      this.peer?.destroy();
    } catch {
      /* Already gone. */
    }
    this.peer = null;
    this.emit('status', 'disconnected');
  }

  /**
   * Own the phase clock.
   *
   * The reducer never schedules anything itself — it publishes an absolute
   * `deadline` in state and this method turns that into exactly one live
   * `setTimeout`. Re-arming is idempotent, so a moderator pausing and
   * resuming the timer mid-phase cannot leave two timers racing.
   */
  _syncTimer() {
    const deadline = this.state.advance?.deadline ?? null;

    if (deadline == null) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.scheduledFor = null;
      return;
    }
    if (this.scheduledFor === deadline && this.timer) return;

    if (this.timer) clearTimeout(this.timer);
    this.scheduledFor = deadline;

    const wait = Math.max(0, deadline - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledFor = null;
      // Re-read the deadline rather than trusting the captured one: a phase
      // change may have moved it while this timer was pending.
      if (this.state.advance?.deadline != null && Date.now() >= this.state.advance.deadline) {
        this._apply({ type: 'TICK' });
      }
    }, wait);
  }
}

/* ========================================================================== */
/* Client                                                                      */
/* ========================================================================== */

/**
 * A joining peer. It holds no authority at all: it renders whatever the host
 * projects and asks the host for anything it wants to happen.
 */
export class ClientSession extends Emitter {
  /**
   * @param {object} opts
   * @param {string} opts.roomCode
   * @param {string} opts.name
   * @param {boolean} [opts.asModerator]
   */
  constructor({ roomCode, name, asModerator = false } = {}) {
    super();
    this.roomCode = roomCode;
    this.name = sanitizeName(name);
    this.asModerator = asModerator;
    this.view = null;
    this.peer = null;
    this.conn = null;
    this.publicId = null;
    this.seatToken = null;
    this.closed = false;
    this.attempt = 0;
    /** Host-clock offset, so countdowns survive a wrong local clock. */
    this.clockOffset = 0;
  }

  /** @returns {Promise<void>} resolves on welcome, rejects on refusal */
  async connect() {
    const Peer = peerLib();
    const saved = loadSession(this.roomCode);
    this.emit('status', 'connecting', { roomCode: this.roomCode });

    return new Promise((resolve, reject) => {
      const peer = new Peer({ debug: 0 });
      this.peer = peer;

      let settled = false;

      peer.on('open', () => {
        const conn = peer.connect(peerIdFor(this.roomCode), { reliable: true });
        this.conn = conn;

        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.emit('error', 'ROOM_NOT_FOUND');
            reject(new Error('connect timeout'));
          }
        }, CONNECT_TIMEOUT);

        conn.on('open', () => {
          send(conn, {
            t: 'hello',
            v: PROTOCOL,
            name: this.name,
            asModerator: this.asModerator,
            ...(saved ? { publicId: saved.publicId, seatToken: saved.seatToken } : {}),
          });
        });

        conn.on('data', (raw) => {
          const msg = readMessage(raw);
          if (!msg) return;

          if (msg.t === 'oops') {
            clearTimeout(timeout);
            if (!settled) {
              settled = true;
              this.emit('error', msg.code || 'UNKNOWN');
              reject(new Error(msg.code || 'refused'));
            } else {
              this.emit('error', msg.code || 'UNKNOWN');
            }
            return;
          }

          if (msg.t === 'welcome') {
            clearTimeout(timeout);
            this.publicId = msg.publicId;
            this.seatToken = msg.seatToken;
            this.attempt = 0;
            saveSession(this.roomCode, msg.publicId, msg.seatToken);
            this.emit('status', 'connected', { roomCode: this.roomCode });
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }

          if (msg.t === 'view') {
            this._acceptView(msg.view);
            return;
          }

          if (msg.t === 'bye') {
            this.closed = true;
            this.emit('error', msg.code || 'ROOM_CLOSED');
            this.emit('status', 'disconnected');
          }
        });

        conn.on('close', () => !this.closed && this._retry());
        conn.on('error', () => !this.closed && this._retry());
      });

      peer.on('error', (err) => {
        const code = err?.type === 'peer-unavailable' ? 'ROOM_NOT_FOUND' : 'NOT_CONNECTED';
        if (!settled) {
          settled = true;
          this.emit('error', code);
          reject(err || new Error(code));
        } else {
          this.emit('error', code);
        }
      });

      peer.on('disconnected', () => {
        if (!this.closed) this.emit('status', 'reconnecting');
      });
    });
  }

  /**
   * Take a projection from the host.
   *
   * Views carry a monotonic `seq`; a stale one that arrives late on a
   * reordered channel is dropped rather than briefly showing the table a
   * phase it has already left.
   */
  _acceptView(view) {
    if (!view || typeof view !== 'object') return;
    if (this.view && Number.isFinite(view.seq) && view.seq < this.view.seq) return;

    // Re-derive the host-time offset from every view, so a countdown stays
    // honest on a device whose own clock is minutes out.
    if (Number.isFinite(view.serverNow)) this.clockOffset = Date.now() - view.serverNow;

    this.view = view;
    this.emit('view', view);
  }

  /** Milliseconds left in the current phase, on this device's clock. */
  remainingMs() {
    const endsAt = this.view?.phaseEndsAt;
    if (endsAt == null) return null;
    return Math.max(0, endsAt - (Date.now() - this.clockOffset));
  }

  /** Ask the host to do something. The host may refuse. */
  dispatch(action) {
    if (this.closed || !this.conn?.open) {
      this.emit('error', 'NOT_CONNECTED');
      return;
    }
    send(this.conn, { t: 'action', action });
  }

  /** Reconnect with backoff, resuming the same seat via the seat token. */
  _retry() {
    if (this.closed) return;
    this.attempt += 1;
    const wait = Math.min(8000, 500 * 2 ** Math.min(this.attempt, 4));
    this.emit('status', 'reconnecting', { attempt: this.attempt });

    setTimeout(() => {
      if (this.closed) return;
      try {
        this.conn?.close();
      } catch {
        /* Already dead. */
      }
      this.connect().catch(() => {
        if (this.attempt >= 6) {
          this.emit('status', 'disconnected', { reason: 'host-gone' });
          this.emit('error', 'HOST_GONE');
        }
      });
    }, wait);
  }

  async close() {
    this.closed = true;
    try {
      this.conn?.close();
      this.peer?.destroy();
    } catch {
      /* Already gone. */
    }
    this.conn = null;
    this.peer = null;
    this.emit('status', 'disconnected');
  }
}

