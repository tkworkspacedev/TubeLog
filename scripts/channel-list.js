// ==UserScript==
// @name         YouTube Channel List Manager
// @namespace    https://github.com/gemini-code-assist/
// @version      1.0
// @description  Adds custom channel management features to YouTube.
// @author       Gemini
// @match        https://www.youtube.com/watch*
// @match        https://www.youtube.com/custom-list*
// @match        https://www.youtube.com/channel/*
// @match        https://www.youtube.com/@*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_addStyle
// @connect      googleapis.com
// ==/UserScript==

window.__waitForGMStorage__(function () {

    (function () {
        'use strict';

        const STORAGE_KEY = 'customChannelListData_v1';
        const MYLIST_STORAGE_KEY = 'mylistData_v16';
        const PLAYLIST_SYNC_KEY = 'playlistSyncData_v1';
        const AUTO_EXPORT_KEY = 'vm-auto-export-v1';
        const TRASH_AUTO_DELETE_KEY = 'vm-trash-auto-delete-v1';
        const THUMB_EXTRA_FOLDER_BTNS_KEY = 'vm-thumb-extra-folder-btns-v1';
        const VIEW_MODE_KEY = 'vm-folder-view-mode-v1';
        const GRID_MOVE_BUTTONS_KEY = 'vm-grid-move-buttons-v1';
        const LOCAL_UNIFIED_BACKUP_PREFIX = 'tubelog_backup';
        const API_KEY_STORAGE_KEY = 'youtubeCustomFeedApiKey';
        const SHARED_API_KEY_STORAGE_KEY = 'yt_api_key';
        const DEFAULT_FOLDER = 'お気に入り';
        const ALL_CHANNELS_VIRTUAL = 'all-channels'; // 仮想フォルダ: すべてのチャンネル

        // ── UI言語ヘルパー ──
        const _vmLang = (() => {
            try {
                const saved = GM_getValue('vm-ui-lang-v1', null);
                if (saved) return saved; // 'ja' or 'en'
            } catch (_) { }
            return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
        })();
        const i18n = (ja, en) => _vmLang === 'ja' ? ja : en;

        /**
         * channel.id からYouTubeチャンネルURLを生成する。
         * UC... 形式の正規IDなら /channel/ 、それ以外はハンドル (/@) として扱う。
         */
        function buildChannelUrl(id) {
            const raw = String(id || '').trim();
            if (!raw) return '#';
            if (/^https?:\/\//i.test(raw)) return raw;
            if (/^UC[\w-]{20,}$/.test(raw)) return `https://www.youtube.com/channel/${raw}`;
            // ハンドル (@name) またはそれ以外はすべて /@ で開く
            return `https://www.youtube.com/@${raw.replace(/^@/, '')}`;
        }

        const ADD_BTN_MODE_KEY = 'cl-add-btn-mode-v1'; // +ボタン挙動: 'instant' | 'select'
        const CUSTOM_LIST_PAGE_URL = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
            ? chrome.runtime.getURL('pages/custom-list.html')
            : 'https://www.youtube.com/custom-list';
        const MYLIST_PAGE_URL = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
            ? chrome.runtime.getURL('pages/mylist.html')
            : 'https://www.youtube.com/mylist';

        function getYouTubeApiKey() {
            const ownKey = String(GM_getValue(API_KEY_STORAGE_KEY, '') || '').trim();
            if (ownKey) return ownKey;
            return String(GM_getValue(SHARED_API_KEY_STORAGE_KEY, '') || '').trim();
        }

        function setYouTubeApiKey(value) {
            const key = String(value || '').trim();
            GM_setValue(API_KEY_STORAGE_KEY, key);
            GM_setValue(SHARED_API_KEY_STORAGE_KEY, key);
        }

        function parseJsonSafe(text, fallback) {
            try {
                return JSON.parse(text);
            } catch (_) {
                return fallback;
            }
        }

        function getThumbExtraFolderBtnsForBackup() {
            try {
                const gmVal = GM_getValue(THUMB_EXTRA_FOLDER_BTNS_KEY, null);
                if (Array.isArray(gmVal)) return gmVal;
            } catch (_) { }
            return parseJsonSafe(localStorage.getItem(THUMB_EXTRA_FOLDER_BTNS_KEY) || '[]', []);
        }

        function setThumbExtraFolderBtnsFromBackup(arr) {
            const list = Array.isArray(arr) ? arr : [];
            try { GM_setValue(THUMB_EXTRA_FOLDER_BTNS_KEY, list); } catch (_) { }
            try { localStorage.setItem(THUMB_EXTRA_FOLDER_BTNS_KEY, JSON.stringify(list)); } catch (_) { }
        }

        function getFolderViewModesForBackup() {
            return parseJsonSafe(localStorage.getItem(VIEW_MODE_KEY) || '{}', {});
        }

        function setFolderViewModesFromBackup(map) {
            const modes = (map && typeof map === 'object') ? map : {};
            try { localStorage.setItem(VIEW_MODE_KEY, JSON.stringify(modes)); } catch (_) { }
        }

        function getGridMoveButtonsForBackup() {
            const arr = parseJsonSafe(localStorage.getItem(GRID_MOVE_BUTTONS_KEY) || '[]', []);
            return Array.isArray(arr) ? arr : [];
        }

        function setGridMoveButtonsFromBackup(arr) {
            const list = Array.isArray(arr) ? arr : [];
            try { localStorage.setItem(GRID_MOVE_BUTTONS_KEY, JSON.stringify(list)); } catch (_) { }
        }

        // 無料プランの制限値（content.js と共通）
        const _FREE_PLAN_VIDEO_LIMIT      = 60;
        const _FREE_PLAN_FOLDER_LIMIT     = 3;
        const _FREE_PLAN_PER_FOLDER_LIMIT = 20;
        const _FREE_PLAN_MOVE_BTN_LIMIT   = 2;
        const _FREE_PLAN_CHANNEL_LIMIT    = 50;
        const _TRASH_FOLDER_NAME          = '__TRASH__';
        const _LICENSE_CACHE_TTL_MS       = 24 * 60 * 60 * 1000;
        const _LICENSE_STALE_GRACE_MS     = 7 * 24 * 60 * 60 * 1000;

        /** サイドバー「すべて (N)」と同じ集計（全フォルダの登録数合計） */
        function _countTotalChannelEntries(data) {
            if (!data || !data.folders || typeof data.folders !== 'object') return 0;
            return Object.values(data.folders).reduce(
                (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
                0
            );
        }

        function _getChannelLimitToastMessage(data) {
            const total = _countTotalChannelEntries(data);
            const n = _FREE_PLAN_CHANNEL_LIMIT;
            if (total > n) {
                return i18n(
                    `現在${total}件登録済みです。無料プランでは合計${n}件まで新規登録できます。既存のチャンネルはそのまま利用できます。追加するにはプレミアムプランが必要です。`,
                    `You have ${total} channels registered. The free plan allows up to ${n} in total. Existing channels remain available. Upgrade to Premium to add more.`
                );
            }
            return i18n(
                `無料プランのチャンネル登録上限（${n}件）に達しました。プレミアムプランで追加できます。`,
                `You have reached the free plan channel limit (${n} channels). Upgrade to Premium to add more.`
            );
        }

        function _isPremiumForImport() {
            try {
                const raw = GM_getValue('vm_license_state_v1', null);
                if (!raw) return false;
                const state = typeof raw === 'object' ? raw : JSON.parse(raw);
                if (state.valid !== true) return false;
                const age = Date.now() - (state.validatedAt || 0);
                if (age <= _LICENSE_CACHE_TTL_MS) return true;
                return age <= _LICENSE_STALE_GRACE_MS;
            } catch (_) { return false; }
        }

        const _FREE_INITIAL_FOLDERS = ['フォルダA', 'フォルダB', 'フォルダC'];
        const _CHANNEL_LIST_VIRTUAL_FOLDER = '__vm_channel_list__';

        function _setDefaultFolderName(name) {
            try { GM_setValue('vm-default-folder-name-v1', name); } catch (_) { }
        }

        /**
         * ★フォルダの動画切り詰め確認モーダル（20件超のフォルダがある場合）。
         * @param {string[]} toTrim
         * @param {object} folders
         * @returns {Promise<boolean>}
         */
        function _showFreePlanTrimModal(toTrim, folders) {
            return new Promise((resolve) => {
                const mk = (tag, props, style) => {
                    const el = document.createElement(tag);
                    if (props) Object.assign(el, props);
                    if (style) Object.assign(el.style, style);
                    return el;
                };
                const overlay = mk('div', {}, {
                    position: 'fixed', inset: '0', background: 'rgba(0,0,0,.75)',
                    zIndex: '2147483647', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
                });
                const modal = mk('div', {}, {
                    width: 'min(440px,95vw)', background: '#1f1f1f', color: '#f3f3f3',
                    border: '1px solid #3a3a3a', borderRadius: '12px', padding: '20px',
                    boxShadow: '0 12px 32px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', gap: '14px'
                });
                modal.appendChild(mk('h3', {
                    textContent: i18n('⭐ フォルダの動画を切り詰め', '⭐ Trim Videos in Folders')
                }, { margin: '0', fontSize: '15px' }));
                modal.appendChild(mk('p', {
                    textContent: i18n(
                        '以下の ⭐ フォルダは20件を超えています。登録の新しい順に20件まで残し、超過分は完全に削除されます（ゴミ箱には入りません）。',
                        'The following ⭐ folders exceed 20 videos. The 20 most recently added will be kept; the rest are permanently deleted (not moved to trash).'
                    )
                }, { margin: '0', fontSize: '12px', color: '#bbb', lineHeight: '1.6' }));

                const listWrap = mk('div', {}, { display: 'flex', flexDirection: 'column', gap: '4px', background: '#2a2a2a', borderRadius: '8px', padding: '8px' });
                toTrim.forEach(k => {
                    const n = Array.isArray(folders[k]) ? folders[k].length : 0;
                    const line = i18n('{name}：{n} 件 → 20 件', '{name}: {n} → 20')
                        .replace('{name}', k).replace('{n}', n);
                    listWrap.appendChild(mk('div', { textContent: line }, { fontSize: '12px', color: '#ffcc80', padding: '3px 4px' }));
                });
                modal.appendChild(listWrap);

                const btnRow = mk('div', {}, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
                const cancelBtn = mk('button', { textContent: i18n('キャンセル', 'Cancel'), type: 'button', className: 'vm-btn' }, { padding: '8px 16px', fontSize: '13px' });
                const okBtn = mk('button', { textContent: i18n('インポートする', 'Import'), type: 'button', className: 'vm-btn vm-btn-primary' }, { padding: '8px 16px', fontSize: '13px' });
                cancelBtn.onclick = () => { document.body.removeChild(overlay); resolve(false); };
                okBtn.onclick = () => { document.body.removeChild(overlay); resolve(true); };
                overlay.onclick = (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(false); } };
                btnRow.appendChild(cancelBtn);
                btnRow.appendChild(okBtn);
                modal.appendChild(btnRow);
                overlay.appendChild(modal);
                document.body.appendChild(overlay);
            });
        }

        /**
         * 非★フォルダがある場合の復元確認モーダル（トリム不要のケース）。
         * @param {string[]} starFolders
         * @param {string[]} lockedFolders
         * @returns {Promise<boolean>}
         */
        function _showFreePlanRestoreConfirmModal(starFolders, lockedFolders) {
            return new Promise((resolve) => {
                const mk = (tag, props, style) => {
                    const el = document.createElement(tag);
                    if (props) Object.assign(el, props);
                    if (style) Object.assign(el.style, style);
                    return el;
                };
                const overlay = mk('div', {}, {
                    position: 'fixed', inset: '0', background: 'rgba(0,0,0,.75)',
                    zIndex: '2147483647', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
                });
                const modal = mk('div', {}, {
                    width: 'min(440px,95vw)', background: '#1f1f1f', color: '#f3f3f3',
                    border: '1px solid #3a3a3a', borderRadius: '12px', padding: '20px',
                    boxShadow: '0 12px 32px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column', gap: '14px'
                });
                modal.appendChild(mk('h3', {
                    textContent: i18n('無料プランで復元', 'Restore on Free Plan')
                }, { margin: '0', fontSize: '15px' }));
                modal.appendChild(mk('p', {
                    textContent: i18n(
                        '⭐ フォルダのみ復元します。その他のフォルダはリストに残りますが開けません（データは保持されます）。',
                        'Only ⭐ folders will be restored. Other folders remain in the list but cannot be opened.'
                    )
                }, { margin: '0', fontSize: '12px', color: '#bbb', lineHeight: '1.6' }));

                const starWrap = mk('div', {}, { display: 'flex', flexDirection: 'column', gap: '4px' });
                starWrap.appendChild(mk('div', { textContent: '⭐ ' + starFolders.join('・') }, { fontSize: '12px', color: '#7ddb7d', padding: '3px 4px' }));
                if (lockedFolders.length > 0) {
                    const lockedLabel = i18n('（開けません）', ' (locked)');
                    starWrap.appendChild(mk('div', {
                        textContent: '🔒 ' + lockedFolders.join('・') + lockedLabel
                    }, { fontSize: '12px', color: '#999', padding: '3px 4px' }));
                }
                modal.appendChild(starWrap);

                const btnRow = mk('div', {}, { display: 'flex', gap: '8px', justifyContent: 'flex-end' });
                const cancelBtn = mk('button', { textContent: i18n('キャンセル', 'Cancel'), type: 'button', className: 'vm-btn' }, { padding: '8px 16px', fontSize: '13px' });
                const okBtn = mk('button', { textContent: i18n('復元する', 'Restore'), type: 'button', className: 'vm-btn vm-btn-primary' }, { padding: '8px 16px', fontSize: '13px' });
                cancelBtn.onclick = () => { document.body.removeChild(overlay); resolve(false); };
                okBtn.onclick = () => { document.body.removeChild(overlay); resolve(true); };
                overlay.onclick = (e) => { if (e.target === overlay) { document.body.removeChild(overlay); resolve(false); } };
                btnRow.appendChild(cancelBtn);
                btnRow.appendChild(okBtn);
                modal.appendChild(btnRow);
                overlay.appendChild(modal);
                document.body.appendChild(overlay);
            });
        }

        /**
         * 無料プランのインポート時: content.js の applyFreePlanLimitsToBackupInteractive と同じ方針。
         * ★フォルダは新しい順20件まで。非★フォルダはデータ保持＋グレーアウト。
         * @param {object} backup
         * @returns {Promise<boolean>}
         */
        async function _applyFreePlanLimitsToBackupInteractive(backup) {
            if (_isPremiumForImport()) return true;
            const isSpecial = k => k === _TRASH_FOLDER_NAME || k === _CHANNEL_LIST_VIRTUAL_FOLDER;

            if (backup.mylistData && backup.mylistData.folders) {
                const data = backup.mylistData;
                const orderedKeys = (Array.isArray(data.folderOrder) ? data.folderOrder : Object.keys(data.folders))
                    .filter(k => !isSpecial(k) && Object.prototype.hasOwnProperty.call(data.folders, k));

                let starFolders;
                if (Array.isArray(data.initialRootFolders) && data.initialRootFolders.length > 0) {
                    starFolders = data.initialRootFolders.filter(k => orderedKeys.includes(k));
                }
                if (!starFolders || starFolders.length === 0) {
                    starFolders = orderedKeys.filter(k => _FREE_INITIAL_FOLDERS.includes(k));
                }
                if (starFolders.length === 0) {
                    starFolders = orderedKeys.slice(0, _FREE_PLAN_FOLDER_LIMIT);
                }

                const toTrim = starFolders.filter(k => Array.isArray(data.folders[k]) && data.folders[k].length > _FREE_PLAN_PER_FOLDER_LIMIT);

                if (toTrim.length > 0) {
                    const confirmed = await _showFreePlanTrimModal(toTrim, data.folders);
                    if (!confirmed) return false;
                } else {
                    const hasNonStar = orderedKeys.some(k => !starFolders.includes(k));
                    if (hasNonStar) {
                        const confirmed = await _showFreePlanRestoreConfirmModal(
                            starFolders,
                            orderedKeys.filter(k => !starFolders.includes(k))
                        );
                        if (!confirmed) return false;
                    }
                }

                for (const k of starFolders) {
                    if (!Array.isArray(data.folders[k])) continue;
                    if (data.folders[k].length > _FREE_PLAN_PER_FOLDER_LIMIT) {
                        data.folders[k].sort((a, b) => {
                            const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0;
                            const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0;
                            return tb - ta;
                        });
                        data.folders[k] = data.folders[k].slice(0, _FREE_PLAN_PER_FOLDER_LIMIT);
                    }
                }

                data.initialRootFolders = [...starFolders];

                if (starFolders.length > 0) {
                    _setDefaultFolderName(starFolders[0]);
                }
            }

            if (Array.isArray(backup.gridMoveButtons) && backup.gridMoveButtons.length > _FREE_PLAN_MOVE_BTN_LIMIT) {
                backup.gridMoveButtons = backup.gridMoveButtons.slice(0, _FREE_PLAN_MOVE_BTN_LIMIT);
            }

            const freeSortKeys = new Set(['title', 'addedAt']);
            if (backup.mylistData && backup.mylistData.sortStateByFolder &&
                typeof backup.mylistData.sortStateByFolder === 'object') {
                Object.keys(backup.mylistData.sortStateByFolder).forEach(folder => {
                    const s = backup.mylistData.sortStateByFolder[folder];
                    if (s && s.key && !freeSortKeys.has(s.key)) {
                        backup.mylistData.sortStateByFolder[folder] = { key: 'addedAt', dir: -1 };
                    }
                });
            }

            return true;
        }

        const UNIFIED_BACKUP_EXTRA_PERSISTED_SPECS = [
            { key: 'mylistColumnWidths_v16', local: true },
            { key: 'vm-video-open-target-v1', gm: true },
            { key: 'vm-thumb-duration-badge-v1', local: true },
            { key: 'vm-settings-saved-at-v1', local: true },
            { key: 'vm-settings-details-state-v1', local: true },
            { key: 'vm-watch-button-customize-v1', gm: true, local: true },
            { key: 'vm-player-bar-btn-config-v1', gm: true },
            { key: 'vm-home-ch-btn-config-v1', gm: true },
            { key: 'vm-watch-note-window-v1', gm: true, local: true },
            { key: 'vm-hide-subfolder-list-v1', local: true },
            { key: 'vm-theme-v1', gm: true },
            { key: 'vm_folder_quick_target_v1', gm: true },
            { key: 'vm-grid-items-per-row-v1', local: true },
            { key: 'vm_license_key_v1', gm: true },
            { key: 'vm_license_state_v1', gm: true },
            { key: 'vm-ui-lang-v1', gm: true },
            { key: 'vm-mini-pl-size_v1', local: true },
            { key: 'vm-mini-pl-position_v1', local: true },
            { key: 'vm-mini-pl-state_v1', local: true },
            { key: 'vm-mini-pl-opacity-v1', gm: true, local: true },
            { key: 'vm-folder-collapse-v1', local: true },
            { key: 'vm-duration-backfill-last-at-v1', gm: true },
            { key: 'vm-playlist', gm: true, local: true },
            { key: 'vm-play-index', gm: true, local: true },
            { key: 'vm-playlist-meta', gm: true, local: true },
            { key: 'vm-play-loop-enabled', gm: true, local: true },
            { key: 'vm-play-stop-enabled', gm: true, local: true },
            { key: 'vm-jump-percent-v1', local: true },
            { key: 'vm-jump-percent-by-folder-v1', local: true },
            { key: 'vm-tag-presets', local: true },
            { key: 'cl-add-btn-mode-v1', local: true },
            { key: 'vm-sidebar-width', local: true },
            { key: 'vm_gdrive_backup_config_v1', local: true },
            { key: 'youtubeCustomFeedApiKey', gm: true },
            { key: 'vm_mobile_sync_password', gm: true },
            { key: 'vm-mobile-sort-mode', local: true },
            { key: 'channelListViewMode', local: true },
            { key: 'channelListViewSize', local: true },
            { key: 'channelListHeaderPinned', local: true },
            { key: 'vm-header-sticky-v1', gm: true },
            { key: 'vm-tree-guides-mode', local: true },
            { key: 'vm-tree-guides', local: true }
        ];

        function collectUnifiedBackupExtraPersistedSettings() {
            const result = {};
            UNIFIED_BACKUP_EXTRA_PERSISTED_SPECS.forEach((spec) => {
                const entry = {};
                if (spec.gm) {
                    try {
                        const sentinel = { __missing: true };
                        const value = GM_getValue(spec.key, sentinel);
                        if (value !== sentinel) entry.gm = value;
                    } catch (_) { }
                }
                if (spec.local) {
                    try {
                        const value = localStorage.getItem(spec.key);
                        if (value !== null) entry.local = value;
                    } catch (_) { }
                }
                if (Object.keys(entry).length) result[spec.key] = entry;
            });
            return result;
        }

        function applyUnifiedBackupExtraPersistedSettings(settings) {
            const source = (settings && typeof settings === 'object') ? settings : {};
            UNIFIED_BACKUP_EXTRA_PERSISTED_SPECS.forEach((spec) => {
                const entry = (source[spec.key] && typeof source[spec.key] === 'object') ? source[spec.key] : null;
                if (spec.gm) {
                    try {
                        if (entry && Object.prototype.hasOwnProperty.call(entry, 'gm')) {
                            GM_setValue(spec.key, entry.gm);
                        } else if (typeof GM_deleteValue === 'function') {
                            GM_deleteValue(spec.key);
                        }
                    } catch (_) { }
                }
                if (spec.local) {
                    try {
                        if (entry && Object.prototype.hasOwnProperty.call(entry, 'local')) {
                            localStorage.setItem(spec.key, String(entry.local));
                        } else {
                            localStorage.removeItem(spec.key);
                        }
                    } catch (_) { }
                }
            });
        }

        function buildUnifiedBackupPayload(channelDataOverride) {
            return {
                __version__: 4,
                __format__: 'ytvp-backup',
                exportedAt: new Date().toISOString(),
                defaultFolderName: GM_getValue('vm-default-folder-name-v1', null) || 'とりあえずマイリスト',
                mylist: GM_getValue(MYLIST_STORAGE_KEY, null),
                channelList: channelDataOverride || getChannelData(),
                syncSettings: GM_getValue(PLAYLIST_SYNC_KEY, null),
                ytApiKey: getYouTubeApiKey() || '',
                autoExport: parseJsonSafe(localStorage.getItem(AUTO_EXPORT_KEY) || '{}', {}),
                trashAutoDelete: parseJsonSafe(localStorage.getItem(TRASH_AUTO_DELETE_KEY) || '{}', {}),
                thumbExtraFolderBtns: getThumbExtraFolderBtnsForBackup(),
                folderViewModes: getFolderViewModesForBackup(),
                gridMoveButtons: getGridMoveButtonsForBackup(),
                extraPersistedSettings: collectUnifiedBackupExtraPersistedSettings()
            };
        }

        // ── Google Drive 自動バックアップトリガー（10秒デバウンス + 未保存フラグ） ──
        const GDRIVE_BACKUP_CONFIG_KEY = 'vm_gdrive_backup_config_v1';
        const GDRIVE_AUTO_BACKUP_DEBOUNCE_MS = 10000;
        let __vmGdriveAutoBackupTimer = null;
        let __vmGdrivePendingBackup = false;

        function _gdriveCfgEnabled() {
            try {
                const cfg = GM_getValue(GDRIVE_BACKUP_CONFIG_KEY, null);
                return !!(cfg && cfg.autoBackup);
            } catch (_) { return false; }
        }

        function _sendGdrivePush(label) {
            try {
                if (!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage)) return;
                const data = buildUnifiedBackupPayload();
                chrome.runtime.sendMessage({ type: 'GDRIVE_BACKUP_PUSH', data, label: label || 'channel-auto' }, () => {
                    void chrome.runtime.lastError;
                });
                __vmGdrivePendingBackup = false;
            } catch (_) {
                /* ignore */
            }
        }

        function triggerGdriveAutoBackupFromChannelList() {
            if (!_gdriveCfgEnabled()) return;
            __vmGdrivePendingBackup = true;
            if (__vmGdriveAutoBackupTimer) clearTimeout(__vmGdriveAutoBackupTimer);
            __vmGdriveAutoBackupTimer = setTimeout(() => {
                __vmGdriveAutoBackupTimer = null;
                _sendGdrivePush('channel-auto');
            }, GDRIVE_AUTO_BACKUP_DEBOUNCE_MS);
        }

        function flushGdriveBackupNowChannelList() {
            if (!_gdriveCfgEnabled()) return;
            if (!__vmGdrivePendingBackup) return;
            if (__vmGdriveAutoBackupTimer) { clearTimeout(__vmGdriveAutoBackupTimer); __vmGdriveAutoBackupTimer = null; }
            _sendGdrivePush('flush-on-unload');
        }

        // タブクローズ・リロード・ナビゲーション時のガード
        // custom-list / YouTube通常ページでは離脱確認ダイアログは出さず、
        // バックアップ送信のみ試みる。
        window.addEventListener('beforeunload', (e) => {
            try {
                if (!__vmGdrivePendingBackup || !_gdriveCfgEnabled()) return;
                flushGdriveBackupNowChannelList();
            } catch (_) { /* noop */ }
        });
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden' && __vmGdrivePendingBackup) {
                flushGdriveBackupNowChannelList();
            }
        });

        function parseUnifiedBackupPayload(parsed) {
            let mylistData = null;
            let channelListData = null;
            let syncData = null;
            let syncConfig = null;
            let ytApiKey = null;
            let autoExport = null;
            let trashAutoDelete = null;
            let thumbExtraFolderBtns = null;
            let folderViewModes = null;
            let gridMoveButtons = null;
            let extraPersistedSettings = null;

            if (parsed && parsed.__version__ && (parsed.mylist || parsed.channelList)) {
                mylistData = parsed.mylist || null;
                channelListData = parsed.channelList || null;
                syncData = parsed.syncSettings || null;
                syncConfig = parsed.syncConfig || null;
                ytApiKey = parsed.ytApiKey || null;
                autoExport = parsed.autoExport || null;
                trashAutoDelete = parsed.trashAutoDelete || null;
                thumbExtraFolderBtns = Array.isArray(parsed.thumbExtraFolderBtns) ? parsed.thumbExtraFolderBtns : null;
                folderViewModes = (parsed.folderViewModes && typeof parsed.folderViewModes === 'object') ? parsed.folderViewModes : null;
                gridMoveButtons = Array.isArray(parsed.gridMoveButtons) ? parsed.gridMoveButtons : null;
                extraPersistedSettings = (parsed.extraPersistedSettings && typeof parsed.extraPersistedSettings === 'object')
                    ? parsed.extraPersistedSettings
                    : null;
            } else if (parsed && typeof parsed === 'object' && parsed.folders && parsed.folderOrder) {
                channelListData = parsed;
            }

            return {
                mylistData,
                channelListData,
                syncData,
                syncConfig,
                ytApiKey,
                autoExport,
                trashAutoDelete,
                thumbExtraFolderBtns,
                folderViewModes,
                gridMoveButtons,
                extraPersistedSettings
            };
        }

        function showImportTargetSelectorModal(hasMylist, hasChannel) {
            if (hasMylist && !hasChannel) return Promise.resolve('mylist');
            if (!hasMylist && hasChannel) return Promise.resolve('channel');
            if (!hasMylist && !hasChannel) return Promise.resolve(null);

            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;';

                const modal = document.createElement('div');
                modal.style.cssText = 'width:min(520px,94vw);background:#1f1f1f;color:#f3f3f3;border:1px solid #3a3a3a;border-radius:12px;padding:16px 16px 12px;box-shadow:0 12px 32px rgba(0,0,0,.45);';

                const title = document.createElement('h3');
                title.textContent = i18n('インポート対象を選択', 'Select Import Target');
                title.style.cssText = 'margin:0 0 8px;font-size:18px;';

                const desc = document.createElement('p');
                desc.textContent = i18n('復元したい対象を選択してください。', 'Select what you want to restore.');
                desc.style.cssText = 'margin:0 0 12px;color:#bcbcbc;font-size:13px;line-height:1.5;';

                const list = document.createElement('div');
                list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;';

                const makeChoiceBtn = (label, sub, mode, enabled = true) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.disabled = !enabled;
                    button.style.cssText = `text-align:left;padding:12px;border-radius:10px;border:1px solid ${enabled ? '#4a4a4a' : '#353535'};background:${enabled ? '#2a2a2a' : '#242424'};color:${enabled ? '#fff' : '#8f8f8f'};cursor:${enabled ? 'pointer' : 'not-allowed'};`;

                    const main = document.createElement('div');
                    main.textContent = label;
                    main.style.cssText = 'font-weight:700;font-size:14px;';

                    const subText = document.createElement('div');
                    subText.textContent = sub;
                    subText.style.cssText = 'margin-top:4px;font-size:12px;color:#b5b5b5;';

                    button.appendChild(main);
                    button.appendChild(subText);
                    if (enabled) {
                        button.addEventListener('mouseenter', () => { button.style.background = '#333'; });
                        button.addEventListener('mouseleave', () => { button.style.background = '#2a2a2a'; });
                        button.addEventListener('click', () => {
                            cleanup();
                            resolve(mode);
                        });
                    }
                    return button;
                };

                list.appendChild(makeChoiceBtn('すべてインポート', 'マイリストとチャンネルリストを復元', 'all', true));
                list.appendChild(makeChoiceBtn('マイリストのみ', 'チャンネルリストはそのまま維持', 'mylist', !!hasMylist));
                list.appendChild(makeChoiceBtn('チャンネルリストのみ', 'マイリストはそのまま維持', 'channel', !!hasChannel));

                const footer = document.createElement('div');
                footer.style.cssText = 'display:flex;justify-content:flex-end;';
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.textContent = 'キャンセル';
                cancel.style.cssText = 'padding:8px 12px;border:none;border-radius:8px;background:#4c4c4c;color:#fff;cursor:pointer;';

                const onEsc = (event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault();
                        cleanup();
                        resolve(null);
                    }
                };

                const cleanup = () => {
                    document.removeEventListener('keydown', onEsc);
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                };

                cancel.addEventListener('click', () => {
                    cleanup();
                    resolve(null);
                });

                overlay.addEventListener('click', (event) => {
                    if (event.target === overlay) {
                        cleanup();
                        resolve(null);
                    }
                });

                document.addEventListener('keydown', onEsc);
                footer.appendChild(cancel);

                modal.appendChild(title);
                modal.appendChild(desc);
                modal.appendChild(list);
                modal.appendChild(footer);
                overlay.appendChild(modal);
                document.body.appendChild(overlay);
            });
        }

        function isCustomListPagePath(pathname) {
            const p = String(pathname || location.pathname || '');
            return p === '/custom-list' || p === '/custom-list.html' || p.endsWith('/custom-list.html');
        }

        // 1回限りのデータ移行処理 (localStorage -> GM_getValue)
        function migrateDataOnce() {
            const gmRaw = GM_getValue(STORAGE_KEY, null);
            const legacyRaw = localStorage.getItem(STORAGE_KEY);

            if (!gmRaw && legacyRaw) {
                try {
                    const legacyData = JSON.parse(legacyRaw);
                    if (legacyData && legacyData.folders) {
                        GM_setValue(STORAGE_KEY, legacyData);
                        try {
                            localStorage.removeItem(STORAGE_KEY);
                        } catch (_) {
                            // noop
                        }
                    }
                } catch (e) {
                    console.error('データ移行に失敗:', e);
                }
            } else if (gmRaw && legacyRaw) {
                try {
                    localStorage.removeItem(STORAGE_KEY);
                } catch (_) {
                    // noop
                }
            }
        }
        migrateDataOnce();

        /* ---------------------------
            データ管理
        --------------------------- */
        function getChannelData() {
            let data = {};
            try {
                const raw = GM_getValue(STORAGE_KEY, null);
                if (raw && typeof raw === 'object') {
                    data = raw;
                } else if (typeof raw === 'string') {
                    data = JSON.parse(raw);
                }
            } catch (e) {
                console.error('チャンネルデータの読み込みに失敗:', e);
            }
            if (!data.folders || typeof data.folders !== 'object') {
                data = { folders: { [DEFAULT_FOLDER]: [] }, folderOrder: [DEFAULT_FOLDER] };
            }
            if (!data.folders[DEFAULT_FOLDER]) {
                data.folders[DEFAULT_FOLDER] = [];
            }
            if (!Array.isArray(data.folderOrder) || !data.folderOrder.includes(DEFAULT_FOLDER)) {
                data.folderOrder = [DEFAULT_FOLDER, ...Object.keys(data.folders).filter(f => f !== DEFAULT_FOLDER)];
            }
            return data;
        }

        function saveChannelData(data) {
            try {
                GM_setValue(STORAGE_KEY, data);
                // localStorage にもミラー（content.js 側のレガシー読み込みに備える）
                try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) { }
                // ローカル変更タイムスタンプを記録（自動pull上書き防止用）
                const now = Date.now();
                window.__vmLastChannelSaveAt = now;
                try { GM_setValue('vm_last_channel_save_at_v1', now); } catch (_) { }
                // 未プッシュフラグを立てる（次回起動時にpushを優先させる）
                try { GM_setValue('vm_firebase_push_pending_v1', now); } catch (_) { }
                // content.js 側に通知して Firebase 自動 push を即トリガーさせる
                // （これが無いと削除直後の自動 pull で削除前データに巻き戻る場合がある）
                try {
                    document.dispatchEvent(new CustomEvent('vm-channel-data-saved', { detail: { savedAt: now } }));
                } catch (_) { }
                // Google Drive 自動バックアップを発火（拡張ページでも動作）
                try { triggerGdriveAutoBackupFromChannelList(); } catch (_) { }
            } catch (e) {
                console.error('チャンネルデータの保存に失敗:', e);
            }
        }

        function showToast(msg) {
            const id = 'vm-channel-list-toast';
            let toast = document.getElementById(id);
            if (toast) toast.remove();
            toast = document.createElement('div');
            toast.id = id;
            toast.textContent = msg;
            Object.assign(toast.style, {
                position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
                padding: '10px 16px', background: 'rgba(0,0,0,0.85)', color: '#fff',
                borderRadius: '8px', zIndex: 999999, fontSize: '14px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)', whiteSpace: 'nowrap',
                maxWidth: '90vw', overflow: 'hidden', textOverflow: 'ellipsis'
            });
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 2500);
        }

        /* ---------------------------
            動画ページでの処理
        --------------------------- */
        async function addChannelFromWatchPage() {
            const videoId = new URL(location.href).searchParams.get('v');
            if (!videoId) {
                showToast(i18n('動画IDが取得できませんでした。', 'Could not retrieve video ID.'));
                return;
            }

            // チャンネル情報をページから取得 (ytInitialDataから取得を試みる)
            let channelId = '', channelName = '', iconUrl = '';
            try {
                // 埋め込みデータから取得する方がHTML構造の変更に強い
                const renderer = window.ytInitialData?.contents?.twoColumnWatchNextResults?.results?.results?.contents
                    ?.find(c => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer?.videoOwner?.videoOwnerRenderer;
                if (renderer) {
                    channelId = renderer.channelId;
                    channelName = renderer.title?.runs?.[0]?.text;
                    if (renderer.thumbnail?.thumbnails?.length > 0) {
                        // 一番大きいサイズのアイコンを取得
                        iconUrl = renderer.thumbnail.thumbnails[renderer.thumbnail.thumbnails.length - 1].url;
                    }
                }
            } catch (e) {
                console.error('ytInitialDataからのチャンネル情報取得に失敗:', e);
            }

            // 埋め込みデータから取得できなかった場合のフォールバック
            if (!channelId) {
                const channelLink = document.querySelector(
                    'ytd-video-owner-renderer .ytd-channel-name a.yt-simple-endpoint,' +
                    '#owner-name a.yt-simple-endpoint,' +
                    '#meta-contents #channel-name a,' +
                    '#upload-info #owner-name a'
                );

                if (channelLink) {
                    channelName = (channelLink.textContent || '').trim();
                    const img = channelLink.closest('ytd-video-owner-renderer')?.querySelector('img#img');
                    if (img) {
                        iconUrl = img.src;
                    }
                    // メタデータからチャンネルIDを取得する方が確実
                    const meta = document.querySelector('meta[property="og:url"][content*="/channel/"]');
                    if (meta) {
                        const match = meta.content.match(/\/channel\/([a-zA-Z0-9_-]+)/);
                        if (match) channelId = match[1];
                    }
                }
            }

            // さらにフォールバックとして ytInitialPlayerResponse から取得を試みる
            if (!channelId) {
                try {
                    const details = window.ytInitialPlayerResponse?.videoDetails;
                    if (details) {
                        channelId = details.channelId;
                        channelName = details.author;
                    }
                } catch (e) {
                    console.error('ytInitialPlayerResponseからのチャンネル情報取得に失敗:', e);
                }
            }

            // 最終手段: ページ HTML から channelId を正規表現で抽出（読み取りのみ・YouTube 埋め込み JSON 用）
            if (!channelId) {
                try {
                    const pageHtml = document.documentElement.innerHTML;
                    const match = pageHtml.match(/"channelId":"(UC[\w-]{22})"/);
                    if (match && match[1]) {
                        channelId = match[1];
                        // チャンネル名は取得済みのものを利用、なければytInitialPlayerResponseから再試行
                        if (!channelName) channelName = window.ytInitialPlayerResponse?.videoDetails?.author || 'チャンネル名不明';
                    }
                } catch (e) {
                    console.error('HTMLからのチャンネルID取得に失敗:', e);
                }
            }

            if (!channelId) {
                showToast(i18n('チャンネル情報が取得できませんでした。', 'Could not retrieve channel info.'));
                return;
            }

            const data = getChannelData();
            const list = data.folders[DEFAULT_FOLDER];

            if (list.some(ch => ch.id === channelId)) {
                showToast(i18n('このチャンネルは既に追加されています。', 'This channel is already added.'));
                return;
            }

            if (!_isPremiumForImport() && _countTotalChannelEntries(data) >= _FREE_PLAN_CHANNEL_LIMIT) {
                showToast(_getChannelLimitToastMessage(data));
                return;
            }

            const newChannel = {
                id: channelId,
                name: channelName,
                addedAt: new Date().toISOString(),
                iconUrl: iconUrl
            };

            list.unshift(newChannel); // 先頭に追加
            saveChannelData(data);
            showToast(i18n(`「${channelName}」を登録しました。`, `Added "${channelName}" to the channel list.`));
        }

        // タイトル直下の共通コンテナを確実に用意（watchメタデータ配下を優先）
        function ensureTitleButtonsContainer() {
            let container = document.getElementById('vm-mylist-buttons');
            const metadata = document.querySelector('ytd-watch-metadata');
            if (container && container.isConnected && (!metadata || metadata.contains(container))) return container;
            let anchor = null;
            if (metadata) {
                anchor = metadata.querySelector('#title') || metadata.querySelector('h1');
            }
            if (!anchor && !metadata) {
                anchor = document.querySelector('#title');
            }
            if (!anchor || !anchor.parentNode) return null;
            if (!container) {
                container = document.createElement('div');
                container.id = 'vm-mylist-buttons';
                container.style.marginTop = '4px';
            }
            if (anchor.nextSibling) {
                anchor.parentNode.insertBefore(container, anchor.nextSibling);
            } else {
                anchor.parentNode.appendChild(container);
            }
            return container;
        }

        function insertButtonsOnWatchPage(targetContainer) {
            // mylist.js のボタンコンテナが見つからない場合は、確実に生成
            targetContainer = targetContainer || ensureTitleButtonsContainer();
            if (!targetContainer) return; // 挿入先がまだない

            // 既にボタンが追加されている場合は何もしない（個別IDで確認）
            const existingAddBtn = targetContainer.querySelector('#vm-channel-add-btn');
            const existingOpenBtn = targetContainer.querySelector('#vm-channel-open-btn');
            if (existingAddBtn && existingOpenBtn) return; // 両方存在すれば完了

            // mylist.js のボタンと同じスタイルを適用するヘルパー関数
            const styleBtn = (btn, bgColor, fontSize = '11px') => {
                Object.assign(btn.style, {
                    margin: '2px 4px 2px 0', padding: '2px 6px', background: bgColor, color: '#fff',
                    border: 'none', borderRadius: '3px', cursor: 'pointer', fontSize: fontSize,
                    display: 'inline-flex', alignItems: 'center', gap: '4px', lineHeight: 'normal'
                });
            };

            // 「チャンネル登録」ボタンを作成（既存がなければ）
            if (!existingAddBtn) {
                const addButton = document.createElement('button');
                addButton.id = 'vm-channel-add-btn';
                addButton.className = 'custom-channel-list-btn';
                addButton.textContent = 'チャンネル登録';
                styleBtn(addButton, '#065fd4'); // 青色
                addButton.addEventListener('click', addChannelFromWatchPage);

                // 「マイリストを開く」ボタンがあればその前に、なければコンテナの先頭に追加
                const openMylistBtn = targetContainer.querySelector('#vm-mylist-open');
                if (openMylistBtn) {
                    targetContainer.insertBefore(addButton, openMylistBtn);
                } else {
                    targetContainer.insertBefore(addButton, targetContainer.firstChild);
                }
            }

            // 「チャンネル一覧」ボタンを作成（既存がなければ）
            if (!existingOpenBtn) {
                const openButton = document.createElement('button');
                openButton.id = 'vm-channel-open-btn';
                openButton.className = 'custom-channel-list-btn';
                openButton.textContent = 'チャンネル一覧';
                styleBtn(openButton, '#000000'); // 黒色
                openButton.addEventListener('click', () => window.open(CUSTOM_LIST_PAGE_URL, 'youtube_custom_channel_list'));

                // チャンネル登録ボタンの次に配置
                const addBtn = targetContainer.querySelector('#vm-channel-add-btn');
                if (addBtn && addBtn.nextSibling) {
                    targetContainer.insertBefore(openButton, addBtn.nextSibling);
                } else if (addBtn) {
                    targetContainer.insertBefore(openButton, addBtn.nextSibling);
                } else {
                    targetContainer.appendChild(openButton);
                }
            }
        }

        function initWatchPage() {
            // DOMの再描画で消えた場合も自動復元するための監視
            let metaObserver = null;
            let insertAttempts = 0;
            const MAX_ATTEMPTS = 5;

            function tryInsertButtons() {
                if (!location.pathname.startsWith('/watch')) return false;
                const container = ensureTitleButtonsContainer();
                if (!container) return false;

                // マイリストボタンが挿入されるまで少し待つ（協調動作）
                const mylistBtn = container.querySelector('#vm-mylist-add');
                if (!mylistBtn && insertAttempts < MAX_ATTEMPTS) {
                    insertAttempts++;
                    setTimeout(tryInsertButtons, 200);
                    return false;
                }

                insertButtonsOnWatchPage(container);
                insertAttempts = 0;
                return true;
            }

            function attachObserver() {
                if (metaObserver) { try { metaObserver.disconnect(); } catch (_) { } metaObserver = null; }
                const target = document.querySelector('ytd-watch-metadata') || document.body;
                if (!target) return;

                metaObserver = new MutationObserver((mutations) => {
                    if (!location.pathname.startsWith('/watch')) return;

                    // コンテナやボタンの削除を検出した場合のみ再挿入
                    const containerRemoved = mutations.some(m =>
                        Array.from(m.removedNodes).some(n =>
                            n.id === 'vm-mylist-buttons' ||
                            n.id === 'vm-channel-add-btn' ||
                            n.id === 'vm-channel-open-btn'
                        )
                    );

                    if (containerRemoved) {
                        setTimeout(tryInsertButtons, 100);
                    }
                });
                metaObserver.observe(target, { childList: true, subtree: true });
            }

            const onNav = () => {
                if (!location.pathname.startsWith('/watch')) return;
                insertAttempts = 0;

                // マイリストボタンが先に挿入されるよう、少し遅延
                setTimeout(() => {
                    tryInsertButtons();
                    attachObserver();
                }, 600);
            };

            document.addEventListener('yt-navigate-finish', () => setTimeout(onNav, 0));
            // 初期読み込み
            if (location.pathname.startsWith('/watch')) {
                onNav();
            }
        }

        /* ---------------------------
            チャンネルページでの処理
        --------------------------- */
        async function addChannelFromChannelPage() {
            let channelId = '', channelName = '', iconUrl = '';

            // 埋め込みデータから取得するのが最も確実
            try {
                const renderer = window.ytInitialData?.header?.c4TabbedHeaderRenderer;
                if (renderer) {
                    channelId = renderer.channelId;
                    channelName = renderer.title;
                    if (renderer.avatar?.thumbnails?.length > 0) {
                        iconUrl = renderer.avatar.thumbnails[renderer.avatar.thumbnails.length - 1].url;
                    }
                }
            } catch (e) {
                console.error('ytInitialDataからのチャンネル情報取得に失敗:', e);
            }

            // フォールバック: メタデータやURLから取得
            if (!channelId) {
                try {
                    const meta = document.querySelector('meta[property="og:url"][content*="/channel/"]');
                    if (meta) {
                        const match = meta.content.match(/\/channel\/([a-zA-Z0-9_-]+)/);
                        if (match) channelId = match[1];
                    }
                } catch (e) {
                    console.error('メタデータからのチャンネルID取得に失敗:', e);
                }
            }

            if (!channelName) {
                channelName = document.querySelector('#channel-name yt-formatted-string')?.textContent || 'チャンネル名不明';
            }
            if (!iconUrl) {
                iconUrl = document.querySelector('#avatar img')?.src || '';
            }

            if (!channelId) {
                showToast(i18n('チャンネル情報が取得できませんでした。', 'Could not retrieve channel info.'));
                return;
            }

            const data = getChannelData();
            const list = data.folders[DEFAULT_FOLDER];

            if (list.some(ch => ch.id === channelId)) {
                showToast(i18n('このチャンネルは既に追加されています。', 'This channel is already added.'));
                return;
            }

            if (!_isPremiumForImport() && _countTotalChannelEntries(data) >= _FREE_PLAN_CHANNEL_LIMIT) {
                showToast(_getChannelLimitToastMessage(data));
                return;
            }

            const newChannel = {
                id: channelId,
                name: channelName,
                addedAt: new Date().toISOString(),
                iconUrl: iconUrl
            };

            list.unshift(newChannel);
            saveChannelData(data);
            showToast(i18n(`「${channelName}」を登録しました。`, `Added "${channelName}" to the channel list.`));
        }

        function insertButtonsOnChannelPage() {
            if (document.getElementById('custom-channel-list-buttons')) return;

            const container = createButtonsContainer(addChannelFromChannelPage);
            // チャンネル名の横か下にボタンを配置するため、チャンネル名コンテナを探す
            const target = document.querySelector(
                '#meta.ytd-c4-tabbed-header-renderer,' +
                '#text-container.ytd-channel-header-renderer,' +
                'ytd-channel-tagline-renderer,' +
                '#channel-header-container #buttons'
            );

            if (target) {
                // チャンネル名コンテナの後ろにボタンを挿入
                target.appendChild(container);
                // ボタンに少し上のマージンを追加して見た目を調整
                container.style.marginTop = '10px';
            }
        }

        /* ---------------------------
            一覧ページ (/custom-list) の処理
        --------------------------- */
        function renderListPage() {
            document.title = i18n('つべろぐ', 'TubeLog');
            while (document.body.firstChild) {
                document.body.removeChild(document.body.firstChild);
            }

            GM_addStyle(`
            :root { --bg: #0f0f0f; --panel-bg: #181818; --text: #f1f1f1; --sub-text: #aaa; --border: #3f3f3f; --accent: #c00; --vm-scrollbar-size:10px; --vm-scrollbar-thumb:rgba(207,207,207,0.28); --vm-scrollbar-thumb-hover:rgba(207,207,207,0.40); --vm-scrollbar-thumb-active:rgba(207,207,207,0.52); }
            html { background: var(--bg) !important; }
            body { background: var(--bg) !important; color: var(--text); font-family: "Arial", sans-serif; margin: 0; }
            html, body { height: 100%; overflow: hidden; }
            html.vm-mobile, html.vm-mobile body { overflow: auto; }
            #vm-custom-list-root { background: var(--bg) !important; font-size: 20px !important; zoom: 1 !important; font-family: "Arial", sans-serif !important; }
            #vm-font-probe { position: absolute; left: -9999px; top: -9999px; visibility: hidden; font-size: 100px; line-height: 1; padding: 0; margin: 0; font-family: "Arial", sans-serif !important; }
            .page-container { display: flex; height: 100%; min-height: 100vh; }
            .sidebar { width: 240px; background: var(--panel-bg) !important; border-right: none; display: flex; flex-direction: column; padding: 12px; scrollbar-width: thin; scrollbar-color: var(--vm-scrollbar-thumb) transparent; flex-shrink: 0; }
            .sidebar::-webkit-scrollbar { width: var(--vm-scrollbar-size); }
            .sidebar::-webkit-scrollbar-track { background: transparent; }
            .sidebar::-webkit-scrollbar-thumb { background-color: var(--vm-scrollbar-thumb); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
            .sidebar::-webkit-scrollbar-thumb:hover { background-color: var(--vm-scrollbar-thumb-hover); }
            .sidebar::-webkit-scrollbar-thumb:active { background-color: var(--vm-scrollbar-thumb-active); }
            .vm-sidebar-resizer { width: 4px; flex-shrink: 0; cursor: col-resize; background: var(--accent); opacity: 0.55; transition: opacity 0.15s; position: relative; z-index: 10; }
            .vm-sidebar-resizer:hover, .vm-sidebar-resizer.dragging { opacity: 1; }
            html.vm-mobile .vm-sidebar-resizer { display: none; }
            .main-content { flex-grow: 1; background: var(--bg) !important; padding: 0; overflow: hidden; display: flex; flex-direction: column; min-height: 0; min-width: 0; scrollbar-width: thin; scrollbar-color: var(--vm-scrollbar-thumb) transparent; }
            .main-content::-webkit-scrollbar { width: var(--vm-scrollbar-size); }
            .main-content::-webkit-scrollbar-track { background: transparent; }
            .main-content::-webkit-scrollbar-thumb { background-color: var(--vm-scrollbar-thumb); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
            .main-content::-webkit-scrollbar-thumb:hover { background-color: var(--vm-scrollbar-thumb-hover); }
            .main-content::-webkit-scrollbar-thumb:active { background-color: var(--vm-scrollbar-thumb-active); }
            .sidebar h2 { font-size: 1.2em; margin: 0 0 16px; }
            .folder-list { list-style: none; padding: 0; margin: 0; }
            .folder-item { padding: 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
            .folder-item .cl-channel-limit-hint { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-left: 4px; border: 1px solid rgba(255,255,255,0.45); border-radius: 50%; font-size: 10px; font-weight: 700; font-style: italic; line-height: 1; opacity: 0.75; flex-shrink: 0; cursor: help; }
            .folder-item .cl-channel-limit-hint:hover { opacity: 1; }
            .folder-item.active .cl-channel-limit-hint { border-color: rgba(255,255,255,0.9); }
            .folder-item:hover { background: #333; }
            .folder-item.active { background: var(--accent); color: white; font-weight: bold; }
            .folder-actions { display: flex; }
            .folder-actions button { background: none; border: none; color: var(--sub-text); cursor: pointer; font-size: 16px; padding: 4px; }
            .folder-actions button:hover { color: white; }
            .btn { background: #333; color: white; border: 1px solid #555; border-radius: 18px; padding: 8px 16px; cursor: pointer; font-weight: 500; margin-right: 8px; }
            .btn-danger { background: var(--accent); }

            .actions-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
            .actions-bar .btn { margin-right: 0; }
            /* チャンネル一覧ヘッダー（main-content の上部に固定される区画） */
            .vm-sticky-header { flex: 0 0 auto; background: #0f0f0f; padding: 16px 24px 12px; box-shadow: 0 4px 10px rgba(0,0,0,0.6); z-index: 50; }
            .vm-sticky-header > h1 { margin: 0 0 8px; padding: 0; }
            .vm-sticky-header > .actions-bar { padding: 0; }
            html.vm-mobile .vm-sticky-header { padding: 12px 16px 10px; }
            /* スクロールエリア（データ行・グリッドはここをスクロール） */
            .vm-scroll-area { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: auto; padding: 0 24px 24px; scrollbar-width: thin; scrollbar-color: var(--vm-scrollbar-thumb) transparent; }
            .vm-scroll-area::-webkit-scrollbar { width: var(--vm-scrollbar-size); }
            .vm-scroll-area::-webkit-scrollbar-track { background: transparent; }
            .vm-scroll-area::-webkit-scrollbar-thumb { background-color: var(--vm-scrollbar-thumb); border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
            .vm-scroll-area::-webkit-scrollbar-thumb:hover { background-color: var(--vm-scrollbar-thumb-hover); }
            .vm-scroll-area::-webkit-scrollbar-thumb:active { background-color: var(--vm-scrollbar-thumb-active); }
            html.vm-mobile .vm-scroll-area { padding: 8px 16px 260px; overflow-y: visible; }
            /* thead もスクロールエリア内で sticky（データ行だけスクロール、見出しは常時表示） */
            .channel-table { margin-top: 0 !important; }
            .channel-table thead th { position: sticky; top: 0; z-index: 30; background: #0f0f0f; box-shadow: 0 1px 0 rgba(255,255,255,0.12); }

            .table-scroll { overflow: visible; -webkit-overflow-scrolling: touch; }
            .channel-table { width: 100%; border-collapse: collapse; margin-top: 20px; table-layout: fixed; }
            .channel-table th, .channel-table td { padding: 12px 8px; text-align: left; border-bottom: 1px solid var(--border); }
            .channel-table .col-check  { width: 36px; text-align: center; }
            .channel-table .col-star   { width: 44px; text-align: center; }
            .channel-table .col-added  { width: 100px; }
            .channel-table .col-actions{ width: 80px; }
            .channel-table th { cursor: pointer; user-select: none; }
            .channel-table th:hover { background: #272727; }
            /* ヘッダー固定トグルボタン */
            .vm-header-pin-btn { background: none; border: none; cursor: pointer; font-size: 15px; padding: 8px 12px; line-height: 1; opacity: 0.5; transition: opacity 0.15s; }
            .vm-header-pin-btn:hover { opacity: 1; }
            .vm-header-pin-btn.pinned { opacity: 1; }
            /* ピンOFF時: theadのstickyを解除（データ行と一緒にスクロール） */
            .vm-scroll-area.vm-thead-unpinned .channel-table thead th { position: static; box-shadow: none; }
            .channel-table .list-thumbnail { width: 120px; height: 68px; object-fit: cover; border-radius: 4px; background-color: #333; float: left; margin-right: 12px; }
            .channel-table td.latest-video-cell { font-size: 0.9em; color: var(--sub-text); }
            .channel-table td.latest-video-cell .video-title { display: block; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
            .vm-add-to-mylist-btn { background: none; border: none; outline: none; box-shadow: none; font-size: 18px; cursor: pointer; padding: 0 6px 0 0; vertical-align: middle; opacity: 0.5; transition: opacity 0.15s, transform 0.1s; flex-shrink: 0; }
            .vm-add-to-mylist-btn:hover { opacity: 1; transform: scale(1.2); }
            .vm-latest-cell-inner { display: flex; align-items: center; }
            .vm-latest-cell-content { flex: 1; min-width: 0; }
            .channel-icon { width: 48px; height: 48px; border-radius: 50%; margin-right: 16px; vertical-align: middle; flex-shrink: 0; }
            .channel-name { white-space: nowrap; max-width: 0; overflow: hidden; }
            .channel-name-inner { display: flex; align-items: center; min-width: 0; }
            .channel-name a { color: var(--text); text-decoration: none; font-size: 1.1em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
            .channel-name a:hover { text-decoration: underline; }
            /* 星評価UI */
            .vm-star-btn { background: none; border: none; cursor: pointer; font-size: 18px; padding: 6px 10px; line-height: 1; transition: transform 0.1s; }
            .vm-star-btn:hover { transform: scale(1.2); }
            .vm-star-popup { position: fixed; z-index: 2147483647; background: #1e1e1e; border: 1px solid #444; border-radius: 10px; padding: 6px 10px; display: flex; gap: 4px; align-items: center; box-shadow: 0 4px 16px rgba(0,0,0,0.7); }
            .vm-star-popup button { background: none; border: none; cursor: pointer; font-size: 20px; padding: 2px 3px; border-radius: 4px; transition: background 0.1s; }
            .vm-star-popup button:hover { background: #333; }
            .vm-star-popup .vm-star-pop-label { font-size: 11px; color: #888; margin-right: 2px; }
            .vm-star-grid { position: absolute; top: 2px; right: 2px; min-width: 20px; height: 20px; border-radius: 10px; padding: 0 5px; font-size: 11px; font-weight: bold; cursor: pointer; white-space: nowrap; opacity: 0; transition: opacity 0.15s; color: white; display: flex; align-items: center; justify-content: center; gap: 1px; box-sizing: border-box; box-shadow: 0 1px 3px rgba(0,0,0,0.5); border: 1.5px solid rgba(255,255,255,0.25); }
            .grid-item:hover .vm-star-grid, .vm-star-grid.has-star { opacity: 1; }
            .vm-star-lock-btn { background: none; border: none; cursor: pointer; font-size: 13px; padding: 1px 3px; border-radius: 3px; vertical-align: middle; opacity: 0.7; transition: opacity 0.15s; }
            .vm-star-lock-btn:hover { opacity: 1; }
            .vm-star-lock-btn.locked { color: #f5c518; opacity: 1; }
            .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; z-index: 3000; }
            .modal-content { background: var(--panel-bg); padding: 24px; border-radius: 12px; width: 400px; }
            .modal-content h3 { margin: 0 0 8px; }
            .modal-content p { margin: 0 0 16px; color: var(--sub-text); line-height: 1.5; }
            .modal-content input, .modal-content select { width: 100%; padding: 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 8px; margin-top: 8px; box-sizing: border-box; }
            .modal-content textarea.vm-log-textarea { width: 100%; padding: 10px; background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 8px; margin-top: 8px; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.9em; line-height: 1.35; }
            .modal-actions { margin-top: 20px; text-align: right; }
            .checkbox-cell { cursor: pointer; }
            .checkbox-cell input { pointer-events: none; }

            .date-cell { line-height: 1.3; }
            .date-cell .time { font-size: 0.85em; color: var(--sub-text); }


            /* グリッド表示用スタイル */
            .grid-container { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 24px 16px; margin-top: 20px; }
            .grid-item { position: relative; display: flex; flex-direction: column; min-width: 0; }
            .grid-item-link { position: relative; display: flex; flex-direction: column; align-items: center; text-decoration: none; color: var(--text); width: 100%; min-width: 0; }
            .grid-item-icon-wrap { position: relative; display: inline-block; margin-bottom: 12px; flex-shrink: 0; }
            .grid-item-delete-btn {
                position: absolute;
                top: -4px;
                right: -4px;
                background: none;
                color: rgba(220,50,50,0.9);
                border: none;
                outline: none;
                box-shadow: none;
                border-radius: 0;
                width: 18px; height: 18px;
                cursor: pointer; display: flex; justify-content: center; align-items: center; font-size: 13px; padding: 0; line-height: 1; z-index: 2; font-weight: bold;
                opacity: 0.8; transition: opacity 0.15s, transform 0.1s; text-shadow: 0 0 4px rgba(0,0,0,0.8);
            }
            .grid-item-delete-btn:hover { opacity: 1; transform: scale(1.2); }
            .grid-item:hover .grid-item-name { color: white; }
            .vm-star-grid { position: absolute; bottom: -4px; right: -4px; top: auto; width: 18px; height: 18px; background: none; border: none; outline: none; box-shadow: none; border-radius: 0; padding: 0; font-size: 14px; cursor: pointer; white-space: nowrap; opacity: 0; transition: opacity 0.15s; display: flex; align-items: center; justify-content: center; box-sizing: border-box; pointer-events: none; text-shadow: 0 0 4px rgba(0,0,0,0.9); }
            .vm-star-grid.icon-s { bottom: -8px; right: -8px; } .vm-star-grid.icon-m { bottom: -7px; right: -7px; } .vm-star-grid.icon-l { }
            .view-size-small .grid-item-delete-btn { top: -8px; right: -8px; }
            .view-size-medium .grid-item-delete-btn { top: -7px; right: -7px; }
            .view-size-small .grid-item-move-btn { top: -8px !important; left: -8px !important; }
            .view-size-medium .grid-item-move-btn { top: -7px !important; left: -7px !important; }
            .grid-item:hover .vm-star-grid { opacity: 1; pointer-events: auto; }
            .view-toggle-buttons { margin-left: auto; }
            .view-toggle-buttons button { background: none; border: 1px solid var(--border); color: var(--sub-text); padding: 6px 12px; border-radius: 18px; cursor: pointer; }
            .view-toggle-buttons button.active { background: var(--text); color: var(--bg); border-color: var(--text); font-weight: bold; }

            /* サイズ設定用スタイル */
            .view-size-small .channel-icon { width: 32px; height: 32px; }
            .view-size-small .channel-name a { font-size: 0.9em; }
            .view-size-medium .channel-icon { width: 48px; height: 48px; } /* デフォルト */
            .view-size-medium .channel-name a { font-size: 1.1em; }
            .view-size-large .channel-icon { width: 64px; height: 64px; }
            .view-size-large .channel-name a { font-size: 1.2em; }

            .view-size-small .grid-container { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
            .view-size-small .grid-item-icon { width: 90px; height: 90px; border-radius: 50%; }
            .view-size-medium .grid-container { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); } /* デフォルト */
            .view-size-medium .grid-item-icon { width: 120px; height: 120px; border-radius: 50%; }
            .view-size-large .grid-container { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
            .view-size-large .grid-item-icon { width: 150px; height: 150px; border-radius: 50%; }
            .grid-item-icon { border-radius: 50%; object-fit: cover; background-color: #333; display: block; }
            .very-new-video-indicator { color: #ff4500; font-weight: bold; margin-right: 2px; }
            .new-video-indicator { color: #3ea6ff; font-weight: bold; margin-right: 2px; }
            .grid-item-name { font-size: 0.9em; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; }

            @media (max-width: 768px) {
                .page-container { flex-direction: column; height: auto; min-height: 100%; }
                .sidebar { width: auto; border-right: none; border-bottom: 1px solid var(--border); }
                .main-content { padding: 16px; overflow-y: visible; overflow-x: hidden; }
                .actions-bar { gap: 6px; }
                .view-toggle-buttons { margin-left: 0; }
                .modal-overlay { align-items: flex-start; padding: 12px; box-sizing: border-box; }
                .modal-content { width: 100%; max-width: 520px; padding: 16px; max-height: calc(100vh - 24px); overflow: auto; }
                .channel-table td.latest-video-cell .video-title { max-width: 100%; }
                .channel-table { min-width: 720px; }

                .sidebar.mobile-drawer {
                    position: fixed;
                    top: 0;
                    left: 0;
                    height: 100vh;
                    width: min(92vw, 360px);
                    border-bottom: none;
                    border-right: 1px solid var(--border);
                    transform: translateX(-105%);
                    display: flex;
                    z-index: 2000;
                }
                .sidebar.mobile-drawer.open { transform: translateX(0); }
                .sidebar-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100vw;
                    height: 100vh;
                    background: rgba(0,0,0,0.55);
                    z-index: 1999;
                }
            }

            /* viewport幅が広く見える端末でもスマホ扱いにできるように（JSでhtml.vm-mobileを付与） */
            html.vm-mobile body { font-size: 24px !important; }
            html.vm-mobile #vm-custom-list-root { font-size: 24px !important; zoom: 1 !important; }
            html.vm-mobile .page-container { flex-direction: column; height: auto; min-height: 100%; }
            html.vm-mobile .sidebar { width: auto; border-right: none; border-bottom: 1px solid var(--border); }
            html.vm-mobile .main-content { padding: 16px; overflow-y: visible; overflow-x: hidden; padding-bottom: 260px; }
            html.vm-mobile .actions-bar { gap: 6px; }
            html.vm-mobile .view-toggle-buttons { margin-left: 0; }
            html.vm-mobile .modal-overlay { align-items: flex-start; padding: 12px; box-sizing: border-box; }
            html.vm-mobile .modal-overlay.vm-center { align-items: center; }
            html.vm-mobile .modal-content { width: 100%; max-width: 520px; padding: 16px; max-height: calc(100vh - 24px); overflow: auto; }
            html.vm-mobile .channel-table td.latest-video-cell .video-title { max-width: 100%; }
            html.vm-mobile .channel-table { min-width: 720px; }

            /* スマホ用：ボタンを大きく（タップしやすく） */
            html.vm-mobile .btn { padding: 14px 20px; font-size: 1em !important; border-radius: 20px; }
            html.vm-mobile .view-toggle-buttons button { padding: 12px 16px; font-size: 1em !important; }
            html.vm-mobile .folder-actions button { font-size: 1.1em; padding: 8px; }

            /* スマホ用：操作バーをモバイル向けに縦積み */
            html.vm-mobile .main-content h1 { font-size: 26px !important; margin: 0 0 12px; }
            html.vm-mobile .actions-bar { flex-direction: row; align-items: center; justify-content: space-between; gap: 10px; }
            html.vm-mobile .actions-bar > * { width: auto; }
            html.vm-mobile .actions-bar .btn { width: auto; }

            html.vm-mobile .folder-item { padding: 14px 12px; }

            html.vm-mobile .mobile-bottom-bar {
                position: fixed;
                left: 0;
                right: 0;
                bottom: 0;
                background: var(--panel-bg);
                border-top: 1px solid var(--border);
                padding: 10px 12px;
                box-sizing: border-box;
                z-index: 1800;
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
            html.vm-mobile .mobile-bottom-btn {
                width: 100%;
                padding: 28px 16px;
                font-size: 1em;
                border-radius: 18px;
                text-align: center;
                line-height: 1;
            }
            html.vm-mobile .mobile-bottom-btn.primary { background: #065fd4; border-color: #065fd4; }
            html.vm-mobile .mobile-bottom-btn.accent { background: var(--accent); border-color: var(--accent); }

            /* スマホ用：グリッド列数はサイズに連動（小=4/中=3/大=2） */
            html.vm-mobile .grid-container { gap: 18px 12px; }
            html.vm-mobile .main-content.view-size-large .grid-container { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            html.vm-mobile .main-content.view-size-medium .grid-container { grid-template-columns: repeat(3, minmax(0, 1fr)); }
            html.vm-mobile .main-content.view-size-small .grid-container { grid-template-columns: repeat(4, minmax(0, 1fr)); }
            html.vm-mobile .grid-item-link { width: 100%; }
            html.vm-mobile .grid-item-icon {
                width: 90% !important;
                height: auto !important;
                aspect-ratio: 1 / 1;
                display: block;
                margin: 0 auto 12px;
                border-radius: 50%;
                object-fit: cover;
            }
            html.vm-mobile .grid-item-name { font-size: 1.25em !important; line-height: 1.25; }
            html.vm-mobile .grid-item-move-btn { display: none !important; }
            html.vm-mobile .grid-item-delete-btn { display: none !important; }

            html.vm-mobile .icon-btn {
                width: 56px;
                height: 56px;
                border-radius: 16px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                font-size: 26px;
                line-height: 1;
                border: 1px solid #555;
                background: #333;
                color: #fff;
                cursor: pointer;
                padding: 0;
            }
            html.vm-mobile .icon-btn:active { filter: brightness(1.15); }
            html.vm-mobile .settings-modal-section { margin-top: 14px; }
            html.vm-mobile .settings-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
            html.vm-mobile .settings-row .btn { flex: 1; min-width: 0; }
            html.vm-mobile .settings-row .view-toggle-buttons { display: flex; gap: 8px; width: 100%; }
            html.vm-mobile .settings-row .view-toggle-buttons button { flex: 1; }
            html.vm-mobile .sidebar.mobile-drawer {
                position: fixed;
                top: 0;
                left: 0;
                height: 100vh;
                width: min(92vw, 360px);
                border-bottom: none;
                border-right: 1px solid var(--border);
                transform: translateX(-105%);
                display: flex;
                z-index: 2000;
            }
            html.vm-mobile .sidebar.mobile-drawer.open { transform: translateX(0); }
            html.vm-mobile .sidebar-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0,0,0,0.55);
                z-index: 1999;
            }
            /* ===================== ライトモード ===================== */
            html.vm-light { color-scheme: light; }
            html.vm-light { --bg: #e4e7ec; --panel-bg: #eef0f4; --text: #111111; --sub-text: #444; --border: #cccccc; --accent: #cc0000; --vm-scrollbar-thumb: rgba(0,0,0,0.18); --vm-scrollbar-thumb-hover: rgba(0,0,0,0.30); --vm-scrollbar-thumb-active: rgba(0,0,0,0.42); }
            html.vm-light, html.vm-light body { background: #e4e7ec !important; color: #111 !important; }
            html.vm-light #vm-custom-list-root { background: #e4e7ec !important; }
            html.vm-light .main-content { background: #e4e7ec !important; }
            html.vm-light .page-container { background: #e4e7ec !important; }
            /* サイドバー */
            html.vm-light .sidebar { background: #d2d7de !important; color: #111 !important; border-right-color: #ccc !important; }
            html.vm-light .folder-item { color: #111 !important; }
            html.vm-light .folder-item .cl-channel-limit-hint { color: #555 !important; border-color: #888 !important; }
            html.vm-light .folder-item.active .cl-channel-limit-hint { color: #fff !important; border-color: rgba(255,255,255,0.9) !important; }
            html.vm-light .folder-item:hover { background: #c8ced6 !important; }
            html.vm-light .folder-item.active { background: var(--accent) !important; color: #fff !important; }
            html.vm-light .folder-actions button { color: #555 !important; }
            html.vm-light .folder-actions button:hover { color: #000 !important; }
            /* スティッキーヘッダー */
            html.vm-light .vm-sticky-header { background: #d8dde5 !important; color: #111 !important; box-shadow: 0 4px 10px rgba(0,0,0,0.1) !important; }
            html.vm-light .vm-sticky-header h1 { color: #111 !important; }
            html.vm-light .vm-sticky-header * { color: #111 !important; }
            html.vm-light .actions-bar .btn { background: #d4d9e0 !important; color: #111 !important; border-color: #b0b8c4 !important; }
            html.vm-light .btn { background: #d4d9e0 !important; color: #111 !important; border-color: #b0b8c4 !important; }
            html.vm-light .btn-danger { background: var(--accent) !important; color: #fff !important; border-color: var(--accent) !important; }
            /* テーブル */
            html.vm-light .channel-table { background: transparent !important; }
            html.vm-light .channel-table thead th { background: #d8dde5 !important; color: #111 !important; box-shadow: 0 1px 0 #bbb !important; }
            html.vm-light .channel-table th:hover { background: #cdd2da !important; }
            html.vm-light .channel-table th, html.vm-light .channel-table td { border-bottom-color: #ddd !important; color: #111 !important; }
            html.vm-light .channel-table tbody tr { background: #eef0f4 !important; }
            html.vm-light .channel-table tbody tr:hover { background: #e4e7ec !important; }
            html.vm-light .channel-name a { color: #111 !important; }
            html.vm-light .channel-table td.latest-video-cell { color: #555 !important; }
            html.vm-light .channel-table td.latest-video-cell .video-title { color: #111 !important; }
            html.vm-light .date-cell { color: #111 !important; }
            html.vm-light .date-cell .time { color: #555 !important; }
            /* グリッド */
            html.vm-light .grid-item-link { color: #111 !important; }
            html.vm-light .grid-item-link:hover { color: #000 !important; }
            /* モーダル */
            html.vm-light .modal-overlay { background: rgba(0,0,0,0.4) !important; }
            html.vm-light .modal-content { background: #eef0f4 !important; color: #111 !important; }
            html.vm-light .modal-content h3 { color: #111 !important; }
            html.vm-light .modal-content p { color: #555 !important; }
            html.vm-light .modal-content input, html.vm-light .modal-content select, html.vm-light .modal-content textarea.vm-log-textarea { background: #e8ebf0 !important; border-color: #ccc !important; color: #111 !important; }
            /* 星ポップアップ */
            html.vm-light .vm-star-popup { background: #eef0f4 !important; border-color: #ccc !important; box-shadow: 0 4px 16px rgba(0,0,0,0.15) !important; }
            html.vm-light .vm-star-popup button:hover { background: #e4e7ec !important; }
            html.vm-light .vm-star-pop-label { color: #555 !important; }
            html.vm-light .view-toggle-buttons button { background: #d4d9e0 !important; color: #111 !important; border-color: #b0b8c4 !important; }
            html.vm-light .view-toggle-buttons button.active { background: #1558b0 !important; color: #fff !important; border-color: #1558b0 !important; }
            /* 右上ボタン */
            html.vm-light #vm-cl-settings-top-btn, html.vm-light #vm-cl-theme-btn { background: #d4d9e0 !important; color: #111 !important; border-color: #b0b8c4 !important; }
        `);

            // 保存済みテーマを適用（content.js の vmTheme を使用，なければ自前で読んで適用）
            const _applyThemeCL = () => {
                try {
                    const t = GM_getValue('vm-theme-v1', 'dark') || 'dark';
                    if (t === 'light') document.documentElement.classList.add('vm-light');
                    else document.documentElement.classList.remove('vm-light');
                } catch (_) {}
            };
            _applyThemeCL();

            let data = getChannelData();

            // URL指定でフォルダを直接開けるようにする: /custom-list?folder=フォルダ名
            const getFolderFromUrl = () => {
                try {
                    const params = new URLSearchParams(location.search || '');
                    const folder = params.get('folder') ?? params.get('f');
                    return (folder || '').trim();
                } catch (_) {
                    return '';
                }
            };

            const syncFolderToUrl = (folderName, { replace = true } = {}) => {
                try {
                    const url = new URL(location.href);
                    url.searchParams.set('folder', String(folderName || ''));
                    url.searchParams.delete('f');
                    if (replace) {
                        history.replaceState(null, '', url.toString());
                    } else {
                        history.pushState(null, '', url.toString());
                    }
                } catch (_) {
                    // noop
                }
            };

            let currentFolder = getFolderFromUrl() || sessionStorage.getItem('selectedFolder') || ALL_CHANNELS_VIRTUAL;
            if (!data.folders[currentFolder] && currentFolder !== ALL_CHANNELS_VIRTUAL) currentFolder = ALL_CHANNELS_VIRTUAL;
            sessionStorage.setItem('selectedFolder', currentFolder);
            // ブックマーク/共有しやすいよう、常に現在フォルダをURLへ反映
            syncFolderToUrl(currentFolder, { replace: true });
            let sortState = { key: 'star', dir: -1 }; // 初期ソート: 星の降順
            let starLock = true; // 星グループロック: ON時は星でグループ後にサブソート
            let openSettingsModalRef = null; // 外部から設定モーダルを開くための参照
            let viewMode = localStorage.getItem('channelListViewMode') || 'list'; // 'list' or 'grid'
            let viewSize = localStorage.getItem('channelListViewSize') || 'medium'; // 'small', 'medium', 'large'
            let headerPinned = localStorage.getItem('channelListHeaderPinned') !== 'false'; // デフォルトは固定ON

            const isMobileLike = () => {
                try {
                    const byWidth = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
                    const byPointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
                    const byScreen = (typeof screen !== 'undefined' && typeof screen.width === 'number') ? screen.width <= 768 : false;
                    const ua = (navigator.userAgent || '').toLowerCase();
                    const byUa = /android|iphone|ipad|ipod/.test(ua);
                    return Boolean(byWidth || byPointer || byScreen || byUa);
                } catch (_) {
                    return false;
                }
            };

            const DESKTOP_BASE_FONT_PX = 20;
            const MOBILE_BASE_FONT_PX = 24;
            let mobileFontEnforcerTimer = null;
            let mobileFontDebugStarted = false;
            let mobileFontDebugObserver = null;
            let fontDebugTextarea = null;

            const FONT_DEBUG_MAX_LINES = 300;

            const FONT_DEBUG_TAG = '[YCLM-FONT]';

            const fontDebugLines = [];

            const pushFontDebugLine = (line) => {
                try {
                    const text = String(line);
                    fontDebugLines.push(text);
                    while (fontDebugLines.length > FONT_DEBUG_MAX_LINES) fontDebugLines.shift();
                    if (fontDebugTextarea) {
                        fontDebugTextarea.value = fontDebugLines.join('\n');
                        fontDebugTextarea.scrollTop = fontDebugTextarea.scrollHeight;
                    }
                } catch (_) {
                    // noop
                }
            };

            const pushFontDebug = (label, extra, diffs, snap) => {
                const ts = new Date().toISOString();
                const parts = [FONT_DEBUG_TAG, ts, label];
                if (extra) parts.push(String(extra));
                if (Array.isArray(diffs) && diffs.length) parts.push(diffs.join(' | '));
                if (snap && snap.root && snap.body && snap.html) {
                    parts.push(`root=${snap.root.computedFontSize} body=${snap.body.computedFontSize} html=${snap.html.computedFontSize}`);
                }
                pushFontDebugLine(parts.join(' '));
            };

            const getFontSnapshot = () => {
                const htmlEl = document.documentElement;
                const bodyEl = document.body;
                const rootEl = document.getElementById('vm-custom-list-root');
                const probeEl = document.getElementById('vm-font-probe');

                const getSample = (selector, label) => {
                    try {
                        const scope = rootEl || document;
                        const el = scope.querySelector(selector);
                        if (!el) return { label, selector, present: false };
                        const cs = getComputedStyle(el);
                        return {
                            label,
                            selector,
                            present: true,
                            tag: el.tagName ? el.tagName.toLowerCase() : '',
                            className: (el.className && typeof el.className === 'string') ? el.className : '',
                            styleFontSize: el.style?.fontSize || '',
                            computedFontFamily: cs.fontFamily,
                            computedFontSize: cs.fontSize,
                            computedZoom: cs.zoom || '',
                            computedTransform: cs.transform || ''
                        };
                    } catch (_) {
                        return { label, selector, present: false };
                    }
                };

                const snap = {
                    path: location.pathname,
                    isMobileLike: false,
                    dpr: (typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number') ? window.devicePixelRatio : null,
                    visualViewportScale: (window.visualViewport && typeof window.visualViewport.scale === 'number') ? window.visualViewport.scale : null,
                    html: {
                        className: htmlEl?.className || '',
                        styleFontSize: htmlEl?.style?.fontSize || '',
                        styleZoom: htmlEl?.style?.zoom || '',
                        computedFontSize: htmlEl ? getComputedStyle(htmlEl).fontSize : ''
                    },
                    body: {
                        className: bodyEl?.className || '',
                        styleFontSize: bodyEl?.style?.fontSize || '',
                        styleZoom: bodyEl?.style?.zoom || '',
                        computedFontSize: bodyEl ? getComputedStyle(bodyEl).fontSize : ''
                    },
                    root: {
                        id: rootEl?.id || '',
                        className: rootEl?.className || '',
                        styleFontSize: rootEl?.style?.fontSize || '',
                        styleZoom: rootEl?.style?.zoom || '',
                        computedFontSize: rootEl ? getComputedStyle(rootEl).fontSize : ''
                    },
                    probe: {
                        present: Boolean(probeEl),
                        computedFontFamily: probeEl ? getComputedStyle(probeEl).fontFamily : null,
                        rectHeight: probeEl ? probeEl.getBoundingClientRect().height : null,
                        rectWidth: probeEl ? probeEl.getBoundingClientRect().width : null
                    },
                    samples: [
                        getSample('h1', 'h1'),
                        getSample('.grid-item-name', 'grid-item-name'),
                        getSample('.btn', 'btn'),
                        getSample('.folder-item', 'folder-item'),
                        getSample('.channel-name a', 'channel-name-link'),
                        getSample('.modal-content', 'modal-content')
                    ]
                };
                try { snap.isMobileLike = isMobileLike(); } catch (_) { snap.isMobileLike = false; }
                return snap;
            };

            const summarizeMutationTarget = (target) => {
                if (!target) return 'unknown';
                if (target === document.documentElement) return 'html';
                if (target === document.body) return 'body';
                if (target.id) return `${target.tagName?.toLowerCase() || 'el'}#${target.id}`;
                const cls = (target.className && typeof target.className === 'string') ? target.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
                return `${target.tagName?.toLowerCase() || 'el'}${cls ? '.' + cls : ''}`;
            };

            const diffSnapshot = (prev, next) => {
                const changes = [];
                const keys = [
                    ['html', 'computedFontSize'],
                    ['body', 'computedFontSize'],
                    ['root', 'computedFontSize'],
                    ['html', 'className'],
                    ['body', 'className'],
                    ['root', 'className'],
                    ['html', 'styleFontSize'],
                    ['body', 'styleFontSize'],
                    ['root', 'styleFontSize'],
                    ['html', 'styleZoom'],
                    ['body', 'styleZoom'],
                    ['root', 'styleZoom'],
                ];
                for (const [section, key] of keys) {
                    const a = prev?.[section]?.[key];
                    const b = next?.[section]?.[key];
                    if (a !== b) changes.push(`${section}.${key}: "${a}" -> "${b}"`);
                }
                if (prev?.isMobileLike !== next?.isMobileLike) changes.push(`isMobileLike: ${prev?.isMobileLike} -> ${next?.isMobileLike}`);
                if (prev?.dpr !== next?.dpr) changes.push(`dpr: ${prev?.dpr} -> ${next?.dpr}`);
                if (prev?.visualViewportScale !== next?.visualViewportScale) changes.push(`visualViewportScale: ${prev?.visualViewportScale} -> ${next?.visualViewportScale}`);
                if (prev?.probe?.present !== next?.probe?.present) changes.push(`probe.present: ${prev?.probe?.present} -> ${next?.probe?.present}`);
                if (prev?.probe?.rectHeight !== next?.probe?.rectHeight) changes.push(`probe.rectHeight: ${prev?.probe?.rectHeight} -> ${next?.probe?.rectHeight}`);
                if (prev?.probe?.rectWidth !== next?.probe?.rectWidth) changes.push(`probe.rectWidth: ${prev?.probe?.rectWidth} -> ${next?.probe?.rectWidth}`);

                const prevSamples = Array.isArray(prev?.samples) ? prev.samples : [];
                const nextSamples = Array.isArray(next?.samples) ? next.samples : [];
                const sampleCount = Math.max(prevSamples.length, nextSamples.length);
                for (let i = 0; i < sampleCount; i++) {
                    const a = prevSamples[i];
                    const b = nextSamples[i];
                    const label = b?.label || a?.label || `sample${i}`;
                    const aSize = a?.computedFontSize;
                    const bSize = b?.computedFontSize;
                    if (a?.present !== b?.present) changes.push(`${label}.present: ${a?.present} -> ${b?.present}`);
                    const aFam = a?.computedFontFamily;
                    const bFam = b?.computedFontFamily;
                    if (aFam !== bFam) changes.push(`${label}.computedFontFamily: "${aFam}" -> "${bFam}"`);
                    if (aSize !== bSize) changes.push(`${label}.computedFontSize: "${aSize}" -> "${bSize}"`);
                    const aZoom = a?.computedZoom;
                    const bZoom = b?.computedZoom;
                    if (aZoom !== bZoom) changes.push(`${label}.computedZoom: "${aZoom}" -> "${bZoom}"`);
                    const aTf = a?.computedTransform;
                    const bTf = b?.computedTransform;
                    if (aTf !== bTf) changes.push(`${label}.computedTransform: "${aTf}" -> "${bTf}"`);
                }

                if (prev?.probe?.computedFontFamily !== next?.probe?.computedFontFamily) {
                    changes.push(`probe.computedFontFamily: "${prev?.probe?.computedFontFamily}" -> "${next?.probe?.computedFontFamily}"`);
                }
                return changes;
            };

            const applyMobileFontOverrides = () => {
                try {
                    if (!document.body || !document.documentElement) return;

                    // custom-listページ以外に移動したら解除
                    if (!isCustomListPagePath(location.pathname)) {
                        document.body.style.removeProperty('font-size');
                        document.documentElement.style.removeProperty('font-size');
                        document.body.style.removeProperty('zoom');
                        document.documentElement.style.removeProperty('zoom');
                        document.documentElement.classList.remove('vm-mobile');
                        if (mobileFontEnforcerTimer) {
                            clearInterval(mobileFontEnforcerTimer);
                            mobileFontEnforcerTimer = null;
                        }
                        return;
                    }

                    const isMobile = isMobileLike();
                    document.documentElement.classList.toggle('vm-mobile', isMobile);

                    const basePx = isMobile ? MOBILE_BASE_FONT_PX : DESKTOP_BASE_FONT_PX;

                    const before = mobileFontDebugStarted ? getFontSnapshot() : null;

                    document.documentElement.style.setProperty('font-size', `${basePx}px`, 'important');
                    document.documentElement.style.setProperty('zoom', '1', 'important');
                    document.body.style.setProperty('font-size', `${basePx}px`, 'important');
                    document.body.style.setProperty('zoom', '1', 'important');
                    document.body.style.setProperty('font-family', 'Arial, sans-serif', 'important');
                    const root = document.getElementById('vm-custom-list-root');
                    if (root) {
                        root.style.setProperty('font-size', `${basePx}px`, 'important');
                        root.style.setProperty('zoom', '1', 'important');
                        root.style.setProperty('font-family', 'Arial, sans-serif', 'important');
                    }

                    if (mobileFontDebugStarted) {
                        const after = getFontSnapshot();
                        const d = diffSnapshot(before, after);
                        if (d.length) pushFontDebug('enforcer', `basePx=${basePx}`, d, after);
                    }
                } catch (_) {
                    // noop
                }
            };

            const startMobileFontDebug = () => {
                if (mobileFontDebugStarted) return;
                mobileFontDebugStarted = true;

                let last = getFontSnapshot();
                pushFontDebug('start', '', [], last);

                const logIfChanged = (reason, extra) => {
                    try {
                        const now = getFontSnapshot();
                        const d = diffSnapshot(last, now);
                        if (d.length) {
                            pushFontDebug(reason, extra || '', d, now);
                            last = now;
                        }
                    } catch (_) {
                        // noop
                    }
                };

                // 属性変化（class/style）から原因候補を特定
                try {
                    mobileFontDebugObserver = new MutationObserver((mutations) => {
                        for (const m of mutations) {
                            if (m.type !== 'attributes') continue;
                            const targetLabel = summarizeMutationTarget(m.target);
                            logIfChanged('mutation', `${targetLabel} attr=${m.attributeName}`);
                        }
                    });

                    const root = document.getElementById('vm-custom-list-root');
                    mobileFontDebugObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
                    mobileFontDebugObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
                    if (root) mobileFontDebugObserver.observe(root, { attributes: true, attributeFilter: ['class', 'style'] });
                } catch (_) {
                    // noop
                }

                // computed値の変化（外部CSSの適用など）を取りこぼさない
                let ticks = 0;
                const timer = setInterval(() => {
                    if (!isCustomListPagePath(location.pathname)) {
                        clearInterval(timer);
                        try { mobileFontDebugObserver?.disconnect(); } catch (_) { /* noop */ }
                        mobileFontDebugObserver = null;
                        mobileFontDebugStarted = false;
                        fontDebugTextarea = null;
                        return;
                    }
                    ticks++;
                    logIfChanged('poll', `t=${ticks}`);
                }, 250);
            };

            const startMobileFontEnforcer = () => {
                if (mobileFontEnforcerTimer) return;
                applyMobileFontOverrides();
                mobileFontEnforcerTimer = setInterval(applyMobileFontOverrides, 500);
            };

            const isMobileView = isMobileLike();
            if (!localStorage.getItem('channelListViewMode') && isMobileView) {
                viewMode = 'grid';
            }
            if (!localStorage.getItem('channelListViewSize') && isMobileView) {
                viewSize = 'small';
            }

            const container = document.createElement('div');
            container.id = 'vm-custom-list-root';
            container.className = 'page-container';
            document.body.appendChild(container);

            const fontProbe = document.createElement('span');
            fontProbe.id = 'vm-font-probe';
            fontProbe.textContent = 'M';
            container.appendChild(fontProbe);

            const sidebar = document.createElement('div');
            sidebar.className = 'sidebar';
            container.appendChild(sidebar);

            // サイドバーリサイザー（ドラッグで幅調整）
            const sidebarResizer = document.createElement('div');
            sidebarResizer.className = 'vm-sidebar-resizer';
            container.appendChild(sidebarResizer);

            const mainContent = document.createElement('div');
            mainContent.className = 'main-content';
            container.appendChild(mainContent);

            // サイドバー幅の復元
            const SIDEBAR_WIDTH_LS_KEY = 'vm-sidebar-width';
            const SIDEBAR_WIDTH_MIN = 140;
            const SIDEBAR_WIDTH_MAX = 520;
            (() => {
                try {
                    const saved = localStorage.getItem(SIDEBAR_WIDTH_LS_KEY);
                    if (saved) {
                        const w = parseInt(saved, 10);
                        if (w >= SIDEBAR_WIDTH_MIN && w <= SIDEBAR_WIDTH_MAX) {
                            sidebar.style.width = w + 'px';
                        }
                    }
                } catch (_) { }
            })();

            // リサイズドラッグ処理
            let _resizerDragging = false;
            let _resizerStartX = 0;
            let _resizerStartWidth = 0;

            sidebarResizer.addEventListener('mousedown', (e) => {
                if (isMobileLike()) return;
                _resizerDragging = true;
                _resizerStartX = e.clientX;
                _resizerStartWidth = sidebar.offsetWidth;
                sidebarResizer.classList.add('dragging');
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'col-resize';
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!_resizerDragging) return;
                const delta = e.clientX - _resizerStartX;
                let newWidth = _resizerStartWidth + delta;
                newWidth = Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, newWidth));
                sidebar.style.width = newWidth + 'px';
            });

            document.addEventListener('mouseup', () => {
                if (!_resizerDragging) return;
                _resizerDragging = false;
                sidebarResizer.classList.remove('dragging');
                document.body.style.userSelect = '';
                document.body.style.cursor = '';
                try { localStorage.setItem(SIDEBAR_WIDTH_LS_KEY, String(sidebar.offsetWidth)); } catch (_) { }
            });

            let sidebarOpen = false;
            const updateSidebarUi = () => {
                const isMobile = isMobileLike();
                document.documentElement.classList.toggle('vm-mobile', isMobile);
                applyMobileFontOverrides();
                const overlay = document.getElementById('vm-sidebar-overlay');

                if (!isMobile) {
                    sidebar.classList.remove('mobile-drawer');
                    sidebar.classList.remove('open');
                    overlay?.remove();
                    document.body.style.overflow = '';
                    sidebarOpen = false;
                    return;
                }

                sidebar.classList.add('mobile-drawer');
                if (sidebarOpen) {
                    sidebar.classList.add('open');
                    if (!overlay) {
                        const ov = document.createElement('div');
                        ov.id = 'vm-sidebar-overlay';
                        ov.className = 'sidebar-overlay';
                        ov.addEventListener('click', () => {
                            sidebarOpen = false;
                            updateSidebarUi();
                        });
                        document.body.appendChild(ov);
                    }
                    document.body.style.overflow = 'hidden';
                } else {
                    sidebar.classList.remove('open');
                    overlay?.remove();
                    document.body.style.overflow = '';
                }
            };

            const closeSidebarIfMobile = () => {
                const isMobile = isMobileLike();
                if (!isMobile) return;
                if (!sidebarOpen) return;
                sidebarOpen = false;
                updateSidebarUi();
            };

            const setCurrentFolder = (folderName, { closeSidebar = true, updateUrl = true, rerender = true } = {}) => {
                const next = (folderName === ALL_CHANNELS_VIRTUAL) ? ALL_CHANNELS_VIRTUAL
                    : (folderName && data.folders[folderName]) ? folderName : DEFAULT_FOLDER;
                currentFolder = next;
                sessionStorage.setItem('selectedFolder', next);
                if (updateUrl) syncFolderToUrl(next, { replace: true });
                if (closeSidebar) closeSidebarIfMobile();
                if (rerender) render();
            };

            window.addEventListener('resize', () => {
                updateSidebarUi();
            });

            startMobileFontEnforcer();
            startMobileFontDebug();

            const handleEscKeyForSidebar = (e) => {
                if (e.key === 'Escape') closeSidebarIfMobile();
            };
            document.addEventListener('keydown', handleEscKeyForSidebar);

            function render() {
                renderSidebar();
                renderMainContent();
            }

            function renderSidebar() {
                while (sidebar.firstChild) {
                    sidebar.removeChild(sidebar.firstChild);
                }
                const h2 = document.createElement('h2'); h2.textContent = i18n('フォルダ', 'Folders'); sidebar.appendChild(h2);
                const folderList = document.createElement('ul');
                folderList.className = 'folder-list';

                // 「すべて」仮想フォルダを先頭に追加
                const allCount = _countTotalChannelEntries(data);
                const allLi = document.createElement('li');
                allLi.className = 'folder-item' + (currentFolder === ALL_CHANNELS_VIRTUAL ? ' active' : '');
                const allSpan = document.createElement('span');
                const allLabel = i18n('すべて', 'All');
                const labelWrap = document.createElement('span');
                labelWrap.style.display = 'inline-flex';
                labelWrap.style.alignItems = 'center';
                labelWrap.style.flexGrow = '1';
                labelWrap.style.minWidth = '0';
                if (!_isPremiumForImport()) {
                    allSpan.textContent = `${allLabel} (${allCount}/${_FREE_PLAN_CHANNEL_LIMIT})`;
                    labelWrap.appendChild(allSpan);
                    const hintTitle = i18n(
                        '無料は新規50件まで。プレミアム（サブスク）で無制限。',
                        'Free: up to 50 registrations. Premium (subscription): unlimited.'
                    );
                    const hintMessage = i18n(
                        '無料プランでは、チャンネルの新規登録は全フォルダ合計50件までです。プレミアムプラン（サブスクリプション）に加入すると、登録数が無制限になります。',
                        'On the free plan, you can register up to 50 channels in total across all folders. Premium (subscription) unlocks unlimited channel registrations.'
                    );
                    const infoIcon = document.createElement('span');
                    infoIcon.className = 'cl-channel-limit-hint';
                    infoIcon.textContent = 'i';
                    infoIcon.title = hintTitle;
                    infoIcon.setAttribute('aria-label', hintTitle);
                    infoIcon.addEventListener('mousedown', (e) => e.stopPropagation());
                    infoIcon.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        await showCustomModal({
                            type: 'alert',
                            title: i18n('チャンネル登録数', 'Channel registration limit'),
                            message: hintMessage
                        });
                    });
                    labelWrap.appendChild(infoIcon);
                } else {
                    allSpan.textContent = `${allLabel} (${allCount})`;
                    labelWrap.appendChild(allSpan);
                }
                allLi.appendChild(labelWrap);
                allLi.addEventListener('click', () => setCurrentFolder(ALL_CHANNELS_VIRTUAL));
                folderList.appendChild(allLi);

                if (!_isPremiumForImport() && allCount > _FREE_PLAN_CHANNEL_LIMIT) {
                    const overHint = document.createElement('p');
                    overHint.textContent = i18n(
                        `現在${allCount}件登録済みです（無料プランの新規登録上限は${_FREE_PLAN_CHANNEL_LIMIT}件）。既存のチャンネルはそのまま利用できますが、追加登録にはプレミアムプランが必要です。`,
                        `You have ${allCount} channels (${_FREE_PLAN_CHANNEL_LIMIT} is the free plan registration limit). Existing channels stay available; upgrade to Premium to add more.`
                    );
                    Object.assign(overHint.style, {
                        margin: '0 0 10px',
                        padding: '8px 10px',
                        fontSize: '11px',
                        lineHeight: '1.5',
                        color: '#f6c26b',
                        background: 'rgba(246, 194, 107, 0.12)',
                        border: '1px solid rgba(246, 194, 107, 0.35)',
                        borderRadius: '6px'
                    });
                    sidebar.appendChild(overHint);
                }

                data.folderOrder.forEach(folderName => {
                    const itemCount = data.folders[folderName]?.length || 0;
                    const li = document.createElement('li');
                    li.className = 'folder-item';
                    if (folderName === currentFolder) {
                        li.classList.add('active');
                    }

                    const folderDisplayName = folderName === DEFAULT_FOLDER
                        ? i18n('お気に入り', 'Favorites')
                        : folderName;
                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = `${folderDisplayName} (${itemCount})`;
                    nameSpan.style.flexGrow = '1';
                    nameSpan.style.overflow = 'hidden';
                    nameSpan.style.textOverflow = 'ellipsis';
                    nameSpan.style.whiteSpace = 'nowrap'; // 2行になるのを防ぐ

                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = 'folder-actions';

                    const editBtn = document.createElement('button');
                    editBtn.textContent = '✏️';
                    editBtn.title = i18n('フォルダ名を編集', 'Edit folder name');
                    editBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const newName = await showCustomModal({ type: 'prompt', title: i18n('フォルダ名の編集', 'Edit Folder Name'), defaultValue: folderDisplayName, okText: i18n('保存', 'Save'), okClass: 'btn-primary' });
                        if (newName && newName !== folderName && !data.folders[newName]) {
                            data.folders[newName] = data.folders[folderName];
                            delete data.folders[folderName];
                            data.folderOrder[data.folderOrder.indexOf(folderName)] = newName;
                            if (currentFolder === folderName) {
                                currentFolder = newName;
                                sessionStorage.setItem('selectedFolder', newName);
                                syncFolderToUrl(newName, { replace: true });
                            }
                            saveChannelData(data);
                            render();
                        } else if (newName && newName !== folderName) {
                            await showCustomModal({ type: 'alert', title: i18n('エラー', 'Error'), message: i18n('そのフォルダ名は既に使用されています。', 'That folder name is already in use.') });
                        }
                    });

                    if (folderName !== DEFAULT_FOLDER) {
                        const deleteBtn = document.createElement('button');
                        deleteBtn.textContent = '🗑️';
                        deleteBtn.title = i18n('フォルダを削除', 'Delete folder');
                        deleteBtn.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            const confirmed = await showCustomModal({ type: 'confirm', title: i18n('フォルダの削除', 'Delete Folder'), message: i18n(`フォルダ「${folderName}」と中のチャンネル（${itemCount}件）を削除しますか？`, `Delete folder "${folderName}" and its ${itemCount} channel(s)?`), okText: i18n('削除', 'Delete') });
                            if (confirmed) {
                                delete data.folders[folderName];
                                data.folderOrder = data.folderOrder.filter(f => f !== folderName);
                                if (currentFolder === folderName) {
                                    currentFolder = DEFAULT_FOLDER;
                                    sessionStorage.setItem('selectedFolder', currentFolder);
                                    syncFolderToUrl(currentFolder, { replace: true });
                                }
                                saveChannelData(data);
                                render();
                            }
                        });
                        actionsDiv.appendChild(deleteBtn);
                    }

                    actionsDiv.appendChild(editBtn);

                    li.appendChild(nameSpan);
                    li.appendChild(actionsDiv);
                    folderList.appendChild(li);

                    // 項目全体をクリックしてフォルダを選択できるようにする
                    li.addEventListener('click', (e) => {
                        // ボタンのクリックは除外
                        if (e.target.closest('.folder-actions')) return;
                        setCurrentFolder(folderName);
                    });
                });

                const addFolderBtn = document.createElement('button');
                addFolderBtn.textContent = i18n('+ 新しいフォルダ', '+ New Folder');
                addFolderBtn.className = 'btn';
                addFolderBtn.style.width = '100%';
                addFolderBtn.style.marginTop = '16px';
                addFolderBtn.addEventListener('click', async () => {
                    const name = await showCustomModal({
                        type: 'prompt', title: i18n('新しいフォルダの作成', 'Create New Folder'), message: i18n('フォルダ名を入力してください。', 'Enter a folder name.'), okText: i18n('作成', 'Create'), okClass: 'btn-primary'
                    });
                    if (name && !data.folders[name]) {
                        data.folders[name] = [];
                        data.folderOrder.push(name);
                        saveChannelData(data);
                        render();
                    } else if (name) {
                        await showCustomModal({ type: 'alert', title: i18n('エラー', 'Error'), message: i18n('そのフォルダ名は既に使用されています。', 'That folder name is already in use.') });
                    }
                });

                sidebar.appendChild(folderList);
                sidebar.appendChild(addFolderBtn);
            }

            function reloadData() {
                const newData = getChannelData();
                data = newData; // データを更新
                render();
            }

            function addMylistButton(container) {
                // iframe内（マイリストから開いた場合）はボタン不要
                if (window.self !== window.top) return;
                const mylistBtn = document.createElement('button');
                mylistBtn.textContent = i18n('マイリストを開く', 'Open My List');
                mylistBtn.className = 'btn';
                mylistBtn.style.marginLeft = '16px'; // 他のボタンとの間隔
                mylistBtn.addEventListener('click', () => {
                    window.open(MYLIST_PAGE_URL, 'youtube_mylist_page');
                });
                container.appendChild(mylistBtn);
            }

            function renderMainContent() {
                while (mainContent.firstChild) {
                    mainContent.removeChild(mainContent.firstChild);
                }

                // モバイル下固定バー（前回描画分）をクリア
                const existingMobileBar = document.getElementById('vm-mobile-bottom-bar');
                if (existingMobileBar) existingMobileBar.remove();

                // スクロール追従ヘッダー（タイトル＋ツールバー）
                const stickyHeader = document.createElement('div');
                stickyHeader.className = 'vm-sticky-header';
                const h1 = document.createElement('h1');
                h1.textContent = currentFolder;
                stickyHeader.appendChild(h1);
                mainContent.className = `main-content view-size-${viewSize}`; // サイズクラスを適用

                const actions = document.createElement('div');
                actions.className = 'actions-bar';

                const openSettingsModal = () => {
                    const overlay = document.createElement('div');
                    overlay.className = 'modal-overlay';

                    const modal = document.createElement('div');
                    modal.className = 'modal-content';

                    const h3 = document.createElement('h3');
                    h3.textContent = '設定';
                    modal.appendChild(h3);

                    const close = () => {
                        fontDebugTextarea = null;
                        overlay.remove();
                    };

                    const addSectionTitle = (text) => {
                        const p = document.createElement('p');
                        p.className = 'settings-modal-section';
                        p.textContent = text;
                        modal.appendChild(p);
                    };

                    // 表示形式
                    addSectionTitle('表示形式');
                    const viewRow = document.createElement('div');
                    viewRow.className = 'settings-row';
                    const viewToggle = document.createElement('div');
                    viewToggle.className = 'view-toggle-buttons';
                    const listBtn = document.createElement('button');
                    listBtn.textContent = i18n('リスト', 'List');
                    if (viewMode === 'list') listBtn.classList.add('active');
                    listBtn.addEventListener('click', () => {
                        viewMode = 'list';
                        localStorage.setItem('channelListViewMode', 'list');
                        renderMainContent();
                        close();
                    });
                    const gridBtn = document.createElement('button');
                    gridBtn.textContent = i18n('グリッド', 'Grid');
                    if (viewMode === 'grid') gridBtn.classList.add('active');
                    gridBtn.addEventListener('click', () => {
                        viewMode = 'grid';
                        localStorage.setItem('channelListViewMode', 'grid');
                        renderMainContent();
                        close();
                    });
                    viewToggle.append(listBtn, gridBtn);
                    viewRow.appendChild(viewToggle);
                    modal.appendChild(viewRow);

                    // サイズ
                    addSectionTitle('アイコンサイズ');
                    const sizeRow = document.createElement('div');
                    sizeRow.className = 'settings-row';
                    ['small', 'medium', 'large'].forEach(size => {
                        const btn = document.createElement('button');
                        btn.textContent = { small: i18n('小', 'S'), medium: i18n('中', 'M'), large: i18n('大', 'L') }[size];
                        btn.className = 'btn';
                        if (viewSize === size) btn.style.borderColor = 'var(--text)';
                        btn.addEventListener('click', () => {
                            viewSize = size;
                            localStorage.setItem('channelListViewSize', size);
                            renderMainContent();
                            close();
                        });
                        sizeRow.appendChild(btn);
                    });
                    modal.appendChild(sizeRow);

                    // インポート/エクスポート
                    addSectionTitle('データ');
                    const dataRow = document.createElement('div');
                    dataRow.className = 'settings-row';
                    const exportBtn = document.createElement('button');
                    exportBtn.className = 'btn';
                    exportBtn.textContent = i18n('エクスポート', 'Export');
                    exportBtn.addEventListener('click', () => {
                        close();
                        handleExport();
                    });
                    const importBtn = document.createElement('button');
                    importBtn.className = 'btn';
                    importBtn.textContent = i18n('インポート', 'Import');
                    // iframe内（マイリストから開いた場合）はマイリストボタンを表示しない
                    if (window.self === window.top) {
                        const mylistBtn = document.createElement('button');
                        mylistBtn.className = 'btn';
                        mylistBtn.textContent = i18n('マイリストを開く', 'Open My List');
                        mylistBtn.addEventListener('click', () => {
                            window.open(MYLIST_PAGE_URL, 'youtube_mylist_page');
                        });
                        dataRow.appendChild(mylistBtn);
                    }
                    modal.appendChild(dataRow);

                    // ログ（フォント診断）
                    addSectionTitle('ログ（YCLM-FONT）');
                    const logBox = document.createElement('textarea');
                    logBox.className = 'vm-log-textarea';
                    logBox.readOnly = true;
                    logBox.rows = 8;
                    logBox.value = fontDebugLines.join('\n');
                    modal.appendChild(logBox);

                    const logActions = document.createElement('div');
                    logActions.className = 'settings-row';
                    const copyLogBtn = document.createElement('button');
                    copyLogBtn.className = 'btn';
                    copyLogBtn.textContent = 'コピー';
                    copyLogBtn.addEventListener('click', async () => {
                        const text = logBox.value || '';
                        try {
                            if (navigator.clipboard && navigator.clipboard.writeText) {
                                await navigator.clipboard.writeText(text);
                            } else {
                                logBox.focus();
                                logBox.select();
                                document.execCommand('copy');
                            }
                            showToast(i18n('ログをコピーしました。', 'Log copied.'));
                        } catch (err) {
                            showToast(i18n('コピーできませんでした。', 'Could not copy.'));
                        }
                    });
                    const clearLogBtn = document.createElement('button');
                    clearLogBtn.className = 'btn';
                    clearLogBtn.textContent = 'クリア';
                    clearLogBtn.addEventListener('click', () => {
                        fontDebugLines.length = 0;
                        logBox.value = '';
                        showToast(i18n('ログをクリアしました。', 'Log cleared.'));
                    });
                    logActions.append(copyLogBtn, clearLogBtn);
                    modal.appendChild(logActions);

                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = 'modal-actions';
                    const closeBtn = document.createElement('button');
                    closeBtn.className = 'btn';
                    closeBtn.textContent = i18n('閉じる', 'Close');
                    closeBtn.addEventListener('click', close);
                    actionsDiv.appendChild(closeBtn);
                    modal.appendChild(actionsDiv);

                    overlay.appendChild(modal);
                    document.body.appendChild(overlay);

                    // ログ欄をライブ更新対象にする（モーダルを閉じたら解除）
                    fontDebugTextarea = logBox;

                    overlay.addEventListener('click', (e) => {
                        if (e.target === overlay) close();
                    });
                    const onEsc = (e) => {
                        if (e.key === 'Escape') {
                            close();
                            document.removeEventListener('keydown', onEsc);
                        }
                    };
                    document.addEventListener('keydown', onEsc);
                };

                if (isMobileLike()) {
                    const channels = currentFolder === ALL_CHANNELS_VIRTUAL
                        ? Object.values(data.folders).flat().filter((ch, i, arr) => arr.findIndex(c => c.id === ch.id) === i)
                        : data.folders[currentFolder] || [];
                    channels.sort((a, b) => {
                        if (starLock && sortState.key !== 'star') {
                            const sa = (a.star || 0), sb = (b.star || 0);
                            if (sa !== sb) return (sb - sa); // 星は常に降順固定
                        }
                        const valA = sortState.key === 'star' ? (a.star || 0) : a[sortState.key];
                        const valB = sortState.key === 'star' ? (b.star || 0) : b[sortState.key];
                        if (valA < valB) return -1 * sortState.dir;
                        if (valA > valB) return 1 * sortState.dir;
                        return 0;
                    });
                    if (viewMode === 'grid') {
                        renderGridView(channels);
                    } else {
                        renderListView(channels);
                    }

                    // 画面下固定の2ボタン
                    const bar = document.createElement('div');
                    bar.id = 'vm-mobile-bottom-bar';
                    bar.className = 'mobile-bottom-bar';

                    const folderBtn = document.createElement('button');
                    folderBtn.className = 'btn mobile-bottom-btn primary';
                    folderBtn.textContent = i18n('フォルダ一覧', 'Folders');
                    folderBtn.addEventListener('click', () => {
                        sidebarOpen = !sidebarOpen;
                        updateSidebarUi();
                    });

                    const settingsBtn = document.createElement('button');
                    settingsBtn.className = 'btn mobile-bottom-btn accent';
                    settingsBtn.textContent = '設定';
                    settingsBtn.addEventListener('click', () => {
                        if (typeof window.showSettingsPanel === 'function') {
                            window.showSettingsPanel('channellist');
                        } else {
                            openSettingsModal();
                        }
                    });
                    openSettingsModalRef = openSettingsModal; // 右上ボタンから呼べるよう外部参照を更新

                    bar.append(folderBtn, settingsBtn);
                    document.body.appendChild(bar);

                    updateSidebarUi();
                    return;
                }

                const actionButtons = document.createElement('div');

                // グリッド表示のときは一括操作ボタンを非表示
                if (viewMode === 'list') {
                    const deleteBtn = document.createElement('button');
                    deleteBtn.textContent = i18n('選択を削除', 'Delete Selected');
                    deleteBtn.className = 'btn btn-danger';
                    deleteBtn.addEventListener('click', handleDelete);

                    const moveBtn = document.createElement('button');
                    moveBtn.textContent = i18n('選択を移動', 'Move Selected');
                    moveBtn.className = 'btn';
                    moveBtn.addEventListener('click', handleMove);

                    actionButtons.appendChild(moveBtn);
                    actionButtons.appendChild(deleteBtn);
                }

                // サイズ切替ボタン
                const sizeToggleButtons = document.createElement('div');
                sizeToggleButtons.className = 'view-toggle-buttons';
                sizeToggleButtons.style.marginLeft = '16px';
                ['small', 'medium', 'large'].forEach(size => {
                    const btn = document.createElement('button');
                    btn.textContent = { small: i18n('小', 'S'), medium: i18n('中', 'M'), large: i18n('大', 'L') }[size];
                    if (viewSize === size) btn.classList.add('active');
                    btn.addEventListener('click', () => {
                        viewSize = size;
                        localStorage.setItem('channelListViewSize', size);
                        renderMainContent();
                    });
                    sizeToggleButtons.appendChild(btn);
                });

                // 表示形式切替ボタン
                const viewToggleButtons = document.createElement('div');
                viewToggleButtons.className = 'view-toggle-buttons';
                const listBtn = document.createElement('button');
                listBtn.textContent = i18n('リスト', 'List');
                if (viewMode === 'list') listBtn.classList.add('active');
                listBtn.addEventListener('click', () => {
                    viewMode = 'list';
                    localStorage.setItem('channelListViewMode', 'list');
                    renderMainContent();
                });

                const gridBtn = document.createElement('button');
                gridBtn.textContent = i18n('グリッド', 'Grid');
                if (viewMode === 'grid') gridBtn.classList.add('active');
                gridBtn.addEventListener('click', () => {
                    viewMode = 'grid';
                    localStorage.setItem('channelListViewMode', 'grid');
                    renderMainContent();
                });

                viewToggleButtons.appendChild(listBtn);
                viewToggleButtons.appendChild(gridBtn);

                actions.appendChild(actionButtons);
                actions.appendChild(sizeToggleButtons);
                actions.appendChild(viewToggleButtons);
                addMylistButton(actions); // マイリストボタンを追加

                const exportBtn = document.createElement('button');
                exportBtn.textContent = i18n('エクスポート', 'Export');
                exportBtn.className = 'btn';
                exportBtn.style.marginLeft = '16px';
                exportBtn.addEventListener('click', handleExport);
                actions.appendChild(exportBtn);

                const importBtn = document.createElement('button');
                importBtn.textContent = i18n('インポート', 'Import');
                importBtn.className = 'btn';
                importBtn.addEventListener('click', handleImport);
                actions.appendChild(importBtn);

                openSettingsModalRef = openSettingsModal;

                stickyHeader.appendChild(actions);
                mainContent.appendChild(stickyHeader);

                // 以降の動的コンテンツはスクロールエリアの中に入れる
                const scrollArea = document.createElement('div');
                scrollArea.className = 'vm-scroll-area';
                mainContent.appendChild(scrollArea);
                // renderListView / renderGridView が mainContent.appendChild を呼ぶのを
                // スクロールエリアへの appendChild に一時的に差し替える
                mainContent.appendChild = (node) => scrollArea.appendChild(node);
                // ピン状態を初期適用
                scrollArea.classList.toggle('vm-thead-unpinned', !headerPinned);

                const channels = currentFolder === ALL_CHANNELS_VIRTUAL
                    ? Object.values(data.folders).flat().filter((ch, i, arr) => arr.findIndex(c => c.id === ch.id) === i)
                    : data.folders[currentFolder] || [];
                // ソート処理
                channels.sort((a, b) => {
                    if (starLock && sortState.key !== 'star') {
                        const sa = (a.star || 0), sb = (b.star || 0);
                        if (sa !== sb) return (sb - sa); // 星は常に降順固定
                    }
                    const valA = sortState.key === 'star' ? (a.star || 0) : a[sortState.key];
                    const valB = sortState.key === 'star' ? (b.star || 0) : b[sortState.key];
                    if (valA < valB) return -1 * sortState.dir;
                    if (valA > valB) return 1 * sortState.dir;
                    return 0;
                });

                if (viewMode === 'grid') {
                    renderGridView(channels);
                } else {
                    renderListView(channels);
                }

                // appendChild の差し替えを解除
                try { delete mainContent.appendChild; } catch (_) { }

                updateSidebarUi();
            }

            function downloadFile(dataStr, filename, mimeType) {
                const blob = new Blob([dataStr], { type: mimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(url);
                }, 100);
            }

            function handleExport() {
                const backup = buildUnifiedBackupPayload(getChannelData());
                const jsonString = JSON.stringify(backup, null, 2);
                const now = new Date();
                const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
                const timePart = now.toTimeString().slice(0, 8).replace(/:/g, '');
                downloadFile(jsonString, `${LOCAL_UNIFIED_BACKUP_PREFIX}_${datePart}_${timePart}.json`, 'application/json');
                showToast(i18n('マイリスト＋チャンネルリストをエクスポートしました。', 'Exported My List + Channel List.'));
            }

            function handleImport() {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;

                    const reader = new FileReader();
                    reader.onload = async (event) => {
                        try {
                            const parsed = JSON.parse(event.target.result);
                            const backup = parseUnifiedBackupPayload(parsed);
                            const hasMylist = !!(backup.mylistData && backup.mylistData.folders);
                            const hasChannel = !!(backup.channelListData && backup.channelListData.folders);

                            if (!hasMylist && !hasChannel) {
                                throw new Error('無効なデータ形式です。');
                            }

                            let importMode = 'all';
                            if (hasMylist && hasChannel) {
                                const mode = await showImportTargetSelectorModal(hasMylist, hasChannel);
                                if (!mode) return;
                                importMode = mode;
                            } else if (hasMylist) {
                                importMode = 'mylist';
                            } else if (hasChannel) {
                                importMode = 'channel';
                            }

                            if ((importMode === 'all' || importMode === 'mylist') && !hasMylist) {
                                await showCustomModal({ type: 'alert', title: i18n('インポートエラー', 'Import Error'), message: i18n('このファイルにはマイリストデータが含まれていません。', 'This file does not contain My List data.') });
                                return;
                            }
                            if ((importMode === 'all' || importMode === 'channel') && !hasChannel) {
                                await showCustomModal({ type: 'alert', title: i18n('インポートエラー', 'Import Error'), message: i18n('このファイルにはチャンネルリストデータが含まれていません。', 'This file does not contain Channel List data.') });
                                return;
                            }

                            const restoreItems = [];
                            if (importMode === 'all' || importMode === 'mylist') restoreItems.push('マイリストデータ');
                            if (importMode === 'all' || importMode === 'channel') restoreItems.push('チャンネルリストデータ');
                            if (importMode === 'all' && backup.syncData) restoreItems.push('再生リスト同期設定');
                            if (importMode === 'all' && backup.ytApiKey) restoreItems.push('YouTube APIキー');
                            if (importMode === 'all' && backup.autoExport) restoreItems.push('自動エクスポート設定');
                            if (importMode === 'all' && backup.trashAutoDelete) restoreItems.push('ゴミ箱自動削除設定');
                            if (importMode === 'all' && Array.isArray(backup.thumbExtraFolderBtns)) restoreItems.push('サムネ追加フォルダボタン設定');
                            if (importMode === 'all' && backup.folderViewModes) restoreItems.push('フォルダごとの表示モード設定');
                            if (importMode === 'all' && Array.isArray(backup.gridMoveButtons)) restoreItems.push('グリッド移動ボタン設定');
                            if (importMode === 'all' && backup.extraPersistedSettings) restoreItems.push('追加UI・動作設定');

                            // 無料プランの制限をデータに適用（content.js と同じ方針）
                            const _freeLimitOk = await _applyFreePlanLimitsToBackupInteractive(backup);
                            if (!_freeLimitOk) return;

                            const confirmed = await showCustomModal({
                                type: 'confirm',
                                title: i18n('データのインポート', 'Import Data'),
                                message: i18n(`ファイル「${file.name}」をインポートします。\n選択した項目を上書きします。よろしいですか？\n復元内容: ${restoreItems.join('・')}`, `Import "${file.name}".\nThis will overwrite the selected items. Continue?\nContent: ${restoreItems.join(', ')}`),
                                okText: 'インポート'
                            });
                            if (confirmed) {
                                if (importMode === 'all' || importMode === 'mylist') {
                                    GM_setValue(MYLIST_STORAGE_KEY, backup.mylistData);
                                }
                                if (importMode === 'all' || importMode === 'channel') {
                                    saveChannelData(backup.channelListData);
                                }

                                if (importMode === 'all') {
                                    if (backup.syncData) GM_setValue(PLAYLIST_SYNC_KEY, backup.syncData);
                                    if (backup.ytApiKey) setYouTubeApiKey(backup.ytApiKey);
                                    if (backup.autoExport) localStorage.setItem(AUTO_EXPORT_KEY, JSON.stringify(backup.autoExport));
                                    if (backup.trashAutoDelete) localStorage.setItem(TRASH_AUTO_DELETE_KEY, JSON.stringify(backup.trashAutoDelete));
                                    if (Array.isArray(backup.thumbExtraFolderBtns)) setThumbExtraFolderBtnsFromBackup(backup.thumbExtraFolderBtns);
                                    if (backup.folderViewModes) setFolderViewModesFromBackup(backup.folderViewModes);
                                    if (Array.isArray(backup.gridMoveButtons)) setGridMoveButtonsFromBackup(backup.gridMoveButtons);
                                    applyUnifiedBackupExtraPersistedSettings(backup.extraPersistedSettings);
                                }

                                if (importMode === 'all' || importMode === 'channel') {
                                    showToast(i18n('インポートしました。', 'Imported successfully.'));
                                    render();
                                } else {
                                    showToast(i18n('マイリストのみインポートしました。', 'Imported My List only.'));
                                }
                            }
                        } catch (err) {
                            await showCustomModal({ type: 'alert', title: i18n('インポートエラー', 'Import Error'), message: i18n(`ファイルの読み込みに失敗しました: ${err.message}`, `Failed to read file: ${err.message}`) });
                        }
                    };
                    reader.readAsText(file);
                };
                input.click();
            }

            async function handleDelete() {
                const checkedIds = getCheckedChannelIds();
                if (checkedIds.length === 0) {
                    await showCustomModal({ type: 'alert', title: i18n('エラー', 'Error'), message: i18n('削除するチャンネルを選択してください。', 'Please select channels to delete.') });
                    return;
                }

                const isAllView = currentFolder === ALL_CHANNELS_VIRTUAL;
                const isDefaultFolder = currentFolder === DEFAULT_FOLDER;

                let deleteMode; // 'complete' | 'folder-only'
                if (isAllView || isDefaultFolder) {
                    // すべてタブ or デフォルトフォルダ → 完全削除のみ
                    const confirmed = await showCustomModal({
                        type: 'confirm',
                        title: i18n('チャンネルの削除', 'Delete Channel(s)'),
                        message: i18n(`${checkedIds.length}件のチャンネルを完全に削除しますか？`, `Permanently delete ${checkedIds.length} channel(s)?`),
                        okText: i18n('完全に削除', 'Delete Permanently')
                    });
                    if (!confirmed) return;
                    deleteMode = 'complete';
                } else {
                    // 個別フォルダ → 選択ダイアログ
                    const choice = await showCustomModal({
                        type: 'select',
                        title: i18n('削除方法を選択', 'Select Delete Method'),
                        message: i18n(
                            `${checkedIds.length}件のチャンネルをどのように削除しますか？\n「このフォルダから削除」を選ぶと「${DEFAULT_FOLDER}」に移動します。`,
                            `How do you want to delete ${checkedIds.length} channel(s)?\n"Remove from folder" will move them to "${DEFAULT_FOLDER}".`
                        ),
                        buttons: [
                            { label: i18n('このフォルダから削除', 'Remove from Folder'), value: 'folder-only' },
                            { label: i18n('完全に削除', 'Delete Permanently'), value: 'complete', danger: true },
                        ]
                    });
                    if (!choice) return;
                    deleteMode = choice;
                }

                try {
                    const idSet = new Set(checkedIds);
                    if (deleteMode === 'complete') {
                        // 全フォルダから完全削除
                        Object.keys(data.folders).forEach(fname => {
                            const arr = data.folders[fname];
                            if (Array.isArray(arr)) {
                                data.folders[fname] = arr.filter(ch => !idSet.has(ch && ch.id));
                            }
                        });
                    } else {
                        // このフォルダから削除 → デフォルトフォルダへ移動
                        const moving = (data.folders[currentFolder] || []).filter(ch => idSet.has(ch && ch.id));
                        data.folders[currentFolder] = (data.folders[currentFolder] || []).filter(ch => !idSet.has(ch && ch.id));
                        if (!Array.isArray(data.folders[DEFAULT_FOLDER])) data.folders[DEFAULT_FOLDER] = [];
                        // デフォルトフォルダに未登録のものだけ追加（重複防止）
                        const existIds = new Set(data.folders[DEFAULT_FOLDER].map(ch => ch.id));
                        moving.forEach(ch => { if (!existIds.has(ch.id)) data.folders[DEFAULT_FOLDER].push(ch); });
                    }
                } catch (e) {
                    console.error('チャンネル削除中にエラー:', e);
                }
                saveChannelData(data);
                render();
            }

            function handleMove() {
                const checkedIds = getCheckedChannelIds();
                if (checkedIds.length === 0) {
                    showCustomModal({ type: 'alert', title: i18n('エラー', 'Error'), message: i18n('移動するチャンネルを選択してください。', 'Please select channels to move.') });
                    return;
                }
                showMoveModal(checkedIds);
            }

            // 星の色を値に応じて返す (0=灰 1=青 2=水色 3=黄 4=オレンジ 5=赤)
            function getStarColor(val) {
                return ['#555', '#4a90d9', '#00bcd4', '#f5c518', '#ff9800', '#e53935'][val] || '#555';
            }

            // 1つの☟ボタン（クリックでポップアップを開く）
            function makeSingleStarBtn(channel) {
                const btn = document.createElement('button');
                btn.className = 'vm-star-btn';
                const val = channel.star || 0;
                btn.textContent = val === 0 ? '☆' : '★';
                btn.style.color = getStarColor(val);
                btn.title = i18n(`評価: ${val} / クリックで変更`, `Rating: ${val} / Click to change`);

                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    // 既存のポップアップを適宜閉じる
                    document.querySelectorAll('.vm-star-popup').forEach(p => p.remove());

                    const popup = document.createElement('div');
                    popup.className = 'vm-star-popup';

                    const label = document.createElement('span');
                    label.className = 'vm-star-pop-label';
                    label.textContent = '評価:';
                    popup.appendChild(label);

                    for (let s = 0; s <= 5; s++) {
                        const pb = document.createElement('button');
                        pb.textContent = s === 0 ? '☆' : '★';
                        pb.style.color = getStarColor(s);
                        pb.title = s === 0 ? i18n('評価なし', 'No rating') : `${s}`;
                        if (s === val) pb.style.outline = '2px solid #888';
                        pb.addEventListener('click', (e2) => {
                            e2.stopPropagation();
                            popup.remove();
                            Object.values(data.folders).forEach(arr => {
                                const ch = arr.find(c => c.id === channel.id);
                                if (ch) ch.star = s;
                            });
                            channel.star = s;
                            saveChannelData(data);
                            btn.textContent = s === 0 ? '☆' : '★';
                            btn.style.color = getStarColor(s);
                            btn.title = i18n(`評価: ${s} / クリックで変更`, `Rating: ${s} / Click to change`);
                        });
                        popup.appendChild(pb);
                    }

                    // ボタンの位置にポップアップを配置
                    document.body.appendChild(popup);
                    const rect = btn.getBoundingClientRect();
                    const pw = popup.offsetWidth || 200;
                    const ph = popup.offsetHeight || 44;
                    let left = rect.left;
                    let top = rect.bottom + 4;
                    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
                    if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
                    popup.style.left = `${left}px`;
                    popup.style.top = `${top}px`;

                    // 外側クリックで閉じる
                    const close = (ev) => {
                        if (!popup.contains(ev.target) && ev.target !== btn) {
                            popup.remove();
                            document.removeEventListener('click', close, true);
                        }
                    };
                    setTimeout(() => document.addEventListener('click', close, true), 0);
                });
                return btn;
            }

            function renderGridView(channels) {
                const gridContainer = document.createElement('div');
                gridContainer.className = 'grid-container';

                const showMobileChannelActionSheet = (channel) => {
                    const overlay = document.createElement('div');
                    overlay.className = 'modal-overlay vm-center';

                    const modal = document.createElement('div');
                    modal.className = 'modal-content';

                    const h3 = document.createElement('h3');
                    h3.textContent = channel.name;
                    modal.appendChild(h3);

                    const p = document.createElement('p');
                    p.textContent = i18n('操作を選択してください。', 'Select an action.');
                    modal.appendChild(p);

                    const actions = document.createElement('div');
                    actions.className = 'settings-row';
                    actions.style.flexDirection = 'column';
                    actions.style.alignItems = 'stretch';

                    const close = () => {
                        overlay.remove();
                    };

                    const moveBtn = document.createElement('button');
                    moveBtn.className = 'btn';
                    moveBtn.textContent = 'フォルダ移動';
                    moveBtn.style.width = '100%';
                    moveBtn.addEventListener('click', () => {
                        close();
                        showMoveModal([channel.id]);
                    });

                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'btn btn-danger';
                    deleteBtn.textContent = i18n('削除', 'Delete');
                    deleteBtn.style.width = '100%';
                    deleteBtn.addEventListener('click', async () => {
                        const confirmed = await showCustomModal({
                            type: 'confirm', title: i18n('チャンネルの削除', 'Delete Channel'), message: i18n(`「${channel.name}」を削除しますか？`, `Delete "${channel.name}"?`), okText: i18n('削除', 'Delete')
                        });
                        if (confirmed) {
                            data.folders[currentFolder] = data.folders[currentFolder].filter(ch => ch.id !== channel.id);
                            saveChannelData(data);
                            close();
                            render();
                        }
                    });

                    const cancelBtn = document.createElement('button');
                    cancelBtn.className = 'btn';
                    cancelBtn.textContent = 'キャンセル';
                    cancelBtn.style.width = '100%';
                    cancelBtn.addEventListener('click', close);

                    actions.append(moveBtn, deleteBtn, cancelBtn);
                    modal.appendChild(actions);

                    overlay.appendChild(modal);
                    document.body.appendChild(overlay);

                    overlay.addEventListener('click', (e) => {
                        if (e.target === overlay) close();
                    });
                    const onEsc = (e) => {
                        if (e.key === 'Escape') {
                            close();
                            document.removeEventListener('keydown', onEsc);
                        }
                    };
                    document.addEventListener('keydown', onEsc);
                };

                channels.forEach(channel => {
                    const baseIconSize = { small: 90, medium: 120, large: 150 }[viewSize];
                    const iconSize = (() => {
                        if (!isMobileLike()) return baseIconSize;
                        const dpr = (typeof window.devicePixelRatio === 'number' && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1;
                        const contentPadding = 32; // main-content左右padding(16*2)
                        const gridGap = 12; // html.vm-mobileのgrid gap列
                        const cols = ({ small: 4, medium: 3, large: 2 }[viewSize] || 2);
                        const totalGaps = gridGap * (cols - 1);
                        const cellWidthCss = (window.innerWidth - contentPadding - totalGaps) / cols;
                        const targetPx = Math.round(cellWidthCss * dpr);
                        return Math.min(512, Math.max(200, targetPx));
                    })();
                    const channelUrl = buildChannelUrl(channel.id);

                    const item = document.createElement('div');
                    item.className = 'grid-item';

                    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
                    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;

                    const link = document.createElement('a');
                    link.href = channelUrl;
                    link.target = '_blank';
                    link.className = 'grid-item-link';

                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'grid-item-name';

                    if (channel.latestVideoPublishedAt) {
                        const publishedTime = new Date(channel.latestVideoPublishedAt).getTime();
                        if (publishedTime > twentyFourHoursAgo) {
                            const indicator = document.createElement('span');
                            indicator.className = 'very-new-video-indicator';
                            indicator.textContent = '・';
                            nameSpan.appendChild(indicator);
                        } else if (publishedTime > threeDaysAgo) {
                            const indicator = document.createElement('span');
                            indicator.className = 'new-video-indicator';
                            indicator.textContent = '・';
                            nameSpan.appendChild(indicator);
                        }
                    }
                    nameSpan.appendChild(document.createTextNode(channel.name));

                    const icon = document.createElement('img');
                    icon.src = (channel.iconUrl || '').replace(/=s\d+-c/, `=s${iconSize}-c`);
                    icon.className = 'grid-item-icon';
                    icon.alt = channel.name;
                    if (!channel.iconUrl) icon.style.visibility = 'hidden';
                    const iconWrap = document.createElement('div');
                    iconWrap.className = 'grid-item-icon-wrap';
                    iconWrap.appendChild(icon);
                    link.appendChild(iconWrap);
                    link.appendChild(nameSpan);
                    item.appendChild(link);

                    if (isMobileLike()) {
                        let longPressTimer = null;
                        let longPressed = false;
                        let startX = 0;
                        let startY = 0;

                        const cancelLongPress = () => {
                            if (longPressTimer) {
                                clearTimeout(longPressTimer);
                                longPressTimer = null;
                            }
                        };

                        item.addEventListener('pointerdown', (e) => {
                            if (e.button !== 0) return;
                            if (e.pointerType && e.pointerType !== 'touch') return;

                            longPressed = false;
                            startX = e.clientX;
                            startY = e.clientY;
                            cancelLongPress();
                            longPressTimer = setTimeout(() => {
                                longPressed = true;
                                showMobileChannelActionSheet(channel);
                            }, 550);
                        });

                        item.addEventListener('pointermove', (e) => {
                            if (!longPressTimer) return;
                            const dx = Math.abs(e.clientX - startX);
                            const dy = Math.abs(e.clientY - startY);
                            if (dx > 10 || dy > 10) cancelLongPress();
                        });

                        item.addEventListener('pointerup', cancelLongPress);
                        item.addEventListener('pointercancel', cancelLongPress);
                        item.addEventListener('contextmenu', (e) => {
                            e.preventDefault();
                        });

                        link.addEventListener('click', (e) => {
                            if (!longPressed) return;
                            e.preventDefault();
                            e.stopPropagation();
                            longPressed = false;
                        });
                    }

                    if (!isMobileLike()) {
                        const deleteBtn = document.createElement('button');
                        deleteBtn.className = 'grid-item-delete-btn';
                        deleteBtn.textContent = '✕';
                        deleteBtn.title = i18n('このチャンネルを削除', 'Remove this channel');
                        deleteBtn.addEventListener('click', async (e) => {
                            e.preventDefault();
                            const isAllView = currentFolder === ALL_CHANNELS_VIRTUAL;
                            const isDefaultFld = currentFolder === DEFAULT_FOLDER;
                            if (isAllView || isDefaultFld) {
                                const confirmed = await showCustomModal({
                                    type: 'confirm', title: i18n('チャンネルの削除', 'Delete Channel'),
                                    message: i18n(`「${channel.name}」を完全に削除しますか？`, `Permanently delete "${channel.name}"?`),
                                    okText: i18n('完全に削除', 'Delete Permanently')
                                });
                                if (!confirmed) return;
                                Object.keys(data.folders).forEach(fname => {
                                    data.folders[fname] = data.folders[fname].filter(ch => ch.id !== channel.id);
                                });
                            } else {
                                const choice = await showCustomModal({
                                    type: 'select',
                                    title: i18n('削除方法を選択', 'Select Delete Method'),
                                    message: i18n(
                                        `「${channel.name}」をどのように削除しますか？\n「このフォルダから削除」を選ぶと「${DEFAULT_FOLDER}」に移動します。`,
                                        `How do you want to delete "${channel.name}"?\n"Remove from folder" will move it to "${DEFAULT_FOLDER}".`
                                    ),
                                    buttons: [
                                        { label: i18n('このフォルダから削除', 'Remove from Folder'), value: 'folder-only' },
                                        { label: i18n('完全に削除', 'Delete Permanently'), value: 'complete', danger: true },
                                    ]
                                });
                                if (!choice) return;
                                if (choice === 'complete') {
                                    Object.keys(data.folders).forEach(fname => {
                                        data.folders[fname] = data.folders[fname].filter(ch => ch.id !== channel.id);
                                    });
                                } else {
                                    data.folders[currentFolder] = data.folders[currentFolder].filter(ch => ch.id !== channel.id);
                                    if (!Array.isArray(data.folders[DEFAULT_FOLDER])) data.folders[DEFAULT_FOLDER] = [];
                                    if (!data.folders[DEFAULT_FOLDER].some(ch => ch.id === channel.id)) {
                                        data.folders[DEFAULT_FOLDER].push(channel);
                                    }
                                }
                            }
                            saveChannelData(data);
                            render();
                        });

                        const moveBtn = document.createElement('button');
                        moveBtn.className = 'grid-item-move-btn';
                        moveBtn.textContent = '📁';
                        moveBtn.title = i18n('このチャンネルを移動', 'Move this channel');
                        moveBtn.style.cssText = `
                        position: absolute;
                        top: -4px;
                        left: -4px;
                        background: none;
                        color: white;
                        border: none;
                        outline: none;
                        box-shadow: none;
                        border-radius: 0;
                        width: 18px;
                        height: 18px;
                        font-size: 13px;
                        padding: 0;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        opacity: 0.8;
                        transition: opacity 0.15s, transform 0.1s;
                        text-shadow: 0 0 4px rgba(0,0,0,0.8);
                        z-index: 2;
                    `;
                        moveBtn.addEventListener('click', (e) => {
                            e.preventDefault();
                            showMoveModal([channel.id]);
                        });

                        iconWrap.appendChild(moveBtn);
                        iconWrap.appendChild(deleteBtn);

                        // アイコン右上に通知バッジ風で星評価を表示
                        const starDiv = makeSingleStarBtn(channel);
                        starDiv.className = 'vm-star-grid';
                        const starVal = channel.star || 0;
                        const starColor = getStarColor(starVal);
                        starDiv.style.background = 'none';
                        starDiv.textContent = '';
                        if (starVal > 0) {
                            starDiv.classList.add('has-star');
                            starDiv.textContent = '★';
                            starDiv.style.color = starColor;
                        } else {
                            starDiv.textContent = '☆';
                            starDiv.style.color = '#ccc';
                        }
                        // ポップアップ選択後にバッジ表示を更新
                        starDiv.addEventListener('click', (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setTimeout(() => {
                                const newVal = channel.star || 0;
                                starDiv.style.background = 'none';
                                if (newVal > 0) {
                                    starDiv.classList.add('has-star');
                                    starDiv.textContent = '★';
                                    starDiv.style.color = getStarColor(newVal);
                                } else {
                                    starDiv.classList.remove('has-star');
                                    starDiv.textContent = '☆';
                                    starDiv.style.color = '#ccc';
                                }
                            }, 80);
                        });
                        const sizeClass = { small: 'icon-s', medium: 'icon-m', large: 'icon-l' }[viewSize] || 'icon-m';
                        starDiv.classList.add(sizeClass);
                        iconWrap.appendChild(starDiv);
                    }
                    gridContainer.appendChild(item);
                });

                mainContent.appendChild(gridContainer);
            }

            // マイリストに最新動画を追加するモーダル
            function addToMylistInstant(channel) {
                let mylistData = null;
                try {
                    const raw = GM_getValue(MYLIST_STORAGE_KEY, null);
                    mylistData = raw && typeof raw === 'object' ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null);
                } catch (_) { }
                if (!mylistData || !mylistData.folders) {
                    showCustomModal({ type: 'alert', title: i18n('マイリストなし', 'No My List'), message: i18n('マイリストデータが見つかりません。', 'My List data not found.') });
                    return;
                }
                const videoId = channel.latestVideoId;
                if (!videoId) {
                    showCustomModal({ type: 'alert', title: i18n('動画なし', 'No Video'), message: i18n('最新動画が取得できていません。', 'Latest video has not been fetched yet.') });return;
                }
                // 全フォルダで登録済かチェック
                const allFolders = mylistData.folderOrder || Object.keys(mylistData.folders);
                const alreadyIn = allFolders.filter(f => (mylistData.folders[f] || []).some(v => v && v.id === videoId));
                if (alreadyIn.length > 0) {
                    showToast(i18n(`⚠ すでに「${alreadyIn.join('」「')}」に登録済みです`, `⚠ Already registered in: ${alreadyIn.join(', ')}`) );
                    return;
                }
                // 先頭フォルダに追加
                const targetFolder = allFolders[0];
                if (!Array.isArray(mylistData.folders[targetFolder])) mylistData.folders[targetFolder] = [];
                const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
                mylistData.folders[targetFolder].push({
                    id: videoId,
                    title: channel.latestVideoTitle || '',
                    thumb: thumbnailUrl,
                    note: '',
                    addedAt: new Date().toISOString(),
                    publishedAt: channel.latestVideoPublishedAt || '',
                    channelId: channel.id,
                    channelTitle: channel.name
                });
                GM_setValue(MYLIST_STORAGE_KEY, mylistData);
                showToast(i18n(`✅ 「${targetFolder}」に追加しました`, `✅ Added to "${targetFolder}"`));
            }

            function showAddToMylistModal(channel) {
                let mylistData = null;
                try {
                    const raw = GM_getValue(MYLIST_STORAGE_KEY, null);
                    mylistData = raw && typeof raw === 'object' ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null);
                } catch (_) { }
                if (!mylistData || !mylistData.folders) {
                    showCustomModal({ type: 'alert', title: i18n('マイリストなし', 'No My List'), message: i18n('マイリストデータが見つかりません。', 'My List data not found.') });
                    return;
                }
                const folderOrder = mylistData.folderOrder || Object.keys(mylistData.folders);
                const videoId = channel.latestVideoId;
                const videoTitle = channel.latestVideoTitle || '';
                const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay vm-center';
                const modal = document.createElement('div');
                modal.className = 'modal-content';
                modal.style.cssText = 'min-width:280px;max-width:400px;';

                const h3 = document.createElement('h3');
                h3.textContent = i18n('マイリストに追加', 'Add to My List');
                h3.style.margin = '0 0 8px';
                modal.appendChild(h3);

                const videoInfo = document.createElement('div');
                videoInfo.style.cssText = 'font-size:13px;color:var(--sub-text);margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                videoInfo.textContent = videoTitle;
                videoInfo.title = videoTitle;
                modal.appendChild(videoInfo);

                const label = document.createElement('div');
                label.textContent = i18n('フォルダを選択:', 'Select folder:');
                label.style.cssText = 'font-size:13px;margin-bottom:6px;';
                modal.appendChild(label);

                const select = document.createElement('select');
                select.style.cssText = 'width:100%;padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg,#2a2a2a);color:var(--text);font-size:14px;margin-bottom:16px;';
                folderOrder.forEach(folder => {
                    const opt = document.createElement('option');
                    opt.value = folder;
                    opt.textContent = folder;
                    // すでに登録済みかチェック
                    const list = mylistData.folders[folder] || [];
                    if (list.some(v => v && v.id === videoId)) {
                        opt.textContent = folder + ' ✓登録済み';
                    }
                    select.appendChild(opt);
                });
                modal.appendChild(select);

                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'btn';
                cancelBtn.textContent = 'キャンセル';
                cancelBtn.addEventListener('click', () => overlay.remove());

                const addBtn = document.createElement('button');
                addBtn.className = 'btn primary';
                addBtn.textContent = '追加';
                addBtn.addEventListener('click', () => {
                    const target = select.value;
                    // 最新のデータを再取得
                    let d = null;
                    try {
                        const raw = GM_getValue(MYLIST_STORAGE_KEY, null);
                        d = raw && typeof raw === 'object' ? raw : (typeof raw === 'string' ? JSON.parse(raw) : null);
                    } catch (_) { }
                    if (!d || !d.folders) { overlay.remove(); return; }
                    if (!Array.isArray(d.folders[target])) d.folders[target] = [];
                    if (d.folders[target].some(v => v && v.id === videoId)) {
                        showCustomModal({ type: 'alert', title: i18n('登録済み', 'Already Added'), message: i18n(`「${target}」にはすでに登録されています。`, `Already registered in "${target}".`) });
                        return;
                    }
                    d.folders[target].push({
                        id: videoId,
                        title: videoTitle,
                        thumb: thumbnailUrl,
                        note: '',
                        addedAt: new Date().toISOString(),
                        publishedAt: channel.latestVideoPublishedAt || '',
                        channelId: channel.id,
                        channelTitle: channel.name
                    });
                    GM_setValue(MYLIST_STORAGE_KEY, d);
                    overlay.remove();
                    showCustomModal({ type: 'alert', title: i18n('追加完了', 'Added'), message: i18n(`「${target}」に追加しました。`, `Added to "${target}".`) });
                });

                btnRow.append(cancelBtn, addBtn);
                modal.appendChild(btnRow);
                overlay.appendChild(modal);
                document.body.appendChild(overlay);
                overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
            }

            function renderListView(channels) {
                const table = document.createElement('table');
                table.className = 'channel-table';
                const thead = document.createElement('thead');
                const trHead = document.createElement('tr');
                const thCheck = document.createElement('th');
                thCheck.className = 'col-check';
                const selectAllCheckbox = document.createElement('input');
                selectAllCheckbox.type = 'checkbox';
                selectAllCheckbox.id = 'select-all';
                thCheck.appendChild(selectAllCheckbox);
                const thStar = document.createElement('th');
                thStar.className = 'col-star';
                thStar.dataset.sort = 'star';
                const thStarLabel = document.createElement('span');
                thStarLabel.textContent = '☆';
                const lockBtn = document.createElement('button');
                lockBtn.className = 'vm-star-lock-btn' + (starLock ? ' locked' : '');
                lockBtn.textContent = starLock ? '🔒' : '🔓';
                lockBtn.title = starLock ? '星グループソート: ON（クリックで解除）' : '星グループソート: OFF（クリックで有効化）';
                lockBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    starLock = !starLock;
                    lockBtn.className = 'vm-star-lock-btn' + (starLock ? ' locked' : '');
                    lockBtn.textContent = starLock ? '🔒' : '🔓';
                    lockBtn.title = starLock ? i18n('星グループソート: ON（クリックで解除）', 'Star group sort: ON (click to disable)') : i18n('星グループソート: OFF（クリックで有効化）', 'Star group sort: OFF (click to enable)');
                    renderMainContent();
                });
                thStar.appendChild(thStarLabel);
                thStar.appendChild(lockBtn);
                const thName = document.createElement('th');
                thName.dataset.sort = 'name';
                thName.textContent = i18n('チャンネル名', 'Channel');
                const thLatest = document.createElement('th');
                thLatest.dataset.sort = 'latestVideoPublishedAt';
                thLatest.textContent = i18n('最新動画', 'Latest Video');
                const thAdded = document.createElement('th');
                thAdded.className = 'col-added';
                thAdded.dataset.sort = 'addedAt';
                thAdded.textContent = i18n('登録日', 'Added');
                const thActions = document.createElement('th');
                thActions.className = 'col-actions';
                thActions.style.cursor = 'pointer';
                thActions.title = i18n(
                    headerPinned ? 'ヘッダー固定中（クリックでスクロール追従に変更）' : 'スクロール追従中（クリックでヘッダーを固定）',
                    headerPinned ? 'Header pinned (click to unpin)' : 'Header unpinned (click to pin)'
                );
                thActions.addEventListener('click', (e) => {
                    e.stopPropagation();
                    pinBtn.click();
                });
                const pinBtn = document.createElement('button');
                pinBtn.className = 'vm-header-pin-btn' + (headerPinned ? ' pinned' : '');
                pinBtn.textContent = headerPinned ? '📌' : '📍';
                pinBtn.title = i18n(
                    headerPinned ? 'ヘッダー固定中（クリックでスクロール追従に変更）' : 'スクロール追従中（クリックでヘッダーを固定）',
                    headerPinned ? 'Header pinned (click to unpin)' : 'Header unpinned (click to pin)'
                );
                pinBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    headerPinned = !headerPinned;
                    localStorage.setItem('channelListHeaderPinned', String(headerPinned));
                    pinBtn.className = 'vm-header-pin-btn' + (headerPinned ? ' pinned' : '');
                    pinBtn.textContent = headerPinned ? '📌' : '📍';
                    const titleText = i18n(
                        headerPinned ? 'ヘッダー固定中（クリックでスクロール追従に変更）' : 'スクロール追従中（クリックでヘッダーを固定）',
                        headerPinned ? 'Header pinned (click to unpin)' : 'Header unpinned (click to pin)'
                    );
                    pinBtn.title = titleText;
                    thActions.title = titleText;
                    const sa = document.querySelector('.vm-scroll-area');
                    if (sa) sa.classList.toggle('vm-thead-unpinned', !headerPinned);
                });
                thActions.appendChild(pinBtn);

                const thDelete = document.createElement('th');
                thDelete.className = 'col-delete';
                thDelete.style.cssText = 'width:28px;min-width:28px;text-align:center;';
                trHead.append(thCheck, thDelete, thStar, thName, thLatest, thAdded, thActions);
                thead.appendChild(trHead);

                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                channels.forEach(channel => {
                    const tr = document.createElement('tr');
                    const channelUrl = buildChannelUrl(channel.id);
                    const addedDateObj = new Date(channel.addedAt);
                    const addedDate = addedDateObj.toLocaleDateString();
                    const addedTime = addedDateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

                    const tdCheck = document.createElement('td');
                    tdCheck.className = 'checkbox-cell col-check';
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.className = 'channel-checkbox';
                    checkbox.dataset.id = channel.id;
                    tdCheck.appendChild(checkbox);
                    tdCheck.addEventListener('click', () => { checkbox.checked = !checkbox.checked; });

                    const tdStar = document.createElement('td');
                    tdStar.className = 'col-star';
                    const starBtn = makeSingleStarBtn(channel);
                    tdStar.appendChild(starBtn);

                    const tdName = document.createElement('td');
                    tdName.className = 'channel-name';
                    const nameInner = document.createElement('div');
                    nameInner.className = 'channel-name-inner';
                    const iconImg = document.createElement('img');
                    iconImg.src = channel.iconUrl || '';
                    iconImg.className = 'channel-icon';
                    if (!channel.iconUrl) iconImg.style.display = 'none';
                    const nameLink = document.createElement('a');
                    nameLink.href = channelUrl;
                    nameLink.target = '_blank';
                    nameLink.textContent = channel.name;
                    nameInner.append(iconImg, nameLink);
                    tdName.appendChild(nameInner);

                    const tdLatest = document.createElement('td');
                    tdLatest.className = 'latest-video-cell';
                    tdLatest.id = `latest-video-${channel.id}`;
                    tdLatest.dataset.latestId = channel.id; // UCID解決後の検索用
                    // _originalId: 登録時のID（ハンドル名等）を保持してセル検索に使う
                    channel._originalId = channel._originalId || channel.id;
                    tdLatest.dataset.latestId = channel._originalId;
                    tdLatest.textContent = '取得中...';
                    const tdAdded = document.createElement('td');
                    tdAdded.className = 'date-cell col-added';
                    const dateDiv = document.createElement('div'); dateDiv.textContent = addedDate;
                    const timeDiv = document.createElement('div'); timeDiv.className = 'time'; timeDiv.textContent = addedTime;
                    tdAdded.append(dateDiv, timeDiv);

                    const tdDelete = document.createElement('td');
                    tdDelete.className = 'col-delete';
                    tdDelete.style.cssText = 'text-align:center;vertical-align:middle;';
                    const rowDeleteBtn = document.createElement('button');
                    rowDeleteBtn.textContent = '🗑️';
                    rowDeleteBtn.title = i18n('このチャンネルを削除', 'Remove this channel');
                    rowDeleteBtn.className = 'btn-small';
                    rowDeleteBtn.style.cssText = `background:none;border:none;outline:none;box-shadow:none;padding:2px 4px;cursor:pointer;font-size:15px;opacity:0.6;`;
                    rowDeleteBtn.addEventListener('mouseenter', () => { rowDeleteBtn.style.opacity = '1'; });
                    rowDeleteBtn.addEventListener('mouseleave', () => { rowDeleteBtn.style.opacity = '0.6'; });
                    rowDeleteBtn.addEventListener('click', async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const isAllView = currentFolder === ALL_CHANNELS_VIRTUAL;
                        const isDefaultFld = currentFolder === DEFAULT_FOLDER;
                        if (isAllView || isDefaultFld) {
                            const confirmed = await showCustomModal({
                                type: 'confirm', title: i18n('チャンネルの削除', 'Delete Channel'),
                                message: i18n(`「${channel.name}」を完全に削除しますか？`, `Permanently delete "${channel.name}"?`),
                                okText: i18n('完全に削除', 'Delete Permanently')
                            });
                            if (!confirmed) return;
                            Object.keys(data.folders).forEach(fname => {
                                if (Array.isArray(data.folders[fname]))
                                    data.folders[fname] = data.folders[fname].filter(ch => ch.id !== channel.id);
                            });
                        } else {
                            const choice = await showCustomModal({
                                type: 'select',
                                title: i18n('削除方法を選択', 'Select Delete Method'),
                                message: i18n(
                                    `「${channel.name}」をどのように削除しますか？\n「このフォルダから削除」を選ぶと「${DEFAULT_FOLDER}」に移動します。`,
                                    `How do you want to delete "${channel.name}"?\n"Remove from folder" will move it to "${DEFAULT_FOLDER}".`
                                ),
                                buttons: [
                                    { label: i18n('このフォルダから削除', 'Remove from Folder'), value: 'folder-only' },
                                    { label: i18n('完全に削除', 'Delete Permanently'), value: 'complete', danger: true },
                                ]
                            });
                            if (!choice) return;
                            if (choice === 'complete') {
                                Object.keys(data.folders).forEach(fname => {
                                    if (Array.isArray(data.folders[fname]))
                                        data.folders[fname] = data.folders[fname].filter(ch => ch.id !== channel.id);
                                });
                            } else {
                                data.folders[currentFolder] = data.folders[currentFolder].filter(ch => ch.id !== channel.id);
                                if (!Array.isArray(data.folders[DEFAULT_FOLDER])) data.folders[DEFAULT_FOLDER] = [];
                                if (!data.folders[DEFAULT_FOLDER].some(ch => ch.id === channel.id)) {
                                    data.folders[DEFAULT_FOLDER].push(channel);
                                }
                            }
                        }
                        saveChannelData(data);
                        render();
                    });
                    tdDelete.appendChild(rowDeleteBtn);

                    const tdActions = document.createElement('td');
                    tdActions.className = 'actions-cell col-actions';

                    const moveBtn = document.createElement('button');
                    moveBtn.textContent = '📁';
                    moveBtn.title = i18n('このチャンネルを移動', 'Move this channel');
                    moveBtn.className = 'btn-small';
                    moveBtn.style.cssText = `background:none;border:none;outline:none;box-shadow:none;padding:2px 4px;cursor:pointer;font-size:16px;`;
                    moveBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        showMoveModal([channel.id]);
                    });

                    tdActions.append(moveBtn);

                    tr.append(tdCheck, tdDelete, tdStar, tdName, tdLatest, tdAdded, tdActions);

                    tbody.appendChild(tr);
                });

                table.appendChild(tbody);

                const tableScroll = document.createElement('div');
                tableScroll.className = 'table-scroll';
                tableScroll.appendChild(table);
                mainContent.appendChild(tableScroll);

                updateAllLatestVideoInfo(channels);

                // イベントリスナーの設定
                document.getElementById('select-all').addEventListener('change', (e) => {
                    document.querySelectorAll('.channel-checkbox').forEach(chk => {
                        chk.checked = e.target.checked;
                    });
                });

                thead.querySelectorAll('th[data-sort]').forEach(th => {
                    th.addEventListener('click', (e) => {
                        if (e.target.classList.contains('vm-star-lock-btn')) return; // ロックボタンクリックは除外
                        const key = th.dataset.sort;
                        if (sortState.key === key) {
                            sortState.dir *= -1;
                        } else {
                            sortState.key = key;
                            sortState.dir = -1;
                        }
                        renderMainContent();
                    });
                });
            }

            function getCheckedChannelIds() {
                return Array.from(document.querySelectorAll('.channel-checkbox:checked')).map(chk => chk.dataset.id);
            }

            function showMoveModal(channelIds) {
                const overlay = document.createElement('div');
                overlay.className = 'modal-overlay';

                const modal = document.createElement('div');
                modal.className = 'modal-content';

                const h3 = document.createElement('h3');
                h3.textContent = i18n('移動先のフォルダを選択', 'Select Destination Folder');

                // フォルダ一覧コンテナを作成
                const folderListDiv = document.createElement('div');
                folderListDiv.className = 'folder-list-container';
                folderListDiv.style.cssText = `
                max-height: 300px;
                overflow-y: auto;
                border: 1px solid #3a3a3a;
                border-radius: 4px;
                margin: 10px 0;
                padding: 5px;
                background: #1a1a1a;
            `;

                // 移動可能なフォルダのボタンを作成
                data.folderOrder.forEach(folderName => {
                    if (folderName !== currentFolder) {
                        const folderBtn = document.createElement('button');
                        folderBtn.className = 'folder-move-btn';
                        folderBtn.textContent = folderName;
                        folderBtn.style.cssText = `
                        display: block;
                        width: 100%;
                        padding: 10px;
                        margin: 2px 0;
                        background: #2a2a2a;
                        border: 1px solid #3a3a3a;
                        border-radius: 4px;
                        cursor: pointer;
                        text-align: left;
                        color: #f3f3f3;
                        font-size: 13px;
                        transition: background-color 0.2s;
                    `;

                        // ホバー効果
                        folderBtn.addEventListener('mouseenter', () => {
                            folderBtn.style.backgroundColor = '#3a3a3a';
                        });
                        folderBtn.addEventListener('mouseleave', () => {
                            folderBtn.style.backgroundColor = '#2a2a2a';
                        });

                        // クリックで移動実行
                        folderBtn.addEventListener('click', () => {
                            const targetFolder = folderName;
                            if (currentFolder === ALL_CHANNELS_VIRTUAL) {
                                // 仮想フォルダ「すべて」の場合: 各chが実際に属するフォルダから移動
                                const movingChannels = [];
                                for (const chId of channelIds) {
                                    for (const [fName, fList] of Object.entries(data.folders)) {
                                        const idx = fList.findIndex(ch => ch.id === chId);
                                        if (idx !== -1) {
                                            movingChannels.push(...fList.splice(idx, 1));
                                            break;
                                        }
                                    }
                                }
                                data.folders[targetFolder] = [...(data.folders[targetFolder] || []), ...movingChannels];
                            } else {
                                const movingChannels = data.folders[currentFolder].filter(ch => channelIds.includes(ch.id));
                                data.folders[currentFolder] = data.folders[currentFolder].filter(ch => !channelIds.includes(ch.id));
                                data.folders[targetFolder] = [...(data.folders[targetFolder] || []), ...movingChannels];
                            }
                            saveChannelData(data);
                            overlay.remove();
                            render();
                        });

                        folderListDiv.appendChild(folderBtn);
                    }
                });

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'modal-actions';
                const cancelBtn = document.createElement('button');
                cancelBtn.id = 'move-cancel';
                cancelBtn.className = 'btn';
                cancelBtn.textContent = 'キャンセル';
                actionsDiv.appendChild(cancelBtn);

                modal.append(h3, folderListDiv, actionsDiv);
                overlay.appendChild(modal);
                document.body.appendChild(overlay);

                // キャンセルボタンのクリックイベント
                modal.querySelector('#move-cancel').addEventListener('click', () => overlay.remove());

                // オーバーレイクリックで閉じる
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) {
                        overlay.remove();
                    }
                });

                // ESCキーで閉じる
                const handleEscKey = (e) => {
                    if (e.key === 'Escape') {
                        overlay.remove();
                        document.removeEventListener('keydown', handleEscKey);
                    }
                };
                document.addEventListener('keydown', handleEscKey);
            }

            function showCustomModal(options) {
                return new Promise(resolve => {
                    const overlay = document.createElement('div');
                    overlay.className = 'modal-overlay';

                    const modal = document.createElement('div');
                    modal.className = 'modal-content';

                    let inputHtml = '';
                    if (options.type === 'prompt') {
                        inputHtml = `<input type="text" id="modal-input" class="yt-dict-form-input" value="${options.defaultValue || ''}" placeholder="${options.placeholder || ''}">`;
                    }

                    const h3 = document.createElement('h3');
                    h3.textContent = options.title;
                    modal.appendChild(h3);
                    if (options.message) {
                        const p = document.createElement('p');
                        p.textContent = options.message;
                        modal.appendChild(p);
                    }
                    if (inputHtml) {
                        const inputEl = document.createElement('input');
                        inputEl.type = 'text';
                        inputEl.id = 'modal-input';
                        inputEl.className = 'yt-dict-form-input';
                        inputEl.value = options.defaultValue || '';
                        inputEl.placeholder = options.placeholder || '';
                        modal.appendChild(inputEl);
                    }
                    const actionsDiv = document.createElement('div');
                    actionsDiv.className = 'modal-actions';
                    if (options.type === 'select' && Array.isArray(options.buttons)) {
                        // selectタイプ: 複数ボタンを並べて表示し、クリックされたボタンのvalueをresolve
                        const cancelBtn = document.createElement('button');
                        cancelBtn.id = 'modal-cancel'; cancelBtn.className = 'btn';
                        cancelBtn.textContent = options.cancelText || i18n('キャンセル', 'Cancel');
                        actionsDiv.appendChild(cancelBtn);
                        options.buttons.forEach(btnDef => {
                            const b = document.createElement('button');
                            b.className = `btn ${btnDef.danger ? 'btn-danger' : 'btn-primary'}`;
                            b.textContent = btnDef.label;
                            b.addEventListener('click', () => { overlay.remove(); resolve(btnDef.value); });
                            actionsDiv.appendChild(b);
                        });
                        modal.appendChild(actionsDiv);
                        overlay.appendChild(modal);
                        document.body.appendChild(overlay);
                        modal.querySelector('#modal-cancel')?.addEventListener('click', () => { overlay.remove(); resolve(null); });
                        overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
                        return;
                    }
                    if (options.type !== 'alert') {
                        const cancelBtn = document.createElement('button');
                        cancelBtn.id = 'modal-cancel'; cancelBtn.className = 'btn';
                        cancelBtn.textContent = options.cancelText || i18n('キャンセル', 'Cancel');
                        actionsDiv.appendChild(cancelBtn);
                    }
                    const okBtn = document.createElement('button');
                    okBtn.id = 'modal-ok'; okBtn.className = `btn ${options.okClass || 'btn-danger'}`;
                    okBtn.textContent = options.okText || 'OK';
                    actionsDiv.appendChild(okBtn);
                    modal.appendChild(actionsDiv);

                    overlay.appendChild(modal);
                    document.body.appendChild(overlay);

                    // const okBtn = modal.querySelector('#modal-ok'); // 重複宣言のため削除
                    const cancelBtn = modal.querySelector('#modal-cancel');
                    const inputEl = modal.querySelector('#modal-input');

                    const close = (value) => {
                        overlay.remove();
                        resolve(value);
                    };

                    okBtn.addEventListener('click', () => close(options.type === 'prompt' ? inputEl.value : true));
                    cancelBtn?.addEventListener('click', () => close(options.type === 'prompt' ? null : false));
                    overlay.addEventListener('click', (e) => {
                        if (e.target === overlay) close(options.type === 'prompt' ? null : false);
                    });

                    if (inputEl) {
                        inputEl.focus();
                        inputEl.addEventListener('keydown', (e) => {
                            if (e.key === 'Enter') okBtn.click();
                            else if (e.key === 'Escape') cancelBtn?.click();
                        });
                    }
                });
            }

            /**
             * channel.id が UC... 形式でない場合、YouTube API の forHandle パラメータで
             * 正規のUCIDを取得して channel.id を上書きする。
             */
            /**
             * channel.id が UC... 形式でない場合、YouTube API の forHandle パラメータで
             * 正規のUCIDを取得して channel.id を上書きする。
             * ※ この関数は個別呼び出し用。まとめて解決する場合は resolveAllHandles() を使う。
             */
            async function resolveChannelUcId(channel, apiKey) {
                if (/^UC[\w-]{20,}$/.test(channel.id)) return channel.id; // 既にUCID
                // 以前に解決失敗済みならスキップ（quota節約）
                if (channel._ucidResolveFailed) return null;

                const applyUcid = (json) => {
                    const item = json?.items?.[0];
                    if (!item?.id) return null;
                    channel.id = item.id;
                    delete channel._ucidResolveFailed;
                    if (!channel.iconUrl) {
                        const thumbnails = item.snippet?.thumbnails;
                        if (thumbnails) {
                            channel.iconUrl = thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '';
                        }
                    }
                    saveChannelData(data);
                    return item.id;
                };

                const base = `https://www.googleapis.com/youtube/v3/channels?part=snippet&key=${apiKey}`;

                // 1. forHandle で検索（各1ユニット）
                try {
                    const handle = channel.id.replace(/^@/, '').replace(/^(c\/|user\/)/i, '');
                    const res = await fetch(`${base}&forHandle=${encodeURIComponent(handle)}`);
                    const json = await res.json();
                    if (json.error?.code === 403) {
                        markQuotaExceeded();
                        return null;
                    }
                    const ucid = applyUcid(json);
                    if (ucid) return ucid;
                } catch (e) {
                    console.error('forHandle失敗:', channel.id, e);
                }

                // 2. forUsername で検索（旧形式 user/xxx 対応、各1ユニット）
                try {
                    const username = channel.id.replace(/^(c\/|user\/)/i, '').replace(/^@/, '');
                    const res = await fetch(`${base}&forUsername=${encodeURIComponent(username)}`);
                    const json = await res.json();
                    if (json.error?.code === 403) {
                        markQuotaExceeded();
                        return null;
                    }
                    const ucid = applyUcid(json);
                    if (ucid) return ucid;
                } catch (e) {
                    console.error('forUsername失敗:', channel.id, e);
                }

                // 両方失敗 → フラグを立てて次回ロード時の無駄なAPI呼び出しを防ぐ
                channel._ucidResolveFailed = true;
                saveChannelData(data);
                return null;
            }

            /**
             * ハンドル名のチャンネルをまとめてUCID解決する（quota節約版）。
             * forHandle は1件ずつしか使えないため順番に処理するが、
             * 解決済み・失敗済みはスキップして無駄を省く。
             */
            async function resolveAllHandles(channels, apiKey) {
                const needResolve = channels.filter(ch =>
                    !/^UC[\w-]{20,}$/.test(ch.id) && !ch._ucidResolveFailed
                );
                for (const ch of needResolve) {
                    if (isQuotaExceededToday()) break;
                    await resolveChannelUcId(ch, apiKey);
                }
            }

            /**
             * 最新動画を activities API（1ユニット/回）で取得する。
             * search API（100ユニット/回）より99%安い。
             * activities が空の場合のみ search にフォールバックしない（quota節約優先）。
             */
            async function fetchLatestVideo(channelId, apiKey) {
                const url = `https://www.googleapis.com/youtube/v3/activities?part=snippet,contentDetails&channelId=${channelId}&maxResults=5&key=${apiKey}`;
                const res = await fetch(url);
                const json = await res.json();
                if (json.error?.code === 403) return { quotaExceeded: true };

                const item = json.items?.find(i => i.snippet?.type === 'upload' && i.contentDetails?.upload?.videoId);
                if (!item) return { notFound: true };

                return {
                    publishedAt: item.snippet.publishedAt,
                    videoTitle: item.snippet.title,
                    videoId: item.contentDetails.upload.videoId,
                };
            }

            // YouTube APIのquota超過を日付付きで記録するキー（太平洋時間でリセットされるため翌日UTC扱い）
            const QUOTA_EXCEEDED_KEY = 'vm-yt-quota-exceeded-date-v1';

            function isQuotaExceededToday() {
                try {
                    const saved = GM_getValue(QUOTA_EXCEEDED_KEY, '');
                    if (!saved) return false;
                    // 保存日付（YYYY-MM-DD UTC）と今日を比較
                    const today = new Date().toISOString().slice(0, 10);
                    return saved === today;
                } catch (_) { return false; }
            }

            function markQuotaExceeded() {
                try {
                    const today = new Date().toISOString().slice(0, 10);
                    GM_setValue(QUOTA_EXCEEDED_KEY, today);
                } catch (_) { }
            }

            async function updateAllLatestVideoInfo(channels) {
                const apiKey = getYouTubeApiKey();
                if (!apiKey) {
                    channels.forEach(ch => {
                        const cell = document.getElementById(`latest-video-${ch.id}`);
                        if (cell) {
                            const span = document.createElement('span');
                            span.style.color = '#ffc107';
                            span.textContent = 'APIキー未設定';
                            cell.textContent = ''; // Clear previous content
                            cell.appendChild(span);
                        }
                    });
                    return;
                }

                // 本日すでにquota超過済みなら API呼び出しをスキップ、ただし表示だけ更新
                if (isQuotaExceededToday()) {
                    channels.forEach(ch => {
                        const cell = document.querySelector(`[data-latest-id="${ch._originalId || ch.id}"]`)
                            || document.getElementById(`latest-video-${ch.id}`);
                        if (!cell) return;
                        if (ch.latestVideoPublishedAt) {
                            renderLatestVideoCell(cell, ch);
                        } else {
                            const span = document.createElement('span');
                            span.style.color = '#888';
                            span.title = 'YouTube APIのquotaが本日超過しています。明日リセットされます。';
                            span.textContent = i18n('情報なし', 'N/A');
                            cell.textContent = '';
                            cell.appendChild(span);
                        }
                    });
                    return;
                }

                // まず全ハンドル名チャンネルのUCIDをまとめて解決
                await resolveAllHandles(channels, apiKey);

                let quotaExceeded = false;

                for (const channel of channels) {
                    // 動画情報が未取得、または1日以上経過していたら更新
                    const shouldUpdate = !channel.latestVideoPublishedAt
                        || !channel.latestVideoCheckedAt
                        || (Date.now() - channel.latestVideoCheckedAt > 86400000);

                    // セルはIDが変わっている可能性があるので data-id で検索
                    const cell = document.querySelector(`[data-latest-id="${channel._originalId || channel.id}"]`)
                        || document.getElementById(`latest-video-${channel.id}`);

                    if (!cell) continue;

                    if (!shouldUpdate) {
                        // キャッシュ済み：表示だけ更新（「取得中...」を消す）
                        if (channel.latestVideoPublishedAt) {
                            renderLatestVideoCell(cell, channel);
                        } else {
                            cell.textContent = i18n('情報なし', 'N/A');
                        }
                        continue;
                    }

                    if (shouldUpdate) {
                        if (quotaExceeded || isQuotaExceededToday()) {
                            if (!channel.latestVideoPublishedAt) cell.textContent = i18n('情報なし', 'N/A');
                            else renderLatestVideoCell(cell, channel);
                            continue;
                        }
                        // UCIDに解決できなかった場合はスキップ
                        if (!/^UC[\w-]{20,}$/.test(channel.id)) {
                            cell.textContent = channel._ucidResolveFailed ? i18n('ID不明', 'ID unknown') : i18n('情報なし', 'N/A');
                            continue;
                        }
                        try {
                            // activities API（1ユニット/回）で取得
                            const result = await fetchLatestVideo(channel.id, apiKey);
                            if (result.quotaExceeded) {
                                quotaExceeded = true;
                                markQuotaExceeded();
                                if (!channel.latestVideoPublishedAt) cell.textContent = i18n('情報なし', 'N/A');        else renderLatestVideoCell(cell, channel);
                                continue;
                            }
                            if (!result.notFound && result.videoId) {
                                channel.latestVideoPublishedAt = result.publishedAt;
                                channel.latestVideoTitle = result.videoTitle;
                                channel.latestVideoId = result.videoId;
                            }
                            channel.latestVideoCheckedAt = Date.now();
                        } catch (error) {
                            console.error(`[${channel.name}] の最新動画取得に失敗:`, error);
                            cell.textContent = '取得失敗';
                        }
                    }

                    if (cell && channel.latestVideoPublishedAt) {
                        renderLatestVideoCell(cell, channel);
                    } else if (cell && !cell.textContent.includes('失敗') && !cell.textContent.includes('不明')) {
                        cell.textContent = i18n('情報なし', 'N/A');
                    }
                }
                saveChannelData(data); // 更新した情報を保存
            }

            function renderLatestVideoCell(cell, channel) {
                if (!channel.latestVideoPublishedAt) return;
                const date = new Date(channel.latestVideoPublishedAt).toLocaleDateString();
                const videoUrl = `https://www.youtube.com/watch?v=${channel.latestVideoId}`;
                const thumbnailUrl = `https://i.ytimg.com/vi/${channel.latestVideoId}/mqdefault.jpg`;
                while (cell.firstChild) cell.removeChild(cell.firstChild);

                // ラッパー（+ボタン + コンテンツ）
                const cellInner = document.createElement('div');
                cellInner.className = 'vm-latest-cell-inner';

                // +ボタン
                const addBtn = document.createElement('button');
                addBtn.className = 'vm-add-to-mylist-btn';
                addBtn.textContent = '➕';
                addBtn.title = i18n('マイリストに追加', 'Add to My List');
                addBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const mode = localStorage.getItem(ADD_BTN_MODE_KEY) || 'instant';
                    if (mode === 'select') {
                        showAddToMylistModal(channel);
                    } else {
                        addToMylistInstant(channel);
                    }
                });

                const content = document.createElement('div');
                content.className = 'vm-latest-cell-content';

                const link = document.createElement('a');
                link.href = videoUrl;
                link.target = '_blank';
                const img = document.createElement('img');
                img.className = 'list-thumbnail';
                img.src = thumbnailUrl;
                link.appendChild(img);
                content.appendChild(link);
                const dateDiv = document.createElement('div');
                dateDiv.textContent = date;
                const titleLink = document.createElement('a');
                titleLink.href = videoUrl; titleLink.target = '_blank'; titleLink.className = 'video-title';
                titleLink.title = channel.latestVideoTitle; titleLink.textContent = channel.latestVideoTitle;
                content.append(dateDiv, titleLink);

                cellInner.appendChild(addBtn);
                cellInner.appendChild(content);
                cell.appendChild(cellInner);
            }

            async function backfillMissingIcons(channels) {
                const apiKey = getYouTubeApiKey();
                if (!apiKey || isQuotaExceededToday()) return;

                // アイコン未取得 かつ UCIDのものを一括取得
                // (ハンドル名は resolveChannelUcId で既に解決済みのはず)
                const channelsToUpdate = channels.filter(ch => !ch.iconUrl && /^UC[\w-]{20,}$/.test(ch.id));
                if (channelsToUpdate.length === 0) return;

                // YouTube APIは一度に50件までIDを指定できる
                const chunkSize = 50;
                for (let i = 0; i < channelsToUpdate.length; i += chunkSize) {
                    const chunk = channelsToUpdate.slice(i, i + chunkSize);
                    const channelIds = chunk.map(ch => ch.id).join(',');

                    try {
                        const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelIds}&key=${apiKey}`;
                        const response = await fetch(url);
                        const json = await response.json();
                        if (json.error?.code === 403) {
                            markQuotaExceeded();
                            break;
                        }
                        if (json.items) {
                            json.items.forEach(item => {
                                const channel = data.folders[currentFolder].find(ch => ch.id === item.id);
                                if (channel && item.snippet?.thumbnails) {
                                    const thumbnails = item.snippet.thumbnails;
                                    channel.iconUrl = thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || '';

                                    // 画面上のアイコンも即時更新
                                    const imgElement = document.querySelector(`img[alt="${channel.name}"], .channel-name img[src=""]`);
                                    if (imgElement && channel.iconUrl) {
                                        imgElement.src = channel.iconUrl;
                                    }
                                }
                            });
                        }
                    } catch (error) {
                        console.error('アイコンの一括取得に失敗:', error);
                    }
                }
                saveChannelData(data); // 更新した情報を保存
            }

            render();

            // 右上固定の設定ボタンを追加（デスクトップのみ・iframeでは非表示）
            if (!isMobileLike() && window.self === window.top) {
                const existingSettingsTopBtn = document.getElementById('vm-cl-settings-top-btn');
                if (existingSettingsTopBtn) existingSettingsTopBtn.remove();
                const settingsTopBtn = document.createElement('button');
                settingsTopBtn.id = 'vm-cl-settings-top-btn';
                settingsTopBtn.textContent = '⚙ 設定';
                Object.assign(settingsTopBtn.style, {
                    position: 'fixed', top: '10px', right: '16px', zIndex: '10001',
                    background: '#444', color: 'white', border: '1px solid #666',
                    padding: '4px 10px', borderRadius: '14px', cursor: 'pointer',
                    fontSize: '12px', lineHeight: '1.2'
                });
                settingsTopBtn.addEventListener('click', () => {
                    // content.js が一緒に読み込まれている場合はマイリストの統合設定パネルを開く
                    if (typeof window.showSettingsPanel === 'function') {
                        window.showSettingsPanel('channellist');
                    } else if (openSettingsModalRef) {
                        openSettingsModalRef();
                    }
                });
                document.body.appendChild(settingsTopBtn);

                // テーマトグルボタン (💡/🔆)
                const existingThemeBtnCL = document.getElementById('vm-cl-theme-btn');
                if (existingThemeBtnCL) existingThemeBtnCL.remove();
                const themeBtnCL = document.createElement('button');
                themeBtnCL.id = 'vm-cl-theme-btn';
                const _currentThemeCL = () => { try { return GM_getValue('vm-theme-v1', 'dark') || 'dark'; } catch (_) { return 'dark'; } };
                themeBtnCL.textContent = _currentThemeCL() === 'light' ? '🔆' : '💡';
                themeBtnCL.title = 'ライト/ダークモード切替';
                Object.assign(themeBtnCL.style, {
                    position: 'fixed', top: '10px', right: '90px', zIndex: '10001',
                    background: '#444', color: 'white', border: '1px solid #666',
                    padding: '4px 8px', borderRadius: '14px', cursor: 'pointer',
                    fontSize: '14px', lineHeight: '1.2'
                });
                themeBtnCL.addEventListener('click', () => {
                    if (typeof window.vmTheme === 'object' && window.vmTheme.toggle) {
                        window.vmTheme.toggle();
                    } else {
                        try {
                            const next = _currentThemeCL() === 'light' ? 'dark' : 'light';
                            GM_setValue('vm-theme-v1', next);
                            if (next === 'light') document.documentElement.classList.add('vm-light');
                            else document.documentElement.classList.remove('vm-light');
                            themeBtnCL.textContent = next === 'light' ? '🔆' : '💡';
                        } catch (_) {}
                    }
                });
                document.body.appendChild(themeBtnCL);
            }
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
                chrome.storage.onChanged.addListener((changes, areaName) => {
                    if (areaName !== 'local') return;
                    if (!Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) return;
                    setTimeout(reloadData, 200);
                });
            }

            // 初回読み込み時に、アイコンがないチャンネルの情報を取得
            setTimeout(() => {
                backfillMissingIcons(data.folders[currentFolder] || []);
            }, 1000);
        }

        function createButtonsContainer(addFunction) {
            const container = document.createElement('div');
            container.id = 'custom-channel-list-buttons';
            container.style.marginRight = '8px'; // 右側のボタンとの間隔

            const addButton = document.createElement('button');
            addButton.textContent = i18n('このチャンネルを登録', 'Register this channel');
            Object.assign(addButton.style, {
                background: '#c00', color: 'white', border: 'none', borderRadius: '18px',
                padding: '8px 16px', marginRight: '8px', cursor: 'pointer', fontWeight: '500'
            });
            addButton.addEventListener('click', addFunction);

            const openButton = document.createElement('button');
            openButton.textContent = i18n('一覧を開く', 'Open List');
            Object.assign(openButton.style, {
                background: '#333', color: 'white', border: '1px solid #555', borderRadius: '18px',
                padding: '8px 16px', cursor: 'pointer', fontWeight: '500'
            });
            openButton.addEventListener('click', () => { location.href = CUSTOM_LIST_PAGE_URL; });

            const openMylistButton = document.createElement('button');
            openMylistButton.textContent = i18n('マイリストを開く', 'Open My List');
            Object.assign(openMylistButton.style, {
                background: '#333', color: 'white', border: '1px solid #555', borderRadius: '18px',
                padding: '8px 16px', cursor: 'pointer', fontWeight: '500'
            });
            openMylistButton.addEventListener('click', () => {
                window.open(MYLIST_PAGE_URL, 'youtube_mylist_page');
            });

            container.appendChild(addButton);
            container.appendChild(openButton);
            container.appendChild(openMylistButton);
            return container;
        }

        /* ---------------------------
            メイン処理の分岐
        --------------------------- */
        function isChannelPagePath(p) {
            return p.startsWith('/channel/') || p.startsWith('/@') || p.startsWith('/c/') || p.startsWith('/user/');
        }

        const path = location.pathname;
        if (path.startsWith('/watch')) {
            // 動画視聴ページ
            initWatchPage();
        } else if (isChannelPagePath(path)) {
            // チャンネルページ
            const handleNav = () => setTimeout(() => {
                if (isChannelPagePath(location.pathname)) {
                    insertButtonsOnChannelPage();
                }
            }, 1000);
            document.addEventListener('yt-navigate-finish', handleNav);
            handleNav(); // 初期読み込み

        } else if (isCustomListPagePath(path)) {
            // 一覧ページ
            renderListPage();
        }
    })();

});
