# HANDOFF

작업 환경을 윈도 랩탑 → 맥북으로 옮기기 위한 인수인계 문서. 이어받는 사람/에이전트는 이 문서부터 읽고, 세부는 아래 참조 문서로.

## 0. 가장 먼저

- **윈도에서 떠나기 전 반드시 `git add -A && git commit && git push`** 해둘 것. 이 세션의 변경 다수가 아직 커밋 안 됐을 수 있음. 맥에서 `git clone`(또는 `git pull`)로 받아 이어감.
- 참조 문서 (이 레포 안): `CLAUDE.md`(작업 규칙), `workflow.md`(상세 작업 로그, 시간순), `MEMORY_ENGINE_PLAN.md`(메모리 엔진 설계), `checklist.md`(진행 체크리스트), `DESIGN_NOTE_relationship_sim.md`(관계 시뮬 설계).
- **CLAUDE.md를 꼭 따를 것** — 특히 한국어 문장 끝 콜론 금지, 변경 전 가정 명시·푸시백, 수술적 변경, 완료 전 검증, 커밋 메시지는 영어.

## 1. 두 개의 프로젝트 (구분 중요)

### A. BongoWaifu-bridge (지금 이 레포 = 기존/진행 중)
남이 만든 **스팀 게임 BongoWaifu**의 MCP 엔드포인트(say / ask_and_wait / get_game_state)에 **로컬 LLM**을 붙인 Electron 브릿지. 게임 캐릭터가 로컬 모델로 말하고, 기억·스케줄·호감도를 가짐.
- 스택: Electron(main.js / preload.js / index.html) + 로컬 llama-server + memory.js(장기기억 엔진).
- 완료된 것: 채팅(메신저 UI)·자동 발화·MCP 연동·**태그/주체/가중치 메모리 엔진**·스케줄(하루 일과)·호감도/기분·TTS(VOICEVOX/OS, 한↔일 번역)·페르소나(설정탭 + persona.md)·테마 5종·파일 편집 버튼·메신저식 좁은 창(440×820)·메뉴바 제거.
- **검증 공백 (중요)**: 이 세션 내내 샌드박스 bash 마운트가 main.js를 옛 버전에 동결시켜 `node --check`를 못 돌림. 편집은 호스트에서 수동 검토만 함. **맥에서는 이 문제 없음 → 먼저 `npm start`로 부팅·동작 확인하고, 깨지면 그 에러부터 잡을 것.** memory.js는 동결 전 node --check + 기능 테스트 통과함.
- 메모리 엔진 상태: 저장(memory-items.json)·검색(태그+가중치+최근성, 주체 접두사)·추출(고정 카테고리 태그)·UI 표시·초기화 재확인까지 배선 완료. memMd(memory.md)는 사람이 읽는 미러로 병행 유지 중(추후 정리 가능).
- 미룬 것(브릿지 쪽): 인물 탭(characters.json), 방향성 관계 그래프, 모순 갱신/사용자 정정 우선, 임베딩 RAG, 대사/서술 분리.

### B. 새 데스크탑 컴패니언 (앞으로 만들 것 = 별도 신규 프로젝트)
BongoWaifu에 의존하지 않는 **독립** 데스크탑 컴패니언. 6월 안 MVP 목표.
- 확정된 컨셉: **관계 시뮬 라이트 + 데스크탑에 항상 떠있는 플로팅 캐릭터 + Live2D 지향**.
- 핵심 재활용: 브릿지의 엔진(memory.js·LLM 대화·페르소나·호감도/기분·스케줄)은 게임에 안 묶인 독립 로직이라 그대로 가져옴. **MCP(get_game_state/say) 부분만 떼고, 출력을 자체 말풍선으로 교체.**
- MVP 범위(2주): 투명·프레임리스·항상-위 캐릭터 창 + 말풍선 + 채팅 입력 / 엔진 이식 / 단일 캐릭터 호감도·기분·기억 / **그래픽은 감정별 정적 스프라이트로 먼저**.
- 리스크·결정: **Live2D는 모델(에셋) 확보가 2주 마감의 최대 리스크.** 렌더러를 갈아끼울 수 있게 설계해 MVP는 정적 스프라이트로 확정 완성, Live2D는 v2 드롭인. (남의 Live2D 모델 그대로 쓰면 저작권 침해 — 직접 제작/외주/정식 라이선스/무료 배포본만.)
- **열린 질문(미해결)**: Live2D 리깅 모델이 지금 있는가? 있으면 MVP에 검토, 없으면 정적 우선. ← 새 프로젝트 시작 전 이것부터 확정할 것.

## 2. 런타임 환경

- 로컬 모델: `llama-server`, 포트 8001, OpenAI 호환 `/v1/chat/completions`. 앱 설정의 llama URL = `http://127.0.0.1:8001/v1/chat/completions`.
- 현재 모델: `Qwen3.6-35B-A3B-Uncensored-...Q4_K_M.gguf` (MoE, 활성 3.3B). 9B dense도 시험했고 한국어가 더 나았음 — 모델 선택은 미확정.
- 현재 llama-server 커맨드(윈도):
  `llama-server -m "...Q4_K_M.gguf" -ngl 99 --n-cpu-moe 40 --ctx-size 8192 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --jinja --port 8001 --webui-mcp-proxy`
- 알아둘 것: 이 모델은 SWA라 프롬프트 캐시 재사용이 안 돼 매 턴 전체 재처리(느림, 에러 아님). 어휘 다양성은 `--top-k 0 --min-p 0.05` + (지원 시) XTC/DRY 샘플러 + 앱 temp 0.9~1.0로 개선. ctx는 8192면 충분(256k는 RAM 오프로드로 되지만 불필요).
- 한국어 출력: 생성 프롬프트(관계/스케줄/일화/사실/요약)에 언어 고정을 넣어 `settings.language`(ko/en)를 따름. Qwen이 안 그러면 중국어로 샘.

## 3. 맥 전환 메모

- Electron은 크로스플랫폼 → 같은 코드로 맥에서 `npm install && npm start`. 경로는 `path.join`·`app.getPath('userData')` 써서 OS 자동 처리(맥: `~/Library/Application Support/`).
- 맥에서도 llama-server를 맥에 띄우고 앱은 127.0.0.1:8001로 붙이면 됨(또는 윈도 머신 IP로). 가장 단순한 건 맥에서 모델 실행.
- TTS: 맥 OS 음성에 한국어(유나 등) 내장 → 윈도보다 나음. VOICEVOX도 맥 버전 있음.
- 배포 빌드는 각 OS에서(맥 .dmg는 맥에서). MVP 단계에선 빌드 불필요, `npm start`로 충분.

## 4. 이어서 할 일 (우선순위)

1. (브릿지) 맥에서 `npm start`로 부팅·채팅·메모리 적립·발화 전 과정 검증. 깨지는 부분부터 수정. (그동안 못 한 컴파일 검증을 여기서.)
2. (새 프로젝트) Live2D 모델 유무 확정 → MVP 그래픽 노선 결정.
3. (새 프로젝트) 신규 폴더/레포 스캐폴딩: 투명 항상-위 캐릭터 창 + 엔진 이식(memory.js 등 복사, MCP 제거, 출력=말풍선). checklist를 마감 역산으로 작성.
4. (브릿지, 여유 시) 인물 탭·관계 그래프는 MVP 이후.
