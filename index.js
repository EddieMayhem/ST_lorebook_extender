/*
 * Lorebook Extender - SillyTavern UI extension
 * License: AGPL-3.0
 *
 * On manual trigger, diffs the current chat against a per-chat snapshot,
 * sends the diff + the character's primary lorebook to a configurable LLM,
 * and saves the LLM's returned lorebook as a new timestamped sibling.
 * Old siblings beyond a configurable count are pruned (oldest first).
 */

import {
    createNewWorldInfo,
    deleteWorldInfo,
} from '../../../scripts/world-info.js';

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
    let newName = `${originalName} - ${formatStamp(settings.dateFormat)}`;
    const existing = new Set(ctx.getWorldInfoNames());
    if (existing.has(newName)) {
        for (let counter = 2; counter < 1000; counter++) {
            const candidate = `${newName}-${counter}`;
            if (!existing.has(candidate)) { newName = candidate; break; }
        }
    }

    // 7. Create + save.
    const created = await createNewWorldInfo(newName, { interactive: false });
    if (!created) {
        throw new Error(`Failed to create lorebook "${newName}"`);
    }
    await ctx.saveWorldInfo(newName, normalized, true);
    await ctx.updateWorldInfoList?.();

    // 8. Cleanup. Find siblings = anything with the exact "<original> - " prefix
    // whose remainder parses as our timestamp format.
    const prefix = `${originalName} - `;
    const limit = Math.max(1, Number(settings.maxVersions) || 5);
    const siblings = ctx.getWorldInfoNames()
        .filter(n => n !== originalName && n.startsWith(prefix))
        .map(n => {
            const suffix = n.slice(prefix.length).replace(/-\d+$/, ''); // strip trailing counter
            const ts = parseStampSuffix(suffix, settings.dateFormat);
            return ts === null ? null : { name: n, ts };
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);

    let deleted = 0;
    while (siblings.length > limit) {
        const victim = siblings.shift();
        if (victim.name === newName) continue; // never delete the one we just made
        try {
            const ok = await deleteWorldInfo(victim.name);
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
        sourceLorebook: originalName,
    };
    await ctx.saveMetadata();

    const parts = [
        `Created "${newName}" with ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`,
        `from ${baselineDescription}`,
    ];
    if (deleted > 0) parts.push(`pruned ${deleted} old version${deleted === 1 ? '' : 's'}`);
    return parts.join(' · ');
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

// Hook into APP_READY. eventSource is available immediately.
const ctx = SillyTavern.getContext();
if (ctx?.eventSource && ctx.eventTypes?.APP_READY) {
    ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
        initialize().catch(err => console.error(`[${MODULE_NAME}] init error:`, err));
    });
} else {
    // Fallback: try once on next tick.
    setTimeout(() => initialize().catch(err => console.error(`[${MODULE_NAME}] init error:`, err)), 0);
}
