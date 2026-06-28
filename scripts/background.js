/**
 * background.js (Service Worker)
 * Manifest V3 用バックグラウンドスクリプト
 *
 * 担当:
 *   - GM_openInTab   : chrome.tabs.create でタブを開く
 *   - GM_xmlhttpRequest : fetch を使ってクロスオリジンリクエストを代行（CORS回避）
 *   - GM_notification : chrome.notifications で通知を表示
 */

'use strict';

const FIREBASE_CONFIG = {}; // Firebaseは廃止済み
const POLAR_ORGANIZATION_ID = '52bbedc6-4576-4712-a8c3-e85354ce08b1';
const POLAR_API_BASE_URL = 'https://api.polar.sh';
const POLAR_SANDBOX_API_BASE_URL = 'https://sandbox-api.polar.sh';

function storageGetLocal(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => resolve(result ? result[key] : null));
  });
}

function storageSetLocal(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'storage set failed'));
        return;
      }
      resolve();
    });
  });
}

// ============================================================
// Google Drive appdata 同期
// ============================================================
const GDRIVE_AUTH_STATE_KEY = 'vm_gdrive_auth_state_v1';
const GDRIVE_BACKUP_CONFIG_KEY = 'vm_gdrive_backup_config_v1';
const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  if (!response.ok) {
    const msg = parsed && parsed.error && parsed.error.message
      ? parsed.error.message
      : text || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return parsed;
}

/** drive.appdata スコープのみで、認証アカウントのメールを Drive about.get から取得 */
async function fetchGdriveUserEmail(accessToken) {
  try {
    const about = await fetchJson(
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)',
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return about && about.user && about.user.emailAddress
      ? String(about.user.emailAddress).trim()
      : '';
  } catch (_) {
    return '';
  }
}

async function postJsonWithMeta(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
  return { ok: response.ok, status: response.status, parsed, text };
}

function resolvePolarConfig(message) {
  const envRaw = String((message && message.polarEnv) || 'production').trim().toLowerCase();
  const env = envRaw === 'sandbox' ? 'sandbox' : 'production';
  const organizationId = String((message && message.organizationId) || POLAR_ORGANIZATION_ID).trim() || POLAR_ORGANIZATION_ID;
  const baseUrl = env === 'sandbox' ? POLAR_SANDBOX_API_BASE_URL : POLAR_API_BASE_URL;
  return {
    env,
    organizationId,
    validateUrl: `${baseUrl}/v1/customer-portal/license-keys/validate`,
    activateUrl: `${baseUrl}/v1/customer-portal/license-keys/activate`,
    deactivateUrl: `${baseUrl}/v1/customer-portal/license-keys/deactivate`
  };
}

function extractPolarErrorMessage(result) {
  if (!result) return 'Unknown Polar API error';
  const parsed = result.parsed;
  if (Array.isArray(parsed && parsed.detail)) {
    return parsed.detail.map((item) => item && item.msg ? item.msg : JSON.stringify(item)).join(', ');
  }
  if (parsed && typeof parsed.detail === 'string' && parsed.detail) return parsed.detail;
  if (parsed && typeof parsed.error === 'string' && parsed.error) return parsed.error;
  return result.text || `HTTP ${result.status}`;
}

function buildLicenseValidationResponse(payload, activationId) {
  const valid = !!(payload && payload.status === 'granted');
  return {
    valid,
    plan: valid ? 'premium' : 'free',
    activationId: activationId || (payload && payload.activation && payload.activation.id) || null,
    status: payload && payload.status ? String(payload.status) : null
  };
}

function getActivationFromPayload(payload) {
  return payload && payload.activation && typeof payload.activation === 'object'
    ? payload.activation
    : null;
}

async function validatePolarLicenseKey(key, activationId, polarConfig) {
  const body = {
    key,
    organization_id: polarConfig.organizationId
  };
  if (activationId) body.activation_id = activationId;
  return postJsonWithMeta(polarConfig.validateUrl, body);
}

async function activatePolarLicenseKey(key, label, polarConfig) {
  return postJsonWithMeta(polarConfig.activateUrl, {
    key,
    organization_id: polarConfig.organizationId,
    label: label || 'TubeLog'
  });
}

async function deactivatePolarLicenseKey(key, activationId, polarConfig) {
  return postJsonWithMeta(polarConfig.deactivateUrl, {
    key,
    organization_id: polarConfig.organizationId,
    activation_id: activationId
  });
}

async function getGdriveAuthState() {
  const state = await storageGetLocal(GDRIVE_AUTH_STATE_KEY);
  return state && typeof state === 'object' ? state : null;
}
async function setGdriveAuthState(state) {
  await storageSetLocal(GDRIVE_AUTH_STATE_KEY, state || {});
}

/** manifest.json の oauth2.client_id を正とする（#7: 実装と宣言の一本化） */
function getGdriveOAuthClientId() {
  const oauth2 = chrome.runtime.getManifest().oauth2;
  const id = oauth2 && oauth2.client_id ? String(oauth2.client_id).trim() : '';
  if (!id) throw new Error('manifest oauth2.client_id is not configured');
  return id;
}

/** Edge は getAuthToken / removeCachedAuthToken を宣言するが実行時に未対応 */
function isEdgeBrowser() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /\bEdg\//.test(ua);
}

function isChromeIdentityGetAuthTokenSupported() {
  return !!(chrome.identity && typeof chrome.identity.getAuthToken === 'function' && !isEdgeBrowser());
}

function isChromeIdentityRemoveCachedAuthTokenSupported() {
  return !!(chrome.identity && typeof chrome.identity.removeCachedAuthToken === 'function' && !isEdgeBrowser());
}

/** chrome.identity.getAuthToken() でアクセストークンを取得（Chrome のみ。Edge は launchWebAuthFlow） */
function getChromeIdentityToken(interactive) {
  return new Promise((resolve, reject) => {
    if (!isChromeIdentityGetAuthTokenSupported()) {
      if (!interactive) { resolve(null); return; }
      reject(new Error('chrome.identity.getAuthToken が利用できません'));
      return;
    }
    chrome.identity.getAuthToken({ interactive: !!interactive }, (token) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message || '認証失敗';
        if (!interactive) { resolve(null); return; }
        reject(new Error(msg));
        return;
      }
      if (!token) {
        if (!interactive) { resolve(null); return; }
        reject(new Error('トークン取得失敗'));
        return;
      }
      // getAuthToken はトークンの有効期限を返さないため 3500 秒で近似
      resolve({ token, expiresAt: Date.now() + 3500 * 1000 });
    });
  });
}

/** launchWebAuthFlow でアクセストークンを取得（非Chromiumブラウザ向けフォールバック） */
async function launchGdriveAuthFlow(interactive) {
  // launchWebAuthFlow にはウェブアプリケーションタイプのクライアントIDが必要
  // （Chrome拡張機能タイプの client_id は getAuthToken 専用）
  const WEB_CLIENT_ID = '443994081592-oqgl39ust46c9hhbmuhj8g2hjrvg5gep.apps.googleusercontent.com';
  // リダイレクトURIは固定値（Google Cloud Console の承認済みURIと一致させる）
  const redirectUri = 'https://medkhkpnmgfnkkdfoiafgnlhipncaajh.chromiumapp.org/';
  const params = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GDRIVE_SCOPE,
    prompt: interactive ? 'select_account' : 'none'
  });
  const authUrl = 'https://accounts.google.com/o/oauth2/auth?' + params.toString();
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive }, (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        if (!interactive) { resolve(null); return; }
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : '認証がキャンセルされました'));
        return;
      }
      try {
        const hash = new URL(responseUrl).hash.slice(1);
        const p = new URLSearchParams(hash);
        const token = p.get('access_token');
        const expiresIn = parseInt(p.get('expires_in') || '3500', 10);
        if (!token) {
          if (!interactive) { resolve(null); return; }
          reject(new Error('認証がキャンセルされました'));
          return;
        }
        resolve({ token, expiresAt: Date.now() + expiresIn * 1000 });
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** アクセストークンを取得（getAuthToken でサイレント再取得、失敗なら例外） */
async function ensureGdriveAccessToken() {
  const state = await getGdriveAuthState();
  // 一度もログインしていない（loggedInAt がない）場合はサイレント取得を試みない
  if (!state || !state.loggedInAt) {
    throw new Error('Googleドライブの認証が必要です。再度ログインしてください。');
  }
  const now = Date.now();
  // 残り60秒以上あれば再利用
  if (state.accessToken && state.expiresAt && (state.expiresAt - now) > 60000) {
    return state.accessToken;
  }
  // chrome.identity.getAuthToken でサイレント再取得（EdgeはgetAuthToken非対応のためlaunchWebAuthFlowへフォールバック）
  let result = await getChromeIdentityToken(false);
  if (!result || !result.token) {
    result = await launchGdriveAuthFlow(false).catch(() => null);
  }
  if (!result || !result.token) throw new Error('Googleドライブの認証が必要です。再度ログインしてください。');
  const next = Object.assign({}, state, { accessToken: result.token, expiresAt: result.expiresAt });
  await setGdriveAuthState(next);
  return result.token;
}

let __gdriveLoginHandlerInFlight = null;

async function handleGdriveAuthLogin() {
  // 同時に複数の GDRIVE_AUTH_LOGIN が来ても1回だけ呼ぶ
  if (__gdriveLoginHandlerInFlight) return __gdriveLoginHandlerInFlight;
  __gdriveLoginHandlerInFlight = (async () => {
    // launchWebAuthFlow を優先（prompt: 'select_account' で毎回アカウント選択UIを表示）
    // ユーザーがウィンドウを閉じた場合は getAuthToken にフォールバックしない
    // （getAuthToken は Chrome プロファイルの既定アカウントでサイレントログインしてしまう）
    const result = await launchGdriveAuthFlow(true);
    if (!result || !result.token) throw new Error('トークン取得失敗');
    const token = result.token;
    // ログイン表示用: email スコープは不要。Drive about.get で認証アカウントのメールを取得
    const email = await fetchGdriveUserEmail(token);
    const displayName = email || 'Googleアカウント';
    const state = {
      accessToken: token,
      expiresAt: result.expiresAt,
      email,
      displayName,
      loggedInAt: new Date().toISOString()
    };
    await setGdriveAuthState(state);
    return { loggedIn: true, user: { email: state.email, displayName: state.displayName } };
  })().finally(() => { __gdriveLoginHandlerInFlight = null; });
  return __gdriveLoginHandlerInFlight;
}

async function handleGdriveAuthStatus() {
  const state = await getGdriveAuthState();
  // loggedInAt が存在することをログイン済みの根拠にする（email が空でも可）
  if (!state || !state.loggedInAt) return { loggedIn: false, user: null };
  // 期限内ならログイン済みとみなす
  const now = Date.now();
  if (state.accessToken && state.expiresAt && (state.expiresAt - now) > 0) {
    let email = state.email || '';
    let displayName = state.displayName || email || 'Googleアカウント';
    // 旧ログイン状態（email 未保存）を about.get で補完
    if (!email && state.accessToken) {
      email = await fetchGdriveUserEmail(state.accessToken);
      if (email) {
        displayName = email;
        await setGdriveAuthState(Object.assign({}, state, { email, displayName }));
      }
    }
    return { loggedIn: true, user: { email, displayName } };
  }
  return { loggedIn: false, user: null };
}

async function handleGdriveAuthLogout() {
  const state = await getGdriveAuthState();
  const token = state && state.accessToken ? String(state.accessToken) : '';
  if (token && isChromeIdentityRemoveCachedAuthTokenSupported()) {
    await new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }
  await setGdriveAuthState({});
  return { loggedIn: false };
}

/** Drive appdata にファイルをアップロード（multipart/form-data） */
async function gdriveUploadFile(accessToken, fileName, jsonString) {
  const metadata = JSON.stringify({ name: fileName, parents: ['appDataFolder'] });
  const boundary = '-------vmdrive_boundary_' + Date.now();
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    metadata,
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    jsonString,
    `--${boundary}--`
  ].join('\r\n');

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime,size', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Drive upload failed: ${text}`);
  return JSON.parse(text);
}

/** Drive appdata のファイル一覧を取得（名前でフィルタ可能） */
async function gdriveListFiles(accessToken, namePrefix) {
  const q = namePrefix
    ? encodeURIComponent(`name contains '${namePrefix}' and trashed = false`)
    : encodeURIComponent('trashed = false');
  const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,createdTime,size)&orderBy=createdTime+desc&q=${q}&pageSize=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Drive list failed: ${text}`);
  return JSON.parse(text).files || [];
}

/** Drive appdata のファイルの中身を取得 */
async function gdriveDownloadFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) throw new Error(`Drive download failed: HTTP ${res.status}`);
  return res.text();
}

/** Drive appdata のファイルを削除 */
async function gdriveDeleteFile(accessToken, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed: HTTP ${res.status}`);
}

const GDRIVE_BACKUP_PREFIX = 'ytvp_backup_';
const GDRIVE_META_FILE = 'ytvp_backup_meta.json';

/** バックアップ設定を取得 */
async function getGdriveBackupConfig() {
  const cfg = await storageGetLocal(GDRIVE_BACKUP_CONFIG_KEY);
  if (!cfg || typeof cfg !== 'object') return { mode: 'count', count: 30, days: 10, autoBackup: true };
  return {
    mode: cfg.mode === 'days' ? 'days' : 'count',
    count: Math.max(1, Math.min(500, parseInt(String(cfg.count || '30'), 10) || 30)),
    days: Math.max(1, Math.min(365, parseInt(String(cfg.days || '10'), 10) || 10)),
    autoBackup: cfg.autoBackup !== false
  };
}

/**
 * バックアップをプッシュする
 * - 前回と内容が同一なら保存しない（ハッシュ比較）
 * - 保持設定を超えた古いファイルを削除
 */
async function handleGdriveBackupPush(message) {
  const payload = message && message.data;
  if (!payload || typeof payload !== 'object') throw new Error('バックアップデータが不正です');

  const accessToken = await ensureGdriveAccessToken();
  const jsonString = JSON.stringify(payload);

  // ハッシュ計算（FNV-1a 32bit、全文走査で確実な差分検出）
  function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  const hashStr = String(jsonString.length) + ':' + fnv1a32(jsonString);

  // メタファイルを取得して前回ハッシュと比較
  let metaFiles = await gdriveListFiles(accessToken, GDRIVE_META_FILE.replace('.json', ''));
  let lastHash = '';
  if (metaFiles.length > 0) {
    try {
      const metaText = await gdriveDownloadFile(accessToken, metaFiles[0].id);
      const meta = JSON.parse(metaText);
      lastHash = meta.lastHash || '';
    } catch (_) { /* noop */ }
  }
  if (hashStr === lastHash) {
    return { ok: true, skipped: true, reason: 'no_change' };
  }

  // バックアップファイルをアップロード
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = (message && message.label) ? String(message.label) : '';
  const fileName = `${GDRIVE_BACKUP_PREFIX}${timestamp}${label ? '_' + label.replace(/[^a-zA-Z0-9_-]/g, '') : ''}.json`;
  const uploaded = await gdriveUploadFile(accessToken, fileName, jsonString);

  // メタファイルを更新（古いメタファイルを削除してから新規作成）
  for (const mf of metaFiles) {
    await gdriveDeleteFile(accessToken, mf.id).catch(() => { });
  }
  await gdriveUploadFile(accessToken, GDRIVE_META_FILE, JSON.stringify({ lastHash: hashStr, lastBackupAt: new Date().toISOString() }));

  // 古いバックアップを保持設定に従って削除
  const cfg = await getGdriveBackupConfig();
  const allBackups = await gdriveListFiles(accessToken, GDRIVE_BACKUP_PREFIX);
  // createdTime 降順（新しい順）
  allBackups.sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));

  const now = Date.now();
  for (let i = 0; i < allBackups.length; i++) {
    const f = allBackups[i];
    let shouldDelete = false;
    if (cfg.mode === 'count') {
      // 新しいものから count 件以内は保持
      if (i >= cfg.count) shouldDelete = true;
    } else {
      // days 日以内のものは保持
      const createdMs = f.createdTime ? new Date(f.createdTime).getTime() : 0;
      if (createdMs && (now - createdMs) > cfg.days * 24 * 60 * 60 * 1000) shouldDelete = true;
    }
    if (shouldDelete) {
      await gdriveDeleteFile(accessToken, f.id).catch(() => { });
    }
  }

  return { ok: true, skipped: false, fileId: uploaded.id, fileName, timestamp };
}

/** バックアップ一覧を返す */
async function handleGdriveBackupList() {
  const accessToken = await ensureGdriveAccessToken();
  const files = await gdriveListFiles(accessToken, GDRIVE_BACKUP_PREFIX);
  files.sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));
  return { ok: true, files: files.map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime, size: f.size })) };
}

/** 指定したバックアップを取得して返す（復元用） */
async function handleGdriveBackupPull(message) {
  const fileId = message && message.fileId;
  if (!fileId) {
    // fileId 未指定なら最新を返す
    const accessToken = await ensureGdriveAccessToken();
    const files = await gdriveListFiles(accessToken, GDRIVE_BACKUP_PREFIX);
    if (!files.length) return { ok: true, found: false, data: null };
    files.sort((a, b) => (b.createdTime || '').localeCompare(a.createdTime || ''));
    const text = await gdriveDownloadFile(accessToken, files[0].id);
    const data = JSON.parse(text);
    return { ok: true, found: true, data, fileName: files[0].name, createdTime: files[0].createdTime };
  }
  const accessToken = await ensureGdriveAccessToken();
  const text = await gdriveDownloadFile(accessToken, fileId);
  const data = JSON.parse(text);
  return { ok: true, found: true, data };
}

/** バックアップ設定を保存 */
async function handleGdriveBackupConfigSave(message) {
  const cfg = message && message.config;
  if (!cfg || typeof cfg !== 'object') throw new Error('設定が不正です');
  await storageSetLocal(GDRIVE_BACKUP_CONFIG_KEY, {
    mode: cfg.mode === 'days' ? 'days' : 'count',
    count: Math.max(1, Math.min(500, parseInt(String(cfg.count || '30'), 10) || 30)),
    days: Math.max(1, Math.min(365, parseInt(String(cfg.days || '10'), 10) || 10)),
    autoBackup: cfg.autoBackup !== false
  });
  return { ok: true };
}

/** バックアップ設定を取得して返す */
async function handleGdriveBackupConfigGet() {
  const cfg = await getGdriveBackupConfig();
  return { ok: true, config: cfg };
}

// ============================================================
// メッセージハンドラ
// ============================================================
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  const type = message && typeof message === 'object' ? message.type : '';
  const respondAsync = (promiseFactory) => {
    Promise.resolve()
      .then(() => promiseFactory())
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error && error.message ? error.message : error) }));
    return true;
  };

  try {

  // ----------------------------------------------------------
  // GM_openInTab
  // ----------------------------------------------------------
  if (type === 'GM_openInTab') {
    chrome.tabs.create({
      url: message.url,
      active: message.active !== false
    });
    return false;
  }

  // ----------------------------------------------------------
  // GM_xmlhttpRequest
  // ----------------------------------------------------------
  if (type === 'GM_xmlhttpRequest') {
    handleXHR(message, sender);
    return false; // sendResponseは使わず、別メッセージで返す
  }

  // ----------------------------------------------------------
  // GM_xmlhttpRequest_abort (現状ではfetchのAbortは省略)
  // ----------------------------------------------------------
  if (type === 'GM_xmlhttpRequest_abort') {
    // AbortControllerによるキャンセル（将来の実装用）
    return false;
  }

  // ----------------------------------------------------------
  // GM_notification
  // ----------------------------------------------------------
  if (type === 'GM_notification') {
    const notifId = 'yt-mylist-' + Date.now();
    chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: message.title || 'TubeLog',
      message: message.text || ''
    });
    return false;
  }

  if (type === 'GDRIVE_AUTH_LOGIN') {
    return respondAsync(() => handleGdriveAuthLogin());
  }
  if (type === 'GDRIVE_AUTH_STATUS') {
    return respondAsync(() => handleGdriveAuthStatus());
  }
  if (type === 'GDRIVE_AUTH_LOGOUT') {
    return respondAsync(() => handleGdriveAuthLogout());
  }
  if (type === 'GDRIVE_BACKUP_PUSH') {
    return respondAsync(() => handleGdriveBackupPush(message));
  }
  if (type === 'GDRIVE_BACKUP_LIST') {
    return respondAsync(() => handleGdriveBackupList());
  }
  if (type === 'GDRIVE_BACKUP_PULL') {
    return respondAsync(() => handleGdriveBackupPull(message));
  }
  if (type === 'GDRIVE_BACKUP_CONFIG_SAVE') {
    return respondAsync(() => handleGdriveBackupConfigSave(message));
  }
  if (type === 'GDRIVE_BACKUP_CONFIG_GET') {
    return respondAsync(() => handleGdriveBackupConfigGet());
  }

  // ----------------------------------------------------------
  // LICENSE_VALIDATE  (Polar license key validate/activate)
  // ----------------------------------------------------------
  if (type === 'LICENSE_VALIDATE') {
    return respondAsync(async () => {
      const key = String(message.key || message.email || '').trim();
      const activationId = String(message.activationId || '').trim();
      const deviceLabel = String(message.deviceLabel || '').trim() || 'TubeLog';
      const polarConfig = resolvePolarConfig(message || {});
      if (!key) throw new Error('No license key provided');

      if (!activationId) {
        const existingValidateResult = await validatePolarLicenseKey(key, '', polarConfig);
        if (existingValidateResult.ok) {
          const activation = getActivationFromPayload(existingValidateResult.parsed);
          const existingActivationId = activation && activation.id ? String(activation.id) : '';
          const existingActivationLabel = activation && activation.label ? String(activation.label) : '';
          if (existingActivationId && existingActivationLabel && existingActivationLabel === deviceLabel) {
            return buildLicenseValidationResponse(existingValidateResult.parsed, existingActivationId);
          }
          // ラベル不一致でも即ブロックしない。limit>1 なら activate で2台目を確保できる。
          // limit=1 なら activate が 403 となり、その時点で無効扱いにする。
          // アクティベーション情報なし → このデバイスのアクティベーションを試みる。
          // 制限に達していれば activatePolarLicenseKey が 403 を返し、無効扱いになる。
        } else if ([404, 422].includes(existingValidateResult.status)) {
          return {
            valid: false,
            plan: 'free',
            activationId: null,
            reason: extractPolarErrorMessage(existingValidateResult)
          };
        } else if (![403].includes(existingValidateResult.status)) {
          throw new Error(extractPolarErrorMessage(existingValidateResult));
        }

        const activateResult = await activatePolarLicenseKey(key, deviceLabel, polarConfig);
        if (activateResult.ok) {
          const newActivationId = activateResult.parsed && activateResult.parsed.id
            ? String(activateResult.parsed.id)
            : '';
          const validateResult = await validatePolarLicenseKey(key, newActivationId, polarConfig);
          if (validateResult.ok) {
            return buildLicenseValidationResponse(validateResult.parsed, newActivationId);
          }
          if ([403, 404, 422].includes(validateResult.status)) {
            return {
              valid: false,
              plan: 'free',
              activationId: newActivationId || null,
              reason: extractPolarErrorMessage(validateResult)
            };
          }
          throw new Error(extractPolarErrorMessage(validateResult));
        }

        if ([403, 404, 422].includes(activateResult.status)) {
          return {
            valid: false,
            plan: 'free',
            activationId: null,
            reason: extractPolarErrorMessage(activateResult)
          };
        }

        throw new Error(extractPolarErrorMessage(activateResult));
      }

      const validateResult = await validatePolarLicenseKey(key, activationId, polarConfig);
      if (validateResult.ok) {
        return buildLicenseValidationResponse(validateResult.parsed, activationId);
      }

      if ([403, 404, 422].includes(validateResult.status)) {
        return {
          valid: false,
          plan: 'free',
          activationId: activationId || null,
          reason: extractPolarErrorMessage(validateResult)
        };
      }

      throw new Error(extractPolarErrorMessage(validateResult));
    });
  }

  // LICENSE_DEACTIVATE アクティベーション解除
  // ----------------------------------------------------------
  if (type === 'LICENSE_DEACTIVATE') {
    return respondAsync(async () => {
      const key = String(message.key || '').trim();
      const activationId = String(message.activationId || '').trim();
      const polarConfig = resolvePolarConfig(message || {});
      if (!key) throw new Error('No license key provided');
      if (!activationId) throw new Error('No activation ID provided');

      const result = await deactivatePolarLicenseKey(key, activationId, polarConfig);
      if (result.ok) {
        return { success: true };
      }
      if ([403, 404, 422].includes(result.status)) {
        return { success: false, reason: extractPolarErrorMessage(result) };
      }
      throw new Error(extractPolarErrorMessage(result));
    });
  }

  } catch (error) {
    try {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      return true;
    } catch (_) {
      return false;
    }
  }

  return false;
});

// ============================================================
// GM_xmlhttpRequest の実際の処理
// ============================================================
async function handleXHR(message, sender) {
  const tabId = sender && sender.tab && sender.tab.id;

  try {
    const init = {
      method: message.method || 'GET',
      headers: message.headers || {}
    };

    if (message.data && message.method !== 'GET' && message.method !== 'HEAD') {
      init.body = message.data;
    }

    // タイムアウト対応
    let timeoutId = null;
    let aborted = false;
    const controller = new AbortController();
    init.signal = controller.signal;

    if (message.timeout && message.timeout > 0) {
      timeoutId = setTimeout(function () {
        aborted = true;
        controller.abort();
      }, message.timeout);
    }

    const res = await fetch(message.url, init);

    if (timeoutId) clearTimeout(timeoutId);

    // レスポンスヘッダーを文字列へ変換
    const headerLines = [];
    res.headers.forEach(function (value, name) {
      headerLines.push(name + ': ' + value);
    });
    const responseHeaders = headerLines.join('\r\n');

    let responseText = '';
    let responseData = null;

    try {
      responseText = await res.text();
      // JSONレスポンスタイプの場合はパースを試みる
      if (message.responseType === 'json') {
        try { responseData = JSON.parse(responseText); } catch (e) { responseData = null; }
      }
    } catch (e) {
      responseText = '';
    }

    // content scriptへ結果を送信
    sendToTab(tabId, {
      type: 'GM_xmlhttpRequest_response',
      id: message.id,
      status: res.status,
      statusText: res.statusText,
      responseText: responseText,
      responseHeaders: responseHeaders,
      finalUrl: res.url,
      response: responseData !== null ? responseData : responseText,
      error: false
    });

  } catch (err) {
    sendToTab(tabId, {
      type: 'GM_xmlhttpRequest_response',
      id: message.id,
      status: 0,
      statusText: '',
      responseText: '',
      responseHeaders: '',
      finalUrl: message.url,
      response: null,
      error: true,
      errorMessage: String(err && err.message ? err.message : err)
    });
  }
}

// ============================================================
// タブへメッセージを送る（エラーを無視）
// ============================================================
function sendToTab(tabId, message) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, message, function () {
    // chrome.runtime.lastError は無視（タブが閉じていることもある）
    void chrome.runtime.lastError;
  });
}

// ============================================================
// youtube.com/mylist → 拡張機能専用ページへリダイレクト
//
// youtube.com/mylist はYouTube本来のページが存在しないため
// エラーページが表示されてしまう。
// タブの URL が /mylist になった瞬間に chrome-extension:// の
// 専用ページへ置き換えることで、エラー画面を完全に回避する。
// ============================================================
const MYLIST_PAGE_URL = chrome.runtime.getURL('pages/mylist.html');
const MYLIST_PATTERN = /^https:\/\/www\.youtube\.com\/mylist(\?.*)?$/;
const CUSTOM_LIST_PAGE_URL = chrome.runtime.getURL('pages/custom-list.html');
const CUSTOM_LIST_PATTERN = /^https:\/\/www\.youtube\.com\/custom-list(\?.*)?$/;

// ツールバーアイコンクリック → マイリストページを開く（既に開いていればそのタブをアクティブに）
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: MYLIST_PAGE_URL });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: MYLIST_PAGE_URL });
  }
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  // loading 状態かつ URL が /mylist の場合にリダイレクト
  if (
    changeInfo.status === 'loading' &&
    tab.url &&
    ((MYLIST_PATTERN.test(tab.url) && !tab.url.startsWith(MYLIST_PAGE_URL)) ||
      (CUSTOM_LIST_PATTERN.test(tab.url) && !tab.url.startsWith(CUSTOM_LIST_PAGE_URL)))
  ) {
    const targetUrl = MYLIST_PATTERN.test(tab.url) ? MYLIST_PAGE_URL : CUSTOM_LIST_PAGE_URL;
    chrome.tabs.update(tabId, { url: targetUrl });
  }
});
