/* history.js  ---  分類項目の入力履歴（全工事共通）
   工種・種別・細別・撮影区分・撮影箇所の既出値を保持し、詳細フォームの
   候補（datalist）として検索・選択できるようにする。 */
(function (global) {
  'use strict';
  var Storage = global.App.Storage;

  var FIELDS = ['koushu', 'shubetsu', 'saibetsu', 'kubun', 'spot'];
  /* 撮影区分の既定候補（履歴が空でも出す） */
  var KUBUN_DEFAULT = ['着手前', '施工状況', '完成', '安全管理', '使用材料', '出来形管理', '品質管理', 'その他'];

  var _map = { koushu: {}, shubetsu: {}, saibetsu: {}, kubun: {}, spot: {} }; // 値の集合（オブジェクトをSet代わりに）

  function addTo(field, value) {
    if (!value) return;
    value = String(value).trim();
    if (!value) return;
    if (!_map[field]) return;
    _map[field][value] = true;
  }

  function persist() {
    var plain = {};
    FIELDS.forEach(function (f) { plain[f] = Object.keys(_map[f]); });
    return Storage.setSetting('fieldHistory', plain);
  }

  /* 起動時：保存済み履歴＋全工事の写真から横断的にマージ（全工事共通） */
  function init() {
    return Storage.getSetting('fieldHistory', null).then(function (saved) {
      if (saved) FIELDS.forEach(function (f) { (saved[f] || []).forEach(function (v) { addTo(f, v); }); });
      KUBUN_DEFAULT.forEach(function (v) { addTo('kubun', v); });
      return Storage.getAll('photos');
    }).then(function (photos) {
      (photos || []).forEach(function (p) {
        FIELDS.forEach(function (f) { addTo(f, p[f]); });
      });
    }).catch(function () {});
  }

  /* 1件の写真オブジェクトから全項目を取り込み（保存・取り込み時に呼ぶ） */
  function addFromPhoto(p) {
    FIELDS.forEach(function (f) { addTo(f, p[f]); });
    return persist();
  }

  function list(field) {
    if (!_map[field]) return [];
    return Object.keys(_map[field]).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
  }

  global.App = global.App || {};
  global.App.History = {
    FIELDS: FIELDS, KUBUN_DEFAULT: KUBUN_DEFAULT,
    init: init, addFromPhoto: addFromPhoto, list: list
  };
})(window);
