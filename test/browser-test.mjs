/**
 * Real-browser test suite for page-pilot-toolkit. Serves a local copy of
 * toolkit.js with its two jsDelivr URLs swapped for local ones (this
 * sandbox can't reach cdn.jsdelivr.net), then simulates clicking the
 * bookmarklet by evaluating the same code the bookmarklet's javascript:
 * URL runs, and drives the resulting shadow-DOM panel exactly like a real
 * user would (Playwright's locators pierce open shadow roots by default).
 *
 * Run: node test/browser-test.mjs
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const sparticuzChromium = require('@sparticuz/chromium').default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ok -', name); }
  else { fail++; console.error('  FAIL -', name); }
}

function startServer() {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
  const server = http.createServer(async (req, res) => {
    try {
      const urlNoQuery = req.url.split('?')[0];
      if (urlNoQuery === '/toolkit.js') {
        let src = await readFile(path.join(ROOT, 'toolkit.js'), 'utf8');
        src = src
          .replace(
            /const PAGE_PILOT_URL = .*;/,
            "const PAGE_PILOT_URL = '/vendor/page-pilot.js';"
          )
          .replace(
            /const RECORDER_URL = .*;/,
            "const RECORDER_URL = '/vendor/page-pilot-recorder.js';"
          );
        res.writeHead(200, { 'Content-Type': 'text/javascript' });
        res.end(src);
        return;
      }
      const urlPath = req.url === '/' ? '/test/fixture.html' : req.url;
      const filePath = path.join(ROOT, urlPath.startsWith('/vendor') ? `test${urlPath}` : urlPath);
      const body = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** Exactly what the bookmarklet's javascript: URL does, minus the CDN pin
 * (the local test server rewrites toolkit.js to point at vendored copies). */
function clickBookmarklet(base) {
  return (async () => {
    if (window.__pagePilotToolkitActive) return;
    const s = document.createElement('script');
    s.type = 'module';
    s.src = `${base}/toolkit.js?t=${Date.now()}`;
    document.documentElement.appendChild(s);
  })();
}

async function main() {
  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;

  const executablePath = await sparticuzChromium.executablePath();
  const launchArgs = sparticuzChromium.args.filter(
    (a) => a !== '--single-process' && a !== '--no-zygote'
  );
  const browser = await chromium.launch({ executablePath, args: launchArgs, headless: true });
  let intentionalClose = false;
  browser.on('disconnected', () => {
    if (!intentionalClose) console.error('[browser] disconnected unexpectedly');
  });

  async function freshPageWithPanel() {
    const page = await browser.newPage();
    await page.goto(`${base}/test/fixture.html`);
    await page.evaluate(clickBookmarklet, base);
    await page.getByText('PagePilot').first().waitFor();
    return page;
  }

  console.log('=== bookmarklet injects the panel ===');
  {
    const page = await freshPageWithPanel();
    const panelVisible = await page.locator('text=PagePilot').first().isVisible();
    check('panel is visible after "clicking" the bookmarklet', panelVisible);
    await page.close();
  }

  console.log('=== clicking the bookmarklet twice does not stack two panels ===');
  {
    const page = await freshPageWithPanel();
    await page.evaluate(clickBookmarklet, base);
    await page.waitForTimeout(200);
    const hostCount = await page.locator('#page-pilot-toolkit-host').count();
    check('still exactly one panel host', hostCount === 1);
    await page.close();
  }

  console.log('=== record -> stop -> run round trip through the panel UI ===');
  {
    const page = await freshPageWithPanel();
    await page.locator('#record-btn').click();
    await page.locator('#name-input').click();
    await page.keyboard.type('Jane Cooper');
    await page.locator('#submit-btn').click();
    await page.locator('#stop-btn').click();

    const stepsJson = await page.locator('textarea').inputValue();
    const steps = JSON.parse(stepsJson);
    check('recorded a type step for the input', steps.some((s) => s.type === 'type' && s.text === 'Jane Cooper'));
    check('recorded a click step for the submit button', steps.some((s) => s.type === 'click' && s.target === '#submit-btn'));

    // Reset the fixture, then Run the recorded steps back through the panel.
    await page.fill('#name-input', '');
    await page.locator('#run-btn').click();
    await page.waitForFunction(() => document.getElementById('name-input').value === 'Jane Cooper', { timeout: 5000 });
    check('Run button replays the recorded steps correctly', true);
    await page.close();
  }

  console.log('=== pasting a hand-written steps array and running it works without recording first ===');
  {
    const page = await freshPageWithPanel();
    const handWritten = JSON.stringify([{ type: 'click', target: '#submit-btn' }]);
    await page.locator('textarea').fill(handWritten);
    let clicked = false;
    await page.exposeFunction('__markClicked', () => { clicked = true; });
    await page.evaluate(() => {
      document.getElementById('submit-btn').addEventListener('click', () => window.__markClicked());
    });
    await page.locator('#run-btn').click();
    await page.waitForTimeout(500);
    check('hand-written JSON runs without needing to record first', clicked);
    await page.close();
  }

  console.log('=== password field is never recorded, even through the panel ===');
  {
    const page = await freshPageWithPanel();
    await page.locator('#record-btn').click();
    await page.locator('#password-field').click();
    await page.keyboard.type('super-secret-123');
    await page.locator('#submit-btn').click();
    await page.locator('#stop-btn').click();
    const stepsJson = await page.locator('textarea').inputValue();
    check('the password text never appears in the recorded output', !stepsJson.includes('super-secret-123'));
    await page.close();
  }

  console.log('=== Copy button writes the steps JSON to the clipboard ===');
  {
    const page = await freshPageWithPanel();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.locator('textarea').fill('[{"type":"click","target":"#submit-btn"}]');
    await page.locator('#copy-btn').click();
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    check('clipboard contains the steps JSON from the box', clipboardText.includes('#submit-btn'));
    await page.close();
  }

  console.log('=== Close button removes the panel and allows reopening ===');
  {
    const page = await freshPageWithPanel();
    await page.locator('#close-btn').click();
    await page.waitForTimeout(200);
    const hostCountAfterClose = await page.locator('#page-pilot-toolkit-host').count();
    check('panel is removed after closing', hostCountAfterClose === 0);

    await page.evaluate(clickBookmarklet, base);
    await page.getByText('PagePilot').first().waitFor();
    const reopened = await page.locator('#page-pilot-toolkit-host').count();
    check('bookmarklet can be "clicked" again after closing to reopen the panel', reopened === 1);
    await page.close();
  }

  console.log('=== the panel itself is never recorded as part of a session ===');
  {
    const page = await freshPageWithPanel();
    await page.locator('#record-btn').click();
    await page.locator('#name-input').click();
    await page.keyboard.type('hello');
    await page.locator('#stop-btn').click();
    const stepsJson = await page.locator('textarea').inputValue();
    const steps = JSON.parse(stepsJson);
    check('no step targets anything inside the toolkit panel itself',
      !steps.some((s) => JSON.stringify(s).includes('page-pilot-toolkit')));
    await page.close();
  }

  intentionalClose = true;
  await browser.close();
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
