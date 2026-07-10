/**
 * page-pilot-recorder
 * Records real user interactions on a page and turns them into a step array
 * in the exact shape PagePilot's run() expects — so you can record once and
 * play it back with page-pilot.js without hand-writing selectors.
 *
 * This is a companion tool, not part of the playback engine. It only listens
 * to real (isTrusted) DOM events and never dispatches anything itself.
 *
 * Usage:
 *   import { PagePilotRecorder } from './page-pilot-recorder.js'
 *   const recorder = new PagePilotRecorder({ ui: true })
 *   recorder.start()
 *   // ...user interacts with the page normally...
 *   const steps = recorder.stop()
 *   console.log(JSON.stringify(steps, null, 2))
 *   // paste the result straight into: await cursor.run(steps)
 *
 * What gets recorded:
 *   - click            → { type: 'click', target } (not recorded for a
 *     plain click into a text field/textarea — that's just focusing it to
 *     type, already implicit in the 'type' step)
 *   - typing            → { type: 'type', target, text }  (buffered until blur, not per-keystroke)
 *   - native <select>   → { type: 'select', target, value }
 *   - checkbox/radio    → { type: 'check', target, checked }
 *   - non-character keys (Enter/Escape/Tab/arrows/etc.), and any key combined
 *     with a modifier (Ctrl+A, Cmd+S, etc.) → { type: 'pressKey', target, key, options }
 *   - scroll (window or a container), debounced until it settles → { type: 'scroll', target, options }
 *   - drag gestures (mousedown, moved past dragThreshold, mouseup) →
 *     { type: 'dragTo', target, destination }. destination is an element
 *     selector if one was under the pointer at mouseup, otherwise a raw
 *     { x, y } point. Text-selection drags are skipped automatically.
 *   - opening a custom dropdown/menu and picking an option inside it gets
 *     merged into one { type: 'chooseOption', target, option, options:
 *     { waitAfterOpen } } step, detected via MutationObserver (see
 *     mergeChooseOption below) instead of two separate click steps.
 *   - interactions inside a same-origin iframe get a `frame` field (an
 *     iframe selector, or an array of them for nested iframes) alongside
 *     the usual `target`, so PagePilot knows which document to resolve the
 *     selector in. Cross-origin iframes can't be observed at all — that's a
 *     hard browser security limitation, not something this library can work
 *     around. Set recordIframes: false to disable this entirely.
 *   - a step following a long pause (opts.waitHintThreshold, default
 *     1200ms) gets a `gapBefore` (ms) field and fires onWaitHint — a nudge
 *     that something might have been loading, NOT an automatic waitFor()
 *     step (the recorder has no way to know what selector to wait for).
 *
 * What does NOT get recorded (by design, needs a human to decide):
 *   - waitFor() steps themselves — see gapBefore/onWaitHint above for the
 *     closest thing to automatic help here.
 *   - hover/unhover — real hover gestures aren't meaningfully distinguishable
 *     from incidental mouse movement without a lot of false-positive risk.
 *     Add these by hand.
 *
 * Selector generation prefers stable attributes over structural position:
 *   id → data-testid/data-cy/data-test/data-qa → any other data-* attribute
 *   → aria-label → name → non-utility class names → structural nth-of-type
 *   path (last resort). Every generated step carries a `fragile: true` flag
 *   when it had to fall back to the structural path, so you know which ones
 *   to double check before relying on the script long-term.
 */

const UTILITY_CLASS_PATTERNS = [
  /:/, // Tailwind variants like hover:bg-blue-500
  /^\d/, // classes starting with a digit
  /^[a-z]{1,2}$/, // single/double letter classes (usually generated/minified)
  /^(w|h|p|m|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr|gap|text|bg|flex|grid|rounded|border|shadow|z|top|left|right|bottom|inset|opacity|transition|duration|ease|cursor|select|items|justify|space|col|row)-/,
];

function isStableClass(cls) {
  if (!cls) return false;
  return !UTILITY_CLASS_PATTERNS.some((re) => re.test(cls));
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  return String(value).replace(/([^\w-])/g, '\\$1');
}

/** Escape a value going inside a quoted attribute selector, e.g. [name="..."]. */
function escapeAttrValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function isUnique(root, selector) {
  try {
    return root.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

function nearestIdAncestor(el) {
  let node = el.parentElement;
  while (node) {
    if (node.id) return node;
    node = node.parentElement;
  }
  return null;
}

function structuralPath(el, stopAt) {
  const parts = [];
  let node = el;
  while (node && node !== stopAt && node.tagName) {
    const parent = node.parentElement;
    if (!parent) break;
    const siblingsOfType = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    const index = siblingsOfType.indexOf(node) + 1;
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
    node = parent;
  }
  return parts.join(' > ');
}

/**
 * Generate a CSS selector for an element, preferring stable attributes over
 * structural position. Returns { selector, fragile }. `fragile: true` means
 * this had to fall back to a structural path — review it before relying on
 * the generated script long-term; consider adding a data-testid instead.
 *
 * Uniqueness is checked against the element's OWN document (el.ownerDocument),
 * not necessarily the top-level `document` — this matters for elements
 * inside a same-origin iframe, where the top document has no idea the
 * element even exists.
 */
export function generateSelector(el) {
  const root = el.ownerDocument || document;

  if (el.id) {
    const sel = `#${cssEscape(el.id)}`;
    if (isUnique(root, sel)) return { selector: sel, fragile: false };

    // Duplicate ids are surprisingly common on real (especially older or
    // messier) sites — invalid HTML, but browsers don't stop you from doing
    // it. Rather than throwing the id away entirely and falling all the way
    // back to a deep structural path, disambiguate among just the elements
    // sharing this id by position: much shorter and more robust than a full
    // ancestor-based path, since it still anchors on the (weak) id signal.
    // This produces a { selector, index } target instead of a plain string —
    // still marked fragile, since a duplicate id is itself a sign of markup
    // that could shift under you.
    const dupSelector = `[id="${escapeAttrValue(el.id)}"]`;
    let duplicates;
    try {
      duplicates = Array.from(root.querySelectorAll(dupSelector));
    } catch {
      duplicates = [];
    }
    const index = duplicates.indexOf(el);
    if (index !== -1 && duplicates.length > 1) {
      return { selector: dupSelector, index, fragile: true };
    }
  }

  for (const attr of ['data-testid', 'data-cy', 'data-test', 'data-qa']) {
    const val = el.getAttribute(attr);
    if (val) {
      const sel = `[${attr}="${escapeAttrValue(val)}"]`;
      if (isUnique(root, sel)) return { selector: sel, fragile: false };
    }
  }

  // Any other data-* attribute is often a stable functional identifier too
  // (e.g. data-value on a custom dropdown option) — the app's own JS reads
  // it, so it's unlikely to get renamed casually, unlike a CSS class.
  const skipDataAttrs = new Set(['data-testid', 'data-cy', 'data-test', 'data-qa', 'data-ppr-ignore']);
  for (const attr of el.attributes || []) {
    if (!attr.name.startsWith('data-') || skipDataAttrs.has(attr.name)) continue;
    const sel = `${el.tagName.toLowerCase()}[${attr.name}="${escapeAttrValue(attr.value)}"]`;
    if (isUnique(root, sel)) return { selector: sel, fragile: false };
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const sel = `${el.tagName.toLowerCase()}[aria-label="${escapeAttrValue(ariaLabel)}"]`;
    if (isUnique(root, sel)) return { selector: sel, fragile: false };
  }

  const name = el.getAttribute('name');
  if (name) {
    const sel = `${el.tagName.toLowerCase()}[name="${escapeAttrValue(name)}"]`;
    if (isUnique(root, sel)) return { selector: sel, fragile: false };
  }

  const stableClasses = Array.from(el.classList || []).filter(isStableClass);
  if (stableClasses.length) {
    const sel = `${el.tagName.toLowerCase()}.${stableClasses.map(cssEscape).join('.')}`;
    if (isUnique(root, sel)) return { selector: sel, fragile: false };
  }

  const ancestor = nearestIdAncestor(el);
  const path = structuralPath(el, ancestor || root.body);
  const selector = ancestor ? `#${cssEscape(ancestor.id)} > ${path}` : path;
  return { selector, fragile: true };
}

const NON_CHARACTER_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

const DEFAULTS = {
  ui: true, // show a small floating start/stop/copy control panel
  scrollSettleDelay: 250, // ms of no scroll activity before a scroll step is recorded
  mergeChooseOption: true, // detect trigger-click + option-click into one chooseOption step
  chooseOptionMergeWindow: 4000, // max ms between the two clicks for them to still merge
  recordDragTo: true, // detect mousedown-move-mouseup gestures as dragTo steps
  dragThreshold: 10, // px of movement before a mousedown/mouseup pair counts as a drag, not a click
  waitHintThreshold: 1200, // ms of silence before a step gets a gapBefore hint (see onWaitHint)
  recordIframes: true, // also record interactions inside same-origin iframes
  onStep: null, // (step) => void, called every time a step is recorded
  onWaitHint: null, // (gapMs, step) => void, called when a long pause is detected before a step
};

export class PagePilotRecorder {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.recording = false;
    this.steps = [];
    this._typingBuffer = null; // { el, selector, startValue }
    this._scrollTimers = new Map(); // scroll target -> debounce timer
    this._scrollStartTop = new Map(); // scroll target -> scrollTop when this settle-cycle began
    this._pendingTrigger = null; // last click step, candidate to merge into a chooseOption
    this._recentMutations = []; // { target, time } — rolling window for chooseOption detection
    this._mutationObserver = null;
    this._dragCandidate = null; // { el, startX, startY, time } while a mouse button is held down
    this._observedDocuments = new Map(); // Document -> frame path (array of iframe selectors from top)
    this._iframeLoadHandlers = new Map(); // iframe element -> its 'load' handler, for cleanup
    this._lastStepTime = null; // performance.now() of the last recorded step, for wait-hint detection

    this._onClick = this._onClick.bind(this);
    this._onChange = this._onChange.bind(this);
    this._onFocusIn = this._onFocusIn.bind(this);
    this._onFocusOut = this._onFocusOut.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onScroll = this._onScroll.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
  }

  /** Start listening. Returns this, so `recorder.start()` reads naturally. */
  start() {
    if (this.recording) return this;
    this.recording = true;
    this.steps = [];
    this._pendingTrigger = null;
    this._recentMutations = [];
    this._dragCandidate = null;
    this._observedDocuments = new Map();
    this._iframeLoadHandlers = new Map();
    this._lastStepTime = performance.now();

    this._attachListenersTo(document, []);

    if (this.opts.mergeChooseOption || this.opts.recordIframes) {
      this._mutationObserver = new MutationObserver((mutations) => this._onMutations(mutations));
      this._mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'open', 'aria-hidden'],
      });
    }

    // If a form field already has focus at the moment recording starts (the
    // person clicked into it before pressing "Start", or it was autofocused),
    // no 'focusin' will ever fire for it during this session — nothing would
    // trigger the typing buffer to be created, silently losing anything they
    // type. Seed the buffer immediately as if a focusin had just happened.
    // This descends into iframes too, since a focused iframe shows up as
    // the top document's activeElement being the <iframe> itself.
    const active = this._deepActiveElement(document);
    if (active && active.nodeType === 1 && this._isFormField(active) && !this._isPasswordField(active)) {
      this._beginTypingBuffer(active);
    }

    if (this.opts.ui) this._showUi();
    return this;
  }

  /** Stop listening and return the recorded steps array. */
  stop() {
    if (!this.recording) return this.steps;
    this.recording = false;
    this._flushTyping();
    for (const doc of this._observedDocuments.keys()) this._detachListenersFrom(doc);
    this._observedDocuments.clear();
    for (const [iframe, handler] of this._iframeLoadHandlers) iframe.removeEventListener('load', handler);
    this._iframeLoadHandlers.clear();
    for (const timer of this._scrollTimers.values()) clearTimeout(timer);
    this._scrollTimers.clear();
    this._mutationObserver?.disconnect();
    this._mutationObserver = null;
    this._recentMutations = [];
    this._pendingTrigger = null;
    this._dragCandidate = null;
    if (this._uiEl) this._setUiRecordingState(false);
    return this.steps;
  }

  /**
   * Attach the full set of recording listeners to a document (the top page,
   * or a same-origin iframe's contentDocument), and — if opts.recordIframes
   * is on — recurse into any same-origin iframes already inside it.
   * `framePath` is the array of iframe selectors needed to reach `doc` from
   * the top document (empty for the top document itself).
   */
  _attachListenersTo(doc, framePath) {
    if (this._observedDocuments.has(doc)) return;
    this._observedDocuments.set(doc, framePath);
    doc.addEventListener('click', this._onClick, true);
    doc.addEventListener('change', this._onChange, true);
    doc.addEventListener('focusin', this._onFocusIn, true);
    doc.addEventListener('focusout', this._onFocusOut, true);
    doc.addEventListener('keydown', this._onKeyDown, true);
    doc.addEventListener('scroll', this._onScroll, true);
    if (this.opts.recordDragTo) {
      doc.addEventListener('mousedown', this._onMouseDown, true);
      doc.addEventListener('mouseup', this._onMouseUp, true);
    }
    if (this.opts.recordIframes) this._discoverIframes(doc, framePath);
  }

  _detachListenersFrom(doc) {
    doc.removeEventListener('click', this._onClick, true);
    doc.removeEventListener('change', this._onChange, true);
    doc.removeEventListener('focusin', this._onFocusIn, true);
    doc.removeEventListener('focusout', this._onFocusOut, true);
    doc.removeEventListener('keydown', this._onKeyDown, true);
    doc.removeEventListener('scroll', this._onScroll, true);
    doc.removeEventListener('mousedown', this._onMouseDown, true);
    doc.removeEventListener('mouseup', this._onMouseUp, true);
  }

  /** Find same-origin iframes inside `doc` and start observing them too. */
  _discoverIframes(doc, parentFramePath) {
    let iframes;
    try {
      iframes = doc.querySelectorAll('iframe');
    } catch {
      return;
    }
    for (const iframe of iframes) {
      if (this._iframeLoadHandlers.has(iframe)) continue;

      const attach = () => {
        let innerDoc;
        try {
          innerDoc = iframe.contentDocument;
        } catch {
          innerDoc = null; // cross-origin — inaccessible, nothing we can do
        }
        // A same-origin iframe's contentDocument gets swapped out for a brand
        // new Document object once it finishes navigating to its real
        // content — attaching to whatever contentDocument is present right
        // this instant could mean attaching to a transitional empty document
        // that's about to be discarded. The 'load' listener below re-runs
        // this once the iframe's real content is actually ready, so this
        // works correctly regardless of whether it's already loaded when
        // discovered or still in flight.
        if (!innerDoc || this._observedDocuments.has(innerDoc)) return;
        const { selector } = generateSelector(iframe);
        this._attachListenersTo(innerDoc, [...parentFramePath, selector]);
      };
      this._iframeLoadHandlers.set(iframe, attach);
      attach();
      iframe.addEventListener('load', attach);
    }
  }

  /** The frame path for an element's own document, or undefined if it's the
   * top document (so steps for top-level elements don't carry a frame field). */
  _frameFor(el) {
    const doc = el.ownerDocument || document;
    const path = this._observedDocuments.get(doc);
    if (!path || path.length === 0) return undefined;
    return path.length === 1 ? path[0] : path;
  }

  /**
   * Build the target value for a step from an element and its generated
   * selector: a plain selector string when that's enough on its own, or
   * { selector, index?, frame? } when the element needed positional
   * disambiguation (duplicate ids) and/or lives inside a same-origin
   * iframe. page-pilot's _resolve() understands both shapes.
   */
  _buildTarget(el, generated) {
    const frame = this._frameFor(el);
    if (generated.index === undefined && !frame) return generated.selector;
    const target = { selector: generated.selector };
    if (generated.index !== undefined) target.index = generated.index;
    if (frame) target.frame = frame;
    return target;
  }

  /** Clear everything recorded so far without stopping. */
  clear() {
    this.steps = [];
    if (this._uiEl) this._updateUiCount();
  }

  _pushStep(step) {
    this._applyWaitHint(step);
    this.steps.push(step);
    this.opts.onStep?.(step);
    if (this._uiEl) this._updateUiCount();
  }

  /**
   * If a long stretch of silence preceded this step, attach a `gapBefore`
   * (ms) hint to it and fire onWaitHint. This is deliberately NOT an
   * automatic waitFor() step — the recorder has no way to know what
   * selector to wait for — just a nudge that a pause happened here, in
   * case it was waiting on something to load asynchronously.
   */
  _applyWaitHint(step) {
    const now = performance.now();
    if (this._lastStepTime != null) {
      const gap = now - this._lastStepTime;
      if (gap >= this.opts.waitHintThreshold) {
        step.gapBefore = Math.round(gap);
        this.opts.onWaitHint?.(step.gapBefore, step);
      }
    }
    this._lastStepTime = now;
  }

  /** The actual focused element, descending into iframes as needed — a
   * focused iframe shows up as the parent document's activeElement being
   * the <iframe> tag itself, not the element focused inside it. */
  _deepActiveElement(doc) {
    let active = doc.activeElement;
    while (active && active.tagName === 'IFRAME') {
      let inner;
      try {
        inner = active.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) break;
      active = inner.activeElement;
    }
    return active;
  }

  _isFormField(el) {
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  }

  /** Password fields are never recorded — there's no legitimate reason a
   * generated automation script should contain someone's typed password,
   * and this is deliberately NOT a configurable option. */
  _isPasswordField(el) {
    return el.tagName === 'INPUT' && el.type === 'password';
  }

  /**
   * True for elements that shouldn't be recorded at all — the recorder's
   * own floating UI, or anything you've marked with a data-ppr-ignore
   * attribute (put it on your own Start/Stop/Replay controls if you build a
   * custom UI instead of using the built-in one, so pressing Stop doesn't
   * get recorded as a click step in the middle of your session).
   */
  _isIgnored(el) {
    if (this._uiEl && this._uiEl.contains(el)) return true;
    return !!el.closest?.('[data-ppr-ignore]');
  }

  /** Record a rolling window of recent DOM mutations, used to detect a
   * custom dropdown/menu opening for chooseOption merging (see _onClick). */
  _onMutations(mutations) {
    const now = performance.now();
    if (this.opts.mergeChooseOption) {
      for (const m of mutations) {
        this._recentMutations.push({ target: m.target, time: now });
        if (m.addedNodes) {
          for (const node of m.addedNodes) {
            if (node.nodeType === 1) this._recentMutations.push({ target: node, time: now });
          }
        }
      }
      const cutoff = now - this.opts.chooseOptionMergeWindow;
      while (this._recentMutations.length && this._recentMutations[0].time < cutoff) {
        this._recentMutations.shift();
      }
    }

    if (this.opts.recordIframes) {
      for (const m of mutations) {
        if (!m.addedNodes) continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const doc = node.ownerDocument;
          const framePath = this._observedDocuments.get(doc) || [];
          if (node.tagName === 'IFRAME') this._discoverIframes(doc, framePath);
          else if (node.querySelector?.('iframe')) this._discoverIframes(doc, framePath);
        }
      }
    }
  }

  /** Was `el` (or one of its ancestors/descendants) touched by a DOM
   * mutation between `sinceTime` and `untilTime`? Used as the "a menu
   * probably just opened here" signal for chooseOption merging. */
  _wasRevealedSince(el, sinceTime, untilTime) {
    for (const { target, time } of this._recentMutations) {
      if (time < sinceTime || time > untilTime) continue;
      if (target === el) return true;
      if (target.contains?.(el)) return true;
      if (el.contains?.(target)) return true;
    }
    return false;
  }

  /**
   * Safety net: flush the typing buffer if the element it's tracking no
   * longer has focus, regardless of whether we ever saw a 'focusout' event
   * for it. focusin/focusout are the primary mechanism, but relying on them
   * exclusively turned out to be fragile in practice — real-world focus
   * transitions (e.g. clicking to open a native <select>) don't always fire
   * them in a way this recorder could observe reliably, silently losing
   * whatever was typed. Checking document.activeElement directly, on every
   * subsequent click/change/keydown, catches that regardless of the cause.
   */
  _flushIfBlurred() {
    if (!this._typingBuffer) return;
    const ownerDoc = this._typingBuffer.el.ownerDocument || document;
    if (ownerDoc.activeElement !== this._typingBuffer.el) {
      this._flushTyping();
    }
  }

  _onClick(e) {
    if (!this.recording) return;
    const el = e.target;
    if (!(el && el.nodeType === 1)) return;
    if (this._isIgnored(el)) return; // don't record clicks on the recorder's own controls
    this._flushIfBlurred();

    // Checkboxes/radios are recorded as check() via the 'change' handler
    // instead — a raw click() would be semantically weaker (loses the
    // explicit "set to this state" intent that check() carries), so skip
    // recording a click here to avoid a duplicate/conflicting step.
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return;
    if (el.tagName === 'SELECT') return; // handled by 'change'

    // A plain click on a text field/textarea is just focusing it to type —
    // that's already implicit in the upcoming 'type' step (page-pilot's
    // type() focuses the element itself), so recording it separately would
    // just be noise (and a redundant click() during replay).
    if (this._isFormField(el)) return;

    const now = performance.now();
    this._flushTyping();
    if (this.opts.mergeChooseOption && this._tryMergeChooseOption(el, now)) {
      this._pendingTrigger = null;
      return;
    }

    const generated = generateSelector(el);
    const step = { type: 'click', target: this._buildTarget(el, generated) };
    if (generated.fragile) step.fragile = true;
    this._pushStep(step);

    // Remember this click as a possible chooseOption trigger — if the very
    // next recorded step turns out to be a click on something that appeared
    // shortly after this one, the two get merged (see _tryMergeChooseOption).
    this._pendingTrigger = { el, generated, time: now, step };
  }

  /**
   * If there's a pending trigger click, and this new click lands on
   * something that was revealed by a DOM mutation shortly after that
   * trigger — with nothing else recorded in between — merge both clicks
   * into a single chooseOption step instead of two separate click steps.
   * Returns true if it merged (caller should skip normal click recording).
   */
  _tryMergeChooseOption(el, now) {
    const pending = this._pendingTrigger;
    if (!pending) return false;
    // Nothing else may have been recorded between the trigger click and now.
    if (this.steps[this.steps.length - 1] !== pending.step) return false;
    if (now - pending.time > this.opts.chooseOptionMergeWindow) return false;
    if (pending.el === el || pending.el.contains(el)) return false;
    if (!this._wasRevealedSince(el, pending.time, now)) return false;

    const optionGenerated = generateSelector(el);
    const mergedStep = {
      type: 'chooseOption',
      target: this._buildTarget(pending.el, pending.generated),
      option: this._buildTarget(el, optionGenerated),
    };
    const waitAfterOpen = Math.round((now - pending.time) / 50) * 50;
    if (waitAfterOpen > 0) mergedStep.options = { waitAfterOpen };
    if (pending.generated.fragile || optionGenerated.fragile) mergedStep.fragile = true;
    if (pending.step.gapBefore) mergedStep.gapBefore = pending.step.gapBefore;

    const idx = this.steps.indexOf(pending.step);
    if (idx !== -1) this.steps.splice(idx, 1, mergedStep);
    else this.steps.push(mergedStep);

    this._lastStepTime = now;
    this.opts.onStep?.(mergedStep);
    if (this._uiEl) this._updateUiCount();
    return true;
  }

  _onChange(e) {
    if (!this.recording) return;
    const el = e.target;
    if (!(el && el.nodeType === 1)) return;
    if (this._isIgnored(el)) return;
    this._flushIfBlurred();

    if (el.tagName === 'SELECT') {
      const generated = generateSelector(el);
      const value = el.multiple
        ? Array.from(el.selectedOptions).map((o) => o.value)
        : el.value;
      const step = { type: 'select', target: this._buildTarget(el, generated), value };
      if (generated.fragile) step.fragile = true;
      this._pushStep(step);
      return;
    }

    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const generated = generateSelector(el);
      const step = { type: 'check', target: this._buildTarget(el, generated), checked: el.checked };
      if (generated.fragile) step.fragile = true;
      this._pushStep(step);
    }
  }

  _onFocusIn(e) {
    if (!this.recording) return;
    const el = e.target;
    if (!(el && el.nodeType === 1) || !this._isFormField(el)) return;
    if (this._isPasswordField(el)) return; // never buffer/record what's typed into a password field
    this._beginTypingBuffer(el);
  }

  /** Establish a fresh typing buffer for a form field, flushing any prior one first. */
  _beginTypingBuffer(el) {
    this._flushTyping();
    const generated = generateSelector(el);
    this._typingBuffer = {
      el,
      generated,
      startValue: el.isContentEditable ? el.textContent : el.value,
    };
  }

  _onFocusOut(e) {
    if (!this.recording) return;
    if (this._typingBuffer && this._typingBuffer.el === e.target) this._flushTyping();
  }

  _flushTyping() {
    const buf = this._typingBuffer;
    this._typingBuffer = null;
    if (!buf) return;
    const currentValue = buf.el.isContentEditable ? buf.el.textContent : buf.el.value;
    if (currentValue === buf.startValue || currentValue === '') return; // nothing typed, skip
    const step = { type: 'type', target: this._buildTarget(buf.el, buf.generated), text: currentValue };
    if (buf.generated.fragile) step.fragile = true;
    this._pushStep(step);
  }

  _onKeyDown(e) {
    if (!this.recording) return;
    const el = e.target;

    // Enter inside a textarea/contenteditable is just a newline — part of
    // the text being typed, not a shortcut — so let it flow into the
    // typing buffer like any other character instead of flushing it early
    // and recording a pressKey step. Without this, every newline would
    // prematurely flush+clear the buffer, and everything typed after the
    // first line would have nowhere to go and get silently lost.
    const isMultilineField = el && el.nodeType === 1 && (el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (e.key === 'Enter' && isMultilineField) return;

    const hasModifier = e.ctrlKey || e.metaKey || e.altKey;
    // Plain character keys (no modifier) flow into the typing buffer instead;
    // anything in NON_CHARACTER_KEYS, or any key combined with a modifier
    // (Ctrl+A, Cmd+S, etc. — these are shortcuts, not text being typed), gets
    // recorded as its own pressKey step.
    if (!NON_CHARACTER_KEYS.has(e.key) && !hasModifier) return;

    this._flushTyping(); // whatever was typed before this key counts as its own step first

    const modifiers = {};
    if (e.ctrlKey) modifiers.ctrl = true;
    if (e.shiftKey) modifiers.shift = true;
    if (e.altKey) modifiers.alt = true;
    if (e.metaKey) modifiers.meta = true;

    let target = null;
    let fragile = false;
    if (el && el.nodeType === 1 && el !== (el.ownerDocument || document).body) {
      const generated = generateSelector(el);
      target = this._buildTarget(el, generated);
      fragile = generated.fragile;
    }

    const step = { type: 'pressKey', target, key: e.key };
    if (Object.keys(modifiers).length) step.options = { modifiers };
    if (fragile) step.fragile = true;
    this._pushStep(step);
  }

  _onScroll(e) {
    if (!this.recording) return;
    const isDocumentScroll = e.target && e.target.nodeType === 9; // 9 = DOCUMENT_NODE; realm-safe, unlike instanceof Document
    const target = isDocumentScroll ? (e.target.defaultView || window) : e.target;
    if (!this._scrollStartTop.has(target)) {
      this._scrollStartTop.set(target, typeof target.scrollY === 'number' ? target.scrollY : target.scrollTop);
    }
    clearTimeout(this._scrollTimers.get(target));
    this._scrollTimers.set(target, setTimeout(() => this._flushScroll(target), this.opts.scrollSettleDelay));
  }

  _flushScroll(target) {
    const startTop = this._scrollStartTop.get(target) ?? 0;
    this._scrollStartTop.delete(target);
    this._scrollTimers.delete(target);

    const isWindowLike = typeof target.scrollY === 'number';
    const doc = isWindowLike ? target.document : target.ownerDocument;
    const scrollTop = isWindowLike ? target.scrollY : target.scrollTop;
    const scrollHeight = isWindowLike
      ? (doc.scrollingElement || doc.documentElement).scrollHeight
      : target.scrollHeight;
    const clientHeight = isWindowLike ? target.innerHeight : target.clientHeight;

    let options;
    if (scrollTop <= 1) options = { to: 'top' };
    else if (scrollTop >= scrollHeight - clientHeight - 1) options = { to: 'bottom' };
    else options = { amount: scrollTop - startTop };

    const step = { type: 'scroll', target: null, options };
    if (!isWindowLike) {
      const generated = generateSelector(target);
      step.target = this._buildTarget(target, generated);
      if (generated.fragile) step.fragile = true;
    } else {
      // Scrolling the window of a same-origin iframe (not the top page)
      // still needs a frame marker so playback knows which window to scroll.
      const framePath = this._observedDocuments.get(doc);
      if (framePath && framePath.length) step.frame = framePath.length === 1 ? framePath[0] : framePath;
    }
    this._pushStep(step);
  }

  /**
   * Drag detection: track where a mouse button went down, and on mouseup,
   * check whether it moved far enough (opts.dragThreshold) to count as a
   * deliberate drag rather than a click — browsers already suppress the
   * 'click' event themselves when the pointer moves enough between down
   * and up, so there's little risk of double-recording the same gesture.
   */
  _onMouseDown(e) {
    if (!this.recording || e.button !== 0) return;
    const el = e.target;
    if (!(el && el.nodeType === 1) || this._isIgnored(el)) return;
    this._dragCandidate = { el, startX: e.clientX, startY: e.clientY, time: performance.now() };
  }

  _onMouseUp(e) {
    if (!this.recording) return;
    const cand = this._dragCandidate;
    this._dragCandidate = null;
    if (!cand) return;

    const dx = e.clientX - cand.startX;
    const dy = e.clientY - cand.startY;
    if (Math.sqrt(dx * dx + dy * dy) < this.opts.dragThreshold) return; // just a click

    // A drag that ended with a text selection is probably the person
    // selecting text, not dragging a UI element — skip recording that as
    // dragTo (leave text-selection interactions unrecorded entirely; there's
    // no faithful way to "replay" a text selection via page-pilot anyway).
    const doc = cand.el.ownerDocument || document;
    const selection = doc.defaultView?.getSelection?.();
    if (selection && String(selection).length > 0) return;

    this._flushIfBlurred();
    this._flushTyping();

    const sourceGenerated = generateSelector(cand.el);
    let destEl = null;
    try {
      destEl = doc.elementFromPoint(e.clientX, e.clientY);
    } catch {
      destEl = null;
    }

    const step = { type: 'dragTo', target: this._buildTarget(cand.el, sourceGenerated) };
    let fragile = sourceGenerated.fragile;
    if (destEl && destEl !== cand.el && !cand.el.contains(destEl)) {
      const destGenerated = generateSelector(destEl);
      step.destination = this._buildTarget(destEl, destGenerated);
      fragile = fragile || destGenerated.fragile;
    } else {
      step.destination = { x: e.clientX, y: e.clientY };
    }
    if (fragile) step.fragile = true;
    this._pushStep(step);
    this._pendingTrigger = null; // a drag breaks any pending chooseOption merge
  }

  // --- minimal floating UI -------------------------------------------------

  _showUi() {
    if (this._uiEl) { this._setUiRecordingState(true); return; }
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      background: #111; color: #fff; font: 13px/1.4 -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 10px 12px; border-radius: 10px; display: flex; align-items: center; gap: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    `;
    el.innerHTML = `
      <span id="ppr-dot" style="width:8px;height:8px;border-radius:50%;background:#ef4444;"></span>
      <span id="ppr-count">0 steps</span>
      <button id="ppr-stop" style="margin-left:6px; padding:3px 8px; border-radius:6px; border:none; cursor:pointer;">Stop</button>
      <button id="ppr-copy" style="padding:3px 8px; border-radius:6px; border:none; cursor:pointer;" disabled>Copy</button>
    `;
    document.body.appendChild(el);
    this._uiEl = el;
    el.querySelector('#ppr-stop').addEventListener('click', () => {
      this.stop();
      el.querySelector('#ppr-copy').disabled = false;
    });
    el.querySelector('#ppr-copy').addEventListener('click', () => {
      const json = JSON.stringify(this.steps, null, 2);
      navigator.clipboard?.writeText(json).catch(() => {});
      console.log('[page-pilot-recorder] steps:\n' + json);
    });
  }

  _setUiRecordingState(isRecording) {
    const dot = this._uiEl.querySelector('#ppr-dot');
    if (dot) dot.style.background = isRecording ? '#ef4444' : '#6b7280';
  }

  _updateUiCount() {
    const count = this._uiEl?.querySelector('#ppr-count');
    if (count) count.textContent = `${this.steps.length} step${this.steps.length === 1 ? '' : 's'}`;
  }

  /** Remove the floating UI, if shown. Does not stop recording. */
  destroyUi() {
    this._uiEl?.remove();
    this._uiEl = null;
  }
}
