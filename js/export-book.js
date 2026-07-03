/* export-book.js  ---  写真帳出力（PDF / Excel）
   PDF: 日本語フォント埋め込みを避けるため、各ページを canvas に描画して
        jsPDF に画像として貼り込む（ブラウザのシステムフォントで日本語表示）。
   Excel: ExcelJS で画像を各写真ごとに埋め込み、管理項目を隣接セルに記載。 */
(function (global) {
  'use strict';
  var UI = global.App.UI;
  var Exif = global.App.Exif;
  var Projects = global.App.Projects;
  var Storage = global.App.Storage;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function fmtDate(ms) {
    if (!ms) return '（日時なし）';
    var d = new Date(ms);
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function safeName(s) { return String(s || '写真帳').replace(/[\\/:*?"<>|]/g, '_'); }

  function blobToImage(blob) { return Exif.blobToImage(blob); }
  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  function sortedPhotos() {
    var proj = Projects.current();
    return Storage.getPhotosByProject(proj.id).then(function (rows) {
      rows.sort(function (a, b) { return (a.takenAt || a.importedAt) - (b.takenAt || b.importedAt); });
      return rows;
    });
  }

  /* エントリ種別：photo（写真オブジェクト）/ text（見出し・メモ）/ blank（空欄コマ） */
  function kindOf(it) {
    if (it && it._kind === 'text') return 'text';
    if (it && it._kind === 'blank') return 'blank';
    return 'photo';
  }

  /* ---------- 表示項目の定義（順序＝描画順・チェックで表示切替） ---------- */
  var FIELD_DEFS = [
    { key: 'projName', label: '現場名（工事名）', get: function (p, projName) { return projName || '―'; } },
    { key: 'koushu', label: '工種', get: function (p) { return p.koushu || '―'; } },
    { key: 'shubetsu', label: '種別', get: function (p) { return p.shubetsu || '―'; } },
    { key: 'kubun', label: '撮影区分', get: function (p) { return p.kubun || '―'; } },
    { key: 'spot', label: '撮影場所（測点）', get: function (p) { return p.spot || '―'; } },
    { key: 'takenAt', label: '撮影年月日', get: function (p) { return fmtDate(p.takenAt); } },
    { key: 'caption', label: '説明', get: function (p) { return p.caption || '―'; } }
  ];
  // fields 未指定なら全項目ON
  function normFields(fields) {
    if (!fields) { var all = {}; FIELD_DEFS.forEach(function (f) { all[f.key] = true; }); return all; }
    return fields;
  }
  function enabledDefs(fields) {
    var fs = normFields(fields);
    return FIELD_DEFS.filter(function (f) { return fs[f.key]; });
  }

  /* ---------- 共通：1エントリのテキスト行（チェックされた項目のみ） ---------- */
  function entryRows(p, projName, fields) {
    return enabledDefs(fields).map(function (f) { return [f.label, f.get(p, projName)]; });
  }
  /* 空欄コマ（手書き用）：項目名は残し値は空（現場名のみ値を入れる） */
  function blankRows(projName, fields) {
    return enabledDefs(fields).map(function (f) {
      return [f.label, f.key === 'projName' ? (projName || '') : ''];
    });
  }

  /* ================= PDF ================= */
  function wrapText(ctx, text, maxW) {
    var lines = [], cur = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\n') { lines.push(cur); cur = ''; continue; }
      if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function drawEntry(ctx, x, y, w, h, img, rows, photoOnly) {
    // 枠
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
    var pad = 14;
    // 写真のみ（コメント欄なし）／項目が0件のときは画像を全幅表示
    var noTable = photoOnly || !rows || !rows.length;
    var imgW = noTable ? w : Math.round(w * 0.54);
    // 画像領域
    var ax = x + pad, ay = y + pad, aw = imgW - pad * 1.5, ah = h - pad * 2;
    if (img) {
      var s = Math.min(aw / img.width, ah / img.height);
      var dw = img.width * s, dh = img.height * s;
      ctx.drawImage(img, ax + (aw - dw) / 2, ay + (ah - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = '#eee'; ctx.fillRect(ax, ay, aw, ah);
    }
    if (noTable) return; // 写真のみ（コメント欄なし）
    // 区切り線
    var tableX = x + imgW;
    ctx.beginPath(); ctx.moveTo(tableX, y); ctx.lineTo(tableX, y + h); ctx.stroke();
    // 管理項目テーブル
    var tx = tableX + 12, tw = w - imgW - 24;
    var rowH = h / rows.length;
    ctx.textBaseline = 'top';
    for (var i = 0; i < rows.length; i++) {
      var ry = y + i * rowH;
      if (i > 0) { ctx.beginPath(); ctx.moveTo(tableX, ry); ctx.lineTo(x + w, ry); ctx.stroke(); }
      ctx.fillStyle = '#555'; ctx.font = '20px sans-serif';
      ctx.fillText(rows[i][0], tx, ry + 8);
      ctx.fillStyle = '#000'; ctx.font = 'bold 24px sans-serif';
      var lines = wrapText(ctx, rows[i][1], tw);
      for (var j = 0; j < lines.length && j < 3; j++) ctx.fillText(lines[j], tx, ry + 34 + j * 28);
    }
  }

  /* 見出し・メモの全幅行 */
  function drawTextRow(ctx, x, y, w, h, text) {
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#f4f6f9'; ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = 'bold 30px sans-serif';
    var pad = 24, lh = 42;
    var lines = wrapText(ctx, text || '', w - pad * 2);
    var startY = y + h / 2 - (lines.length - 1) * lh / 2;
    for (var i = 0; i < lines.length && i < Math.floor(h / lh); i++) ctx.fillText(lines[i], x + pad, startY + i * lh);
    ctx.textBaseline = 'top'; // 既定へ戻す
  }

  /* 1ページを canvas に描いて返す（プレビュー・PDF 共用）
     opts = { fields:{key:bool}, photoOnly:bool } */
  function renderPageCanvas(slice, perPage, projName, headerTitle, pg, pages, opts) {
    opts = opts || {};
    var W = 1240, H = 1754; // 150dpi A4
    var margin = 48, headerH = 70, footerH = 30;
    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('工事写真帳　' + headerTitle, margin, 24);
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(margin, headerH); ctx.lineTo(W - margin, headerH); ctx.stroke();
    ctx.font = '18px sans-serif'; ctx.fillStyle = '#666';
    ctx.fillText((pg + 1) + ' / ' + pages, W - margin - 60, H - footerH + 4);

    var top = headerH + 20, areaH = H - top - footerH - 10, gap = 20;
    var rowH = (areaH - gap * (perPage - 1)) / perPage;
    var imgProms = slice.map(function (it) {
      return kindOf(it) === 'photo' ? blobToImage(it.blob).catch(function () { return null; }) : Promise.resolve(null);
    });
    return Promise.all(imgProms).then(function (imgs) {
      for (var i = 0; i < slice.length; i++) {
        var y = top + i * (rowH + gap), it = slice[i], k = kindOf(it);
        if (k === 'text') drawTextRow(ctx, margin, y, W - margin * 2, rowH, it.text);
        else if (k === 'blank') drawEntry(ctx, margin, y, W - margin * 2, rowH, null, blankRows(projName, opts.fields), opts.photoOnly);
        else drawEntry(ctx, margin, y, W - margin * 2, rowH, imgs[i], entryRows(it, projName, opts.fields), opts.photoOnly);
        if (imgs[i] && imgs[i].src) URL.revokeObjectURL(imgs[i].src);
      }
      return canvas;
    });
  }

  function makePDF(photos, perPage, projName, headerTitle, opts) {
    headerTitle = headerTitle || projName;
    var jsPDFCtor = (global.jspdf && global.jspdf.jsPDF) || global.jsPDF;
    var doc = new jsPDFCtor({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    var pages = Math.ceil(photos.length / perPage) || 1;
    var chain = Promise.resolve();
    for (var pg = 0; pg < pages; pg++) {
      (function (pg) {
        chain = chain.then(function () {
          var slice = photos.slice(pg * perPage, pg * perPage + perPage);
          return renderPageCanvas(slice, perPage, projName, headerTitle, pg, pages, opts).then(function (canvas) {
            if (pg > 0) doc.addPage();
            doc.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', 0, 0, 210, 297);
          });
        });
      })(pg);
    }
    return chain.then(function () { return doc.output('blob'); });
  }

  /* プレビュー：全ページを縮小 canvas で container に並べる。isCurrent() が false になったら中断 */
  function buildPreview(container, entries, perPage, projName, headerTitle, isCurrent, opts) {
    var pages = Math.ceil(entries.length / perPage) || 1;
    var chain = Promise.resolve();
    for (var pg = 0; pg < pages; pg++) {
      (function (pg) {
        chain = chain.then(function () {
          if (isCurrent && !isCurrent()) return;
          var slice = entries.slice(pg * perPage, pg * perPage + perPage);
          return renderPageCanvas(slice, perPage, projName, headerTitle, pg, pages, opts).then(function (canvas) {
            if (isCurrent && !isCurrent()) return;
            if (pg === 0) container.innerHTML = '';
            var d = document.createElement('div'); d.className = 'pg';
            canvas.style.width = '100%'; d.appendChild(canvas);
            var no = document.createElement('div'); no.className = 'pg-no';
            no.textContent = (pg + 1) + ' / ' + pages + ' ページ';
            d.appendChild(no); container.appendChild(d);
          });
        });
      })(pg);
    }
    return chain;
  }

  /* ================= Excel ================= */
  function makeExcel(photos, perPage, projName, opts) {
    opts = opts || {};
    var wb = new global.ExcelJS.Workbook();
    var ws = wb.addWorksheet('写真帳');
    ws.columns = [
      { width: 44 }, // A 画像
      { width: 20 }, // B 項目
      { width: 44 }  // C 内容
    ];
    var BLOCK = 12; // 1写真あたりの行数
    var chain = Promise.resolve();

    photos.forEach(function (it, idx) {
      chain = chain.then(function () {
        var startRow = idx * BLOCK; // 0-based
        for (var r = 0; r < BLOCK; r++) ws.getRow(startRow + r + 1).height = 20;
        var k = kindOf(it);

        if (k === 'text') {
          // 見出し・メモ：A〜C を結合して大きめ表示
          ws.mergeCells('A' + (startRow + 1) + ':C' + (startRow + 3));
          var tc = ws.getCell('A' + (startRow + 1));
          tc.value = it.text || '';
          tc.font = { bold: true, size: 14 };
          tc.alignment = { vertical: 'middle', wrapText: true };
          return;
        }

        // photo / blank 共通：管理項目（写真のみのときは項目を出さない）
        var rows = opts.photoOnly ? [] : ((k === 'blank') ? blankRows(projName, opts.fields) : entryRows(it, projName, opts.fields));
        rows.forEach(function (kv, i) {
          var rowNo = startRow + i + 1;
          var bCell = ws.getCell('B' + rowNo);
          var cCell = ws.getCell('C' + rowNo);
          bCell.value = kv[0]; cCell.value = kv[1];
          bCell.font = { bold: true, size: 11 }; bCell.alignment = { vertical: 'middle' };
          cCell.font = { size: 11 }; cCell.alignment = { vertical: 'middle', wrapText: true };
        });
        if (k === 'blank') return; // 空欄コマは画像なし

        // 画像（印刷用に長辺1000pxへ再エンコード）
        return Exif.makeThumbnail(it.blob, 1000).then(function (b) {
          return b.arrayBuffer();
        }).then(function (buf) {
          var imageId = wb.addImage({ buffer: buf, extension: 'jpeg' });
          ws.addImage(imageId, {
            tl: { col: 0, row: startRow + 0.1 },
            ext: { width: 300, height: 220 }
          });
        });
      });
    });

    return chain.then(function () {
      return wb.xlsx.writeBuffer();
    }).then(function (buf) {
      return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    });
  }

  /* ================= ダイアログ（プレビュー付き） =================
     photos 省略時＝この工事の全件（従来）。label は見出し・ファイル名に反映。 */
  function dialog(photos, label) {
    var proj = Projects.current();
    if (!proj) { UI.alert('先に工事を選択してください。', '写真帳出力'); return; }
    label = label || '全件';

    var getEntries = photos ? Promise.resolve(photos.slice()) : sortedPhotos();
    getEntries.then(function (entries) {
      if (!entries.length) { UI.alert('写真がありません。', '写真帳出力'); return; }
      var headerTitle = proj.name + (label !== '全件' ? '　[' + label + ']' : '');

      var fieldChecks = FIELD_DEFS.map(function (f) {
        return '<label class="inline"><input type="checkbox" class="expField" data-key="' + f.key + '" checked> ' + UI.esc(f.label) + '</label>';
      }).join('');

      var wrap = document.createElement('div');
      wrap.className = 'export-dialog';
      wrap.innerHTML =
        '<div class="export-controls">' +
        '<label class="inline">レイアウト <select id="expPer" class="input"><option value="2">2枚 / ページ</option><option value="3" selected>3枚 / ページ</option><option value="4">4枚 / ページ</option></select></label>' +
        '<label class="inline">形式 <select id="expFmt" class="input"><option value="pdf">PDF</option><option value="xlsx">Excel</option></select></label>' +
        '<label class="inline"><input type="checkbox" id="expPhotoOnly"> 写真のみ（コメント欄なし）</label>' +
        '<span class="note">対象：' + UI.esc(label) + '（' + entries.length + ' 件）／ファイル名末尾に「ai」</span>' +
        '<button class="btn btn-primary btn-lg" id="expRun">出力する</button>' +
        '</div>' +
        '<div class="export-fields" id="expFields"><span class="note">表示項目：</span>' + fieldChecks + '</div>' +
        '<div class="export-preview" id="expPreview"></div>';
      var close = UI.modal(wrap, '写真帳の出力（プレビュー）');

      var per = wrap.querySelector('#expPer'), fmt = wrap.querySelector('#expFmt'), prev = wrap.querySelector('#expPreview');
      var photoOnly = wrap.querySelector('#expPhotoOnly');
      var fieldEls = Array.prototype.slice.call(wrap.querySelectorAll('.expField'));

      function readOpts() {
        var fields = {};
        fieldEls.forEach(function (cb) { fields[cb.getAttribute('data-key')] = cb.checked; });
        return { fields: fields, photoOnly: photoOnly.checked };
      }
      var _run = 0;
      function refresh() {
        // 写真のみのときは項目チェックを無効化（グレー）
        fieldEls.forEach(function (cb) { cb.disabled = photoOnly.checked; });
        var id = ++_run;
        prev.innerHTML = '<p class="note" style="padding:24px;text-align:center">プレビューを作成中…</p>';
        buildPreview(prev, entries, parseInt(per.value, 10), proj.name, headerTitle, function () { return id === _run; }, readOpts());
      }
      per.onchange = refresh;
      photoOnly.onchange = refresh;
      fieldEls.forEach(function (cb) { cb.onchange = refresh; });
      refresh();

      wrap.querySelector('#expRun').onclick = function () {
        var perPage = parseInt(per.value, 10), f = fmt.value, opts = readOpts();
        var base = safeName(proj.name) + '_写真帳_' + safeName(label) + '_' + today() + '_ai';
        var busy = UI.busy('写真帳を作成中…（枚数が多いと時間がかかります）');
        var task = (f === 'pdf')
          ? makePDF(entries, perPage, proj.name, headerTitle, opts).then(function (b) { download(b, base + '.pdf'); })
          : makeExcel(entries, perPage, proj.name, opts).then(function (b) { download(b, base + '.xlsx'); });
        task.then(function () {
          busy.close(); close(); UI.toast('写真帳を出力しました');
        }).catch(function (e) {
          busy.close();
          UI.alert('出力中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
        });
      };
    });
  }

  global.App = global.App || {};
  global.App.ExportBook = { dialog: dialog };
})(window);
