/* storage.js  ---  IndexedDB の薄い Promise ラッパ
   file:// でも動くよう import/export は使わず、グローバル App.Storage に公開する。
   Chrome / Edge を対象。 */
(function (global) {
  'use strict';

  var DB_NAME = 'photo-manager';
  var DB_VERSION = 2;
  var _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('photos')) {
          var ps = db.createObjectStore('photos', { keyPath: 'id' });
          ps.createIndex('projectId', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('albums')) {
          var al = db.createObjectStore('albums', { keyPath: 'id' });
          al.createIndex('projectId', 'projectId', { unique: false });
        }
      };
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror = function () {
        reject(new Error('データベースを開けませんでした。Microsoft Edge か Chrome でお使いください。'));
      };
    });
    return _dbPromise;
  }

  function tx(store, mode) {
    return openDB().then(function (db) {
      return db.transaction(store, mode).objectStore(store);
    });
  }

  function reqToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /* ---- Blob ⇄ ArrayBuffer 透過変換 ----
     Safari/WebKit は IndexedDB に Blob/File を直接保存すると壊れるため、
     保存時に ArrayBuffer 化（dehydrate）、読み出し時に Blob へ復元（hydrate）する。 */
  function isBlob(v) { return (typeof Blob !== 'undefined' && v instanceof Blob); }
  function isMarker(v) { return v && typeof v === 'object' && v.__blob === true && v.buf; }

  function blobToBuffer(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error || new Error('read error')); };
      fr.readAsArrayBuffer(blob);
    });
  }

  /* 値のトップレベルにある Blob/File を {__blob,buf,type,name} へ。元は壊さずコピーを返す（Promise）。 */
  function dehydrate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return Promise.resolve(value);
    var out = {}, jobs = [];
    Object.keys(value).forEach(function (k) {
      var v = value[k];
      if (isBlob(v)) {
        jobs.push(blobToBuffer(v).then(function (buf) {
          out[k] = { __blob: true, buf: buf, type: v.type || '', name: (v.name || '') };
        }));
      } else {
        out[k] = v;
      }
    });
    return Promise.all(jobs).then(function () { return out; });
  }

  /* {__blob,...} マーカーを Blob へ復元。生Blob(旧データ)や通常値はそのまま。 */
  function hydrate(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    Object.keys(value).forEach(function (k) {
      var v = value[k];
      if (isMarker(v)) value[k] = new Blob([v.buf], { type: v.type || '' });
    });
    return value;
  }
  function hydrateAll(rows) { return (rows || []).map(hydrate); }

  var Storage = {
    /* 汎用 CRUD */
    put: function (store, value) {
      return dehydrate(value).then(function (v) {
        return tx(store, 'readwrite').then(function (os) { return reqToPromise(os.put(v)); });
      });
    },
    get: function (store, key) {
      return tx(store, 'readonly').then(function (os) { return reqToPromise(os.get(key)); }).then(hydrate);
    },
    delete: function (store, key) {
      return tx(store, 'readwrite').then(function (os) { return reqToPromise(os.delete(key)); });
    },
    getAll: function (store) {
      return tx(store, 'readonly').then(function (os) { return reqToPromise(os.getAll()); }).then(hydrateAll);
    },
    /* 写真を工事IDで取得（index 利用） */
    getPhotosByProject: function (projectId) {
      return tx('photos', 'readonly').then(function (os) {
        return reqToPromise(os.index('projectId').getAll(projectId));
      }).then(hydrateAll);
    },
    /* アルバムを工事IDで取得（index 利用） */
    getAlbumsByProject: function (projectId) {
      return tx('albums', 'readonly').then(function (os) {
        return reqToPromise(os.index('projectId').getAll(projectId));
      }).then(hydrateAll);
    },
    /* 設定 */
    getSetting: function (key, fallback) {
      return Storage.get('settings', key).then(function (row) {
        return row ? row.value : fallback;
      });
    },
    setSetting: function (key, value) {
      return Storage.put('settings', { key: key, value: value });
    },
    /* 一意な id 生成（Date.now＋乱数）。 */
    newId: function (prefix) {
      var rnd = Math.floor(Math.random() * 1e9).toString(36);
      return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + rnd;
    }
  };

  global.App = global.App || {};
  global.App.Storage = Storage;
})(window);
