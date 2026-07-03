/* photos.js  ---  写真の取り込み・サムネイル一覧・分類・検索
   工事(案件)単位で写真を管理する画面。 */
(function (global) {
  'use strict';
  var Storage = global.App.Storage;
  var UI = global.App.UI;
  var Exif = global.App.Exif;
  var Projects = global.App.Projects;
  var History = global.App.History;

  var _photos = [];             // 現在工事の写真一覧
  var _objectUrls = [];         // 生成した object URL（再描画時に解放）
  var _container = null;
  var _sidebar = null;          // 左サイドバー（分類フィルタ）
  var _filters = { keyword: '', sort: 'date_asc' };
  // 左サイドバーのチェック式フィルタ（各値=選択集合）。同分類 OR・別分類 AND
  var _facets = { date: {}, koushu: {}, kubun: {}, shubetsu: {}, saibetsu: {}, spot: {} };
  var _selected = {};           // 選択中の写真ID（set 代わりのオブジェクト）
  var _inAlbum = {};            // いずれかのアルバムに含まれる写真ID
  var _shown = [];              // 現在表示中（絞り込み後）の並び。範囲選択で使用
  var _lastIndex = null;        // 直近にトグルした表示位置（Shift 範囲選択の起点）
  var _groupByDate = false;     // 撮影日でまとめて表示
  var _drafts = {};             // 編集途中（下書き）がある写真ID
  var _dragIds = null;          // ドラッグ中の写真ID配列（サイドバーへD&Dで分類反映）
  var _keywordTimer = null;     // キーワード検索の再描画デバウンス
  var _regCombos = [];          // 呼び出した分類の組合せ（写真に紐づかない・件数0でサイドバー表示）

  function regFacetKey(id) { return 'regFacets_' + id; }

  // Undo/Redo 用の写真レコードのスナップショット・記録（call-time で App.Undo 参照）
  function snap(p) { return global.App.Undo ? global.App.Undo.snapshot(p) : Object.assign({}, p); }
  function undoRecord(changes) { if (global.App.Undo) global.App.Undo.record(changes); }

  function selectedCount() { return Object.keys(_selected).length; }
  function selectedPhotos() {
    return _photos.filter(function (p) { return _selected[p.id]; });
  }
  function datalist(name) {
    var id = 'dl_' + name;
    var opts = (History ? History.list(name) : []).map(function (o) {
      return '<option value="' + UI.esc(o) + '">';
    }).join('');
    return '<datalist id="' + id + '">' + opts + '</datalist>';
  }

  /* 履歴付き入力欄（文字が入っていても▼で全履歴から選べる）。data-name で読み取り */
  function histFieldHtml(label, name, value, placeholder) {
    placeholder = placeholder || '入力または履歴から選択';
    return '<label class="field"><span>' + UI.esc(label) + '</span>' +
      '<div class="field-input">' +
      '<input data-name="' + name + '" value="' + UI.esc(value || '') + '" list="dl_' + name + '" placeholder="' + UI.esc(placeholder) + '">' +
      '<button type="button" class="btn hist-btn" data-hist="' + name + '" title="履歴から選ぶ">▼</button>' +
      datalist(name) + '</div></label>';
  }

  var _histPop = null;
  function closeHistPop() {
    if (_histPop && _histPop.parentNode) _histPop.parentNode.removeChild(_histPop);
    _histPop = null;
    document.removeEventListener('mousedown', _histDocDown, true);
    document.removeEventListener('keydown', _histKey, true);
  }
  function _histDocDown(e) { if (_histPop && !_histPop.contains(e.target) && !(e.target.classList && e.target.classList.contains('hist-btn'))) closeHistPop(); }
  function _histKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeHistPop(); } }
  function openHistPop(btn) {
    closeHistPop();
    var name = btn.getAttribute('data-hist');
    var input = btn.parentNode.querySelector('input[data-name="' + name + '"]');
    var list = History ? History.list(name) : [];
    if (!list.length) { UI.toast('まだ履歴がありません'); return; }
    var pop = document.createElement('div');
    pop.className = 'hist-pop';
    pop.innerHTML = list.map(function (v) { return '<div class="hist-item">' + UI.esc(v) + '</div>'; }).join('');
    btn.parentNode.appendChild(pop); // .field-input(position:relative)
    _histPop = pop;
    Array.prototype.forEach.call(pop.querySelectorAll('.hist-item'), function (el) {
      el.onmousedown = function (e) { // blur より先に確定
        e.preventDefault();
        input.value = el.textContent;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        closeHistPop();
        input.focus();
      };
    });
    setTimeout(function () {
      document.addEventListener('mousedown', _histDocDown, true);
      document.addEventListener('keydown', _histKey, true);
    }, 0);
  }
  /* scope 内の ▼履歴ボタンを配線 */
  function wireHistory(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll('.hist-btn'), function (btn) {
      btn.onclick = function (e) { e.preventDefault(); openHistPop(btn); };
    });
  }

  function revokeUrls() {
    _objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    _objectUrls = [];
  }
  function thumbUrl(blob) { var u = URL.createObjectURL(blob); _objectUrls.push(u); return u; }

  /* ---- 取り込み ---- */
  function dupKey(name, size, takenAt) { return (name || '') + '|' + (size || 0) + '|' + (takenAt || ''); }

  function importFiles(fileList) {
    var proj = Projects.current();
    if (!proj) { UI.alert('先に工事を作成・選択してください。', '工事が未選択'); return Promise.resolve(); }
    var files = Array.prototype.slice.call(fileList).filter(function (f) {
      return f.type && f.type.indexOf('image/') === 0;
    });
    if (!files.length) { UI.alert('画像ファイルが選択されていません。', '取り込み'); return Promise.resolve(); }

    var busy0 = UI.busy('写真を確認中…');
    // 先に EXIF を読み、既存写真と「ファイル名＋サイズ＋撮影日時」で重複判定
    return Promise.all([
      Storage.getPhotosByProject(proj.id),
      Promise.all(files.map(function (f) {
        return Exif.readMeta(f).then(function (m) {
          return { file: f, meta: m, key: dupKey(f.name, f.size, m.takenAt) };
        });
      }))
    ]).then(function (res) {
      var existing = res[0], prepared = res[1];
      var existKeys = {};
      existing.forEach(function (p) { existKeys[dupKey(p.fileName, p.blob && p.blob.size, p.takenAt)] = true; });
      var dupCount = prepared.filter(function (x) { return existKeys[x.key]; }).length;
      busy0.close();

      if (!dupCount) return doImport(prepared, proj, 0);

      return UI.choose(
        dupCount + ' 枚は取込み済みの可能性があります（ファイル名・サイズ・撮影日時が一致）。どうしますか？',
        '取込み済みの確認',
        [
          { key: 'all', label: '重複も取り込む', primary: true },
          { key: 'skip', label: '取込み済みを除いて取り込む' },
          { key: 'cancel', label: 'キャンセル' }
        ]
      ).then(function (choice) {
        if (!choice || choice === 'cancel') return;
        var toImport = (choice === 'all') ? prepared
          : prepared.filter(function (x) { return !existKeys[x.key]; });
        if (!toImport.length) { UI.toast('すべて取込み済みのため取り込みませんでした'); return; }
        return doImport(toImport, proj, prepared.length - toImport.length);
      });
    }).catch(function (e) {
      busy0.close();
      UI.alert('取り込み中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
    });
  }

  /* prepared: [{file,meta,key}] を直列で保存（先読みした meta を再利用） */
  function doImport(prepared, proj, skipped) {
    var busy = UI.busy('写真を取り込み中… (0/' + prepared.length + ')');
    var done = 0;
    return prepared.reduce(function (chain, x) {
      return chain.then(function () {
        return Exif.makeThumbnail(x.file, 480).then(function (thumb) {
          return Storage.put('photos', {
            id: Storage.newId('ph'),
            projectId: proj.id,
            fileName: x.file.name,
            blob: x.file,                 // 原本（無加工）
            thumbBlob: thumb,
            takenAt: x.meta.takenAt,
            lat: x.meta.lat, lng: x.meta.lng,
            koushu: '', shubetsu: '', saibetsu: '',
            kubun: '', spot: '', caption: '',
            importedAt: Date.now()
          });
        }).then(function () { done++; busy.update('写真を取り込み中… (' + done + '/' + prepared.length + ')'); });
      });
    }, Promise.resolve()).then(function () {
      busy.close();
      UI.toast(done + ' 枚を取り込みました' + (skipped ? '（' + skipped + ' 枚は取込み済みでスキップ）' : ''));
      return reload();
    }).catch(function (e) {
      busy.close();
      UI.alert('取り込み中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
    });
  }

  function reload() {
    var proj = Projects.current();
    if (!proj) { _photos = []; _inAlbum = {}; _drafts = {}; render(); return Promise.resolve(); }
    return Promise.all([
      Storage.getPhotosByProject(proj.id),
      Storage.getAlbumsByProject(proj.id),
      Storage.getAll('settings')
    ]).then(function (res) {
      _photos = res[0];
      _inAlbum = global.App.Albums ? global.App.Albums.photoIdSet(res[1]) : {};
      _drafts = {};
      _regCombos = [];
      var regKey = regFacetKey(proj.id);
      (res[2] || []).forEach(function (row) {
        if (row.key && row.key.indexOf(DRAFT_PREFIX) === 0) _drafts[row.key.slice(DRAFT_PREFIX.length)] = true;
        if (row.key === regKey && Array.isArray(row.value)) _regCombos = row.value;
      });
      render();
    });
  }

  var DRAFT_PREFIX = 'draft_photo_';
  function draftKey(id) { return DRAFT_PREFIX + id; }
  function dateKey(takenAt) {
    if (!takenAt) return '日付なし';
    var d = new Date(takenAt);
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + z(d.getMonth() + 1) + '/' + z(d.getDate());
  }
  /* ---- 左サイドバーのチェック式フィルタ（facet） ---- */
  // 表示順。撮影区分→種別→細別→撮影箇所は連動ツリー（parents の選択で下位候補を制限）
  // 連動ツリー：撮影区分 → 工種 → 種別 → 細別 → 撮影箇所（撮影日は独立）
  var FACETS = [
    { field: 'date', label: '撮影日', parents: [] },
    { field: 'kubun', label: '撮影区分', parents: [] },
    { field: 'koushu', label: '工種', parents: ['kubun'] },
    { field: 'shubetsu', label: '種別', parents: ['kubun', 'koushu'] },
    { field: 'saibetsu', label: '細別', parents: ['kubun', 'koushu', 'shubetsu'] },
    { field: 'spot', label: '撮影箇所', parents: ['kubun', 'koushu', 'shubetsu', 'saibetsu'] }
  ];
  function facetDef(field) { for (var i = 0; i < FACETS.length; i++) if (FACETS[i].field === field) return FACETS[i]; }
  function facetVal(field, p) { return field === 'date' ? dateKey(p.takenAt) : (p[field] || '').trim(); }

  // 上位（parents）の選択に一致する写真だけを対象に（連動）
  function photosForFacet(field) {
    var f = facetDef(field);
    return _photos.filter(function (p) {
      return f.parents.every(function (pf) {
        var sel = _facets[pf], keys = Object.keys(sel);
        return !keys.length || sel[facetVal(pf, p)];
      });
    });
  }
  // 集計対象の行：実写真(_count:1) ＋ 呼び出した分類(_count:0)
  function facetRows() {
    var rows = _photos.map(function (p) { return { r: p, _count: 1 }; });
    _regCombos.forEach(function (c) { rows.push({ r: c, _count: 0 }); });
    return rows;
  }
  // 上位選択に一致する行だけ（写真＋登録分類を同じ土俵で連動）
  function rowsForFacet(field) {
    var f = facetDef(field);
    return facetRows().filter(function (row) {
      return f.parents.every(function (pf) {
        var sel = _facets[pf], keys = Object.keys(sel);
        return !keys.length || sel[facetVal(pf, row.r)];
      });
    });
  }
  // その facet に出す値（記入済みのみ・件数付き・並び）。登録分類は件数0でも一覧に含める
  function facetValues(field) {
    if (field === 'date') {
      // 撮影日は写真のみ（登録分類は日付を持たない）
      var dcounts = {};
      photosForFacet('date').forEach(function (p) {
        dcounts[facetVal('date', p)] = (dcounts[facetVal('date', p)] || 0) + 1;
      });
      var dkeys = Object.keys(dcounts);
      dkeys.sort(function (a, b) { if (a === '日付なし') return 1; if (b === '日付なし') return -1; return a < b ? 1 : (a > b ? -1 : 0); });
      return dkeys.map(function (k) { return { value: k, count: dcounts[k] }; });
    }
    var counts = {}, present = {};
    rowsForFacet(field).forEach(function (row) {
      var v = facetVal(field, row.r);
      if (!v) return; // 記入済みのみ（空文字は除外）
      present[v] = true;
      counts[v] = (counts[v] || 0) + (row._count || 0);
    });
    var keys = Object.keys(present);
    keys.sort(function (a, b) { return a.localeCompare(b, 'ja'); });
    return keys.map(function (k) { return { value: k, count: counts[k] || 0 }; });
  }
  // 上位変更で候補から消えた下位のチェックを解除（parents 先→子の順で処理）
  function pruneFacets() {
    FACETS.forEach(function (f) {
      var avail = {};
      facetValues(f.field).forEach(function (o) { avail[o.value] = true; });
      Object.keys(_facets[f.field]).forEach(function (v) { if (!avail[v]) delete _facets[f.field][v]; });
    });
  }
  function anyFacetSelected() {
    return FACETS.some(function (f) { return Object.keys(_facets[f.field]).length; });
  }

  /* ---- 絞り込み・並べ替え ---- */
  function applyFilters(list) {
    var f = _filters;
    var out = list.filter(function (p) {
      // 分類フィルタ：チェックがある分類は OR 一致、全分類 AND
      for (var i = 0; i < FACETS.length; i++) {
        var field = FACETS[i].field, sel = _facets[field];
        if (Object.keys(sel).length && !sel[facetVal(field, p)]) return false;
      }
      if (f.keyword) {
        var hay = [p.koushu, p.shubetsu, p.saibetsu, p.kubun, p.spot, p.caption, p.fileName]
          .join(' ').toLowerCase();
        if (hay.indexOf(f.keyword.toLowerCase()) < 0) return false;
      }
      return true;
    });
    out.sort(function (a, b) {
      var av = a.takenAt || a.importedAt, bv = b.takenAt || b.importedAt;
      return f.sort === 'date_desc' ? bv - av : av - bv;
    });
    return out;
  }

  /* ---- 左サイドバー描画 ---- */
  function renderSidebar() {
    if (!_sidebar) return;
    var proj = Projects.current();
    if (!proj) { _sidebar.innerHTML = ''; return; }
    // 見出し（呼び出し・クリア等のボタンは常時）
    var head = '<div class="side-head"><b>絞り込み</b>' +
      '<button class="btn btn-sm" id="facetRecall" title="以前の工事の分類をここに並べます">分類を呼び出す</button>' +
      (_regCombos.length ? '<button class="btn btn-sm" id="facetRecallClear" title="呼び出した分類を消す">呼出しを消す</button>' : '') +
      (anyFacetSelected() ? '<button class="btn btn-sm" id="facetClear">クリア</button>' : '') +
      '</div>';
    // 写真も呼び出し分類も無ければ案内文（＋見出しの呼び出しボタンは出す）
    if (!_photos.length && !_regCombos.length) {
      _sidebar.innerHTML = head +
        '<div class="side-empty">写真を取り込むか、「分類を呼び出す」で以前の工事の分類をここに並べられます。</div>';
      wireSidebarHead();
      return;
    }
    var html = head;
    FACETS.forEach(function (f) {
      var vals = facetValues(f.field);
      if (!vals.length) return; // 記入済みが無ければ非表示
      var depth = f.parents.length; // 階層の深さで字下げ
      html += '<div class="facet' + (depth ? ' facet-child' : '') + '" style="margin-left:' + (depth * 14) + 'px">';
      html += '<div class="facet-label">' + UI.esc(f.label) + '</div>';
      var droppable = f.field !== 'date'; // 撮影日はEXIF由来のためドロップ反映しない
      html += vals.map(function (o) {
        var checked = _facets[f.field][o.value] ? ' checked' : '';
        var dropAttr = droppable ? ' data-drop-field="' + f.field + '" data-drop-val="' + UI.esc(o.value) + '"' : '';
        return '<label class="facet-row' + (droppable ? ' droppable' : '') + '"' + dropAttr + '><input type="checkbox" data-facet="' + f.field + '" data-val="' + UI.esc(o.value) + '"' + checked + '>' +
          '<span class="fv">' + UI.esc(o.value) + '</span><span class="fc">' + o.count + '</span></label>';
      }).join('');
      html += '</div>';
    });
    _sidebar.innerHTML = html;

    wireSidebarHead();
    Array.prototype.forEach.call(_sidebar.querySelectorAll('[data-facet]'), function (cb) {
      cb.onchange = function () {
        var field = cb.getAttribute('data-facet'), val = cb.getAttribute('data-val');
        if (cb.checked) _facets[field][val] = true; else delete _facets[field][val];
        render();
      };
    });
    // 写真をドロップして分類を反映
    Array.prototype.forEach.call(_sidebar.querySelectorAll('.facet-row.droppable'), function (row) {
      row.addEventListener('dragover', function (e) {
        if (!_dragIds) return;                 // アプリ内の写真ドラッグ時のみ反応
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        row.classList.add('drop-hover');
      });
      row.addEventListener('dragleave', function () { row.classList.remove('drop-hover'); });
      row.addEventListener('drop', function (e) {
        if (!_dragIds) return;
        e.preventDefault();
        row.classList.remove('drop-hover');
        applyDrop(row.getAttribute('data-drop-field'), row.getAttribute('data-drop-val'));
      });
    });
  }

  /* サイドバー見出しのボタン配線（クリア／分類を呼び出す／呼出しを消す） */
  function wireSidebarHead() {
    var clr = document.getElementById('facetClear');
    if (clr) clr.onclick = function () { FACETS.forEach(function (f) { _facets[f.field] = {}; }); render(); };
    var rec = document.getElementById('facetRecall');
    if (rec) rec.onclick = openRecallFacets;
    var rcl = document.getElementById('facetRecallClear');
    if (rcl) rcl.onclick = clearRecalledFacets;
  }

  /* 呼び出した分類の重複キー（5フィールドの組合せ） */
  function comboKey(c) {
    return [c.kubun || '', c.koushu || '', c.shubetsu || '', c.saibetsu || '', c.spot || ''].join('');
  }

  /* 以前の工事の分類を呼び出してサイドバーに登録（写真は取り込まない） */
  function openRecallFacets() {
    var cur = Projects.current();
    if (!cur) { UI.alert('先に工事を選択してください。', '分類を呼び出す'); return; }
    Projects.list().then(function (all) {
      var others = all.filter(function (pj) { return pj.id !== cur.id; });
      if (!others.length) { UI.alert('呼び出せる他の工事がありません。', '分類を呼び出す'); return; }
      var wrap = document.createElement('div');
      wrap.className = 'detail-form';
      var opts = '<option value="">（分類を呼び出す工事を選択）</option>';
      others.forEach(function (pj) { opts += '<option value="' + UI.esc(pj.id) + '">' + UI.esc(pj.name) + '</option>'; });
      wrap.innerHTML =
        '<p class="note">選んだ工事で使われている分類（工種・種別・細別・撮影区分・撮影場所）を、この工事のサイドバーに並べます（写真は取り込みません）。</p>' +
        '<label class="field"><span>呼び出す工事</span><select id="rcTarget">' + opts + '</select></label>' +
        '<div class="detail-actions"><button class="btn btn-primary btn-lg" id="rcApply">呼び出す</button></div>';
      var close = UI.modal(wrap, '分類を呼び出す');
      wrap.querySelector('#rcApply').onclick = function () {
        var srcId = wrap.querySelector('#rcTarget').value;
        if (!srcId) { UI.alert('工事を選んでください。', '分類を呼び出す'); return; }
        var busy = UI.busy('分類を読み込み中…');
        Storage.getPhotosByProject(srcId).then(function (photos) {
          // 既存の登録分類 ＋ 元工事の組合せ を和集合
          var seen = {}, merged = [];
          _regCombos.forEach(function (c) { var k = comboKey(c); if (!seen[k]) { seen[k] = true; merged.push(c); } });
          var added = 0;
          photos.forEach(function (p) {
            var c = {
              kubun: (p.kubun || '').trim(), koushu: (p.koushu || '').trim(),
              shubetsu: (p.shubetsu || '').trim(), saibetsu: (p.saibetsu || '').trim(),
              spot: (p.spot || '').trim()
            };
            if (!c.kubun && !c.koushu && !c.shubetsu && !c.saibetsu && !c.spot) return; // 全空は除外
            var k = comboKey(c);
            if (seen[k]) return;
            seen[k] = true; merged.push(c); added++;
          });
          return Storage.setSetting(regFacetKey(cur.id), merged).then(function () {
            _regCombos = merged;
            busy.close(); close();
            UI.toast(added ? ('分類を呼び出しました（' + added + '件を追加）') : '追加された分類はありませんでした');
            render();
          });
        }).catch(function (e) {
          busy.close();
          UI.alert('呼び出し中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
        });
      };
    });
  }

  /* 呼び出した分類をこの工事から消す（写真・分類データには影響しない） */
  function clearRecalledFacets() {
    var cur = Projects.current();
    if (!cur) return;
    if (!_regCombos.length) return;
    UI.confirm('呼び出した分類をサイドバーから消しますか？（写真や写真に付けた分類は変わりません）', '呼出しを消す').then(function (ok) {
      if (!ok) return;
      Storage.setSetting(regFacetKey(cur.id), []).then(function () {
        _regCombos = [];
        // 消えた分類にチェックが残っていれば掃除
        FACETS.forEach(function (f) { _facets[f.field] = _facets[f.field] || {}; });
        UI.toast('呼び出した分類を消しました');
        render();
      });
    });
  }

  function fmtDate(ms) {
    if (!ms) return '日時なし';
    var d = new Date(ms);
    function z(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '/' + z(d.getMonth() + 1) + '/' + z(d.getDate()) +
      ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  }

  /* 1枚のカード HTML。idx は表示順の連番（Shift 範囲選択で使用） */
  function cardHtml(p, idx) {
    var badge = p.kubun ? '<span class="badge">' + UI.esc(p.kubun) + '</span>' : '';
    var gps = (p.lat != null && p.lng != null) ? '<span class="gps" title="位置情報あり">📍</span>' : '';
    var alb = _inAlbum[p.id] ? '<span class="album-mark" title="アルバム取込み済み">アルバム済</span>' : '';
    var draft = _drafts[p.id] ? '<span class="draft-mark" title="編集途中の下書きがあります">下書き</span>' : '';
    var checked = _selected[p.id] ? ' checked' : '';
    var pick = '<label class="pick" data-id="' + p.id + '" data-index="' + idx + '"><input type="checkbox"' + checked + '></label>';
    var delBtn = '<button class="card-del" data-del-id="' + p.id + '" title="この写真を削除">✕</button>';
    return '<div class="card' + (_selected[p.id] ? ' selected' : '') + '" data-id="' + p.id + '" draggable="true">' +
      '<div class="thumb"><img loading="lazy" src="' + thumbUrl(p.thumbBlob || p.blob) + '">' + badge + gps + alb + draft + pick + delBtn + '</div>' +
      '<div class="cap">' + fmtDate(p.takenAt) + '</div>' +
      '<div class="cap sub">' + UI.esc(p.spot || p.caption || p.koushu || '（未分類）') + '</div>' +
      '</div>';
  }

  function countByDate(list, key) {
    var n = 0; list.forEach(function (p) { if (dateKey(p.takenAt) === key) n++; }); return n;
  }

  /* 撮影日ごとに見出し＋グリッドを組み立てる。data-index は全体連番 */
  function buildGroupedGrid(shown) {
    var html = '', idx = 0, curKey = null, open = false;
    shown.forEach(function (p) {
      var k = dateKey(p.takenAt);
      if (k !== curKey) {
        if (open) { html += '</div>'; }
        curKey = k;
        html += '<div class="date-head"><span class="date-label">' + UI.esc(k) + '</span>' +
          '<span class="date-count">' + countByDate(shown, k) + ' 枚</span>' +
          '<button class="btn btn-sm" data-dsel="' + UI.esc(k) + '">この日を選択／解除</button></div>';
        html += '<div class="grid">';
        open = true;
      }
      html += cardHtml(p, idx); idx++;
    });
    if (open) html += '</div>';
    return html;
  }

  /* ---- 描画 ---- */
  function render() {
    if (!_container) return;
    revokeUrls();
    var proj = Projects.current();
    if (!proj) {
      _container.innerHTML = '<div class="empty">左上の「工事」から工事を作成・選択してください。</div>';
      if (_sidebar) _sidebar.innerHTML = '';
      return;
    }
    // 分類フィルタ：連動で無効になった下位選択を掃除してからサイドバー再描画
    pruneFacets();
    renderSidebar();

    var shown = applyFilters(_photos);
    _shown = shown;

    var html = '';
    // 固定される操作バー（ツールバー＋選択バー）
    html += '<div class="main-controls">';
    // ツールバー
    html += '<div class="toolbar">';
    html += '<button class="btn btn-primary btn-lg" id="btnImport">＋ 写真を取り込む</button>';
    html += '<input id="fKeyword" class="input" placeholder="キーワード検索（工種・測点・内容…）" value="' + UI.esc(_filters.keyword) + '">';
    html += '<select id="fSort" class="input">' +
      '<option value="date_asc"' + (_filters.sort === 'date_asc' ? ' selected' : '') + '>撮影日時：古い順</option>' +
      '<option value="date_desc"' + (_filters.sort === 'date_desc' ? ' selected' : '') + '>撮影日時：新しい順</option>' +
      '</select>';
    html += '<label class="toggle"><input type="checkbox" id="fGroupDate"' + (_groupByDate ? ' checked' : '') + '> 日付でまとめる</label>';
    html += '<span class="count">' + shown.length + ' / ' + _photos.length + ' 枚</span>';
    html += '</div>';

    // 選択バー
    if (_photos.length) {
      html += '<div class="selbar">' +
        '<button class="btn" id="btnSelAll">表示中を全選択</button>' +
        '<button class="btn" id="btnSelClear">選択解除</button>' +
        '<span class="selcount">選択 <b id="selCount">' + selectedCount() + '</b> 枚</span>' +
        '<span class="selhint">（Shift＋クリックで範囲選択）</span>' +
        '<button class="btn" id="btnSelEdit">選択をまとめて入力</button>' +
        '<button class="btn btn-primary" id="btnSelExport">選択した写真で写真帳</button>' +
        '<button class="btn" id="btnSelAlbum">選択をアルバムに保存</button>' +
        '<button class="btn" id="btnSelMoveCopy">別の工事へコピー／移動</button>' +
        '<button class="btn btn-danger" id="btnSelDelete">選択を削除</button>' +
        '</div>';
    }
    html += '</div>'; // .main-controls（固定バー）ここまで

    // グリッド
    if (!_photos.length) {
      html += '<div class="empty">まだ写真がありません。「＋ 写真を取り込む」から追加してください。</div>';
    } else if (_groupByDate) {
      html += buildGroupedGrid(shown);
    } else {
      html += '<div class="grid">';
      shown.forEach(function (p, idx) { html += cardHtml(p, idx); });
      html += '</div>';
    }

    // キーワード入力中はフォーカス／キャレット位置を控えておく（再描画で外れないように）
    var ae = document.activeElement;
    var keepKey = ae && ae.id === 'fKeyword';
    var caret = keepKey ? { s: ae.selectionStart, e: ae.selectionEnd } : null;

    _container.innerHTML = html;

    // イベント
    var imp = document.getElementById('btnImport');
    if (imp) imp.onclick = pickFiles;
    var fkey = document.getElementById('fKeyword');
    if (fkey) {
      // 連続入力で止まらないよう、値は即時反映・再描画はデバウンス
      fkey.oninput = function () {
        _filters.keyword = fkey.value;
        if (_keywordTimer) clearTimeout(_keywordTimer);
        _keywordTimer = setTimeout(function () { _keywordTimer = null; render(); }, 200);
      };
      // 再描画直後にフォーカス／キャレットを復元
      if (keepKey) {
        fkey.focus();
        try { fkey.setSelectionRange(caret.s, caret.e); } catch (e) {}
      }
    }
    var fs = document.getElementById('fSort');
    if (fs) fs.onchange = function () { _filters.sort = fs.value; render(); };
    var fg = document.getElementById('fGroupDate');
    if (fg) fg.onchange = function () { _groupByDate = fg.checked; render(); };

    // 日付見出しの「この日を選択／解除」
    Array.prototype.forEach.call(_container.querySelectorAll('[data-dsel]'), function (btn) {
      btn.onclick = function () {
        var key = btn.getAttribute('data-dsel');
        var group = _shown.filter(function (p) { return dateKey(p.takenAt) === key; });
        var allOn = group.every(function (p) { return _selected[p.id]; });
        group.forEach(function (p) { if (allOn) delete _selected[p.id]; else _selected[p.id] = true; });
        render();
      };
    });

    // 選択バー
    wireSelbar(shown);

    // カードの✕削除（詳細を開かず1枚削除）
    Array.prototype.forEach.call(_container.querySelectorAll('.card-del'), function (btn) {
      btn.onclick = function (e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-del-id');
        var ph = _photos.filter(function (x) { return x.id === id; })[0];
        if (ph) deletePhotos([ph]);
      };
    });

    // チェックボックス（選択トグル。カード本体クリックとは分離）
    Array.prototype.forEach.call(_container.querySelectorAll('.pick'), function (label) {
      label.onclick = function (e) { e.stopPropagation(); };
      var cb = label.querySelector('input');
      cb.onclick = function (e) {
        var idx = +label.getAttribute('data-index');
        var id = label.getAttribute('data-id');
        if (e.shiftKey && _lastIndex != null) {
          // 範囲選択：起点〜今回を、今クリックした状態に合わせる
          var a = Math.min(_lastIndex, idx), b = Math.max(_lastIndex, idx), on = cb.checked;
          for (var k = a; k <= b; k++) {
            var pid = _shown[k] && _shown[k].id;
            if (!pid) continue;
            if (on) _selected[pid] = true; else delete _selected[pid];
          }
          _lastIndex = idx;
          render();
          return;
        }
        if (cb.checked) _selected[id] = true; else delete _selected[id];
        var card = _container.querySelector('.card[data-id="' + id + '"]');
        if (card) card.classList.toggle('selected', cb.checked);
        var sc = document.getElementById('selCount');
        if (sc) sc.textContent = selectedCount();
        _lastIndex = idx;
      };
    });

    Array.prototype.forEach.call(_container.querySelectorAll('.card'), function (card) {
      card.onclick = function () {
        var id = card.getAttribute('data-id');
        var ph = _photos.filter(function (x) { return x.id === id; })[0];
        if (ph) openDetail(ph);
      };
      // ドラッグ：選択中ならその選択写真すべて、そうでなければこの1枚
      card.addEventListener('dragstart', function (e) {
        var id = card.getAttribute('data-id');
        _dragIds = (_selected[id] && selectedCount() > 0) ? Object.keys(_selected) : [id];
        try { e.dataTransfer.setData('text/plain', _dragIds.join(',')); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', function () {
        _dragIds = null;
        card.classList.remove('dragging');
        if (_sidebar) Array.prototype.forEach.call(_sidebar.querySelectorAll('.drop-hover'), function (el) { el.classList.remove('drop-hover'); });
      });
    });
  }

  /* ドロップ先 field=val ＋ 上位を決める。
     上位は 1)チェック1つ→それ 2)複数チェック→曖昧でスキップ 3)未チェック→既存写真から推定（1つに定まるときだけ）。 */
  function inferAssign(field, val) {
    var assign = {}; assign[field] = val;
    var parents = (facetDef(field) || {}).parents || [];
    parents.forEach(function (pf) {
      var keys = Object.keys(_facets[pf] || {});
      if (keys.length === 1) { assign[pf] = keys[0]; return; } // チェック1つ＝最優先
      if (keys.length >= 2) return;                            // 複数チェック＝曖昧
      // 未チェック：ドロップ先の値＋確定済み上位に一致する既存写真から推定
      var cand = {};
      _photos.forEach(function (p) {
        if (facetVal(field, p) !== val) return;
        for (var i = 0; i < parents.length; i++) {
          var af = parents[i];
          if (assign.hasOwnProperty(af) && facetVal(af, p) !== assign[af]) return;
        }
        var v = facetVal(pf, p);
        if (v) cand[v] = true;
      });
      var ck = Object.keys(cand);
      if (ck.length === 1) assign[pf] = ck[0]; // 1種類に定まるときだけ
    });
    return assign;
  }

  /* ドラッグした写真に分類を一括反映して保存。
     下層タブへ落としたときは上位（撮影区分・工種・種別・細別）も一緒に反映（チェック優先・未チェックは推定）。 */
  function applyDrop(field, val) {
    if (!_dragIds || !_dragIds.length) return;
    var ids = {}; _dragIds.forEach(function (i) { ids[i] = true; });
    var targets = _photos.filter(function (p) { return ids[p.id]; });
    if (!targets.length) return;

    // 代入セット：ドロップ先＋上位（チェック優先、未チェックは既存データから推定）
    var assign = inferAssign(field, val);
    // トースト用に FACETS 並び（上位→下位）で列挙
    var parts = FACETS.filter(function (f) { return assign.hasOwnProperty(f.field); })
      .map(function (f) { return f.label + '：' + assign[f.field]; });

    var before = targets.map(snap);
    var busy = UI.busy('反映中…');
    targets.reduce(function (chain, p) {
      return chain.then(function () {
        Object.keys(assign).forEach(function (k) { p[k] = assign[k]; });
        return Storage.put('photos', p).then(function () { if (History) History.addFromPhoto(p); });
      });
    }, Promise.resolve()).then(function () {
      undoRecord(targets.map(function (p, i) { return { key: p.id, before: before[i], after: snap(p) }; }));
      busy.close();
      UI.toast(targets.length + ' 枚を ' + parts.join(' / ') + ' にしました');
      reload();
    }).catch(function (e) {
      busy.close();
      UI.alert('反映中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
    });
  }

  function wireSelbar(shown) {
    var all = document.getElementById('btnSelAll');
    if (all) all.onclick = function () {
      shown.forEach(function (p) { _selected[p.id] = true; });
      render();
    };
    var clr = document.getElementById('btnSelClear');
    if (clr) clr.onclick = function () { _selected = {}; _lastIndex = null; render(); };
    var edit = document.getElementById('btnSelEdit');
    if (edit) edit.onclick = function () {
      var sel = selectedPhotos();
      if (!sel.length) { UI.alert('写真が選択されていません。サムネイルのチェックで選んでください。', 'まとめて入力'); return; }
      openBulkEdit(sel);
    };
    var exp = document.getElementById('btnSelExport');
    if (exp) exp.onclick = function () {
      var sel = selectedPhotos();
      if (!sel.length) { UI.alert('写真が選択されていません。サムネイルのチェックで選んでください。', '選択して出力'); return; }
      sel.sort(function (a, b) { return (a.takenAt || a.importedAt) - (b.takenAt || b.importedAt); });
      global.App.ExportBook.dialog(sel, '選択');
    };
    var del = document.getElementById('btnSelDelete');
    if (del) del.onclick = function () { deletePhotos(selectedPhotos()); };
    var mvc = document.getElementById('btnSelMoveCopy');
    if (mvc) mvc.onclick = function () {
      var sel = selectedPhotos();
      if (!sel.length) { UI.alert('写真が選択されていません。サムネイルのチェックで選んでください。', 'コピー／移動'); return; }
      openMoveCopy(sel);
    };
    var alb = document.getElementById('btnSelAlbum');
    if (alb) alb.onclick = function () {
      var sel = selectedPhotos();
      if (!sel.length) { UI.alert('写真が選択されていません。サムネイルのチェックで選んでください。', 'アルバムに保存'); return; }
      UI.prompt('アルバムとして保存', [
        { name: 'name', label: 'アルバム名', placeholder: '例：受電盤付近 / 着手前まとめ' }
      ]).then(function (v) {
        if (!v || !v.name) return;
        global.App.Albums.createManual(v.name, sel.map(function (p) { return p.id; })).then(function () {
          UI.toast('アルバム「' + v.name + '」を保存しました（' + sel.length + ' 枚）');
        });
      });
    };
  }

  /* 選択写真へまとめて入力（入力した項目だけ上書き・空欄は変更しない） */
  function openBulkEdit(photos) {
    var wrap = document.createElement('div');
    wrap.className = 'detail-form bulk-form';
    function field(label, name) { return histFieldHtml(label, name, '', '入力した項目だけ上書き'); }
    wrap.innerHTML =
      '<p class="note">選択した ' + photos.length + ' 枚に、入力した項目だけをまとめて設定します（空欄の項目は変更しません）。</p>' +
      field('工種', 'koushu') + field('種別', 'shubetsu') + field('細別', 'saibetsu') +
      field('撮影区分', 'kubun') + field('撮影箇所（測点）', 'spot') +
      '<label class="field"><span>説明（キャプション）</span>' +
      '<input data-name="caption" placeholder="入力した項目だけ上書き"></label>' +
      '<div class="detail-actions"><button class="btn btn-primary btn-lg" id="bulkApply">まとめて設定</button></div>';
    var close = UI.modal(wrap, '選択写真へまとめて入力');
    wireHistory(wrap); // ▼履歴ボタン

    wrap.querySelector('#bulkApply').onclick = function () {
      var vals = {};
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-name]'), function (el) {
        var v = el.value.trim();
        if (v) vals[el.getAttribute('data-name')] = v;
      });
      var keys = Object.keys(vals);
      if (!keys.length) { UI.alert('入力された項目がありません。', 'まとめて入力'); return; }
      var before = photos.map(snap);
      var busy = UI.busy('設定中…');
      photos.reduce(function (chain, p) {
        return chain.then(function () {
          keys.forEach(function (k) { p[k] = vals[k]; });
          return Storage.put('photos', p).then(function () { if (History) History.addFromPhoto(p); });
        });
      }, Promise.resolve()).then(function () {
        undoRecord(photos.map(function (p, i) { return { key: p.id, before: before[i], after: snap(p) }; }));
        busy.close(); close();
        UI.toast(photos.length + ' 枚に設定しました');
        reload();
      }).catch(function (e) {
        busy.close();
        UI.alert('設定中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
      });
    };
  }

  function pickFiles() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true; inp.accept = 'image/*';
    inp.onchange = function () { importFiles(inp.files); };
    inp.click();
  }

  /* 写真を削除（編集画面を開かず）。確認→Undo記録→下書きも掃除→reload */
  function deletePhotos(list) {
    if (!list || !list.length) { UI.alert('写真が選択されていません。サムネイルのチェックで選んでください。', '削除'); return; }
    var msg = (list.length === 1) ? 'この写真を削除しますか？（戻るボタンで元に戻せます）'
      : list.length + ' 枚を削除しますか？（戻るボタンで元に戻せます）';
    UI.confirm(msg, '削除の確認').then(function (ok) {
      if (!ok) return;
      var before = list.map(snap);
      var busy = UI.busy('削除中…');
      list.reduce(function (chain, p) {
        return chain.then(function () {
          return Storage.delete('photos', p.id).then(function () {
            delete _selected[p.id]; delete _drafts[p.id];
            return Storage.delete('settings', draftKey(p.id)).catch(function () {});
          });
        });
      }, Promise.resolve()).then(function () {
        undoRecord(list.map(function (p, i) { return { key: p.id, before: before[i], after: null }; }));
        busy.close();
        UI.toast(list.length + ' 枚を削除しました');
        reload();
      }).catch(function (e) {
        busy.close();
        UI.alert('削除中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
      });
    });
  }

  /* 選択写真を別の工事へコピー／移動。写真の全情報を引き継ぐ。Undo対応。 */
  function openMoveCopy(list) {
    var cur = Projects.current();
    Projects.list().then(function (all) {
      var others = all.filter(function (pj) { return !cur || pj.id !== cur.id; });
      var wrap = document.createElement('div');
      wrap.className = 'detail-form';
      var opts = '<option value="">（移動先の工事を選択）</option>' +
        '<option value="__new__">＋ 新しい工事を作成…</option>';
      others.forEach(function (pj) {
        opts += '<option value="' + UI.esc(pj.id) + '">' + UI.esc(pj.name) + '</option>';
      });
      wrap.innerHTML =
        '<p class="note">選択した ' + list.length + ' 枚を、別の工事へコピー／移動します（工種・説明・撮影日時・位置情報などの情報もそのまま引き継ぎます）。</p>' +
        '<label class="field"><span>移動先の工事</span>' +
        '<select id="mcTarget">' + opts + '</select></label>' +
        '<p class="note" id="mcHint" style="min-height:1.2em"></p>' +
        '<div class="detail-actions" style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button class="btn btn-primary btn-lg" id="mcCopy">コピーする（元は残す）</button>' +
        '<button class="btn btn-lg" id="mcMove">移動する（元から消す）</button>' +
        '</div>';
      var close = UI.modal(wrap, '別の工事へコピー／移動');
      var sel = wrap.querySelector('#mcTarget');
      var hint = wrap.querySelector('#mcHint');
      sel.onchange = function () {
        hint.textContent = (sel.value === '__new__') ? '「新しい工事を作成」を選択中：実行時に工事名を入力します。' : '';
      };

      // 移動先ID（新規なら作成）を解決
      function resolveTarget() {
        var v = sel.value;
        if (!v) { UI.alert('移動先の工事を選んでください。', 'コピー／移動'); return Promise.resolve(null); }
        if (v === '__new__') {
          return UI.prompt('新しい工事を作成', [
            { name: 'name', label: '工事名', placeholder: '例：○○地内 電気設備工事' },
            { name: 'client', label: '発注者（任意）', placeholder: '例：京都府 / 民間 / 自社' }
          ]).then(function (val) {
            if (!val || !val.name) return null;
            return Projects.create(val.name, val.client).then(function (p) { return p; });
          });
        }
        // 既存工事オブジェクトを返す
        var found = null;
        others.forEach(function (pj) { if (pj.id === v) found = pj; });
        return Promise.resolve(found);
      }

      function doCopy() {
        resolveTarget().then(function (target) {
          if (!target) return;
          var busy = UI.busy('コピー中…');
          var copies = [];
          list.reduce(function (chain, p) {
            return chain.then(function () {
              var copy = Object.assign({}, p, {
                id: Storage.newId('ph'),
                projectId: target.id,
                importedAt: Date.now()
              });
              copies.push(copy);
              return Storage.put('photos', copy);
            });
          }, Promise.resolve()).then(function () {
            undoRecord(copies.map(function (c) { return { key: c.id, before: null, after: snap(c) }; }));
            busy.close(); close();
            UI.toast(list.length + ' 枚を「' + target.name + '」へコピーしました');
            reload();
          }).catch(function (e) {
            busy.close();
            UI.alert('コピー中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
          });
        });
      }

      function doMove() {
        resolveTarget().then(function (target) {
          if (!target) return;
          UI.confirm(list.length + ' 枚を「' + target.name + '」へ移動します。\n（この工事からは無くなります。戻るボタンで元に戻せます）', '移動の確認').then(function (ok) {
            if (!ok) return;
            var before = list.map(snap);
            var busy = UI.busy('移動中…');
            list.reduce(function (chain, p) {
              return chain.then(function () {
                p.projectId = target.id;
                return Storage.put('photos', p).then(function () { delete _selected[p.id]; });
              });
            }, Promise.resolve()).then(function () {
              undoRecord(list.map(function (p, i) { return { key: p.id, before: before[i], after: snap(p) }; }));
              busy.close(); close();
              UI.toast(list.length + ' 枚を「' + target.name + '」へ移動しました');
              reload();
            }).catch(function (e) {
              busy.close();
              UI.alert('移動中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
            });
          });
        });
      }

      wrap.querySelector('#mcCopy').onclick = doCopy;
      wrap.querySelector('#mcMove').onclick = doMove;
    });
  }

  /* 全画面拡大ビューア（原本を表示・ホイール/ボタンで拡大・ドラッグで移動・Escで閉じる） */
  function openZoom(blob) {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay zoom-overlay';
    var url = URL.createObjectURL(blob);
    ov.innerHTML =
      '<div class="zoom-bar">' +
      '<button class="btn" data-z="out">－</button>' +
      '<button class="btn" data-z="reset">リセット</button>' +
      '<button class="btn" data-z="in">＋</button>' +
      '<button class="btn btn-primary" data-z="close">閉じる</button>' +
      '</div><div class="zoom-stage"><img draggable="false" src="' + url + '"></div>';
    document.body.appendChild(ov);
    var stage = ov.querySelector('.zoom-stage'), img = ov.querySelector('img');
    var scale = 1, fit = 1, natW = 0, natH = 0;

    function apply() { img.style.width = Math.round(natW * scale) + 'px'; }
    function center() { stage.scrollLeft = (img.clientWidth - stage.clientWidth) / 2; stage.scrollTop = (img.clientHeight - stage.clientHeight) / 2; }
    function zoomAt(factor, cx, cy) {
      var rect = stage.getBoundingClientRect();
      var w = natW * scale, h = natH * scale;
      var rx = (stage.scrollLeft + (cx - rect.left)) / (w || 1);
      var ry = (stage.scrollTop + (cy - rect.top)) / (h || 1);
      scale = Math.min(Math.max(scale * factor, fit * 0.5), 8);
      apply();
      stage.scrollLeft = rx * (natW * scale) - (cx - rect.left);
      stage.scrollTop = ry * (natH * scale) - (cy - rect.top);
    }
    img.onload = function () {
      natW = img.naturalWidth; natH = img.naturalHeight;
      fit = Math.min(stage.clientWidth / natW, stage.clientHeight / natH, 1) || 1;
      scale = fit; apply(); center();
    };
    stage.addEventListener('wheel', function (e) { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
    ov.querySelector('[data-z="in"]').onclick = function () { var r = stage.getBoundingClientRect(); zoomAt(1.25, r.left + r.width / 2, r.top + r.height / 2); };
    ov.querySelector('[data-z="out"]').onclick = function () { var r = stage.getBoundingClientRect(); zoomAt(1 / 1.25, r.left + r.width / 2, r.top + r.height / 2); };
    ov.querySelector('[data-z="reset"]').onclick = function () { scale = fit; apply(); center(); };

    var dragging = false, sx, sy, sl, st;
    stage.addEventListener('mousedown', function (e) { dragging = true; sx = e.clientX; sy = e.clientY; sl = stage.scrollLeft; st = stage.scrollTop; stage.style.cursor = 'grabbing'; e.preventDefault(); });
    function onMove(e) { if (!dragging) return; stage.scrollLeft = sl - (e.clientX - sx); stage.scrollTop = st - (e.clientY - sy); }
    function onUp() { dragging = false; stage.style.cursor = 'grab'; }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    function onKey(e) {
      if (e.key !== 'Escape') return;
      var all = document.querySelectorAll('.modal-overlay');
      if (all.length && all[all.length - 1] !== ov) return; // 最前面のときだけ
      e.preventDefault(); close();
    }
    document.addEventListener('keydown', onKey);
    function close() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onKey);
      URL.revokeObjectURL(url);
      if (ov.parentNode) ov.parentNode.removeChild(ov);
    }
    ov.querySelector('[data-z="close"]').onclick = close;
  }

  /* ---- 詳細・分類編集（最前面モーダル）。onSaved は保存/削除後に呼ぶ ---- */
  function openDetail(photo, onSaved) {
    var wrap = document.createElement('div');
    wrap.className = 'detail';
    var imgUrl = URL.createObjectURL(photo.blob);
    var localUrls = [imgUrl];

    // 5 項目は全工事共通の入力履歴（▼で全履歴、打って絞り込みの両方）
    function field(label, name, value) { return histFieldHtml(label, name, value); }

    wrap.innerHTML =
      '<div class="detail-img"><img src="' + imgUrl + '" title="クリックで拡大"><span class="zoom-hint">クリックで拡大</span></div>' +
      '<div class="detail-form">' +
      '<div class="detail-meta">撮影日時：' + fmtDate(photo.takenAt) +
      '　ファイル：' + UI.esc(photo.fileName || '') + '</div>' +
      field('工種', 'koushu', photo.koushu) +
      field('種別', 'shubetsu', photo.shubetsu) +
      field('細別', 'saibetsu', photo.saibetsu) +
      field('撮影区分', 'kubun', photo.kubun) +
      field('撮影箇所（測点）', 'spot', photo.spot) +
      '<label class="field"><span>説明（キャプション）</span>' +
      '<textarea data-name="caption" rows="2">' + UI.esc(photo.caption || '') + '</textarea></label>' +
      '<div class="gps-row">' +
      '<label class="field small"><span>緯度</span><input data-name="lat" value="' + (photo.lat != null ? photo.lat : '') + '" placeholder="例 35.0116"></label>' +
      '<label class="field small"><span>経度</span><input data-name="lng" value="' + (photo.lng != null ? photo.lng : '') + '" placeholder="例 135.7681"></label>' +
      '<button class="btn" id="btnMap">地図</button>' +
      '</div>' +
      '<div class="detail-actions">' +
      '<button class="btn btn-danger" id="btnDel">この写真を削除</button>' +
      '<button class="btn btn-primary" id="btnSave">保存</button>' +
      '</div></div>';

    var mapHolder = document.createElement('div');
    mapHolder.className = 'detail-map';
    mapHolder.style.display = 'none';
    wrap.appendChild(mapHolder);

    var closeModal = UI.modal(wrap, '写真の分類・情報');

    // 画像クリックで全画面拡大（原本で細部確認）
    var detailImg = wrap.querySelector('.detail-img img');
    if (detailImg) detailImg.onclick = function () { openZoom(photo.blob); };
    wireHistory(wrap); // ▼履歴ボタン

    function readForm() {
      var vals = {};
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-name]'), function (el) {
        vals[el.getAttribute('data-name')] = el.value;
      });
      return vals;
    }
    function applyValues(v) {
      Array.prototype.forEach.call(wrap.querySelectorAll('[data-name]'), function (el) {
        var k = el.getAttribute('data-name');
        if (v[k] != null) el.value = v[k];
      });
    }

    // --- 下書き（編集途中）の自動保存・復元 ---
    var dkey = draftKey(photo.id);
    var draftTimer = null;
    function saveDraftSoon() {
      if (draftTimer) clearTimeout(draftTimer);
      draftTimer = setTimeout(function () {
        Storage.setSetting(dkey, readForm());
        _drafts[photo.id] = true;
      }, 500);
    }
    function clearDraft() {
      if (draftTimer) clearTimeout(draftTimer);
      delete _drafts[photo.id];
      return Storage.delete('settings', dkey);
    }
    wrap.addEventListener('input', function (e) {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-name')) saveDraftSoon();
    });
    Storage.getSetting(dkey, null).then(function (draft) {
      if (!draft) return;
      applyValues(draft);
      var note = document.createElement('div');
      note.className = 'restore-note';
      note.innerHTML = '※前回の編集途中を復元しました（未保存） <button class="btn btn-sm" id="btnDiscardDraft">下書きを破棄</button>';
      var form = wrap.querySelector('.detail-form');
      form.insertBefore(note, form.firstChild);
      note.querySelector('#btnDiscardDraft').onclick = function () {
        applyValues({
          koushu: photo.koushu || '', shubetsu: photo.shubetsu || '', saibetsu: photo.saibetsu || '',
          kubun: photo.kubun || '', spot: photo.spot || '', caption: photo.caption || '',
          lat: (photo.lat != null ? photo.lat : ''), lng: (photo.lng != null ? photo.lng : '')
        });
        clearDraft().then(reload);
        if (note.parentNode) note.parentNode.removeChild(note);
      };
    });

    wrap.querySelector('#btnMap').onclick = function () {
      var v = readForm();
      var lat = parseFloat(v.lat), lng = parseFloat(v.lng);
      mapHolder.style.display = 'block';
      global.App.Map.show(mapHolder, isFinite(lat) ? lat : null, isFinite(lng) ? lng : null, function (nlat, nlng) {
        wrap.querySelector('[data-name="lat"]').value = nlat.toFixed(6);
        wrap.querySelector('[data-name="lng"]').value = nlng.toFixed(6);
      });
    };

    wrap.querySelector('#btnSave').onclick = function () {
      var before = snap(photo); // 変更前（Undo 用）
      var v = readForm();
      photo.koushu = v.koushu.trim(); photo.shubetsu = v.shubetsu.trim();
      photo.saibetsu = v.saibetsu.trim(); photo.kubun = v.kubun.trim();
      photo.spot = v.spot.trim(); photo.caption = v.caption.trim();
      var la = parseFloat(v.lat), lo = parseFloat(v.lng);
      photo.lat = isFinite(la) ? la : null;
      photo.lng = isFinite(lo) ? lo : null;
      Storage.put('photos', photo).then(function () {
        if (History) History.addFromPhoto(photo); // 入力履歴を更新（全工事共通）
        undoRecord([{ key: photo.id, before: before, after: snap(photo) }]);
        return clearDraft();                       // 保存できたので下書きは削除
      }).then(function () {
        localUrls.forEach(URL.revokeObjectURL);
        closeModal();
        UI.toast('保存しました');
        reload();
        if (onSaved) onSaved();
      });
    };

    wrap.querySelector('#btnDel').onclick = function () {
      UI.confirm('この写真を削除しますか？（戻るボタンで元に戻せます）', '削除の確認').then(function (ok) {
        if (!ok) return;
        var before = snap(photo); // 削除前（Undo で復元）
        Storage.delete('photos', photo.id).then(function () {
          undoRecord([{ key: photo.id, before: before, after: null }]);
          return clearDraft();
        }).then(function () {
          localUrls.forEach(URL.revokeObjectURL);
          closeModal();
          UI.toast('削除しました');
          reload();
          if (onSaved) onSaved();
        });
      });
    };
  }

  function mount(container, sidebar) {
    _container = container;
    _sidebar = sidebar || null;
    render();
  }

  global.App = global.App || {};
  global.App.Photos = {
    mount: mount, reload: reload, importFiles: importFiles, openDetail: openDetail,
    histField: histFieldHtml, wireHistory: wireHistory,
    getAll: function () { return _photos.slice(); }
  };
})(window);
