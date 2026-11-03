/* ============================================
   카카오맵 연동 (index.html 전용) — 지도 표시와 핀만 담당
   - 화장실 데이터는 가져오지 않습니다 (데이터는 JSON / 서울시 API)
   - 좌표가 없는 JSON 항목만 주소 → 좌표 변환(지오코더) 후 LocalStorage에 캐시
   ============================================ */

const KakaoMap = (() => {
  const KEY = (window.KAKAO_JS_KEY || "").trim();
  let map, geocoder, places;
  let ready = false;
  let onSelect = () => {};
  let myOverlay = null;
  const markers = new Map();    // id -> { ov, el }

  const hasKey = () => KEY.length > 0;

  function loadSdk() {
    return new Promise((resolve, reject) => {
      if (window.kakao && kakao.maps) return kakao.maps.load(resolve);
      const s = document.createElement("script");
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KEY)}&libraries=services&autoload=false`;
      s.onload = () => kakao.maps.load(resolve);
      s.onerror = () => reject(new Error("카카오 SDK를 불러오지 못했습니다 (키·도메인 등록 확인)"));
      document.head.appendChild(s);
    });
  }

  async function init(opts) {
    if (!hasKey()) throw new Error("no key");
    onSelect = opts.onSelect || onSelect;
    await loadSdk();
    map = new kakao.maps.Map(opts.el, {
      center: new kakao.maps.LatLng(opts.center.lat, opts.center.lng),
      level: 5,
    });
    geocoder = new kakao.maps.services.Geocoder();
    places = new kakao.maps.services.Places(); // 주소 변환 실패 시 '이름'으로 위치만 찾는 용도
    kakao.maps.event.addListener(map, "click", () => opts.onMapClick && opts.onMapClick());
    ready = true;
    window.addEventListener("resize", () => map && map.relayout());
  }

  /* ---------- 주소 → 좌표 ---------- */
  const clean = (a) => (a ? String(a).replace(/\(.*?\)/g, "").split(",")[0].trim() : "");

  function addressSearch(addr) {
    return new Promise((resolve) => {
      if (!addr) return resolve(null);
      geocoder.addressSearch(addr, (res, status) => {
        resolve(status === kakao.maps.services.Status.OK && res[0] ? [parseFloat(res[0].y), parseFloat(res[0].x)] : null);
      });
    });
  }
  function keywordFirst(q) {
    return new Promise((resolve) => {
      places.keywordSearch(q, (res, status) => {
        resolve(status === kakao.maps.services.Status.OK && res[0] ? [parseFloat(res[0].y), parseFloat(res[0].x)] : null);
      });
    });
  }
  async function geocodeOne(t) {
    const road = clean(t.roadAddress);
    const tries = [road, road.replace(/\s지하(\d)/, " $1"), clean(t.lotAddress)];
    for (const addr of tries) {
      const r = await addressSearch(addr);
      if (r) return r;
    }
    // 마지막 수단: '구 + 이름'으로 키워드 검색
    return keywordFirst(`${t.district || ""} ${t.name}`);
  }

  /* 좌표가 없는 항목만 변환 (4개씩 병렬). 결과는 캐시에 저장 */
  async function geocodeAll(list, onProgress) {
    if (!ready) return;
    const cache = App.GEO.cache();
    const todo = list.filter((t) => {
      if (t.lat != null) return false;           // 서울시 API 항목은 좌표가 이미 있음
      if (cache[t.id]) { t.lat = cache[t.id][0]; t.lng = cache[t.id][1]; return false; }
      return true;
    });
    let i = 0, done = 0;
    async function worker() {
      while (i < todo.length) {
        const t = todo[i++];
        const r = await geocodeOne(t);
        if (r) { t.lat = r[0]; t.lng = r[1]; cache[t.id] = r; }
        if (++done % 10 === 0 || done === todo.length) {
          App.GEO.saveCache(cache);
          onProgress && onProgress(done, todo.length);
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    App.GEO.saveCache(cache);
    const failed = list.filter((t) => t.lat == null).length;
    if (failed) console.warn(`[KakaoMap] 좌표를 찾지 못한 화장실 ${failed}건 (목록에는 표시, 지도 핀은 없음)`);
  }

  /* ---------- 핀 ---------- */
  function makeMarker(t) {
    const el = document.createElement("div");
    el.className = `map-pin status-${t.status || "open"}`;
    el.title = t.name;
    el.addEventListener("click", (e) => { e.stopPropagation(); onSelect(t); });
    const ov = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(t.lat, t.lng),
      content: el, xAnchor: 0, yAnchor: 0,
      zIndex: t.source === "api" ? 2 : 1,
    });
    return { ov, el };
  }
  /* list에 들어 있는(필터 통과한) 항목의 핀만 보이게 한다 */
  function showMarkers(list) {
    if (!ready) return;
    const visible = new Set();
    list.forEach((t) => {
      if (t.lat == null || t.lng == null) return;
      visible.add(t.id);
      let m = markers.get(t.id);
      if (!m) { m = makeMarker(t); markers.set(t.id, m); }
      m.ov.setMap(map);
    });
    markers.forEach((m, id) => { if (!visible.has(id)) m.ov.setMap(null); });
  }

  function setMyPos(o) {
    if (!ready) return;
    const pos = new kakao.maps.LatLng(o.lat, o.lng);
    if (!myOverlay) {
      const el = document.createElement("div");
      el.className = "loc-dot";
      myOverlay = new kakao.maps.CustomOverlay({ position: pos, content: el, xAnchor: 0, yAnchor: 0, zIndex: 3 });
      myOverlay.setMap(map);
    } else myOverlay.setPosition(pos);
    map.setCenter(pos);
  }
  function panTo(t) {
    if (ready && t.lat != null) map.panTo(new kakao.maps.LatLng(t.lat, t.lng));
  }
  function fitTo(list) {
    if (!ready) return;
    const pts = list.filter((t) => t.lat != null);
    if (!pts.length) return;
    const b = new kakao.maps.LatLngBounds();
    pts.forEach((t) => b.extend(new kakao.maps.LatLng(t.lat, t.lng)));
    map.setBounds(b, 120, 40, 120, 40);
  }

  /* 상세 페이지용: 화장실 한 곳을 크게 확대해서 보여 준다 */
  async function showOne(el, t) {
    await init({ el, center: t.lat != null ? { lat: t.lat, lng: t.lng } : App.GEO.getOrigin() });
    map.setLevel(2);                         // 숫자가 작을수록 확대 (1~14)
    map.setDraggable(false);
    map.setZoomable(false);
    if (t.lat == null) await geocodeAll([t]);   // 좌표가 아직 없으면 주소로 변환
    if (t.lat == null) return false;
    map.setCenter(new kakao.maps.LatLng(t.lat, t.lng));
    showMarkers([t]);
    return true;
  }

  /* 로드뷰: el 안에 가장 가까운 거리뷰를 띄운다. 근처(100m)에 로드뷰가 없으면 null.
     el은 화면에 보이는(크기가 있는) 상태여야 한다. */
  function openRoadview(el, t) {
    return new Promise((resolve) => {
      if (!ready || t.lat == null || t.lng == null) return resolve(null);
      const client = new kakao.maps.RoadviewClient();
      const pos = new kakao.maps.LatLng(t.lat, t.lng);
      client.getNearestPanoId(pos, 100, (panoId) => {
        if (panoId == null) return resolve(null);
        el.innerHTML = "";
        const rv = new kakao.maps.Roadview(el);
        rv.setPanoId(panoId, pos);
        resolve(rv);
      });
    });
  }

  /* 메인 지도: 특정 화장실이 가운데에 오도록 이동 (상세 → 메인 이동 시 위치 유지) */
  function focusOn(t, level) {
    if (!ready || t.lat == null || t.lng == null) return false;
    map.setLevel(level || 3);
    map.setCenter(new kakao.maps.LatLng(t.lat, t.lng));
    return true;
  }

  return { hasKey, init, showOne, openRoadview, focusOn, geocodeAll, showMarkers, setMyPos, panTo, fitTo, isReady: () => ready };
})();
