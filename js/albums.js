/* albums.js  ---  アルバム（手動保存＋分類項目ごとの自動グループ）
   アルバムは順序付き項目リスト items を持つ：
     {t:'photo', photoId} / {t:'text', text} / {t:'blank'}
   写真の並び替え・自由行（見出し/メモ・空欄コマ）・削除・文字編集に対応。 */
(function (global) {
  'use strict';
  var Storage = global.App.Storage;
  var UI = global.App.UI;
  var Projects = global.App.Projects;

  var FIELD_LABEL = { koushu: '工種', shubetsu: '種別', saibetsu: '細別', kubun: '撮影区分', spot: '撮影箇所' };

  function byDate(a, b) { return (a.takenAt || a.importedAt) - (b.takenAt || b.importedAt); }

  /* 後方互換：items が無い旧アルバムは photoIds から生成 */
  function itemsOf(album) {
    if (album.items && album.items.length !== undefined) return album.items;
    return (album.photoIds || []).map(function (id) { return { t: 'photo', photoId: id }; });
  }
  function photoCount(album) {
    return itemsOf(album).filter(function (it) { return it.t === 'photo'; }).length;
  }
  /* 複数アルバムに含まれる写真ID集合（取込み済みバッジ用） */
  function photoIdSet(albums) {
    var set = {};
    (albums || []).forEach(function (a) {
      itemsOf(a).forEach(function (it) { if (it.t === 'photo') set[it.photoId] = true; });
    });
    return set;
  }

  function save(album) { return Storage.put('albums', album); }

  /* 選択写真を手動アルバムとして保存 */
  function createManual(name, photoIds) {
    var proj = Projects.current();
    if (!proj) return Promise.resolve(null);
    var album = {
      id: Storage.newId('alb'),
      projectId: proj.id,
      name: name,
      items: photoIds.map(function (id) { return { t: 'photo', photoId: id }; }),
      createdAt: Date.now()
    };
    return save(album).then(function () {
      if (global.App.Photos) global.App.Photos.reload(); // バッジ更新
      return album;
    });
  }

  function outputPhotos(photos, label) {
    if (!photos.length) { UI.alert('対象の写真がありません。', '写真帳出力'); return; }
    photos.sort(byDate);
    global.App.ExportBook.dialog(photos, label);
  }

  /* 手動アルバムを items 順（並べ替えず）に出力。自由行も含める */
  function outputAlbum(album) {
    var proj = Projects.current();
    return Storage.getPhotosByProject(proj.id).then(function (all) {
      var map = {};
      all.forEach(function (p) { map[p.id] = p; });
      var entries = [];
      itemsOf(album).forEach(function (it) {
        if (it.t === 'photo') { if (map[it.photoId]) entries.push(map[it.photoId]); }
        else if (it.t === 'text') entries.push({ _kind: 'text', text: it.text || '' });
        else if (it.t === 'blank') entries.push({ _kind: 'blank' });
      });
      if (!entries.length) { UI.alert('出力する項目がありません。', '写真帳出力'); return; }
      global.App.ExportBook.dialog(entries, 'アルバム：' + album.name);
    });
  }

  /* ===== アルバム画面 ===== */
  function openView() {
    var proj = Projects.current();
    if (!proj) { UI.alert('先に工事を選択してください。', 'アルバム'); return; }

    var wrap = document.createElement('div');
    wrap.className = 'albums-view';
    var close = UI.modal(wrap, 'アルバム');

    Promise.all([Storage.getAlbumsByProject(proj.id), Storage.getPhotosByProject(proj.id)])
      .then(function (res) {
        var albums = res[0], photos = res[1];
        albums.sort(function (a, b) { return b.createdAt - a.createdAt; });
        renderManual(wrap, albums, close);
        renderDateAlbums(wrap, photos, close);
        renderAuto(wrap, photos, close);
      });
  }

  /* 撮影日（EXIF）ごとの自動アルバム */
  function dateKey(takenAt) {
    if (!takenAt) return '日付なし';
    var d = new Date(takenAt);
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + z(d.getMonth() + 1) + '/' + z(d.getDate());
  }

  /* 自動グループを手動アルバムに変換して編集画面を開く（同名があれば再利用） */
  function editAutoGroup(name, photos, close) {
    var proj = Projects.current();
    var sorted = photos.slice().sort(byDate);
    Storage.getAlbumsByProject(proj.id).then(function (albums) {
      var exist = albums.filter(function (a) { return a.name === name; })[0];
      if (exist) { close(); openEditor(exist.id); return; }
      createManual(name, sorted.map(function (p) { return p.id; })).then(function (al) {
        close(); openEditor(al.id);
      });
    });
  }

  function renderDateAlbums(wrap, photos, close) {
    var box = document.createElement('div');
    box.className = 'album-section';
    var groups = {};
    photos.forEach(function (p) { var k = dateKey(p.takenAt); (groups[k] = groups[k] || []).push(p); });
    // 日付なしは最後、それ以外は新しい日が上
    var keys = Object.keys(groups).sort(function (a, b) {
      if (a === '日付なし') return 1;
      if (b === '日付なし') return -1;
      return a < b ? 1 : (a > b ? -1 : 0);
    });
    var html = '<h3>撮影日ごと（自動）</h3>';
    if (!keys.length) {
      html += '<p class="note">写真がありません。</p>';
    } else {
      html += '<ul class="album-ul">' + keys.map(function (k) {
        return '<li class="album-item">' +
          '<div class="album-main"><b>' + UI.esc(k) + '</b>' +
          '<span class="album-sub">' + groups[k].length + ' 枚</span></div>' +
          '<div class="album-btns">' +
          '<button class="btn" data-editdate="' + UI.esc(k) + '">編集</button>' +
          '<button class="btn btn-primary" data-datekey="' + UI.esc(k) + '">写真帳を出力</button></div>' +
          '</li>';
      }).join('') + '</ul>';
    }
    box.innerHTML = html;
    wrap.appendChild(box);
    Array.prototype.forEach.call(box.querySelectorAll('[data-datekey]'), function (btn) {
      btn.onclick = function () {
        var k = btn.getAttribute('data-datekey');
        close(); outputPhotos(groups[k].slice(), '撮影日：' + k);
      };
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-editdate]'), function (btn) {
      btn.onclick = function () {
        var k = btn.getAttribute('data-editdate');
        editAutoGroup('撮影日：' + k, groups[k], close);
      };
    });
  }

  function renderManual(wrap, albums, close) {
    var box = document.createElement('div');
    box.className = 'album-section';
    var html = '<h3>手動アルバム</h3>';
    if (!albums.length) {
      html += '<p class="note">写真を選んで「選択をアルバムに保存」で作成できます。</p>';
    } else {
      html += '<ul class="album-ul">';
      albums.forEach(function (a) {
        html += '<li class="album-item" data-id="' + a.id + '">' +
          '<div class="album-main"><b>' + UI.esc(a.name) + '</b>' +
          '<span class="album-sub">写真 ' + photoCount(a) + ' 枚</span></div>' +
          '<div class="album-btns">' +
          '<button class="btn" data-act="edit" data-id="' + a.id + '">編集</button>' +
          '<button class="btn btn-primary" data-act="out" data-id="' + a.id + '">写真帳を出力</button>' +
          '<button class="btn btn-danger" data-act="del" data-id="' + a.id + '">削除</button>' +
          '</div></li>';
      });
      html += '</ul>';
    }
    box.innerHTML = html;
    wrap.appendChild(box);

    Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute('data-id');
        var album = albums.filter(function (x) { return x.id === id; })[0];
        if (!album) return;
        var act = btn.getAttribute('data-act');
        if (act === 'out') { close(); outputAlbum(album); }
        else if (act === 'edit') { close(); openEditor(id); }
        else {
          UI.confirm('アルバム「' + album.name + '」を削除しますか？（写真自体は消えません）', 'アルバムの削除')
            .then(function (ok) {
              if (!ok) return;
              Storage.delete('albums', id).then(function () {
                close(); UI.toast('削除しました');
                if (global.App.Photos) global.App.Photos.reload();
                openView();
              });
            });
        }
      };
    });
  }

  function renderAuto(wrap, photos, close) {
    var box = document.createElement('div');
    box.className = 'album-section';
    box.innerHTML = '<h3>自動グループ（分類項目でまとめて出力）</h3>' +
      '<div class="field"><span>まとめる項目</span>' +
      '<select id="autoField" class="input">' +
      Object.keys(FIELD_LABEL).map(function (k) {
        return '<option value="' + k + '">' + FIELD_LABEL[k] + '</option>';
      }).join('') + '</select></div>' +
      '<div id="autoList" class="auto-list"></div>';
    wrap.appendChild(box);

    var sel = box.querySelector('#autoField');
    var listEl = box.querySelector('#autoList');

    function renderGroups() {
      var field = sel.value;
      var groups = {};
      photos.forEach(function (p) {
        var v = (p[field] || '').trim();
        var key = v || '（未入力）';
        (groups[key] = groups[key] || []).push(p);
      });
      var keys = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
      if (!keys.length) { listEl.innerHTML = '<p class="note">写真がありません。</p>'; return; }
      listEl.innerHTML = '<ul class="album-ul">' + keys.map(function (k) {
        return '<li class="album-item">' +
          '<div class="album-main"><b>' + UI.esc(k) + '</b>' +
          '<span class="album-sub">' + groups[k].length + ' 枚</span></div>' +
          '<div class="album-btns">' +
          '<button class="btn" data-editkey="' + UI.esc(k) + '">編集</button>' +
          '<button class="btn btn-primary" data-key="' + UI.esc(k) + '">出力</button></div>' +
          '</li>';
      }).join('') + '</ul>';
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-key]'), function (btn) {
        btn.onclick = function () {
          var k = btn.getAttribute('data-key');
          outputPhotos(groups[k].slice(), FIELD_LABEL[field] + '：' + k);
        };
      });
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-editkey]'), function (btn) {
        btn.onclick = function () {
          var k = btn.getAttribute('data-editkey');
          editAutoGroup(FIELD_LABEL[field] + '：' + k, groups[k], close);
        };
      });
    }
    sel.onchange = renderGroups;
    renderGroups();
  }

  /* ===== アルバム編集画面 ===== */
  function openEditor(albumId) {
    var proj = Projects.current();
    var album = null, photoMap = {};
    var _editing = -1;   // インライン編集中の photo 行 index（-1=なし）
    var _dragFrom = null; // ドラッグ中の行 index
    var CLS = [['koushu', '工種'], ['shubetsu', '種別'], ['saibetsu', '細別'], ['kubun', '撮影区分'], ['spot', '撮影箇所']];

    var wrap = document.createElement('div');
    wrap.className = 'album-editor';
    var close = UI.modal(wrap, 'アルバムの編集');

    function reloadData() {
      return Promise.all([Storage.get('albums', albumId), Storage.getPhotosByProject(proj.id)])
        .then(function (res) {
          album = res[0];
          photoMap = {};
          res[1].forEach(function (p) { photoMap[p.id] = p; });
        });
    }

    function fmtShort(p) {
      var d = p.takenAt ? new Date(p.takenAt) : null;
      var ds = d ? (d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate()) : '日時なし';
      var cls = [p.koushu, p.spot].filter(Boolean).join(' / ');
      return ds + (cls ? '　' + cls : '') + (p.caption ? '　' + p.caption : '');
    }

    function insertBar(at) {
      return '<div class="ed-insert" data-at="' + at + '">' +
        '<button class="btn btn-sm" data-ins="text" data-at="' + at + '">＋ 見出し</button>' +
        '<button class="btn btn-sm" data-ins="blank" data-at="' + at + '">＋ 空欄</button></div>';
    }
    function editPanelHtml(p) {
      var HF = global.App.Photos.histField;
      var fields = CLS.map(function (c) { return HF(c[1], c[0], p[c[0]]); }).join('');
      return '<li class="ed-edit"><div class="ed-edit-fields">' + fields +
        '<label class="field"><span>説明（キャプション）</span>' +
        '<input data-name="caption" value="' + UI.esc(p.caption || '') + '"></label></div>' +
        '<div class="detail-actions">' +
        '<button class="btn" data-edit-cancel>閉じる</button>' +
        '<button class="btn btn-primary" data-edit-save="' + p.id + '">保存</button>' +
        '</div></li>';
    }

    function render() {
      if (!album) return;
      (wrap._thumbUrls || []).forEach(function (u) { URL.revokeObjectURL(u); });
      wrap._thumbUrls = [];
      var items = itemsOf(album);
      var thumbUrls = [];

      var rows = insertBar(0);
      items.forEach(function (it, i) {
        var up = '<button class="btn btn-sm" data-move="-1" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>↑</button>';
        var down = '<button class="btn btn-sm" data-move="1" data-i="' + i + '"' + (i === items.length - 1 ? ' disabled' : '') + '>↓</button>';
        var del = '<button class="btn btn-sm btn-danger" data-del="' + i + '">削除</button>';
        var body, editBtn = '';
        if (it.t === 'photo') {
          var p = photoMap[it.photoId];
          if (p) {
            var u = URL.createObjectURL(p.thumbBlob || p.blob); thumbUrls.push(u);
            body = '<img class="ed-thumb" src="' + u + '">' +
              '<div class="ed-info">' + UI.esc(fmtShort(p)) + '</div>';
            editBtn = '<button class="btn btn-sm" data-editrow="' + i + '">' + (i === _editing ? '閉じる' : '編集') + '</button>';
          } else {
            body = '<div class="ed-info ed-missing">（写真が見つかりません）</div>';
          }
        } else if (it.t === 'text') {
          body = '<input class="ed-text input" data-text="' + i + '" value="' + UI.esc(it.text || '') + '" placeholder="見出し・メモを入力">';
        } else {
          body = '<div class="ed-info ed-blank">（空欄コマ：印刷後に手書き用）</div>';
        }
        rows += '<li class="ed-row ed-' + it.t + '" draggable="true" data-i="' + i + '">' +
          '<div class="ed-move"><span class="ed-grip" title="ドラッグで移動">⠿</span>' + up + down + '</div>' +
          '<div class="ed-body">' + body + '</div>' +
          '<div class="ed-act">' + editBtn + del + '</div></li>';
        if (it.t === 'photo' && i === _editing && photoMap[it.photoId]) rows += editPanelHtml(photoMap[it.photoId]);
        rows += insertBar(i + 1);
      });

      wrap.innerHTML =
        '<div class="ed-head">' +
        '<b>' + UI.esc(album.name) + '</b>' +
        '<div class="ed-head-btns">' +
        '<button class="btn" id="edRename">名称変更</button>' +
        '<button class="btn btn-primary" id="edOut">写真帳を出力</button>' +
        '</div></div>' +
        '<p class="note">行間の「＋見出し／＋空欄」で任意の位置に挿入。行はドラッグ（⠿）や ↑↓ で並べ替え。写真の「編集」で分類・説明をその場で変更できます。</p>' +
        '<ul class="ed-ul">' + rows + '</ul>';

      wrap._thumbUrls = thumbUrls;
      if (global.App.Photos.wireHistory) global.App.Photos.wireHistory(wrap);
      wireEditor(items);
    }

    function persistAndRender() { return save(album).then(render); }

    function moveItem(from, to) {
      var arr = itemsOf(album).slice();
      var it = arr.splice(from, 1)[0];
      if (from < to) to--;
      arr.splice(to, 0, it);
      album.items = arr; _editing = -1; persistAndRender();
    }
    function insertAt(at, item) {
      var arr = itemsOf(album).slice();
      arr.splice(at, 0, item);
      album.items = arr;
      if (_editing >= at) _editing++;
      persistAndRender();
    }

    function wireEditor(items) {
      wrap.querySelector('#edRename').onclick = function () {
        UI.prompt('アルバム名の変更', [{ name: 'name', label: 'アルバム名', value: album.name }]).then(function (v) {
          if (!v || !v.name) return; album.name = v.name; persistAndRender();
        });
      };
      wrap.querySelector('#edOut').onclick = function () { close(); outputAlbum(album); };

      // 任意位置に挿入
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-ins]'), function (btn) {
        btn.onclick = function () {
          var at = +btn.getAttribute('data-at'), kind = btn.getAttribute('data-ins');
          insertAt(at, kind === 'text' ? { t: 'text', text: '' } : { t: 'blank' });
        };
      });
      // ↑↓
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-move]'), function (btn) {
        btn.onclick = function () {
          var i = +btn.getAttribute('data-i'), d = +btn.getAttribute('data-move');
          if (i + d < 0 || i + d >= itemsOf(album).length) return;
          moveItem(i, i + d + (d > 0 ? 1 : 0));
        };
      });
      // 行削除
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-del]'), function (btn) {
        btn.onclick = function () {
          var i = +btn.getAttribute('data-del');
          var arr = itemsOf(album).slice(); arr.splice(i, 1);
          album.items = arr; _editing = -1; persistAndRender();
        };
      });
      // 見出し行のインライン入力
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-text]'), function (inp) {
        inp.onchange = function () {
          var i = +inp.getAttribute('data-text');
          var arr = itemsOf(album).slice(); arr[i] = { t: 'text', text: inp.value };
          album.items = arr; save(album);
        };
      });
      // 写真行の「編集」トグル
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-editrow]'), function (btn) {
        btn.onclick = function () {
          var i = +btn.getAttribute('data-editrow');
          _editing = (i === _editing) ? -1 : i;
          render();
        };
      });
      // インライン編集：キャンセル
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-edit-cancel]'), function (btn) {
        btn.onclick = function () { _editing = -1; render(); };
      });
      // インライン編集：保存（写真自体に反映＋Undo記録）
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-edit-save]'), function (btn) {
        btn.onclick = function () {
          var pid = btn.getAttribute('data-edit-save'), p = photoMap[pid];
          if (!p) return;
          var panel = btn.closest('.ed-edit');
          var before = global.App.Undo ? global.App.Undo.snapshot(p) : Object.assign({}, p);
          Array.prototype.forEach.call(panel.querySelectorAll('[data-name]'), function (el) { p[el.getAttribute('data-name')] = el.value.trim(); });
          Storage.put('photos', p).then(function () {
            if (global.App.History) global.App.History.addFromPhoto(p);
            if (global.App.Undo) global.App.Undo.record([{ key: p.id, before: before, after: global.App.Undo.snapshot(p) }]);
            if (global.App.Photos) global.App.Photos.reload();
            UI.toast('保存しました');
            _editing = -1;
            return reloadData().then(render);
          });
        };
      });
      // ドラッグ並べ替え：行を掴んで挿入バーへ落とす
      Array.prototype.forEach.call(wrap.querySelectorAll('.ed-row'), function (row) {
        row.addEventListener('dragstart', function (e) { _dragFrom = +row.getAttribute('data-i'); row.classList.add('dragging'); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'row'); } catch (_) {} });
        row.addEventListener('dragend', function () { _dragFrom = null; row.classList.remove('dragging'); Array.prototype.forEach.call(wrap.querySelectorAll('.ed-insert.over'), function (el) { el.classList.remove('over'); }); });
      });
      Array.prototype.forEach.call(wrap.querySelectorAll('.ed-insert'), function (bar) {
        bar.addEventListener('dragover', function (e) { if (_dragFrom == null) return; e.preventDefault(); bar.classList.add('over'); });
        bar.addEventListener('dragleave', function () { bar.classList.remove('over'); });
        bar.addEventListener('drop', function (e) { if (_dragFrom == null) return; e.preventDefault(); bar.classList.remove('over'); moveItem(_dragFrom, +bar.getAttribute('data-at')); });
      });
    }

    reloadData().then(render);
  }

  global.App = global.App || {};
  global.App.Albums = {
    createManual: createManual, openView: openView, openEditor: openEditor,
    outputAlbum: outputAlbum, photoIdSet: photoIdSet, itemsOf: itemsOf
  };
})(window);
