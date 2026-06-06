# Lorebook Extender

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) UI extension that grows a character's lorebook automatically from the conversation.

When triggered, the extension:

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

Open *Extensions* → **Lorebook Extender** drawer:

| Setting | What it does |
|---|---|
| Enabled | Toggles the extension. |
| Connection profile | Which Connection Manager profile to use. Leave on `(Active profile)` to use whatever the user has selected. |
| System prompt | Sent as the `system` role. |
| User prompt template | Sent as the `user` role. Supports `{{CHARACTER_NAME}}`, `{{ORIGINAL_LOREBOOK}}`, `{{DIFF}}`. |
| Max output tokens | Cap on the LLM response length. |
| Max versions to keep | How many timestamped siblings to keep before pruning. |
| Include full chat on first run | If checked and no snapshot exists yet (first run on this chat), send the whole chat instead of failing. |

Hit **Extend Lorebook Now** to run the pipeline. **Reset snapshot** forgets the saved snapshot for the current chat so the next run starts fresh. **View latest diff** opens a popup comparing the newest timestamped sibling against the character's currently linked lorebook (read-only — added / removed / modified entries, with an inline text diff of changed `content` fields).

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

## License

AGPL-3.0
