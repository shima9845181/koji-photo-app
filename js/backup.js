/* backup.js  ---  工事ごとの書き出し／取り込み（zip）
   構成: meta.json（工事＋写真メタ）＋ photos/<id>.<ext>（原本・無加工）。
   端末間の受け渡し・完了工事の退避に使う。写真は外部送信せずローカル完結。 */
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

  /* ---- 書き出し ---- */
  function exportCurrent() {
    var proj = Projects.current();
    if (!proj) { UI.alert('先に工事を選択してください。', '書き出し'); return; }
    var busy = UI.busy('書き出しファイルを作成中…');
    Storage.getPhotosByProject(proj.id).then(function (photos) {
      var zip = new global.JSZip();
      var photoDir = zip.folder('photos');
      var meta = {
        version: 1,
        exportedAt: Date.now(),
        project: { name: proj.name, client: proj.client || '', createdAt: proj.createdAt },
        photos: []
      };
      var chain = Promise.resolve();
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
      return chain.then(function () {
        return zip.generateAsync({ type: 'blob', compression: 'STORE' }, function (m) {
          busy.update('書き出し中… ' + Math.round(m.percent) + '%');
        });
      });
    }).then(function (blob) {
      busy.close();
      download(blob, safeName(proj.name) + '_' + stamp() + '.zip');
      UI.toast('書き出しました');
    }).catch(function (e) {
      busy.close();
      UI.alert('書き出し中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
    });
  }

  /* ---- 取り込み ---- */
  function importDialog() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.zip,application/zip';
    inp.onchange = function () { if (inp.files[0]) importZip(inp.files[0]); };
    inp.click();
  }

  function importZip(file) {
    var busy = UI.busy('取り込み中…');
    global.JSZip.loadAsync(file).then(function (zip) {
      var metaFile = zip.file('meta.json');
      if (!metaFile) throw new Error('meta.json が見つかりません。当アプリで書き出した zip を指定してください。');
      return metaFile.async('string').then(function (txt) {
        var meta = JSON.parse(txt);
        // 新しい工事として作成（既存と混ざらないよう別IDで取り込む）
        return Projects.create(meta.project.name + '（取込）', meta.project.client).then(function (proj) {
          var chain = Promise.resolve();
          var count = 0;
          meta.photos.forEach(function (pm) {
            chain = chain.then(function () {
              var f = zip.file(pm.file);
              if (!f) return;
              return f.async('blob').then(function (blob) {
                return global.App.Exif.makeThumbnail(blob, 480).then(function (thumb) {
                  return Storage.put('photos', {
                    id: Storage.newId('ph'),
                    projectId: proj.id,
                    fileName: pm.fileName,
                    blob: blob, thumbBlob: thumb,
                    takenAt: pm.takenAt, lat: pm.lat, lng: pm.lng,
                    koushu: pm.koushu || '', shubetsu: pm.shubetsu || '', saibetsu: pm.saibetsu || '',
                    kubun: pm.kubun || '', spot: pm.spot || '', caption: pm.caption || '',
                    importedAt: Date.now()
                  });
                });
              }).then(function () { count++; busy.update('取り込み中… ' + count + '/' + meta.photos.length); });
            });
          });
          return chain.then(function () { return proj; });
        });
      });
    }).then(function (proj) {
      return Projects.select(proj.id);
    }).then(function () {
      return global.App.History.init(); // 取り込んだ分類値を履歴へ反映
    }).then(function () {
      busy.close();
      UI.toast('取り込みが完了しました');
      global.App.Photos.reload();
    }).catch(function (e) {
      busy.close();
      UI.alert('取り込み中にエラーが発生しました。\n' + (e && e.message ? e.message : e), 'エラー');
    });
  }

  global.App = global.App || {};
  global.App.Backup = { exportCurrent: exportCurrent, importDialog: importDialog };
})(window);
