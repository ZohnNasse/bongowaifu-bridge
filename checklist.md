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
- [ ] 태그 추출 강화 — 추출 프롬프트가 tags+weight를 내도록(현재 태그 비어있음, 관련성은 본문 매칭으로 동작)
- [ ] (배선) UI 기억 보기에서 항목 표시(type/subject/tags/weight)
- [ ] 자기점검 한 줄(크랙 차용)
- [ ] 회귀 확인 — npm start 부팅 + 기존 기능(스케줄·호감도·TTS·발화)
- [ ] 커밋 — 논리 단위 분할 (English message)

## 결정 필요 (사용자 확인)

- [ ] 읽기용 memory.md 유지 여부 → 잠정: 유지(사용자 편집 기능 보존)
- [ ] Phase 1 범위로 충분한지 확인 후 착수
