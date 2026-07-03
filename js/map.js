/* map.js  ---  簡易地図（Leaflet）。タイルはオンライン時のみ表示。
   クリックで位置を設定・修正できる。オフライン時は緯度経度の手入力で代替。 */
(function (global) {
  'use strict';

  var DEFAULT = { lat: 35.0116, lng: 135.7681, zoom: 15 }; // 京都駅付近

  /* holder: 表示先DOM, lat/lng: 初期位置(nullなら既定), onPick(lat,lng): クリック時 */
  function show(holder, lat, lng, onPick) {
    if (!global.L) {
      holder.innerHTML = '<div class="map-note">地図の表示にはインターネット接続が必要です。' +
        '緯度・経度は手入力してください。</div>';
      return null;
    }
    holder.innerHTML = '';
    var has = (lat != null && lng != null);
    var c = { lat: has ? lat : DEFAULT.lat, lng: has ? lng : DEFAULT.lng };

    var map = L.map(holder).setView([c.lat, c.lng], has ? 16 : DEFAULT.zoom);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(map);

    var marker = null;
    // 既定マーカー画像を同梱していないため circleMarker を使う（オフラインでも表示可）
    function place(la, lo) {
      if (marker) marker.setLatLng([la, lo]);
      else marker = L.circleMarker([la, lo], { radius: 9, color: '#c0392b', weight: 3, fillColor: '#e74c3c', fillOpacity: 0.7 }).addTo(map);
    }
    if (has) place(lat, lng);

    map.on('click', function (e) {
      place(e.latlng.lat, e.latlng.lng);
      if (onPick) onPick(e.latlng.lat, e.latlng.lng);
    });

    // モーダル内でサイズが確定してから再計算
    setTimeout(function () { map.invalidateSize(); }, 60);
    return map;
  }

  global.App = global.App || {};
  global.App.Map = { show: show };
})(window);
