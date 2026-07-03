/* autoimport.js  ---  工事ごとのフォルダ自動取込（PCのChrome/Edge専用）
   工事ごとに取込元フォルダ（FileSystemDirectoryHandle）を設定し、
   その工事を開くたび（起動時＋工事切替時）にフォルダを確認、新しい写真を自動取込する。
   ブラウザは閉じている間は動けないため「開いたときに確認」で実現。iPad/iPhone は非対応。 */
(function (global) {
  'use strict';
  var UI = global.App.UI;
  var Storage = global.App.Storage;
  var Projects = global.App.Projects;

  var _prompted = {}; // このセッションで権限確認を出した工事（連続ナグ防止）

  function dirKey(pid) { return 'autoImportDir_' + pid; }
  function cfgKey(pid) { return 'autoImport_' + pid; }
  function nowMs() { return Date.now(); }
  function supported() { return !!global.showDirectoryPicker; }
  function isImageName(name) { return /\.(jpe?g|png|gif|webp|bmp|heic|heif|tif?f)$/i.test(name || ''); }

  /* ---- 設定ダイアログ（現在の工事に対して） ---- */
  function setup() {
    var proj = Projects.current();
    if (!proj) { UI.alert('先に工事を選択してください。', '自動取込'); return; }
    if (!supported()) {
      UI.alert('自動取込は パソコンの Google Chrome または Microsoft Edge でご利用ください。\n（iPad / iPhone のブラウザは未対応です）', '自動取込');
      return;
    }
    Storage.getSetting(dirKey(proj.id), null).then(function (dir) {
      var has = !!dir;
      var buttons = [{ key: 'pick', label: has ? '取込元フォルダを変更' : '取込元フォルダを選ぶ', primary: true }];
      if (has) {
        buttons.push({ key: 'now', label: '今すぐ新しい写真を確認' });
        buttons.push({ key: 'off', label: '自動取込を解除' });
      }
      buttons.push({ key: '__cancel', label: '閉じる' });
      UI.choose('工事「' + proj.name + '」の自動取込（PC専用）。\n' +
        '選んだフォルダを、この工事を開くたびに確認し、新しい写真を自動で取り込みます。\n\n' +
        '現在：' + (has ? '設定済み' : '未設定'), '⚙ 自動取込', buttons).then(function (k) {
        if (k === 'pick') return pickFolder(proj);
        if (k === 'now') return run(proj, { manual: true });
        if (k === 'off') return disable(proj.id);
      });
    });
  }

  function pickFolder(proj) {
    return global.showDirectoryPicker({ mode: 'read' }).then(function (dir) {
      return Storage.setSetting(dirKey(proj.id), dir).then(function () {
        return Storage.setSetting(cfgKey(proj.id), { enabled: true, lastCheck: 0 });
      }).then(function () {
        UI.toast('取込元フォルダを設定しました');
        return run(proj, { manual: true });
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return; // フォルダ選択のキャンセル
      UI.alert('フォルダを設定できませんでした。\n' + (e && e.message ? e.message : e), '自動取込');
    });
  }

  function disable(pid) {
    return Storage.delete('settings', dirKey(pid)).catch(function () {}).then(function () {
      return Storage.setSetting(cfgKey(pid), { enabled: false, lastCheck: 0 });
    }).then(function () { UI.toast('自動取込を解除しました'); });
  }

  /* ---- 工事を開いたときの確認（app.js から呼ぶ） ---- */
  function check(proj) {
    if (!proj || !supported()) return;
    Storage.getSetting(cfgKey(proj.id), null).then(function (cfg) {
      if (!cfg || !cfg.enabled) return;
      Storage.getSetting(dirKey(proj.id), null).then(function (dir) {
        if (!dir || !dir.queryPermission) return;
        dir.queryPermission({ mode: 'read' }).then(function (perm) {
          if (perm === 'granted') { run(proj); return; }
          // prompt/denied：起動時に自動で権限要求できないため、セッション1回だけ控えめに案内
          if (perm === 'prompt' && !_prompted[proj.id]) {
            _prompted[proj.id] = true;
            promptPermission(proj, dir);
          }
        });
      });
    });
  }

  function promptPermission(proj, dir) {
    UI.confirm('工事「' + proj.name + '」の自動取込フォルダを確認しますか？\n（新しい写真があれば取り込みます）', '自動取込').then(function (yes) {
      if (!yes) return;
      dir.requestPermission({ mode: 'read' }).then(function (p) {
        if (p === 'granted') return run(proj, { manual: true });
        UI.alert('フォルダへのアクセスが許可されませんでした。\n「⚙ 自動取込」から設定し直してください。', '自動取込');
      }).catch(function () {});
    });
  }

  /* ---- 実行：フォルダを走査して新規写真を取込 ---- */
  function run(proj, opts) {
    opts = opts || {};
    return Promise.all([
      Storage.getSetting(dirKey(proj.id), null),
      Storage.getSetting(cfgKey(proj.id), { enabled: true, lastCheck: 0 })
    ]).then(function (res) {
      var dir = res[0], cfg = res[1] || { enabled: true, lastCheck: 0 };
      if (!dir) { if (opts.manual) UI.alert('取込元フォルダが設定されていません。', '自動取込'); return; }
      var busy = opts.manual ? UI.busy('フォルダを確認中…') : null;
      return collectImages(dir).then(function (files) {
        var since = cfg.lastCheck || 0;
        // lastCheck 以降に更新されたファイルを優先（重複は importFiles 側でも除外）
        var candidates = files.filter(function (f) { return !since || (f.lastModified || 0) >= since - 60000; });
        var use = candidates.length ? candidates : files;
        return global.App.Photos.importFiles(use, { autoSkipDup: true, projectId: proj.id }).then(function (added) {
          if (busy) busy.close();
          return Storage.setSetting(cfgKey(proj.id), { enabled: true, lastCheck: nowMs() }).then(function () {
            if (added) UI.toast('自動取込：' + added + ' 枚を追加しました');
            else if (opts.manual) UI.toast('新しい写真はありませんでした');
          });
        });
      }).catch(function (e) {
        if (busy) busy.close();
        if (opts.manual) UI.alert('自動取込でエラーが発生しました。\n' + (e && e.message ? e.message : e), '自動取込');
      });
    });
  }

  function collectImages(dir) {
    return (async function () {
      var files = [];
      for await (var entry of dir.values()) {
        if (entry.kind === 'file' && isImageName(entry.name)) {
          try { files.push(await entry.getFile()); } catch (e) { /* 読めないファイルは無視 */ }
        }
      }
      return files;
    })();
  }

  global.App = global.App || {};
  global.App.AutoImport = {
    setup: setup, check: check, run: run, disable: disable
  };
})(window);
