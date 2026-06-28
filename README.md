# TubeLog — Chrome拡張機能版

YouTube上で動画をフォルダ管理できる「マイリスト機能」と、チャンネル管理用の「チャンネル一覧」を提供する **Manifest V3 拡張機能** です。

## 主な機能

### 📋 マイリスト管理
- 動画視聴ページからワンクリックでマイリスト追加
- 階層フォルダ構造（フォルダのネスト・移動・コピー・削除）
- フォルダカラー設定、フォルダ折りたたみ（開閉トグル）
- フォルダ右クリックメニュー（連続再生・フォルダ操作）
- 選択中フォルダの再クリックでサブフォルダ一覧を開閉トグル
- ゴミ箱機能（削除 → ゴミ箱 → 完全削除、指定日数での自動削除）
- テーブル表示 / グリッド表示 の切り替え（フォルダ単位で記憶）
- グリッド表示: 1行の表示件数カスタマイズ、移動ボタン設定
- テーブル表示: カラム幅リサイズ、ソート、サムネ右下に再生時間バッジ
- 動画検索（フォルダ内）
- チェックボックスによる複数選択 → 一括移動・削除・コピー
- ドラッグ＆ドロップによる動画の順序変更
- 動画メモ（テーブル行内ノート）
- タイムスタンプジャンプ（フォルダ単位でジャンプ幅設定、10〜50%）

### 🎬 視聴ページ統合
- ミニプレイリストパネル（ドラッグ移動・リサイズ・アイコン化・連続再生）
- 視聴ページメモウィンドウ（フローティング・自動保存対応）
- 視聴ページボタンのカスタマイズ（表示ラベル・色・アイコン）
- ショートカットキー設定（タイムスタンプ操作など）
- 動画終了時の自動次曲送り

### 📺 チャンネル一覧
- `custom-list.html` による独自チャンネル一覧画面
- チャンネルのフォルダ分類管理

### ☁️ データ同期・バックアップ
- **Googleドライブバックアップ**（Googleアカウントでログインし、同期設定不要で自身のドライブに保存）
- 「隠蔽されたアプリケーションデータ」領域に保存されるため他アプリから見えずドライブ容量も消費しない
- 保持件数・保持日数を設定可能（古いバックアップは自動削除）
- 編集後30秒で自動バックアップ（オンオフ切替可）
- バックアップ履歴から任意の時点に復元可能
- 統合バックアップ（エクスポート/インポート）— マイリスト・チャンネル・設定を一括
- インポート対象の選択（すべて / マイリストのみ / チャンネルのみ）
- 自動エクスポート設定

### ⚙️ 設定
- UI言語切り替え（日本語 / English、ブラウザ言語から自動判定）
- メインフォルダを開いたときにサブフォルダ一覧を表示しない
- ゴミ箱内自動削除（日数指定）
- サムネ右下の再生時間バッジ表示
- 視聴ページメモの自動保存 ON/OFF
- YouTube API キー共有（任意。未設定でも登録・管理は可能。視聴ページからの追加でチャンネル名と追加日は表示。投稿日・再生時間の後追いは API 設定時）

---

## ファイル構成

```
YouTube-Video-Playlist/
├── manifest.json
├── background.js       # Service Worker（Google Drive 認証・同期・GM_* RPC ハブ）
├── polyfill.js         # GM_* API ポリフィル（chrome.storage.local ベース）
├── content.js          # マイリスト機能・視聴ページ統合（メインモジュール）
├── channel-list.js     # チャンネル一覧機能
├── mylist.html         # マイリストページ
├── mylist.css
├── custom-list.html    # チャンネル一覧ページ
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## 画面URL

- マイリスト: `https://www.youtube.com/mylist` → 拡張ページ `mylist.html` へリダイレクト
- チャンネル一覧: `https://www.youtube.com/custom-list` → 拡張ページ `custom-list.html` へリダイレクト

---

## データ保存方針

| 種別 | ストレージ |
|------|-----------|
| マイリスト本体（`mylistData_v16`） | `chrome.storage.local`（GM_setValue）|
| チャンネルリスト本体 | `chrome.storage.local`（GM_setValue）|
| 同期設定・Googleドライブバックアップ設定 | `chrome.storage.local`（GM_setValue）|
| UI状態（カラム幅・フォルダ折りたたみ等） | `localStorage` |
| 設定の最終保存日時（競合防止用） | `chrome.storage.local` |

旧 `localStorage` データが存在する場合は、読み取り時に `chrome.storage.local` へ移行します。

## 統合バックアップ形式

```json
{
  "__version__": 4,
  "__format__": "ytvp-backup",
  "mylist": {},
  "channelList": {},
  "syncSettings": {},
  "syncConfig": {},
  "ytApiKey": "",
  "autoExport": {},
  "trashAutoDelete": {},
  "extraPersistedSettings": {}
}
```

統合バックアップでは、主要データに加えて多くのUI設定・動作設定・ローカル保持状態も復元対象に含めます。
ただし Google のログイン状態やアクセストークン自体は含めません。

---

## GM_* API の対応

| API | 実装 |
|---|---|
| `GM_getValue` / `GM_setValue` | `chrome.storage.local` + メモリキャッシュ |
| `GM_xmlhttpRequest` | `background.js` 経由の `fetch` |
| `GM_openInTab` | `chrome.tabs.create` |
| `GM_notification` | `chrome.notifications.create` |
| `GM_addStyle` | `<style>` 注入 |

---

## インストール手順

1. `chrome://extensions/`（または `vivaldi://extensions/`）を開く
2. デベロッパーモードをON
3. 「パッケージ化されていない拡張機能を読み込む」で本フォルダを指定
4. YouTubeを開いて動作確認

## プライバシーポリシー

- 本文: [`docs/privacy-policy.html`](docs/privacy-policy.html)
- 公開 URL: https://tkworkspacedev.github.io/TubeLog/privacy-policy.html
- お問い合わせ: [GitHub Issues](https://github.com/tkworkspacedev/TubeLog/issues)

## 注意事項

- 大きな変更前は統合エクスポートでバックアップ取得を推奨します。

### YouTube Data API キー（任意）

- キーは端末内に保存され、拡張が API を呼ぶときのみ Google（`googleapis.com`）へ送信されます。
- 無料枠は1日約10,000ユニットです。大量のメタデータ更新や再生リスト取得でクォータを使い切ると、翌日まで取得できなくなることがあります。
- キーの漏洩防止のため、Google Cloud で HTTP リファラー等のアプリ制限を設定することを推奨します。
- JSON エクスポート・Google ドライブバックアップへのキー含有は **同期設定のチェック（デフォルトオフ）と同意** がある場合のみです。共有ファイルの取り扱いに注意してください。
- 詳細はマイリストの設定 → **ヘルプ** タブおよび **同期設定** の注意書きを参照してください。

---

## Googleドライブバックアップの使い方

Googleアカウントでログインし、マイリストデータを自動でGoogleドライブの「凝縮されたアプリケーションデータ」領域にバックアップします。他のアプリからは見えず、ドライブの使用容量にもカウントされません。

1. マイリストページ右上の「設定」を開き、「同期設定」タブを選択
2. 「☁️ Googleドライブ バックアップ」セクションで「🔑 Googleでログイン」をクリック
3. Googleアカウントを選択しアクセスを許可
4. 保持設定（件数 or 日数）を調整して設定を保存
5. 編集後30秒で自動バックアップされ、「📂 履歴から復元」から任意の時点に復元できます

別ブラウザ・別端末への移行も、同じGoogleアカウントでログインしてバックアップ履歴から復元するだけで完了します。

---

## デバッグ方法

| 場所 | 確認方法 |
|------|---------|
| Service Worker ログ | `chrome://extensions` → この拡張 → Service Worker |
| マイリストページ UI | 拡張ページの DevTools |
| 視聴ページ / コンテンツスクリプト | YouTubeタブの DevTools |
