# page-pilot-toolkit

[中文](./README.zh-CN.md) · **English**

**Version 0.7.0** · see [CHANGELOG.md](./CHANGELOG.md) for release history

A bookmarklet that drops a record/run panel onto whatever page you're
currently on — no install, no browser extension, no build step. Drag one
link to your bookmarks bar, click it on any site.

Built entirely on top of two existing libraries:
- [page-pilot](https://github.com/jyy1082/page-pilot) — plays back a
  recorded sequence with a visible cursor, click ripples, and highlight
  borders, so it's obvious what's happening and where.
- [page-pilot-recorder](https://github.com/jyy1082/page-pilot-recorder) —
  turns real clicks/typing/selecting into the exact step array page-pilot's
  `run()` expects.

`toolkit.js` is the glue: a small floating panel with Start/Stop/Run/Copy,
loaded by the bookmarklet.

## Install

**[Open the install page](https://jyy1082.github.io/page-pilot-toolkit/install.html)**
and drag the button there to your bookmarks bar. (Dragging is how you
install it — clicking it on that page won't do much useful, since the demo
page itself has nothing worth recording.)

## Usage

1. Go to any site, click the **PagePilot** bookmark.
2. A panel appears in the corner. Press **Start recording**, then use the
   page normally — type, click, select, whatever the task needs.
3. Press **Stop**. The recorded steps appear as JSON in the box, and a
   second panel asks whether to save this as a reusable skill (see "My
   Skills" below) or use it just this once.
4. Press **Run** to play the recorded steps back right there, or **Copy**
   to take the JSON elsewhere (paste it into `cursor.run(steps)` in your
   own code).
5. You can also paste a hand-written steps array into the box and press
   Run directly — recording isn't required.

## My Skills

Saving a recording as a skill (via the panel that appears after Stop)
turns specific typed/selected values into named, reusable parameters —
built on [page-pilot-skills](https://github.com/jyy1082/page-pilot-skills).
Expand **My Skills** at the top of the panel to see everything saved for
the site you're currently on:

- **Run** shows a small form — one field per parameter — fill in new
  values and run the skill with them, instead of whatever was typed
  during the original recording.
- Skills marked **high-risk** (detected from common dangerous-action
  words like delete/submit/pay, or set manually when saving) ask for an
  extra confirmation before running.
- **Delete** removes a skill for good, with a confirmation first.

Nothing here involves AI — matching a new instruction to the right skill,
and figuring out what values to fill in from a sentence someone typed, is
a separate, later layer built on top of what gets saved here. This part
is entirely manual: you pick the skill, you type the values, you press Run.

If a step reloads an iframe's content (common for embedded payment widgets
or multi-step forms), the panel automatically waits for that reload to
finish before continuing — no manual wait step needed, since there's no
practical way to hand-edit a wait step into recorded or pasted JSON here.

If an earlier step didn't actually close a modal dialog, the panel refuses
to click through its backdrop to whatever's behind it — a real mouse could
never do that either, so it stops with a clear error instead of silently
interacting with the wrong thing.

## What it deliberately doesn't do

- **The JSON box itself doesn't persist between visits.** Closing the tab
  (or the panel) loses whatever's currently in the text box — copy it out
  first if you want to keep it as-is. Saved *skills* are the one
  exception: choosing "Save as skill" after Stop does persist (see "My
  Skills" above), specifically as named, reusable parameters rather than
  a fixed one-off script.
- **Never records password fields**, on any site, no matter what — this is
  a hard rule enforced inside page-pilot-recorder itself, not something
  layered on top here.
- **Can't run on every site.** A site with a strict Content-Security-Policy
  can block the external `<script>` the bookmarklet injects entirely — the
  panel just won't appear (you'll see an alert explaining that). That's the
  site's own security setting; a bookmarklet has no privilege to work
  around it. A browser extension would, a bookmarklet doesn't.

## Security notes

- A page you run this on gets exactly the same access your browser session
  already has to it — same as any bookmarklet or user script. Don't run it
  anywhere you wouldn't otherwise paste arbitrary JavaScript into.
- `page-pilot.js`, `page-pilot-recorder.js`, and `page-pilot-skills.js` are
  loaded from [jsDelivr](https://www.jsdelivr.net/) at **pinned version
  tags**, not their `main` branches — so none of these libraries updating
  later silently changes what an already-installed bookmarklet does. See
  "Updating" below.
- Saved skills live in that site's own `localStorage`, same as any other
  site data — clearing the browser's site data for it removes them too.
  page-pilot-skills deliberately never stores example values, only
  parameter names, specifically so nothing typed during recording (names,
  ids, etc.) ends up sitting there indefinitely.
- The panel renders inside a closed-off
  [Shadow DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM)
  so the host page's own CSS can't visually break it, and so it can't leak
  its own styles onto the host page either.

## Updating

The bookmarklet's URL is pinned to a specific version
(`page-pilot-toolkit@0.7.0`, and pinned versions of page-pilot /
page-pilot-recorder inside `toolkit.js` itself). An already-installed
bookmark keeps working exactly the same way even after this repo changes —
to pick up a new version, revisit the install page and drag the (updated)
button again.

## Testing

```bash
npm install
npm test
```

Runs a real-browser suite (Playwright + Chromium via `@sparticuz/chromium`
— see [page-pilot-recorder's README](https://github.com/jyy1082/page-pilot-recorder#testing)
for why that specific detour exists) that simulates clicking the
bookmarklet, drives the resulting Shadow DOM panel the way a real user
would, and verifies the record → run round trip, the password exclusion,
and that closing/reopening the panel works correctly. jsDelivr isn't
reachable from this sandbox, so tests serve local vendored copies of
page-pilot.js/page-pilot-recorder.js instead of the real CDN URLs.

## License

MIT
