/*
 * Lorebook Extender - SillyTavern UI extension
 * License: AGPL-3.0
 *
 * On manual trigger, diffs the current chat against a per-chat snapshot,
 * sends the diff + the character's primary lorebook to a configurable LLM,
 * and saves the LLM's returned lorebook as a new timestamped sibling.
 * Old siblings beyond a configurable count are pruned (oldest first).
 */

// We deliberately do NOT import from SillyTavern's internal modules.
// Different ST install modes serve extensions at different URL depths
// ("/scripts/extensions/<name>/" vs "/scripts/extensions/third-party/<name>/"),
// which makes relative imports unreliable. Everything we need is either on
// getContext() or reachable via the documented HTTP API with getRequestHeaders().

/**
 * Compatibility wrapper around getContext().getWorldInfoNames().
 *
 * That helper was only added to SillyTavern on 2026-04-23 (PR #5505). On
 * older builds the synchronous path is missing entirely, which manifests as
 * "ctx.getWorldInfoNames is not a function" — and on the extend pipeline
 * the crash happens *after* a successful (and possibly expensive) LLM call.
 *
 * Strategy:
 *   1. Prefer the native getter when it exists (no network, instant).
 *   2. Fall back to POST /api/worldinfo/list (a stable, long-lived endpoint
 *      we already rely on indirectly via /api/worldinfo/delete).
 *   3. Never throw. Worst case: log + return [] so callers behave as if no
 *      lorebooks exist, which is the same degraded-but-survivable state the
 *      old optional-chained calls already produced.
 *
 * @param {ReturnType<typeof SillyTavern.getContext>} [ctx]
 * @returns {Promise<string[]>}
 */
async function getWorldInfoNamesCompat(ctx) {
    const context = ctx ?? SillyTavern.getContext();

    if (typeof context.getWorldInfoNames === 'function') {
        try {
            const names = context.getWorldInfoNames();
            return Array.isArray(names) ? names.filter(n => typeof n === 'string') : [];
        } catch (e) {
            console.warn(`[${MODULE_NAME}] ctx.getWorldInfoNames() threw, falling back to REST:`, e);
        }
    }

    // REST fallback for older SillyTavern builds.
    try {
        const headers = typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {};
        const response = await fetch('/api/worldinfo/list', {
            method: 'POST',
            headers,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.warn(`[${MODULE_NAME}] /api/worldinfo/list ${response.status}: ${text}`);
            return [];
        }
        const data = await response.json().catch(() => null);
        if (!Array.isArray(data)) return [];
        // Each row is { file_id, name, extensions }. world_names (the binding
        // the native getter mirrors) uses file_id, so prefer that — but also
        // include the user-facing `name` when it differs, so case/whitespace
        // drift between the on-disk filename and the in-app display name
        // doesn't cause us to miss a perfectly valid sibling.
        const out = [];
        const seenLower = new Set();
        for (const entry of data) {
            if (!entry || typeof entry !== 'object') continue;
            for (const candidate of [entry.file_id, entry.name]) {
                if (typeof candidate !== 'string' || !candidate.length) continue;
                const key = candidate.toLowerCase();
                if (seenLower.has(key)) continue;
                seenLower.add(key);
                out.push(candidate);
            }
        }
        return out;
    } catch (e) {
        console.warn(`[${MODULE_NAME}] /api/worldinfo/list fetch failed:`, e);
        return [];
    }
}

/**
 * Create a new (empty) world info file. Mirrors createNewWorldInfo() from
 * scripts/world-info.js, but only uses getContext-exposed surface.
 * @param {string} name
 * @returns {Promise<boolean>} true on success
 */
async function createEmptyWorldInfo(name) {
    const ctx = SillyTavern.getContext();
    if (!name || typeof name !== 'string') return false;
    // Check overwrite up front; createNewWorldInfo would prompt interactively,
    // we just refuse silently and let the caller pick a different name.
    // Case-insensitive: ST persists worlds as files on disk, and filesystems
    // on Windows/macOS are case-insensitive — so "Foo" and "foo" would collide.
    const existing = await getWorldInfoNamesCompat(ctx);
    const target = name.toLowerCase();
    if (existing.some(n => n.toLowerCase() === target)) return false;
    await ctx.saveWorldInfo(name, { entries: {} }, true);
    await ctx.updateWorldInfoList?.();
    return true;
}

/**
 * Delete a world info file. Mirrors deleteWorldInfo() from
 * scripts/world-info.js via the documented /api/worldinfo/delete endpoint.
 * @param {string} name
 * @returns {Promise<boolean>} true on success
 */
async function deleteWorldInfoFile(name) {
    const ctx = SillyTavern.getContext();
    if (!name || typeof name !== 'string') return false;
    const headers = typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {};
    const response = await fetch('/api/worldinfo/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.warn(`[lorebook_extender] /api/worldinfo/delete ${response.status}: ${text}`);
        return false;
    }
    await ctx.updateWorldInfoList?.();
    return true;
}

const MODULE_NAME = 'lorebook_extender';
const EXTENSION_FOLDER = 'third-party/ST_lorebook_extender';
const SNAPSHOT_KEY = 'lorebook_extender_snapshot';

const DEFAULT_SYSTEM_PROMPT = `You are a lorebook curator for a roleplay.
Given an existing lorebook and a diff containing new chat content, return an updated lorebook in JSON.
Preserve all existing entries unchanged unless the new content explicitly contradicts them.
Add new entries for any new characters, places, items, events, or facts that appear in the diff.
Update existing entries when the diff reveals additional detail.
Each entry must have meaningful 'key' triggers, a clear 'comment' title, and concise factual 'content'.
Always return the COMPLETE updated lorebook, not just the changes.`;

const DEFAULT_USER_PROMPT = `Character: {{CHARACTER_NAME}}

Existing lorebook (JSON):
\`\`\`json
{{ORIGINAL_LOREBOOK}}
\`\`\`

New chat content since the last update:
\`\`\`
{{DIFF}}
\`\`\`

Return the complete updated lorebook as JSON conforming to the provided schema.`;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    profileId: '',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPromptTemplate: DEFAULT_USER_PROMPT,
    maxTokens: 4096,
    maxVersions: 5,
    dateFormat: 'YYYY-MM-DD HH-mm-ss',
    includeFullChat: true,
});

// Minimal default values for world info entry fields, mirroring
// newWorldInfoEntryDefinition in scripts/world-info.js. Kept local so we don't
// hard-depend on internal module shape.
const ENTRY_DEFAULTS = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
});

// JSON schema for structured output. Only used on supported Chat Completion sources.
const LOREBOOK_SCHEMA = {
    name: 'Lorebook',
    description: 'A SillyTavern world info / lorebook',
    strict: false,
    value: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            entries: {
                type: 'object',
                additionalProperties: {
                    type: 'object',
                    properties: {
                        uid: { type: 'integer' },
                        key: { type: 'array', items: { type: 'string' } },
                        keysecondary: { type: 'array', items: { type: 'string' } },
                        comment: { type: 'string' },
                        content: { type: 'string' },
                        constant: { type: 'boolean' },
                        selective: { type: 'boolean' },
                        order: { type: 'integer' },
                        position: { type: 'integer' },
                        probability: { type: 'integer' },
                        disable: { type: 'boolean' },
                    },
                    required: ['key', 'comment', 'content'],
                },
            },
        },
        required: ['entries'],
    },
};

// ------------------------------------------------------------------ settings -

/** @returns {typeof DEFAULT_SETTINGS} */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    // Backfill any newly added defaults after updates.
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

function persistSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ------------------------------------------------------------------- helpers -

/**
 * Safe deep clone with fallback for older browsers.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
    if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch { /* fall through */ }
    }
    return JSON.parse(JSON.stringify(value));
}

/** djb2-style non-crypto string hash, returned as base36. */
function simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) + str.charCodeAt(i);
        h |= 0;
    }
    return (h >>> 0).toString(36);
}

/**
 * Render visible chat messages into a plain-text transcript.
 * @param {Array<any>} messages
 * @returns {string}
 */
function renderChatTranscript(messages) {
    const lines = [];
    for (const msg of messages) {
        if (!msg) continue;
        if (msg.is_system) continue;
        const name = (msg.name ?? (msg.is_user ? 'User' : 'Character')).toString().trim();
        const body = (msg.mes ?? '').toString().trim();
        if (!body) continue;
        lines.push(`${name}: ${body}`);
    }
    return lines.join('\n\n');
}

/**
 * Extract a JSON object from arbitrary LLM output.
 * Tries: direct parse, fenced json block, fenced generic block, first {...} span.
 * @param {string} text
 * @returns {any}
 */
function extractJson(text) {
    if (typeof text !== 'string') throw new Error('LLM response was not a string');
    const trimmed = text.trim();
    if (!trimmed) throw new Error('LLM returned empty response');

    // 1. Direct parse.
    try { return JSON.parse(trimmed); } catch { /* try other strategies */ }

    // 2. Fenced ```json ... ```
    const fencedJson = /```json\s*([\s\S]*?)\s*```/i.exec(trimmed);
    if (fencedJson) {
        try { return JSON.parse(fencedJson[1]); } catch { /* keep going */ }
    }

    // 3. Generic ``` ... ```
    const fencedAny = /```\s*([\s\S]*?)\s*```/.exec(trimmed);
    if (fencedAny) {
        try { return JSON.parse(fencedAny[1]); } catch { /* keep going */ }
    }

    // 4. First balanced {...} span. Walk with a brace counter, skipping string literals.
    const start = trimmed.indexOf('{');
    if (start !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = start; i < trimmed.length; i++) {
            const c = trimmed[i];
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (inString) continue;
            if (c === '{') depth++;
            else if (c === '}') {
                depth--;
                if (depth === 0) {
                    const candidate = trimmed.slice(start, i + 1);
                    try { return JSON.parse(candidate); }
                    catch { break; }
                }
            }
        }
    }

    throw new Error('Could not parse JSON from LLM response');
}

/**
 * Coerce LLM output into a valid lorebook shape, assigning fresh uids and
 * filling missing fields from defaults. Tolerates entries provided as an array.
 * @param {any} raw
 * @returns {{ entries: Record<string, any> }}
 */
function normalizeLorebook(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('LLM output is not an object');
    }

    // Tolerate: top-level array, { entries: [...] }, or proper { entries: { uid: ... } }.
    let rawEntries;
    if (Array.isArray(raw)) {
        rawEntries = raw;
    } else if (Object.hasOwn(raw, 'entries')) {
        rawEntries = raw.entries;
    }

    if (rawEntries === undefined || rawEntries === null) {
        throw new Error('LLM output missing "entries" field');
    }
    if (typeof rawEntries !== 'object') {
        throw new Error('LLM output.entries is not an object');
    }

    /** @type {Array<any>} */
    const list = Array.isArray(rawEntries) ? rawEntries : Object.values(rawEntries);

    const normalized = { entries: /** @type {Record<string, any>} */ ({}) };
    let nextUid = 0;

    for (const candidate of list) {
        if (!candidate || typeof candidate !== 'object') continue;

        const entry = { ...ENTRY_DEFAULTS };

        // Copy over known fields with light coercion.
        for (const key of Object.keys(ENTRY_DEFAULTS)) {
            if (!Object.hasOwn(candidate, key)) continue;
            const value = candidate[key];
            const def = ENTRY_DEFAULTS[key];

            if (Array.isArray(def)) {
                if (Array.isArray(value)) {
                    entry[key] = value.map(v => String(v));
                } else if (typeof value === 'string' && value.length) {
                    // Tolerate comma-separated string from sloppy LLM output.
                    entry[key] = value.split(',').map(s => s.trim()).filter(Boolean);
                }
            } else if (typeof def === 'boolean') {
                entry[key] = Boolean(value);
            } else if (typeof def === 'number') {
                const n = Number(value);
                if (Number.isFinite(n)) entry[key] = n;
            } else if (typeof def === 'string') {
                entry[key] = String(value ?? '');
            } else {
                // def is null (nullable). Accept value as-is.
                entry[key] = value;
            }
        }

        // Skip empty entries (no content AND no comment AND no keys).
        const hasKey = Array.isArray(entry.key) && entry.key.length > 0;
        const hasContent = (entry.content || '').trim().length > 0;
        const hasComment = (entry.comment || '').trim().length > 0;
        if (!hasKey && !hasContent && !hasComment) continue;

        entry.uid = nextUid;
        normalized.entries[String(nextUid)] = entry;
        nextUid++;
    }

    return normalized;
}

/**
 * Format the current date using the configured format string. Supports a tiny
 * subset of tokens: YYYY, MM, DD, HH, mm, ss. Avoids the moment dependency
 * surfacing token quirks across versions.
 * @param {string} fmt
 * @param {Date} [date]
 */
function formatStamp(fmt, date = new Date()) {
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return fmt
        .replace(/YYYY/g, String(date.getFullYear()))
        .replace(/MM/g, pad(date.getMonth() + 1))
        .replace(/DD/g, pad(date.getDate()))
        .replace(/HH/g, pad(date.getHours()))
        .replace(/mm/g, pad(date.getMinutes()))
        .replace(/ss/g, pad(date.getSeconds()));
}

/**
 * Build a regex from the format string that captures a timestamp suffix.
 * Tokens become numeric character classes; everything else is escaped literally.
 * @param {string} fmt
 * @returns {RegExp}
 */
function buildStampRegex(fmt) {
    const tokens = { YYYY: '(\\d{4})', MM: '(\\d{2})', DD: '(\\d{2})', HH: '(\\d{2})', mm: '(\\d{2})', ss: '(\\d{2})' };
    let out = '';
    let i = 0;
    while (i < fmt.length) {
        let matched = false;
        for (const tok of Object.keys(tokens)) {
            if (fmt.startsWith(tok, i)) {
                out += tokens[tok];
                i += tok.length;
                matched = true;
                break;
            }
        }
        if (!matched) {
            out += fmt[i].replace(/[\\.*+?^${}()|[\]\\-]/g, '\\$&');
            i++;
        }
    }
    return new RegExp(`^${out}$`);
}

/**
 * Try to parse a timestamp suffix produced by formatStamp. Returns ms epoch
 * or null if it doesn't match.
 * @param {string} suffix
 * @param {string} fmt
 * @returns {number | null}
 */
function parseStampSuffix(suffix, fmt) {
    const re = buildStampRegex(fmt);
    const m = re.exec(suffix);
    if (!m) return null;

    // Determine which capture group is which token by re-scanning the format.
    const order = [];
    let i = 0;
    const knownTokens = ['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'];
    while (i < fmt.length) {
        let matched = false;
        for (const tok of knownTokens) {
            if (fmt.startsWith(tok, i)) {
                order.push(tok);
                i += tok.length;
                matched = true;
                break;
            }
        }
        if (!matched) i++;
    }

    const parts = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 };
    for (let k = 0; k < order.length; k++) {
        const v = Number(m[k + 1]);
        if (!Number.isFinite(v)) return null;
        parts[order[k]] = v;
    }
    const d = new Date(parts.YYYY, parts.MM - 1, parts.DD, parts.HH, parts.mm, parts.ss);
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Strip our own " - <timestamp>" suffix (with optional "-N" collision counter)
 * off a lorebook name, recursively, to recover the true base/root name.
 *
 * The bug this exists to fix: when a character card's `extensions.world` is
 * relinked to a previously-generated sibling (e.g. "MyChar - 2026-06-07 14-30-00"),
 * naively appending another timestamp produces stacked names like
 * "MyChar - 2026-06-07 14-30-00 - 2026-06-08 09-15-00" and breaks sibling
 * discovery / pruning because the prefix no longer matches the actual base.
 *
 * Algorithm: repeatedly take the substring after the *last* " - "; if it
 * parses as our timestamp format (with or without a trailing "-N" counter),
 * strip it and continue. Stop as soon as the suffix doesn't look like a
 * timestamp — this is what protects names that legitimately contain " - ".
 *
 * The loop has a hard cap (16) purely as a defensive guard against pathological
 * inputs; real-world stacks from this bug are at most a handful deep.
 *
 * @param {string} name
 * @param {string} dateFormat
 * @returns {string}
 */
function resolveBaseLorebookName(name, dateFormat) {
    if (typeof name !== 'string' || !name.length) return name;
    let current = name;
    for (let guard = 0; guard < 16; guard++) {
        const idx = current.lastIndexOf(' - ');
        if (idx === -1) break;
        const suffix = current.slice(idx + 3);
        if (!suffix.length) break;
        let ts = parseStampSuffix(suffix, dateFormat);
        if (ts === null) {
            // Tolerate a trailing collision counter like "-2" appended by the
            // free-name picker when a "<base> - <stamp>" name was already taken.
            const stripped = suffix.replace(/-\d+$/, '');
            if (stripped !== suffix) ts = parseStampSuffix(stripped, dateFormat);
        }
        if (ts === null) break;
        current = current.slice(0, idx);
    }
    return current;
}

/**
 * Resolve the connection profile id to use for generation.
 * Returns the configured one, or the current active profile, or null.
 */
function resolveProfileId(settings) {
    const ctx = SillyTavern.getContext();
    const cm = ctx.extensionSettings?.connectionManager;
    if (settings.profileId) {
        // Validate it still exists; otherwise fall back.
        const exists = cm?.profiles?.some(p => p.id === settings.profileId);
        if (exists) return settings.profileId;
    }
    return cm?.selectedProfile || null;
}

/** Is the Connection Manager extension installed and not disabled? */
function isConnectionManagerAvailable() {
    const ctx = SillyTavern.getContext();
    const disabled = ctx.extensionSettings?.disabledExtensions ?? [];
    return Boolean(ctx.ConnectionManagerRequestService) && !disabled.includes('connection-manager');
}

// ------------------------------------------------------------------ pipeline -

/**
 * The full extend-lorebook flow. Returns a string status on success or throws on failure.
 */
async function runExtendPipeline() {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();

    if (!settings.enabled) {
        throw new Error('Extension is disabled in settings');
    }

    // 1. Validate context.
    if (ctx.groupId) {
        throw new Error('Group chats are not supported (no single primary character)');
    }
    if (ctx.characterId === undefined || ctx.characterId === null) {
        throw new Error('No character is currently selected');
    }
    if (!Array.isArray(ctx.chat) || ctx.chat.length === 0) {
        throw new Error('Chat is empty; nothing to extend from');
    }

    const character = ctx.characters[ctx.characterId];
    if (!character) {
        throw new Error('Active character could not be resolved');
    }

    const originalName = character?.data?.extensions?.world;
    if (!originalName || typeof originalName !== 'string') {
        throw new Error('Active character has no primary lorebook linked');
    }

    // The character card may currently be linked to a previously-generated
    // sibling (e.g. "MyChar - 2026-06-07 14-30-00"). For the LLM context we
    // load whatever the card actually points at (so the user sees the same
    // content they were editing), but for naming the *new* sibling and for
    // running cleanup we always resolve back to the true base name. Without
    // this, names would stack — "MyChar - <ts1> - <ts2> - <ts3>" — and
    // sibling discovery / maxVersions pruning would silently break.
    const baseName = resolveBaseLorebookName(originalName, settings.dateFormat);

    const originalData = await ctx.loadWorldInfo(originalName);
    if (!originalData) {
        throw new Error(`Could not load lorebook "${originalName}"`);
    }

    // 2. Build diff.
    const snapshot = ctx.chatMetadata?.[SNAPSHOT_KEY] || null;
    const totalLen = ctx.chat.length;

    /** @type {Array<any>} */
    let diffMessages;
    let baselineDescription;

    if (!snapshot) {
        if (settings.includeFullChat) {
            diffMessages = ctx.chat.slice();
            baselineDescription = 'full chat (first run)';
        } else {
            throw new Error('No prior snapshot for this chat. Enable "Include full chat on first run" or click Reset snapshot first.');
        }
    } else {
        let startIndex = (snapshot.lastProcessedIndex ?? -1) + 1;

        // If the message at the snapshot index was edited, replay from it.
        const ref = ctx.chat[snapshot.lastProcessedIndex];
        if (ref && snapshot.lastProcessedHash && simpleHash((ref.mes ?? '').toString()) !== snapshot.lastProcessedHash) {
            startIndex = Math.max(0, snapshot.lastProcessedIndex);
        }

        if (startIndex >= totalLen) {
            throw new Error('No new messages since the last run. Send/receive new messages first.');
        }
        diffMessages = ctx.chat.slice(startIndex);
        baselineDescription = `messages ${startIndex}..${totalLen - 1}`;
    }

    const transcript = renderChatTranscript(diffMessages);
    if (!transcript.trim()) {
        throw new Error('Diff contains no visible messages (all hidden/system)');
    }

    // 3. Build prompt.
    const userPrompt = settings.userPromptTemplate
        .replaceAll('{{CHARACTER_NAME}}', character.name ?? 'Unknown')
        .replaceAll('{{ORIGINAL_LOREBOOK}}', JSON.stringify(originalData, null, 2))
        .replaceAll('{{DIFF}}', transcript);

    // 4. Show loader and generate.
    const loaderHandle = ctx.loader?.show?.({ message: 'Extending lorebook…' });
    let rawText;
    try {
        if (isConnectionManagerAvailable()) {
            const profileId = resolveProfileId(settings);
            if (!profileId) {
                throw new Error('No connection profile is selected');
            }
            const CMRS = ctx.ConnectionManagerRequestService;
            const messages = [
                { role: 'system', content: settings.systemPrompt },
                { role: 'user', content: userPrompt },
            ];
            const result = await CMRS.sendRequest(profileId, messages, settings.maxTokens, {
                stream: false,
                extractData: true,
                includePreset: true,
                includeInstruct: true,
            });
            rawText = typeof result === 'string' ? result : (result?.content ?? '');
        } else {
            // Fallback: use whatever the user currently has active.
            rawText = await ctx.generateRaw({
                systemPrompt: settings.systemPrompt,
                prompt: userPrompt,
                jsonSchema: LOREBOOK_SCHEMA,
            });
        }
    } finally {
        await loaderHandle?.hide?.();
    }

    if (!rawText || !String(rawText).trim()) {
        throw new Error('LLM returned an empty response');
    }

    // 5. Parse + normalize.
    let parsed;
    try {
        parsed = extractJson(String(rawText));
    } catch (e) {
        console.error(`[${MODULE_NAME}] Parse failure. Raw response was:\n`, rawText);
        throw new Error(`LLM did not return valid JSON: ${e.message} (see console)`);
    }

    let normalized;
    try {
        normalized = normalizeLorebook(parsed);
    } catch (e) {
        console.error(`[${MODULE_NAME}] Normalization failure. Parsed object was:`, parsed);
        throw new Error(`LLM JSON could not be normalized: ${e.message} (see console)`);
    }

    const entryCount = Object.keys(normalized.entries).length;
    if (entryCount === 0) {
        // Treat as no-op success: don't save, don't update snapshot.
        return `No entries produced from ${baselineDescription}; nothing to save.`;
    }

    // 6. Pick a free name.
    // Always derive the new name from the resolved base, never from the
    // currently-linked name. This is the fix for the timestamp-stacking bug:
    // if the card is linked to "MyChar - <ts1>", we still produce
    // "MyChar - <ts2>", not "MyChar - <ts1> - <ts2>".
    let newName = `${baseName} - ${formatStamp(settings.dateFormat)}`;
    // Fetch the lorebook list once and reuse for both name collision and the
    // cleanup pass below. Avoids a duplicate REST round-trip on older ST builds
    // where ctx.getWorldInfoNames doesn't exist (added 2026-04-23, PR #5505).
    let knownNames = await getWorldInfoNamesCompat(ctx);
    // Case-insensitive collision check: on Windows/macOS the on-disk filesystem
    // is case-insensitive, so "Foo - 2026" and "foo - 2026" would clobber each
    // other server-side even though the JS Set would treat them as distinct.
    const existingLower = new Set(knownNames.map(n => n.toLowerCase()));
    if (existingLower.has(newName.toLowerCase())) {
        for (let counter = 2; counter < 1000; counter++) {
            const candidate = `${newName}-${counter}`;
            if (!existingLower.has(candidate.toLowerCase())) { newName = candidate; break; }
        }
    }

    // 7. Create + save.
    const created = await createEmptyWorldInfo(newName);
    if (!created) {
        throw new Error(`Failed to create lorebook "${newName}"`);
    }
    await ctx.saveWorldInfo(newName, normalized, true);
    await ctx.updateWorldInfoList?.();

    // 8. Cleanup. Find siblings = anything with the exact "<base> - " prefix
    // whose remainder parses as our timestamp format.
    // Re-fetch the list so the just-created lorebook is included (and any
    // concurrent edits since step 6 are reflected). Case-insensitive matching
    // mirrors findSiblingCandidates so cleanup works even if the character
    // card's `extensions.world` value drifts in case from the on-disk file_id.
    // We use the resolved base name here, not the (possibly already-timestamped)
    // linked name, otherwise cleanup looks for siblings of a sibling and
    // silently prunes nothing.
    knownNames = await getWorldInfoNamesCompat(ctx);
    const origLowerCleanup = String(baseName).toLowerCase();
    const prefixLower = `${origLowerCleanup} - `;
    const newNameLower = newName.toLowerCase();
    const limit = Math.max(1, Number(settings.maxVersions) || 5);
    const siblings = knownNames
        .filter(n => {
            const nl = n.toLowerCase();
            return nl !== origLowerCleanup && nl.startsWith(prefixLower);
        })
        .map(n => {
            const rawSuffix = n.slice(prefixLower.length);
            // Try the full suffix first; only strip a trailing "-N" collision counter
            // as a fallback, because the timestamp itself ends with "-NN" (seconds).
            let ts = parseStampSuffix(rawSuffix, settings.dateFormat);
            if (ts === null) {
                const stripped = rawSuffix.replace(/-\d+$/, '');
                if (stripped !== rawSuffix) ts = parseStampSuffix(stripped, settings.dateFormat);
            }
            return ts === null ? null : { name: n, ts };
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);

    let deleted = 0;
    while (siblings.length > limit) {
        const victim = siblings.shift();
        if (victim.name.toLowerCase() === newNameLower) continue; // never delete the one we just made
        try {
            const ok = await deleteWorldInfoFile(victim.name);
            if (ok !== false) deleted++;
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Failed to delete "${victim.name}":`, e);
        }
    }

    // 9. Update snapshot for this chat.
    const lastIndex = totalLen - 1;
    const lastMes = (ctx.chat[lastIndex]?.mes ?? '').toString();
    ctx.chatMetadata[SNAPSHOT_KEY] = {
        lastProcessedIndex: lastIndex,
        lastProcessedAt: Date.now(),
        lastProcessedHash: simpleHash(lastMes),
        // Always store the resolved base so this value stays stable across
        // runs even after the character card gets relinked to a timestamped
        // sibling. Avoids confusing "sourceLorebook" drift in saved metadata.
        sourceLorebook: baseName,
    };
    await ctx.saveMetadata();

    const parts = [
        `Created "${newName}" with ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`,
        `from ${baselineDescription}`,
    ];
    if (deleted > 0) parts.push(`pruned ${deleted} old version${deleted === 1 ? '' : 's'}`);
    return parts.join(' · ');
}

// ------------------------------------------------------------- diff engine -

/**
 * Find the newest "<originalName> - <timestamp>" sibling of a given book.
 * Returns { name, ts } of the newest strict match, or null if none exist.
 * Uses the same matching logic as the cleanup step in the extend pipeline.
 */
async function findLatestSibling(originalName, dateFormat) {
    const candidates = await findSiblingCandidates(originalName, dateFormat);
    const strict = candidates.find(c => c.tier === 'strict');
    return strict ?? null;
}

/**
 * Locate any plausible "sibling" of a lorebook, in decreasing strictness:
 *   - tier 'strict': "<name> - <YYYY-MM-DD HH-mm-ss>" (extension's own format)
 *   - tier 'loose':  starts with "<name> - " but suffix doesn't parse as our format
 *   - tier 'fuzzy':  starts with "<name>" (no separator requirement) but isn't <name> itself
 *
 * Within each tier, strict is sorted by parsed timestamp desc; loose/fuzzy are
 * sorted by name desc (so ISO-ish suffixes still come out newest-first).
 *
 * Matching is case-insensitive: on Windows + macOS the underlying filesystem
 * is case-insensitive, and the character card's `extensions.world` field has
 * been observed to drift in case from the actual on-disk file_id (e.g. after
 * a manual rename). The returned `name` field always preserves the casing as
 * reported by SillyTavern so subsequent loadWorldInfo / saveWorldInfo calls
 * still address the correct file.
 *
 * @returns {Promise<Array<{ name: string, ts: number|null, tier: 'strict'|'loose'|'fuzzy' }>>}
 */
async function findSiblingCandidates(originalName, dateFormat) {
    const ctx = SillyTavern.getContext();
    const rawNames = await getWorldInfoNamesCompat(ctx);
    if (!originalName || !rawNames.length) return [];

    const origLower = String(originalName).toLowerCase();
    // Filter out exact (case-insensitive) self-matches.
    const names = rawNames.filter(n => n.toLowerCase() !== origLower);
    if (!names.length) return [];

    const strict = [];
    const loose = [];
    const fuzzy = [];

    const sepPrefixLower = `${origLower} - `;
    for (const n of names) {
        const nLower = n.toLowerCase();
        if (nLower.startsWith(sepPrefixLower)) {
            // Slice off the prefix using the lower-cased length, then read the
            // suffix from the ORIGINAL string at the same offset to keep its
            // casing intact (matters for timestamp parsing? no — but cheap).
            const rawSuffix = n.slice(sepPrefixLower.length);
            // Try the full suffix first; only strip a trailing counter (e.g. "-2") as a fallback,
            // because our own timestamp itself ends with "-NN" (seconds).
            let ts = parseStampSuffix(rawSuffix, dateFormat);
            if (ts === null) {
                const stripped = rawSuffix.replace(/-\d+$/, '');
                if (stripped !== rawSuffix) ts = parseStampSuffix(stripped, dateFormat);
            }
            if (ts !== null) {
                strict.push({ name: n, ts, tier: 'strict' });
            } else {
                loose.push({ name: n, ts: null, tier: 'loose' });
            }
        } else if (nLower.startsWith(origLower)) {
            // No " - " separator, but the original is a prefix. Common for
            // hand-named exports like "<name>_2026-06-06" or "<name>(v2)".
            fuzzy.push({ name: n, ts: null, tier: 'fuzzy' });
        }
    }

    strict.sort((a, b) => b.ts - a.ts);
    loose.sort((a, b) => b.name.localeCompare(a.name));
    fuzzy.sort((a, b) => b.name.localeCompare(a.name));

    return [...strict, ...loose, ...fuzzy];
}

/**
 * Rank every lorebook name by how plausibly it could be a sibling of
 * `originalName`. Purely diagnostic — used when we want to tell the user
 * "we didn't find a sibling, but here's what's closest" without spamming the
 * full list. Score is in [0, 1] where 1 is identical (case-insensitive) and
 * 0 shares no leading characters.
 *
 * Two signals are combined:
 *   - shared lowercase prefix length / max length  (primary, weight 0.7)
 *   - lowercase substring containment              (secondary, weight 0.3)
 *
 * @param {string} originalName
 * @param {string[]} allNames
 * @returns {Array<{ name: string, score: number }>}
 */
function rankProbableSiblings(originalName, allNames) {
    const origLower = String(originalName ?? '').toLowerCase();
    if (!origLower || !Array.isArray(allNames) || !allNames.length) return [];

    /** @param {string} a @param {string} b */
    const sharedPrefixLen = (a, b) => {
        const max = Math.min(a.length, b.length);
        let i = 0;
        while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
        return i;
    };

    const ranked = allNames
        .filter(n => n.toLowerCase() !== origLower) // exclude self (case-insensitive)
        .map(n => {
            const nl = n.toLowerCase();
            const prefix = sharedPrefixLen(nl, origLower);
            const longer = Math.max(nl.length, origLower.length);
            const prefixScore = longer === 0 ? 0 : prefix / longer;
            const containsScore = (nl.includes(origLower) || origLower.includes(nl)) ? 1 : 0;
            const score = 0.7 * prefixScore + 0.3 * containsScore;
            return { name: n, score };
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score);

    return ranked;
}

/** Shallow-equal for arrays (string elements expected). */
function arrShallowEq(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Loose equality for entry field values (arrays compared element-wise). */
function entryValuesEqual(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) return arrShallowEq(a, b);
    if (a === b) return true;
    // null/undefined collapsed: many ST entry fields default to null.
    if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
    return false;
}

/** Make a stable matching key from an entry. Returns null if no good key. */
function entryMatchKey(entry, mode) {
    if (!entry || typeof entry !== 'object') return null;
    switch (mode) {
        case 'uid':
            return entry.uid !== undefined && entry.uid !== null ? `uid:${entry.uid}` : null;
        case 'comment': {
            const c = (entry.comment ?? '').toString().trim().toLowerCase();
            return c.length > 0 ? `comment:${c}` : null;
        }
        case 'firstKey': {
            if (Array.isArray(entry.key) && entry.key.length > 0) {
                const k = String(entry.key[0] ?? '').trim().toLowerCase();
                return k.length > 0 ? `key:${k}` : null;
            }
            return null;
        }
        default:
            return null;
    }
}

/**
 * Compute a per-entry diff between two lorebook objects.
 * @param {{entries?: Record<string, any>}} oldBook
 * @param {{entries?: Record<string, any>}} newBook
 * @returns {{
 *   added: Array<object>,
 *   removed: Array<object>,
 *   modified: Array<{ oldEntry: object, newEntry: object, fields: string[] }>
 * }}
 */
function diffLorebooks(oldBook, newBook) {
    const oldEntries = oldBook && typeof oldBook.entries === 'object' && oldBook.entries
        ? Object.values(oldBook.entries) : [];
    const newEntries = newBook && typeof newBook.entries === 'object' && newBook.entries
        ? Object.values(newBook.entries) : [];

    // Build lookup tables for old entries.
    const oldByUid = new Map();
    const oldByComment = new Map();
    const oldByFirstKey = new Map();
    for (const e of oldEntries) {
        const ku = entryMatchKey(e, 'uid');       if (ku && !oldByUid.has(ku)) oldByUid.set(ku, e);
        const kc = entryMatchKey(e, 'comment');   if (kc && !oldByComment.has(kc)) oldByComment.set(kc, e);
        const kk = entryMatchKey(e, 'firstKey');  if (kk && !oldByFirstKey.has(kk)) oldByFirstKey.set(kk, e);
    }

    const consumed = new Set(); // identity-set of old entries already matched
    const added = [];
    const modified = [];

    for (const newEntry of newEntries) {
        let match = null;

        // Try uid, then comment, then firstKey, never re-consuming.
        for (const mode of ['uid', 'comment', 'firstKey']) {
            const key = entryMatchKey(newEntry, mode);
            if (!key) continue;
            const table = mode === 'uid' ? oldByUid : mode === 'comment' ? oldByComment : oldByFirstKey;
            const candidate = table.get(key);
            if (candidate && !consumed.has(candidate)) { match = candidate; break; }
        }

        if (!match) {
            added.push(newEntry);
            continue;
        }

        consumed.add(match);

        // Compare fields. Ignore uid (extension reassigns these during normalization).
        const changedFields = [];
        const allKeys = new Set([...Object.keys(match), ...Object.keys(newEntry)]);
        allKeys.delete('uid');
        for (const k of allKeys) {
            if (!entryValuesEqual(match[k], newEntry[k])) changedFields.push(k);
        }

        if (changedFields.length === 0) continue; // truly identical, skip
        modified.push({ oldEntry: match, newEntry, fields: changedFields });
    }

    const removed = oldEntries.filter(e => !consumed.has(e));

    return { added, removed, modified };
}

// ------------------------------------------------------------ diff rendering

function escapeHtml(input) {
    return String(input ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Build a unified HTML diff for a content string change, using DiffMatchPatch
 * when available, with a graceful fallback otherwise.
 */
function renderContentDiff(oldText, newText) {
    const safeOld = String(oldText ?? '');
    const safeNew = String(newText ?? '');

    /** @type {any} */
    const DiffMatchPatch = SillyTavern?.libs?.DiffMatchPatch;
    if (DiffMatchPatch) {
        try {
            const dmp = new DiffMatchPatch();
            const diff = dmp.diff_main(safeOld, safeNew);
            if (typeof dmp.diff_cleanupSemantic === 'function') dmp.diff_cleanupSemantic(diff);
            const html = diff.map(([op, text]) => {
                const safe = escapeHtml(text);
                if (op === -1) return `<del>${safe}</del>`;
                if (op === 1) return `<ins>${safe}</ins>`;
                return safe;
            }).join('');
            return html;
        } catch (e) {
            console.warn(`[${MODULE_NAME}] DiffMatchPatch failed, falling back:`, e);
        }
    }

    // Fallback: line-by-line side-by-side with a naive line union.
    const oldLines = safeOld.split('\n');
    const newLines = safeNew.split('\n');
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);
    const out = [];
    for (const line of oldLines) {
        if (!newSet.has(line)) out.push(`<del>${escapeHtml(line)}</del>`);
        else out.push(escapeHtml(line));
    }
    for (const line of newLines) {
        if (!oldSet.has(line)) out.push(`<ins>${escapeHtml(line)}</ins>`);
    }
    return out.join('\n');
}

function entryKeysSummary(entry) {
    const keys = Array.isArray(entry?.key) ? entry.key : [];
    if (keys.length === 0) return '<em class="lbx-diff-empty">(no keys)</em>';
    return escapeHtml(JSON.stringify(keys));
}

/**
 * Serialise an entry.key array into the comma-separated form used in the
 * editable input. Strips falsy entries but otherwise leaves whitespace alone
 * so a round-trip with no edits is a no-op.
 *
 * @param {unknown} keyField
 * @returns {string}
 */
function keysToEditableString(keyField) {
    const keys = Array.isArray(keyField) ? keyField : [];
    return keys
        .map(k => (k === null || k === undefined) ? '' : String(k))
        .filter(k => k.length > 0)
        .join(', ');
}

/**
 * Parse the comma-separated form back into a string array. Trims each token,
 * drops empties, and dedupes while preserving first-seen order. Mirrors how
 * the SillyTavern world-info editor itself treats key inputs.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseEditableKeysString(raw) {
    if (typeof raw !== 'string') return [];
    const seen = new Set();
    const out = [];
    for (const piece of raw.split(',')) {
        const trimmed = piece.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function entryCommentSummary(entry) {
    const c = (entry?.comment ?? '').toString().trim();
    return c.length ? escapeHtml(c) : '<em class="lbx-diff-empty">(no title)</em>';
}

function renderAddedRemovedCard(entry, kind, options = {}) {
    const content = (entry?.content ?? '').toString();
    const safeContent = escapeHtml(content);
    const editable = options.editable === true && kind === 'added';
    const uid = entry?.uid;
    const hasUid = uid !== undefined && uid !== null;
    const safeUid = hasUid ? escapeHtml(String(uid)) : '';
    const keysString = keysToEditableString(entry?.key);
    const editArea = editable && hasUid
        ? `<div class="lbx-edit-area">
                <label class="lbx-edit-label">Keys (comma-separated triggers)</label>
                <input type="text" class="lbx-edit-keys" data-lbx-keys-uid="${safeUid}" data-lbx-keys-original="${escapeHtml(keysString)}" value="${escapeHtml(keysString)}" placeholder="key1, key2, key3" />
                <label class="lbx-edit-label">Content</label>
                <textarea data-lbx-uid="${safeUid}" data-lbx-original="${escapeHtml(content)}">${safeContent}</textarea>
            </div>`
        : '';
    const toggle = editable
        ? `<span class="lbx-edit-toggle" data-lbx-toggle="1"><i class="fa-solid fa-pen-to-square"></i> Edit</span>`
        : '';
    return `
        <div class="lbx-diff-card ${kind}">
            ${toggle}
            <div class="lbx-diff-comment">${entryCommentSummary(entry)}</div>
            <div class="lbx-diff-keys">keys: ${entryKeysSummary(entry)}</div>
            ${content ? `<pre class="lbx-diff-content">${safeContent}</pre>` : (editable ? '<pre class="lbx-diff-content"><em class="lbx-diff-empty">(empty)</em></pre>' : '')}
            ${editArea}
        </div>
    `;
}

function renderModifiedCard(oldEntry, newEntry, fields, options = {}) {
    const includesContent = fields.includes('content');
    const otherFields = fields.filter(f => f !== 'content');
    const fieldsLine = otherFields.length
        ? `<div class="lbx-diff-fields-changed">Fields changed: ${escapeHtml(otherFields.join(', '))}</div>`
        : '';
    const contentBlock = includesContent
        ? `<pre class="lbx-diff-content">${renderContentDiff(oldEntry.content, newEntry.content)}</pre>`
        : `<pre class="lbx-diff-content">${escapeHtml((newEntry.content ?? '').toString())}</pre>`;

    const editable = options.editable === true;
    const uid = newEntry?.uid;
    const hasUid = uid !== undefined && uid !== null;
    const safeUid = hasUid ? escapeHtml(String(uid)) : '';
    const newContent = (newEntry?.content ?? '').toString();
    const keysString = keysToEditableString(newEntry?.key);
    const editArea = editable && hasUid
        ? `<div class="lbx-edit-area">
                <label class="lbx-edit-label">Keys (comma-separated triggers)</label>
                <input type="text" class="lbx-edit-keys" data-lbx-keys-uid="${safeUid}" data-lbx-keys-original="${escapeHtml(keysString)}" value="${escapeHtml(keysString)}" placeholder="key1, key2, key3" />
                <label class="lbx-edit-label">Content</label>
                <textarea data-lbx-uid="${safeUid}" data-lbx-original="${escapeHtml(newContent)}">${escapeHtml(newContent)}</textarea>
            </div>`
        : '';
    const toggle = editable
        ? `<span class="lbx-edit-toggle" data-lbx-toggle="1"><i class="fa-solid fa-pen-to-square"></i> Edit</span>`
        : '';

    return `
        <div class="lbx-diff-card modified">
            ${toggle}
            <div class="lbx-diff-comment">${entryCommentSummary(newEntry)}</div>
            <div class="lbx-diff-keys">keys: ${entryKeysSummary(newEntry)}</div>
            ${fieldsLine}
            ${contentBlock}
            ${editArea}
        </div>
    `;
}

function buildDiffHtml({ originalName, latestName, diff, editable = false }) {
    const a = diff.added.length;
    const r = diff.removed.length;
    const m = diff.modified.length;

    const header = `
        <div class="lbx-diff-header">
            <div class="lbx-diff-names">
                <div><strong>Base (linked):</strong> <code>${escapeHtml(originalName)}</code></div>
                <div><strong>Latest extended:</strong> <code>${escapeHtml(latestName)}</code></div>
            </div>
            <div class="lbx-diff-stats">
                <span class="added">+${a}</span> added ·
                <span class="removed">-${r}</span> removed ·
                <span class="modified">~${m}</span> modified
                <span class="lbx-diff-dirty-badge" data-lbx-dirty-badge></span>
            </div>
        </div>
    `;

    if (a === 0 && r === 0 && m === 0) {
        return header + `<p class="lbx-diff-empty">Lorebooks are identical.</p>`;
    }

    const addedSection = `
        <div class="lbx-diff-section">
            <h3>Added (${a})</h3>
            ${a === 0
                ? '<div class="lbx-diff-empty">None</div>'
                : diff.added.map(e => renderAddedRemovedCard(e, 'added', { editable })).join('')}
        </div>
    `;
    const removedSection = `
        <div class="lbx-diff-section">
            <h3>Removed (${r})</h3>
            ${r === 0
                ? '<div class="lbx-diff-empty">None</div>'
                : diff.removed.map(e => renderAddedRemovedCard(e, 'removed', { editable: false })).join('')}
        </div>
    `;
    const modifiedSection = `
        <div class="lbx-diff-section">
            <h3>Modified (${m})</h3>
            ${m === 0
                ? '<div class="lbx-diff-empty">None</div>'
                : diff.modified.map(x => renderModifiedCard(x.oldEntry, x.newEntry, x.fields, { editable })).join('')}
        </div>
    `;

    return header + addedSection + modifiedSection + removedSection;
}

// ----------------------------------------------------------- diff editing --

/**
 * Wire delegated click + input handlers for the editable diff dialog.
 * - Click on .lbx-edit-toggle: toggle .lbx-editing on the parent card,
 *   swap toggle label, focus the textarea on first edit.
 * - Input on textarea[data-lbx-uid]: mark card dirty / undirty based on
 *   comparison with data-lbx-original, then update the header badge.
 * - Input on input[data-lbx-keys-uid]: same dirty tracking, but compares
 *   parsed key arrays so cosmetic whitespace/comma noise doesn't flag it.
 *
 * @param {HTMLElement} rootEl - The popup content container.
 */
function wireEditModeHandlers(rootEl) {
    if (!rootEl) return;

    rootEl.addEventListener('click', (ev) => {
        const target = /** @type {HTMLElement} */ (ev.target);
        const toggle = target.closest('[data-lbx-toggle]');
        if (!toggle) return;
        const card = toggle.closest('.lbx-diff-card');
        if (!card) return;
        const wasEditing = card.classList.contains('lbx-editing');
        card.classList.toggle('lbx-editing');
        // Update toggle label.
        const editing = !wasEditing;
        toggle.innerHTML = editing
            ? '<i class="fa-solid fa-check"></i> Done'
            : '<i class="fa-solid fa-pen-to-square"></i> Edit';
        if (editing) {
            // Prefer the keys input on first edit so users see/realise it's
            // editable; fall back to the content textarea otherwise.
            const keysInput = /** @type {HTMLInputElement | null} */ (card.querySelector('input[data-lbx-keys-uid]'));
            const ta = /** @type {HTMLTextAreaElement | null} */ (card.querySelector('textarea[data-lbx-uid]'));
            (keysInput ?? ta)?.focus();
        }
    });

    rootEl.addEventListener('input', (ev) => {
        const target = /** @type {HTMLElement} */ (ev.target);

        // Content textarea path.
        if (target instanceof HTMLTextAreaElement && target.dataset.lbxUid) {
            const card = target.closest('.lbx-diff-card');
            if (!card) return;
            const original = target.dataset.lbxOriginal ?? '';
            const dirty = target.value !== original;
            setFieldDirty(card, 'content', dirty);
            updateCardDirtyAttr(card);
            updateDirtyBadge(rootEl);
            return;
        }

        // Keys input path.
        if (target instanceof HTMLInputElement && target.dataset.lbxKeysUid) {
            const card = target.closest('.lbx-diff-card');
            if (!card) return;
            const original = parseEditableKeysString(target.dataset.lbxKeysOriginal ?? '');
            const current = parseEditableKeysString(target.value);
            const dirty = !arrShallowEq(original, current);
            setFieldDirty(card, 'keys', dirty);
            updateCardDirtyAttr(card);
            updateDirtyBadge(rootEl);
            return;
        }
    });
}

/**
 * Track per-field dirtiness on the card via two independent dataset flags
 * so editing one input doesn't accidentally clear another's dirty marker.
 */
function setFieldDirty(card, field, dirty) {
    const attr = field === 'keys' ? 'data-dirty-keys' : 'data-dirty-content';
    if (dirty) card.setAttribute(attr, 'true');
    else card.removeAttribute(attr);
}

/**
 * Aggregate the per-field flags into the existing data-dirty attribute so
 * downstream queries (badge counter, save sweep, discard prompt) keep using
 * a single uniform selector.
 */
function updateCardDirtyAttr(card) {
    const dirty = card.hasAttribute('data-dirty-keys') || card.hasAttribute('data-dirty-content');
    if (dirty) card.setAttribute('data-dirty', 'true');
    else card.removeAttribute('data-dirty');
}

/** Update the "N edits pending" badge in the dialog header. */
function updateDirtyBadge(rootEl) {
    if (!rootEl) return;
    const badge = rootEl.querySelector('[data-lbx-dirty-badge]');
    if (!badge) return;
    const dirty = rootEl.querySelectorAll('.lbx-diff-card[data-dirty="true"]').length;
    badge.textContent = dirty === 0 ? '' : `· ${dirty} edit${dirty === 1 ? '' : 's'} pending`;
}

/**
 * Apply every dirty field's value back into the sibling data object's
 * matching entry. Returns a summary suitable for status reporting.
 *
 * Both `content` (textarea) and `key` (comma-separated input) are written
 * back. Each is independently dirty-tracked, so a card can save just one of
 * them without touching the other.
 *
 * @param {HTMLElement} rootEl - The popup content container.
 * @param {{entries?: Record<string, any>}} siblingData
 * @returns {{ changed: number, missing: string[] }}
 */
function applyEditsToSibling(rootEl, siblingData) {
    const result = { changed: 0, missing: /** @type {string[]} */ ([]) };
    if (!rootEl || !siblingData || typeof siblingData.entries !== 'object' || !siblingData.entries) {
        return result;
    }

    // Build a uid -> storage-key lookup (uid as written on the entry, not the
    // outer key, because they can differ).
    const uidToKey = new Map();
    for (const [storageKey, entry] of Object.entries(siblingData.entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const uid = entry.uid;
        if (uid === undefined || uid === null) continue;
        uidToKey.set(String(uid), storageKey);
    }

    /**
     * Resolve a uid back to the actual entry object (nullable). Pushes to
     * result.missing on lookup failure and returns null.
     */
    const resolveEntry = (uid) => {
        const storageKey = uidToKey.get(uid);
        if (storageKey === undefined) {
            result.missing.push(uid);
            return null;
        }
        const entry = siblingData.entries[storageKey];
        if (!entry || typeof entry !== 'object') {
            result.missing.push(uid);
            return null;
        }
        return entry;
    };

    // ---- Content edits ----
    const dirtyContent = rootEl.querySelectorAll('.lbx-diff-card[data-dirty-content="true"] textarea[data-lbx-uid]');
    for (const node of dirtyContent) {
        const ta = /** @type {HTMLTextAreaElement} */ (node);
        const uid = ta.dataset.lbxUid ?? '';
        const entry = resolveEntry(uid);
        if (!entry) continue;
        const newContent = ta.value;
        if (entry.content !== newContent) {
            entry.content = newContent;
            result.changed++;
        }
    }

    // ---- Keys edits ----
    const dirtyKeys = rootEl.querySelectorAll('.lbx-diff-card[data-dirty-keys="true"] input[data-lbx-keys-uid]');
    for (const node of dirtyKeys) {
        const inp = /** @type {HTMLInputElement} */ (node);
        const uid = inp.dataset.lbxKeysUid ?? '';
        const entry = resolveEntry(uid);
        if (!entry) continue;
        const newKeys = parseEditableKeysString(inp.value);
        const oldKeys = Array.isArray(entry.key) ? entry.key : [];
        if (!arrShallowEq(oldKeys, newKeys)) {
            entry.key = newKeys;
            result.changed++;
        }
    }

    return result;
}

// --------------------------------------------------------------------- UI ---

let statusEl = /** @type {HTMLElement | null} */ (null);

function setStatus(message, kind /** @type {'info'|'success'|'error'|''} */ = 'info') {
    if (!statusEl) return;
    statusEl.classList.remove('error', 'success');
    if (kind === 'error') statusEl.classList.add('error');
    if (kind === 'success') statusEl.classList.add('success');
    statusEl.textContent = message;
}

function describeSnapshot() {
    const ctx = SillyTavern.getContext();
    const snap = ctx.chatMetadata?.[SNAPSHOT_KEY];
    if (!snap) return 'Last run for this chat: never';
    const when = snap.lastProcessedAt ? new Date(snap.lastProcessedAt).toLocaleString() : 'unknown time';
    return `Last run for this chat: ${when} (msg index ${snap.lastProcessedIndex})`;
}

async function onExtendClicked(event) {
    event?.preventDefault?.();
    const button = event?.currentTarget;
    button?.classList?.add('disabled');
    try {
        setStatus('Working…', 'info');
        const result = await runExtendPipeline();
        setStatus(result, 'success');
        toastr.success(result, 'Lorebook Extender');
    } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        console.error(`[${MODULE_NAME}]`, e);
        setStatus(msg, 'error');
        toastr.error(msg, 'Lorebook Extender');
    } finally {
        button?.classList?.remove('disabled');
    }
}

async function onResetSnapshotClicked() {
    const ctx = SillyTavern.getContext();
    if (!ctx.chatMetadata) {
        setStatus('No chat is loaded', 'error');
        return;
    }
    delete ctx.chatMetadata[SNAPSHOT_KEY];
    await ctx.saveMetadata();
    setStatus(`${describeSnapshot()} — snapshot cleared.`, 'info');
    toastr.info('Snapshot cleared for this chat', 'Lorebook Extender');
}

async function onViewDiffClicked(event) {
    event?.preventDefault?.();
    const button = event?.currentTarget;
    button?.classList?.add('disabled');
    try {
        const ctx = SillyTavern.getContext();
        const settings = getSettings();

        // Validate prerequisites (same checks as the extend pipeline, minus chat).
        if (ctx.groupId) {
            throw new Error('Group chats are not supported (no single primary character)');
        }
        if (ctx.characterId === undefined || ctx.characterId === null) {
            throw new Error('No character is currently selected');
        }
        const character = ctx.characters[ctx.characterId];
        if (!character) {
            throw new Error('Active character could not be resolved');
        }
        const linkedName = character?.data?.extensions?.world;
        if (!linkedName || typeof linkedName !== 'string') {
            throw new Error('Active character has no primary lorebook linked');
        }

        // The card may currently point at a previously-generated sibling
        // (e.g. "MyChar - 2026-06-07 14-30-00"). Sibling discovery has to
        // happen against the true base, otherwise we'd be searching for
        // siblings of a sibling and miss the whole family. The "Base (linked)"
        // header in the diff dialog still shows linkedName — that's what's
        // actually loaded and edited on the left side.
        const baseName = resolveBaseLorebookName(linkedName, settings.dateFormat);

        // Refresh the world info list from the server so stale caches can't hide a sibling.
        try { await ctx.updateWorldInfoList?.(); } catch (e) {
            console.warn(`[${MODULE_NAME}] updateWorldInfoList failed (continuing):`, e);
        }

        const candidates = await findSiblingCandidates(baseName, settings.dateFormat);
        if (candidates.length === 0) {
            const allNames = await getWorldInfoNamesCompat(ctx);
            // Rank existing books by how plausibly they could be siblings, so
            // the user can immediately see whether there's a typo / case
            // mismatch / wrong "base lorebook" link on the character card.
            const ranked = rankProbableSiblings(baseName, allNames);
            const topMatches = ranked.slice(0, 5);
            const tail = allNames
                .filter(n => !topMatches.some(t => t.name === n))
                .slice(0, 10);

            const matchesLine = topMatches.length
                ? topMatches.map(m => `  • ${m.name}  (similarity ${m.score.toFixed(2)})`).join('\n')
                : '  (none)';
            const tailLine = tail.length ? `\nOther lorebooks (${allNames.length} total):\n` + tail.map(n => `  • ${n}`).join('\n') : '';

            const linkedNote = baseName !== linkedName
                ? `Card is linked to: "${linkedName}"\n(resolved base: "${baseName}")\n\n`
                : `Card is linked to: "${linkedName}"\n\n`;

            console.warn(
                `[${MODULE_NAME}] No siblings found.\n` +
                linkedNote +
                `Looking for siblings of base: "${baseName}"\n\n` +
                `Closest matches:\n${matchesLine}${tailLine}\n\n` +
                `A "sibling" must be a lorebook whose name starts with "${baseName}". ` +
                `If your sibling has a different name, either rename it or change the ` +
                `character card's linked lorebook to the matching base.`,
            );

            // Show the closest match (if any) in the toast itself so the user
            // doesn't always need to open devtools.
            const hint = topMatches.length
                ? `\nClosest existing: "${topMatches[0].name}"`
                : '';
            toastr.info(
                `No sibling of "${baseName}" found among ${allNames.length} lorebook${allNames.length === 1 ? '' : 's'}.${hint}\nSee browser console for details.`,
                'Lorebook Extender',
                { timeOut: 10000 },
            );
            return;
        }

        // Pick the sibling to use.
        /** @type {{name: string, ts: number|null, tier: string}} */
        let chosen;
        const strictCandidates = candidates.filter(c => c.tier === 'strict');

        if (strictCandidates.length > 0) {
            // Trust the newest strict match outright.
            chosen = strictCandidates[0];
        } else if (candidates.length === 1) {
            // Only one fuzzy/loose match — use it.
            chosen = candidates[0];
        } else {
            // Multiple loose/fuzzy candidates; let the user pick.
            const picked = await promptSiblingChoice(candidates, baseName);
            if (!picked) return; // cancelled
            chosen = picked;
        }

        const [oldData, newData] = await Promise.all([
            ctx.loadWorldInfo(linkedName),
            ctx.loadWorldInfo(chosen.name),
        ]);
        if (!oldData) throw new Error(`Could not load lorebook "${linkedName}"`);
        if (!newData) throw new Error(`Could not load lorebook "${chosen.name}"`);

        const diff = diffLorebooks(oldData, newData);
        const html = buildDiffHtml({
            originalName: linkedName,
            latestName: chosen.name,
            diff,
            editable: true,
        });

        const Popup = ctx.Popup;
        const POPUP_TYPE = ctx.POPUP_TYPE;
        const POPUP_RESULT = ctx.POPUP_RESULT;
        if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
            throw new Error('SillyTavern Popup API is unavailable');
        }

        // Track whether a save has been performed so we don't double-prompt for
        // discard after a successful save.
        let saved = false;

        const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            okButton: 'Close',
            allowVerticalScrolling: true,
            customButtons: [
                {
                    text: 'Save changes',
                    result: POPUP_RESULT.CUSTOM1,
                    appendAtEnd: false,
                },
            ],
            onClosing: async (popupInstance, _result) => {
                // popupInstance.result holds the resolved POPUP_RESULT value here.
                const result = popupInstance?.result;
                const root = popupInstance?.content;

                // SAVE path: write edits, keep popup open if it fails, close if it succeeds.
                if (result === POPUP_RESULT.CUSTOM1) {
                    try {
                        const summary = applyEditsToSibling(root, newData);
                        if (summary.missing.length > 0) {
                            console.warn(`[${MODULE_NAME}] Some edited entries could not be matched by uid:`, summary.missing);
                        }
                        if (summary.changed === 0) {
                            toastr.info('No edits to save.', 'Lorebook Extender');
                            // Don't close — let the user click Close explicitly.
                            return false;
                        }
                        await ctx.saveWorldInfo(chosen.name, newData, true);
                        saved = true;
                        toastr.success(
                            `Saved ${summary.changed} edit${summary.changed === 1 ? '' : 's'} to "${chosen.name}".`,
                            'Lorebook Extender',
                        );
                        return true;
                    } catch (err) {
                        console.error(`[${MODULE_NAME}] Save failed:`, err);
                        toastr.error(
                            `Save failed: ${err?.message ?? err}`,
                            'Lorebook Extender',
                        );
                        return false; // keep popup open
                    }
                }

                // CLOSE path: confirm discard if there are unsaved edits.
                if (!saved && root) {
                    const dirty = root.querySelectorAll('.lbx-diff-card[data-dirty="true"]').length;
                    if (dirty > 0) {
                        const confirmed = await Popup.show.confirm(
                            'Discard unsaved edits?',
                            `${dirty} entr${dirty === 1 ? 'y has' : 'ies have'} pending edits that have not been saved.`,
                        );
                        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return false;
                    }
                }
                return true;
            },
        });

        // Wire handlers AFTER the Popup constructor has built popup.content.
        wireEditModeHandlers(popup.content);

        await popup.show();
    } catch (e) {
        const msg = (e && e.message) ? e.message : String(e);
        console.error(`[${MODULE_NAME}]`, e);
        toastr.error(msg, 'Lorebook Extender');
    } finally {
        button?.classList?.remove('disabled');
    }
}

/**
 * Show a small popup with a <select> listing sibling candidates. The user
 * picks one and clicks OK; we read the selection from the live DOM node.
 * Returns the chosen candidate or null if cancelled.
 *
 * @param {Array<{name: string, ts: number|null, tier: string}>} candidates
 * @param {string} originalName
 * @returns {Promise<{name: string, ts: number|null, tier: string} | null>}
 */
async function promptSiblingChoice(candidates, originalName) {
    const ctx = SillyTavern.getContext();
    const Popup = ctx.Popup;
    const POPUP_TYPE = ctx.POPUP_TYPE;
    const POPUP_RESULT = ctx.POPUP_RESULT;
    if (!Popup || !POPUP_TYPE || !POPUP_RESULT) {
        // Fallback: just pick the first.
        return candidates[0] ?? null;
    }

    const optionsHtml = candidates.map((c, idx) => {
        const tag =
            c.tier === 'strict' ? '[strict]' :
            c.tier === 'loose'  ? '[loose]'  : '[fuzzy]';
        return `<option value="${idx}">${escapeHtml(tag)} ${escapeHtml(c.name)}</option>`;
    }).join('');

    const html = `
        <div class="lbx-diff-picker">
            <p>No strict-format sibling found for <code>${escapeHtml(originalName)}</code>.
            Pick which lorebook to compare against:</p>
            <select id="lbx_diff_pick" class="text_pole" style="width:100%; margin-top:6px;">
                ${optionsHtml}
            </select>
            <p class="lbx-hint" style="margin-top:6px; opacity:0.7; font-size:0.85em;">
                Tiers: <strong>strict</strong> = matches this extension's "<code>${escapeHtml(originalName)} - YYYY-MM-DD HH-mm-ss</code>" format;
                <strong>loose</strong> = starts with "<code>${escapeHtml(originalName)} - </code>" but a different suffix;
                <strong>fuzzy</strong> = name starts with "<code>${escapeHtml(originalName)}</code>".
            </p>
        </div>
    `;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
        wide: true,
        okButton: 'Compare',
        cancelButton: 'Cancel',
        allowVerticalScrolling: true,
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    // The select still lives in popup.content while the popup is being closed.
    const selectEl = popup.content?.querySelector?.('#lbx_diff_pick')
        || document.querySelector('#lbx_diff_pick');
    const idx = selectEl ? parseInt(/** @type {HTMLSelectElement} */(selectEl).value, 10) : 0;
    return candidates[Number.isFinite(idx) ? idx : 0] ?? null;
}

function bindUi(root) {
    const settings = getSettings();
    const $ = (sel) => /** @type {HTMLElement | null} */ (root.querySelector(sel));

    const enabledEl = /** @type {HTMLInputElement} */ ($('#lbx_enabled'));
    const systemEl = /** @type {HTMLTextAreaElement} */ ($('#lbx_system_prompt'));
    const userEl = /** @type {HTMLTextAreaElement} */ ($('#lbx_user_prompt'));
    const maxTokEl = /** @type {HTMLInputElement} */ ($('#lbx_max_tokens'));
    const maxVerEl = /** @type {HTMLInputElement} */ ($('#lbx_max_versions'));
    const includeEl = /** @type {HTMLInputElement} */ ($('#lbx_include_full'));
    const runBtn = $('#lbx_run');
    const resetBtn = $('#lbx_reset_snapshot');
    const viewDiffBtn = $('#lbx_view_diff');
    const profileEl = /** @type {HTMLSelectElement} */ ($('#lbx_profile'));
    statusEl = $('#lbx_status');

    // Initial values.
    enabledEl.checked = settings.enabled;
    systemEl.value = settings.systemPrompt;
    userEl.value = settings.userPromptTemplate;
    maxTokEl.value = String(settings.maxTokens);
    maxVerEl.value = String(settings.maxVersions);
    includeEl.checked = settings.includeFullChat;

    // Change handlers.
    enabledEl.addEventListener('change', () => { settings.enabled = enabledEl.checked; persistSettings(); });
    systemEl.addEventListener('input', () => { settings.systemPrompt = systemEl.value; persistSettings(); });
    userEl.addEventListener('input', () => { settings.userPromptTemplate = userEl.value; persistSettings(); });
    maxTokEl.addEventListener('change', () => {
        const v = parseInt(maxTokEl.value, 10);
        settings.maxTokens = Number.isFinite(v) && v > 0 ? v : DEFAULT_SETTINGS.maxTokens;
        maxTokEl.value = String(settings.maxTokens);
        persistSettings();
    });
    maxVerEl.addEventListener('change', () => {
        const v = parseInt(maxVerEl.value, 10);
        settings.maxVersions = Number.isFinite(v) && v >= 1 ? v : DEFAULT_SETTINGS.maxVersions;
        maxVerEl.value = String(settings.maxVersions);
        persistSettings();
    });
    includeEl.addEventListener('change', () => { settings.includeFullChat = includeEl.checked; persistSettings(); });

    runBtn?.addEventListener('click', onExtendClicked);
    resetBtn?.addEventListener('click', onResetSnapshotClicked);
    viewDiffBtn?.addEventListener('click', onViewDiffClicked);

    // Connection profile dropdown. Use the Connection Manager helper when available,
    // otherwise build a static placeholder.
    setupProfileDropdown(profileEl, settings);

    setStatus(describeSnapshot(), 'info');
}

function setupProfileDropdown(selectEl, settings) {
    if (!selectEl) return;
    const ctx = SillyTavern.getContext();
    const CMRS = ctx.ConnectionManagerRequestService;

    // Always start with the "(Active profile)" option.
    const repopulate = () => {
        selectEl.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '(Active profile)';
        selectEl.appendChild(placeholder);

        const profiles = ctx.extensionSettings?.connectionManager?.profiles ?? [];
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name + (p.mode ? ` [${p.mode}]` : '');
            selectEl.appendChild(opt);
        }
        // Restore selection.
        if (settings.profileId && profiles.some(p => p.id === settings.profileId)) {
            selectEl.value = settings.profileId;
        } else {
            selectEl.value = '';
            settings.profileId = '';
        }
    };

    repopulate();

    selectEl.addEventListener('change', () => {
        settings.profileId = selectEl.value || '';
        persistSettings();
    });

    // Subscribe to profile changes for live updates.
    const { eventSource, eventTypes } = ctx;
    const events = [
        eventTypes?.CONNECTION_PROFILE_CREATED,
        eventTypes?.CONNECTION_PROFILE_UPDATED,
        eventTypes?.CONNECTION_PROFILE_DELETED,
    ].filter(Boolean);
    for (const evt of events) {
        eventSource?.on?.(evt, () => repopulate());
    }

    // Surface a hint if Connection Manager isn't usable.
    if (!CMRS) {
        const hint = document.createElement('option');
        hint.value = '';
        hint.disabled = true;
        hint.textContent = '— Connection Manager not detected —';
        selectEl.appendChild(hint);
    }
}

// ------------------------------------------------------------- bootstrapping -

async function initialize() {
    const ctx = SillyTavern.getContext();
    getSettings(); // ensure defaults are persisted

    try {
        const html = await ctx.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings', {});
        // jQuery is available globally in SillyTavern.
        // eslint-disable-next-line no-undef
        $('#extensions_settings2').append(html);
        const rootEl = document.querySelector('#extensions_settings2 .lorebook-extender-settings');
        if (rootEl) bindUi(rootEl);
    } catch (e) {
        console.error(`[${MODULE_NAME}] Failed to render settings:`, e);
    }

    // Update status line when chat changes.
    ctx.eventSource?.on?.(ctx.eventTypes.CHAT_CHANGED, () => {
        setStatus(describeSnapshot(), 'info');
    });
}

// Bootstrap: defer all initialization until DOMReady so SillyTavern and
// jQuery are guaranteed to be available. Wrap in a try/catch so a single
// failure cannot break ST's "Extensions" panel for the user.
if (typeof jQuery === 'function') {
    jQuery(async () => {
        try {
            await initialize();
        } catch (err) {
            console.error(`[${MODULE_NAME}] init error:`, err);
        }
    });
} else {
    // Fallback if jQuery isn't loaded for some reason: try on next tick.
    setTimeout(() => {
        initialize().catch(err => console.error(`[${MODULE_NAME}] init error:`, err));
    }, 0);
}
