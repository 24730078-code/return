/* ============================================
   사용자 유형별 맞춤형 공공화장실 큐레이터 및 안심 지도
   공통 로직: 데이터 로드 · LocalStorage · 헤더/탭바 렌더링
   ============================================ */

const App = (() => {
  const IN_PAGES = location.pathname.includes("/pages/");
  const DATA_URL = IN_PAGES ? "../data/toilets_seoul_jung.json" : "./data/toilets_seoul_jung.json";
  const HOME_URL = IN_PAGES ? "../index.html" : "./index.html";
  const pageUrl = (name) => (IN_PAGES ? `./${name}` : `pages/${name}`);

  const FAV_KEY = "pt_favorites";   // 즐겨찾기 id 배열
  const RECENT_KEY = "pt_recent";   // 최근 본 공간 [{id, viewedAt}]

  /* ---------- 위치/거리 (GEO) ----------
     JSON에는 좌표가 없어서, 카카오 지오코더로 구한 좌표를 LocalStorage에 캐시해 둡니다.
     (js/kakao-map.js가 좌표를 저장하고, 다른 페이지는 캐시를 읽어 거리를 계산합니다) */
  const GEO_KEY = "pt_geo_v1";       // { [id]: [lat, lng] }
  const ORIGIN_KEY = "pt_origin";    // 마지막으로 확인한 내 위치 {lat, lng}
  const DEFAULT_ORIGIN = { lat: 37.5665, lng: 126.9780 }; // 서울시청 (위치 권한 전 기본값)
  const GEO = (() => {
    const read = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) || fb; } catch { return fb; } };
    const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
    const getOrigin = () => read(ORIGIN_KEY, DEFAULT_ORIGIN);
    const setOrigin = (o) => write(ORIGIN_KEY, { lat: o.lat, lng: o.lng });
    function haversine(a, b) {
      const R = 6371000, rad = (d) => (d * Math.PI) / 180;
      const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    }
    const cache = () => read(GEO_KEY, {});
    const saveCache = (c) => write(GEO_KEY, c);
    function applyCache(list) {
      const c = cache();
      list.forEach((t) => { if (c[t.id]) { t.lat = c[t.id][0]; t.lng = c[t.id][1]; } });
    }
    function applyDistances(list) {
      const o = getOrigin();
      list.forEach((t) => {
        t.distanceM = t.lat != null && t.lng != null ? Math.round(haversine(o, t)) : null;
      });
    }
    function locate() {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error("geolocation unsupported"));
        navigator.geolocation.getCurrentPosition(
          (p) => { const o = { lat: p.coords.latitude, lng: p.coords.longitude }; setOrigin(o); resolve(o); },
          reject,
          { enableHighAccuracy: true, timeout: 8000 }
        );
      });
    }
    return { getOrigin, setOrigin, haversine, cache, saveCache, applyCache, applyDistances, locate, DEFAULT_ORIGIN };
  })();

  /* ---------- 데이터 로드 ----------
     data/toilets_seoul_jung.json(서울 중구·종로구 200건)을 불러와 화면에서 쓰는 형태로 가공합니다.
     ※ fetch()가 필요하므로 파일 더블클릭(file://)이 아니라 로컬 서버/GitHub Pages로 열어야 합니다. */
  function parseHours(raw) {
    const text = String(raw || "").trim();
    if (text === "상시") return { openTime: "00:00", closeTime: "24:00", hoursLabel: "상시 (24시간)" };
    const m = text.match(/(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})/);
    if (m) return { openTime: m[1].padStart(5, "0"), closeTime: m[2].padStart(5, "0"), hoursLabel: `${m[1]} – ${m[2]}` };
    return { openTime: "", closeTime: "", hoursLabel: text || "정보 없음" };
  }
  function normalize(r) {
    const disabledStalls = (r.maleDisabledToilet || 0) + (r.maleDisabledUrinal || 0) + (r.femaleDisabledToilet || 0);
    return {
      ...r,
      source: "json",
      area: r.district,
      address: r.roadAddress || r.lotAddress || "",
      image: "",
      disabledStalls,
      maleStalls: (r.maleToilet || 0) + (r.maleUrinal || 0) + (r.maleDisabledToilet || 0) + (r.maleDisabledUrinal || 0) + (r.maleChildToilet || 0) + (r.maleChildUrinal || 0),
      femaleStalls: (r.femaleToilet || 0) + (r.femaleDisabledToilet || 0) + (r.femaleChildToilet || 0),
      maleChild: (r.maleChildToilet || 0) + (r.maleChildUrinal || 0),
      femaleChild: r.femaleChildToilet || 0,
      hasStepFree: disabledStalls > 0,          // 장애인용 칸이 있으면 '무장애'로 분류
      hasBell: !!r.hasBell,
      hasCctv: !!r.hasCctv,
      hasDiaperTable: !!r.hasDiaperTable,
      genderSeparated: (r.maleToilet || 0) + (r.maleUrinal || 0) > 0 && (r.femaleToilet || 0) > 0,
      ...parseHours(r.openHours),
      status: "open",                            // 공공데이터 등재 = 개방. (카카오 검색 추가분은 'unknown')
      lat: null, lng: null, distanceM: null,
    };
  }

  /* ---------- A: 서울시 열린데이터광장 '역사공중화장실정보' (tbTrfcSttnToilet) ----------
     실시간 API를 먼저 시도하고, 안 되면 data/toilets_subway.json(같은 항목명)으로 대신합니다. */
  const API_BASE = "http://openapi.seoul.go.kr:8088";   // 서울시 API는 http만 지원
  const SUBWAY_JSON_URL = IN_PAGES ? "../data/toilets_subway.json" : "./data/toilets_subway.json";
  // A는 서울 전체 역사 화장실을 모두 사용합니다 (범위 제한 없음)
  const HIDE_SUBWAY_DUP = true;                          // J 중 지하철역 화장실은 A로 대체(숨김). false면 J도 모두 표시
  const dataStatus = { via: null, reason: "" };          // via: "api" | "json"

  const num = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
  const yes = (v) => String(v || "").trim().toUpperCase() === "Y";

  function normalizeApi(r) {
    const addr = String(r.ROAD_ADDRESS || "").trim();
    const lot = String(r.LOT_ADDRESS || "").trim();
    // 지역(구): 주소에서 '○○구'를 찾는다 (없으면 '○○시', 그래도 없으면 두 번째 단어)
    const guOf = (txt) => (txt.match(/(?:^|\s)([가-힣]+구)(?=\s|$)/) || [])[1];
    const area = guOf(addr) || guOf(lot) || (`${addr} ${lot}`.match(/(?:^|\s)([가-힣]+시)(?=\s|$)/) || [])[1] || (addr.split(" ")[1] || "");
    const station = String(r.STATION_NAME || "").trim();
    const gate = String(r.GATE_TYPE || "").trim();
    const exit = String(r.EXIT_NUMBER || "").trim();
    const disabled = num(r.MALE_DISABLED_TOILET_COUNT) + num(r.MALE_DISABLED_URINAL_COUNT) + num(r.FEMALE_DISABLED_TOILET_COUNT);
    const male = num(r.MALE_TOILET_COUNT) + num(r.MALE_URINAL_COUNT) + num(r.MALE_DISABLED_TOILET_COUNT) + num(r.MALE_DISABLED_URINAL_COUNT) + num(r.MALE_CHILD_TOILET_COUNT) + num(r.MALE_CHILD_URINAL_COUNT);
    const female = num(r.FEMALE_TOILET_COUNT) + num(r.FEMALE_DISABLED_TOILET_COUNT) + num(r.FEMALE_CHILD_TOILET_COUNT);
    const dM = yes(r.HAS_DIAPER_TABLE_MALE), dMD = yes(r.HAS_DIAPER_TABLE_MALE_DISABLED);
    const dF = yes(r.HAS_DIAPER_TABLE_FEMALE), dFD = yes(r.HAS_DIAPER_TABLE_FEMALE_DISABLED);
    const diaperParts = [(dMD || dFD) && "장애인화장실", dM && "남자화장실", dF && "여자화장실"].filter(Boolean);
    const lat = parseFloat(r.LATITUDE), lng = parseFloat(r.LONGITUDE);
    const hours = String(r.OPENING_HOURS || "").trim();
    return {
      id: "a" + String(r.SN).trim(),
      source: "api",
      name: `${station}역(${String(r.LINE_NAME || "").trim()}) ${gate}${exit ? ` · ${exit}번 출구` : ""}`.trim(),
      area, address: addr || lot, image: "",
      station, lineName: String(r.LINE_NAME || "").trim(),
      groundType: String(r.GROUND_TYPE || "").trim(), floor: String(r.FLOOR || "").trim(),
      gateType: gate, exitNumber: exit, detailLocation: String(r.DETAIL_LOCATION || "").replace(/\s+/g, " ").trim(),
      remodelingYear: String(r.REMODELING_YEAR || "").trim(),
      disabledStalls: disabled, maleStalls: male, femaleStalls: female,
      maleChild: num(r.MALE_CHILD_TOILET_COUNT) + num(r.MALE_CHILD_URINAL_COUNT),
      femaleChild: num(r.FEMALE_CHILD_TOILET_COUNT),
      hasStepFree: disabled > 0,
      hasBell: yes(r.HAS_EMERGENCY_BELL), bellLocation: null,
      hasCctv: yes(r.HAS_ENTRANCE_CCTV),
      hasDiaperTable: diaperParts.length > 0, diaperTableLocation: diaperParts.join("+") || null,
      safetyFacilityTarget: null,
      isUnisex: yes(r.IS_UNISEX), genderSeparated: !yes(r.IS_UNISEX),
      openHours: hours,
      ...parseHours(hours),
      updatedAt: String(r.DATA_DATE || "").trim(),
      status: "api",
      lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null, distanceM: null,
    };
  }

  async function fetchApiRows() {
    const key = (window.SEOUL_API_KEY || "").trim();
    if (!key) throw new Error("서울시 API 키가 비어 있음");
    if (location.protocol === "https:") throw new Error("https 페이지에서는 http API 호출이 브라우저에 막힘(혼합 콘텐츠)");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch(`${API_BASE}/${encodeURIComponent(key)}/json/tbTrfcSttnToilet/1/1000/`, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const body = await res.json();
      const root = body.tbTrfcSttnToilet;
      const code = root && root.RESULT && root.RESULT.CODE;
      if (!root || !Array.isArray(root.row) || (code && code !== "INFO-000")) throw new Error("API 응답 오류 " + (code || ""));
      return root.row;
    } finally { clearTimeout(timer); }
  }
  async function loadSubwayRows() {
    try {
      const rows = await fetchApiRows();
      dataStatus.via = "api"; dataStatus.reason = "";
      return rows;
    } catch (err) {
      console.warn("[App] 서울시 API를 쓰지 못해 대체 JSON(data/toilets_subway.json)으로 불러옵니다:", err.message || err);
      const res = await fetch(SUBWAY_JSON_URL);
      if (!res.ok) throw new Error("subway json " + res.status);
      dataStatus.via = "json"; dataStatus.reason = String(err.message || err);
      return res.json();
    }
  }

  /* J(공공화장실 JSON) 중 지하철역 화장실은 A의 자세한 정보로 대체 (이름이 '○○역(…)'으로 시작하는 것) */
  function isSubwayDup(t, stations) {
    const m = String(t.name).match(/^(.+?)역\s*(\(|화장실|공중화장실|$)/);
    if (!m) return false;
    const st = m[1] === "DDP" ? "동대문역사문화공원" : m[1];
    return stations.has(st);
  }

  let loading = null;
  function loadToilets() {
    if (!loading) {
      loading = (async () => {
        const [j, a] = await Promise.allSettled([loadJson(), loadSubwayRows()]);
        if (j.status === "rejected" && a.status === "rejected") throw j.reason;
        const jList = j.status === "fulfilled" ? j.value : [];
        const aList = a.status === "fulfilled" ? a.value.map(normalizeApi) : [];
        if (a.status === "rejected") { dataStatus.via = null; dataStatus.reason = String(a.reason); }
        const stations = new Set(aList.map((t) => t.station));
        const list = jList.filter((t) => !HIDE_SUBWAY_DUP || !isSubwayDup(t, stations)).concat(aList);
        GEO.applyCache(list);
        GEO.applyDistances(list);
        return list;
      })().catch((e) => { loading = null; throw e; });
    }
    return loading;
  }
  async function loadJson() {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error("bad response");
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error("empty");
    return data.map(normalize);
  }
  /* 카드에 쓰는 '지역 · 도보 N분' 문구 (좌표를 아직 모르면 지역만 표시) */
  function distLabel(t) {
    return t.distanceM == null ? `${t.area || ""}` : `${t.area || ""} · 도보 ${Math.max(1, Math.round(t.distanceM / 70))}분`;
  }

  /* 출처 표시: J = 공공데이터 JSON, A = 카카오 API 검색 */
  function srcTag(t) {
    return t.source === "api"
      ? `<span class="src-tag src-a" title="서울시 API (지하철 역사 화장실)">A</span>`
      : `<span class="src-tag src-j" title="공공데이터 JSON">J</span>`;
  }
  /* 남/여 아이콘 (남=파랑, 여=분홍) */
  const MALE_ICON = `<svg class="gi gi-m" viewBox="0 0 24 24" role="img" aria-label="남자"><circle cx="12" cy="5" r="3"/><path d="M8 10h8a1 1 0 0 1 1 1v6h-2v5h-3v-5h-2v5H9v-5H7v-6a1 1 0 0 1 1-1z"/></svg>`;
  const FEMALE_ICON = `<svg class="gi gi-f" viewBox="0 0 24 24" role="img" aria-label="여자"><circle cx="12" cy="5" r="3"/><path d="M12 9c1.5 0 2.4.8 2.8 2L18 19h-3v3h-2v-3h-2v3H9v-3H6l3.2-8c.4-1.2 1.3-2 2.8-2z"/></svg>`;
  /* "남자화장실+여자화장실" 같은 위치 문구 → 아이콘 + 점 구분 */
  function placeHtml(str) {
    if (!str) return "";
    return String(str).split("+").map((p) => {
      p = p.trim();
      if (p === "남자화장실") return MALE_ICON;
      if (p === "여자화장실") return FEMALE_ICON;
      if (p === "장애인화장실") return `<span class="gi-text">장애인</span>`;
      return `<span class="gi-text">${p}</span>`;
    }).join('<span class="gi-dot">·</span>');
  }

  /* 카드에 쓰는 '지역 · 도보 N분' 문구 (좌표를 아직 모르면 지역만 표시) */
  function distLabel(t) {
    return t.distanceM == null ? `${t.area || ""}` : `${t.area || ""} · 도보 ${Math.max(1, Math.round(t.distanceM / 70))}분`;
  }

  /* ---------- LocalStorage ---------- */
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; }
    catch { return []; }
  }
  function isFavorite(id) { return getFavorites().includes(id); }
  function toggleFavorite(id) {
    const favs = getFavorites();
    const idx = favs.indexOf(id);
    if (idx >= 0) favs.splice(idx, 1); else favs.push(id);
    localStorage.setItem(FAV_KEY, JSON.stringify(favs));
    return favs.includes(id);
  }

  function getRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
    catch { return []; }
  }
  function addRecent(id) {
    let list = getRecent().filter((r) => r.id !== id);
    list.unshift({ id, viewedAt: Date.now() });
    list = list.slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  }
  function relativeTime(ts) {
    const diffMin = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (diffMin < 60) return `${diffMin}분 전 확인`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `${diffH}시간 전 확인`;
    const diffD = Math.round(diffH / 24);
    return `${diffD}일 전 확인`;
  }

  /* ---------- 표시 가공 ---------- */
  const BADGE_DEFS = [
    { key: "hasStepFree", label: "턱없음" },
    { key: "hasBell", label: "비상벨" },
    { key: "hasCctv", label: "CCTV" },
    { key: "hasDiaperTable", label: "기저귀교환대" },
  ];
  function badgesOf(t) {
    return BADGE_DEFS.filter((b) => t[b.key]).map((b) => b.label);
  }
  function isOpenNow(t) {
    return t.openTime === "00:00" && t.closeTime === "24:00";
  }

  /* ---------- 계정 (데모용: 브라우저 LocalStorage 기반) ----------
     실제 서비스에서는 서버 인증(API)으로 교체해야 합니다. */
  const USERS_KEY = "pt_users";
  const SESSION_KEY = "pt_session";
  const Auth = (() => {
    const readUsers = () => { try { return JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch { return []; } };
    const writeUsers = (u) => localStorage.setItem(USERS_KEY, JSON.stringify(u));
    const norm = (e) => String(e || "").trim().toLowerCase();
    const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    const salt = () => hex(crypto.getRandomValues(new Uint8Array(8)));
    async function hashPw(pw, s) {
      const data = new TextEncoder().encode(s + ":" + pw);
      if (window.crypto && crypto.subtle) return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
      let h = 5381; for (const b of data) h = ((h << 5) + h + b) >>> 0; // 보안 컨텍스트가 아닐 때의 임시 대체
      return "x" + h.toString(16);
    }
    function currentUser() {
      const email = localStorage.getItem(SESSION_KEY);
      const u = email && readUsers().find((x) => x.email === email);
      return u ? { nickname: u.nickname, email: u.email } : null;
    }
    async function signup({ nickname, email, password, confirm }) {
      nickname = String(nickname || "").trim(); email = norm(email);
      if (nickname.length < 2 || nickname.length > 12) return { ok: false, error: "닉네임은 2~12자로 입력해 주세요" };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "올바른 이메일 형식이 아닙니다" };
      if (String(password || "").length < 8) return { ok: false, error: "비밀번호는 8자 이상이어야 합니다" };
      if (password !== confirm) return { ok: false, error: "비밀번호 확인이 일치하지 않습니다" };
      const users = readUsers();
      if (users.some((u) => u.email === email)) return { ok: false, error: "이미 가입된 이메일입니다" };
      const s = salt();
      users.push({ nickname, email, salt: s, hash: await hashPw(password, s) });
      writeUsers(users);
      localStorage.setItem(SESSION_KEY, email);
      return { ok: true };
    }
    async function login({ email, password }) {
      email = norm(email);
      const u = readUsers().find((x) => x.email === email);
      if (!u || (await hashPw(String(password || ""), u.salt)) !== u.hash)
        return { ok: false, error: "이메일 또는 비밀번호가 올바르지 않습니다" };
      localStorage.setItem(SESSION_KEY, email);
      return { ok: true };
    }
    function logout() { localStorage.removeItem(SESSION_KEY); }
    return { currentUser, signup, login, logout };
  })();

  /* ---------- 헤더/탭바 ---------- */
  function renderTabbar(mountEl, active) {
    if (!mountEl) return;
    const svg = (inner) =>
      `<span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${inner}</svg></span>`;
    const ICON_MAP = svg('<path d="M9 4 3 6.5V20l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/>');
    const ICON_DASH = svg('<rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="3" width="4" height="18" rx="1"/><rect x="17" y="8" width="4" height="13" rx="1"/>');
    const ICON_MY = svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>');
    mountEl.innerHTML = `
      <a class="tab${active === "home" ? " active" : ""}" href="${HOME_URL}">
        ${ICON_MAP}지도
      </a>
      <a class="tab${active === "dashboard" ? " active" : ""}" href="${pageUrl("dashboard.html")}">
        ${ICON_DASH}대시보드
      </a>
      <a class="tab${active === "my" ? " active" : ""}" href="${pageUrl("mypage.html")}">
        ${ICON_MY}마이
      </a>
    `;
  }

  /* 마우스로도 좌우 드래그 스크롤 (터치는 네이티브 스크롤 사용) */
  function enableDragScroll(el) {
    if (!el) return;
    let down = false, moved = false, startX = 0, startLeft = 0;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
      down = true; moved = false; startX = e.clientX; startLeft = el.scrollLeft;
    });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      if (moved) el.scrollLeft = startLeft - dx;
    });
    const end = () => { down = false; };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointerleave", end);
    el.addEventListener("click", (e) => {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    }, true);
  }

  /* ---------- 집계(대시보드용) ---------- */
  function countBy(list, key) {
    return list.reduce((n, t) => n + (t[key] ? 1 : 0), 0);
  }
  function groupByArea(list) {
    const map = {};
    list.forEach((t) => {
      if (!t.hasStepFree) return;
      map[t.area] = (map[t.area] || 0) + 1;
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]);
  }

  return {
    IN_PAGES, pageUrl, HOME_URL,
    loadToilets, distLabel, GEO, dataStatus, srcTag, placeHtml, MALE_ICON, FEMALE_ICON,
    getFavorites, isFavorite, toggleFavorite,
    getRecent, addRecent, relativeTime,
    badgesOf, isOpenNow,
    renderTabbar, enableDragScroll,
    Auth,
    countBy, groupByArea,
  };
})();
