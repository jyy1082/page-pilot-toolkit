/**
 * page-pilot-skills
 * Turns a recorded step array (from page-pilot-recorder) into a reusable
 * "skill": a task description, a parameter list, and the original steps
 * with concrete values swapped for {{parameter}} placeholders — so the
 * same recording can be replayed later with different values, instead of
 * being locked to whatever was typed during recording.
 *
 * This is step 1 of a larger plan (recording → tagging → storage now;
 * AI-driven retrieval and parameter fill-in come later, on top of this).
 * Nothing here talks to an AI at all — it's the data layer + a review UI
 * a person uses right after stopping a recording, and a small storage API.
 *
 * Usage:
 *   import { buildSkillDraft, saveSkill, listSkills, showArchivePanel } from './page-pilot-skills.js'
 *
 *   const steps = recorder.stop()
 *   const skill = await showArchivePanel(steps) // null if the person picked "one-time use"
 *   // skill is already saved if they picked "save as a skill" — showArchivePanel
 *   // handles the save itself so callers don't have to remember to.
 */

const STORAGE_PREFIX = 'page-pilot-skills:';

// Common dangerous-action words, checked against button text (either a
// plain click target string that looks like a selector for something
// named this, or a { selector, text } target's own text) and typed
// values. Deliberately broad and case-insensitive — false positives here
// just mean an extra confirmation checkbox someone can uncheck, which is
// a much smaller cost than a false negative letting something dangerous
// through unflagged.
const HIGH_RISK_WORDS = [
  '删除', '移除', '清除', '清空', '注销', '解除', '终止', '作废', '撤销',
  '提交', '支付', '付款', '转账', '汇款', '充值', '退款', '确认删除',
  'delete', 'remove', 'clear', 'submit', 'pay', 'payment', 'transfer',
  'confirm', 'checkout', 'purchase', 'cancel account', 'deactivate',
];

/** Escape a value for safe use inside a CSS attribute-selector string. */
function escapeAttrValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Resolve a step's target back to a live DOM element, for inspecting its
 * label/placeholder/etc. Supports the plain-string and { selector, text,
 * index } shapes page-pilot-recorder produces. Does not cross into
 * iframes in this first pass — parameter detection runs against the top
 * document right after recording, and iframe-scoped fields are rarer; a
 * step with a `frame` field just won't get a detected label; the
 * parameter still gets created, only the label suggestion falls back to
 * the generic prompt (see detectParameters below).
 */
function resolveElement(target) {
  if (typeof target === 'string') {
    try {
      return document.querySelector(target);
    } catch {
      return null;
    }
  }
  if (target && typeof target === 'object' && 'selector' in target && !target.frame) {
    let matches;
    try {
      matches = Array.from(document.querySelectorAll(target.selector));
    } catch {
      return null;
    }
    if (target.text !== undefined) {
      matches = matches.filter((el) => (el.textContent || '').trim() === target.text);
    }
    return target.index !== undefined ? matches[target.index] || null : matches[0] || null;
  }
  return null;
}

/**
 * Suggest a human-readable field name for an element, trying in order:
 * a <label for="..."> pointing at it, a wrapping <label>, aria-label,
 * placeholder, then the name attribute. Returns null if none are found
 * (the caller falls back to a generic "参数N" name).
 */
function suggestFieldName(el) {
  if (!el) return null;

  if (el.id) {
    let label;
    try {
      label = document.querySelector(`label[for="${escapeAttrValue(el.id)}"]`);
    } catch {
      label = null;
    }
    if (label && label.textContent.trim()) return label.textContent.trim();
  }

  const wrappingLabel = el.closest && el.closest('label');
  if (wrappingLabel) {
    const text = wrappingLabel.textContent.replace(el.value || '', '').trim();
    if (text) return text;
  }

  const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

  const placeholder = el.placeholder;
  if (placeholder && placeholder.trim()) return placeholder.trim();

  const name = el.getAttribute && el.getAttribute('name');
  if (name && name.trim()) return name.trim();

  return null;
}

/**
 * A value this long is much more likely to be free-form text (a note,
 * description, etc.) that should stay fixed per-run rather than a
 * reusable parameter someone would swap out — so it's suggested
 * unchecked by default, not excluded entirely (the person can still
 * check it).
 */
const LONG_VALUE_THRESHOLD = 200;

/**
 * Scan a recorded step array for values worth turning into named
 * parameters — the `text` of a `type` step, and the `value` of a
 * `select`/`check` step. Returns an array of candidates:
 *   { stepIndex, field, value, suggestedName, suggestedChecked }
 * `check` (checkbox/radio boolean) steps are included too, in case
 * someone wants "should this be checked" to itself be a parameter.
 * Password fields never reach here at all — page-pilot-recorder already
 * refuses to record them, so there's nothing in `steps` to scan for that
 * case; this only reflects what's actually present in the recording.
 */
export function detectParameters(steps) {
  const candidates = [];
  steps.forEach((step, stepIndex) => {
    if (step.type === 'type' && typeof step.text === 'string' && step.text !== '') {
      const el = resolveElement(step.target);
      candidates.push({
        stepIndex,
        field: 'text',
        value: step.text,
        suggestedName: suggestFieldName(el),
        suggestedChecked: step.text.length <= LONG_VALUE_THRESHOLD,
      });
    } else if (step.type === 'select' && step.value !== undefined) {
      const el = resolveElement(step.target);
      candidates.push({
        stepIndex,
        field: 'value',
        value: step.value,
        suggestedName: suggestFieldName(el),
        suggestedChecked: true,
      });
    } else if (step.type === 'check' && typeof step.checked === 'boolean') {
      const el = resolveElement(step.target);
      candidates.push({
        stepIndex,
        field: 'checked',
        value: step.checked,
        suggestedName: suggestFieldName(el),
        suggestedChecked: false, // usually a fixed part of the flow, not something worth re-parameterizing by default
      });
    }
  });
  return candidates;
}

/** True if any step's selector had to fall back to a structural path or
 * position-based disambiguation — worth a heads-up before saving, not a
 * reason to block saving. */
export function hasFragileSteps(steps) {
  return steps.some((s) => s.fragile === true);
}

/**
 * True if any step looks like it performs a hard-to-undo action —
 * checked against a click's own visible text (when the target is a
 * { selector, text } shape) or plain-string selectors that mention one of
 * the risk words directly (covers ids/classes like #delete-btn), against
 * a fixed keyword list. This is a heuristic, not a guarantee — it exists
 * to suggest a "handle with care" flag by default, not to be relied on as
 * the only safeguard.
 */
export function isHighRisk(steps) {
  const haystack = steps
    .filter((s) => s.type === 'click' || s.type === 'chooseOption')
    .flatMap((s) => {
      const parts = [];
      const push = (t) => {
        if (typeof t === 'string') parts.push(t);
        else if (t && typeof t === 'object' && typeof t.text === 'string') parts.push(t.text);
        else if (t && typeof t === 'object' && typeof t.selector === 'string') parts.push(t.selector);
      };
      push(s.target);
      push(s.option);
      return parts;
    })
    .join(' ')
    .toLowerCase();
  return HIGH_RISK_WORDS.some((word) => haystack.includes(word.toLowerCase()));
}

/**
 * Build a "skill draft" from recorded steps: the steps with each accepted
 * parameter's value swapped for a {{name}} placeholder, plus the
 * parameter list (names only — no example values, see the note on
 * saveSkill), and the fragile/high-risk flags. `acceptedParams` is the
 * subset of detectParameters()'s output the person actually confirmed,
 * each with a final `name` (overriding suggestedName if they renamed it).
 */
export function buildSkillDraft(description, steps, acceptedParams) {
  const stepsCopy = steps.map((s) => ({ ...s }));
  for (const p of acceptedParams) {
    const step = stepsCopy[p.stepIndex];
    if (!step) continue;
    if (p.field === 'checked') {
      // `checked` is a boolean, not a string — writing "{{name}}" directly
      // into it would silently turn it into a string and break check()'s
      // type contract at run time. Use a separate marker instead, keeping
      // the originally recorded boolean in place as a safe fallback for
      // anything that fills the skill in without providing this value.
      step.checkedParam = p.name;
    } else {
      step[p.field] = `{{${p.name}}}`;
    }
  }
  return {
    description,
    steps: stepsCopy,
    parameters: acceptedParams.map((p) => ({ name: p.name })),
    fragile: hasFragileSteps(steps),
    highRisk: isHighRisk(steps),
  };
}

/**
 * Substitute real values back into a saved skill's steps: replaces every
 * `{{name}}` occurrence inside a step's `text`/`value` string with
 * `values[name]` (leaving it as the literal `{{name}}` text if that name
 * isn't in `values`, rather than silently blanking it out — a visible
 * placeholder left behind is much easier to notice and fix than an empty
 * string quietly going into a form field), and sets `checked` from
 * `values[step.checkedParam]` for any checkbox/radio parameter (falling
 * back to the originally recorded boolean if that name isn't provided).
 * Returns a new steps array — never mutates the skill passed in.
 */
export function fillSkillParameters(skill, values) {
  return skill.steps.map((step) => {
    const copy = { ...step };
    if (copy.checkedParam) {
      if (Object.prototype.hasOwnProperty.call(values, copy.checkedParam)) {
        copy.checked = !!values[copy.checkedParam];
      }
      delete copy.checkedParam;
    }
    for (const field of ['text', 'value']) {
      if (typeof copy[field] === 'string') {
        copy[field] = copy[field].replace(/\{\{(.+?)\}\}/g, (match, name) => {
          const trimmed = name.trim();
          return Object.prototype.hasOwnProperty.call(values, trimmed) ? values[trimmed] : match;
        });
      }
    }
    return copy;
  });
}

// --- storage ----------------------------------------------------------

function storageKey(domain) {
  return STORAGE_PREFIX + domain;
}

function readSkills(domain) {
  let raw;
  try {
    raw = localStorage.getItem(storageKey(domain));
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSkills(domain, skills) {
  try {
    localStorage.setItem(storageKey(domain), JSON.stringify(skills));
    return true;
  } catch {
    return false; // storage full/unavailable — caller decides how to surface this
  }
}

/**
 * Save a skill draft (from buildSkillDraft) for the given domain
 * (defaults to the current page's hostname). Assigns an id and
 * createdAt/updatedAt if not already present, and returns the saved
 * record. No example values are ever written to storage — only
 * parameter names — even if the draft object happens to carry them, as a
 * deliberate safeguard against sensitive data (names, ids, etc.) ending
 * up sitting in localStorage indefinitely.
 */
export function saveSkill(draft, domain = location.hostname) {
  const skills = readSkills(domain);
  const now = new Date().toISOString();
  const cleanParameters = draft.parameters.map((p) => ({ name: p.name })); // strip anything but the name, deliberately
  const record = {
    id: draft.id || `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    domain,
    description: draft.description,
    steps: draft.steps,
    parameters: cleanParameters,
    fragile: !!draft.fragile,
    highRisk: !!draft.highRisk,
    createdAt: draft.createdAt || now,
    updatedAt: now,
  };
  const idx = skills.findIndex((s) => s.id === record.id);
  if (idx !== -1) skills[idx] = record;
  else skills.push(record);
  writeSkills(domain, skills);
  return record;
}

/** List all skills saved for a domain (defaults to the current page's
 * hostname), most recently updated first. */
export function listSkills(domain = location.hostname) {
  return readSkills(domain).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/** Get a single skill by id, or null if not found. Searches the given
 * domain (defaults to the current page's hostname). */
export function getSkill(id, domain = location.hostname) {
  return readSkills(domain).find((s) => s.id === id) || null;
}

/** Delete a skill by id. Returns true if something was actually removed. */
export function deleteSkill(id, domain = location.hostname) {
  const skills = readSkills(domain);
  const next = skills.filter((s) => s.id !== id);
  if (next.length === skills.length) return false;
  writeSkills(domain, next);
  return true;
}

// --- archive panel UI ---------------------------------------------------

/**
 * Shows a review panel right after stopping a recording: a task
 * description field, the detected parameter candidates (checked/unchecked
 * per detectParameters' suggestion, with an editable name), the step list
 * with a delete button per step (for dropping noise like an accidental
 * click that got immediately undone), and fragile/high-risk warnings.
 *
 * Resolves with the saved skill record if the person picks "Save as
 * skill" (the save happens here — callers don't need to call saveSkill()
 * themselves), or `null` if they pick "One-time use" or close the panel
 * without choosing.
 *
 * options.domain: which domain to save under (default: location.hostname)
 */
export function showArchivePanel(steps, options = {}) {
  const domain = options.domain || location.hostname;

  return new Promise((resolve) => {
    let workingSteps = steps.map((s) => ({ ...s }));
    let candidates = detectParameters(workingSteps);

    const host = document.createElement('div');
    host.id = 'page-pilot-skills-archive-host';
    host.setAttribute('data-ppr-ignore', ''); // matches page-pilot-recorder's own-UI exclusion marker
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });

    function render() {
      const fragileWarning = hasFragileSteps(workingSteps)
        ? `<p class="warn">${workingSteps.filter((s) => s.fragile).length} step(s) use a not-fully-stable selector — consider adding a data-testid to those elements and re-recording.</p>`
        : '';

      root.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; }
          .panel {
            position: fixed; right: 16px; bottom: 16px; width: 380px; max-height: 80vh;
            display: flex; flex-direction: column;
            font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #fff; color: #111; border-radius: 12px;
            box-shadow: 0 8px 28px rgba(0,0,0,0.25); border: 1px solid #e5e7eb;
            overflow: hidden;
          }
          .header {
            padding: 10px 14px; background: #111; color: #fff; font-weight: 600; flex-shrink: 0;
          }
          .body { padding: 14px; overflow-y: auto; flex: 1; }
          label { font-size: 12px; color: #6b7280; display: block; margin-bottom: 4px; }
          input[type="text"] {
            width: 100%; height: 32px; border: 1px solid #d1d5db; border-radius: 6px;
            padding: 0 8px; font: inherit; margin-bottom: 12px;
          }
          .section-title { font-size: 12px; font-weight: 600; color: #374151; margin: 12px 0 6px; }
          .param-row, .step-row {
            display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f3f4f6;
          }
          .param-row input[type="text"] { margin-bottom: 0; height: 28px; flex: 1; }
          .param-value { color: #9ca3af; font-size: 11px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .step-desc { flex: 1; font-size: 12px; color: #374151; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .step-row .fragile-tag { font-size: 10px; color: #b45309; background: #fffbeb; padding: 1px 5px; border-radius: 4px; }
          .icon-btn {
            background: transparent; border: none; cursor: pointer; color: #9ca3af; font-size: 14px; padding: 2px 6px;
          }
          .icon-btn:hover { color: #ef4444; }
          .warn {
            background: #fffbeb; border-left: 3px solid #e5a000; padding: 8px 10px;
            border-radius: 6px; font-size: 12px; margin: 8px 0;
          }
          .risk-row { display: flex; align-items: center; gap: 6px; margin: 10px 0; font-size: 12px; }
          .footer { padding: 12px 14px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; flex-shrink: 0; }
          button.action {
            flex: 1; height: 34px; border-radius: 8px; border: 1px solid #d1d5db;
            background: #fff; font: inherit; cursor: pointer; color: #111;
          }
          button.action:hover { background: #f3f4f6; }
          button.primary { border-color: #378ADD; color: #378ADD; }
        </style>
        <div class="panel">
          <div class="header">Save this as a reusable skill?</div>
          <div class="body">
            <label for="desc-input">What does this do?</label>
            <input type="text" id="desc-input" placeholder="e.g. Add a new employee" value="${options.suggestedDescription ? String(options.suggestedDescription).replace(/"/g, '&quot;') : ''}" />

            ${candidates.length ? `
              <div class="section-title">Detected values (check the ones you want to be able to change each time)</div>
              ${candidates.map((c, i) => `
                <div class="param-row" data-candidate-index="${i}">
                  <input type="checkbox" class="param-check" ${c.suggestedChecked ? 'checked' : ''} />
                  <input type="text" class="param-name" value="${(c.suggestedName || `参数${i + 1}`).replace(/"/g, '&quot;')}" />
                  <span class="param-value" title="${String(c.value).replace(/"/g, '&quot;')}">${String(c.value).slice(0, 24)}</span>
                </div>
              `).join('')}
            ` : ''}

            <div class="section-title">Steps (${workingSteps.length})</div>
            ${workingSteps.map((s, i) => `
              <div class="step-row" data-step-index="${i}">
                <span class="step-desc">${i + 1}. ${s.type}${s.fragile ? ' <span class="fragile-tag">unstable</span>' : ''}</span>
                <button class="icon-btn delete-step" data-step-index="${i}" title="Remove this step">&#10005;</button>
              </div>
            `).join('')}

            ${fragileWarning}

            <label class="risk-row">
              <input type="checkbox" id="high-risk-check" ${isHighRisk(workingSteps) ? 'checked' : ''} />
              Mark as high-risk (requires confirmation before running later)
            </label>
          </div>
          <div class="footer">
            <button class="action" id="skip-btn">One-time use</button>
            <button class="action primary" id="save-btn">Save as skill</button>
          </div>
        </div>
      `;

      root.getElementById('save-btn').addEventListener('click', onSave);
      root.getElementById('skip-btn').addEventListener('click', onSkip);
      root.querySelectorAll('.delete-step').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.stepIndex);
          workingSteps.splice(idx, 1);
          candidates = detectParameters(workingSteps); // re-detect — indices shift after a deletion
          render();
        });
      });
    }

    function onSkip() {
      host.remove();
      resolve(null);
    }

    function onSave() {
      const description = root.getElementById('desc-input').value.trim() || 'Untitled skill';
      const highRisk = root.getElementById('high-risk-check').checked;
      const acceptedParams = [];
      root.querySelectorAll('.param-row').forEach((row) => {
        const idx = Number(row.dataset.candidateIndex);
        const checked = row.querySelector('.param-check').checked;
        if (!checked) return;
        const name = row.querySelector('.param-name').value.trim();
        if (!name) return;
        const c = candidates[idx];
        acceptedParams.push({ stepIndex: c.stepIndex, field: c.field, name });
      });
      const draft = buildSkillDraft(description, workingSteps, acceptedParams);
      draft.highRisk = highRisk; // the person's own checkbox overrides the heuristic suggestion
      const saved = saveSkill(draft, domain);
      host.remove();
      resolve(saved);
    }

    render();
  });
}
