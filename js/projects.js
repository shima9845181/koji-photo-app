/* projects.js  ---  工事（案件）の作成・選択・切替
   現在選択中の工事を軸に他画面が動く。 */
(function (global) {
  'use strict';
  var Storage = global.App.Storage;
  var UI = global.App.UI;

  var CURRENT_KEY = 'currentProjectId';
  var _current = null;      // 現在の工事オブジェクト
  var _listeners = [];      // 工事切替時のコールバック

  function onChange(fn) { _listeners.push(fn); }
  function emit() { _listeners.forEach(function (fn) { try { fn(_current); } catch (e) {} }); }

  function current() { return _current; }

  function list() {
    return Storage.getAll('projects').then(function (rows) {
      rows.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      return rows;
    });
  }

  function create(name, client) {
    var p = {
      id: Storage.newId('prj'),
      name: name,
      client: client || '',
      createdAt: Date.now()
    };
    return Storage.put('projects', p).then(function () { return p; });
  }

  function select(id) {
    return Storage.get('projects', id).then(function (p) {
      _current = p || null;
      return Storage.setSetting(CURRENT_KEY, _current ? _current.id : null);
    }).then(function () { emit(); return _current; });
  }

  function update(project) {
    return Storage.put('projects', project).then(function () {
      if (_current && _current.id === project.id) { _current = project; emit(); }
      return project;
    });
  }

  function remove(id) {
    // 工事に紐づく写真も一緒に削除する
    return Storage.getPhotosByProject(id).then(function (photos) {
      return Promise.all(photos.map(function (ph) { return Storage.delete('photos', ph.id); }));
    }).then(function () {
      return Storage.delete('projects', id);
    }).then(function () {
      if (_current && _current.id === id) { _current = null; return Storage.setSetting(CURRENT_KEY, null); }
    }).then(function () { emit(); });
  }

  /* 起動時：前回の工事を復元 */
  function init() {
    return Storage.getSetting(CURRENT_KEY, null).then(function (id) {
      if (!id) { emit(); return null; }
      return select(id);
    });
  }

  /* 新規作成ダイアログ（最前面） */
  function createDialog() {
    return UI.prompt('新しい工事を作成', [
      { name: 'name', label: '工事名', placeholder: '例：○○地内 電気設備工事' },
      { name: 'client', label: '発注者（任意）', placeholder: '例：京都府 / 民間 / 自社' }
    ]).then(function (v) {
      if (!v || !v.name) return null;
      return create(v.name, v.client).then(function (p) {
        return select(p.id).then(function () {
          UI.toast('工事「' + p.name + '」を作成しました');
          return p;
        });
      });
    });
  }

  global.App.Projects = {
    onChange: onChange, current: current, list: list, create: create,
    select: select, update: update, remove: remove, init: init, createDialog: createDialog
  };
})(window);
