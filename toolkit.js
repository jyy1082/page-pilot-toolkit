/**
 * page-pilot-toolkit
 * The script a bookmarklet loads to drop a record/run panel onto whatever
 * page you're currently on. Not meant to be imported as a library — this
 * is glue between page-pilot (playback) and page-pilot-recorder (recording),
 * plus a small floating UI, designed to be injected as a <script type="module">
 * by a bookmarklet. See install.html for the actual bookmarklet link.
 *
 * Loaded via jsDelivr with pinned version tags for page-pilot and
 * page-pilot-recorder — deliberately NOT tracking their `main` branches, so
 * updating either library never silently changes what an already-installed
 * bookmarklet does. Bump these two constants and the version in
 * install.html's bookmarklet URL together when you want to ship an update.
 */

const PAGE_PILOT_URL = 'https://cdn.jsdelivr.net/gh/jyy1082/page-pilot@0.13.0/page-pilot.js';
const RECORDER_URL = 'https://cdn.jsdelivr.net/gh/jyy1082/page-pilot-recorder@0.5.0/page-pilot-recorder.js';

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
  const [{ PagePilot }, { PagePilotRecorder }] = await Promise.all([
    import(PAGE_PILOT_URL),
    import(RECORDER_URL),
  ]);

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
        position: fixed; right: 16px; bottom: 16px; width: 320px;
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: #fff; color: #111; border-radius: 12px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.25); border: 1px solid #e5e7eb;
        overflow: hidden;
      }
      .header {
        display: flex; align-items: center; gap: 8px; padding: 10px 12px;
        background: #111; color: #fff;
      }
      .header strong { flex: 1; font-weight: 600; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7280; flex-shrink: 0; }
      .dot.recording { background: #ef4444; }
      .icon-btn {
        background: transparent; border: none; color: #fff; cursor: pointer;
        font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 6px;
      }
      .icon-btn:hover { background: rgba(255,255,255,0.15); }
      .body { padding: 12px; }
      .row { display: flex; gap: 8px; margin-bottom: 8px; }
      button {
        flex: 1; height: 32px; border-radius: 8px; border: 1px solid #d1d5db;
        background: #fff; font: inherit; cursor: pointer; color: #111;
      }
      button:hover:not(:disabled) { background: #f3f4f6; }
      button:disabled { opacity: 0.5; cursor: default; }
      button.primary { border-color: #378ADD; color: #378ADD; }
      textarea {
        width: 100%; height: 140px; font: 11px/1.5 ui-monospace, "SF Mono", Consolas, monospace;
        border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; resize: vertical;
        margin-bottom: 8px; color: #111; background: #fafafa;
      }
      #status { margin: 0; color: #6b7280; font-size: 12px; min-height: 16px; }
    </style>
    <div class="panel">
      <div class="header">
        <span class="dot" id="dot"></span>
        <strong>PagePilot</strong>
        <button class="icon-btn" id="close-btn" title="Close">&#10005;</button>
      </div>
      <div class="body">
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
  const say = (t) => { status.textContent = t; };

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

  stopBtn.addEventListener('click', () => {
    recorder.stop();
    stepsBox.value = JSON.stringify(recorder.steps, null, 2);
    recordBtn.disabled = false;
    stopBtn.disabled = true;
    dot.classList.remove('recording');
    say(`Stopped — ${recorder.steps.length} step(s). Edit the JSON if needed, then Run or Copy.`);
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
    const cursor = new PagePilot({ showPageGlow: true, pageGlowMessage: 'PagePilot is running \u2014 please wait...' });
    try {
      await cursor.run(steps);
      say('Done.');
    } catch (err) {
      say(`Run failed: ${err.message}`);
    } finally {
      cursor.destroy();
      runBtn.disabled = false;
    }
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
}
