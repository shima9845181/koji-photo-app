/* github.js  ---  GitHub連携（アプリ内ボタンからの反映）
   ① 設定（トークン）② 工事データのバックアップ ③ 復元（同一工事を上書き）
   ④ アプリ本体の更新を公開サイト(GitHub Pages)へデプロイ（PCでfile://起動時のみ）
   通信は GitHub REST API。トークンは IndexedDB(settings) に保存。 */
(function (global) {
  'use strict';
  var UI = global.App.UI;
  var Storage = global.App.Storage;
  var Projects = global.App.Projects;
  var Backup = global.App.Backup;

  var API = 'https://api.github.com';
  var OWNER = 'shima9845181';
  var CODE_REPO = 'koji-photo-app';   // 公開・アプリ本体（GitHub Pages）
  var DATA_REPO = 'koji-photo-data';  // 非公開・データバックアップ
  var PAGES_URL = 'https://shima9845181.github.io/koji-photo-app/';
  var MAX_BACKUP_BYTES = 40 * 1024 * 1024; // ~40MB（GitHub API 制限内の安全値）
  var SKIP_DIRS = { '.git': 1, 'node_modules': 1, 'backups': 1, '.vscode': 1 };

  /* ---------- 小物 ---------- */
  function token() { return Storage.getSetting('githubToken', null); }
  function mb(bytes) { return (bytes / 1048576).toFixed(1); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function nowStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function safeName(s) { return String(s || 'export').replace(/[\\/:*?"<>|]/g, '_'); }
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }

  function fmtErr(e) {
    if (!e) return '不明なエラー';
    if (e.message === 'NO_TOKEN') return 'トークンが未設定です。「① GitHub設定」から登録してください。';
    var m = e.message || String(e);
    // Fine-grained トークンは対象リポジトリ／Contents権限の不足でも 401 になり得る
    if (e.status === 401) return '認証エラー（トークンが無効／期限切れ、または対象リポジトリ・Contents権限の不足）: ' + m;
    if (e.status === 403) return '権限エラー（トークンの権限不足、またはレート制限）: ' + m;
    if (e.status === 404) return '見つかりません（リポジトリ名やトークンの対象範囲をご確認ください）: ' + m;
    if (e.status === 409 || e.status === 422) return '競合／不正なリクエスト: ' + m;
    return m;
  }

  /* 指定リポジトリに書き込み可能か検証（読取＋permissions.push）。
     戻り値: Promise<{ok:bool, reason:string}> */
  function checkRepoWritable(repo) {
    return ghFetch('/repos/' + OWNER + '/' + repo).then(function (r) {
      if (r && r.permissions && r.permissions.push === true) return { ok: true, reason: '' };
      return { ok: false, reason: repo + '：読み取りはできますが書き込み権限がありません（Contents を Read and write に）。' };
    }).catch(function (e) {
      if (e.status === 404) return { ok: false, reason: repo + '：トークンの対象リポジトリに含まれていません（Repository access に追加してください）。' };
      if (e.status === 401 || e.status === 403) return { ok: false, reason: repo + '：アクセスできません（対象リポジトリと Contents=Read and write を確認）。' };
      return { ok: false, reason: repo + '：確認中にエラー（' + (e.message || e) + '）' };
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result);
        resolve(s.substring(s.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(fr.error || new Error('読み込みに失敗')); };
      fr.readAsDataURL(blob);
    });
  }

  /* ---------- API ラッパ ---------- */
  function ghFetch(path, opts) {
    return token().then(function (tok) {
      if (!tok) { var ne = new Error('NO_TOKEN'); throw ne; }
      opts = opts || {};
      var headers = {
        'Authorization': 'Bearer ' + tok,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      };
      if (opts.body) headers['Content-Type'] = 'application/json';
      if (opts.headers) { for (var k in opts.headers) headers[k] = opts.headers[k]; }
      var req = { method: opts.method || 'GET', headers: headers };
      if (opts.body) req.body = opts.body;
      return fetch(API + path, req).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
          if (!res.ok) {
            var msg = (data && data.message) ? data.message : ('HTTP ' + res.status);
            var err = new Error(msg); err.status = res.status; err.data = data; throw err;
          }
          return data;
        });
      });
    });
  }

  /* ファイル内容(生バイナリ)を取得（大きめのzipにも対応：raw メディアタイプ） */
  function fetchRawBlob(repo, path) {
    return token().then(function (tok) {
      if (!tok) throw new Error('NO_TOKEN');
      return fetch(API + '/repos/' + OWNER + '/' + repo + '/contents/' + encPath(path), {
        headers: {
          'Authorization': 'Bearer ' + tok,
          'Accept': 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) { var e = new Error(t || ('HTTP ' + res.status)); e.status = res.status; throw e; });
        }
        return res.blob();
      });
    });
  }

  /* Contents API で作成/更新（sha があれば更新） */
  function putContents(repo, path, contentB64, message, sha) {
    var body = { message: message, content: contentB64 };
    if (sha) body.sha = sha;
    return ghFetch('/repos/' + OWNER + '/' + repo + '/contents/' + encPath(path), {
      method: 'PUT', body: JSON.stringify(body)
    });
  }

  function listBackups() {
    return ghFetch('/repos/' + OWNER + '/' + DATA_REPO + '/contents/backups').then(function (items) {
      if (!Array.isArray(items)) return [];
      return items.filter(function (it) { return it.type === 'file' && /\.zip$/i.test(it.name); });
    }).catch(function (e) { if (e.status === 404) return []; throw e; });
  }

  /* ---------- トークン確保 ---------- */
  function requireToken() {
    return token().then(function (t) {
      if (t) return t;
      return UI.confirm('先にGitHubトークンの設定が必要です。今すぐ設定しますか？', 'GitHub').then(function (yes) {
        if (!yes) return null;
        return settings().then(function () { return token(); });
      });
    });
  }

  /* ---------- ① 設定 ---------- */
  function settings() {
    return token().then(function (cur) {
      return UI.prompt('GitHub設定（アクセストークン）', [
        { name: 'token', label: 'トークン(PAT)', type: 'password', value: cur || '', placeholder: 'github_pat_... または ghp_...' }
      ]).then(function (v) {
        if (!v) return;
        // 改行込みで貼り付けても壊れないよう空白は全除去
        var t = (v.token || '').replace(/\s+/g, '');
        if (!t) { return UI.alert('トークンが空です。', 'GitHub設定'); }
        return Storage.setSetting('githubToken', t).then(function () {
          var busy = UI.busy('接続と権限を確認中…');
          // ① アカウント認証 → ② 両リポジトリの書き込み権限まで検証する
          return ghFetch('/user').then(function (u) {
            return checkRepoWritable(DATA_REPO).then(function (d) {
              return checkRepoWritable(CODE_REPO).then(function (c) {
                busy.close();
                var login = u && u.login;
                if (d.ok && c.ok) {
                  UI.alert('接続できました。\nログイン: ' + login +
                    '\n・' + DATA_REPO + '（バックアップ先）: 書き込みOK' +
                    '\n・' + CODE_REPO + '（公開サイト）: 書き込みOK' +
                    '\n\nこれで「バックアップ」「復元」「アプリを更新して公開」が使えます。', 'GitHub設定');
                } else {
                  var msg = 'ログインはできました（' + login + '）が、リポジトリへの書き込み権限が不足しています。\n\n';
                  if (!d.ok) msg += '× ' + d.reason + '\n';
                  if (!c.ok) msg += '× ' + c.reason + '\n';
                  msg += '\n【直し方】トークン設定ページで\n' +
                    '・Repository access に「' + CODE_REPO + '」と「' + DATA_REPO + '」の両方を追加\n' +
                    '・Permissions → Contents を「Read and write」\n' +
                    'に修正して更新後、もう一度貼り付けてください。';
                  UI.alert(msg, 'GitHub設定');
                }
              });
            });
          }).catch(function (e) {
            busy.close();
            UI.alert('接続できませんでした。\n' + fmtErr(e) +
              '\n\nトークンの値、対象リポジトリ（' + CODE_REPO + ' / ' + DATA_REPO + '）、Contents=Read and write をご確認ください。', 'GitHub設定');
          });
        });
      });
    });
  }

  /* ---------- ② バックアップ ---------- */
  function backupData() {
    var proj = Projects.current();
    if (!proj) { UI.alert('先に工事を選択してください。', 'バックアップ'); return; }
    requireToken().then(function (t) {
      if (!t) return;
      var busy = UI.busy('バックアップを準備中…');
      var fileName = safeName(proj.name) + '__' + proj.id + '.zip';
      var path = 'backups/' + fileName;
      Backup.buildProjectZip(proj, function (pct) { busy.update('圧縮中… ' + pct + '%'); }).then(function (blob) {
        if (blob.size > MAX_BACKUP_BYTES) {
          busy.close();
          return UI.alert('この工事はデータが大きすぎるため（約 ' + mb(blob.size) + 'MB）、GitHubにはバックアップできません。\n' +
            'GitHubの制限（約 ' + mb(MAX_BACKUP_BYTES) + 'MB）を超えています。\n\n' +
            '大きい工事は「書き出し」ボタンでUSBメモリ等に保存してください。', 'バックアップ');
        }
        busy.update('アップロード中…');
        return listBackups().then(function (items) {
          // 同じ工事ID（__<id>.zip）の既存ファイルを探す（名称変更で旧名が残っていれば削除）
          var suffix = '__' + proj.id + '.zip';
          var existingSameName = null, stale = [];
          items.forEach(function (it) {
            if (it.name === fileName) existingSameName = it;
            else if (it.name.indexOf(suffix, it.name.length - suffix.length) !== -1) stale.push(it);
          });
          return blobToBase64(blob).then(function (b64) {
            return putContents(DATA_REPO, path, b64, 'backup: ' + proj.name + ' (' + nowStr() + ')',
              existingSameName ? existingSameName.sha : null);
          }).then(function () {
            // 旧名（工事名変更前）の重複を掃除
            var chain = Promise.resolve();
            stale.forEach(function (it) {
              chain = chain.then(function () {
                return ghFetch('/repos/' + OWNER + '/' + DATA_REPO + '/contents/' + encPath(it.path), {
                  method: 'DELETE',
                  body: JSON.stringify({ message: 'cleanup old backup name', sha: it.sha })
                }).catch(function () { /* 掃除失敗は無視 */ });
              });
            });
            return chain;
          });
        }).then(function () {
          busy.close();
          UI.toast('GitHubにバックアップしました');
        });
      }).catch(function (e) {
        busy.close();
        UI.alert('バックアップに失敗しました。\n' + fmtErr(e), 'バックアップ');
      });
    });
  }

  /* ---------- ③ 復元（上書き） ---------- */
  function prettyName(fname) {
    return String(fname).replace(/\.zip$/i, '').replace(/__[^_]+$/, ''); // 末尾の __<id> を隠す
  }
  function restoreData() {
    requireToken().then(function (t) {
      if (!t) return;
      var busy = UI.busy('バックアップ一覧を取得中…');
      listBackups().then(function (items) {
        busy.close();
        if (!items.length) { return UI.alert('GitHubにバックアップがありません。\n先に「② バックアップ」を実行してください。', '復元'); }
        items.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
        var buttons = items.slice(0, 16).map(function (it) {
          return { key: it.path, label: prettyName(it.name) + '（約' + mb(it.size) + 'MB）', _it: it };
        });
        buttons.push({ key: '__cancel', label: 'キャンセル' });
        return UI.choose('復元するバックアップを選んでください。\n※ 選ぶと内容を確認します。', 'GitHubから復元', buttons).then(function (key) {
          if (!key || key === '__cancel') return;
          var it = null;
          items.forEach(function (x) { if (x.path === key) it = x; });
          if (!it) return;
          var b2 = UI.busy('ダウンロード中…');
          return fetchRawBlob(DATA_REPO, it.path).then(function (blob) {
            return Backup.readZipMeta(blob).then(function (meta) {
              b2.close();
              return confirmAndImport(blob, meta);
            });
          }).catch(function (e) {
            b2.close();
            UI.alert('復元に失敗しました。\n' + fmtErr(e), '復元');
          });
        });
      }).catch(function (e) {
        busy.close();
        UI.alert('一覧の取得に失敗しました。\n' + fmtErr(e), '復元');
      });
    });
  }

  /* 復元前の確認：既存工事と衝突すれば上書き警告＋別名取込みの選択 */
  function confirmAndImport(blob, meta) {
    var name = (meta && meta.project && meta.project.name) || '（無題）';
    var pid = (meta && meta.project && meta.project.id) || null;
    var existsCheck = pid ? Storage.get('projects', pid) : Promise.resolve(null);
    return existsCheck.then(function (existing) {
      if (existing) {
        // 衝突あり：上書きは元データを消す（不可逆）
        return UI.choose(
          'この工事「' + name + '」は既にこの端末にあります。\n' +
          '「上書きして復元」を選ぶと、今この端末にある「' + name + '」の写真・分類は消えて、GitHubの内容に置き換わります（元に戻せません）。',
          '復元の確認', [
            { key: 'overwrite', label: '上書きして復元（現在の内容を消す）', primary: false },
            { key: 'rename', label: '別名で新しい工事として取り込む' },
            { key: '__cancel', label: 'キャンセル' }
          ]).then(function (k) { return runImport(k, blob, meta, name); });
      }
      // 衝突なし：警告不要
      return UI.choose(
        'バックアップ「' + name + '」を復元します。',
        '復元', [
          { key: 'overwrite', label: '復元する', primary: true },
          { key: 'rename', label: '別名で新しい工事として取り込む' },
          { key: '__cancel', label: 'キャンセル' }
        ]).then(function (k) { return runImport(k, blob, meta, name); });
    });
  }

  function runImport(key, blob, meta, name) {
    if (!key || key === '__cancel') return;
    if (key === 'overwrite') {
      return Backup.importZip(blob, { mode: 'overwrite' });
    }
    // rename：新しい工事名を入力して別工事として取り込む（元は残る）
    return UI.prompt('別名で取り込む', [
      { name: 'name', label: '新しい工事名', value: name + '（復元）', placeholder: '例：' + name + '（復元）' }
    ]).then(function (v) {
      if (!v || !v.name || !v.name.trim()) return;
      return Backup.importZip(blob, { mode: 'new', newName: v.name.trim() });
    });
  }

  /* ---------- ④ アプリ更新デプロイ（file:// 専用） ---------- */
  function deployApp() {
    if (location.protocol !== 'file:') {
      return UI.alert('「アプリを更新して公開」は、パソコンで index.html を直接開いて使ったときのみ実行できます。\n' +
        '（スマホや公開サイト上のアプリからは、アプリ本体のファイルを読み取れないため実行できません）\n\n' +
        'パソコンでは、このボタン、または同じフォルダの「deploy.bat」をダブルクリックして公開してください。', 'アプリの公開');
    }
    if (!window.showDirectoryPicker) {
      return UI.alert('お使いのブラウザはフォルダ選択（File System Access API）に未対応です。\n' +
        '同じフォルダの「deploy.bat」をダブルクリックして公開してください。', 'アプリの公開');
    }
    requireToken().then(function (t) {
      if (!t) return;
      UI.confirm('このアプリのフォルダ（写真管理アプリ）を選ぶと、その内容で公開サイトを更新します。\n続けますか？', 'アプリの公開').then(function (yes) {
        if (!yes) return;
        var dir;
        window.showDirectoryPicker().then(function (d) {
          dir = d;
          var busy = UI.busy('ファイルを読み込み中…');
          return collectFiles(dir, '', busy).then(function (files) {
            if (!files.length) { throw new Error('フォルダ内にファイルが見つかりませんでした。'); }
            return commitFiles(files, busy);
          }).then(function () {
            busy.close();
            UI.alert('公開サイトへ反映しました。\n数分でURLの内容が更新されます:\n' + PAGES_URL, 'アプリの公開');
          }).catch(function (e) {
            busy.close(); throw e;
          });
        }).catch(function (e) {
          if (e && (e.name === 'AbortError')) return; // フォルダ選択のキャンセル
          UI.alert('公開に失敗しました。\n' + fmtErr(e) + '\n\n代わりに「deploy.bat」をダブルクリックしてお試しください。', 'アプリの公開');
        });
      });
    });
  }

  /* ディレクトリを再帰読取して {path, file} の配列を返す */
  function collectFiles(dirHandle, prefix, busy) {
    return (async function () {
      var files = [];
      for await (var entry of dirHandle.values()) {
        var name = entry.name;
        var path = prefix ? prefix + '/' + name : name;
        if (entry.kind === 'directory') {
          if (SKIP_DIRS[name]) continue;
          var sub = await collectFiles(entry, path, busy);
          for (var j = 0; j < sub.length; j++) files.push(sub[j]);
        } else {
          var file = await entry.getFile();
          files.push({ path: path, file: file });
          busy.update('読み込み中… ' + files.length + ' ファイル');
        }
      }
      return files;
    })();
  }

  /* Git Data API で 1 コミット（フォルダの完全スナップショット＝削除も反映） */
  function commitFiles(files, busy) {
    return (async function () {
      var base = '/repos/' + OWNER + '/' + CODE_REPO;
      busy.update('GitHubへ送信中…（1/4 参照取得）');
      var ref = await ghFetch(base + '/git/ref/heads/main');
      var baseCommitSha = ref.object.sha;
      var tree = [];
      for (var i = 0; i < files.length; i++) {
        busy.update('GitHubへ送信中…（2/4 ファイル ' + (i + 1) + '/' + files.length + '）');
        var b64 = await blobToBase64(files[i].file);
        var blob = await ghFetch(base + '/git/blobs', {
          method: 'POST', body: JSON.stringify({ content: b64, encoding: 'base64' })
        });
        tree.push({ path: files[i].path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      busy.update('GitHubへ送信中…（3/4 ツリー作成）');
      var newTree = await ghFetch(base + '/git/trees', {
        method: 'POST', body: JSON.stringify({ tree: tree }) // base_tree なし＝完全スナップショット
      });
      busy.update('GitHubへ送信中…（4/4 コミット）');
      var commit = await ghFetch(base + '/git/commits', {
        method: 'POST', body: JSON.stringify({
          message: 'アプリ更新（' + nowStr() + '）', tree: newTree.sha, parents: [baseCommitSha]
        })
      });
      await ghFetch(base + '/git/refs/heads/main', {
        method: 'PATCH', body: JSON.stringify({ sha: commit.sha })
      });
      return commit;
    })();
  }

  /* ---------- メニュー ---------- */
  function openMenu() {
    var isLocal = (location.protocol === 'file:');
    token().then(function (tok) {
      var status = tok ? 'トークン: 設定済み' : 'トークン: 未設定（先に①を実行）';
      var buttons = [
        { key: 'settings', label: '① GitHub設定' + (tok ? '（変更）' : '（未設定）'), primary: !tok },
        { key: 'backup', label: '② この工事をGitHubにバックアップ' },
        { key: 'restore', label: '③ GitHubから復元（上書き）' },
        { key: 'deploy', label: '④ アプリを更新して公開' + (isLocal ? '' : '（PC専用）') },
        { key: '__cancel', label: '閉じる' }
      ];
      UI.choose('GitHub連携メニュー\n' + status, 'GitHub', buttons).then(function (key) {
        if (key === 'settings') settings();
        else if (key === 'backup') backupData();
        else if (key === 'restore') restoreData();
        else if (key === 'deploy') deployApp();
      });
    });
  }

  /* ---------- スマホで開く（公開URL表示＋コピー＋QR） ---------- */
  function copyUrl(text) {
    if (global.navigator && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      var okc = document.execCommand('copy');
      document.body.removeChild(ta);
      return okc;
    } catch (e) { return false; }
  }

  function openMobile() {
    var url = PAGES_URL;
    var wrap = document.createElement('div');
    wrap.className = 'mobile-share';
    var qrHtml = '';
    if (global.qrcode) {
      try {
        var qr = global.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        qrHtml = '<div class="mobile-qr">' + qr.createImgTag(6, 8, 'QRコード') + '</div>';
      } catch (e) { qrHtml = ''; }
    }
    wrap.innerHTML =
      '<p class="note">スマホのカメラで下のQRコードを読み取るか、URLをコピーしてスマホのブラウザで開いてください。<br>' +
      '（写真データはこの端末に保存されます。別端末とは「GitHub」→バックアップ／復元で受け渡しできます）</p>' +
      qrHtml +
      '<div class="mobile-url" id="mobileUrl">' + UI.esc(url) + '</div>' +
      '<div class="detail-actions" style="justify-content:center">' +
      '<button class="btn btn-primary btn-lg" id="mobileCopy">URLをコピー</button>' +
      '<button class="btn btn-lg" id="mobileOpen">このPCで開く</button>' +
      '</div>';
    UI.modal(wrap, 'スマホで開く');
    wrap.querySelector('#mobileCopy').onclick = function () {
      Promise.resolve(copyUrl(url)).then(function (okc) {
        if (okc) UI.toast('URLをコピーしました');
        else UI.alert('自動コピーできませんでした。URLを長押し／範囲選択してコピーしてください。\n\n' + url, 'コピー');
      });
    };
    wrap.querySelector('#mobileOpen').onclick = function () { global.open(url, '_blank'); };
  }

  global.App = global.App || {};
  global.App.Github = {
    openMenu: openMenu,
    settings: settings,
    backupData: backupData,
    restoreData: restoreData,
    deployApp: deployApp,
    openMobile: openMobile
  };
})(window);
