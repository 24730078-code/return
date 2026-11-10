# Restie — 공공화장실 큐레이터 및 안심 지도 (정적 프로토타입)

## 데이터 (J / A 구분)
화면의 이름 옆 작은 글자로 출처를 구분합니다.
- **J** : `data/toilets_seoul_jung.json` — 서울 중구·종로구 공공화장실 200건 (항상 사용)
- **A** : 서울 열린데이터광장 API `tbTrfcSttnToilet` (서울교통공사 역사공중화장실정보) 서울 전체 302건
  - 실시간 호출을 먼저 시도하고, 실패하면 `data/toilets_subway.json`(같은 항목명의 CSV 변환본)으로 자동 대체합니다.
  - 서울시 API는 **http만 지원**해서, `http://localhost`에서는 실시간 호출이 되고 https(GitHub Pages)에서는 브라우저가 막아 대체 JSON을 씁니다.
  - A에 있는 역은 J의 같은 역 화장실(`○○역(…)` 이름 25건)을 숨기고 A의 자세한 정보로 대체합니다. (`js/app.js`의 `HIDE_SUBWAY_DUP`을 false로 하면 J도 모두 표시)
  - 화면에 나오는 전체는 J 175 + A 302 = 477건입니다.
  - A에는 좌표가 있어 바로 핀이 찍히고, J는 카카오 주소→좌표 변환 후 LocalStorage(`pt_geo_v1`)에 캐시합니다.
- 카카오는 지도 표시와 J의 주소→좌표 변환에만 쓰며, 화장실 데이터는 가져오지 않습니다.

## 카카오 키 넣는 법
1. [Kakao Developers](https://developers.kakao.com) → 내 애플리케이션 → 앱 키 → **JavaScript 키** 복사
2. 같은 앱의 [플랫폼 → Web] 에 접속 주소 등록 (`http://localhost:5500`, `https://<아이디>.github.io`)
3. `js/config.js` 의 `window.KAKAO_JS_KEY = ""` 따옴표 안에 키 붙여 넣기

키가 비어 있으면 지도는 안 뜨지만 목록·상세·마이·대시보드는 정상 동작합니다.

## 로컬 실행
`fetch()` 때문에 파일 더블클릭(file://)으로는 JSON을 못 불러옵니다.
```bash
python3 -m http.server 5500   # project 폴더에서
# http://localhost:5500
```

## 폴더 구조
```
index.html            # 지도(홈) + 목록 바텀시트
css/style.css
js/config.js          # 카카오 JS 키 / 서울시 API 키
js/app.js             # 데이터 로드/가공, LocalStorage, 거리 계산, 탭바
js/kakao-map.js       # 카카오맵: 지도·핀·주소→좌표
data/toilets_seoul_jung.json   # J
data/toilets_subway.json       # A 대체본 (역사 화장실 302건)
pages/                # list / detail / mypage / dashboard(개선 보드) / propose(개선 제안)
```

## 개선 제안 · 개선 보드
- `pages/propose.html` : 화장실을 고른 뒤 **불편 개선**(이용 상황 → 막히는 지점 확인 → 개선안 → 내용 작성) 또는 **정보 수정**(항목 → 실제 정보 → 확인 날짜)을 제안합니다. `?id=화장실ID&mode=info&item=broken` 으로 미리 선택해서 열 수 있습니다.
- 제출한 제안은 LocalStorage `pt_proposals`에 저장되고 마이 → **내 제안** 탭에서 상태(검토 대기 / 반영 완료 / 반려)를 확인합니다. (데모용, 실제 서비스는 서버 저장 필요)
- `pages/dashboard.html`(개선 보드) : 기존 현황·유형별 분석에 더해 지역별 핵심 항목 등록률, 먼저 개선할 분야, 개선이 필요한 화장실, 최근 제안을 보여 줍니다.
