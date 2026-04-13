/**
 * cloud-sync.js
 * Hijacks localStorage to passively sync State to the Neon Database via our Render Proxy.
 *
 * Efficiency improvements (v2):
 *  - Debounce increased to 2500 ms so rapid consecutive writes merge into one request.
 *  - Announcement attachments (base64 blobs) are stripped before syncing — they can be
 *    several MB each and are the #1 cause of slow / dropped syncs.
 *  - profilePic blobs are also excluded (unchanged from v1).
 *  - Polling interval increased to 8 s (30 s when the browser tab is hidden).
 *  - Only keys that actually changed are written during hydration.
 *
 * Usage:
 * Add <script src="cloud-sync.js"></script> before <script src="db.js"></script>
 */

const SYNC_URL = 'https://attendease-messenger.onrender.com/api/db/sync';
const originalSetItem = Storage.prototype.setItem;

/**
 * Strip heavyweight blobs from a parsed student/teacher object before sending
 * to the cloud:
 *   • profilePic      — stored locally only, never synced
 *   • announcement attachments — base64 images/files can be multiple MB each;
 *     they are stored in localStorage only (large payloads cause slow/failed syncs)
 */
function _stripHeavyFields(key, value) {
    // ── Student records ──────────────────────────────────────────────────────
    if (key.startsWith('attendease_student_')) {
        try {
            const parsed = JSON.parse(value);
            if (!parsed) return value;
            const { profilePic, ...rest } = parsed;
            return JSON.stringify(rest);
        } catch { return value; }
    }

    // ── Teacher records ──────────────────────────────────────────────────────
    if (key.startsWith('attendease_teacher_')) {
        try {
            const parsed = JSON.parse(value);
            if (!parsed) return value;

            // Strip profilePic
            const { profilePic, ...rest } = parsed;

            // Strip attachment dataUrls from every announcement (keep metadata)
            if (Array.isArray(rest.announcements)) {
                rest.announcements = rest.announcements.map(a => ({
                    ...a,
                    attachments: (a.attachments || []).map(att => ({
                        name: att.name,
                        type: att.type,
                        // dataUrl intentionally omitted — stored in localStorage only
                    })),
                }));
            }

            return JSON.stringify(rest);
        } catch { return value; }
    }

    return value;
}

// ── 1. Hijack localStorage — push patches to cloud on every attendease_ write ──
let syncTimer = null;
const DEBOUNCE_MS = 2500;   // ← increased from 1 000 ms to batch rapid writes

Storage.prototype.setItem = function (key, value) {
    originalSetItem.call(this, key, value);

    if (key.startsWith('attendease_')) {
        window.__cloudSyncDirty = true;
        clearTimeout(syncTimer);
        syncTimer = setTimeout(async () => {
            const state = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (
                    k.startsWith('attendease_') &&
                    !k.startsWith('attendease_admin_pic_') &&
                    !k.startsWith('attendease_notifs_') &&
                    !k.startsWith('attendease_student_notifs_')
                ) {
                    state[k] = _stripHeavyFields(k, localStorage.getItem(k));
                }
            }
            try {
                await fetch(SYNC_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state),
                });
                console.log('[CloudSync] State pushed to Neon db');
            } catch (err) {
                console.warn('[CloudSync] Failed to push state', err);
            } finally {
                window.__cloudSyncDirty = false;
            }
        }, DEBOUNCE_MS);
    }
};

// ── 2. Initial hydration — pull cloud state before app boots ─────────────────
window.initCloudDb = async function () {
    if (window.__cloudSyncDirty) return; // Skip pulling if we have active pending local saves
    try {
        const res = await fetch(SYNC_URL);
        const data = await res.json();

        if (data.ok && data.state && Object.keys(data.state).length > 0) {
            let changed = false;

            for (const [key, value] of Object.entries(data.state)) {
                // ── Student records ─────────────────────────────────────────
                if (key.startsWith('attendease_student_')) {
                    try {
                        const local  = JSON.parse(localStorage.getItem(key) || '{}');
                        const remote = JSON.parse(value || '{}');

                        // Preserve local-only fields that are never in the cloud
                        if (local.profilePic)   remote.profilePic   = local.profilePic;

                        // Merge: cloud is authoritative for most fields, but keep
                        // any local guardianFbLink if cloud doesn't have it yet
                        if (local.guardianFbLink && !remote.guardianFbLink) {
                            remote.guardianFbLink = local.guardianFbLink;
                        }

                        const merged = JSON.stringify(remote);
                        if (localStorage.getItem(key) !== merged) {
                            originalSetItem.call(localStorage, key, merged);
                            changed = true;
                        }
                    } catch {
                        if (localStorage.getItem(key) !== value) {
                            originalSetItem.call(localStorage, key, value);
                            changed = true;
                        }
                    }
                }

                // ── Teacher records ─────────────────────────────────────────
                else if (key.startsWith('attendease_teacher_')) {
                    try {
                        const local  = JSON.parse(localStorage.getItem(key) || '{}');
                        const remote = JSON.parse(value || '{}');

                        // Preserve local profilePic
                        if (local.profilePic) remote.profilePic = local.profilePic;

                        // Restore attachment dataUrls for announcements from local copy
                        // (cloud only stores metadata; the actual blobs stay local)
                        const localAnn   = (local.announcements  || []);
                        const remoteAnn  = (remote.announcements || []);
                        remote.announcements = remoteAnn.map(ra => {
                            const la = localAnn.find(a => a.id === ra.id);
                            if (!la) return ra;
                            // Merge: use local attachments if cloud stripped them
                            return {
                                ...ra,
                                attachments: (ra.attachments || []).map((att, i) => ({
                                    ...att,
                                    // Restore dataUrl from local if available
                                    dataUrl: (la.attachments && la.attachments[i])
                                        ? la.attachments[i].dataUrl
                                        : att.dataUrl,
                                })),
                            };
                        });

                        const merged = JSON.stringify(remote);
                        if (localStorage.getItem(key) !== merged) {
                            originalSetItem.call(localStorage, key, merged);
                            changed = true;
                        }
                    } catch {
                        if (localStorage.getItem(key) !== value) {
                            originalSetItem.call(localStorage, key, value);
                            changed = true;
                        }
                    }
                }

                // ── Skip local-only keys ────────────────────────────────────
                else if (
                    key.startsWith('attendease_admin_pic_') ||
                    key.startsWith('attendease_notifs_') ||
                    key.startsWith('attendease_student_notifs_')
                ) {
                    // Never overwrite from cloud — these are local-only
                }

                // ── Everything else (users list, version, etc.) ─────────────
                else {
                    if (localStorage.getItem(key) !== value) {
                        originalSetItem.call(localStorage, key, value);
                        changed = true;
                    }
                }
            }

            if (changed) {
                console.log('[CloudSync] Synced local state with Neon DB!');
                if (window.renderDashboard)         window.renderDashboard();
                if (window.refreshAttendanceSummary) window.refreshAttendanceSummary();
            }
        }
    } catch (err) {
        // Silent fail — app still works from localStorage
    }
};

// ── 3. Adaptive polling: 8 s when visible, 30 s when tab is hidden ────────────
const POLL_ACTIVE_MS  =  8000;   // ← was 3 000 ms
const POLL_HIDDEN_MS  = 30000;

let _pollTimer = null;

function _schedulePoll() {
    clearTimeout(_pollTimer);
    const delay = document.hidden ? POLL_HIDDEN_MS : POLL_ACTIVE_MS;
    _pollTimer = setTimeout(async () => {
        if (window.initCloudDb) await window.initCloudDb();
        _schedulePoll();   // re-schedule after each completed poll
    }, delay);
}

// Start polling after an initial short pause (let the app boot first)
setTimeout(_schedulePoll, POLL_ACTIVE_MS);

// Adjust poll frequency instantly when tab visibility changes
document.addEventListener('visibilitychange', _schedulePoll);
