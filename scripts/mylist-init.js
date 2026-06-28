// mylist.html 専用の初期化フラグ
// CSP違反を避けるため インラインスクリプトではなく外部ファイルとして読み込む
window.__vmIsMylistPage__ = true;
document.title = chrome.i18n.getMessage('appName');
