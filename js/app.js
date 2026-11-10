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
     J: data/toilets_seoul_jung.json(서울 중구·종로구 200건)을 불러와 화면에서 쓰는 형태로 가공합니다.
     A: 서울시 API(지하철 역사 화장실)는 아래 normalizeApi()에서 같은 형태로 맞춥니다.
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
      status: "open",                            // 공공데이터 등재 = 개방. (서울시 API 항목은 'api')
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

  /* 출처 표시: J = 공공데이터 JSON, A = 서울시 API (지하철 역사 화장실) */
  function srcTag(t) {
    return t.source === "api"
      ? `<span class="src-tag src-a" title="서울시 API (지하철 역사 화장실)">A</span>`
      : `<span class="src-tag src-j" title="공공데이터 JSON" style="background:#E3F6EA;color:#188A45">J</span>`;
  }
  /* 남/여 아이콘 (남=파랑, 여=분홍) */
  const MALE_ICON = `<svg class="gi gi-m" viewBox="0 0 24 24" role="img" aria-label="남자"><circle cx="12" cy="2.3" r="2.25"/><rect x="7.25" y="5" width="9.5" height="3.6" rx="1.8"/><rect x="7.25" y="6" width="1.85" height="8.6" rx="0.92"/><rect x="14.9" y="6" width="1.85" height="8.6" rx="0.92"/><rect x="9.55" y="6" width="4.9" height="9" rx="0.6"/><rect x="9.55" y="12" width="2.25" height="12" rx="1.12"/><rect x="12.2" y="12" width="2.25" height="12" rx="1.12"/></svg>`;
  const FEMALE_ICON = `<svg class="gi gi-f" viewBox="0 0 24 24" role="img" aria-label="여자"><circle cx="12" cy="2.3" r="2.25"/><path d="M9.6 5h4.8c1 0 1.5.5 1.6 1.4l-.9 3 1.6 7.3H7.3l1.6-7.3-.9-3C8.1 5.5 8.6 5 9.6 5z"/><path d="M8.2 6.2 6.5 13.2M15.8 6.2l1.7 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"/><rect x="9.85" y="15.5" width="1.9" height="8.5" rx="0.95"/><rect x="12.25" y="15.5" width="1.9" height="8.5" rx="0.95"/></svg>`;
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

  /* ---------- 화장실 이미지 (data/toilet_images_sample.json) ----------
     장소 유형(지하철역·지하상가·공원·공공기관·기타)별 이미지 + 시설(장애인용 칸·기저귀 교환대) 이미지.
     loadImageRules()로 한 번 불러온 뒤 imagesOf(t)로 [{ src, alt }]를 받습니다. 실패하면 빈 배열. */
  const IMAGE_URL = IN_PAGES ? "../data/toilet_images_sample.json" : "./data/toilet_images_sample.json";
  let imageRules = null, imageLoading = null;
  function loadImageRules() {
    if (!imageLoading) {
      imageLoading = fetch(IMAGE_URL)
        .then((res) => { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
        .then((d) => (imageRules = d))
        .catch((err) => { console.warn("[App] 화장실 이미지 데이터를 불러오지 못했습니다:", err.message || err); imageRules = null; });
    }
    return imageLoading;
  }
  function placeTypeOf(t) {
    if (!imageRules) return null;
    return imageRules.placeTypes.find((p) => {
      const m = p.match || {};
      if (!m.source && !m.nameRegex) return true;                    // '기타' (마지막)
      return (m.source && t.source === m.source) || (m.nameRegex && new RegExp(m.nameRegex).test(t.name || ""));
    }) || null;
  }
  function imagesOf(t) {
    const type = placeTypeOf(t);
    if (!type) return [];
    const keys = [...type.images];
    (imageRules.facilityImages || []).forEach((f) => { if (t[f.key] && !keys.includes(f.image)) keys.push(f.image); });
    return keys.slice(0, imageRules.maxImages || 4)
      .map((k) => imageRules.images[k])
      .filter(Boolean)
      .map((img) => ({ src: (IN_PAGES ? "../" : "./") + img.src, alt: img.alt }));
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

  /* ---------- 개선 제안 (데모용: 브라우저 LocalStorage 기반) ----------
     kind: "comfort"(불편 개선) | "info"(정보 수정)
     status: "pending"(검토 대기) | "done"(반영 완료) | "rejected"(반려)
     실제 서비스에서는 서버에 저장하고 담당자가 검토 상태를 바꿔야 합니다. */
  const PROPOSAL_KEY = "pt_proposals";

  /* ---------- 시연용 샘플 제안 ----------
     data/proposals_sample.json을 처음 접속할 때 한 번만 읽어 저장소에 넣습니다 (sample: true로 표시).
     JSON의 daysAgo·reviewedDaysAgo·checkedDate는 '접속한 날 기준 며칠 전'이라 언제 열어도 최근 제안처럼 보입니다.
     지운 뒤에도 다시 생기지 않도록 SEED_KEY로 기록합니다.
     샘플을 처음 상태로 다시 넣고 싶으면 브라우저 콘솔에서 App.Proposals.resetSamples() 실행. */
  const SEED_KEY = "pt_proposals_seeded_v3";   // 샘플 JSON을 바꾸면 v4, v5…로 올리면 다음 접속 때 자동으로 새 샘플로 교체
  const SAMPLE_URL = IN_PAGES ? "../data/proposals_sample.json" : "./data/proposals_sample.json";
  const DAY = 86400000;
  const fmtDay = (ts) => new Date(ts).toISOString().slice(0, 10);
  function buildSample(s, now) {
    const createdAt = now - s.daysAgo * DAY;
    const base = {
      id: s.id, sample: true, createdAt, status: s.status, author: "샘플",
      kind: s.kind, toiletId: s.toiletId, toiletName: s.toiletName, area: s.area,
      hasPhoto: false, photoCount: 0,
    };
    if (s.facility) base.facility = s.facility;     // 어떤 시설에 대한 제안인지 (추천순 1순위 계산용)
    if (s.reviewedDaysAgo != null) base.reviewedAt = fmtDay(now - s.reviewedDaysAgo * DAY);
    if (s.review) base.memo = s.review;
    if (s.kind === "comfort") {
      return {
        ...base,
        title: `${s.toiletName} · ${s.ideas[0]}${s.ideas.length > 1 ? ` 외 ${s.ideas.length - 1}건` : ""}`,
        persona: s.persona, ideas: s.ideas,
        body: `[대상] ${s.toiletName} (${s.area})\n[이용 상황] ${s.persona}\n[개선 요청]\n${s.ideas.map((x) => "- " + x).join("\n")}\n[덧붙이는 말] ${s.text}`,
      };
    }
    const checkedDate = fmtDay(now + s.checkedDate * DAY);
    const isIssue = s.item === "청소·고장";
    return {
      ...base,
      title: `${s.toiletName} · ${s.item} ${isIssue ? "제보" : "정보 수정"}`,
      item: s.item, current: s.current, actual: s.actual, checkedDate,
      body: [!isIssue && `현재: ${s.current || "정보 없음"}`, `실제: ${s.actual}`, `확인일: ${checkedDate}`, s.memo && `설명: ${s.memo}`].filter(Boolean).join("\n"),
    };
  }

  const Proposals = (() => {
    const STATUS = { pending: "검토 대기", done: "반영 완료", rejected: "반려" };
    const KIND = { comfort: "불편 개선", info: "정보 수정" };
    const readRaw = () => { try { return JSON.parse(localStorage.getItem(PROPOSAL_KEY)) || []; } catch { return []; } };
    const write = (all) => { try { localStorage.setItem(PROPOSAL_KEY, JSON.stringify(all)); return true; } catch { return false; } };
    /* 샘플 넣기 (fetch가 필요해서 비동기). 실패해도 앱은 그대로 동작 */
    let seeding = null;
    function seedSamples(force) {
      if (!force && seeding) return seeding;
      seeding = (async () => {
        try {
          if (!force && localStorage.getItem(SEED_KEY)) return;
          const res = await fetch(SAMPLE_URL);
          if (!res.ok) throw new Error("HTTP " + res.status);
          const raw = await res.json();
          const now = Date.now();
          const mine = readRaw().filter((p) => !p.sample);            // 사용자가 쓴 제안은 그대로 둠
          const all = mine.concat(raw.map((s) => buildSample(s, now))).sort((a, b) => b.createdAt - a.createdAt);
          if (write(all)) localStorage.setItem(SEED_KEY, "1");
        } catch (err) {
          console.warn("[App] 샘플 개선 제안(data/proposals_sample.json)을 불러오지 못했습니다:", err.message || err);
        }
      })();
      return seeding;
    }
    /* 샘플이 저장소에 들어갈 때까지 기다릴 때 사용 (예: 추천순 계산 전) */
    const ready = () => seedSamples(false);
    const list = () => readRaw();
    function add(p) {
      const user = Auth.currentUser();
      const item = {
        id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        createdAt: Date.now(), status: "pending", author: user ? user.nickname : null, ...p,
      };
      const all = list();
      all.unshift(item);
      return write(all) ? item : null;
    }
    function remove(id) { write(list().filter((p) => p.id !== id)); }
    /* 검토 상태·메모 변경 (관리자 모드 데모용) */
    function update(id, patch) {
      const all = list();
      const item = all.find((p) => p.id === id);
      if (!item) return null;
      Object.assign(item, patch);
      Object.keys(item).forEach((k) => item[k] === undefined && delete item[k]);
      return write(all) ? item : null;
    }
    function clear() { write([]); }
    /* 샘플 제안만 처음 상태로 다시 넣기 (사용자가 쓴 제안은 유지) */
    function resetSamples() { return seedSamples(true); }
    seedSamples(false);   // 어느 화면이든 처음 열리면 바로 샘플을 넣기 시작
    return { list, ready, add, remove, update, clear, resetSamples, STATUS, KIND };
  })();

  /* HTML 이스케이프 (사용자 입력·데이터를 innerHTML에 넣을 때) */
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 헤더/탭바 ---------- */
  function renderTabbar(mountEl, active) {
    if (!mountEl) return;
    const svg = (inner) =>
      `<span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${inner}</svg></span>`;
    const ICON_MAP = svg('<path d="M12 22s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/>');
    const ICON_DASH = svg('<rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="3" width="4" height="18" rx="1"/><rect x="17" y="8" width="4" height="13" rx="1"/>');
    const ICON_MY = svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>');
    const ICON_PROPOSE = svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>');
    mountEl.innerHTML = `
      <a class="tab${active === "home" ? " active" : ""}" href="${HOME_URL}">
        ${ICON_MAP}Restie
      </a>
      <a class="tab${active === "propose" ? " active" : ""}" href="${pageUrl("propose.html")}">
        ${ICON_PROPOSE}개선 제안
      </a>
      <a class="tab${active === "dashboard" ? " active" : ""}" href="${pageUrl("dashboard.html")}">
        ${ICON_DASH}개선 보드
      </a>
      <a class="tab${active === "my" ? " active" : ""}" href="${pageUrl("mypage.html")}">
        ${ICON_MY}마이페이지
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
    loadImageRules, imagesOf,
    getFavorites, isFavorite, toggleFavorite,
    getRecent, addRecent, relativeTime,
    badgesOf, isOpenNow,
    renderTabbar, enableDragScroll,
    Auth, Proposals, esc,
    countBy, groupByArea,
  };
})();
