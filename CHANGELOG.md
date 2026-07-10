# Changelog

All notable changes to this project are documented in this file, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
