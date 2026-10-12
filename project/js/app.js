/* ============================================
   사용자 유형별 맞춤형 공공화장실 큐레이터 및 안심 지도
   공통 로직: 데이터 로드 · LocalStorage · 헤더/탭바 렌더링
   ============================================ */

const App = (() => {
  const IN_PAGES = location.pathname.includes("/pages/");
  const DATA_URL = IN_PAGES ? "../data/toilets.json" : "./data/toilets.json";
  const HOME_URL = IN_PAGES ? "../index.html" : "./index.html";
  const pageUrl = (name) => (IN_PAGES ? `./${name}` : `pages/${name}`);

  const FAV_KEY = "pt_favorites";   // 즐겨찾기 id 배열
  const RECENT_KEY = "pt_recent";   // 최근 본 공간 [{id, viewedAt}]

  /* ---------- 데이터 로드 ----------
     file:// 로 index.html을 직접 열면 브라우저 보안 정책(CORS) 때문에
     fetch()가 막힐 수 있어, 그 경우에는 아래 내장 샘플로 대체합니다.
     (python3 -m http.server 등 로컬 서버로 열면 fetch가 정상 동작합니다) */
  const FALLBACK_TOILETS = [
    { id: "t01", name: "홍대입구역 2번 출구 공중화장실", area: "홍대입구", address: "서울 마포구 양화로 160 지하1층", image: "", hasStepFree: true, hasAutoDoor: true, turnSpace: true, hasDiaperTable: true, hasBell: true, genderSeparated: true, hasSupplies: true, openTime: "05:30", closeTime: "24:00", distanceM: 320, status: "open" },
    { id: "t02", name: "경의선숲길 공원 화장실", area: "홍대입구", address: "서울 마포구 양화로 93", image: "", hasStepFree: true, hasAutoDoor: false, turnSpace: true, hasDiaperTable: false, hasBell: true, genderSeparated: true, hasSupplies: true, openTime: "06:00", closeTime: "22:00", distanceM: 540, status: "unknown" },
    { id: "t03", name: "산울림소극장 옆 개방화장실", area: "홍대입구", address: "서울 마포구 와우산로 128", image: "", hasStepFree: false, hasAutoDoor: false, turnSpace: false, hasDiaperTable: false, hasBell: false, genderSeparated: true, hasSupplies: false, openTime: "09:00", closeTime: "23:00", distanceM: 710, status: "broken" },
    { id: "t04", name: "잠실역 롯데월드몰 공용화장실", area: "잠실", address: "서울 송파구 올림픽로 240", image: "", hasStepFree: true, hasAutoDoor: true, turnSpace: true, hasDiaperTable: true, hasBell: true, genderSeparated: true, hasSupplies: true, openTime: "00:00", closeTime: "24:00", distanceM: 180, status: "open" },
    { id: "t05", name: "석촌호수 동호 공중화장실", area: "잠실", address: "서울 송파구 석촌호수로 148", image: "", hasStepFree: true, hasAutoDoor: false, turnSpace: true, hasDiaperTable: true, hasBell: true, genderSeparated: true, hasSupplies: true, openTime: "05:00", closeTime: "23:00", distanceM: 430, status: "open" },
    { id: "t06", name: "성수동 서울숲 입구 화장실", area: "성수동", address: "서울 성동구 뚝섬로 273", image: "", hasStepFree: true, hasAutoDoor: true, turnSpace: false, hasDiaperTable: true, hasBell: false, genderSeparated: true, hasSupplies: true, openTime: "06:00", closeTime: "22:00", distanceM: 260, status: "unknown" },
    { id: "t07", name: "건대입구역 공중화장실", area: "건대입구", address: "서울 광진구 능동로 110", image: "", hasStepFree: false, hasAutoDoor: true, turnSpace: false, hasDiaperTable: false, hasBell: true, genderSeparated: true, hasSupplies: true, openTime: "05:30", closeTime: "24:00", distanceM: 390, status: "open" },
  ];

  async function loadToilets() {
    try {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error("empty");
      return data;
    } catch (err) {
      console.warn("[App] data/toilets.json을 불러오지 못해 내장 샘플 데이터로 대체합니다.", err);
      return FALLBACK_TOILETS;
    }
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
    { key: "hasAutoDoor", label: "자동문" },
    { key: "hasDiaperTable", label: "기저귀교환대" },
    { key: "hasBell", label: "비상벨" },
  ];
  function badgesOf(t) {
    return BADGE_DEFS.filter((b) => t[b.key]).map((b) => b.label);
  }
  function isOpenNow(t) {
    return t.openTime === "00:00" && t.closeTime === "24:00";
  }

  /* ---------- 헤더/탭바 ---------- */
  function renderTabbar(mountEl, active) {
    if (!mountEl) return;
    mountEl.innerHTML = `
      <a class="tab tab-brand${active === "home" ? " active" : ""}" href="${HOME_URL}">
        Restie
      </a>
      <a class="tab${active === "list" ? " active" : ""}" href="${pageUrl("list.html")}?sort=distance">
        <span class="tab-icon" aria-hidden="true"></span>목록
      </a>
      <a class="tab${active === "dashboard" ? " active" : ""}" href="${pageUrl("dashboard.html")}">
        <span class="tab-icon" aria-hidden="true"></span>대시보드
      </a>
      <a class="tab${active === "my" ? " active" : ""}" href="${pageUrl("mypage.html")}">
        <span class="tab-icon" aria-hidden="true"></span>마이
      </a>
    `;
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
    loadToilets,
    getFavorites, isFavorite, toggleFavorite,
    getRecent, addRecent, relativeTime,
    badgesOf, isOpenNow,
    renderTabbar,
    countBy, groupByArea,
  };
})();
