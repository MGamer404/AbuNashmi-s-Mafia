/**
 * ============================================================================
 * AbuNashmi's Mafia — DOM helpers
 * ============================================================================
 *
 * There is no framework here, so this module is the whole rendering toolkit.
 * The single rule it exists to enforce: **nothing is ever built with
 * `innerHTML`**. Text reaches the page through `textContent` and attributes
 * through `setAttribute`, which means a player named `<img onerror=…>` is a
 * player named `<img onerror=…>` and never a running script. That property
 * does not depend on remembering to escape anything at each of the several
 * dozen places a name or a chat line is rendered.
 */

/**
 * Create an element.
 *
 * @param {string} tag
 * @param {object} [props]  `class`, `text`, `html` is deliberately absent;
 *                          `on*` handlers, `dataset`, and anything else becomes
 *                          an attribute.
 * @param {...(Node|string|null|undefined|false)} children
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;

    if (key === 'class' || key === 'className') {
      node.className = value;
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, val] of Object.entries(value)) {
        if (prop.startsWith('--')) node.style.setProperty(prop, String(val));
        else node.style[prop] = val;
      }
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dataKey, dataVal] of Object.entries(value)) {
        if (dataVal != null) node.dataset[dataKey] = String(dataVal);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value' && 'value' in node) {
      // Set as a property so a live <input> is not clobbered on re-render.
      node.value = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/** Append children, skipping nullish/false so `cond && el(...)` reads cleanly. */
export function append(parent, children) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
  return parent;
}

/** Remove every child. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Replace a node's contents in one shot. Used for the many small regions that
 * are cheap to rebuild wholesale.
 */
export function setChildren(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

/** Set text without touching structure. Skips the write when unchanged. */
export function setText(node, text) {
  const next = text == null ? '' : String(text);
  if (node.textContent !== next) node.textContent = next;
  return node;
}

/** Toggle a class only when it actually changes, to avoid needless style recalcs. */
export function toggleClass(node, name, on) {
  if (node.classList.contains(name) !== Boolean(on)) node.classList.toggle(name, Boolean(on));
  return node;
}

/** Show/hide with the `hidden` attribute (which also removes it from the a11y tree). */
export function setHidden(node, hidden) {
  if (node.hidden !== Boolean(hidden)) node.hidden = Boolean(hidden);
  return node;
}

/** Set or remove an attribute, treating null/undefined/false as removal. */
export function setAttr(node, name, value) {
  if (value == null || value === false) node.removeAttribute(name);
  else if (value === true) node.setAttribute(name, '');
  else node.setAttribute(name, String(value));
  return node;
}

/**
 * A node that is hidden from sight but present for assistive technology.
 * Equivalent to the `.sr-only` class, built here so callers can clone it.
 */
export function srOnly(text) {
  return el('span', { class: 'sr-only', text });
}

/**
 * Give a focusable region a name without adding visible chrome — used for the
 * player grid and the vote tally.
 */
export function labelledBy(node, id) {
  node.setAttribute('aria-labelledby', id);
  return node;
}

/**
 * Build a `<button>` with the boilerplate the app always wants: a type, an
 * accessible label, and disabled state driven by the caller.
 */
export function button(label, { onClick, class: cls, disabled, ariaLabel, title, type = 'button' } = {}) {
  return el(
    'button',
    {
      class: cls,
      type,
      disabled: Boolean(disabled),
      'aria-label': ariaLabel,
      title,
      onClick,
    },
    label
  );
}

/**
 * The 3D flip card used for role reveal.
 *
 * The accessibility story matters here: a face-down card must not put the role
 * in the DOM at all, or a screen reader would announce it before the player
 * chose to look. So the back face holds a neutral label and the role text is
 * only inserted when the card is turned.
 *
 * @param {object} opts
 * @param {string} opts.backLabel
 * @param {string} opts.frontLabel
 * @returns {{ root: HTMLElement, setRevealed: (on: boolean, frontText?: string) => void }}
 */
export function flipCard({ backLabel, frontLabel }) {
  const back = el('div', { class: 'flip__face flip__face--back' }, srOnly(backLabel));
  const front = el('div', { class: 'flip__face flip__face--front' });
  const inner = el('div', { class: 'flip__inner' }, back, front);
  const root = el('div', { class: 'flip', role: 'img', 'aria-label': backLabel }, inner);

  let revealed = false;

  return {
    root,
    setRevealed(on, frontText = '') {
      if (on === revealed && !on) return;
      revealed = on;
      root.classList.toggle('is-revealed', on);
      root.setAttribute('aria-label', on ? frontLabel : backLabel);
      // Only now does the role text enter the document.
      setChildren(front, on ? frontText : '');
    },
    isRevealed: () => revealed,
  };
}

/**
 * A countdown ring. The circle's dash offset is written as a CSS custom
 * property so all the animation lives in the stylesheet, where
 * `prefers-reduced-motion` can switch it off in one place.
 */
export function countdownRing() {
  const NS = 'http://www.w3.org/2000/svg';
  const R = 16;
  const CIRC = 2 * Math.PI * R;

  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', '20');
  track.setAttribute('cy', '20');
  track.setAttribute('r', String(R));
  track.setAttribute('class', 'ring__track');

  const value = document.createElementNS(NS, 'circle');
  value.setAttribute('cx', '20');
  value.setAttribute('cy', '20');
  value.setAttribute('r', String(R));
  value.setAttribute('class', 'ring__value');
  value.setAttribute('stroke-dasharray', String(CIRC));

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(track);
  svg.appendChild(value);

  const label = el('span', { class: 'ring__label' });
  const root = el('div', { class: 'ring-wrap' }, svg, label);

  return {
    root,
    /**
     * @param {number|null} remainingMs
     * @param {number} durationMs
     * @param {string} text
     */
    update(remainingMs, durationMs, text) {
      if (remainingMs == null) {
        root.hidden = true;
        return;
      }
      root.hidden = false;
      const frac = durationMs > 0 ? Math.max(0, Math.min(1, remainingMs / durationMs)) : 0;
      value.setAttribute('stroke-dashoffset', String(CIRC * (1 - frac)));
      root.classList.toggle('is-urgent', remainingMs <= 10000);
      setText(label, text);
    },
  };
}
