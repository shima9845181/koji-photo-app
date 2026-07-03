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

  var Storage = {
    /* 汎用 CRUD */
    put: function (store, value) {
      return tx(store, 'readwrite').then(function (os) { return reqToPromise(os.put(value)); });
    },
    get: function (store, key) {
      return tx(store, 'readonly').then(function (os) { return reqToPromise(os.get(key)); });
    },
    delete: function (store, key) {
      return tx(store, 'readwrite').then(function (os) { return reqToPromise(os.delete(key)); });
    },
    getAll: function (store) {
      return tx(store, 'readonly').then(function (os) { return reqToPromise(os.getAll()); });
    },
    /* 写真を工事IDで取得（index 利用） */
    getPhotosByProject: function (projectId) {
      return tx('photos', 'readonly').then(function (os) {
        return reqToPromise(os.index('projectId').getAll(projectId));
      });
    },
    /* アルバムを工事IDで取得（index 利用） */
    getAlbumsByProject: function (projectId) {
      return tx('albums', 'readonly').then(function (os) {
        return reqToPromise(os.index('projectId').getAll(projectId));
      });
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
