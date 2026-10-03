/**
 * ============================================================================
 * AbuNashmi's Mafia — entry point
 * ============================================================================
 *
 * Everything that touches the browser lives here and nowhere else: the URL, the
 * clipboard, the animation loop, the audio unlock, the form on the home screen.
 * The modules below it — engine, net, i18n, ui, modpanel — are all importable
 * and testable without a document, which is why the engine has 86 headless
 * tests behind it.
 *
 * The one job this file has is LOOP CLOSURE. A session emits a projection; the
 * UI draws it; a click turns into an action; the action goes back to the
 * session. No module reaches around that loop, so there is exactly one place
 * where a bug in "what the player sees" can live.
 */

import { HostSession, ClientSession } from './net.js';
import { GameUI } from './ui.js';
import { ModPanel } from './modpanel.js';
import { PHASE } from './engine.js';
import { sfx, unlock, isMuted, toggleMuted } from './sound.js';
import {
  normalizeRoomCode,
  isValidRoomCode,
  sanitizeName,
  isUsableName,
  canonicalDeal,
  sha256Hex,
} from './util.js';
import { t, toggleLang, onLangChange, applyDocumentLang } from './i18n.js';

/* ========================================================================== */
/* Boot                                                                        */
/* ========================================================================== */

applyDocumentLang();
applyStaticStrings();

/** @type {HostSession|ClientSession|null} */
let session = null;
let lastPhaseId = null;
let lastTally = '';
let lastAliveCount = 0;
let frame = null;

const ui = new GameUI({
  onAction: (action) => dispatch(action),
  onChat: (text, channel) => dispatch({ type: 'CHAT', text, channel }),
  onLastWords: (text) => dispatch({ type: 'LAST_WORDS', text }),
  onStart: () => startGame(),
  onRematch: () => dispatch({ type: 'REMATCH', entropy: crypto.getRandomValues(new Uint32Array(4)) }),
  onToggleLang: () => toggleLang(),
  onToggleMute: () => {
    toggleMuted();
    ui.rerender();
  },
  isMuted: () => isMuted(),
});

const mod = new ModPanel({
  onAction: (action) => dispatch(action),
});

/* The launcher for the moderator panel. Created here rather than in the panel
   so that the panel itself never has to know whether it is currently shown. */
const modLauncher = document.createElement('button');
modLauncher.type = 'button';
modLauncher.className = 'mod-launcher';
modLauncher.hidden = true;
modLauncher.addEventListener('click', () => mod.toggle());
document.body.appendChild(modLauncher);
refreshModLauncher();

/**
 * Translate the static markup.
 *
 * The home screen is plain HTML rather than something the UI builds, so it
 * needs its own path into the dictionary. Everything marked `data-i18n` gets
 * its text replaced; `data-i18n-placeholder` and `data-i18n-aria` cover the
 * attributes, which are a different kind of string and cannot be reached with
 * textContent.
 *
 * The English in index.html is therefore a real fallback rather than a
 * duplicate: if a key were ever missing, the hard-coded English is what a
 * player sees, not a raw key.
 */
function applyStaticStrings() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of document.querySelectorAll('[data-i18n-aria]')) {
    node.setAttribute('aria-label', t(node.dataset.i18nAria));
  }
  // Only claim the document title while the home screen owns the view; a room
  // has already put its code in there.
  if (!document.getElementById('screen-home')?.hidden) {
    document.title = t('app.name');
  }
}

onLangChange(() => {
  applyStaticStrings();
  ui.rerender();
  refreshHomeTools();
  refreshModLauncher();
});

/* ========================================================================== */
/* Dispatch                                                                    */
/* ========================================================================== */

/**
 * Send an action to whoever is authoritative.
 *
 * The UI is never told whether it is a host or a guest — both sessions expose
 * the same `dispatch`, so no screen has a host path and a guest path to drift
 * apart.
 */
function dispatch(action) {
  if (!session) return;
  sfx.tap();
  session.dispatch(action);
}

/* ========================================================================== */
/* Starting a game                                                             */
/* ========================================================================== */

/**
 * Begin the deal, and — on the host alone — publish the commitment.
 *
 * The commit-reveal proof has to be sealed BEFORE anyone sees a card: the host
 * publishes `sha256(nonce + roles)` at the deal and the nonce at the end, so
 * anyone can check the roles were fixed in advance rather than invented to fit
 * the result. Only the host can do this, because only the host knows the roles.
 */
async function startGame() {
  if (!session) return;
  // No sound here: the shift into ROLE_DEAL plays one, and hearing it twice
  // would be the tell that this path is separate.
  session.dispatch({ type: 'START' });

  if (!(session instanceof HostSession)) return;
  const proof = session.state.dealProof;
  if (!proof?.rolesByPublicId) return;

  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  try {
    const commitment = await sha256Hex(canonicalDeal(nonce, proof.rolesByPublicId));
    session.dispatch({ type: 'SET_DEAL_COMMITMENT', commitment, nonce });
  } catch {
    // A missing WebCrypto context does not stop the game; it only means the
    // deal cannot be independently verified afterwards.
  }
}

/* ========================================================================== */
/* Reacting to a projection                                                    */
/* ========================================================================== */

function onView(view) {
  ui.update(view);
  mod.render(view);
  refreshModLauncher();
  reactTo(view);
  startClock();
}

function reactTo(view) {
  const phaseChanged = view.phaseId !== lastPhaseId;
  lastPhaseId = view.phaseId;

  if (phaseChanged) {
    if (view.phase === PHASE.NIGHT) sfx.night();
    else if (view.phase === PHASE.DAY_ANNOUNCE) sfx.day();
    else if (view.phase === PHASE.DAY_VOTE || view.phase === PHASE.DAY_RUNOFF) sfx.vote();
    else if (view.phase === PHASE.ROLE_DEAL) sfx.deal(0);
    else if (view.phase === PHASE.ENDED) playEndMusic(view);
  }

  // A departure is the one event with no dedicated phase of its own — it is
  // visible only as the alive count dropping.
  const alive = view.board.players.filter((p) => p.alive).length;
  if (lastAliveCount > 0 && alive < lastAliveCount) sfx.eliminated();
  lastAliveCount = alive;

  // Vote traffic can be heavy; only announce an actual change in the shape of
  // the tally, not each individual ballot.
  const tally = JSON.stringify(view.board?.tally ?? null);
  if (tally !== lastTally) {
    if (lastTally && lastTally !== 'null' && view.board?.tally) sfx.vote();
    lastTally = tally;
  }
}

function playEndMusic(view) {
  const winner = view.win?.winner;
  if (winner === 'TOWN') sfx.townWins();
  else if (winner === 'MAFIA') sfx.mafiaWins();
  else sfx.draw();
}

/* ========================================================================== */
/* The clock                                                                   */
/* ========================================================================== */

/**
 * One animation frame loop for the countdown ring.
 *
 * This is the only place in the app that reads the wall clock for display, and
 * it never writes to game state — the host's own `setTimeout` is what actually
 * ends a phase. A guest whose loop stalls sees a stale ring, never a wrong
 * game.
 */
function startClock() {
  if (frame != null) return;
  const step = () => {
    frame = null;
    const view = session?.view ?? null;
    const duration = view?.advance?.durationMs ?? 0;
    const remaining = remainingMs();
    if (view && remaining != null && duration > 0) ui.tick(remaining, duration);
    else ui.tick(null, 0, '');
    if (session) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

function stopClock() {
  if (frame != null) cancelAnimationFrame(frame);
  frame = null;
}

function remainingMs() {
  if (!session) return null;
  const view = session.view;
  const endsAt = view?.phaseEndsAt;
  if (endsAt == null) return null;

  // A guest offsets against the host's clock; the host is the clock.
  if (session instanceof ClientSession) return session.remainingMs();
  return Math.max(0, endsAt - Date.now());
}

/* ========================================================================== */
/* Sessions                                                                    */
/* ========================================================================== */

function wire(activeSession) {
  activeSession.on('view', onView);
  activeSession.on('status', (status, detail) => ui.setStatus(status, detail));
  activeSession.on('error', (code) => {
    sfx.error();
    ui.notify(code, 'error');
  });
}

function teardown() {
  stopClock();
  session?.close?.();
  session = null;
  lastPhaseId = null;
  lastTally = '';
  lastAliveCount = 0;
}

async function createRoom({ name, asModerator }) {
  teardown();
  const next = new HostSession({ name, role: asModerator ? 'moderator' : 'player' });
  session = next;
  wire(next);
  ui.showRoom(next.roomCode);
  ui.setStatus('connecting');
  markUrl(next.roomCode);
  try {
    await next.open();
  } catch (err) {
    ui.notify(err?.message ?? 'error.UNKNOWN', 'error');
  }
}

async function joinRoom({ name, roomCode, asModerator }) {
  teardown();
  const next = new ClientSession({ roomCode, name, asModerator });
  session = next;
  wire(next);
  ui.showRoom(roomCode);
  ui.setStatus('connecting');
  markUrl(roomCode);
  try {
    await next.connect();
  } catch {
    // `connect` already emitted the specific error; the home screen is where
    // the player can try again from.
    ui.setStatus('disconnected');
  }
}

/* ========================================================================== */
/* URL                                                                         */
/* ========================================================================== */

/** Put the room code in the URL so "share" is just "copy the address". */
function markUrl(code) {
  try {
    const url = new URL(location.href);
    url.hash = code ? `#${code}` : '';
    history.replaceState(null, '', url);
  } catch {
    /* A blocked history API costs nothing but a tidy address. */
  }
}

function codeFromUrl() {
  const raw = location.hash.replace(/^#/, '');
  const code = normalizeRoomCode(raw);
  return isValidRoomCode(code) ? code : '';
}

/* ========================================================================== */
/* Home screen                                                                 */
/* ========================================================================== */

const formCreate = document.getElementById('form-create');
const formJoin = document.getElementById('form-join');

{
  const prefilled = codeFromUrl();
  const joinCodeInput = document.getElementById('join-code');
  if (prefilled && joinCodeInput) {
    joinCodeInput.value = prefilled;
    openTab('join');
  }
}

// The code field is the one place a player types a code, so it is normalised on
// every keystroke — the alphabet excludes I, L, O, 0 and 1, so a typed one is
// always a misreading and simply does not appear.
document.getElementById('join-code')?.addEventListener('input', (ev) => {
  ev.target.value = normalizeRoomCode(ev.target.value);
});

formCreate?.addEventListener('submit', (ev) => {
  ev.preventDefault();
  unlock();
  const name = sanitizeName(document.getElementById('create-name').value);
  if (!isUsableName(name)) return ui.notify('error.NAME_REQUIRED', 'error');
  createRoom({ name, asModerator: document.getElementById('create-moderator').checked });
});

formJoin?.addEventListener('submit', (ev) => {
  ev.preventDefault();
  unlock();
  const name = sanitizeName(document.getElementById('join-name').value);
  const raw = document.getElementById('join-code').value;
  if (!isUsableName(name)) return ui.notify('error.NAME_REQUIRED', 'error');
  if (!isValidRoomCode(raw)) return ui.notify('error.ROOM_NOT_FOUND', 'error');
  joinRoom({
    name,
    roomCode: raw,
    asModerator: document.getElementById('join-moderator')?.checked ?? false,
  });
});

document.querySelectorAll('[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => openTab(btn.dataset.tab));
});

function openTab(which) {
  for (const panel of document.querySelectorAll('[data-tab-panel]')) {
    panel.hidden = panel.dataset.tabPanel !== which;
  }
  for (const btn of document.querySelectorAll('[data-tab]')) {
    const on = btn.dataset.tab === which;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

/* ========================================================================== */
/* Chrome                                                                      */
/* ========================================================================== */

ui.setStatus('disconnected');
ui.showHome();

/* The home screen has its own language and sound buttons, because the room
   topbar — which owns the other pair — does not exist until a room does. */
const homeLang = document.getElementById('home-lang');
const homeMute = document.getElementById('home-mute');

homeLang?.addEventListener('click', () => {
  unlock();
  toggleLang();
});

homeMute?.addEventListener('click', () => {
  unlock();
  toggleMuted();
  refreshHomeTools();
});

function refreshHomeTools() {
  if (homeLang) homeLang.textContent = document.documentElement.lang === 'ar' ? 'ع' : 'EN';
  if (homeLang) homeLang.setAttribute('aria-label', t('a11y.language'));
  if (homeMute) {
    homeMute.textContent = isMuted() ? '🔇' : '🔊';
    homeMute.setAttribute('aria-label', isMuted() ? t('a11y.unmute') : t('a11y.mute'));
  }
}

refreshHomeTools();

function refreshModLauncher() {
  const isMod = Boolean(session?.view?.self?.isModerator);
  modLauncher.hidden = !isMod;
  modLauncher.textContent = t('mod.title');
  modLauncher.setAttribute('aria-label', t('mod.title'));
}

// A player leaving the tab should not keep a lobby slot looking occupied.
window.addEventListener('pagehide', () => {
  if (session instanceof HostSession) session.close();
});

// Exposed for debugging from the console. Deliberately read-only: `session` is
// a getter, so nothing here can be replaced by a stray assignment.
window.mafia = { ui, mod, get session() { return session; } };
