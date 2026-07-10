/**
 * PagePilot
 * A dependency-free visualization layer for automated page operations.
 * It does NOT decide what to click — it only animates a virtual cursor to a
 * target, plays a click/input feedback effect, then lets your own executor
 * (your own selectors, your own controller, whatever drives the automation)
 * perform the real DOM action. Every operation is queued so animations never
 * overlap.
 *
 * Supported controls:
 *   - buttons/links          click(target)
 *   - text inputs/textareas/contenteditable  type(target, text)
 *   - native <select>        select(target, value | valueArray)
 *   - checkbox/radio/switch  check(target, checked)
 *   - custom div/li dropdown chooseOption(trigger, option)
 *   - page/container scroll  scroll(target, { amount | to })
 *   - keyboard              pressKey(target, key, { modifiers })
 *   - hover / unhover        hover(target), unhover()
 *   - drag and drop          dragTo(source, target)
 *   - wait for async content waitFor(target, { timeout, interval, visible })
 *   - abort mid-sequence     stop()
 *
 * Known limits:
 *   - Native <select> renders its open option list via the OS/browser, not
 *     the DOM, so only the click on the select box itself can be animated.
 *   - File inputs (<input type="file">) cannot be set programmatically for
 *     security reasons in any browser — out of scope for any DOM-based tool.
 *   - Native <input type="date">/color pickers have browser-drawn popups,
 *     same limitation as <select>; set .value + dispatch 'change' via step().
 *   - dragTo() covers mouse-event-based drag implementations (most sortable
 *     lists, sliders, custom drag widgets) — it does not drive native HTML5
 *     drag-and-drop (draggable="true" + DataTransfer), which needs a trusted
 *     user gesture in most browsers.
 *   - pressKey() dispatches real KeyboardEvents that any keydown/keyup
 *     listener will see, but — like click() — it won't trigger a browser's
 *     own built-in default action for a key (e.g. Enter alone won't
 *     auto-submit a form unless the page's JS explicitly does that itself).
 *   - Canvas-based widgets aren't covered directly; use step() to write
 *     custom logic while still getting the cursor animation for free.
 *
 * Every acted-on element also gets a highlight border (a separate overlay
 * box, not the element's own outline). By default it PERSISTS — it does not
 * fade out on its own — so it's obvious afterwards which elements the agent
 * touched. Clear it explicitly with clearHighlight(target) / clearHighlights(),
 * or set highlightDuration to a number (ms) to have it auto-fade instead.
 * Set highlightEnabled: false to turn highlighting off entirely.
 *
 * Set showCursorDot: false to skip the moving cursor dot entirely and keep
 * only the ripple/highlight feedback on each target. Otherwise, run() hides
 * the dot automatically once the whole sequence finishes — call
 * hideCursor()/showCursor() yourself if you're calling individual methods
 * instead of run().
 *
 * scroll() only highlights the scrolled container by default (no separate
 * indicator). Set showScrollIndicator: true to also show a small arrow badge
 * at the bottom of the screen while a scroll animation is in progress.
 *
 * Set showPageGlow: true to pulse a colored border around the entire
 * viewport for as long as any step is running — a "the system is driving
 * this, not you" tell for the person watching. Off by default. Configure
 * its color via pageGlowColor (defaults to `color`) and thickness via
 * pageGlowWidth. Set pageGlowTarget to an element/selector to wrap the glow
 * tightly around that container instead of the whole page — it stays
 * aligned to it across scroll/resize. pageGlowRadius (default 0) rounds its
 * corners, useful when wrapping a container that itself has rounded corners.
 *
 * Whenever the glow is showing, a transparent overlay also blocks real mouse
 * input within that same area (blockInteraction, on by default) — so the
 * person watching can't click/interact while automation is driving things,
 * only while the glow is lit. Set blockInteraction: false to let real input
 * through even while the glow is showing. If something inside the glow-
 * covered area needs to stay clickable regardless (e.g. a Stop button that
 * happens to sit inside it), list its selector(s) in pointerBlockAllowlist.
 * Set pageGlowMessage to a string to show a small status label pinned to
 * the top of the glow area (e.g. "Automation running — please wait…"); it's
 * hidden by default, and disappears together with the glow.
 *
 * Usage:
 *   import { PagePilot } from './page-pilot.js'
 *   const cursor = new PagePilot({ onExecuteClick: el => el.click() })
 *   await cursor.click(document.querySelector('#submit'))
 *   await cursor.type(document.querySelector('#name'), 'Acme Corp')
 *   await cursor.select(document.querySelector('#country'), 'US')
 *   await cursor.check(document.querySelector('#agree'), true)
 *   await cursor.chooseOption('#menu-trigger', '.menu-item[data-value="pro"]')
 *   await cursor.scroll(null, { amount: 600 })       // scroll window down 600px
 *   await cursor.scroll('#panel', { to: 'bottom' })  // scroll a container to its bottom
 *   await cursor.pressKey('#search', 'Enter')
 *   await cursor.hover('#info-icon'); await cursor.unhover()
 *   await cursor.dragTo('#item-1', '#drop-zone')
 *   await cursor.waitFor('#async-result', { timeout: 8000 })
 *   cursor.clearHighlight('#name')                   // remove one persisted highlight
 *   cursor.clearHighlights()                         // remove all of them
 *   cursor.stop()                                    // abort whatever is running right now
 *   cursor.destroy()
 */

/**
 * Thrown internally when stop() aborts a step in progress. run() catches
 * this and resolves quietly instead of rejecting; if you call individual
 * methods (click/type/etc.) directly instead of run(), you'll see this
 * rejection yourself — check `err instanceof PagePilotStopped` if you
 * want to distinguish "the user hit stop" from an actual failure.
 */
export class PagePilotStopped extends Error {
  constructor() {
    super('PagePilot: aborted by stop()');
    this.name = 'PagePilotStopped';
  }
}

/**
 * Set an <input>/<textarea>/<select>'s value via its native property setter
 * rather than plain assignment. React (and some other frameworks) patch a
 * "value tracker" onto these elements for controlled components; assigning
 * el.value = x directly leaves the tracker's old value in place, so React's
 * change-detection thinks nothing changed and skips onChange even after you
 * dispatch an 'input'/'change' event. Going through the native setter avoids
 * that tracker entirely.
 */
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : el.tagName === 'SELECT'
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** keyCode/which values for the non-printable keys people actually press. */
const KEY_CODES = {
  Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
};

function keyCodeFor(key) {
  if (key in KEY_CODES) return KEY_CODES[key];
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

const DEFAULTS = {
  color: '#378ADD',
  size: 16,
  moveDuration: 480,
  clickPause: 260,
  typeDelay: 45,
  respectReducedMotion: true,
  zIndex: 999999,
  onExecuteClick: (el) => el.click(),
  onExecuteInput: (el, text) => {
    const editableAttr = el.getAttribute?.('contenteditable');
    const isEditable = el.isContentEditable || editableAttr === 'true' || editableAttr === '';
    if (isEditable) {
      // contenteditable div (rich-text editors, some custom input components)
      // has no .value — set textContent directly instead.
      el.textContent = text;
      // Place the caret at the end so it behaves like a real typed input.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    setNativeValue(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  onExecuteKey: (el, key, modifiers = {}) => {
    const eventInit = {
      key,
      keyCode: keyCodeFor(key),
      which: keyCodeFor(key),
      bubbles: true,
      cancelable: true,
      ctrlKey: !!modifiers.ctrl,
      shiftKey: !!modifiers.shift,
      altKey: !!modifiers.alt,
      metaKey: !!modifiers.meta,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  },
  onExecuteHover: (el, entering) => {
    if (entering) {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
      }
    } else {
      el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      if (typeof PointerEvent === 'function') {
        el.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
      }
    }
  },
  onExecuteDragStart: (el, pos) => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: pos.x, clientY: pos.y, button: 0 }));
  },
  onExecuteDragMove: (el, pos) => {
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: pos.x, clientY: pos.y }));
  },
  onExecuteDragEnd: (el, pos) => {
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: pos.x, clientY: pos.y }));
  },
  scrollSettleTimeout: 1200,
  showCursorDot: true,
  showScrollIndicator: false,
  showPageGlow: false,
  pageGlowColor: null, // defaults to opts.color if not set
  pageGlowWidth: 4,
  pageGlowTarget: null, // element/selector to wrap instead of the full viewport
  pageGlowRadius: 0,
  blockInteraction: true, // block real pointer input inside the glow area while it's showing
  pageGlowMessage: null, // small status label pinned to the top of the glow area; null = hidden
  pointerBlockAllowlist: [], // selectors that stay clickable even while blocked (e.g. a Stop button)
  highlightEnabled: true,
  highlightColor: null, // defaults to opts.color if not set
  highlightDuration: null, // null/0 = persists until manually cleared; number (ms) = auto-fade
  onBeforeStep: null, // (step) => void
  onAfterStep: null, // (step) => void
};

export class PagePilot {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    if (!this.opts.highlightColor) this.opts.highlightColor = this.opts.color;
    if (!this.opts.pageGlowColor) this.opts.pageGlowColor = this.opts.color;
    this.queue = Promise.resolve();
    this.reduced = this.opts.respectReducedMotion &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this._highlights = new Map(); // element -> overlay box element
    this._repositionScheduled = false;
    this._activeCount = 0; // how many queued steps are currently running (drives the page glow)
    this._glowHideTimer = null;
    this._generation = 0; // bumped by stop() to invalidate any steps already queued
    this._pendingRejects = new Set(); // abort callbacks for in-flight waits, cleared/fired by stop()
    this._onWindowChange = () => this._scheduleReposition();
    window.addEventListener('scroll', this._onWindowChange, { passive: true, capture: true });
    window.addEventListener('resize', this._onWindowChange, { passive: true });
    if (this.opts.showCursorDot) this._buildCursorEl();
  }

  _buildCursorEl() {
    const el = document.createElement('div');
    const s = this.opts.size;
    el.style.cssText = `
      position: fixed;
      width: ${s}px; height: ${s}px;
      border-radius: 50%;
      background: ${this.opts.color};
      opacity: 0.85;
      pointer-events: none;
      z-index: ${this.opts.zIndex};
      transform: translate(-50%, -50%);
      transition: left ${this.opts.moveDuration}ms cubic-bezier(.2,.8,.2,1),
                  top ${this.opts.moveDuration}ms cubic-bezier(.2,.8,.2,1);
      display: none;
    `;
    document.body.appendChild(el);
    this.cursorEl = el;
  }

  /**
   * Build the full-viewport glow border, lazily, the first time it's needed.
   * A pulsing colored border around the whole page — the "the system is
   * driving this, not you" tell. Gated behind opts.showPageGlow (off by
   * default); shown automatically for as long as any queued step is running.
   */
  _buildGlowEl() {
    if (!document.getElementById('page-pilot-glow-style')) {
      const style = document.createElement('style');
      style.id = 'page-pilot-glow-style';
      style.textContent = '@keyframes page-pilot-glow-pulse{0%,100%{opacity:.55}50%{opacity:1}}';
      document.head.appendChild(style);
    }
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      border: ${this.opts.pageGlowWidth}px solid ${this.opts.pageGlowColor};
      border-radius: ${this.opts.pageGlowRadius}px;
      box-shadow: inset 0 0 ${this.opts.pageGlowWidth * 6}px ${this.opts.pageGlowColor};
      pointer-events: none;
      box-sizing: border-box;
      z-index: ${this.opts.zIndex - 2};
      opacity: 0;
      transition: opacity 250ms ease-out, left 150ms ease-out, top 150ms ease-out,
                  width 150ms ease-out, height 150ms ease-out;
    `;
    document.body.appendChild(el);
    this._glowEl = el;
    this._positionGlowEl();
  }

  /**
   * A transparent overlay matching the glow area that intercepts real mouse
   * input while it's active — so the person watching can't click/interact
   * inside the glowing area while automation is driving it. Gated behind
   * opts.blockInteraction (on by default whenever showPageGlow is on).
   *
   * Elements matching opts.pointerBlockAllowlist (e.g. a Stop button that
   * happens to sit inside the glow-covered container) stay clickable: on
   * pointerdown we hide the overlay just long enough to hit-test what's
   * underneath, and if it matches the allowlist we leave it hidden so the
   * real click reaches the real element, restoring the block shortly after.
   */
  _buildBlockerEl() {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      background: transparent;
      cursor: not-allowed;
      border-radius: ${this.opts.pageGlowRadius}px;
      pointer-events: none;
      z-index: ${this.opts.zIndex - 2};
      opacity: 0;
      transition: opacity 250ms ease-out, left 150ms ease-out, top 150ms ease-out,
                  width 150ms ease-out, height 150ms ease-out;
    `;
    el.addEventListener('pointerdown', (e) => {
      if (!this.opts.pointerBlockAllowlist?.length) return;
      el.style.pointerEvents = 'none';
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const allowed = this.opts.pointerBlockAllowlist.some(
        (sel) => under && under.closest && under.closest(sel)
      );
      if (allowed) {
        // Leave it click-through for this interaction (covers click/dblclick),
        // then restore blocking shortly after.
        clearTimeout(this._blockerAllowTimer);
        this._blockerAllowTimer = setTimeout(() => {
          if (this.opts.blockInteraction && this._glowEl?.style.opacity !== '0') {
            el.style.pointerEvents = 'auto';
          }
        }, 250);
      } else {
        el.style.pointerEvents = 'auto';
      }
    });
    document.body.appendChild(el);
    this._blockerEl = el;
  }

  /** The small status label pinned to the top of the glow area, shown only if opts.pageGlowMessage is set. */
  _buildMessageEl() {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      transform: translateX(-50%);
      background: rgba(17, 17, 17, 0.85);
      color: #fff;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 5px 12px;
      border-radius: 999px;
      white-space: nowrap;
      pointer-events: none;
      z-index: ${this.opts.zIndex};
      opacity: 0;
      transition: opacity 200ms ease-out, left 150ms ease-out, top 150ms ease-out;
    `;
    document.body.appendChild(el);
    this._messageEl = el;
  }

  /** Resolve opts.pageGlowTarget defensively — if it's set but doesn't match
   * anything (e.g. removed from the DOM), fall back to the full viewport
   * rather than throwing and breaking whatever step triggered this. */
  _resolveGlowTarget() {
    if (!this.opts.pageGlowTarget) return null;
    try {
      return this._resolve(this.opts.pageGlowTarget);
    } catch {
      return null;
    }
  }

  /** The effective area the glow/blocker/message all share: the target
   * container's current rect, or the full viewport if none is set. */
  _currentGlowRect() {
    const targetEl = this._resolveGlowTarget();
    if (targetEl) return targetEl.getBoundingClientRect();
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  /** Size/position the glow border, the interaction blocker, and the status
   * message together — full viewport by default, or wrapped tightly around
   * opts.pageGlowTarget's current rect if one is set. */
  _positionGlowEl() {
    if (!this._glowEl) return;
    const rect = this._currentGlowRect();

    this._glowEl.style.left = rect.left + 'px';
    this._glowEl.style.top = rect.top + 'px';
    this._glowEl.style.width = rect.width + 'px';
    this._glowEl.style.height = rect.height + 'px';

    if (this._blockerEl) {
      this._blockerEl.style.left = rect.left + 'px';
      this._blockerEl.style.top = rect.top + 'px';
      this._blockerEl.style.width = rect.width + 'px';
      this._blockerEl.style.height = rect.height + 'px';
    }
    if (this._messageEl) {
      this._messageEl.style.left = (rect.left + rect.width / 2) + 'px';
      this._messageEl.style.top = (rect.top + 10) + 'px';
    }
  }

  _showPageGlow() {
    if (!this.opts.showPageGlow) return;
    if (!this._glowEl) this._buildGlowEl();
    if (this.opts.blockInteraction && !this._blockerEl) this._buildBlockerEl();
    if (this.opts.pageGlowMessage && !this._messageEl) this._buildMessageEl();
    this._positionGlowEl(); // target may have moved/resized since it was last shown

    if (this._glowHideTimer) { clearTimeout(this._glowHideTimer); this._glowHideTimer = null; }

    this._glowEl.style.opacity = '1';
    this._glowEl.style.animation = this.reduced ? 'none' : 'page-pilot-glow-pulse 1.4s ease-in-out infinite';

    if (this._blockerEl && this.opts.blockInteraction) {
      this._blockerEl.style.pointerEvents = 'auto';
      this._blockerEl.style.opacity = '1';
    }
    if (this._messageEl && this.opts.pageGlowMessage) {
      this._messageEl.textContent = this.opts.pageGlowMessage;
      this._messageEl.style.opacity = '1';
    }
  }

  /** Debounced so the glow (and blocker/message) stay lit continuously
   * across back-to-back steps in the same run() instead of flickering off
   * between each one. */
  _hidePageGlowSoon() {
    if (!this.opts.showPageGlow || !this._glowEl) return;
    this._glowHideTimer = setTimeout(() => {
      this._glowEl.style.opacity = '0';
      this._glowEl.style.animation = 'none';
      if (this._blockerEl) {
        this._blockerEl.style.pointerEvents = 'none';
        this._blockerEl.style.opacity = '0';
      }
      if (this._messageEl) this._messageEl.style.opacity = '0';
      this._glowHideTimer = null;
    }, 200);
  }

  /**
   * getBoundingClientRect() is relative to the element's OWN window's
   * viewport — for an element inside a same-origin iframe, that's the
   * iframe's viewport, not the top page's. The cursor dot, ripples, and
   * highlight boxes all live in the TOP document (position: fixed there),
   * so their coordinates need to be in top-level-viewport terms. This walks
   * up through any iframe ancestors (win.frameElement), accumulating each
   * iframe's own offset within ITS parent's viewport, to get there.
   */
  _topLevelRect(el) {
    const rect = el.getBoundingClientRect();
    let win = (el.ownerDocument || document).defaultView;
    let offsetX = 0;
    let offsetY = 0;
    while (win && win !== window && win.frameElement) {
      const frameRect = win.frameElement.getBoundingClientRect();
      offsetX += frameRect.left;
      offsetY += frameRect.top;
      win = win.parent;
    }
    return {
      top: rect.top + offsetY,
      left: rect.left + offsetX,
      right: rect.right + offsetX,
      bottom: rect.bottom + offsetY,
      width: rect.width,
      height: rect.height,
    };
  }

  _center(el) {
    const rect = this._topLevelRect(el);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  _ripple(x, y) {
    const r = document.createElement('div');
    r.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px;
      width: 8px; height: 8px;
      border: 2px solid ${this.opts.color};
      border-radius: 50%;
      transform: translate(-50%, -50%);
      pointer-events: none;
      z-index: ${this.opts.zIndex};
      opacity: 0.9;
      transition: width .45s ease-out, height .45s ease-out, opacity .45s ease-out;
    `;
    document.body.appendChild(r);
    requestAnimationFrame(() => {
      r.style.width = '40px';
      r.style.height = '40px';
      r.style.opacity = '0';
    });
    setTimeout(() => r.remove(), 480);
  }

  /**
   * Draw a highlight border around an element that was just acted on. Uses a
   * separate overlay box (not the element's own outline/border) so it works
   * identically on inputs, selects, checkboxes, custom divs, whatever —
   * without touching the target's own styles or layout. By default this
   * PERSISTS on screen until clearHighlight()/clearHighlights() is called,
   * or opts.highlightDuration is set to a number of ms for auto-fade.
   * Re-highlighting the same element replaces its existing box rather than
   * stacking a new one on top.
   *
   * `fallbackRect` is used when the element's own action (e.g. selecting a
   * custom-dropdown option) closes/hides its container as a side effect —
   * without it, getBoundingClientRect() on a now-hidden element returns a
   * degenerate 0x0 rect at (0, 0), which would draw the box in the top-left
   * corner of the page instead of skipping or using the last known position.
   */
  _highlight(el, fallbackRect) {
    if (!this.opts.highlightEnabled || !el || !el.getBoundingClientRect) return;
    this._removeHighlightBox(el);

    let rect = this._topLevelRect(el);
    if (rect.width === 0 && rect.height === 0 && fallbackRect) rect = fallbackRect;
    if (rect.width === 0 && rect.height === 0) return; // nothing visible to draw around

    const box = document.createElement('div');
    box.style.cssText = `
      position: fixed;
      left: ${rect.left - 3}px; top: ${rect.top - 3}px;
      width: ${rect.width + 6}px; height: ${rect.height + 6}px;
      border: 2px solid ${this.opts.highlightColor};
      border-radius: 6px;
      box-sizing: border-box;
      pointer-events: none;
      z-index: ${this.opts.zIndex - 1};
      opacity: 0;
      transition: opacity 150ms ease-out;
    `;
    document.body.appendChild(box);
    requestAnimationFrame(() => { box.style.opacity = '1'; });
    this._highlights.set(el, box);

    const duration = this.opts.highlightDuration;
    if (!this.reduced && typeof duration === 'number' && duration > 0) {
      setTimeout(() => this._removeHighlightBox(el), duration);
    }
  }

  _removeHighlightBox(el) {
    const box = this._highlights.get(el);
    if (!box) return;
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 200);
    this._highlights.delete(el);
  }

  /** Remove the highlight from one element (selector or Element), if present. */
  clearHighlight(target) {
    const el = this._resolve(target);
    this._removeHighlightBox(el);
  }

  /** Remove every active highlight box currently on screen. */
  clearHighlights() {
    for (const el of Array.from(this._highlights.keys())) this._removeHighlightBox(el);
  }

  /** Keep persistent highlight boxes — and a container-targeted page glow — aligned with their elements on scroll/resize. */
  _scheduleReposition() {
    const glowNeedsTracking = this._glowEl && this._glowEl.style.opacity !== '0';
    if (this._repositionScheduled || (this._highlights.size === 0 && !glowNeedsTracking)) return;
    this._repositionScheduled = true;
    requestAnimationFrame(() => {
      for (const [el, box] of this._highlights) {
        if (!el.isConnected) { this._removeHighlightBox(el); continue; }
        const rect = this._topLevelRect(el);
        if (rect.width === 0 && rect.height === 0) {
          // Element (or an ancestor) is hidden right now — hide the box
          // rather than snapping it to (0, 0), but keep tracking it in case
          // it becomes visible again later (e.g. a dropdown reopened).
          box.style.opacity = '0';
          continue;
        }
        box.style.left = (rect.left - 3) + 'px';
        box.style.top = (rect.top - 3) + 'px';
        box.style.width = (rect.width + 6) + 'px';
        box.style.height = (rect.height + 6) + 'px';
        box.style.opacity = '1';
      }
      if (glowNeedsTracking) this._positionGlowEl();
      this._repositionScheduled = false;
    });
  }

  async _ensureVisible(el) {
    const rect = this._topLevelRect(el);
    const inView = rect.top >= 0 && rect.bottom <= window.innerHeight &&
      rect.left >= 0 && rect.right <= window.innerWidth;
    if (!inView) {
      el.scrollIntoView({ behavior: this.reduced ? 'auto' : 'smooth', block: 'center' });
      await this._wait(this.reduced ? 0 : 350);
    }
  }

  _showScrollIndicator(direction) {
    const el = document.createElement('div');
    const arrow = direction === 'up' ? '&#9650;' : '&#9660;';
    el.innerHTML = arrow;
    el.style.cssText = `
      position: fixed;
      left: 50%; bottom: 24px;
      transform: translateX(-50%);
      width: 28px; height: 28px;
      border-radius: 50%;
      background: ${this.opts.color};
      color: #fff;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px;
      pointer-events: none;
      z-index: ${this.opts.zIndex};
      opacity: 0;
      transition: opacity 150ms ease-out;
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = '0.9'; });
    this._scrollIndicatorEl = el;
  }

  _hideScrollIndicator() {
    const el = this._scrollIndicatorEl;
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
    this._scrollIndicatorEl = null;
  }

  /** Poll scroll position until it stops changing, or a timeout is hit. Abortable by stop(). */
  _waitForScrollSettle(scrollable) {
    return new Promise((resolve, reject) => {
      let lastTop = scrollable === window ? window.scrollY : scrollable.scrollTop;
      let stableFrames = 0;
      const start = performance.now();
      let rafId;
      const abort = () => { cancelAnimationFrame(rafId); reject(new PagePilotStopped()); };
      this._pendingRejects.add(abort);
      const tick = () => {
        const top = scrollable === window ? window.scrollY : scrollable.scrollTop;
        const elapsed = performance.now() - start;
        if (top === lastTop) stableFrames += 1;
        else stableFrames = 0;
        lastTop = top;
        if (stableFrames > 4 || elapsed > this.opts.scrollSettleTimeout) {
          this._pendingRejects.delete(abort);
          resolve();
        } else {
          rafId = requestAnimationFrame(tick);
        }
      };
      rafId = requestAnimationFrame(tick);
    });
  }

  async _moveTo(el) {
    await this._ensureVisible(el);
    const rect = this._topLevelRect(el);
    if (rect.width === 0 && rect.height === 0) {
      // The target is hidden (display:none, detached, or a zero-size ancestor)
      // right now — most likely a menu/dropdown whose open state doesn't
      // match what the caller expected. Moving to (0, 0) would be worse than
      // doing nothing, so keep the cursor at its last known position.
      console.warn('[PagePilot] target has zero size (likely hidden) — cursor not moved:', el);
      return this._lastPos || { x: 0, y: 0 };
    }
    const { x, y } = this._center(el);
    if (this.cursorEl) {
      this.cursorEl.style.display = 'block';
      this.cursorEl.style.left = x + 'px';
      this.cursorEl.style.top = y + 'px';
    }
    this._lastPos = { x, y };
    if (!this.reduced) await this._wait(this.opts.moveDuration + 20);
    return { x, y };
  }

  /** A setTimeout-based delay that stop() can cut short immediately. */
  _wait(ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRejects.delete(abort);
        resolve();
      }, ms);
      const abort = () => { clearTimeout(timer); reject(new PagePilotStopped()); };
      this._pendingRejects.add(abort);
    });
  }

  /** Queue an arbitrary async step so animations never overlap. */
  _enqueue(fn) {
    const myGen = this._generation;
    const run = async () => {
      if (myGen !== this._generation) return; // stop() fired before this step got its turn
      this._activeCount++;
      this._showPageGlow();
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof PagePilotStopped)) {
          console.error('[PagePilot] step failed:', err);
        }
        throw err;
      } finally {
        // Clamped at 0: stop() may have already force-reset this counter
        // while this step was still in flight, so a plain decrement could
        // drift negative and never hit 0 again — which would permanently
        // stop the page glow from ever hiding on future runs.
        this._activeCount = Math.max(0, this._activeCount - 1);
        if (this._activeCount === 0) this._hidePageGlowSoon();
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Resolve a target that may be an Element, a selector string, or {x, y}. */
  /** Resolve a target that may be an Element, a selector string, or
   * { selector, frame } for an element inside a same-origin iframe. `frame`
   * is an iframe selector (or an array of them, for nested iframes) — see
   * _resolveFrameDocument. */
  _resolve(target) {
    if (target && typeof target === 'object' && 'selector' in target) {
      const doc = this._resolveFrameDocument(target.frame);
      const el = doc.querySelector(target.selector);
      if (!el) {
        const where = target.frame ? ` inside frame "${JSON.stringify(target.frame)}"` : '';
        throw new Error(`PagePilot: no element matches "${target.selector}"${where}`);
      }
      return el;
    }
    if (typeof target === 'string') {
      const el = document.querySelector(target);
      if (!el) throw new Error(`PagePilot: no element matches "${target}"`);
      return el;
    }
    return target;
  }

  /** Walk through a chain of same-origin iframes (a selector, or an array of
   * them for nested iframes) and return the Document at the end of it. No
   * frame (null/undefined) just means the top document. */
  _resolveFrameDocument(frame) {
    if (!frame) return document;
    const chain = Array.isArray(frame) ? frame : [frame];
    let doc = document;
    for (const sel of chain) {
      const iframeEl = doc.querySelector(sel);
      if (!iframeEl) throw new Error(`PagePilot: no iframe matches "${sel}"`);
      let inner;
      try {
        inner = iframeEl.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) {
        throw new Error(`PagePilot: iframe "${sel}" has no accessible document (cross-origin, or not loaded yet)`);
      }
      doc = inner;
    }
    return doc;
  }

  /** Move the cursor to a target without clicking. */
  moveTo(target) {
    return this._enqueue(async () => {
      const el = this._resolve(target);
      await this._moveTo(el);
    });
  }

  /**
   * Scroll the page or a specific scrollable container.
   * options:
   *   - amount: number   scroll by N px (negative = up)
   *   - to: 'top'|'bottom'  scroll to an edge
   *   - label: string    passed to onBeforeStep/onAfterStep for logging
   * target: element/selector to use as the scroll container, or omit for window.
   */
  scroll(target, options = {}) {
    return this._enqueue(async () => {
      const container = target ? this._resolve(target) : null;
      const scrollable = container || document.scrollingElement || document.documentElement;
      const step = { type: 'scroll', target: container, label: options.label, options };
      this.opts.onBeforeStep?.(step);

      const startTop = container ? container.scrollTop : window.scrollY;
      let targetTop;
      if (options.to === 'top') targetTop = 0;
      else if (options.to === 'bottom') targetTop = scrollable.scrollHeight;
      else targetTop = startTop + (options.amount ?? 0);

      const direction = targetTop >= startTop ? 'down' : 'up';
      if (this.opts.showScrollIndicator) this._showScrollIndicator(direction);

      const behavior = this.reduced ? 'auto' : 'smooth';
      if (container) {
        if (typeof container.scrollTo === 'function') container.scrollTo({ top: targetTop, behavior });
        else container.scrollTop = targetTop; // fallback for environments without element.scrollTo
      } else {
        window.scrollTo({ top: targetTop, behavior });
      }

      if (!this.reduced) await this._waitForScrollSettle(container || window);
      if (this.opts.showScrollIndicator) this._hideScrollIndicator();
      if (container) this._highlight(container);
      this.opts.onAfterStep?.(step);
    });
  }

  /** Shared click animation + execution, reused by click() and chooseOption(). */
  async _animatedClick(el) {
    const { x, y } = await this._moveTo(el);
    const preClickRect = this._topLevelRect(el);
    this._ripple(x, y);
    const prevTransform = el.style.transform;
    el.style.transition = el.style.transition || 'transform 120ms ease-out';
    el.style.transform = 'scale(0.96)';
    setTimeout(() => { el.style.transform = prevTransform; }, 120);
    this.opts.onExecuteClick(el);
    this._highlight(el, preClickRect);
    await this._wait(this.opts.clickPause);
  }

  /** Animate a click on the target, then execute the real click. */
  click(target, label) {
    return this._enqueue(async () => {
      const el = this._resolve(target);
      const step = { type: 'click', target: el, label };
      this.opts.onBeforeStep?.(step);
      await this._animatedClick(el);
      this.opts.onAfterStep?.(step);
    });
  }

  /** Animate typing into a text input / textarea / contenteditable. */
  type(target, text, label) {
    return this._enqueue(async () => {
      const el = this._resolve(target);
      const step = { type: 'type', target: el, label, text };
      this.opts.onBeforeStep?.(step);
      await this._moveTo(el);
      el.focus();
      if (this.reduced) {
        this.opts.onExecuteInput(el, text);
      } else {
        let acc = '';
        for (const ch of text) {
          acc += ch;
          this.opts.onExecuteInput(el, acc);
          await this._wait(this.opts.typeDelay);
        }
      }
      this._highlight(el);
      this.opts.onAfterStep?.(step);
    });
  }

  /**
   * Choose a value in a native <select>. Sets .value (or selects matching
   * <option> for multi-select arrays) and dispatches 'change'.
   * Note: a native <select>'s open dropdown list is rendered by the OS/browser,
   * not the DOM, so there is no way to animate the option list itself — only
   * the click on the select box is shown.
   */
  select(target, value, label) {
    return this._enqueue(async () => {
      const el = this._resolve(target);
      const step = { type: 'select', target: el, label, value };
      this.opts.onBeforeStep?.(step);
      await this._moveTo(el);
      this._ripple(...Object.values(this._center(el)));
      if (Array.isArray(value)) {
        // multi-select: mark matching <option> elements as selected
        for (const opt of el.options) {
          opt.selected = value.includes(opt.value);
        }
      } else {
        setNativeValue(el, value);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      this._highlight(el);
      await this._wait(this.opts.clickPause);
      this.opts.onAfterStep?.(step);
    });
  }

  /**
   * Set a checkbox/radio (or a custom ARIA switch) to a specific checked
   * state — only clicks if the current state differs, since clicking an
   * already-checked radio/switch is a no-op anyway but would be misleading
   * to animate.
   *
   * Works on:
   *   - native <input type="checkbox"> / <input type="radio">, via .checked
   *   - custom toggle-switch components with no real <input> underneath,
   *     identified by role="switch" or an aria-checked attribute, via
   *     aria-checked="true"/"false" (the common pattern for hand-built or
   *     div-based Switch components)
   */
  check(target, checked = true, label) {
    return this._enqueue(async () => {
      const el = this._resolve(target);
      const step = { type: 'check', target: el, label, checked };
      this.opts.onBeforeStep?.(step);

      const isAriaSwitch = el.getAttribute('role') === 'switch' || el.hasAttribute('aria-checked');
      const currentState = isAriaSwitch ? el.getAttribute('aria-checked') === 'true' : el.checked;

      if (currentState !== checked) {
        await this._animatedClick(el);
      } else {
        await this._moveTo(el);
        this._highlight(el);
      }
      this.opts.onAfterStep?.(step);
    });
  }

  /**
   * Open a custom (non-native) dropdown/menu and click an option inside it.
   * Use this for div/li-based menus where the option only exists in the DOM
   * after the trigger is opened — pass `option` as a selector string and it
   * will be queried fresh after the menu opens, or a function returning an
   * element/selector, or an element you already have a reference to.
   *
   * options.waitAfterOpen: ms to wait for the menu's open animation (default 200)
   */
  chooseOption(trigger, option, options = {}) {
    return this._enqueue(async () => {
      const triggerEl = this._resolve(trigger);
      const step = { type: 'chooseOption', target: triggerEl, label: options.label };
      this.opts.onBeforeStep?.(step);

      await this._animatedClick(triggerEl);
      await this._wait(options.waitAfterOpen ?? 200);

      let optionEl;
      if (typeof option === 'function') {
        optionEl = await option();
      } else {
        optionEl = this._resolve(option);
      }
      if (!optionEl) {
        throw new Error('PagePilot: chooseOption could not resolve the option element');
      }
      await this._animatedClick(optionEl);
      this.opts.onAfterStep?.(step);
    });
  }

  /**
   * Send a key press to a target (or to whatever currently has focus, if
   * target is omitted). Dispatches real keydown/keyup KeyboardEvents, so it
   * reaches any keydown/keyup listener bound to the element or its ancestors.
   *
   * Common keys: 'Enter', 'Escape', 'Tab', 'ArrowUp'/'ArrowDown'/'ArrowLeft'/
   * 'ArrowRight', 'Backspace', 'Delete', ' ' (space), 'Home', 'End', or any
   * single printable character (e.g. 'a').
   *
   * options.modifiers: { ctrl, shift, alt, meta } — all optional booleans.
   *
   * Known limit: this dispatches synthetic events, so it reaches JS
   * listeners correctly, but it does NOT trigger a browser's built-in
   * default action for a key (e.g. pressing Enter alone won't auto-submit a
   * <form> the way a real keypress would unless the page's own JS listens
   * for Enter and submits explicitly) — the same synthetic-event caveat that
   * applies to click().
   */
  pressKey(target, key, options = {}) {
    return this._enqueue(async () => {
      const el = target ? this._resolve(target) : (document.activeElement || document.body);
      const step = { type: 'pressKey', target: el, label: options.label, key };
      this.opts.onBeforeStep?.(step);
      if (target) await this._moveTo(el);
      if (typeof el.focus === 'function') el.focus();
      this.opts.onExecuteKey(el, key, options.modifiers || {});
      this._highlight(el);
      await this._wait(this.opts.clickPause);
      this.opts.onAfterStep?.(step);
    });
  }

  /**
   * Move the cursor to a target and dispatch hover events (mouseenter/
   * mouseover, plus pointerenter where supported) — for tooltips, hover-
   * triggered menus, or any :hover-driven CSS/JS. If something else is
   * already "hovered" from a previous hover() call, its mouseleave/mouseout
   * fire first. Call unhover() to explicitly leave the current target
   * without hovering a new one.
   */
  hover(target, label) {
    return this._enqueue(async () => {
      const el = this._resolve(target);
      const step = { type: 'hover', target: el, label };
      this.opts.onBeforeStep?.(step);
      await this._moveTo(el);
      if (this._hoveredEl && this._hoveredEl !== el) {
        this.opts.onExecuteHover(this._hoveredEl, false);
      }
      this.opts.onExecuteHover(el, true);
      this._hoveredEl = el;
      this._highlight(el);
      await this._wait(this.opts.clickPause);
      this.opts.onAfterStep?.(step);
    });
  }

  /** Leave whatever element is currently "hovered" via hover(), if any. */
  unhover(label) {
    return this._enqueue(async () => {
      if (this._hoveredEl) {
        const step = { type: 'unhover', target: this._hoveredEl, label };
        this.opts.onBeforeStep?.(step);
        this.opts.onExecuteHover(this._hoveredEl, false);
        this._hoveredEl = null;
        this.opts.onAfterStep?.(step);
      }
    });
  }

  /**
   * Drag from a source element to a target element (or a plain {x, y}
   * point), animating the cursor smoothly between them and dispatching a
   * mousedown → a series of mousemove → mouseup sequence — the pattern most
   * JS-driven sortable lists, sliders, and custom drag interactions listen
   * for. options.steps controls animation smoothness (default 12),
   * options.duration the total ms for the move (default 400).
   *
   * Known limit: this does NOT drive native HTML5 drag-and-drop
   * (`<div draggable="true">` + dragstart/dragover/drop + DataTransfer) —
   * that flow requires a trusted user gesture in most browsers and can't be
   * reliably reproduced with synthetic events. It covers the much more
   * common case of mouse-event-based drag implementations.
   */
  dragTo(source, target, options = {}) {
    return this._enqueue(async () => {
      const sourceEl = this._resolve(source);
      const isPoint = target && typeof target === 'object' && 'x' in target && 'y' in target;
      const targetEl = isPoint ? null : this._resolve(target);
      const step = { type: 'dragTo', target: sourceEl, label: options.label };
      this.opts.onBeforeStep?.(step);

      const startPos = await this._moveTo(sourceEl);
      const endPos = isPoint ? target : this._center(targetEl);

      this.opts.onExecuteDragStart(sourceEl, startPos);

      const steps = options.steps ?? 12;
      const stepDuration = Math.max(8, (options.duration ?? 400) / steps);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = startPos.x + (endPos.x - startPos.x) * t;
        const y = startPos.y + (endPos.y - startPos.y) * t;
        if (this.cursorEl) {
          this.cursorEl.style.left = x + 'px';
          this.cursorEl.style.top = y + 'px';
        }
        this.opts.onExecuteDragMove(sourceEl, { x, y });
        await this._wait(stepDuration);
      }

      this.opts.onExecuteDragEnd(sourceEl, endPos);
      this._highlight(sourceEl);
      if (targetEl) this._highlight(targetEl);
      await this._wait(this.opts.clickPause);
      this.opts.onAfterStep?.(step);
    });
  }

  /**
   * Wait for a selector to match a visible element (or for a predicate
   * function to return a truthy element) before continuing — for content
   * that loads or renders asynchronously, instead of guessing a fixed delay.
   * Resolves with the found element. Rejects with a plain Error on timeout,
   * or with PagePilotStopped if stop() is called while waiting.
   *
   * target: a selector string, or a function returning an element (or null)
   * options.timeout: ms before giving up (default 5000)
   * options.interval: ms between checks (default 100)
   * options.visible: also require a non-zero bounding rect (default true) —
   *   set false to accept elements that exist but are currently hidden
   */
  waitFor(target, options = {}) {
    return this._enqueue(async () => {
      const timeout = options.timeout ?? 5000;
      const interval = options.interval ?? 100;
      const requireVisible = options.visible !== false;
      const step = { type: 'waitFor', target, label: options.label };
      this.opts.onBeforeStep?.(step);

      // Support target as a function, a plain selector string, or
      // { selector, frame } for polling inside a same-origin iframe.
      const isFrameTarget = target && typeof target === 'object' && 'selector' in target;
      const queryDoc = isFrameTarget ? this._resolveFrameDocument(target.frame) : document;
      const querySelector = isFrameTarget ? target.selector : target;

      const start = performance.now();
      const found = await new Promise((resolve, reject) => {
        let timer;
        const abort = () => { clearTimeout(timer); reject(new PagePilotStopped()); };
        this._pendingRejects.add(abort);
        const tick = () => {
          let el = null;
          try {
            el = typeof target === 'function' ? target() : queryDoc.querySelector(querySelector);
          } catch {
            el = null;
          }
          const visible = !requireVisible || (el && (() => {
            const r = el.getBoundingClientRect();
            return r.width > 0 || r.height > 0;
          })());
          if (el && visible) {
            this._pendingRejects.delete(abort);
            resolve(el);
            return;
          }
          if (performance.now() - start > timeout) {
            this._pendingRejects.delete(abort);
            const desc = typeof querySelector === 'string' ? `"${querySelector}"` : 'the given condition';
            reject(new Error(`PagePilot: waitFor timed out after ${timeout}ms waiting for ${desc}`));
            return;
          }
          timer = setTimeout(tick, interval);
        };
        tick();
      });
      this.opts.onAfterStep?.(step);
      return found;
    });
  }

  /** Run a fully custom step while still going through the queue/cursor. */
  step(target, action, label) {
    return this._enqueue(async () => {
      const el = target ? this._resolve(target) : null;
      const stepInfo = { type: 'custom', target: el, label };
      this.opts.onBeforeStep?.(stepInfo);
      if (el) await this._moveTo(el);
      await action(el);
      this.opts.onAfterStep?.(stepInfo);
    });
  }

  /** Run an ordered list of steps — see method docs above for each type's shape.
   * Automatically hides the cursor dot once every step finishes (call
   * showCursor() before the next run if you don't want that). If stop() is
   * called mid-sequence, this resolves quietly (does not throw) rather than
   * rejecting — check individual step methods directly if you need to know
   * a sequence was interrupted rather than completed. */
  async run(steps) {
    // If a recorded step happened inside a same-origin iframe (see
    // page-pilot-recorder's `frame` field), wrap its string selector(s) as
    // { selector, frame } so _resolve() looks in the right document. Only
    // strings get wrapped — an already-resolved Element or a raw {x,y}
    // point (dragTo's destination) pass through untouched.
    const withFrame = (val, frame) => (frame && typeof val === 'string') ? { selector: val, frame } : val;
    try {
      for (const s of steps) {
        if (s.type === 'click') await this.click(withFrame(s.target, s.frame), s.label);
        else if (s.type === 'type') await this.type(withFrame(s.target, s.frame), s.text, s.label);
        else if (s.type === 'move') await this.moveTo(withFrame(s.target, s.frame));
        else if (s.type === 'scroll') await this.scroll(withFrame(s.target, s.frame), s.options || {});
        else if (s.type === 'select') await this.select(withFrame(s.target, s.frame), s.value, s.label);
        else if (s.type === 'check') await this.check(withFrame(s.target, s.frame), s.checked, s.label);
        else if (s.type === 'chooseOption') await this.chooseOption(withFrame(s.target, s.frame), withFrame(s.option, s.frame), s.options || {});
        else if (s.type === 'pressKey') await this.pressKey(withFrame(s.target, s.frame), s.key, s.options || {});
        else if (s.type === 'hover') await this.hover(withFrame(s.target, s.frame), s.label);
        else if (s.type === 'unhover') await this.unhover(s.label);
        else if (s.type === 'dragTo') await this.dragTo(withFrame(s.target, s.frame), withFrame(s.destination, s.frame), s.options || {});
        else if (s.type === 'waitFor') await this.waitFor(withFrame(s.target, s.frame), s.options || {});
        else if (s.type === 'custom') await this.step(withFrame(s.target, s.frame), s.action, s.label);
      }
    } catch (err) {
      if (err instanceof PagePilotStopped) return; // intentionally stopped, not a failure
      throw err;
    }
    this.hideCursor();
  }

  /**
   * Immediately abort whatever is currently running (mid-wait, mid-typing,
   * mid-scroll, anywhere) and drop everything still queued behind it. Safe
   * to call at any time, including when nothing is running. The instance
   * stays fully usable afterwards — the very next click()/type()/run() call
   * starts a clean new sequence, no reset() needed.
   */
  stop() {
    this._generation++; // invalidates every step already queued/in flight
    for (const abort of this._pendingRejects) abort();
    this._pendingRejects.clear();
    this.queue = Promise.resolve();
    this._activeCount = 0;
    this.hideCursor();
    this._hideScrollIndicator(); // in case stop() landed mid-scroll
    if (this._glowHideTimer) { clearTimeout(this._glowHideTimer); this._glowHideTimer = null; }
    if (this._blockerAllowTimer) { clearTimeout(this._blockerAllowTimer); this._blockerAllowTimer = null; }
    if (this._glowEl) {
      this._glowEl.style.opacity = '0';
      this._glowEl.style.animation = 'none';
    }
    if (this._blockerEl) {
      this._blockerEl.style.pointerEvents = 'none';
      this._blockerEl.style.opacity = '0';
    }
    if (this._messageEl) this._messageEl.style.opacity = '0';
  }

  /** Hide the cursor dot (e.g. once a whole sequence of actions is done). */
  hideCursor() {
    if (this.cursorEl) this.cursorEl.style.display = 'none';
  }

  /** Show the cursor dot again (it also reappears automatically on the next move/click/type/etc.). */
  showCursor() {
    if (this.cursorEl) this.cursorEl.style.display = 'block';
  }

  /** Remove the cursor element, all highlight boxes, and event listeners. */
  destroy() {
    this.cursorEl?.remove();
    this._glowEl?.remove();
    this._blockerEl?.remove();
    this._messageEl?.remove();
    if (this._glowHideTimer) clearTimeout(this._glowHideTimer);
    if (this._blockerAllowTimer) clearTimeout(this._blockerAllowTimer);
    this.clearHighlights();
    window.removeEventListener('scroll', this._onWindowChange, { capture: true });
    window.removeEventListener('resize', this._onWindowChange);
    this.queue = Promise.resolve();
  }
}
