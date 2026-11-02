/* ============================================
   카카오맵 연동 (index.html 전용)
   - SDK 로드, 지도/핀 표시
   - JSON 200건: 주소 → 좌표 변환(지오코더) 후 LocalStorage 캐시
   - 추가분: 지도 화면 주변 '공중화장실' 키워드 검색(최대 EXTRA_MAX건)
   ============================================ */

const KakaoMap = (() => {
  const KEY = (window.KAKAO_JS_KEY || "").trim();
  const EXTRA_MAX = 100;        // 카카오 검색으로 추가할 최대 개수
  const EXTRA_RADIUS = 2000;    // 검색 반경(m)
  const DUP_DISTANCE = 60;      // JSON 항목과 이 거리(m) 이내면 같은 화장실로 보고 제외

  let map, geocoder, places;
  let ready = false;
  let geoDone = false;
  let getKnown = () => [];
  let onExtras = () => {};
  let onSelect = () => {};
  let myOverlay = null;
  const markers = new Map();    // id -> { ov, el }
  const extras = new Map();     // id -> item
  let searchTimer = null;

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
    onExtras = opts.onExtras || onExtras;
    getKnown = opts.getKnown || getKnown;
    await loadSdk();
    map = new kakao.maps.Map(opts.el, {
      center: new kakao.maps.LatLng(opts.center.lat, opts.center.lng),
      level: 5,
    });
    geocoder = new kakao.maps.services.Geocoder();
    places = new kakao.maps.services.Places();
    kakao.maps.event.addListener(map, "click", () => opts.onMapClick && opts.onMapClick());
    kakao.maps.event.addListener(map, "idle", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(searchHere, 600);
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
    geoDone = true;
    const failed = list.filter((t) => t.lat == null).length;
    if (failed) console.warn(`[KakaoMap] 좌표를 찾지 못한 화장실 ${failed}건 (목록에는 표시, 지도 핀은 없음)`);
    searchHere();
  }

  /* ---------- 주변 '공중화장실' 검색 (추가분) ---------- */
  const norm = (s) => String(s || "").replace(/\s+/g, "");
  function isDuplicate(p, known) {
    const pos = { lat: +p.y, lng: +p.x };
    return known.some((t) => {
      if (t.lat == null) return false;
      const d = App.GEO.haversine(pos, t);
      return d <= DUP_DISTANCE || (d <= 200 && norm(t.name) === norm(p.place_name));
    });
  }
  function searchHere() {
    if (!ready || !geoDone || extras.size >= EXTRA_MAX) return;
    const c = map.getCenter();
    const known = getKnown();
    let added = 0;
    const handle = (data, status, pagination) => {
      if (status !== kakao.maps.services.Status.OK) return;
      data.forEach((p) => {
        const id = "k" + p.id;
        if (extras.has(id) || extras.size >= EXTRA_MAX) return;
        if (!/화장실/.test(p.place_name) && !/화장실/.test(p.category_name || "")) return;
        if (isDuplicate(p, known)) return;
        extras.set(id, {
          id, source: "kakao", placeUrl: p.place_url,
          name: p.place_name,
          area: (p.address_name || "").split(" ")[1] || "",
          address: p.road_address_name || p.address_name || "",
          phone: p.phone || "",
          lat: +p.y, lng: +p.x,
          status: "unknown",
          hasStepFree: false, hasBell: false, hasCctv: false, hasDiaperTable: false,
          distanceM: null,
        });
        added++;
      });
      if (pagination && pagination.hasNextPage && pagination.current < 3 && extras.size < EXTRA_MAX) {
        pagination.nextPage();
      } else if (added > 0) {
        onExtras([...extras.values()]);
        added = 0;
      }
    };
    places.keywordSearch("공중화장실", handle, {
      location: c, radius: EXTRA_RADIUS, sort: kakao.maps.services.SortBy.DISTANCE,
    });
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
      zIndex: t.source === "kakao" ? 1 : 2,
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

  return { hasKey, init, geocodeAll, showMarkers, setMyPos, panTo, fitTo, isReady: () => ready };
})();
