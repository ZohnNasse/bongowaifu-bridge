# BongoWaifu Bridge

An Electron app that connects the [BongoWaifu](https://store.steampowered.com/app/3861430/) desktop companion to a local llama-server.
It reads game state via MCP, generates persona-driven lines with your local LLM, and makes the companion speak automatically.

*[한국어는 아래에 ↓](#한국어)*

## Features

- **Auto speech**: startup greeting, combo gauge reactions, achievement celebrations, idle chatter, and button questions (`ask_and_wait`)
- **Chat UI**: talk to your companion directly (replies also show as speech bubbles), speak any text as-is (Ctrl+Enter), manual question trigger
- **Persona settings**: name / age / how she calls you / personality / speech style — plus automatic reflection of the in-game skin & outfit, and time-of-day awareness
- **Language option**: Korean / English for both the UI and the companion's speech
- **Memory**: recent N lines of conversation + older history compressed into a long-term summary by the local model, persisted to disk

## Requirements

- BongoWaifu with **AI Connection (Beta)** toggled ON in settings
- A llama-server (or any OpenAI-compatible `/v1/chat/completions` endpoint) — default `http://127.0.0.1:8001`
- Node.js 18+

## Run

```bash
npm install
npm start
```

In the Settings tab, set the BongoWaifu port (the number shown in-game, 7337–7356) and your llama-server URL, then press Start.

## Config files

`settings.json` / `memory.json` are stored in the Electron userData folder
(Windows: `%APPDATA%/bongowaifu-bridge/`).

---

## 한국어

BongoWaifu 데스크톱 컴패니언과 로컬 llama-server를 연결하는 Electron 앱.
게임 상태(MCP)를 읽어 로컬 LLM이 페르소나 대사를 생성하고 말풍선으로 자동 발화한다.

### 기능

- 자동 발화: 시작 인사, 콤보 게이지 반응, 업적 축하, idle 잡담, 버튼 질문(ask_and_wait)
- 채팅 UI: 직접 대화(응답이 말풍선으로도 출력), 텍스트 그대로 발화(Ctrl+Enter), 수동 질문 트리거
- 페르소나 설정: 이름/나이/호칭/성격/말투 + 게임 내 스킨·옷 자동 반영, 시간대 인식
- 언어 옵션: UI와 캐릭터 발화 모두 한국어/영어 선택
- 메모리: 최근 대화 N줄 + 오래된 기록은 로컬 모델이 장기 요약으로 압축, 디스크 영속화

### 요구사항

- BongoWaifu — 설정에서 AI Connection (Beta) 토글 ON
- llama-server (OpenAI 호환 `/v1/chat/completions`) — 기본 `http://127.0.0.1:8001`
- Node.js 18+

### 실행

```bash
npm install
npm start
```

설정 탭에서 BongoWaifu 포트(게임 화면에 표시된 값, 7337~7356)와 llama-server URL을 맞춘 뒤 시작.

### 설정 파일

`settings.json` / `memory.json`은 Electron userData 폴더에 저장됨
(Windows: `%APPDATA%/bongowaifu-bridge/`).
