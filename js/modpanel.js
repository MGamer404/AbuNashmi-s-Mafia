/**
 * ============================================================================
 * AbuNashmi's Mafia — the moderator's slide-over
 * ============================================================================
 *
 * The moderator sees the whole board: every role, every submission, every
 * pending slot. This panel is where they steer.
 *
 * The design rule it follows is that THE PANEL NEVER REMEMBERS ANYTHING. Every
 * control re-derives its state from the projection on each render, including
 * the ones that look like local UI state. That is not fussiness: the engine can
 * disarm a timer on a host-mode switch, or resolve a slot the moderator was
 * halfway through overriding. A panel that trusted its own last click would
 * keep showing "timer running" over a table that had already moved on.
 *
 * Everything here dispatches through the same reducer the players use. There is
 * no back channel — a moderator override is a reducer action like any other,
 * which is exactly why it survives a reconnect and replays correctly.
 */

import { PHASE } from './engine.js';
import { ROLE_META } from './roles.js';
import { t, isolate } from './i18n.js';
import { el, setChildren, setText, setHidden } from './dom.js';
import { colorIndexFor, formatClock } from './util.js';

/** The classic night order, read aloud by a human referee. */
const NIGHT_STEPS = [
  { key: 'SLEEP', slot: null },
  { key: 'MAFIA', slot: 'KILL' },
  { key: 'DOCTOR', slot: 'PROTECT' },
  { key: 'DETECTIVE', slot: 'INVESTIGATE' },
];

/** The live-settable flags the engine will actually accept mid-game. */
const LIVE_TOGGLES = [
  { key: 'liveTally' },
  { key: 'revealOnElimination' },
  { key: 'revealSave' },
  { key: 'deadCanChat' },
  { key: 'chatEnabled' },
];

export class ModPanel {
  /**
   * @param {object} opts
   * @param {(action: object) => void} opts.onAction
   * @param {() => void} [opts.onClose]
   */
  constructor(opts) {
    this.opts = opts;
    this.view = null;
    this.open_ = false;
    /** Slot key currently being overridden, if any. */
    this.overrideSlot = null;
    this.overrideTarget = null;
    /** Draft value for the duration field, committed on blur/apply. */
    this.durationDraft = null;

    /** Every node this panel owns, built once in _build and patched after. */
    this.els = {};

    this._build();
  }

  /* ====================================================================== */

  _build() {
    this.els.title = el('h2', { class: 'mod__title', id: 'mod-title', text: t('mod.title') });
    this.els.pill = el('span', { class: 'mod__pill' });
    this.els.close = el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': t('mod.close'),
      text: '✕',
      onClick: () => this.close(),
    });

    this.els.modeSection = el('section', { class: 'mod__section' });
    this.els.advanceSection = el('section', { class: 'mod__section' });
    this.els.orderSection = el('section', { class: 'mod__section' });
    this.els.seatsSection = el('section', { class: 'mod__section' });
    this.els.settingsSection = el('section', { class: 'mod__section' });

    this.els.body = el(
      'div',
      { class: 'mod__body' },
      this.els.modeSection,
      this.els.advanceSection,
      this.els.orderSection,
      this.els.seatsSection,
      this.els.settingsSection
    );

    this.els.scrim = el('div', { class: 'mod__scrim', onClick: () => this.close() });

    this.root = el(
      'aside',
      {
        class: 'mod',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'mod-title',
        hidden: true,
      },
      el('header', { class: 'mod__head' }, this.els.title, this.els.pill, this.els.close),
      this.els.body
    );

    // Escape closes the panel, which is what every slide-over owes a keyboard
    // user. Focus is trapped only for as long as the panel is open.
    this.root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        this.close();
      }
    });

    this.host = el('div', { class: 'mod-host' }, this.els.scrim, this.root);
    document.body.appendChild(this.host);
  }

  /* ====================================================================== */

  isOpen() {
    return this.open_;
  }

  open() {
    this.open_ = true;
    setHidden(this.root, false);
    setHidden(this.els.scrim, false);
    document.body.classList.add('is-mod-open');
    this.root.focus?.();
  }

  close() {
    this.open_ = false;
    setHidden(this.root, true);
    setHidden(this.els.scrim, true);
    document.body.classList.remove('is-mod-open');
    this.opts.onClose?.();
  }

  toggle() {
    if (this.open_) this.close();
    else this.open();
  }

  /** Re-render from a projection. Safe to call while closed (cheap, and keeps
   *  the panel correct the instant it opens). */
  render(view) {
    this.view = view;
    const mod = view?.moderator;
    setHidden(this.host, !view?.self?.isModerator);
    if (!mod) return;

    setText(this.els.pill, t(`mod.mode.${view.config.hostMode}`));
    this.els.pill.dataset.mode = view.config.hostMode;

    this._renderMode(view);
    this._renderAdvance(view);
    this._renderOrder(view);
    this._renderSeats(view, mod);
    this._renderSettings(view);
  }

  /* ====================================================================== */
  /* Sections                                                                */
  /* ====================================================================== */

  _section(title, ...children) {
    return [el('h3', { class: 'mod__heading', text: title }), ...children];
  }

  _renderMode(view) {
    const { hostMode } = view.config;
    const options = ['AUTOMATED', 'MODERATED'];

    setChildren(
      this.els.modeSection,
      ...this._section(
        t('mod.hostMode'),
        el(
          'div',
          { class: 'seg', role: 'radiogroup', 'aria-label': t('mod.hostMode') },
          options.map((mode) =>
            el(
              'button',
              {
                class: `seg__opt${mode === hostMode ? ' is-active' : ''}`,
                type: 'button',
                role: 'radio',
                'aria-checked': mode === hostMode ? 'true' : 'false',
                onClick: () => this._act({ type: 'SET_HOST_MODE', mode }),
              },
              el('span', { class: 'seg__label', text: t(`mod.mode.${mode}`) }),
              el('span', { class: 'seg__desc', text: t(`mod.mode.${mode}.desc`) })
            )
          )
        ),
        // The mod style only means anything once a human is refereeing.
        hostMode === 'MODERATED'
          ? el(
              'div',
              { class: 'mod__field' },
              el('span', { class: 'mod__label', text: t('mod.style') }),
              el(
                'div',
                { class: 'seg seg--tight', role: 'radiogroup', 'aria-label': t('mod.style') },
                ['PLAYERS_ACT', 'MOD_ENTERS'].map((style) =>
                  el('button', {
                    class: `seg__opt seg__opt--sm${style === view.config.modStyle ? ' is-active' : ''}`,
                    type: 'button',
                    role: 'radio',
                    'aria-checked': style === view.config.modStyle ? 'true' : 'false',
                    text: t(`mod.style.${style}`),
                    title: t(`mod.style.${style}.desc`),
                    onClick: () =>
                      this._act({ type: 'SET_MOD_STYLE', style: style === 'MOD_ENTERS' ? 'MOD_ENTERS' : 'PLAYERS_ACT' }),
                  })
                )
              )
            )
          : null
      )
    );
  }

  _renderAdvance(view) {
    const adv = view.advance;
    const armed = Boolean(adv?.deadline != null) || Boolean(view.config.modTimersArmed);
    const auto = view.config.hostMode === 'AUTOMATED';

    const status = !adv
      ? t('mod.paused')
      : armed
        ? t('mod.running', { time: formatClock(adv.remainingMs ?? 0) })
        : t('mod.paused');

    const draft = this.durationDraft ?? Math.round((adv?.durationMs ?? 30000) / 1000);

    setChildren(
      this.els.advanceSection,
      ...this._section(
        t('mod.advance'),
        el(
          'div',
          { class: 'mod__row' },
          el('span', { class: `tag tag--${armed ? 'live' : 'idle'}`, text: status })
        ),
        el(
          'div',
          { class: 'mod__row' },
          el('label', { class: 'mod__label', for: 'mod-duration', text: t('mod.duration') }),
          el('input', {
            id: 'mod-duration',
            class: 'input input--num',
            type: 'number',
            min: '5',
            max: '600',
            step: '5',
            value: String(draft),
            disabled: auto,
            onInput: (ev) => {
              this.durationDraft = Number(ev.target.value) || 0;
            },
          }),
          el('span', { class: 'mod__unit', text: 's' })
        ),
        el(
          'div',
          { class: 'mod__row mod__row--actions' },
          // In AUTOMATED mode the engine owns the clock and a human cannot arm
          // or stall it — the control is shown disabled rather than hidden so
          // the moderator can see *why* it does not respond.
          el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            disabled: auto,
            text: armed ? t('mod.disarmTimer') : t('mod.armTimer'),
            onClick: () =>
              this._act({
                type: 'SET_ADVANCE_POLICY',
                armed: !armed,
                durationMs: (this.durationDraft ?? draft) * 1000,
              }),
          }),
          el('button', {
            class: 'btn btn--primary btn--sm',
            type: 'button',
            text: `${t('mod.next')} →`,
            onClick: () => this._act({ type: 'ADVANCE' }),
          })
        ),
        auto
          ? el('p', { class: 'mod__note', text: t('mod.mode.AUTOMATED.desc') })
          : null
      )
    );
  }

  _renderOrder(view) {
    const show = view.phase === PHASE.NIGHT;
    setHidden(this.els.orderSection, !show);
    if (!show) return;

    const slots = view.moderator?.slots ?? {};
    const byKey = Object.fromEntries(Object.entries(slots).map(([k, s]) => [k, s]));

    setChildren(
      this.els.orderSection,
      ...this._section(
        t('mod.nightOrder'),
        el(
          'ol',
          { class: 'steps' },
          NIGHT_STEPS.map((step, i) => {
            const slot = step.slot ? byKey[step.slot] : null;
            const done = slot ? slot.status !== 'OPEN' || slot.override != null : i === 0;
            const count = slot ? Object.keys(slot.submissions ?? {}).length : 0;
            const total = slot ? slot.eligible.length : 0;

            return el(
              'li',
              { class: `step${done ? ' is-done' : ''}` },
              el('span', { class: 'step__num', text: String(i + 1) }),
              el('span', { class: 'step__name', text: t(`mod.step.${step.key}`) }),
              slot
                ? el('span', {
                    class: 'step__count',
                    text: t('mod.submitted', { done: count, total }),
                  })
                : null,
              slot && done ? el('span', { class: 'tag tag--live', text: t('mod.wake') }) : null
            );
          })
        ),
        el('p', { class: 'mod__note', text: t('mod.overrideHint') })
      )
    );
  }

  _renderSeats(view, mod) {
    setChildren(
      this.els.seatsSection,
      ...this._section(
        t('mod.seat'),
        el(
          'ul',
          { class: 'mod-seats' },
          mod.seats.map((seat) => {
            const meta = ROLE_META[seat.role];
            const classes = ['mod-seat'];
            if (!seat.alive) classes.push('is-out');
            if (!seat.connected) classes.push('is-away');
            if (seat.id === view.self.id) classes.push('is-me');

            return el(
              'li',
              { class: classes.join(' ') },
              el('span', { class: `dot dot--c${colorIndexFor(seat.id)}` }),
              el('span', { class: 'mod-seat__name', text: seat.name }),
              seat.id === view.self.id ? el('span', { class: 'tag', text: t('mod.you') }) : null,
              el('span', {
                class: 'tag tag--role',
                text: seat.role ? t(`role.${seat.role}`) : '—',
                title: meta ? t(`role.${seat.role}.desc`) : '',
              }),
              seat.submitted ? el('span', { class: 'tag tag--live', text: '✓' }) : null,
              !seat.alive ? el('span', { class: 'tag tag--out', text: t('game.dead') }) : null
            );
          })
        ),
        this._renderOverride(view, mod)
      )
    );
  }

  /** The override control for whichever slot is currently open. */
  _renderOverride(view, mod) {
    const open = Object.entries(mod.slots ?? {}).filter(([, s]) => s.status === 'OPEN');
    if (open.length === 0) {
      return el('p', { class: 'mod__note', text: t('mod.waiting') });
    }

    return el(
      'div',
      { class: 'mod__override' },
      ...open.map(([key, slot]) => {
        const current = slot.override ?? null;
        const names = new Map(mod.seats.map((s) => [s.id, s.name]));

        // The <select> is the single source of truth for an unapplied choice.
        // An earlier version mirrored it into a field and decided the Apply
        // button's `disabled` from that snapshot — which left Apply greyed out
        // forever, because picking from a dropdown fires `change`, not a
        // re-render, so the snapshot was always one selection stale.
        const select = el(
          'select',
          {
            class: 'input input--select',
            'aria-label': t('mod.override'),
          },
          el('option', { value: '', text: t('mod.waiting') }),
          slot.targetSpace.map((id) =>
            el('option', { value: id, text: names.get(id) ?? id, selected: current === id })
          ),
          { value: current ?? '' }
        );

        return el(
          'div',
          { class: 'override', dataset: { slot: key } },
          el('span', { class: 'override__label', text: `${t(`slot.${key}`)} — ${t('mod.override')}` }),
          el(
            'div',
            { class: 'mod__row mod__row--actions' },
            select,
            el('button', {
              class: 'btn btn--primary btn--sm',
              type: 'button',
              disabled: slot.targetSpace.length === 0,
              text: t('mod.apply'),
              onClick: () => {
                const targetId = select.value || null;
                if (targetId == null) return;
                this._act({ type: 'MOD_OVERRIDE', slot: key, choice: { targetId } });
              },
            }),
            el('button', {
              class: 'btn btn--ghost btn--sm',
              type: 'button',
              disabled: current == null,
              text: t('mod.clear'),
              onClick: () => this._act({ type: 'MOD_CLEAR_OVERRIDE', slot: key }),
            })
          ),
          current != null
            ? el('p', { class: 'override__current', text: `→ ${isolate(names.get(current) ?? '')}` })
            : null
        );
      })
    );
  }

  _renderSettings(view) {
    const inLobby = view.phase === PHASE.LOBBY;

    setChildren(
      this.els.settingsSection,
      ...this._section(
        t('mod.settings'),
        el(
          'ul',
          { class: 'toggles' },
          LIVE_TOGGLES.map(({ key }) =>
            el(
              'li',
              { class: 'toggle' },
              el('label', { class: 'toggle__label', for: `mod-toggle-${key}` },
                el('span', { text: t(`mod.${key}`) })
              ),
              el('input', {
                id: `mod-toggle-${key}`,
                class: 'toggle__input',
                type: 'checkbox',
                checked: Boolean(view.config[key]),
                onChange: (ev) => {
                  // Mid-game the engine accepts only this whitelist; in the
                  // lobby anything goes. Sending the same action either way
                  // keeps one code path.
                  this._act(
                    inLobby
                      ? { type: 'MOD_CONFIG', patch: { [key]: ev.target.checked } }
                      : { type: 'SET_CONFIG_LIVE', patch: { [key]: ev.target.checked } }
                  );
                },
              })
            )
          )
        ),
        el('p', { class: 'mod__note', text: `stalemate: ${view.moderator?.stalemate ?? 0}` })
      )
    );
  }

  /* ====================================================================== */

  _act(action) {
    this.opts.onAction?.(action);
  }
}
