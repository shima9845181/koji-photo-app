/* exif.js  ---  EXIF（撮影日時・GPS）読み取りとサムネイル生成
   exifr（lib/exifr.umd.js, グローバル exifr）を利用。 */
(function (global) {
  'use strict';

  /* EXIF から撮影日時(ms)・緯度経度を取得。取得できなければ null。
     日時は parse、座標は専用の gps() ヘルパを使う（確実に latitude/longitude を返す）。 */
  function readMeta(fileOrBlob) {
    if (!global.exifr) {
      return Promise.resolve({ takenAt: null, lat: null, lng: null });
    }
    var pDate = global.exifr.parse(fileOrBlob, { pick: ['DateTimeOriginal', 'CreateDate'] })
      .then(function (d) {
        d = d || {};
        var dt = d.DateTimeOriginal || d.CreateDate || null;
        return (dt instanceof Date && !isNaN(dt.getTime())) ? dt.getTime() : null;
      }).catch(function () { return null; });

    var pGps = global.exifr.gps(fileOrBlob)
      .then(function (g) {
        if (g && typeof g.latitude === 'number' && typeof g.longitude === 'number') {
          return { lat: g.latitude, lng: g.longitude };
        }
        return { lat: null, lng: null };
      }).catch(function () { return { lat: null, lng: null }; });

    return Promise.all([pDate, pGps]).then(function (r) {
      return { takenAt: r[0], lat: r[1].lat, lng: r[1].lng };
    });
  }

  /* Blob を最大 maxPx（長辺）に縮小した JPEG サムネイル Blob を生成。 */
  function makeThumbnail(blob, maxPx) {
    maxPx = maxPx || 480;
    return blobToImage(blob).then(function (img) {
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      var scale = Math.min(1, maxPx / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale));
      var ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
      if (img.src && img.src.indexOf('blob:') === 0) URL.revokeObjectURL(img.src);
      return new Promise(function (resolve) {
        canvas.toBlob(function (b) { resolve(b || blob); }, 'image/jpeg', 0.8);
      });
    }).catch(function () { return blob; });
  }

  function blobToImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('画像を読み込めません')); };
      img.src = url;
    });
  }

  global.App = global.App || {};
  global.App.Exif = { readMeta: readMeta, makeThumbnail: makeThumbnail, blobToImage: blobToImage };
})(window);
