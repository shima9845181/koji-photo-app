/* ui.js  ---  最前面モーダル（確認・入力・完了通知）と共通UIヘルパ
   確認事項は必ず画面の一番前（最前面）に表示する、という要件に対応。 */
(function (global) {
  'use strict';

  /* HTML エスケープ（キャプション等をそのまま表示するとき用） */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function overlay() {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    return ov;
  }

  function mount(ov) {
    document.body.appendChild(ov);
    // フォーカスを最前面へ
    var f = ov.querySelector('input, textarea, button');
    if (f) setTimeout(function () { f.focus(); }, 30);
  }

  function close(ov) {
    if (ov && ov._escHandler) { document.removeEventListener('keydown', ov._escHandler); ov._escHandler = null; }
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  /* Escape で閉じる（最前面のオーバーレイだけ反応） */
  function enableEsc(ov, onEsc) {
    function onKey(e) {
      if (e.key !== 'Escape') return;
      var all = document.querySelectorAll('.modal-overlay');
      if (all.length && all[all.length - 1] !== ov) return; // 最前面のみ
      e.preventDefault();
      onEsc();
    }
    document.addEventListener('keydown', onKey);
    ov._escHandler = onKey;
  }

  var UI = {
    esc: esc,

    /* 完了通知・お知らせ（OK のみ） */
    alert: function (message, title) {
      return new Promise(function (resolve) {
        var ov = overlay();
        ov.innerHTML =
          '<div class="modal">' +
          '<h2>' + esc(title || 'お知らせ') + '</h2>' +
          '<p class="modal-msg">' + esc(message).replace(/\n/g, '<br>') + '</p>' +
          '<div class="modal-actions">' +
          '<button class="btn btn-primary" data-ok>OK</button>' +
          '</div></div>';
        mount(ov);
        ov.querySelector('[data-ok]').onclick = function () { close(ov); resolve(true); };
        enableEsc(ov, function () { close(ov); resolve(true); });
      });
    },

    /* はい／いいえの確認 */
    confirm: function (message, title) {
      return new Promise(function (resolve) {
        var ov = overlay();
        ov.innerHTML =
          '<div class="modal">' +
          '<h2>' + esc(title || '確認') + '</h2>' +
          '<p class="modal-msg">' + esc(message).replace(/\n/g, '<br>') + '</p>' +
          '<div class="modal-actions">' +
          '<button class="btn" data-no>いいえ</button>' +
          '<button class="btn btn-primary" data-yes>はい</button>' +
          '</div></div>';
        mount(ov);
        ov.querySelector('[data-yes]').onclick = function () { close(ov); resolve(true); };
        ov.querySelector('[data-no]').onclick = function () { close(ov); resolve(false); };
        enableEsc(ov, function () { close(ov); resolve(false); });
      });
    },

    /* 複数ボタンから選ぶ。buttons: [{key,label,primary?}] → 選んだ key（Esc/×は null） */
    choose: function (message, title, buttons) {
      return new Promise(function (resolve) {
        var ov = overlay();
        var btnHtml = buttons.map(function (b, i) {
          return '<button class="btn ' + (b.primary ? 'btn-primary' : '') + '" data-i="' + i + '">' + esc(b.label) + '</button>';
        }).join('');
        ov.innerHTML =
          '<div class="modal">' +
          '<h2>' + esc(title || '確認') + '</h2>' +
          '<p class="modal-msg">' + esc(message).replace(/\n/g, '<br>') + '</p>' +
          '<div class="modal-actions modal-actions-wrap">' + btnHtml + '</div></div>';
        mount(ov);
        Array.prototype.forEach.call(ov.querySelectorAll('[data-i]'), function (bt) {
          bt.onclick = function () { var k = buttons[+bt.getAttribute('data-i')].key; close(ov); resolve(k); };
        });
        enableEsc(ov, function () { close(ov); resolve(null); });
      });
    },

    /* 1行入力（工事名など）。fields: [{name,label,value,type}] */
    prompt: function (title, fields) {
      return new Promise(function (resolve) {
        var ov = overlay();
        var body = fields.map(function (f, i) {
          return '<label class="field">' +
            '<span>' + esc(f.label) + '</span>' +
            '<input data-i="' + i + '" type="' + (f.type || 'text') + '" ' +
            'value="' + esc(f.value || '') + '" ' +
            'placeholder="' + esc(f.placeholder || '') + '">' +
            '</label>';
        }).join('');
        ov.innerHTML =
          '<div class="modal">' +
          '<h2>' + esc(title) + '</h2>' +
          '<div class="modal-body">' + body + '</div>' +
          '<div class="modal-actions">' +
          '<button class="btn" data-cancel>キャンセル</button>' +
          '<button class="btn btn-primary" data-ok>OK</button>' +
          '</div></div>';
        mount(ov);
        function collect() {
          var out = {};
          Array.prototype.forEach.call(ov.querySelectorAll('input[data-i]'), function (inp) {
            out[fields[+inp.getAttribute('data-i')].name] = inp.value.trim();
          });
          return out;
        }
        ov.querySelector('[data-ok]').onclick = function () { var v = collect(); close(ov); resolve(v); };
        ov.querySelector('[data-cancel]').onclick = function () { close(ov); resolve(null); };
        ov.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && e.target.tagName === 'INPUT') { var v = collect(); close(ov); resolve(v); }
        });
        enableEsc(ov, function () { close(ov); resolve(null); });
      });
    },

    /* 任意DOMを最前面モーダルで表示。closeFn を返す。 */
    modal: function (contentNode, title) {
      var ov = overlay();
      var box = document.createElement('div');
      box.className = 'modal modal-wide';
      var h = document.createElement('h2');
      h.textContent = title || '';
      box.appendChild(h);
      box.appendChild(contentNode);
      var actions = document.createElement('div');
      actions.className = 'modal-actions';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'btn btn-primary';
      closeBtn.textContent = '閉じる';
      actions.appendChild(closeBtn);
      box.appendChild(actions);
      ov.appendChild(box);
      mount(ov);
      var doClose = function () { close(ov); };
      closeBtn.onclick = doClose;
      enableEsc(ov, doClose);
      return doClose;
    },

    /* 処理中スピナー（await 中の重い処理用）。close 関数を返す。 */
    busy: function (message) {
      var ov = overlay();
      ov.innerHTML =
        '<div class="modal modal-busy">' +
        '<div class="spinner"></div>' +
        '<p class="modal-msg">' + esc(message || '処理中…') + '</p>' +
        '</div>';
      mount(ov);
      var msgEl = ov.querySelector('.modal-msg');
      return {
        update: function (m) { if (msgEl) msgEl.textContent = m; },
        close: function () { close(ov); }
      };
    },

    /* トースト（軽い通知、自動で消える） */
    toast: function (message) {
      var t = document.createElement('div');
      t.className = 'toast';
      t.textContent = message;
      document.body.appendChild(t);
      setTimeout(function () { t.classList.add('show'); }, 10);
      setTimeout(function () {
        t.classList.remove('show');
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
      }, 2600);
    }
  };

  global.App = global.App || {};
  global.App.UI = UI;
})(window);
