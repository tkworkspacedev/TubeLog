/**
 * polyfill.js
 * ViolentmonkeyのGM_* APIをChrome拡張機能APIに対応させるポリフィル
 * このファイルはcontent.jsより先に読み込まれます
 */

(function () {
  'use strict';

  // mylist.html から読み込まれた場合（chrome-extension:// ページ）は
  // __vmIsMylistPage__ フラグを立てて content.js に専用モードを伝える。
  // custom-list.html は __vmIsCustomListPage__ が先にセットされるので除外する。
  if (location.protocol === 'chrome-extension:' && !window.__vmIsCustomListPage__) {
    window.__vmIsMylistPage__ = true;
  }

  // ============================================================
  // GM_getValue / GM_setValue → chrome.storage.local (同期ラッパー)
  // ============================================================
  // Violentmonkeyではこれらは同期APIですが、
  // chrome.storage.localは非同期です。
  // 対策: 起動時にストレージ全体をメモリキャッシュへ読み込み、
  //       getValue/setValueはキャッシュ経由で同期的に動作させます。

  window.__GM_STORAGE_CACHE__ = {};
  window.__GM_STORAGE_READY__ = false;
  window.__GM_STORAGE_READY_CALLBACKS__ = [];

  // ストレージ全体をキャッシュへ読み込む
  chrome.storage.local.get(null, function (items) {
    window.__GM_STORAGE_CACHE__ = items || {};
    window.__GM_STORAGE_READY__ = true;
    const cbs = window.__GM_STORAGE_READY_CALLBACKS__ || [];
    cbs.forEach(function (fn) {
      try { fn(); } catch (e) { /* noop */ }
    });
    window.__GM_STORAGE_READY_CALLBACKS__ = [];
  });

  // ストレージ変更をキャッシュへ反映（別タブ/拡張ページからの変更にも対応）
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    Object.keys(changes).forEach(function (key) {
      if (typeof changes[key].newValue === 'undefined') {
        delete window.__GM_STORAGE_CACHE__[key];
      } else {
        window.__GM_STORAGE_CACHE__[key] = changes[key].newValue;
      }
    });
  });

  /**
   * GM_getValue(key, defaultValue)
   * キャッシュから同期的に値を取得します
   */
  window.GM_getValue = function (key, defaultValue) {
    const cache = window.__GM_STORAGE_CACHE__;
    if (Object.prototype.hasOwnProperty.call(cache, key)) {
      return cache[key];
    }
    return (defaultValue !== undefined) ? defaultValue : undefined;
  };

  /**
   * GM_setValue(key, value)
   * キャッシュに即反映し、非同期でストレージへ保存します
   */
  window.GM_setValue = function (key, value) {
    window.__GM_STORAGE_CACHE__[key] = value;
    const data = {};
    data[key] = value;
    chrome.storage.local.set(data, function () {
      if (chrome.runtime.lastError) {
        console.error('[GM_setValue] storage error:', chrome.runtime.lastError);
      }
    });
  };

  /**
   * GM_deleteValue(key)
   */
  window.GM_deleteValue = function (key) {
    delete window.__GM_STORAGE_CACHE__[key];
    chrome.storage.local.remove(key, function () {
      if (chrome.runtime.lastError) {
        console.error('[GM_deleteValue] storage error:', chrome.runtime.lastError);
      }
    });
  };

  /**
   * GM_listValues()
   */
  window.GM_listValues = function () {
    return Object.keys(window.__GM_STORAGE_CACHE__);
  };

  // ============================================================
  // GM_openInTab → chrome.tabs.create
  // ============================================================
  window.GM_openInTab = function (url, options) {
    const active = options && typeof options === 'object'
      ? (options.active !== false)
      : (options !== true); // Violentmonkeyの第2引数 true = バックグラウンド
    chrome.runtime.sendMessage({
      type: 'GM_openInTab',
      url: url,
      active: active
    });
  };

  // ============================================================
  // GM_xmlhttpRequest → background経由でfetch（CORS回避）
  // ============================================================
  const _xhrCallbacks = new Map();
  let _xhrSeq = 1;

  window.GM_xmlhttpRequest = function (details) {
    const id = _xhrSeq++;
    const controller = { abort: function () {
      chrome.runtime.sendMessage({ type: 'GM_xmlhttpRequest_abort', id: id });
    }};

    _xhrCallbacks.set(id, details);

    chrome.runtime.sendMessage({
      type: 'GM_xmlhttpRequest',
      id: id,
      url: details.url,
      method: details.method || 'GET',
      headers: details.headers || {},
      data: details.data || null,
      responseType: details.responseType || 'text',
      timeout: details.timeout || 0
    });

    return controller;
  };

  // backgroundからのレスポンスを受信してコールバックを呼ぶ
  chrome.runtime.onMessage.addListener(function (message) {
    if (message.type !== 'GM_xmlhttpRequest_response') return;
    const details = _xhrCallbacks.get(message.id);
    if (!details) return;
    _xhrCallbacks.delete(message.id);

    const response = {
      status: message.status,
      statusText: message.statusText,
      responseText: message.responseText,
      responseHeaders: message.responseHeaders,
      finalUrl: message.finalUrl,
      response: message.response
    };

    if (message.error) {
      if (typeof details.onerror === 'function') details.onerror(response);
    } else {
      if (typeof details.onload === 'function') details.onload(response);
    }
  });

  // ============================================================
  // GM_notification（簡易実装）
  // ============================================================
  window.GM_notification = function (textOrOptions, title) {
    const text = typeof textOrOptions === 'string' ? textOrOptions : (textOrOptions.text || '');
    const notifTitle = typeof textOrOptions === 'object' ? (textOrOptions.title || title || '') : (title || '');
    chrome.runtime.sendMessage({
      type: 'GM_notification',
      title: notifTitle,
      text: text
    });
  };

  // ============================================================
  // GM_setClipboard
  // ============================================================
  window.GM_setClipboard = function (text) {
    try {
      navigator.clipboard.writeText(text).catch(function () {
        // フォールバック
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  // ============================================================
  // GM_addStyle
  // ============================================================
  window.GM_addStyle = function (cssText) {
    const style = document.createElement('style');
    style.textContent = String(cssText || '');
    (document.head || document.documentElement).appendChild(style);
    return style;
  };

  // ============================================================
  // ストレージ準備完了まで content.js の実行を保留する仕組み
  // ============================================================
  // content.jsは以下の関数が呼ばれるまで実際の初期化を行いません
  window.__waitForGMStorage__ = function (callback) {
    if (window.__GM_STORAGE_READY__) {
      callback();
    } else {
      window.__GM_STORAGE_READY_CALLBACKS__.push(callback);
    }
  };

})();
