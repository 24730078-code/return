/* ============================================
   카카오 API 설정 — 여기에 키만 넣으면 됩니다.
   1) https://developers.kakao.com → 내 애플리케이션 → 앱 키 → 'JavaScript 키' 복사
   2) 플랫폼 → Web → 사이트 도메인에 접속 주소 등록
      (예: http://localhost:5500, https://<아이디>.github.io)
   ============================================ */
window.KAKAO_JS_KEY = "c33242fb931b8915871c38e8fa175b00"; // ← 카카오 JavaScript 키

/* 서울 열린데이터광장 인증키 — '역사공중화장실정보'(tbTrfcSttnToilet) 호출용
   ※ 서울시 API는 http만 지원합니다. http://localhost 에서는 실시간 호출,
     https(GitHub Pages)에서는 브라우저가 막기 때문에 data/toilets_subway.json 으로 자동 대체됩니다. */
window.SEOUL_API_KEY = "7472676c4a616e6531303076704c4d4a";
