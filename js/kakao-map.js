/* ============================================
   카카오맵 연동 (index.html · detail.html) — 지도 표시와 핀만 담당
   - 화장실 데이터는 가져오지 않습니다 (데이터는 JSON / 서울시 API)
   - 좌표가 없는 JSON 항목만 주소 → 좌표 변환(지오코더) 후 LocalStorage에 캐시
   ============================================ */

const KakaoMap = (() => {
  const KEY = (window.KAKAO_JS_KEY || "").trim();
  let map, geocoder, places;
  let ready = false;
  let onSelect = () => {};
  let myHalo = null, myDot = null;   // 내 위치: 하늘색 원(핀 아래) + 파란 점(핀 위)
  const markers = new Map();    // id -> { ov, el, z }
  let selectedId = null;         // 지금 선택된(크게 보이는) 핀의 화장실 id
  let lastPinPress = 0;          // 마지막으로 핀을 누르기 시작한 시각 (지도 클릭과 구분용)

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
    kakao.maps.event.addListener(map, "click", () => {
      if (Date.now() - lastPinPress < 600) return;   // 핀을 누른 것이면 지도 클릭으로 처리하지 않음
      selectMarker(null);
      opts.onMapClick && opts.onMapClick();
    });
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

  /* ---------- 핀 ----------
     모양: 물방울(지도 핀) + 가운데 뚫린 원. 색: J(공공데이터) 초록 · A(서울시 API) 노랑.
     스타일을 여기서 직접 지정해 style.css의 예전 .map-pin 규칙(회전·테두리)과 섞이지 않게 했다. */
  const PIN_COLORS = {
    open: "#22B75E",     // J 공공데이터 — 초록
    api: "#FFB400",      // A 서울시 API — 노랑
    unknown: "#9AA3A0",  // 예비
    broken: "#B3463C",   // 예비
  };
  const PIN_SIZE = 30;
  const PIN_PATH = "M15 28.5L7.53 21.57A11 11 0 1 1 22.47 21.57Z";
  /* 가운데 원은 구멍(투명)이 아니라 흰색으로 채운다.
     같은 좌표에 화장실이 여러 곳이면 핀이 겹쳐 있어서, 구멍이면 아래 핀 색이 비쳐 원이 메워져 보였다. */
  const PIN_DOT = `<circle cx="15" cy="13.5" r="2.6" fill="#fff"/>`;

  function makeMarker(t) {
    const status = t.status || "open";
    const el = document.createElement("div");
    el.className = `map-marker status-${status}`;
    el.title = t.name;
    el.style.cssText = `width:${PIN_SIZE}px;height:${PIN_SIZE}px;cursor:pointer;line-height:0;` +
      `transform-origin:50% ${(28.5 / 30) * 100}%;transition:transform .15s ease`;   // 커질 때 핀 끝이 제자리에 머물도록
    el.innerHTML =
      `<svg width="${PIN_SIZE}" height="${PIN_SIZE}" viewBox="0 0 30 30" aria-hidden="true">` +
      `<path fill="${PIN_COLORS[status] || PIN_COLORS.open}" d="${PIN_PATH}"/>${PIN_DOT}</svg>`;
    /* 핀을 누르면 카카오 지도 자체의 '지도 클릭'도 함께 일어나 선택이 풀려 버렸다 (그래서 두 번째 누름이 안 먹힘).
       누르기 시작할 때 지도 이벤트를 막고, 그 순간 이미 커져 있던 핀인지 기억해 둔다. */
    let pressWasSelected = false;
    const onPress = () => {
      pressWasSelected = selectedId === t.id;
      lastPinPress = Date.now();
      if (window.kakao && kakao.maps.event.preventMap) kakao.maps.event.preventMap();
    };
    el.addEventListener("mousedown", onPress);
    el.addEventListener("touchstart", onPress, { passive: true });
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasSelected = pressWasSelected || selectedId === t.id;
      pressWasSelected = false;
      selectMarker(t.id);
      onSelect(t, wasSelected);
    });
    const ov = new kakao.maps.CustomOverlay({
      position: new kakao.maps.LatLng(t.lat, t.lng),
      content: el,
      xAnchor: 0.5, yAnchor: 28.5 / 30,   // 핀 끝(뾰족한 부분)이 정확한 좌표를 가리키도록
      zIndex: t.source === "api" ? 2 : 1,
    });
    return { ov, el, z: t.source === "api" ? 2 : 1 };
  }

  /* 선택한 핀만 크게 (다른 핀 위로 올라오게). id 가 null 이면 선택 해제 */
  const SELECTED_SCALE = 1.4;   // ← 선택했을 때 크기 배율 (1.4 = 1.4배)
  function selectMarker(id) {
    if (selectedId && markers.has(selectedId)) {
      const prev = markers.get(selectedId);
      prev.el.style.transform = "";
      prev.ov.setZIndex(prev.z);
    }
    selectedId = id;
    if (id && markers.has(id)) {
      const cur = markers.get(id);
      cur.el.style.transform = `scale(${SELECTED_SCALE})`;
      cur.ov.setZIndex(10);
    }
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

  /* ---------- 내 위치 ----------
     디자인: 흰 테두리의 파란 점(#50B0F9) + 가운데가 진하고 바깥으로 갈수록 옅어지는 하늘색 원.
     스타일을 여기서 직접 지정해 style.css의 다른 규칙(.loc-dot 등)과 섞이지 않게 했다. */
  const MY_HALO_STYLE = [
    "width:78px", "height:78px", "border-radius:50%", "pointer-events:none",
    "background:radial-gradient(circle," +
      "rgba(80,176,249,.50) 0%," +
      "rgba(80,176,249,.47) 28%," +
      "rgba(80,176,249,.39) 47%," +
      "rgba(80,176,249,.24) 70%," +
      "rgba(80,176,249,.15) 85%," +
      "rgba(80,176,249,.08) 95%," +
      "rgba(80,176,249,0) 100%)",
  ].join(";");
  const MY_DOT_STYLE = [
    "box-sizing:border-box", "width:20px", "height:20px", "border-radius:50%",
    "background:#50B0F9", "border:3px solid #fff",
    "box-shadow:0 1px 3px rgba(0,0,0,.18)", "pointer-events:none",
  ].join(";");

  function setMyPos(o, opts = {}) {
    if (!ready) return;
    const pos = new kakao.maps.LatLng(o.lat, o.lng);
    if (!myDot) {
      const make = (cls, style) => {
        const el = document.createElement("div");
        el.className = cls;
        el.style.cssText = style;
        return el;
      };
      // 원은 화장실 핀 아래(zIndex 0)에 깔아 핀 클릭을 막지 않고, 점은 핀 위(zIndex 3)에 둔다
      myHalo = new kakao.maps.CustomOverlay({ position: pos, content: make("my-loc-halo", MY_HALO_STYLE), xAnchor: 0.5, yAnchor: 0.5, zIndex: 0 });
      myDot = new kakao.maps.CustomOverlay({ position: pos, content: make("my-loc-dot", MY_DOT_STYLE), xAnchor: 0.5, yAnchor: 0.5, zIndex: 3 });
      myHalo.setMap(map);
      myDot.setMap(map);
    } else {
      myHalo.setPosition(pos);
      myDot.setPosition(pos);
    }
    if (opts.center !== false) map.setCenter(pos);
  }

  /* 지도 위쪽 visibleH 픽셀만 보일 때(아래는 목록 시트가 덮음), 그 보이는 영역의 가운데에 o가 오도록 이동.
     visibleH를 생략하면 지도 전체의 가운데로 이동. smooth=false면 애니메이션 없이 바로 이동 */
  function centerInView(o, visibleH, smooth = true) {
    if (!ready || !o) return;
    const pos = new kakao.maps.LatLng(o.lat, o.lng);
    const node = map.getNode();
    const W = node.clientWidth, H = node.clientHeight;
    const vh = visibleH && visibleH > 0 && visibleH < H ? visibleH : H;
    const proj = map.getProjection();
    const p = proj.containerPointFromCoords(pos);              // 지금 화면에서 o가 있는 위치
    // o가 (W/2, vh/2)에 오려면, 지금 화면에서 (p.x, p.y + (H - vh)/2) 지점이 새 중심이 되면 된다
    const center = proj.coordsFromContainerPoint(new kakao.maps.Point(p.x, p.y + (H - vh) / 2));
    if (smooth) map.panTo(center); else map.setCenter(center);
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
    selectMarker(t.id);   // 상세 → 지도로 돌아왔을 때도 그 화장실 핀을 크게
    return true;
  }

  return { selectMarker, hasKey, init, showOne, openRoadview, focusOn, geocodeAll, showMarkers, setMyPos, centerInView, panTo, fitTo, isReady: () => ready };
})();
