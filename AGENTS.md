# AGENTS.md

Kage Scribe: a Chrome MV3 extension that live-captures the messages API on
`*.isekaizero.ai` / `*.kagesekai.ai`, merges paginated responses into one
transcript per chat, and exports CSV / JSON / XLSX / DOCX (storybook).

No build step, bundler or runtime dependency. MV3 forbids remote code, so the
XLSX/DOCX writers are hand-rolled store-only ZIP generators in
`extension/lib/exporter.js`. Do not change version numbers for feature, fix,
documentation or test work. Only bump versions as part of an actual release
when the user explicitly asks for it; during that release, keep
`extension/manifest.json`, `package.json` and the root package in
`package-lock.json` in sync.

`extension/` is the folder Chrome loads (runtime files only); `tests/`,
`tools/`, `package.json`, `README.md` stay at the repo root. Source paths below
are relative to `extension/`.

## Commands

- `npm test` (run `npm install` once first) — `node --check` on every extension
  script, 7 test files, then the XLSX/DOCX validators. Run before declaring
  any change done.
- One file: `node tests/test-background.cjs` (any `tests/test-*`, any cwd).
- The validators read `tests/out/messages.xlsx` / `transcript.docx` /
  `transcript-colored.docx`, written by `test-export.cjs`; if missing,
  `run-all.mjs` skips them. The colored file is validated with `--colored`
  (6 parts with its cover, per-role run colors).
- `npm run icons` — regenerate `extension/icons/*.png`.
- `npm run screenshots` — retake `docs/screenshots/*.png` (headless Chrome, real
  panel/popup, made-up chats). Rerun after a visible panel/popup change. Never
  screenshot real data: the README is public.
- `npm run release` — zips committed `HEAD:extension` to
  `dist/kage-scribe-<version>.zip`. For an actual GitHub release, run
  `npm test`, then `npm run release`, and upload that generated ZIP. Its root
  must contain only the contents of `extension/`, never the repository or an
  enclosing `extension/` folder. Never remove the manifest `key` once shipped:
  it fixes the extension ID, and removing it resets every install's storage.
- Not automated: panel/popup DOM. Check by loading `extension/` unpacked at
  `chrome://extensions`.

## Architecture

```
page (kagesekai.ai)              background (service worker)      panel/popup
content/hook.js  (MAIN world)    background.js                    panel/panel.js
  patches fetch + XHR at           - owns ALL state (storage.local)   - reads via ks:getState,
  document_start, clones            - merge/dedup by message _id      never writes storage
  matching bodies                   - chat-name sniffing              - exports via lib/exporter.js
  → window.postMessage              - "fetch all pages" replay
content/bridge.js (ISOLATED)        - ks:* message router
  relays page↔SW, pushes settings
```

- `lib/merge.js` (`globalThis.KSMerge`) is loaded by the SW (`importScripts`),
  the panel (`<script>`) and Node tests (`require`). Keep it dependency-free.
- `lib/exportflow.js` (`globalThis.KSFlow`) is panel/test-only, loads after
  `merge.js`. It holds the chat/role/search/order filters (the table and every
  export share them), summaries, the completeness check, the
  load-before-export wait/retry loop, and the Word storybook colors
  (`DOCX_PRESETS`, `resolveDocxColors` — presets are light-only by decision).
- `chrome.storage.local` keys: `ks_settings` (`{enabled}` plus the Word
  storybook colors `docxColors`: the 7 known roles, each `''` or `RRGGBB`,
  cleaned in `sanitizeSettings`; the capture filter and messages pattern are
  constants), `ks_raw`, `ks_merged` (map keyed
  by message `_id`, last seen wins), `ks_chats`, `ks_fetch`. A new key needs an
  entry in the `field` map of `flush()`, or it is written as `undefined`.
- Only the background writes state. Panel/popup use `ks:*` runtime messages
  (`ks:settings`, `ks:clear`, `ks:removeChat`, `ks:fetchAll`).
- Deletions are reconciled by `reconcileFirstPage`/`reconcileChat` with
  conservative guards (page 1 only, newest-first verified; empty, unsorted or
  page>1 is inconclusive). `updateChatTotals` flags `meta.stale` when live
  count > server `totalCount`. Nothing fetches by itself.
- A messages capture's raw entry carries `formatOk` (false = HTTP 200 but no
  readable messages) and `msgCount`; `healthOf` turns them into the popup/badge
  warning.
- Message text lives in `choices[]`; the selected variant is resolved by
  `_selectedChoiceId`, then `choiceIndex`, then first. This is the most
  load-bearing convention. `content` is required in exports.

## Conventions and constraints

- Classic scripts only (no ES modules): content scripts and `importScripts`
  must load them. `.mjs` is for test runners only.
- Trust: page scripts share the MAIN world with `hook.js`, so captures can be
  forged. Keep all four defences when touching capture or fetch-all: (1) accept
  `ks:capture` only from a site tab (`sender.tab`, non-extension `sender.url`);
  (2) rebuild each capture in `cleanEntry` (known fields, types, size caps);
  (3) keep `merged`/`chats` as null-prototype maps (`idMap`); (4) replay auth
  headers only to https hosts in `SITE_DOMAINS` (`siteOf`).
- Extension pages: no inline scripts or `on*` handlers (MV3 CSP). Build DOM with
  `textContent`, never `innerHTML` (captured data is untrusted).
- MAIN-world content script (`run_at: document_start`) needs Chrome 111+.
- `isMessagesCapture` (GET whose path ends at `MESSAGES_PATTERN`) is used by
  merge, reconcile, fetch-all and health. `sniffChatMeta` must keep excluding
  `/messages` URLs.
- Every full-chat reload starts from a user click (Export, "Reload full chat"):
  the sites forbid automated collection. Export reloads when live count !==
  `totalCount`, with no repeat guard. A failed reload with live > total goes on
  with a warning; with live < total it is an error.
- Export rules:
  - CSV/JSON never truncate. CSV text cells starting with `= + - @`, tab or CR
    get a leading `'` (`csvCell`). XLSX truncates cells at 32k chars.
  - DOCX storybook (`KSFlow.storyBlocks` → `buildDOCX(story, colors)`): per
    chat a title block, then messages oldest first; OOC (`type: 'ooc'`)
    dropped; user messages carry the bold persona name ("You" if empty); a
    leading scene header is one small italic line. Story markup, one pass,
    leftmost span wins, nesting stays literal: `**strong**` → bold
    (`BOLD_SRC`), quoted spans (`DIALOGUE_SRC`, straight/curly double quotes)
    → dialogue color, `*action*` → italic (`ITALIC_SRC`) in the thoughts
    color; the dialogue and thoughts colors tint story text only — user
    turns keep the persona color; all three patterns are shared with
    `validate_docx.mjs`. Colors come from `KSFlow.resolveDocxColors`
    (settings over the Print defaults, which `buildDOCX` also applies when
    called bare — `test-export.cjs` pins them equal). The story cover comes
    from `storylineSnapshot.cover.url` (thumbnail fallback), is converted from
    WebP to PNG only during export, and is never stored as image bytes. Direct
    formatting only; a cover adds its media part and document relationship.
    A page tint adds `word/settings.xml` with `displayBackgroundShape`; Word
    shows the tint on screen, not in print.
  - `Block (20 msgs)` is the last column of CSV/Excel/JSON. `KSFlow.blockNumbers`
    runs on the whole store before any filter (per chat, oldest first, OOC
    skipped), so filters never move a number.
- Storage caps are in `LIMITS` in `background.js`; raw eviction drops
  non-messages entries first. Merged messages are uncapped.
- Chrome caps a runtime message at 64 MB, so `ks:getState` omits raw
  `body`/`requestHeaders` (use `ks:getRaw {id}`) and all messages (only
  `mergedCount`, `mergedRev`, `liveMessages`/`liveChats`). Pages read messages
  with `KSFlow.loadState`: 5000 slim messages (`KSMerge.slimMessage`) per
  `ks:getMerged {rev, offset}`; an old `mergedRev` is refused as `stale` and the
  read restarts. Any change to `st.merged` must bump `_mergedRev` (done in
  `scheduleSave`/`flush`). Export polling uses `ks:getFetchStatus`.
- No `storage.onChanged` listeners (each save would copy the multi-MB store into
  every listener). `flush()` writes only dirty keys, then sends `ks:changed` to
  extension pages; settings reach the bridge as `ks:pushSettings`.

## Tests

- `tests/sample.json` is a real capture with text, character name and user ids
  replaced by dummy values. Most tests assert against it: do not edit it
  casually, and never paste a new real capture (the repo is public).
- `test-background.cjs` re-evaluates `background.js` against fake `chrome`/`fetch`
  shims (`loadBackground()`); delete `require.cache` per scenario.
- `validate_xlsx.mjs` / `validate_docx.mjs` read zips with `tests/officezip.mjs`,
  not extension code, so they cannot share a bug with the writers.
  `validate_xlsx.mjs` also opens the file with `xlsx` (SheetJS), the only
  devDependency.
- Gotchas: `Uint8Array.includes(Buffer)` tests element membership, not substring
  (use `Buffer.from(x).includes(...)`); window shims need an `addEventListener`
  alias when extending EventEmitter.

## Before changing sensitive areas

Read `README.md` (filtering, export and fetch-all contracts) and the header
comment of `background.js` (state ownership). If the sites' API paths or hosts
change, update `host_permissions` and `content_scripts.matches` in
`manifest.json`, and `MESSAGES_PATTERN` in `background.js`.
