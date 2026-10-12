# 공공화장실 큐레이터 및 안심 지도 (프런트엔드 정적 프로토타입)

JSON + JavaScript(정렬/필터) + LocalStorage 기반의 정적 웹 프로토타입입니다.

## 폴더 구조
```
project/
├─ index.html        # 홈(메인 지도)
├─ css/style.css      # 공통 스타일 (헤더/탭바 sticky 고정 포함)
├─ js/app.js          # 공통 로직: 데이터 로드, 즐겨찾기/최근 본 공간(LocalStorage)
├─ data/toilets.json  # 화장실 샘플 데이터 (실제 공공데이터로 교체 예정)
├─ asset/             # 이미지 등 정적 자원 (현재 비어 있음)
└─ pages/
   ├─ list.html       # 화장실 목록 (필터·정렬·결과없음/오류 상태 포함)
   ├─ detail.html     # 화장실 상세 (즐겨찾기 저장)
   ├─ mypage.html     # 마이 (즐겨찾기 / 최근 본 공간 탭)
   └─ dashboard.html  # 대시보드 (전국 현황 요약, 지역별 무장애 화장실 바차트)
```

탭바는 홈 / 대시보드 / 마이 3개로 구성되며, 모든 페이지에서 `js/app.js`의
`App.renderTabbar()`가 공통으로 그립니다.

## 로컬에서 확인하기
`index.html`을 더블클릭해서 바로 열어도 됩니다. `fetch()`로 `data/toilets.json`을
불러오지 못하는 경우(파일 직접 열기 시 브라우저 CORS 정책 때문에 발생 가능)
`js/app.js`에 내장된 샘플 데이터로 자동 대체되어 화면이 비어 보이지 않습니다.
다만 실제 데이터 파일을 수정하며 확인하려면 아래처럼 로컬 서버로 열어야
`data/toilets.json`의 변경사항이 반영됩니다.

```bash
# project 폴더 안에서 실행
python3 -m http.server 5500
# 브라우저에서 http://localhost:5500 접속
```

또는 VS Code의 Live Server 확장을 사용해도 됩니다.

## GitHub Pages로 배포하기
1. 이 `project` 폴더의 내용을 레포지토리 루트(또는 `docs/` 등 설정한 경로)에 푸시합니다.
2. 저장소 Settings → Pages에서 배포 브랜치/폴더를 지정합니다.
3. 배포된 주소의 `index.html`이 홈 화면으로 열립니다.

## 다음 단계로 남겨둔 것
- `index.html`의 지도 영역은 자리만 잡아둔 더미이며, 실제로는 Kakao Maps JavaScript SDK
  `<script>` 태그와 API 키를 연동해야 합니다 (`js/app.js`의 핀 렌더링 로직을 좌표 기반으로 교체).
- `data/toilets.json`은 샘플 7건이며, 공공데이터포털·수기 조사 데이터로 교체해야 합니다.
- 상세 페이지의 "제보" 버튼은 자리만 있고, 실제 저장(Supabase/Firebase 등 DB 연동)은 Should 범위로 남겨뒀습니다.
