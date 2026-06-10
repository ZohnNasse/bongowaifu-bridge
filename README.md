# BongoWaifu Bridge

BongoWaifu 데스크톱 컴패니언과 로컬 llama-server를 연결하는 Electron 앱.
게임 상태(MCP)를 읽어 로컬 LLM이 페르소나 대사를 생성하고 말풍선으로 자동 발화한다.

## 기능

- 자동 발화: 시작 인사, 콤보 게이지 반응, 업적 축하, idle 잡담, 버튼 질문(ask_and_wait)
- 채팅 UI: 직접 대화(응답이 말풍선으로도 출력), 텍스트 그대로 발화(Ctrl+Enter), 수동 질문 트리거
- 페르소나 설정: 이름/나이/호칭/성격/말투 + 게임 내 스킨·옷 자동 반영, 시간대 인식
- 메모리: 최근 대화 N줄 + 오래된 기록은 로컬 모델이 장기 요약으로 압축, 디스크 영속화

## 요구사항

- [BongoWaifu](https://store.steampowered.com/app/3861430/) — 설정에서 AI Connection (Beta) 토글 ON
- llama-server (OpenAI 호환 `/v1/chat/completions`) — 기본 `http://127.0.0.1:8001`
- Node.js 18+

## 실행

```bash
npm install
npm start
```

설정 탭에서 BongoWaifu 포트(게임 화면에 표시된 값, 7337~7356)와 llama-server URL을 맞춘 뒤 시작.

## 설정 파일

`settings.json` / `memory.json`은 Electron userData 폴더에 저장됨
(Windows: `%APPDATA%/bongowaifu-bridge/`).
