# Changelog

All notable changes to this project are documented in this file, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] — page-pilot-skills integration

### Added
- Stopping a recording now shows [page-pilot-skills](https://github.com/jyy1082/page-pilot-skills)'s
  archive panel — save the recording as a reusable, named skill (turning
  specific typed/selected values into named parameters) or use it just
  this once. The JSON box always keeps the originally recorded values
  either way, so Run/Copy on what you just recorded keep working
  immediately regardless of whether it was also saved.
- A **My Skills** section at the top of the panel lists everything saved
  for the current site: **Run** opens a small form (one field per
  parameter) to fill in new values and run the skill with them; skills
  marked high-risk ask for an extra confirmation first; **Delete** removes
  one for good, with a confirmation.
- Pinned `page-pilot-skills` at 0.2.0.
- 5 new real-browser tests: the full save → appears in My Skills flow,
  running a saved skill with values different from what was originally
  recorded, deleting a skill, and the high-risk confirmation dialog.

### Documentation
- Corrected an outdated claim that nothing persists between visits — the
  JSON text box itself still doesn't, but saved skills now deliberately
  do (as named parameters, via page-pilot-skills, never as raw example
  values — see its own README for why). Added a security note about
  skills living in the site's own `localStorage`.

## [0.6.1]

### Changed
- Pinned page-pilot version bumped to 0.17.0, which adds an
  `onObstruction` callback for library consumers writing their own scripts
  (not directly usable from this panel's JSON-based UI, since there's no
  way to provide a JS callback through it — the panel's Run button keeps
  using the default error behavior when something is blocked).

## [0.6.0] — Modal/overlay obstruction detection

### Changed
- Pinned page-pilot version bumped to 0.16.0, and the Run button now
  passes `verifyClickable: true` when creating its PagePilot instance.
  Fixes the exact real-world risk: if a step in a recorded/pasted sequence
  clicks through a modal dialog's backdrop that hadn't actually closed
  (its own close button didn't work as expected, or something it was
  waiting on never resolved), a real mouse could never reach whatever's
  behind it — but this library, dispatching events straight to a resolved
  element, silently could and would, interacting with the wrong thing with
  no indication anything was wrong. With this on, such a click now throws
  a clear error instead of going through. Bookmarklet users have no
  realistic way to notice and fix this mid-run, so it needed to be
  automatic here even though it's opt-in in the underlying library.
- New real-browser test confirming the panel's own Run button (not just
  the underlying library) correctly refuses to click a button still
  covered by an open modal backdrop.

## [0.5.1]

### Changed
- Pinned page-pilot version bumped to 0.15.0, which fixes the default
  click behavior to dispatch a fuller mousedown/mouseup/click sequence
  instead of just `el.click()` alone. Real-world admin dashboards and UI
  frameworks (dropdown menus, tab switches — AceAdmin among them) often
  bind their actual behavior to `mousedown` instead of `click`, and would
  otherwise silently never respond even though the cursor animation played
  correctly.

## [0.5.0] — Automatic iframe-reload handling

### Changed
- Pinned page-pilot version bumped to 0.14.0, and the Run button now
  passes `autoWaitForIframeReload: true` when creating its PagePilot
  instance. Fixes the exact real-world race: clicking a button that
  reloads an iframe's content (whether the button is inside the iframe or
  on the parent page), then immediately clicking something in what should
  be the new content — without this, the next step could run before the
  iframe finished reloading and hit a stale, about-to-be-replaced button
  instead. Bookmarklet users have no realistic way to hand-insert a wait
  step into recorded/pasted JSON, so this needed to be automatic here even
  though it's opt-in in the underlying library.
- New real-browser test confirming the panel's own Run button (not just
  the underlying library) correctly waits through an iframe reload with no
  manual intervention.

## [0.4.2]

### Changed
- Pinned page-pilot version bumped to 0.13.0, which adds
  `waitForFrameReload()` — waits for a same-origin iframe's own content to
  actually reload, fixing a race where the step right after a click that
  triggers an iframe reload can otherwise run before that reload has even
  started, hitting stale content.

## [0.4.1]

### Changed
- Pinned page-pilot version bumped to 0.12.1, which fixes `waitFor()`
  incorrectly polling a stale document if an iframe navigates or reloads
  its own content while waiting (e.g. an embedded payment widget or
  multi-step form that reloads just that iframe, without the top page
  navigating at all).

## [0.4.0]

### Changed
- Pinned versions bumped to page-pilot 0.12.0 and page-pilot-recorder 0.5.0,
  which add text-based matching for buttons/links (`{ selector, text }`
  targets) — often the most human-recognizable and redesign-resistant way
  to identify a button that has no id/aria-label/data attribute at all.

## [0.3.0]

### Changed
- Pinned page-pilot version bumped to 0.11.0, which adds
  `waitFor(target, { state: 'gone' })` — fixes a real race condition on
  pages that update content asynchronously without a full navigation,
  where replaying a step right after one that triggers such an update
  could run ahead of it and hit a stale element.

## [0.2.0]

### Changed
- Pinned versions bumped to page-pilot 0.10.0 and page-pilot-recorder 0.4.0,
  which add duplicate-`id` disambiguation (`{ selector, index }` targets) —
  real, especially older or messier, sites often have more than one element
  sharing the same `id`, and recorded steps for such elements now resolve
  correctly on replay instead of always hitting the first match.
- Also fixes the earlier tag/version-pinning setup: the very first release
  referenced version tags on page-pilot/page-pilot-recorder that hadn't
  actually been created as real git tags yet, so jsDelivr's `@version`
  URLs 404'd and the bookmarklet silently did nothing. All three repos now
  have proper tags matching every pinned version referenced anywhere.

## [0.1.0] — Initial release

### Added
- `toolkit.js`: loaded by a bookmarklet, dynamically imports pinned versions
  of page-pilot and page-pilot-recorder from jsDelivr, and renders a
  floating record/run panel inside a closed-off Shadow DOM so it can't be
  visually broken by (or leak styles onto) whatever site it's running on.
- Panel controls: Start/Stop recording, an editable JSON textarea showing
  the recorded steps, Run (plays them back with `showPageGlow` +
  `pageGlowMessage` for visible feedback), and Copy (to clipboard).
- Running a hand-written steps array works the same way as running a
  recorded one — pasting into the box and pressing Run doesn't require
  recording first.
- `install.html`: the page with the actual draggable bookmarklet link and
  usage/security notes.
- A real-browser test suite (`test/browser-test.mjs`, `npm test`) covering
  the full record → stop → run round trip through the panel UI, pasting
  and running hand-written steps, password-field exclusion end-to-end,
  Copy-to-clipboard, and closing/reopening the panel.

### Fixed (found via the real-browser tests before shipping)
- Re-"clicking" the bookmarklet after closing the panel did nothing: an ES
  module script is only ever evaluated once per exact URL, so injecting a
  second `<script type="module">` pointing at the identical jsDelivr URL
  silently no-ops instead of re-running `toolkit.js`'s top-level code.
  Fixed by appending a `?t=<timestamp>` cache-buster to the script URL each
  time the bookmarklet runs, forcing a fresh module evaluation.
- Clicks inside the Shadow DOM panel get retargeted when observed by a
  listener outside the shadow root (`event.target` appears as the shadow
  host element, not the actual button clicked inside it) — this meant the
  recorder's own `data-ppr-ignore` exclusion check couldn't find the marker
  by walking up from the real target. Fixed by also putting
  `data-ppr-ignore` directly on the shadow host element itself, which is
  what a retargeted event's `target` actually resolves to.
