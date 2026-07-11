/**
 * page-pilot-toolkit
 * The script a bookmarklet loads to drop a record/run panel onto whatever
 * page you're currently on. Not meant to be imported as a library — this
 * is glue between page-pilot (playback), page-pilot-recorder (recording),
 * and page-pilot-skills (turning a recording into a reusable, named
 * skill), plus a small floating UI, designed to be injected as a
 * <script type="module"> by a bookmarklet. See install.html for the
 * actual bookmarklet link.
 *
 * Loaded via jsDelivr with pinned version tags — deliberately NOT tracking
 * `main` branches, so updating a library never silently changes what an
 * already-installed bookmarklet does. Bump these constants and the version
 * in install.html's bookmarklet URL together when you want to ship an update.
 */

const PAGE_PILOT_URL = 'https://cdn.jsdelivr.net/gh/jyy1082/page-pilot@0.17.0/page-pilot.js';
const RECORDER_URL = 'https://cdn.jsdelivr.net/gh/jyy1082/page-pilot-recorder@0.5.0/page-pilot-recorder.js';
const SKILLS_URL = 'https://cdn.jsdelivr.net/gh/jyy1082/page-pilot-skills@0.2.0/page-pilot-skills.js';

if (window.__pagePilotToolkitActive) {
  // Already running on this page (clicked the bookmarklet twice) — no-op
  // rather than stacking a second panel on top of the first.
  console.log('[page-pilot-toolkit] already active on this page.');
} else {
  window.__pagePilotToolkitActive = true;
  init().catch((err) => {
    window.__pagePilotToolkitActive = false;
    console.error('[page-pilot-toolkit] failed to load:', err);
    alert(
      'PagePilot toolkit failed to load.\n\n' +
      'This can happen if the site blocks external scripts (Content-Security-Policy) — ' +
      'that\'s a security setting on the site itself, not something the bookmarklet can work around.\n\n' +
      'https://github.com/jyy1082/page-pilot-toolkit'
    );
  });
}

async function init() {
  const [{ PagePilot }, { PagePilotRecorder }, Skills] = await Promise.all([
    import(PAGE_PILOT_URL),
    import(RECORDER_URL),
    import(SKILLS_URL),
  ]);
  const { listSkills, deleteSkill, fillSkillParameters, showArchivePanel } = Skills;

  // A shadow root keeps the panel's own styles from leaking into the host
  // page and, just as importantly, keeps the host page's CSS (resets,
  // `all: unset` rules, aggressive global selectors — anything a random
  // site might have) from mangling the panel. This needs to work on
  // literally any site, so isolation isn't optional here.
  const host = document.createElement('div');
  host.id = 'page-pilot-toolkit-host';
  // Also marked data-ppr-ignore directly on the host: clicks inside a shadow
  // tree get retargeted to the host element when observed from a listener
  // outside the shadow root (e.target appears as the host, not the real
  // inner button), so the recorder's own ignore-check needs to find the
  // marker right here to correctly exclude the panel's own controls.
  host.setAttribute('data-ppr-ignore', '');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647;';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        position: fixed; right: 16px; bottom: 16px; width: 320px; max-height: 85vh;
        display: flex; flex-direction: column;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #fff; color: #111; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.25); border: 1px solid #e5e7eb;
        overflow: hidden;
      }
      .header {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        background: #111; color: #fff; flex-shrink: 0;
      }
      .header strong { flex: 1; font-weight: 600; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex-shrink: 0; }
      .dot.recording { background: #ef4444; }
      .icon-btn {
        background: transparent; border: none; color: #fff; cursor: pointer;
        font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 6px;
      }
      .icon-btn:hover { background: rgba(255,255,255,0.15); }
      .body { padding: 12px; overflow-y: auto; flex: 1; }
      .row { display: flex; gap: 8px; margin-bottom: 8px; }
      button {
        flex: 1; height: 32px; border-radius: 8px; border: 1px solid #d1d5db;
        background: #fff; font: inherit; cursor: pointer; color: #111;
      }
      button:hover:not(:disabled) { background: #f3f4f6; }
      button:disabled { opacity: 0.5; cursor: default; }
      button.primary { border-color: #378ADD; color: #378ADD; }
      textarea {
        width: 100%; height: 120px; font: 11px/1.5 ui-monospace, "SF Mono", Consolas, monospace;
        border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; resize: vertical;
        margin-bottom: 8px; color: #111; background: #fafafa;
      }
      #status { margin: 0; color: #6b7280; font-size: 12px; min-height: 16px; }
      details.skills-section { margin-bottom: 12px; border: 1px solid #e5e7eb; border-radius: 8px; }
      details.skills-section summary {
        padding: 8px 10px; cursor: pointer; font-weight: 600; font-size: 12px; color: #374151;
        list-style: none; display: flex; align-items: center; justify-content: space-between;
      }
      details.skills-section summary::-webkit-details-marker { display: none; }
      #skills-list { padding: 0 8px 8px; }
      .skill-item { border-top: 1px solid #f3f4f6; padding: 8px 0; }
      .skill-item:first-child { border-top: none; }
      .skill-desc { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
      .skill-meta { font-size: 11px; color: #9ca3af; margin-bottom: 6px; }
      .skill-meta .risk-tag { color: #b45309; background: #fffbeb; padding: 1px 5px; border-radius: 4px; margin-left: 4px; }
      .skill-actions { display: flex; gap: 6px; }
      .skill-actions button { height: 26px; font-size: 11px; }
      .param-form { margin: 6px 0; padding: 8px; background: #f9fafb; border-radius: 6px; }
      .param-form label { font-size: 11px; color: #6b7280; display: block; margin: 4px 0 2px; }
      .param-form input[type="text"] { width: 100%; height: 26px; border: 1px solid #d1d5db; border-radius: 4px; padding: 0 6px; font: inherit; }
      .empty-skills { font-size: 12px; color: #9ca3af; padding: 4px 0; }
    </style>
    <div class="panel">
      <div class="header">
        <span class="dot" id="dot"></span>
        <strong>PagePilot</strong>
        <button class="icon-btn" id="close-btn" title="Close">&#10005;</button>
      </div>
      <div class="body">
        <details class="skills-section" id="skills-section">
          <summary>My Skills <span id="skills-count"></span></summary>
          <div id="skills-list"></div>
        </details>

        <div class="row">
          <button id="record-btn" class="primary">&#9679; Start recording</button>
          <button id="stop-btn" disabled>&#9632; Stop</button>
        </div>
        <textarea id="steps-box" placeholder="Recorded steps will show up here as JSON — or paste your own steps array to run it directly."></textarea>
        <div class="row">
          <button id="run-btn" class="primary">&#9654; Run</button>
          <button id="copy-btn">Copy</button>
        </div>
        <p id="status">Idle.</p>
      </div>
    </div>
  `;

  const $ = (id) => root.getElementById(id);
  const dot = $('dot');
  const recordBtn = $('record-btn');
  const stopBtn = $('stop-btn');
  const runBtn = $('run-btn');
  const copyBtn = $('copy-btn');
  const closeBtn = $('close-btn');
  const stepsBox = $('steps-box');
  const status = $('status');
  const skillsCount = $('skills-count');
  const skillsList = $('skills-list');
  const say = (t) => { status.textContent = t; };

  /** Shared by the main Run button and running a saved skill — same
   * visual feedback and the same safety options either way. */
  async function runSteps(steps) {
    const cursor = new PagePilot({
      showPageGlow: true,
      pageGlowMessage: 'PagePilot is running \u2014 please wait...',
      // Bookmarklet users are running arbitrary recorded/pasted/saved
      // steps with no realistic way to hand-insert a waitForFrameReload()
      // step, so this needs to be automatic here even though it's opt-in
      // in the underlying library.
      autoWaitForIframeReload: true,
      // Same reasoning: if an earlier step didn't actually close a modal,
      // there's no way for someone running steps through this panel to
      // notice and fix that mid-run — better to stop with a clear error
      // than silently click through the backdrop to whatever's behind it.
      verifyClickable: true,
    });
    try {
      await cursor.run(steps);
      say('Done.');
    } catch (err) {
      say(`Run failed: ${err.message}`);
    } finally {
      cursor.destroy();
    }
  }

  /** Does this skill have any checkbox/radio-backed parameter? Used to
   * decide whether a parameter's fill-in input should be a checkbox or a
   * plain text field. */
  function isCheckedParam(skill, paramName) {
    return skill.steps.some((s) => s.checkedParam === paramName);
  }

  function renderSkillsList() {
    const skills = listSkills();
    skillsCount.textContent = skills.length ? `(${skills.length})` : '';
    if (skills.length === 0) {
      skillsList.innerHTML = '<p class="empty-skills">No skills saved for this site yet — stop a recording to save one.</p>';
      return;
    }
    skillsList.innerHTML = skills.map((skill) => `
      <div class="skill-item" data-skill-id="${skill.id}">
        <div class="skill-desc">${skill.description}${skill.highRisk ? '<span class="risk-tag">high-risk</span>' : ''}</div>
        <div class="skill-meta">${skill.parameters.length} parameter(s)${skill.fragile ? ' · has an unstable selector' : ''}</div>
        <div class="skill-actions">
          <button class="run-skill-btn">Run</button>
          <button class="delete-skill-btn">Delete</button>
        </div>
        <div class="param-form-container"></div>
      </div>
    `).join('');

    skillsList.querySelectorAll('.skill-item').forEach((item) => {
      const skillId = item.dataset.skillId;
      const skill = skills.find((s) => s.id === skillId);

      item.querySelector('.delete-skill-btn').addEventListener('click', () => {
        if (!confirm(`Delete the skill "${skill.description}"? This cannot be undone.`)) return;
        deleteSkill(skillId);
        renderSkillsList();
      });

      item.querySelector('.run-skill-btn').addEventListener('click', () => {
        const container = item.querySelector('.param-form-container');
        if (container.dataset.open === 'true') {
          container.innerHTML = '';
          container.dataset.open = 'false';
          return;
        }
        container.dataset.open = 'true';
        container.innerHTML = `
          <div class="param-form">
            ${skill.parameters.map((p, i) => `
              <label for="param-${i}">${p.name}</label>
              ${isCheckedParam(skill, p.name)
                ? `<input type="checkbox" id="param-${i}" data-param-name="${p.name}" />`
                : `<input type="text" id="param-${i}" data-param-name="${p.name}" />`
              }
            `).join('')}
            <div class="row" style="margin-top:8px; margin-bottom:0;">
              <button class="primary confirm-run-btn">Run this skill</button>
            </div>
          </div>
        `;
        container.querySelector('.confirm-run-btn').addEventListener('click', async () => {
          if (skill.highRisk && !confirm(`"${skill.description}" is marked high-risk. Run it anyway?`)) return;
          const values = {};
          container.querySelectorAll('[data-param-name]').forEach((input) => {
            values[input.dataset.paramName] = input.type === 'checkbox' ? input.checked : input.value;
          });
          const filled = fillSkillParameters(skill, values);
          say(`Running "${skill.description}"...`);
          await runSteps(filled);
        });
      });
    });
  }

  const recorder = new PagePilotRecorder({
    ui: false,
    onStep: () => { stepsBox.value = JSON.stringify(recorder.steps, null, 2); },
  });

  recordBtn.addEventListener('click', () => {
    recorder.start();
    recordBtn.disabled = true;
    stopBtn.disabled = false;
    dot.classList.add('recording');
    say('Recording — interact with the page normally.');
  });

  stopBtn.addEventListener('click', async () => {
    const steps = recorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    dot.classList.remove('recording');
    // The steps box always gets the ORIGINAL recorded values (not
    // templated with {{name}} placeholders) so Run/Copy keep working on
    // exactly what was just recorded, whether or not it also gets saved
    // as a skill below.
    stepsBox.value = JSON.stringify(steps, null, 2);
    say(`Stopped — ${steps.length} step(s). Review below.`);

    if (steps.length === 0) return;
    const saved = await showArchivePanel(steps);
    if (saved) {
      say(`Saved as a skill: "${saved.description}". You can also just Run/Copy what you recorded below.`);
      renderSkillsList();
    } else {
      say(`Stopped — ${steps.length} step(s). Edit the JSON if needed, then Run or Copy.`);
    }
  });

  runBtn.addEventListener('click', async () => {
    let steps;
    try {
      steps = JSON.parse(stepsBox.value || '[]');
      if (!Array.isArray(steps)) throw new Error('not an array');
    } catch {
      say('Could not parse the JSON above — check it\'s a valid steps array.');
      return;
    }
    runBtn.disabled = true;
    say('Running...');
    await runSteps(steps);
    runBtn.disabled = false;
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(stepsBox.value);
      say('Copied to clipboard.');
    } catch {
      say('Could not access the clipboard — select and copy the text manually.');
    }
  });

  closeBtn.addEventListener('click', () => {
    recorder.stop();
    host.remove();
    window.__pagePilotToolkitActive = false;
  });

  renderSkillsList();
}
