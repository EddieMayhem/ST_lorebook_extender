# Lorebook Extender

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) UI extension that grows a character's lorebook automatically from the conversation, and lets you inspect what changed.

Two main features, both available as buttons in the *Extensions* settings drawer:

1. **Extend** the character's currently linked lorebook based on new chat content (with a configurable LLM + prompt).
2. **Diff** the newest extended version against the linked lorebook so you can see exactly what was added, removed, or modified — before deciding whether to keep it.

When you click **Extend Lorebook Now**, the extension:

1. Takes the lorebook currently linked to the active character (`character.data.extensions.world`).
2. Diffs the current chat against a per-chat snapshot of the last run.
3. Sends the existing lorebook + the diff to a configurable LLM (via Connection Manager, with a configurable system prompt).
4. Saves the LLM-returned lorebook JSON as a **new** lorebook named `<original> - YYYY-MM-DD HH-mm-ss`.
5. Keeps at most N timestamped versions per original lorebook (default: 5), deleting the oldest.

The original lorebook is never modified, and the character card is never silently re-linked.

## Install

In SillyTavern's *Extensions* panel, click **Install Extension** and paste this repo's URL.

For local development, clone into `SillyTavern/public/scripts/extensions/third-party/ST_lorebook_extender/` and reload.

## Use

Open *Extensions* → **Lorebook Extender** drawer. Settings:

| Setting | What it does |
|---|---|
| Enabled | Toggles the extension. |
| Connection profile | Which Connection Manager profile to use. Leave on `(Active profile)` to use whatever the user has selected. |
| System prompt | Sent as the `system` role. |
| User prompt template | Sent as the `user` role. Supports `{{CHARACTER_NAME}}`, `{{ORIGINAL_LOREBOOK}}`, `{{DIFF}}`. |
| Max output tokens | Cap on the LLM response length. |
| Max versions to keep | How many timestamped siblings to keep before pruning. |
| Include full chat on first run | If checked and no snapshot exists yet (first run on this chat), send the whole chat instead of failing. |

Action buttons:

| Button | What it does |
|---|---|
| Extend Lorebook Now | Runs the full extend pipeline (diff chat, call LLM, save new timestamped lorebook, prune old versions). |
| Reset snapshot | Forgets the per-chat snapshot so the next *Extend* starts fresh. |
| View latest diff | Opens a read-only popup comparing the newest extended sibling against the character's currently linked lorebook. |

## View latest diff

The **View latest diff** button opens an ST popup that compares the newest timestamped sibling lorebook against the character's currently linked one. It's read-only — nothing is modified, nothing is re-linked.

The dialog header shows both lorebook names plus a one-line summary:

```
+N added · -M removed · ~K modified
```

Below the header, entries are grouped into three sections:

- **Added** — entries present in the extended sibling but not in the linked one. Each card shows the entry title (`comment`), the trigger keys, and a preview of `content`.
- **Modified** — entries present in both, but with at least one differing field. The card lists which fields changed (e.g. `Fields changed: key, order`) and, when `content` changed, renders an inline text diff (additions highlighted green, deletions struck-through red) using SillyTavern's bundled DiffMatchPatch.
- **Removed** — entries in the linked lorebook that are missing from the extended sibling.

### How entries are matched between the two books

Per-entry matching uses several keys, in this order, and never re-consumes an entry that already matched:

1. By `uid`
2. By `comment` (trimmed, case-insensitive)
3. By the first `key`

This makes the diff robust to the uid reassignment that happens during normalization — an entry whose only difference is a new uid is correctly reported as **unchanged**, not as a remove+add pair.

### Which sibling is "the latest"?

The button looks for sibling lorebooks of the character's currently linked one, in three tiers of strictness:

1. **strict** — `<original> - YYYY-MM-DD HH-mm-ss` (the format this extension produces). Newest by parsed timestamp wins.
2. **loose** — anything starting with `<original> - ` whose suffix doesn't parse as the strict format. Sorted descending by name.
3. **fuzzy** — anything starting with `<original>` (no `" - "` separator required). Sorted descending by name.

If at least one strict match exists, the newest one is used silently. If only loose/fuzzy candidates exist, you'll get a small picker popup to choose among them. If nothing matches, the browser console will log the full list of detected lorebooks so you can see what's actually there.

### Editing the sibling

Each *Added* and *Modified* entry card in the diff dialog has an **Edit** toggle in the top-right (it flips to **Done** while editing). Clicking it swaps the diff view for two inputs pre-filled with the sibling's current data:

- **Keys** — a comma-separated list of trigger keywords (the entry's `key` array). Whitespace around each token is trimmed, empties are dropped, and duplicates are collapsed (first one wins) on save.
- **Content** — the entry's `content` text.

Cards with unsaved changes get a yellow stripe and an `(unsaved)` tag next to the toggle, and the header shows the count of pending edits.

Click **Save changes** (in the dialog footer) to overwrite the sibling lorebook in place. The linked (base) lorebook and the character card link are never touched. Closing the dialog with unsaved edits prompts to discard.

Only `key` and `content` are editable here. Other fields (title, secondary keys, order, position, etc.) stay as the LLM produced them — edit those via SillyTavern's standard world-info editor if needed. *Removed* cards remain read-only since those entries don't exist in the sibling.

## Requirements

- A character must be selected, and that character must have a lorebook linked on its card (the *World/Lorebook* field on the character).
- Group chats are not supported.
- Structured-output JSON works best on Chat Completion sources (OpenAI, Claude, etc.); for other backends the extension falls back to parsing whatever JSON the model produces.

## Storage

- Global settings: `extension_settings['lorebook_extender']`.
- Per-chat snapshot: `chatMetadata['lorebook_extender_snapshot']` containing `{ lastProcessedIndex, lastProcessedAt, lastProcessedHash, sourceLorebook }`.

## Troubleshooting

**The extension is running old code after an update.** ST's *Update* button doesn't always invalidate the browser module cache. To force a clean reload:

1. Click *Update* on the extension in ST's *Extensions* manager.
2. Hard-refresh the page (Ctrl+Shift+R / Cmd+Shift+R).
3. If still stale, on the server: `git -C <ST_root>/data/<user>/extensions/ST_lorebook_extender pull` (or `<ST_root>/public/scripts/extensions/third-party/ST_lorebook_extender` for "all users" installs), then hard-refresh.

**`[object Event]` failure to load.** Almost always a path-resolution problem in an older version of this extension. Update to ≥ 0.2.0, which no longer depends on relative imports to ST internals.

**"No sibling of `<name>` found" when *View latest diff* is clicked.** Either no extended version has been produced yet (click *Extend Lorebook Now* first), or you're on a version older than 0.3.1 where the sibling-detection parser had an off-by-one bug that misclassified its own output. Update to ≥ 0.3.1 and hard-refresh. The browser console will log every lorebook name the extension can see if you need to debug further.

## License

AGPL-3.0
