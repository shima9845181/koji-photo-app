/* backup.js  ---  工事ごとの書き出し／取り込み（zip）
   構成: meta.json（工事＋写真メタ）＋ photos/<id>.<ext>（原本・無加工）。
   端末間の受け渡し・完了工事の退避に使う。写真は外部送信せずローカル完結。
   ※ github.js から buildProjectZip / importZip を再利用する。 */
(function (global) {
  'use strict';
  var UI = global.App.UI;
  var Storage = global.App.Storage;
  var Projects = global.App.Projects;

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function stamp() { var d = new Date(); return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()); }
  function safeName(s) { return String(s || 'export').replace(/[\\/:*?"<>|]/g, '_'); }
  function extOf(name, type) {
    var m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
    if (m) return m[1].toLowerCase();
    if (type && type.indexOf('/') > 0) return type.split('/')[1];
    return 'jpg';
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  /* ---- zip 生成（書き出し／GitHubバックアップ共通） ----
     戻り値: Promise<Blob>。meta.version=2、工事IDと写真の原IDを保持する。 */
  function buildProjectZip(proj, onProgress) {
    return Storage.getPhotosByProject(proj.id).then(function (photos) {
      var zip = new global.JSZip();
      var photoDir = zip.folder('photos');
      var meta = {
        version: 2,
        exportedAt: Date.now(),
        project: {
          id: proj.id,
          name: proj.name,
          client: proj.client || '',
          createdAt: proj.createdAt
        },
        photos: []
      };
      photos.forEach(function (p) {
        var ext = extOf(p.fileName, p.blob && p.blob.type);
        var fname = p.id + '.' + ext;
        photoDir.file(fname, p.blob);
        meta.photos.push({
          id: p.id, file: 'photos/' + fname, fileName: p.fileName || fname,
          takenAt: p.takenAt, lat: p.lat, lng: p.lng,
          koushu: p.koushu, shubetsu: p.shubetsu, saibetsu: p.saibetsu,
          kubun: p.kubun, spot: p.spot, caption: p.caption, importedAt: p.importedAt
        });
      });
      zip.file('meta.json', JSON.stringify(meta, null, 2));
      return zip.generateAsync({ type: 'blob', compression: 'STORE' }, function (m) {
        if (onProgress) onProgress(Math.round(m.percent));
      });
    });
  }

  /* ---- 書き出し（ローカルファイルへ） ---- */
  function exportCurrent() {
    var proj = Projects.current();
    if (!proj) { UI.alert('先に工事を選択してください。', '書き出し'); return; }
    var busy = UI.busy('書き出しファイルを作成中…');
    buildProjectZip(proj, function (pct) {
      busy.update('書き出し中… ' + pct + '%');
    }).then(function (blob) {
      busy.close();
      download(blob, safeName(proj.name) + '_' + stamp() + '.zip');
      UI.toast('書き出しました');
    }).catch(function (e) {
      busy.close();
      UI.alert('書き出し中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
    });
  }

  /* ---- 取り込み（ローカルファイルから・新規工事として） ---- */
  function importDialog() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip,application/zip';
    inp.onchange = function () { if (inp.files[0]) importZip(inp.files[0]); };
    inp.click();
  }

  /* ---- 取り込み本体 ----
     opts.mode:
       'new'（既定）      … 「〇〇（取込）」として別工事で追加（写真は新ID）
       'overwrite'        … meta.project.id と同じ工事を上書き更新（写真は原ID・入替）
                            旧v1（idなし）zipは自動的に 'new' へフォールバック
     opts.silent が真ならトースト/リロードを呼び出し側に任せる（進捗UIは表示）。 */
  function importZip(file, opts) {
    opts = opts || {};
    var mode = opts.mode || 'new';
    var busy = UI.busy('取り込み中…');
    return global.JSZip.loadAsync(file).then(function (zip) {
      var metaFile = zip.file('meta.json');
      if (!metaFile) throw new Error('meta.json が見つかりません。当アプリで書き出した zip を指定してください。');
      return metaFile.async('string').then(function (txt) {
        var meta = JSON.parse(txt);
        var hasId = meta.project && meta.project.id;
        if (mode === 'overwrite' && hasId) {
          return importOverwrite(zip, meta, busy);
        }
        return importAsNew(zip, meta, busy, opts.newName);
      });
    }).then(function (proj) {
      return Projects.select(proj.id).then(function () { return proj; });
    }).then(function (proj) {
      return global.App.History.init().then(function () { return proj; }); // 分類値を履歴へ反映
    }).then(function (proj) {
      busy.close();
      if (!opts.silent) {
        UI.toast('取り込みが完了しました');
        global.App.Photos.reload();
      }
      return proj;
    }).catch(function (e) {
      busy.close();
      if (opts.rethrow) throw e;
      UI.alert('取り込み中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
    });
  }

  /* zip の meta.json だけを読む（復元前に工事名/IDを知るため） */
  function readZipMeta(file) {
    return global.JSZip.loadAsync(file).then(function (zip) {
      var metaFile = zip.file('meta.json');
      if (!metaFile) throw new Error('meta.json が見つかりません。当アプリで書き出した zip を指定してください。');
      return metaFile.async('string').then(function (txt) { return JSON.parse(txt); });
    });
  }

  /* 新規工事として取り込み（従来動作）。newName があればその名前で作成 */
  function importAsNew(zip, meta, busy, newName) {
    var name = (newName && newName.trim()) ? newName.trim() : (meta.project.name + '（取込）');
    return Projects.create(name, meta.project.client).then(function (proj) {
      return putPhotos(zip, meta, proj.id, busy).then(function () { return proj; });
    });
  }

  /* 同一IDの工事を上書き更新 */
  function importOverwrite(zip, meta, busy) {
    var pid = meta.project.id;
    return Storage.get('projects', pid).then(function (existing) {
      // 既存工事の他フィールドは温存しつつ、名称等を上書き
      var proj = Object.assign({}, existing || {}, {
        id: pid,
        name: meta.project.name,
        client: meta.project.client || '',
        createdAt: meta.project.createdAt || (existing && existing.createdAt) || Date.now(),
        updatedAt: Date.now()
      });
      return Storage.put('projects', proj).then(function () {
        // 既存写真を全削除してから入れ替え（原IDのまま）
        return Storage.getPhotosByProject(pid).then(function (olds) {
          var del = Promise.resolve();
          olds.forEach(function (o) { del = del.then(function () { return Storage.delete('photos', o.id); }); });
          return del;
        });
      }).then(function () {
        return putPhotos(zip, meta, pid, busy, /*keepId*/ true).then(function () { return proj; });
      });
    });
  }

  /* zip 内の写真を photos ストアへ書き込む。keepId=true なら meta の原IDを使う。 */
  function putPhotos(zip, meta, projectId, busy, keepId) {
    var chain = Promise.resolve();
    var count = 0;
    var total = (meta.photos || []).length;
    (meta.photos || []).forEach(function (pm) {
      chain = chain.then(function () {
        var f = zip.file(pm.file);
        if (!f) return;
        return f.async('blob').then(function (blob) {
          return global.App.Exif.makeThumbnail(blob, 480).then(function (thumb) {
            return Storage.put('photos', {
              id: keepId ? pm.id : Storage.newId('ph'),
              projectId: projectId,
              fileName: pm.fileName,
              blob: blob, thumbBlob: thumb,
              takenAt: pm.takenAt, lat: pm.lat, lng: pm.lng,
              koushu: pm.koushu || '', shubetsu: pm.shubetsu || '', saibetsu: pm.saibetsu || '',
              kubun: pm.kubun || '', spot: pm.spot || '', caption: pm.caption || '',
              importedAt: pm.importedAt || Date.now()
            });
          });
        }).then(function () { count++; busy.update('取り込み中… ' + count + '/' + total); });
      });
    });
    return chain;
  }

  global.App = global.App || {};
  global.App.Backup = {
    exportCurrent: exportCurrent,
    importDialog: importDialog,
    buildProjectZip: buildProjectZip,
    importZip: importZip,
    readZipMeta: readZipMeta
  };
})(window);
