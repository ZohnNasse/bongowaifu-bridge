# Checklist — 메모리 엔진 재설계 (Phase 1)

설계 근거는 `MEMORY_ENGINE_PLAN.md`, 진행 기록은 `workflow.md`.

## Phase 1

- [x] 데이터 모델 정의 — memory.js (id/type/subject/text/tags/weight/date/lastUsed)
- [x] 로드/저장 — memory.js load/save (memory.json)
- [x] 마이그레이션 — migrateFromMd: memory.md 섹션 → 항목 (없을 때 1회)
- [x] 선택 주입 — selectForPrompt: score(weight+recency+태그/키워드 relevance), subject 접두사 렌더, 예산 캡
- [x] 엔진 검증 — node --check + 기능 테스트(마이그레이션 5항목, 주체접두사, 태그검색) 통과
- [x] (배선) require + 부팅 시 load/migrate (MEMITEMS_PATH = memory-items.json)
- [x] (배선) 추출 → memory.addItems (extractUserFacts/maybeSummarize/episode/relationships), memMd 기록은 유지
- [x] (배선) memForPrompt → memory.selectForPrompt (query = 최근 사용자 발화 2개), subjectLabel(user→호칭, self→이름)
- [x] (배선) memory:clear → mem.clear, orphan recentEntries 제거
- [x] (배선) 시스템 프롬프트 "나/너 구분" = 메신저 프레임(같은 공간 아님) + 즉석 상황극 금지 규칙
- [x] 태그 추출 강화 — factSys가 고정 카테고리(A안) tags+weight를 내는 items 형식으로, extractUserFacts가 items 소비
- [x] (배선) UI 기억 보기에서 항목 표시(type/subject/weight/tags)
- [x] 자기점검 한 줄(크랙 차용) — 규칙 6
- [x] 메모리 초기화 재확인 — confirm() 다이얼로그
- [ ] 회귀 확인 — npm start 부팅 + 기존 기능(스케줄·호감도·TTS·발화)
- [ ] 커밋 — 논리 단위 분할 (English message)

## 다음 단계 — 인물 탭 (characters.json)

- 고정 프로필(메인/사용자/등장인물) CRUD, 이름=태그, 프로필 우선(모델이 못 바꿈)
- 관계 = 방향성 그래프(캐릭터↔나, 지인↔나, 지인↔지인) — 인공학원2식, 디자인 노트 4축과 연결
- 메모리 초기화 시 인물도 초기화 옵션 + 재확인
- 모순 갱신(이름·나이 등 단일값은 새 값이 옛 값 덮어쓰기), 사용자 정정 우선

## 결정 필요 (사용자 확인)

- [ ] 읽기용 memory.md 유지 여부 → 잠정: 유지(사용자 편집 기능 보존)
- [ ] Phase 1 범위로 충분한지 확인 후 착수
