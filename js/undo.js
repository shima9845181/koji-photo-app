/* undo.js  ---  戻る／進む（Undo/Redo）
   写真レコードの「変更前後スナップショット」をスタックに積み、元に戻す/やり直す。
   セッション内のみ有効（ブラウザを閉じると消える）。 */
(function (global) {
  'use strict';
  var Storage = global.App.Storage;
  var UI = global.App.UI;

  var _undo = [];   // 各要素：changes 配列 [{ key, before, after }]（store は photos 固定）
  var _redo = [];
  var _listeners = [];

  function emit() { _listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  function onChange(fn) { _listeners.push(fn); }
  function canUndo() { return _undo.length > 0; }
  function canRedo() { return _redo.length > 0; }
  function clear() { _undo = []; _redo = []; emit(); }

  /* 写真レコードの浅いコピー（blob/thumbBlob は同一参照で保持＝復元可能） */
  function snapshot(photo) { return photo ? Object.assign({}, photo) : null; }

  /* changes: [{ key, before, after }] を undo スタックへ。redo はクリア */
  function record(changes) {
    if (!changes || !changes.length) return;
    _undo.push(changes);
    _redo = [];
    emit();
  }

  function applyState(key, state) {
    return state === null ? Storage.delete('photos', key) : Storage.put('photos', state);
  }

  function undo() {
    if (!_undo.length) return Promise.resolve();
    var changes = _undo.pop();
    return changes.reduce(function (chain, ch) {
      return chain.then(function () { return applyState(ch.key, ch.before); });
    }, Promise.resolve()).then(function () {
      _redo.push(changes);
      emit();
      if (global.App.Photos) global.App.Photos.reload();
      UI.toast('元に戻しました');
    });
  }

  function redo() {
    if (!_redo.length) return Promise.resolve();
    var changes = _redo.pop();
    return changes.reduce(function (chain, ch) {
      return chain.then(function () { return applyState(ch.key, ch.after); });
    }, Promise.resolve()).then(function () {
      _undo.push(changes);
      emit();
      if (global.App.Photos) global.App.Photos.reload();
      UI.toast('やり直しました');
    });
  }

  global.App = global.App || {};
  global.App.Undo = {
    snapshot: snapshot, record: record, undo: undo, redo: redo,
    canUndo: canUndo, canRedo: canRedo, onChange: onChange, clear: clear
  };
})(window);
