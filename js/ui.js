/**
 * ============================================================================
 * AbuNashmi's Mafia — the table
 * ============================================================================
 *
 * Everything visible. The UI holds no game state of its own: it is handed a
 * projection from the host on every change and patches the DOM to match. That
 * one-way flow is why the two host modes need no separate rendering — a view
 * says what is true, never who arranged it.
 *
 * Two rendering decisions worth stating:
 *
 *   - THE DOM IS BUILT ONCE AND PATCHED. Re-creating the tree on every view
 *     would throw away focus mid-sentence in the chat box and restart the CSS
 *     transitions on the role card. So the skeleton is constructed at startup
 *     and `update()` writes text, classes and attributes into it.
 *
 *   - TEXT ONLY EVER REACHES THE PAGE AS TEXT. See dom.js. Nothing a player
 *     types is parsed as markup, anywhere.
 */

import { ROLE_META, ROLE } from './roles.js';
import { PHASE } from './engine.js';
import { t, isolate, getLang } from './i18n.js';
import {
  el,
  setChildren,
  setText,
  setHidden,
  button,
  flipCard,
  countdownRing,
} from './dom.js';
import { sanitizeChat, formatClock, colorIndexFor } from './util.js';

const CHANNEL_ORDER = ['public', 'mafia', 'dead'];

/**
 * The phases that have a prompt for the table. Deliberately a list rather than
 * "every phase": asking for `hint.${phase}` across the whole enum would put the
 * raw key `hint.DAY_ANNOUNCE` on screen for the phases that have nothing to
 * ask, because a missing translation returns the key itself.
 */
const HINT_PHASES = new Set([PHASE.DAY_DISCUSS, PHASE.DAY_VOTE, PHASE.DAY_RUNOFF, PHASE.LAST_WORDS]);

export class GameUI {
  /**
   * @param {object} opts
   * @param {(action: object) => void} opts.onAction
   * @param {(text: string, channel: string) => void} opts.onChat
   * @param {(text: string) => void} opts.onLastWords
   * @param {() => void} opts.onStart
   * @param {() => void} opts.onRematch
   * @param {() => void} opts.onToggleLang
   * @param {() => void} opts.onToggleMute
   * @param {() => boolean} opts.isMuted
   */
  constructor(opts) {
    this.opts = opts;

    /** The most recent projection. Everything renders from it. */
    this.view = null;
    /** Chat channel the player is currently reading. */
    this.channel = 'public';
    /** Set while the local player is choosing a target, before confirming. */
    this.selected = null;
    this.status = 'disconnected';

    this.els = {};
    this._build();
  }

  /* ====================================================================== */
  /* Skeleton                                                                */
  /* ====================================================================== */

  _build() {
    this.els.screenHome = document.getElementById('screen-home');
    this.els.screenRoom = document.getElementById('screen-room');

    this._buildTopbar();
    this._buildLobby();
    this._buildStage();
    this._buildChat();
    this.els.toasts = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(this.els.toasts);
  }

  _buildTopbar() {
    this.els.roomCode = el('span', { class: 'chip__code' });
    this.els.copyBtn = button(t('a11y.copyCode'), {
      class: 'chip chip--code',
      ariaLabel: t('a11y.copyCode'),
      onClick: () => this.opts.onCopyCode?.(this.view?.roomId ?? ''),
    });
    setChildren(this.els.copyBtn, el('span', { class: 'chip__label', text: t('game.room') }), this.els.roomCode);

    this.els.phaseName = el('span', { class: 'phase__name' });
    this.els.round = el('span', { class: 'phase__round' });
    this.ring = countdownRing();

    this.els.langBtn = button('EN', {
      class: 'icon-btn',
      ariaLabel: t('a11y.language'),
      onClick: () => this.opts.onToggleLang?.(),
    });
    this.els.muteBtn = button('🔊', {
      class: 'icon-btn',
      ariaLabel: t('a11y.mute'),
      onClick: () => this.opts.onToggleMute?.(),
    });
    this.els.status = el('span', { class: 'status', role: 'status' });

    this.els.topbar = el(
      'header',
      { class: 'topbar' },
      el('div', { class: 'topbar__left' }, this.els.copyBtn),
      el('div', { class: 'topbar__mid' }, this.els.phaseName, this.els.round, this.ring.root),
      el('div', { class: 'topbar__right' }, this.els.status, this.els.langBtn, this.els.muteBtn)
    );

    document.getElementById('room-topbar').appendChild(this.els.topbar);
  }

  _buildLobby() {
    this.els.lobbySeats = el('p', { class: 'lobby__seats' });
    this.els.lobbyList = el('ul', { class: 'seats', 'aria-label': t('a11y.playerList') });
    this.els.lobbyHint = el('p', { class: 'lobby__hint' });
    this.els.startBtn = button(t('lobby.start'), {
      class: 'btn btn--primary',
      onClick: () => this.opts.onStart?.(),
    });
    this.els.lobbyActions = el('div', { class: 'lobby__actions' }, this.els.startBtn);

    this.els.lobby = el(
      'section',
      { class: 'panel lobby' },
      el('h2', { class: 'panel__title', text: t('lobby.title') }),
      this.els.lobbySeats,
      this.els.lobbyList,
      this.els.lobbyHint,
      this.els.lobbyActions
    );

    document.getElementById('room-stage').appendChild(this.els.lobby);
  }

  _buildStage() {
    // --- role card ---------------------------------------------------------
    this.card = flipCard({ backLabel: t('a11y.cardBack'), frontLabel: t('game.yourRole') });
    this.els.roleName = el('p', { class: 'role__name' });
    this.els.roleDesc = el('p', { class: 'role__desc' });
    this.els.roleTeam = el('p', { class: 'role__team' });
    this.els.roleSecret = el('p', { class: 'role__secret', text: t('game.secret') });

    this.els.rolePanel = el(
      'section',
      { class: 'panel role' },
      el('h2', { class: 'panel__title', text: t('game.yourRole') }),
      this.card.root,
      this.els.roleName,
      this.els.roleTeam,
      this.els.roleDesc,
      this.els.roleSecret
    );
    this.els.rolePanel.addEventListener('click', () => {
      this.card.setRevealed(!this.card.isRevealed(), this._roleFrontText());
    });

    // --- announcement ------------------------------------------------------
    this.els.reportLine = el('p', { class: 'report__line' });
    this.els.report = el(
      'section',
      { class: 'panel report', role: 'status', 'aria-live': 'polite' },
      this.els.reportLine
    );

    // --- the table ---------------------------------------------------------
    this.els.boardTitle = el('h2', { class: 'panel__title', id: 'board-title', text: t('a11y.playerList') });
    this.els.board = el('ul', { class: 'board', 'aria-labelledby': 'board-title' });
    this.els.boardPanel = el('section', { class: 'panel' }, this.els.boardTitle, this.els.board);

    // --- action ------------------------------------------------------------
    this.els.hint = el('p', { class: 'action__hint' });
    this.els.choices = el('div', { class: 'choices' });
    this.els.abstainBtn = button(t('vote.abstain'), {
      class: 'btn btn--ghost',
      onClick: () => this._submitChoice(null),
    });
    this.els.confirmBtn = button(t('vote.cast'), {
      class: 'btn btn--primary',
      onClick: () => this._submitChoice(this.selected),
    });
    this.els.actions = el('div', { class: 'action__bar' }, this.els.abstainBtn, this.els.confirmBtn);
    this.els.actionPanel = el(
      'section',
      { class: 'panel action' },
      this.els.hint,
      this.els.choices,
      this.els.actions
    );

    // --- tally -------------------------------------------------------------
    this.els.tallyTitle = el('h3', { class: 'tally__title', id: 'tally-title', text: t('vote.tally') });
    this.els.tally = el('div', { class: 'tally', 'aria-labelledby': 'tally-title' });
    this.els.tallyPanel = el('section', { class: 'panel' }, this.els.tallyTitle, this.els.tally);

    // --- last words --------------------------------------------------------
    this.els.lastWordsInput = el('textarea', {
      class: 'input',
      rows: '3',
      maxlength: '300',
      placeholder: t('lastWords.placeholder'),
      'aria-label': t('lastWords.title'),
    });
    this.els.lastWordsSend = button(t('lastWords.send'), {
      class: 'btn btn--primary',
      onClick: () => this._sendLastWords(),
    });
    this.els.lastWordsSkip = button(t('lastWords.skip'), {
      class: 'btn btn--ghost',
      onClick: () => this.opts.onAction?.({ type: 'SKIP_LAST_WORDS' }),
    });
    this.els.lastWordsPanel = el(
      'section',
      { class: 'panel last-words' },
      el('h3', { class: 'panel__title', text: t('lastWords.title') }),
      this.els.lastWordsInput,
      el('div', { class: 'action__bar' }, this.els.lastWordsSkip, this.els.lastWordsSend)
    );

    // --- end ---------------------------------------------------------------
    this.els.endTitle = el('h2', { class: 'end__title' });
    this.els.endReason = el('p', { class: 'end__reason' });
    this.els.endReveal = el('ul', { class: 'reveal' });
    this.els.endProof = el('details', { class: 'proof' });
    this.els.rematchBtn = button(t('end.rematch'), {
      class: 'btn btn--primary',
      onClick: () => this.opts.onRematch?.(),
    });
    this.els.endPanel = el(
      'section',
      { class: 'panel end', role: 'alert' },
      this.els.endTitle,
      this.els.endReason,
      this.els.endReveal,
      this.els.endProof,
      el('div', { class: 'action__bar' }, this.els.rematchBtn)
    );

    const stage = document.getElementById('room-stage');
    for (const panel of [
      this.els.report,
      this.els.actionPanel,
      this.els.tallyPanel,
      this.els.lastWordsPanel,
      this.els.rolePanel,
      this.els.boardPanel,
      this.els.endPanel,
    ]) {
      stage.appendChild(panel);
    }
  }

  _buildChat() {
    this.els.chatLog = el('ul', { class: 'chat__log', role: 'log', 'aria-live': 'polite' });
    this.els.chatTabs = el('div', { class: 'chat__tabs', role: 'tablist' });
    this.els.chatInput = el('textarea', {
      class: 'input chat__input',
      rows: '1',
      maxlength: String(400),
      placeholder: t('chat.placeholder'),
      'aria-label': t('chat.title'),
    });
    this.els.chatSend = button(t('chat.send'), {
      class: 'btn btn--primary btn--sm',
      onClick: () => this._sendChat(),
    });
    this.els.chatInput.addEventListener('keydown', (ev) => {
      // Enter sends; Shift+Enter is a newline, as in every chat people know.
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        this._sendChat();
      }
    });

    this.els.chatComposer = el(
      'div',
      { class: 'chat__composer' },
      this.els.chatInput,
      this.els.chatSend
    );

    this.els.chat = el(
      'aside',
      { class: 'chat', 'aria-label': t('chat.title') },
      el('h2', { class: 'panel__title', text: t('chat.title') }),
      this.els.chatTabs,
      this.els.chatLog,
      this.els.chatComposer
    );

    document.getElementById('room-aside').appendChild(this.els.chat);
  }

  /* ====================================================================== */
  /* Public API                                                              */
  /* ====================================================================== */

  showHome() {
    setHidden(this.els.screenHome, false);
    setHidden(this.els.screenRoom, true);
  }

  showRoom(roomCode) {
    setHidden(this.els.screenHome, true);
    setHidden(this.els.screenRoom, false);
    this.setRoomCode(roomCode);
    document.title = `${roomCode} — ${t('app.name')}`;
  }

  setRoomCode(code) {
    setText(this.els.roomCode, code || '');
  }

  /** @param {'connecting'|'connected'|'reconnecting'|'disconnected'} status */
  setStatus(status, detail) {
    this.status = status;
    const label = t(`conn.${status === 'connected' ? 'connected' : status}`);
    setText(this.els.status, label);
    this.els.status.dataset.status = status;
    this.els.status.title = detail?.reason ? t('error.HOST_GONE') : '';
  }

  /** Show a transient message. Errors are announced, not just drawn. */
  notify(code, kind = 'error') {
    const node = el('div', {
      class: `toast toast--${kind}`,
      role: kind === 'error' ? 'alert' : 'status',
      text: t(code),
    });
    this.els.toasts.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }

  /** Re-render everything from a fresh projection. */
  update(view) {
    const previous = this.view;
    this.view = view;
    if (!view) return;

    const changedPhase = previous?.phaseId !== view.phaseId;
    if (changedPhase) this.selected = null;

    this._renderTopbar(view);
    this._renderLobby(view);
    this._renderRole(view);
    this._renderBoard(view);
    this._renderAction(view);
    this._renderTally(view);
    this._renderReport(view);
    this._renderLastWords(view);
    this._renderEnd(view);
    this._renderChat(view);
    this._renderMute();
  }

  /** Repaint only the clock — called on an animation frame, not a full render. */
  tick(remainingMs, durationMs) {
    this.ring.update(remainingMs, durationMs, remainingMs == null ? '' : formatClock(remainingMs));
  }

  rerender() {
    if (this.view) this.update(this.view);
  }

  /* ====================================================================== */
  /* Sections                                                                */
  /* ====================================================================== */

  _renderTopbar(view) {
    setText(this.els.phaseName, t(`phase.${view.phase}`));
    setText(
      this.els.round,
      view.phase === PHASE.LOBBY || view.phase === PHASE.ENDED ? '' : t('game.round', { n: view.round })
    );
    document.documentElement.dataset.phase = view.isNight ? 'night' : 'day';
    setText(this.els.langBtn, getLang() === 'ar' ? 'ع' : 'EN');
  }

  _renderMute() {
    const muted = this.opts.isMuted?.() ?? false;
    setText(this.els.muteBtn, muted ? '🔇' : '🔊');
    this.els.muteBtn.setAttribute('aria-label', muted ? t('a11y.unmute') : t('a11y.mute'));
  }

  _renderLobby(view) {
    const show = view.phase === PHASE.LOBBY;
    setHidden(this.els.lobby, !show);
    if (!show) return;

    const players = view.board.players;
    setText(this.els.lobbySeats, t('lobby.seats', { count: players.length, max: 20 }));

    setChildren(
      this.els.lobbyList,
      players.map((p) => {
        const isSelf = p.id === view.self.id;
        return el(
          'li',
          { class: `seat${p.alive ? '' : ' is-out'}` },
          el('span', { class: `dot dot--c${colorIndexFor(p.id)}` }),
          el('span', { class: 'seat__name', text: p.name }),
          isSelf ? el('span', { class: 'tag', text: t('lobby.you') }) : null,
          p.connected ? null : el('span', { class: 'tag tag--muted', text: t('lobby.away') })
        );
      })
    );

    // Every seated player can start, not just a moderator. A table may have no
    // moderator at all — that is the whole point of the automated mode — and
    // gating the button on a role that might not exist would leave such a
    // lobby unable to begin. The lobby is cooperative; there is nothing to
    // protect here that the deal does not already protect.
    const enough = players.length >= 5;
    const seated = view.self.id != null && !view.self.isSpectator;
    setHidden(this.els.startBtn, !seated);
    this.els.startBtn.disabled = !(seated && enough);
    setText(
      this.els.lobbyHint,
      enough ? t('lobby.startHint') : t('lobby.needMore', { min: 5 })
    );
  }

  _roleFrontText() {
    const role = this.view?.self?.role;
    if (!role) return '';
    return t(`role.${role}`);
  }

  _renderRole(view) {
    const inGame =
      view.phase !== PHASE.LOBBY && view.phase !== PHASE.ENDED && Boolean(view.self.role);
    setHidden(this.els.rolePanel, !inGame);
    if (!inGame) {
      this.card.setRevealed(false, '');
      return;
    }

    const role = view.self.role;
    const meta = ROLE_META[role];
    this.els.rolePanel.style.setProperty('--role-accent', `var(${meta?.accent ?? '--c-accent'})`);
    this.els.rolePanel.dataset.role = role;

    setText(this.els.roleName, t(`role.${role}`));
    setText(this.els.roleTeam, t(`team.${meta?.team ?? 'TOWN'}`));
    setText(this.els.roleDesc, t(`role.${role}.desc`));
    setHidden(this.els.roleSecret, this.card.isRevealed());
    this.card.setRevealed(this.card.isRevealed(), this._roleFrontText());
  }

  _renderBoard(view) {
    const show = view.phase !== PHASE.LOBBY;
    setHidden(this.els.boardPanel, !show);
    if (!show) return;

    // During a vote the board doubles as the ballot, so the targets are
    // buttons; the rest of the time it is a plain list.
    const voting = view.phase === PHASE.DAY_VOTE || view.phase === PHASE.DAY_RUNOFF;
    const pending = view.privateNotes?.pending;
    const canTarget =
      voting && pending?.kind === 'VOTE' && view.privateNotes?.canAct && pending.targetSpace.length > 0;
    const targets = new Set(canTarget ? pending.targetSpace : []);

    setChildren(
      this.els.board,
      view.board.players.map((p) => {
        const isSelf = p.id === view.self.id;
        const isTarget = targets.has(p.id);
        const classes = ['card'];
        if (!p.alive) classes.push('is-out');
        if (isSelf) classes.push('is-self');
        if (isTarget) classes.push('is-target');
        if (this.selected === p.id) classes.push('is-selected');
        if (p.id === view.board.lastWordsFor) classes.push('is-speaking');

        const nameRow = el(
          'span',
          { class: 'card__name-row' },
          el('span', { class: `dot dot--c${colorIndexFor(p.id)}` }),
          el('span', { class: 'card__name', text: p.name }),
          isSelf ? el('span', { class: 'tag', text: t('game.you') }) : null
        );

        const statusRow = el(
          'span',
          { class: 'card__status' },
          p.alive ? null : el('span', { class: 'tag tag--out', text: t('game.dead') }),
          p.connected ? null : el('span', { class: 'tag tag--muted', text: t('lobby.away') }),
          // A role is only present here when the table has chosen to reveal it.
          p.role ? el('span', { class: 'tag tag--role', text: t(`role.${p.role}`) }) : null
        );

        if (!isTarget) {
          return el('li', { class: classes.join(' ') }, nameRow, statusRow);
        }
        return el(
          'li',
          { class: classes.join(' ') },
          el(
            'button',
            {
              class: 'card__pick',
              type: 'button',
              'aria-pressed': this.selected === p.id ? 'true' : 'false',
              'aria-label': p.name,
              onClick: () => {
                this.selected = this.selected === p.id ? null : p.id;
                this._renderBoard(this.view);
                this._renderAction(this.view);
              },
            },
            nameRow,
            statusRow
          )
        );
      })
    );
  }

  _renderAction(view) {
    const pending = view.privateNotes?.pending;
    const canAct = Boolean(view.privateNotes?.canAct);
    const ended = view.phase === PHASE.ENDED;

    let hint = '';
    if (ended) hint = '';
    else if (view.isNight && view.self.role) hint = t(`hint.NIGHT.${view.self.role.toLowerCase()}`);
    else if (!view.isNight && HINT_PHASES.has(view.phase)) hint = t(`hint.${view.phase}`);

    const usable = !ended && canAct && pending && pending.targetSpace.length > 0;

    setHidden(this.els.actionPanel, !hint || ended);
    setText(this.els.hint, hint);
    if (!hint || ended) return;

    const targetById = new Map(view.board.players.map((p) => [p.id, p]));
    setChildren(
      this.els.choices,
      usable
        ? pending.targetSpace.map((id) => {
            const p = targetById.get(id);
            const kindHint = this._choiceHint(pending.kind, p);
            return el(
              'button',
              {
                class: `choice${this.selected === id ? ' is-selected' : ''}`,
                type: 'button',
                'aria-pressed': this.selected === id ? 'true' : 'false',
                onClick: () => {
                  this.selected = this.selected === id ? null : id;
                  this._renderAction(this.view);
                  this._renderBoard(this.view);
                },
              },
              el('span', { class: `dot dot--c${colorIndexFor(id)}` }),
              el('span', { class: 'choice__name', text: p?.name ?? '' }),
              kindHint ? el('span', { class: 'choice__hint', text: kindHint }) : null
            );
          })
        : [el('p', { class: 'action__none', text: t('hint.waiting') })]
    );

    // The vote panel offers abstaining only when the house rule allows it, and
    // an action already taken is shown as changeable rather than hidden.
    const mine = pending?.myChoice ?? null;
    const showAbstain = usable && pending.kind === 'VOTE' && view.config.vote.allowAbstain;
    setHidden(this.els.abstainBtn, !showAbstain);
    setHidden(this.els.confirmBtn, !usable);

    if (usable) {
      const locked = mine && pending.kind === 'VOTE' && !view.config.vote.changeableUntilDeadline;
      this.els.confirmBtn.disabled = locked || this.selected == null;
      setText(this.els.confirmBtn, mine ? t('vote.change') : t('vote.cast'));
      this.selected = this.selected ?? mine?.targetId ?? null;
    }
  }

  /**
   * A short note on a candidate, shown under their name in the picker.
   *
   * Only the Detective gets one: their own past readings of that player. It
   * saves them re-investigating someone they already know, which is the single
   * most common way a Detective wastes a night. Nobody else's picker carries a
   * hint, because any hint derived from a role would be a leak.
   */
  _choiceHint(kind, player) {
    if (!player || kind !== 'INVESTIGATE') return '';
    const results = this.view?.privateNotes?.detectiveResults;
    if (!results?.length) return '';
    const last = [...results].reverse().find((r) => r.targetId === player.id);
    if (!last) return '';
    return t(`verdict.${last.verdict}`);
  }

  _submitChoice(targetId) {
    const pending = this.view?.privateNotes?.pending;
    if (!pending) return;
    this.opts.onAction?.({
      type: 'SUBMIT',
      slot: pending.kind === 'VOTE' ? 'VOTE' : pending.kind,
      phaseId: pending.phaseId,
      choice: { targetId, abstain: targetId == null },
    });
    this.selected = targetId;
  }

  _renderTally(view) {
    // Live counts are a house rule: an open tally can change how people vote,
    // so the table chooses whether to see it before the window closes.
    const voting = view.phase === PHASE.DAY_VOTE || view.phase === PHASE.DAY_RUNOFF;
    const tally = view.board.tally;
    const show = Boolean(tally && Object.keys(tally).length > 0) && (view.config.liveTally || !voting);

    setHidden(this.els.tallyPanel, !show);
    if (!show) return;

    const byId = new Map(view.board.players.map((p) => [p.id, p.name]));
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(([, n]) => n));

    setChildren(
      this.els.tally,
      entries.map(([id, count]) =>
        el(
          'div',
          { class: 'tally__row' },
          el('span', { class: 'tally__name', text: byId.get(id) ?? '' }),
          el(
            'span',
            { class: 'tally__bar', role: 'img', 'aria-label': `${count}` },
            el('span', {
              class: 'tally__fill',
              style: { inlineSize: `${Math.round((count / max) * 100)}%` },
            })
          ),
          el('span', { class: 'tally__count', text: String(count) })
        )
      )
    );
  }

  _renderReport(view) {
    const text = this._reportText(view);
    setHidden(this.els.report, !text);
    setText(this.els.reportLine, text);
  }

  /** One sentence describing what just happened, from the last report. */
  _reportText(view) {
    const nameOf = (id) => view.board.players.find((p) => p.id === id)?.name ?? '';

    if (view.phase === PHASE.DAY_ANNOUNCE && view.board.nightReport) {
      const r = view.board.nightReport;
      if (r.noKillNight) return t('report.firstNight');
      if (r.saved) return t('report.saved');
      if (r.killedId) return t('report.death', { name: isolate(nameOf(r.killedId)) });
      return t('report.noDeath');
    }

    if (view.board.lastElimination) {
      return t('report.killed', { name: isolate(nameOf(view.board.lastElimination.playerId)) });
    }

    if (view.isNight && view.round > 1) return t('report.noElimination');

    return '';
  }

  _renderLastWords(view) {
    const mine = view.board.lastWordsFor === view.self.id;
    setHidden(this.els.lastWordsPanel, !mine);
    if (mine) {
      this.els.lastWordsInput.placeholder = t('lastWords.placeholder');
    }
  }

  _sendLastWords() {
    const text = sanitizeChat(this.els.lastWordsInput.value);
    if (!text) return;
    this.opts.onLastWords?.(text);
    this.els.lastWordsInput.value = '';
  }

  _renderEnd(view) {
    const show = view.phase === PHASE.ENDED;
    setHidden(this.els.endPanel, !show);
    if (!show) return;

    setText(this.els.endTitle, t(`end.${this._endKey(view)}`));
    setText(this.els.endReason, t(`end.reason.${view.win?.reason ?? 'UNKNOWN'}`));

    const reveal = view.board.reveal ?? {};
    setChildren(
      this.els.endReveal,
      view.board.players.map((p) =>
        el(
          'li',
          { class: 'reveal__row' },
          el('span', { class: `dot dot--c${colorIndexFor(p.id)}` }),
          el('span', { class: 'reveal__name', text: p.name }),
          el('span', {
            class: `tag tag--role tag--${(reveal[p.id] ?? '').toLowerCase()}`,
            text: reveal[p.id] ? t(`role.${reveal[p.id]}`) : '—',
          })
        )
      )
    );

    const proof = view.board.dealProof;
    setChildren(
      this.els.endProof,
      el('summary', { text: t('end.proof') }),
      el('p', { class: 'proof__hint', text: t('end.proofHint') }),
      el('code', { class: 'proof__commit', text: proof?.commitment ?? '—' })
    );
  }

  _endKey(view) {
    const winner = view.win?.winner;
    if (winner === 'TOWN') return 'townWins';
    if (winner === 'MAFIA') return 'mafiaWins';
    if (winner === 'DRAW') return 'draw';
    return 'draw';
  }

  /* ---- chat ------------------------------------------------------------ */

  _renderChat(view) {
    const available = this._availableChannels(view);
    if (!available.includes(this.channel)) this.channel = available[0] ?? 'public';

    setChildren(
      this.els.chatTabs,
      available.map((channel) =>
        el('button', {
          class: `chat__tab${channel === this.channel ? ' is-active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': channel === this.channel ? 'true' : 'false',
          text: t(`chat.${channel}`),
          onClick: () => {
            this.channel = channel;
            this._renderChat(this.view);
          },
        })
      )
    );

    const messages = (view.chat ?? []).filter((m) => m.channel === this.channel);
    setChildren(
      this.els.chatLog,
      messages.length === 0
        ? [el('li', { class: 'chat__empty', text: t('chat.empty') })]
        : messages.map((m) =>
            el(
              'li',
              { class: `chat__msg${m.from === view.self.id ? ' is-mine' : ''}` },
              el('span', { class: 'chat__from', text: m.name }),
              el('span', { class: 'chat__text', text: m.text })
            )
          )
    );
    this.els.chatLog.scrollTop = this.els.chatLog.scrollHeight;

    const canPost = this._canPost(view, this.channel);
    setHidden(this.els.chatComposer, !canPost);
    this.els.chatInput.placeholder = canPost ? t('chat.placeholder') : t('chat.silenced');
  }

  /** Which channels this player may READ. The host enforces the same set. */
  _availableChannels(view) {
    const out = [];
    const role = view.self.role;
    const alive = view.self.alive;

    if (alive) out.push('public');
    if (view.self.isModerator) return ['public', 'mafia', 'dead'];
    if (role === ROLE.MAFIA) out.push('mafia');
    if (!alive && view.config.deadCanChat) out.push('dead');
    if (!alive) out.push('public'); // the departed still watch the table

    return CHANNEL_ORDER.filter((c) => out.includes(c));
  }

  /** Which channels this player may WRITE to. */
  _canPost(view, channel) {
    if (!view.config.chatEnabled || view.self.isModerator) return view.config.chatEnabled;
    if (channel === 'mafia') return view.self.role === ROLE.MAFIA;
    if (channel === 'dead') return !view.self.alive && view.config.deadCanChat;
    if (channel === 'public') return view.self.alive;
    return false;
  }

  _sendChat() {
    const text = sanitizeChat(this.els.chatInput.value);
    if (!text) return;
    this.opts.onChat?.(text, this.channel);
    this.els.chatInput.value = '';
  }
}
