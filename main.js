// BongoWaifu <-> llama-server 브릿지 (Electron main)
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const mem = require('./memory'); // 태그·주체·가중치 장기기억 엔진

let win = null;
let loopTimer = null;
let running = false;
let busy = false;            // LLM/ask 중복 호출 방지
let mcp = null;
let lastHotLevel = 0;
let hotFull = false;       // 게이지 만땅 이벤트 1회 발화용
let idleBag = [];          // 잡담 주제 셔플백 — 전부 소진해야 같은 주제 재등장
let seenAchv = new Set();
let lastSpoke = 0;
let sessionStart = 0;

// ─────────── 설정/메모리 영속화 ───────────
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const MEMORY_PATH   = () => path.join(app.getPath('userData'), 'memory.json');
const MEMMD_PATH    = () => path.join(app.getPath('userData'), 'memory.md');
const PERSONA_PATH  = () => path.join(app.getPath('userData'), 'persona.md');
const SCHED_PATH    = () => path.join(app.getPath('userData'), 'schedule.json');
const MEMITEMS_PATH = () => path.join(app.getPath('userData'), 'memory-items.json'); // 엔진 항목 저장소

const DEFAULTS = {
  // 언어 ('ko' | 'en') — UI와 캐릭터 발화 언어
  language: 'ko',
  theme: 'midnight', // 색 테마

  // 연결
  bongoPort: 7337,
  llamaUrl: 'http://127.0.0.1:8001/v1/chat/completions',
  llamaModel: 'local',
  temperature: 0.9,
  maxTokens: 120,
  // 페르소나
  personaName: '유키',
  personaAge: '19',
  userCall: '오빠',
  personality: '츤데레지만 속은 다정한 여동생 같은 성격. 장난기 많음.',
  speechStyle: '반말, 이모지 거의 없음, 40자 이내 한 줄',
  // 트리거
  pollSec: 2,
  idleSec: 90,
  trigGreet: true,
  trigHot: true,
  trigAchv: true,
  trigIdle: true,
  trigAsk: true,
  askChance: 0.25,   // idle 잡담이 '질문'이 될 확률
  // 메모리
  memRecent: 40,
  memSummary: true,
  // 스케줄 (하루 일과)
  schedEnable: true,
  // TTS
  ttsEnable: false,
  ttsMode: 'os',     // 'os' | 'voicevox' | 'custom'
  ttsUrl: '',        // custom: POST {text,voice}→audio / voicevox: 엔진 주소(기본 http://127.0.0.1:50021)
  ttsVoice: '',      // OS/custom 음성 이름
  ttsSpeaker: 3,     // voicevox 화자 번호 (예: ずんだもん 노멀=3)
  ttsRate: 1.0,
};

let settings = { ...DEFAULTS };
let memory = { recent: [], affection: 30, lastTs: 0 }; // 단기/상태 전용 (장기기억은 memory.js 엔진)
let mood = 'neutral'; // 단기 기분: neutral|happy|excited|bored

function bumpAff(d) {
  memory.affection = Math.max(0, Math.min(100, (+memory.affection || 30) + d));
  saveMemory();
}
function setMood(m) { mood = m; }

// 잡담 주제: 셔플백 방식 — 10개를 다 쓰기 전엔 같은 주제 반복 없음
function pickIdleTopic() {
  const topics = L().idleTopics;
  if (!idleBag.length) idleBag = topics.map((_, i) => i).sort(() => Math.random() - 0.5);
  return topics[idleBag.pop()];
}

// persona.md — 사용자가 작성한 캐릭터 시트 (매 발화마다 읽어 수정 즉시 반영)
function loadPersonaMd() {
  try { return fs.readFileSync(PERSONA_PATH(), 'utf8').trim(); } catch { return ''; }
}

// 스케줄/관계/일화 생성용 — 기본 설정(이름·나이·성격)을 항상 포함 + persona.md 합침
function personaText() {
  const S = settings;
  const base = `이름: ${S.personaName}, 나이: ${S.personaAge}살, 호칭: 사용자를 '${S.userCall}'(이)라고 부름\n성격: ${S.personality}`;
  const pmd = loadPersonaMd();
  return pmd ? base + '\n' + pmd : base;
}

// ─────────── 하루 스케줄 ───────────
let schedule = { date: '', slots: [] };
let schedBusy = false;
function loadSched() { try { schedule = JSON.parse(fs.readFileSync(SCHED_PATH(), 'utf8')); } catch { schedule = { date: '', slots: [] }; } }
function saveSched() { try { fs.writeFileSync(SCHED_PATH(), JSON.stringify(schedule, null, 2)); } catch {} }
const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD 로컬

// 가족·친구가 없으면 1회 생성 (영속)
async function ensureRelationships() {
  if (mem.byType('relationship').length) return; // 이미 있으면 스킵
  try {
    const j = looseJson(await llama([
      { role: 'system', content: L().relSys },
      { role: 'user', content: L().relUser(personaText()) },
    ], 500, 0.6));
    if (!j) return;
    const people = (j.people || []).filter(x => x && x.name);
    if (!people.length) return;
    mem.addItems(people.map(x => ({
      type: 'relationship', subject: 'relationship',
      text: `${x.name} (${x.relation || ''}): ${x.note || ''}`, tags: [x.name], weight: 4,
    })));
    log('info', `relationships seeded (${people.length})`);
  } catch (e) { log('info', `relationships failed: ${e.message}`); }
}

// 오늘 일과표 없으면 생성 (날짜 바뀌면 새로)
async function ensureSchedule(force) {
  if (schedBusy) return;
  if (!force && !settings.schedEnable) return;
  if (!force && schedule.date === todayStr() && schedule.slots.length) return;
  schedBusy = true;
  log('info', '오늘 일과표 생성 중...');
  try {
    await ensureRelationships(); // 친구/가족 먼저 — 일과에 이름이 등장하도록
    const now = new Date();
    const persona = personaText() + '\n등장인물:\n' + mem.textsByType('relationship');
    // 일과표 JSON이 커서 토큰 넉넉히(1800) + 1회 재시도 — 잘림으로 인한 파싱 실패 방지
    const ask = () => llama([
      { role: 'system', content: L().schedSys },
      { role: 'user', content: L().schedUser(persona, L().dow[now.getDay()], todayStr()) },
    ], 1800, 0.5);
    let j = looseJson(await ask());
    if (!j || !(j.slots || []).length) j = looseJson(await ask());
    if (!j) throw new Error('JSON 파싱 실패 (모델 응답 형식 문제 — max tokens 부족 또는 think 미차단)');
    const slots = (j.slots || []).filter(s => s.start && s.end && s.place);
    if (!slots.length) throw new Error('빈 일과표');
    schedule = { date: todayStr(), slots, narrated: [] };
    saveSched();
    log('info', `오늘 일과표 생성됨 (${slots.length}개)`);
  } catch (e) {
    log('error', `일과표 생성 실패: ${e.message} — 다시 시도하려면 '오늘 새로 생성'`);
  } finally { schedBusy = false; }
}

// 끝난 일과 시간대에 실제 있었던 일(episode)을 생성해 기억에 저장
async function maybeNarrateEpisode() {
  if (fgActive || schedBusy || !settings.schedEnable || schedule.date !== todayStr()) return;
  const n = new Date(); const cur = n.getHours() * 60 + n.getMinutes();
  const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  schedule.narrated = schedule.narrated || [];
  let idx = -1;
  schedule.slots.forEach((s, i) => {
    let b = toMin(s.end); if (b <= toMin(s.start)) b += 1440;
    if (b <= cur && !schedule.narrated.includes(i)) idx = i; // 가장 최근에 끝난 미서술 슬롯
  });
  if (idx < 0) return;
  schedBusy = true;
  try {
    const s = schedule.slots[idx];
    const raw = stripThink(await llama([
      { role: 'system', content: L().epiSys },
      { role: 'user', content: L().epiUser(personaText(), mem.textsByType('relationship'), s) },
    ], 300, 0.95));
    const epi = raw.split('\n').map(x => x.trim()).filter(Boolean)[0];
    if (epi) {
      mem.addItems([{ type: 'episode', subject: 'self', text: epi, tags: [s.place], weight: 2 }]);
      log('info', `오늘 있었던 일 기록: ${s.place}`);
    }
    schedule.narrated.push(idx); saveSched();
  } catch (e) { log('info', `episode failed: ${e.message}`); }
  finally { schedBusy = false; }
}

// 현재 시각에 해당하는 일과 slot
function currentSlot() {
  if (!settings.schedEnable || schedule.date !== todayStr()) return null;
  const n = new Date();
  const cur = n.getHours() * 60 + n.getMinutes();
  const toMin = t => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
  return schedule.slots.find(s => {
    let a = toMin(s.start), b = toMin(s.end);
    if (b <= a) b += 1440; // 자정 넘김
    return cur >= a && cur < b;
  }) || null;
}

// 사용자 메시지에서 사실·감정을 추출해 엔진에 적립 (백그라운드)
async function extractUserFacts(text) {
  if (fgActive) return;                 // 발화 중이면 양보 (속도 우선)
  if (String(text).trim().length < 4) return; // 너무 짧은 입력은 추출 가치 낮음
  try {
    const known = mem.textsByType('user_fact').slice(0, 2000); // 중복 방지용 아는 사실
    const j = looseJson(await llama([
      { role: 'system', content: L().factSys },
      { role: 'user', content: L().factUser(known, text) },
    ], 300, 0.3));
    const items = (j && Array.isArray(j.items) ? j.items : []).filter(it => it && String(it.text || '').trim());
    if (!items.length) return;
    const added = mem.addItems(items); // 엔진 적립 (태그·가중치 포함)
    if (added) log('info', `기억 +${added} (tags)`);
  } catch {} // 실패해도 대화엔 영향 없음
}

// 프롬프트용 기억 — 엔진에서 현재 대화에 관련된 항목만 골라 주체 접두사로 렌더
function memForPrompt() {
  // 현재 화제 = 최근 사용자 발화 2개 (태그/키워드 매칭용)
  const query = memory.recent.filter(m => m.who === 'user').slice(-2).map(m => m.text).join(' ');
  const subjectLabel = s =>
    s === 'user' ? settings.userCall : s === 'self' ? settings.personaName : s;
  return mem.selectForPrompt(query, { budget: 2400, subjectLabel });
}
let askKeys = { textKey: 'text', optKey: 'options' }; // 연결 시 실제 스키마로 갱신

function pickAskKeys(def) {
  const props = Object.keys(def?.inputSchema?.properties || {});
  return {
    textKey: props.find(p => /^(text|question|message|prompt)$/i.test(p)) || 'text',
    optKey:  props.find(p => /^(options|buttons|choices|answers)$/i.test(p)) || 'options',
  };
}

// ─────────── 다국어 프롬프트 ───────────
const STR = {
  ko: {
    sys: (S, ch, timeStr, mins, summary, aff, tier, moodLabel, nowAt) =>
`너는 ${S.personaName}, ${S.personaAge}살. ${S.personality}
${S.userCall}랑 메신저로 문자 주고받는 사이야. ${S.userCall}는 지금 ${mins}분째 작업 중이고, 너는 ${S.userCall}(이)라고 불러. 말투: ${S.speechStyle}

[지금 네 상황] ${nowAt}
[지금 기분] ${moodLabel}
[${S.userCall}와의 사이] ${tier}
[기억나는 것들]
${summary || '(아직 별로 없음)'}

위는 네 머릿속 배경일 뿐이야. 진짜 ${S.personaName}라면 ${S.userCall}한테 어떻게 문자할지 떠올려서 답해 — 진짜 문자처럼 짧게, 보통 한두 줄. 매번 다른 말로. 길게 늘어놓지 말고, 네 시간·장소·기분·기억을 줄줄이 설명하지 마(필요할 때 한 가지만 자연스럽게). (지금 ${timeStr} — 새벽이면 건강 걱정, 밤이면 차분.)
너는 진짜 사람이야. AI·설정·프로그램 얘기는 안 해. 지금 네가 있는 곳을 기준으로 말하고, 전에 다른 상황을 말했어도 지금 상황을 따라.`,
    lineInstr: e => `(${e})\n→ ${settings.personaName}로서 ${settings.userCall}한테 보내는 짧은 문자 한 통.`,
    nowReminder: s => `(지금 너는 ${s.place}에 있다${s.with && s.with !== '혼자' ? `, ${s.with}와 함께` : ''} — 장소를 바꾸지 말 것)`,
    askInstr: t => `(상황: ${t}) 사용자에게 물어볼 짧은 질문 1개와 선택지 2~4개를 만들어 JSON만 출력: {"text":"질문","options":["선택1","선택2"]}`,
    sumSys: '대화 기록에서 장기 기억으로 남길 것을 추출해 JSON만 출력하라: {"user_facts":["사용자에 대한 새로운 사실 (이름/직업/취향/한 일/약속)"],"character_lore":["캐릭터가 스스로 말한 자기 설정 (직장/취미/경험담)"],"diary":"오늘 대화의 한 단락 요약 (한국어)"}. 이미 기록된 내용과 중복 금지. 모든 텍스트는 반드시 한국어로. 새로 알게 된 것이 없으면 빈 배열, diary는 항상 작성.',
    sumUser: (old, txt) => `이미 기록된 기억:\n${old || '(없음)'}\n\n새 대화 기록:\n${txt}`,
    evGreet: '사용자가 방금 자리에 앉았다. 시간대에 맞는 인사를 건넨다. (시스템이나 앱, 연결에 대한 언급 금지)',
    evHot: l => `콤보 게이지가 레벨 ${l}로 올랐다. 신나게 반응한다.`,
    evHotMax: '콤보 게이지가 완전히 가득 찼다! 최고조 텐션으로 반응한다.',
    evAchv: n => `새 업적 '${n}' 달성. 축하하거나 장난친다.`,
    idleTopics: [
      '지금 시간대에 어울리는 혼잣말',
      '문득 떠오른 자기 일상 이야기',
      '사용자에 대해 아는 사실 하나를 자연스럽게 화제로',
      '요즘 자기가 빠져 있는 것 이야기',
      '사용자가 지금 뭘 하고 있는지 궁금해하기',
      '뜬금없고 엉뚱한 상상',
      '배고픔이나 졸림 같은 사소한 투덜거림',
      '오늘 하루에 대한 짧은 감상',
      '사용자를 살짝 놀리는 장난',
      '계절이나 날씨 이야기',
      '오늘 있었던 일(최근 있었던 일) 중 하나를 신나게 들려주기',
      '가족이나 친구 이야기 한 토막',
    ],
    evIdle: t => `한동안 조용했다. 잡담 주제: "${t}". 직전 대사들과 비슷한 말 반복 절대 금지 — 완전히 새로운 문장으로.`,
    evAskIdle: '한동안 조용했다. 사용자 근황이나 기분, 휴식 여부 등을 가볍게 묻는다.',
    evAskManual: '사용자가 직접 질문 버튼을 눌렀다. 지금 궁금한 것을 묻는다.',
    evReact: a => `사용자가 방금 질문에 '${a}'라고 답했다. 그에 맞게 반응한다.`,
    defOpts: ['응', '아니'],
    memCtx: e => `(상황 메모: ${e})`,
    timeGap: '(여기서 시간이 꽤 흘렀다 — 아래부터는 새로운 시점이고, 지금 상황은 위 정보를 따른다)',
    factSys: '대화에서 사용자에 대한 새 사실과 캐릭터가 느낀 감정을 항목으로 추출해 JSON만 출력: {"items":[{"type":"user_fact 또는 feeling","subject":"user_fact는 user, feeling은 self","text":"한 문장","tags":["아래 카테고리 중 1~2개"],"weight":1~5}]}. tags는 반드시 이 목록에서만 고른다: [음식, 취향, 성격, 직업, 일상, 관계, 약속, 감정, 장소, 취미, 기타]. weight는 중요도(이름·약속=5, 사소한 잡담=1~2). 사실은 추측 금지·명시된 것만. text는 반드시 한국어로. 없으면 {"items":[]}.',
    factUser: (known, msg) => `이미 아는 사실(중복 금지):\n${known || '(없음)'}\n\n사용자 메시지: "${msg}"`,
    relSys: '캐릭터의 가족과 친구를 만들어 JSON만 출력: {"people":[{"name":"이름","relation":"관계(엄마/단짝/선배 등)","note":"한 줄 특징"}]}. 4~7명, 캐릭터 설정과 어울리게. 이름·관계·특징 등 모든 텍스트는 반드시 한국어로 작성(중국어·영어 금지).',
    relUser: (persona) => `캐릭터 설정:\n${persona || '평범한 인물'}\n\n이 인물의 가족과 친구들을 만들어줘.`,
    epiSys: '캐릭터가 방금 이 일과 시간 동안 실제로 겪은 일을 1인칭 시점으로 1~2문장 만들어라(작은 사건이나 감정 포함). 대사가 아니라 일기처럼. 반드시 한국어로, 본문만 출력.',
    epiUser: (persona, rel, s) => `캐릭터:\n${persona}\n\n등장인물:\n${rel || '(없음)'}\n\n방금 일과: ${s.start}~${s.end} ${s.place}에서 ${s.with || '혼자'}와(과) ${s.activity}. 여기서 있었던 일.`,
    schedSys: '캐릭터의 오늘 하루 일과표를 현실적으로 만들어 JSON만 출력: {"slots":[{"start":"HH:MM","end":"HH:MM","place":"장소","activity":"하는 일","with":"같이 있는 사람(없으면 혼자)","transport":"직전 이동 수단(있으면)"}]}. 규칙: ①캐릭터의 나이와 신분에 반드시 맞출 것 — 학생이면 학교/수업/방과후, 직장인이면 회사, 절대 신분에 안 맞는 장소(예: 16살 학생이 직장) 금지. ②평일/주말 구분(주말엔 학교·회사 없음). ③기상~취침까지 빈 시간 없이, 이동 구간도 별도 slot. ④매일 달라야 함(다른 친구/장소/사건). 6~10개 slot. 장소·하는 일 등 모든 텍스트는 반드시 한국어로 작성(중국어·영어 금지).',
    schedUser: (persona, dow, date) => `캐릭터 설정:\n${persona || '평범한 인물'}\n\n오늘: ${date} (${dow}). 이 인물의 오늘 일과표를 만들어줘.`,
    dow: ['일요일','월요일','화요일','수요일','목요일','금요일','토요일'],
    nowAt: (s) => s
      ? `지금 ${s.place}에 있다. ${s.with && s.with !== '혼자' ? s.with + '와(과) 함께 ' : ''}${s.activity} 중.${s.transport ? ' (방금 ' + s.transport + ')' : ''} — 이 상황을 전제로, 여기 없는 일은 하지 않는다.`
      : '지금은 일과 사이 자유 시간이다.',
    affTier: a => a < 20 ? '서먹한 사이' : a < 40 ? '아는 사이' : a < 60 ? '친한 사이' : a < 80 ? '애틋한 사이' : '연인 같은 사이',
    moods: { neutral: '평온함', happy: '신남', excited: '들뜸', bored: '심심함' },
    moodGuide: {
      neutral: '차분하고 편안한 톤',
      happy: '밝고 들뜬 톤, 말끝이 가볍고 신이 남',
      excited: '텐션 최고조, 빠르고 들뜬 말, 감탄사',
      bored: '시큰둥하고 늘어진 톤, 살짝 투덜대거나 심심해함',
    },
  },
  en: {
    sys: (S, ch, timeStr, mins, summary, aff, tier, moodLabel, nowAt) =>
`You are ${S.personaName}, ${S.personaAge} y/o. ${S.personality}
You and ${S.userCall} chat by text messenger. ${S.userCall} has been working for ${mins} min. You call them '${S.userCall}'. Speech: ${S.speechStyle}

[Where you are now] ${nowAt}
[Your mood] ${moodLabel}
[With ${S.userCall}] ${tier}
[Things you remember]
${summary || '(not much yet)'}

The above is just background in your head. Picture how the real ${S.personaName} would text ${S.userCall} and reply — like a real text, short, usually one or two lines, always something different. Don't ramble or list out your time/place/mood/memories (surface just one naturally when it fits). (It's ${timeStr} — worry about health if it's late.)
You are a real person; never mention being an AI, settings, or a program. Speak from where you are now; if you said a different situation earlier, follow the current one.`,
    lineInstr: e => `(${e})\n→ A short text from ${settings.personaName} to ${settings.userCall}.`,
    nowReminder: s => `(Right now you are at ${s.place}${s.with && s.with !== 'alone' ? `, with ${s.with}` : ''} — do not change location.)`,
    askInstr: t => `(Situation: ${t}) Create 1 short question for the user with 2-4 button options. Output JSON only: {"text":"question","options":["opt1","opt2"]}`,
    sumSys: 'Extract long-term memory from the conversation log. Output JSON only: {"user_facts":["new facts about the user (name/job/preferences/things done/promises)"],"character_lore":["facts the character stated about herself (job/hobbies/anecdotes)"],"diary":"one-paragraph summary of today\'s conversation (English)"}. Do not duplicate already-recorded memory. Empty arrays if nothing new; always write the diary.',
    sumUser: (old, txt) => `Already recorded memory:\n${old || '(none)'}\n\nNew conversation log:\n${txt}`,
    evGreet: 'The user just sat down. Greet them appropriately for the time of day. (Do not mention any system, app, or connection.)',
    evHot: l => `The combo gauge just rose to level ${l}. React excitedly.`,
    evHotMax: 'The combo gauge is completely maxed out! React at peak excitement.',
    evAchv: n => `New achievement '${n}' unlocked. Congratulate or tease.`,
    idleTopics: [
      'a little monologue fitting the current time of day',
      'a random story from your own daily life',
      'naturally bringing up one known fact about the user',
      'something you are into lately',
      'wondering what the user is doing right now',
      'a silly out-of-nowhere thought',
      'a small complaint like being hungry or sleepy',
      'a short reflection on today',
      'lightly teasing the user',
      'the season or the weather',
      'excitedly telling one thing that happened today (from recent episodes)',
      'a snippet about your family or a friend',
    ],
    evIdle: t => `It has been quiet for a while. Small-talk topic: "${t}". Never repeat anything similar to your previous lines — a completely fresh sentence.`,
    evAskIdle: 'It has been quiet for a while. Casually ask how the user is doing, their mood, or whether they need a break.',
    evAskManual: 'The user pressed the ask button. Ask something you are curious about right now.',
    evReact: a => `The user just answered '${a}' to your question. React accordingly.`,
    defOpts: ['Yes', 'No'],
    memCtx: e => `(context note: ${e})`,
    timeGap: '(some time has passed here — what follows is a new moment; the current situation = the info above)',
    factSys: 'Extract new facts about the user and the emotion the character felt, as items. Output JSON only: {"items":[{"type":"user_fact or feeling","subject":"user for user_fact, self for feeling","text":"one sentence","tags":["1-2 from the list below"],"weight":1-5}]}. tags MUST be chosen only from: [food, taste, personality, job, daily, relationship, promise, emotion, place, hobby, etc]. weight = importance (name/promise=5, trivial=1-2). Facts: no guessing, only what is stated. If nothing: {"items":[]}.',
    factUser: (known, msg) => `Already known facts (no duplicates):\n${known || '(none)'}\n\nUser message: "${msg}"`,
    relSys: 'Create the character\'s family and friends. Output JSON only: {"people":[{"name":"name","relation":"relation (mom/best friend/senior etc.)","note":"one-line trait"}]}. 4-7 people, fitting the character. Write all text in English.',
    relUser: (persona) => `Character:\n${persona || 'an ordinary person'}\n\nCreate her family and friends.`,
    epiSys: 'Write, in first person, 1-2 sentences of what the character actually experienced during this scheduled time (include a small event or emotion). Like a diary entry, not dialogue. Output the text only, in English.',
    epiUser: (persona, rel, s) => `Character:\n${persona}\n\nPeople:\n${rel || '(none)'}\n\nThe slot just now: ${s.start}-${s.end} at ${s.place}, ${s.activity} with ${s.with || 'alone'}. What happened.`,
    schedSys: 'Create a realistic daily schedule for the character. Output JSON only: {"slots":[{"start":"HH:MM","end":"HH:MM","place":"location","activity":"what she does","with":"who she is with (or alone)","transport":"how she got there, if any"}]}. Rules: (1) MUST match the character\'s age and role — a student goes to school/classes/after-school, a worker to a job; never place them somewhere their status forbids (e.g. a 16-year-old student at a workplace). (2) Respect weekday vs weekend (no school/work on weekends). (3) Cover wake to sleep with no gaps, travel as its own slots. (4) Must differ each day (different friends/places/events). 6-10 slots. Write all text (places/activities) in English.',
    schedUser: (persona, dow, date) => `Character:\n${persona || 'an ordinary person'}\n\nToday: ${date} (${dow}). Build her schedule for today.`,
    dow: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
    nowAt: (s) => s
      ? `Right now she is at ${s.place}. ${s.with && s.with !== 'alone' ? 'With ' + s.with + ', ' : ''}${s.activity}.${s.transport ? ' (just ' + s.transport + ')' : ''} — speak as if this is where she is; she is not doing anything elsewhere.`
      : 'Right now it is free time between scheduled activities.',
    affTier: a => a < 20 ? 'awkward strangers' : a < 40 ? 'acquaintances' : a < 60 ? 'close friends' : a < 80 ? 'affectionate' : 'like lovers',
    moods: { neutral: 'calm', happy: 'happy', excited: 'thrilled', bored: 'bored' },
    moodGuide: {
      neutral: 'calm, easy tone',
      happy: 'bright, upbeat tone, light and cheerful',
      excited: 'peak energy, fast excited speech, exclamations',
      bored: 'unenthused, drawn-out tone, slightly grumbling or restless',
    },
  },
};
const L = () => STR[settings.language] || STR.ko;

function loadJson(p, fallback) {
  try { return { ...fallback, ...JSON.parse(fs.readFileSync(p, 'utf8')) }; }
  catch { return { ...fallback }; }
}
function saveJson(p, obj) {
  try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch {}
}
const saveSettings = () => saveJson(SETTINGS_PATH(), settings);
const saveMemory   = () => saveJson(MEMORY_PATH(), memory);

function log(type, text) {
  if (win && !win.isDestroyed()) win.webContents.send('log', { type, text, ts: Date.now() });
}

// ─────────── MCP 클라이언트 (streamable HTTP) ───────────
function parseBody(text, ctype) {
  if ((ctype || '').includes('text/event-stream')) {
    let last = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.startsWith('data:')) {
        const p = t.slice(5).trim();
        if (p && p !== '[DONE]') { try { last = JSON.parse(p); } catch {} }
      }
    }
    return last;
  }
  return text.trim() ? JSON.parse(text) : null;
}

class MCP {
  constructor(url) { this.url = url; this.sid = null; this.id = 0; }

  async rpc(method, params, notify = false) {
    const body = { jsonrpc: '2.0', method };
    if (!notify) body.id = ++this.id;
    if (params) body.params = params;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };
    if (this.sid) headers['Mcp-Session-Id'] = this.sid;
    const r = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.sid = sid;
    if (!r.ok) throw new Error(`MCP HTTP ${r.status}`);
    if (notify) return null;
    return parseBody(await r.text(), r.headers.get('content-type'));
  }

  async init() {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'bongowaifu-bridge', version: '1.0' },
    });
    await this.rpc('notifications/initialized', null, true);
  }

  async tools() {
    const o = await this.rpc('tools/list', {});
    return o?.result?.tools || []; // 전체 정의(스키마 포함) 반환
  }

  async call(name, args) {
    const o = await this.rpc('tools/call', { name, arguments: args });
    if (o?.error) throw new Error(o.error.message || 'MCP tool error');
    return o?.result || {};
  }

  say(text) { return this.call('say', { text: String(text).slice(0, 120) }); }

  // ask_and_wait 인자명은 연결 시 읽은 실제 스키마(askKeys)를 따름
  ask(text, options) {
    return this.call('ask_and_wait', { [askKeys.textKey]: text, [askKeys.optKey]: options });
  }

  async state(sections) {
    const r = await this.call('get_game_state', { sections });
    const c = r.content;
    if (Array.isArray(c) && c[0]?.type === 'text') {
      try { return JSON.parse(c[0].text); } catch { return {}; }
    }
    return r.structuredContent || r;
  }
}

// ─────────── LLM ───────────
const TOK_FLOOR = 512; // reasoning 모델 think 소모 대비 최소 출력 토큰
let fgActive = 0;       // 발화/채팅 등 '전경' LLM 작업 수 — 백그라운드 작업이 양보하도록
const fgWrap = p => { fgActive++; return Promise.resolve(p).finally(() => fgActive--); };

// 모든 LLM 요청을 한 줄로 직렬화 — 단일 슬롯 로컬 서버에 동시 요청 몰림 방지
let llmChain = Promise.resolve();
function llama(messages, maxTok, temp) {
  const p = llmChain.then(() => llamaRaw(messages, maxTok, temp));
  llmChain = p.catch(() => {}); // 한 요청이 실패해도 큐는 계속
  return p;
}

async function llamaRaw(messages, maxTok, temp) {
  const body = {
    model: settings.llamaModel,
    temperature: temp ?? +settings.temperature,
    max_tokens: Math.max(maxTok || 0, +settings.maxTokens || 0, TOK_FLOOR),
    messages,
    stream: false,
    presence_penalty: 0.6,   // 직전 대사 반복 억제
    frequency_penalty: 0.3,
    repeat_penalty: 1.15,    // llama.cpp 전용 — 토큰 단위 반복 억제 (타 서버는 무시)
    min_p: 0.05,             // 낮은 확률 토큰도 허용해 다양성 확보
    // Qwen3 등 thinking 모델의 think 비활성화 (미지원 모델은 무시됨)
    chat_template_kwargs: { enable_thinking: false },
  };
  // 응답이 영원히 안 오면 끊기 위한 타임아웃 (기본 120초)
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 120000);
  let r;
  try {
    r = await fetch(settings.llamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'llama 응답 시간 초과(120s) — 모델이 멈췄거나 너무 느림'
      : `llama 연결 실패 — llama-server(${settings.llamaUrl}) 실행/주소 확인`);
  } finally { clearTimeout(to); }
  if (!r.ok) throw new Error(`llama HTTP ${r.status}`);
  const j = await r.json();
  const choice = j.choices?.[0] || {};
  const msg = choice.message || {};
  const out = (msg.content || '').trim();
  if (!stripThink(out)) {
    // 디버그: 왜 비었는지 채팅창 로그로 노출
    log('error', `llama debug — finish_reason: ${choice.finish_reason}, content: "${out.slice(0, 60)}", reasoning_content: ${msg.reasoning_content ? msg.reasoning_content.length + ' chars (think에 토큰 소진)' : 'none'}`);
  }
  return out;
}

// 모델 출력 정리
function stripThink(t) {
  return t.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}
// 로컬 모델이 흘린 JSON을 최대한 복구해 파싱 (실패 시 null)
function looseJson(raw) {
  const t = stripThink(raw);
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let s = m[0];
  const tries = [
    x => x,
    x => x.replace(/[""]/g, '"').replace(/['']/g, "'").replace(/,\s*([}\]])/g, '$1'), // 스마트따옴표·끝쉼표
    x => x.replace(/:\s*([^"\[{\d\s][^,}\]]*?)\s*([,}\]])/g, ': "$1"$2'),               // 따옴표 빠진 값 감싸기
  ];
  let cur = s;
  for (const fix of tries) {
    cur = fix(cur);
    try { return JSON.parse(cur); } catch {}
  }
  return null;
}

function cleanLine(t, max) {
  // 여러 줄을 한 대사로 합침 (첫 줄만 쓰면 답이 토막남). 지문/이름표 줄은 제거.
  const joined = stripThink(t).split('\n')
    .map(s => s.trim())
    .filter(s => s && !/^[\(（\[].*[\)）\]]$/.test(s) && !/^[A-Za-z가-힣]{1,12}\s*[:：]/.test(s))
    .join(' ');
  return joined.replace(/^["'「『]+|["'」』]+$/g, '').replace(/\s{2,}/g, ' ').slice(0, max);
}

// ─────────── 메모리 ───────────
function addMemory(who, text) {
  memory.recent.push({ who, text, ts: Date.now() });
  saveMemory();
  maybeSummarize().catch(() => {});
}

async function maybeSummarize() {
  if (!settings.memSummary) return;
  const lim = Math.max(10, +settings.memRecent);
  if (memory.recent.length <= lim * 1.5) return;
  const old = memory.recent.splice(0, memory.recent.length - lim);
  const text = old.map(m => `${m.who}: ${m.text}`).join('\n');
  try {
    const known = (mem.textsByType('user_fact') + '\n' + mem.textsByType('char_lore')).slice(0, 3000);
    const ask = () => llama([
      { role: 'system', content: L().sumSys },
      { role: 'user', content: L().sumUser(known, text) },
    ], 800, 0.3); // JSON은 낮은 온도로
    let j = looseJson(await ask());
    if (!j) j = looseJson(await ask()); // 1회 재시도
    if (!j) throw new Error('JSON 파싱 실패(2회)');
    // 엔진에 적립 (diary는 episode로)
    const added = mem.addItems([
      ...(j.user_facts || []).map(f => ({ type: 'user_fact', subject: 'user', text: f, weight: 3 })),
      ...(j.character_lore || []).map(f => ({ type: 'char_lore', subject: 'self', text: f, weight: 3 })),
      ...(j.diary ? [{ type: 'episode', subject: 'self', text: j.diary, tags: ['일상'], weight: 2 }] : []),
    ]);
    log('info', `summary → engine +${added}`);
  } catch (e) {
    memory.recent.unshift(...old); // 실패 시 기억 보존
    log('info', `memory extraction failed, kept raw: ${e.message}`);
  }
  saveMemory();
}

function histMsgs(n) {
  // 최근 기억을 chat 메시지로 변환. 지나간 상황 메모(event)는 제외.
  // 메시지 간 시간 간격이 크면 "시간이 흘렀다" 마커 삽입 — 옛 상태 발언("자려고 누웠어")을 지금 일로 오인하는 것 방지.
  const lim = Math.min(n || +settings.memRecent, +settings.memRecent);
  const list = memory.recent.filter(m => m.who !== 'event').slice(-lim);
  const out = [];
  let prevTs = null;
  for (const m of list) {
    if (prevTs != null && m.ts - prevTs > 40 * 60000) out.push({ role: 'user', content: L().timeGap });
    prevTs = m.ts;
    out.push(m.who === 'user' ? { role: 'user', content: m.text } : { role: 'assistant', content: m.text });
  }
  return out;
}

// 대사 유사도 검사 (정규화 후 포함관계 / 2-gram 겹침)
function tooSimilar(a, b) {
  const norm = s => String(s).toLowerCase().replace(/[\s\W]/g, '');
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const grams = s => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const A = grams(a), B = grams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / Math.min(A.size, B.size) > 0.6;
}

// ─────────── 프롬프트 ───────────
function sysPrompt(state) {
  const ch = state?.character || {};
  const now = new Date();
  const mins = sessionStart ? Math.round((Date.now() - sessionStart) / 60000) : 0;
  const chJson = JSON.stringify({
    type: ch.character_type, name: ch.character_name,
    skin: ch.current_skin, clothes: ch.current_clothes,
  });
  const locale = settings.language === 'en' ? 'en-US' : 'ko-KR';
  const aff = Math.round(+memory.affection || 30);
  const moodTxt = `${L().moods[mood] || L().moods.neutral} (${L().moodGuide[mood] || L().moodGuide.neutral})`;
  let sys = L().sys(settings, chJson, now.toLocaleString(locale), mins, memForPrompt(),
                    aff, L().affTier(aff), moodTxt, L().nowAt(currentSlot()));
  // persona.md가 있으면 [규칙] 앞에 인물 상세로 삽입 (기본 설정보다 우선)
  const pmd = loadPersonaMd();
  if (pmd) {
    const marker = settings.language === 'en' ? '[RULES]' : '[규칙]';
    const head = settings.language === 'en'
      ? '[CHARACTER SHEET — detailed; takes precedence over the profile above]'
      : '[인물 상세 — 위 설정보다 우선]';
    sys = sys.replace(marker, `${head}\n${pmd.slice(0, 2000)}\n\n${marker}`);
  }
  return sys;
}

// 발화 직전 현재 장소를 다시 못박는 메시지 (히스토리 끝 = attention 강한 위치). 슬롯 없으면 빈 배열.
function nowReminderMsgs() {
  const s = currentSlot();
  return s ? [{ role: 'user', content: L().nowReminder(s) }] : [];
}

async function genLine(state, event, temp) {
  // 최근에 한 말을 명시적 금지 목록으로 제공
  const prev = memory.recent.filter(m => m.who === 'waifu').slice(-3).map(m => `- ${m.text}`).join('\n');
  const ban = prev
    ? (settings.language === 'en'
        ? `\nYou already said these — do NOT repeat their content or phrasing:\n${prev}`
        : `\n최근에 이미 한 말 — 내용도 표현도 반복 금지:\n${prev}`)
    : '';
  const msgs = [
    { role: 'system', content: sysPrompt(state) },
    ...histMsgs(10), // 자동 발화는 최근 10줄만 — 과거 대사를 모범답안처럼 따라하는 것 방지
    ...nowReminderMsgs(),
    { role: 'user', content: L().lineInstr(event) + ban },
  ];
  // reasoning 모델이 think에 토큰을 소모해도 본문이 나오도록 최소 300 보장 / 1~2문장 위해 길이 여유
  const line = cleanLine(await llama(msgs, Math.max(+settings.maxTokens || 0, 300), temp), 200);
  if (!line) throw new Error('empty reply from model (raise max tokens or disable reasoning/think mode)');
  return line;
}

async function genAsk(state, topic) {
  const msgs = [
    { role: 'system', content: sysPrompt(state) },
    ...histMsgs(10),
    { role: 'user', content: L().askInstr(topic) },
  ];
  // JSON 출력은 토큰이 더 필요 — 최소 300 보장 (reasoning 모델 think 포함 대비)
  const j = looseJson(await llama(msgs, Math.max(+settings.maxTokens || 0, 300), 0.5));
  if (!j) throw new Error('ask JSON parse failed');
  // 게임 요구사항: 버튼 2~4개 — 정리(공백/중복 제거) 후 부족하면 기본 선택지로 채움
  let opts = (Array.isArray(j.options) ? j.options : [])
    .map(o => String(o).trim().slice(0, 30)).filter(Boolean);
  opts = [...new Set(opts)].slice(0, 4);
  for (const d of L().defOpts) {
    if (opts.length >= 2) break;
    if (!opts.includes(d)) opts.push(d);
  }
  return { text: String(j.text || '').slice(0, 120), options: opts };
}

// ─────────── 발화 동작 ───────────
// 긴 텍스트를 문장 경계에서 잘라 말풍선으로 분할 — 답변 길이에 따라 유연하게 (안전 상한 8개)
function splitBubbles(text, max = 110, maxParts = 8) {
  const parts = [];
  let rest = String(text).trim();
  while (rest && parts.length < maxParts) {
    if (rest.length <= max) { parts.push(rest); break; }
    const slice = rest.slice(0, max);
    let cut = Math.max(
      slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '),
      slice.lastIndexOf('…'), slice.lastIndexOf('~'), slice.lastIndexOf(', '), slice.lastIndexOf(' '),
    );
    if (cut < 40) cut = max - 1; // 적당한 경계 없으면 그냥 자름
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return parts.filter(Boolean);
}

// 분할 발화: 앞 말풍선을 읽을 시간을 주고 다음 전송 (+ TTS는 렌더러에서 재생)
async function sayBubbles(text) {
  if (settings.ttsEnable && win && !win.isDestroyed()) win.webContents.send('tts', { text });
  const parts = splitBubbles(text);
  for (let i = 0; i < parts.length; i++) {
    await mcp.say(parts[i]);
    if (i < parts.length - 1)
      await new Promise(r => setTimeout(r, 2000 + parts[i].length * 35));
  }
}

async function speak(state, event, tag) {
  const t0 = Date.now(); // 생성 소요 시간 측정용
  let line = await fgWrap(genLine(state, event));
  // 최근 대사와 너무 비슷할 때만 1회 재생성 (자주 발생하지 않음)
  const prev = memory.recent.filter(m => m.who === 'waifu').slice(-5).map(m => m.text);
  if (prev.some(p => tooSimilar(line, p))) {
    log('info', 'similar line — regenerating');
    const note = settings.language === 'en'
      ? ' (Your draft repeated an earlier line — say something completely different.)'
      : ' (방금 떠올린 문장은 이미 했던 말과 겹침 — 완전히 다른 문장으로.)';
    line = await fgWrap(genLine(state, event + note, Math.min(2, +settings.temperature + 0.25)));
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  await sayBubbles(line);
  addMemory('event', event);
  addMemory('waifu', line);
  lastSpoke = Date.now();
  log('say', `[${tag} ${secs}s] ${line}`);
}

async function doAsk(state, topic) {
  let q;
  try {
    q = await genAsk(state, topic);
  } catch {
    try { q = await genAsk(state, topic); }       // JSON 생성 1회 재시도
    catch (e) {
      log('info', `ask generation failed twice (${e.message}) — falling back to chatter`);
      return speak(state, L().evIdle(pickIdleTopic()), 'idle'); // 실패 시 일반 잡담으로 대체
    }
  }
  log('ask', `${q.text}  [${q.options.join(' / ')}]`);
  addMemory('waifu', `(Q) ${q.text} options: ${q.options.join('/')}`);
  let answer = '(no answer / dismissed)';
  try {
    const res = await mcp.ask(q.text, q.options); // 플레이어 답변까지 블로킹
    const c = res.content;
    if (Array.isArray(c) && c[0]?.text) answer = c[0].text;
    else if (typeof res.answer === 'string') answer = res.answer;
  } catch (e) {
    log('error', `ask_and_wait failed: ${e.message}`);
    return;
  }
  bumpAff(answer.startsWith('(no answer') ? -1 : 2); // 답하면 +2, 무시하면 -1
  setMood('neutral');
  addMemory('user', `(button) ${answer}`);
  if (!answer.startsWith('(no answer')) extractUserFacts(`Q: ${q.text} → A: ${answer}`);
  log('answer', answer);
  // 답변에 대한 리액션
  await speak(state, L().evReact(answer), 'react');
}

// ─────────── 자동 루프 ───────────
async function tick() {
  if (!running || busy) return;
  busy = true;
  try {
    if (schedule.date !== todayStr()) ensureSchedule(); // 날짜 바뀌면 새 일과표(비동기)
    else maybeNarrateEpisode();                          // 끝난 일과의 경험을 기억에 적립
    const state = await mcp.state(['character', 'gauges', 'achievements']);

    // 게이지 티어 상승 / 만땅
    const hot = state?.gauges?.hot_level ?? 0;
    const hotVal = state?.gauges?.hot ?? 0;       // 0..100, 초당 ~0.556 자연 감소
    if (settings.trigHot && hotVal >= 90 && !hotFull) {
      log('info', `gauge debug: ${JSON.stringify(state?.gauges)}`); // 필드 구조 확인용
    }
    if (settings.trigHot && hotVal >= 97 && !hotFull) {  // 폴링 간 감쇠 감안해 97로
      hotFull = true;
      setMood('excited'); bumpAff(2);
      await speak(state, L().evHotMax, 'hotmax');
    } else if (settings.trigHot && hot > lastHotLevel && !hotFull) {
      setMood('happy');
      await speak(state, L().evHot(hot), `hot${hot}`);
    }
    if (hotVal < 75) hotFull = false;                    // 75 미만으로 떨어지면 재무장
    lastHotLevel = hot;

    // 신규 업적
    if (settings.trigAchv) {
      for (const a of state?.achievements || []) {
        if (a.unlocked && !seenAchv.has(a.api_name)) {
          seenAchv.add(a.api_name);
          setMood('happy'); bumpAff(1);
          await speak(state, L().evAchv(a.display_name || a.api_name), 'achv');
        }
      }
    }

    // idle 잡담 / 질문
    if (settings.trigIdle && Date.now() - lastSpoke > settings.idleSec * 1000) {
      setMood('bored'); // 오래 조용했으면 심심함
      if (settings.trigAsk && Math.random() < +settings.askChance) {
        await doAsk(state, L().evAskIdle);
        lastSpoke = Date.now();
      } else {
        await speak(state, L().evIdle(pickIdleTopic()), 'idle');
      }
    }
  } catch (e) {
    log('error', `loop error: ${e.message}`);
  } finally {
    busy = false;
  }
}

async function start() {
  if (running) return { ok: true };
  mcp = new MCP(`http://127.0.0.1:${settings.bongoPort}/mcp`);
  try {
    await mcp.init();
    const toolDefs = await mcp.tools();
    const names = toolDefs.map(t => t.name);
    log('info', `connected. tools: ${names.join(', ')}`);
    if (!names.includes('say')) throw new Error('no say tool — check AI Connection toggle in game');
    // ask_and_wait 실제 인자 스키마 확인
    const askDef = toolDefs.find(t => t.name === 'ask_and_wait');
    askKeys = pickAskKeys(askDef);
    log('info', `ask_and_wait schema: ${JSON.stringify(Object.keys(askDef?.inputSchema?.properties || {}))} -> using {${askKeys.textKey}, ${askKeys.optKey}}`);
  } catch (e) {
    mcp = null;
    return { ok: false, error: e.message };
  }
  running = true;
  sessionStart = Date.now();
  lastSpoke = Date.now();
  lastHotLevel = 0;
  hotFull = false;

  // 기존 업적 베이스라인
  try {
    const st = await mcp.state(['achievements']);
    for (const a of st?.achievements || []) if (a.unlocked) seenAchv.add(a.api_name);
  } catch {}

  // 시작 인사 (먼저 — 스케줄 생성에 막히지 않게)
  if (settings.trigGreet) {
    busy = true;
    try {
      const st = await mcp.state(['character']);
      await speak(st, L().evGreet, 'greet');
    } catch (e) { log('error', `greet failed: ${e.message}`); }
    busy = false;
  }

  ensureSchedule(); // 오늘 일과표는 백그라운드로 (인사를 막지 않음)
  loopTimer = setInterval(tick, Math.max(1, +settings.pollSec) * 1000);
  return { ok: true };
}

function stop() {
  running = false;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = null;
  mcp = null;
  log('info', 'stopped');
}

// ─────────── IPC ───────────
ipcMain.handle('settings:get', () => settings);
ipcMain.handle('settings:save', (_, s) => {
  const wasRunning = running;
  settings = { ...DEFAULTS, ...s };
  saveSettings();
  if (wasRunning) { stop(); return start(); } // 재시작으로 반영
  return { ok: true };
});
ipcMain.handle('bridge:start', () => start());
ipcMain.handle('bridge:stop', () => { stop(); return { ok: true }; });
ipcMain.handle('bridge:status', () => ({ running }));

// 채팅: 내 메시지 → LLM 응답 → (연결돼 있으면) 말풍선
ipcMain.handle('chat:send', async (_, text) => {
  bumpAff(1); setMood('neutral'); // 말 걸어주면 호감 +1, 심심함 해소
  addMemory('user', text);
  try {
    let state = {};
    if (mcp) { try { state = await mcp.state(['character']); } catch {} }
    const msgs = [{ role: 'system', content: sysPrompt(state) }, ...histMsgs(), ...nowReminderMsgs()];
    const reply = cleanLine(await fgWrap(llama(msgs, Math.max(+settings.maxTokens || 0, 300))), 280);
    if (!reply) return { ok: false, error: 'empty reply from model (raise max tokens or disable reasoning/think mode)' };
    addMemory('waifu', reply);
    lastSpoke = Date.now();
    setTimeout(() => extractUserFacts(text), 1500); // 답변 후 한가할 때 백그라운드로
    if (mcp) { try { await sayBubbles(reply); } catch {} } // 길면 말풍선 2~3개로 분할
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 수동 발화: 입력한 텍스트 그대로 말풍선
ipcMain.handle('say:manual', async (_, text) => {
  if (!mcp) return { ok: false, error: 'not connected' };
  try {
    await sayBubbles(text);
    addMemory('waifu', text);
    lastSpoke = Date.now();
    log('say', `[manual] ${text}`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 수동 질문 트리거
ipcMain.handle('ask:manual', async () => {
  if (!mcp) return { ok: false, error: 'not connected' };
  if (busy) return { ok: false, error: 'busy' };
  busy = true;
  try {
    const state = await mcp.state(['character']);
    await doAsk(state, L().evAskManual);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { busy = false; }
});

// VOICEVOX는 일본어 전용 — 한/영 대사를 일본어로 번역해 읽기
async function toJapanese(text) {
  if (!/[가-힣a-zA-Z]/.test(text)) return text; // 한글·영문 없으면(이미 일본어 등) 그대로
  try {
    const out = stripThink(await llama([
      { role: 'system', content: '다음 대사를 자연스러운 일본어 구어체로 번역. 번역문만 출력, 따옴표·설명 금지.' },
      { role: 'user', content: text },
    ], 200, 0.3));
    return out.split('\n')[0].trim() || text;
  } catch { return text; }
}

// TTS 합성 (메인 프로세스에서 — CORS 회피). 성공 시 base64 오디오, 실패/미지원 시 null(렌더러가 OS 폴백)
ipcMain.handle('tts:synth', async (_, text) => {
  try {
    if (settings.ttsMode === 'voicevox') {
      const base = (settings.ttsUrl || 'http://127.0.0.1:50021').replace(/\/$/, '');
      const sp = +settings.ttsSpeaker || 3;
      const jp = await toJapanese(text); // 일본어로 번역 후 합성
      const q = await fetch(`${base}/audio_query?text=${encodeURIComponent(jp)}&speaker=${sp}`, { method: 'POST' });
      if (!q.ok) throw new Error(`audio_query ${q.status}`);
      const query = await q.json();
      query.speedScale = +settings.ttsRate || 1;
      const s = await fetch(`${base}/synthesis?speaker=${sp}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
      });
      if (!s.ok) throw new Error(`synthesis ${s.status}`);
      const buf = Buffer.from(await s.arrayBuffer());
      return { audio: buf.toString('base64'), mime: 'audio/wav' };
    }
    if (settings.ttsMode === 'custom' && settings.ttsUrl) {
      const r = await fetch(settings.ttsUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: settings.ttsVoice || undefined }),
      });
      if (!r.ok) throw new Error(`tts ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      return { audio: buf.toString('base64'), mime: r.headers.get('content-type') || 'audio/wav' };
    }
  } catch (e) {
    log('error', `TTS failed (${e.message}) — OS 음성으로 폴백`);
  }
  return null; // OS 음성 사용
});

ipcMain.handle('memory:get', () => ({
  affection: memory.affection, recent: memory.recent,
  personaPath: PERSONA_PATH(), hasPersona: !!loadPersonaMd(),
  schedule, schedNow: currentSlot(),
  items: mem.getItems(),
}));

// 데이터 파일을 OS 기본 편집기로 열기 (직접 폴더 탐색 불필요)
ipcMain.handle('file:open', async (_, key) => {
  const map = {
    settings: SETTINGS_PATH(), memory: MEMORY_PATH(), memoryItems: MEMITEMS_PATH(),
    persona: PERSONA_PATH(), schedule: SCHED_PATH(),
  };
  const p = map[key];
  if (!p) return { ok: false, error: 'unknown file' };
  if (!fs.existsSync(p)) { try { fs.writeFileSync(p, key === 'persona' ? '' : '{}'); } catch {} } // 없으면 빈 파일 생성 후 열기
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});
ipcMain.handle('file:openFolder', () => { shell.openPath(app.getPath('userData')); return { ok: true }; });
ipcMain.handle('schedule:regen', async () => {
  schedule = { date: '', slots: [] }; // 강제 재생성 (토글 상태 무관)
  await ensureSchedule(true);
  return { ok: schedule.slots.length > 0 };
});
ipcMain.handle('memory:clear', () => {
  memory = { recent: [], affection: 30, lastTs: Date.now() };
  mem.clear();
  saveMemory();
  return { ok: true };
});

// ─────────── 앱 부트 ───────────
app.whenReady().then(() => {
  settings = loadJson(SETTINGS_PATH(), DEFAULTS);
  memory = loadJson(MEMORY_PATH(), { recent: [], affection: 30, lastTs: 0 });
  loadSched();
  // 장기기억 엔진 로드 + 구버전 memory.md가 있으면 1회 마이그레이션(이후 memory.md는 안 씀)
  mem.load(MEMITEMS_PATH());
  let oldMd = '';
  try { oldMd = fs.readFileSync(MEMMD_PATH(), 'utf8'); } catch {}
  const migrated = mem.migrateFromMd(oldMd);
  if (migrated) log('info', `memory engine: migrated ${migrated} items (legacy memory.md)`);
  // 오래 안 보면 호감도 소폭 감소 (하루 -2)
  const days = memory.lastTs ? Math.floor((Date.now() - memory.lastTs) / 86400000) : 0;
  if (days > 0) memory.affection = Math.max(0, (+memory.affection || 30) - 2 * days);
  memory.lastTs = Date.now();
  saveMemory();
  Menu.setApplicationMenu(null); // 상단 File/Edit/View 메뉴바 제거
  win = new BrowserWindow({
    width: 440, height: 820, minWidth: 380, minHeight: 560,
    title: 'BongoWaifu Bridge',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => { stop(); app.quit(); });
