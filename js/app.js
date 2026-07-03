/* app.js  ---  エントリポイント。ヘッダ操作と画面制御をまとめる。 */
(function (global) {
  'use strict';
  var App = global.App;
  var UI = App.UI, Projects = App.Projects, Photos = App.Photos;

  function refreshHeader(proj) {
    var el = document.getElementById('currentProject');
    if (el) el.textContent = proj ? proj.name : '（工事が未選択）';
  }

  /* ヘッダの高さを CSS 変数へ（操作バー・サイドバーの固定位置に使う） */
  function updateAppbarH() {
    var a = document.querySelector('.appbar');
    if (a) document.documentElement.style.setProperty('--appbar-h', a.offsetHeight + 'px');
  }

  /* ヘッダのボタン群を▽/△で開閉。畳んだら高さ変数を更新して固定バーを追従させる */
  function applyHeaderCollapsed(collapsed) {
    var a = document.querySelector('.appbar');
    var btn = document.getElementById('btnHeaderToggle');
    if (!a) return;
    if (collapsed) a.classList.add('collapsed'); else a.classList.remove('collapsed');
    // 下のツールバー（＋写真を取り込む/検索/選択バー等）も連動して収納
    document.documentElement.classList.toggle('ui-collapsed', collapsed);
    if (btn) {
      btn.textContent = collapsed ? '▽' : '△';        // 畳=▽(開く) / 展開=△(閉じる)
      btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      btn.title = collapsed ? 'メニューを表示' : 'メニューを隠す';
    }
    // レイアウト確定後に高さ再計算
    global.requestAnimationFrame(function () { updateAppbarH(); });
  }

  /* 工事名（・発注者）の変更 */
  function renameProject(proj) {
    if (!proj) return Promise.resolve(null);
    return UI.prompt('工事名の変更', [
      { name: 'name', label: '工事名', value: proj.name },
      { name: 'client', label: '発注者（任意）', value: proj.client || '' }
    ]).then(function (v) {
      if (!v || !v.name) return null;
      var updated = Object.assign({}, proj, { name: v.name, client: v.client });
      return Projects.update(updated).then(function () { UI.toast('工事名を変更しました'); return updated; });
    });
  }

  /* 工事の切替・管理ダイアログ */
  function projectDialog() {
    Projects.list().then(function (rows) {
      var wrap = document.createElement('div');
      wrap.className = 'project-list';
      var cur = Projects.current();
      var html = '<div class="detail-actions" style="justify-content:flex-start">' +
        '<button class="btn btn-primary" id="newPrj">＋ 新しい工事</button></div>';
      if (!rows.length) {
        html += '<p class="empty">工事がありません。「＋ 新しい工事」から作成してください。</p>';
      } else {
        html += '<ul class="prj-ul">';
        rows.forEach(function (p) {
          var active = cur && cur.id === p.id;
          html += '<li class="prj-item' + (active ? ' active' : '') + '" data-id="' + p.id + '">' +
            '<div class="prj-main"><b>' + UI.esc(p.name) + '</b>' +
            (p.client ? '<span class="prj-sub">' + UI.esc(p.client) + '</span>' : '') + '</div>' +
            '<div class="prj-btns">' +
            '<button class="btn" data-act="select" data-id="' + p.id + '">' + (active ? '選択中' : '選択') + '</button>' +
            '<button class="btn" data-act="rename" data-id="' + p.id + '">名称変更</button>' +
            '<button class="btn btn-danger" data-act="del" data-id="' + p.id + '">削除</button>' +
            '</div></li>';
        });
        html += '</ul>';
      }
      wrap.innerHTML = html;
      var close = UI.modal(wrap, '工事の選択・管理');

      wrap.querySelector('#newPrj').onclick = function () {
        close(); Projects.createDialog().then(function () { Photos.reload(); });
      };
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-act]'), function (btn) {
        btn.onclick = function () {
          var id = btn.getAttribute('data-id');
          var act = btn.getAttribute('data-act');
          if (act === 'select') {
            Projects.select(id).then(function () { close(); Photos.reload(); });
          } else if (act === 'rename') {
            var target = rows.filter(function (x) { return x.id === id; })[0];
            renameProject(target).then(function (u) { if (u) { close(); projectDialog(); } });
          } else if (act === 'del') {
            UI.confirm('この工事と、含まれる写真をすべて削除します。元に戻せません。よろしいですか？', '工事の削除')
              .then(function (ok) {
                if (!ok) return;
                Projects.remove(id).then(function () { close(); Photos.reload(); UI.toast('削除しました'); });
              });
          }
        };
      });
    });
  }

  function wireHeader() {
    document.getElementById('btnProjects').onclick = projectDialog;
    document.getElementById('btnNewProject').onclick = function () {
      Projects.createDialog().then(function () { Photos.reload(); });
    };
    document.getElementById('btnAlbums').onclick = function () { App.Albums.openView(); };
    document.getElementById('btnExportBook').onclick = function () { App.ExportBook.dialog(); };
    document.getElementById('btnBackup').onclick = function () { App.Backup.exportCurrent(); };
    document.getElementById('btnImportZip').onclick = function () { App.Backup.importDialog(); };
    document.getElementById('btnGithub').onclick = function () { App.Github.openMenu(); };
    document.getElementById('btnMobile').onclick = function () { App.Github.openMobile(); };
    // ヘッダのボタン群を▽/△で開閉（状態は記憶）
    var hToggle = document.getElementById('btnHeaderToggle');
    if (hToggle) hToggle.onclick = function () {
      var collapsed = !document.querySelector('.appbar').classList.contains('collapsed');
      applyHeaderCollapsed(collapsed);
      App.Storage.setSetting('headerCollapsed', collapsed);
    };

    // ヘッダの工事名クリックで名称変更（現在の工事）
    var pj = document.querySelector('.appbar-project');
    if (pj) pj.onclick = function () {
      var c = Projects.current();
      if (c) renameProject(c);
      else UI.alert('先に工事を作成・選択してください。', '工事名の変更');
    };

    // 戻る／進む（Undo/Redo）
    var btnUndo = document.getElementById('btnUndo');
    var btnRedo = document.getElementById('btnRedo');
    btnUndo.onclick = function () { App.Undo.undo(); };
    btnRedo.onclick = function () { App.Undo.redo(); };
    App.Undo.onChange(function () {
      btnUndo.disabled = !App.Undo.canUndo();
      btnRedo.disabled = !App.Undo.canRedo();
    });
    // キーボード（入力欄にフォーカス中は無効）
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      var k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); App.Undo.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); App.Undo.redo(); }
    });
    // 工事を切り替えたら履歴をクリア（別工事の履歴を混ぜない）
    Projects.onChange(function () { App.Undo.clear(); });
  }

  function start() {
    // 対象ブラウザの簡易チェック
    if (!global.indexedDB) {
      document.body.innerHTML = '<div style="padding:40px;font-size:18px">' +
        'このアプリは Microsoft Edge または Google Chrome でお使いください。</div>';
      return;
    }
    wireHeader();
    Projects.onChange(refreshHeader);
    updateAppbarH();
    window.addEventListener('resize', updateAppbarH);
    setTimeout(updateAppbarH, 200); // フォント確定後に再計測
    // ヘッダの畳み状態を復元
    App.Storage.getSetting('headerCollapsed', false).then(function (c) { applyHeaderCollapsed(!!c); });
    // 入力履歴（全工事共通）を先に構築してから画面を初期化
    App.History.init().then(function () {
      Photos.mount(document.getElementById('main'), document.getElementById('sidebar'));
      return Projects.init();
    }).then(function (proj) {
      refreshHeader(proj);
      Photos.reload();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else { start(); }
})(window);
