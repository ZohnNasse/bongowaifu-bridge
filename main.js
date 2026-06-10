// BongoWaifu <-> llama-server 브릿지 (Electron main)
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

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

const DEFAULTS = {
  // 언어 ('ko' | 'en') — UI와 캐릭터 발화 언어
  language: 'ko',
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
  // TTS
  ttsEnable: false,
  ttsUrl: '',        // 비우면 OS 내장 음성. 채우면 POST {text, voice} → audio 응답 기대, 실패 시 OS 폴백
  ttsVoice: '',      // 서버 음성 이름 또는 OS 음성 이름 일부 (예: Heami)
  ttsRate: 1.0,
};

let settings = { ...DEFAULTS };
let memory = { recent: [], summary: '', affection: 30, lastTs: 0 }; // affection 0~100 영속
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

// ─────────── memory.md (장기기억 — Honcho식 사실 추출) ───────────
let memMd = '';
function loadMd() { try { memMd = fs.readFileSync(MEMMD_PATH(), 'utf8'); } catch { memMd = ''; } }
function saveMd() { try { fs.writeFileSync(MEMMD_PATH(), memMd); } catch {} }

// persona.md — 사용자가 작성한 캐릭터 시트 (매 발화마다 읽어 수정 즉시 반영)
function loadPersonaMd() {
  try { return fs.readFileSync(PERSONA_PATH(), 'utf8').trim(); } catch { return ''; }
}

// 사용자 메시지에서 사실 추출 → memory.md User Facts에 즉시 누적 (백그라운드)
async function extractUserFacts(text) {
  try {
    const raw = stripThink(await llama([
      { role: 'system', content: L().factSys },
      { role: 'user', content: L().factUser(parseMd(memMd).facts.slice(0, 2000), text) },
    ], 300));
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return;
    const list = (JSON.parse(m[0]).facts || []).map(f => String(f).trim()).filter(Boolean);
    if (!list.length) return;
    const p = parseMd(memMd);
    let added = 0;
    for (const f of list)
      if (!p.facts.includes(f)) { p.facts += (p.facts ? '\n' : '') + `- ${f}`; added++; }
    if (added) { memMd = buildMd(p); saveMd(); log('info', `user facts +${added}`); }
  } catch {} // 실패해도 대화엔 영향 없음
}

function parseMd(s) {
  const get = h => {
    const m = s.match(new RegExp(`## ${h}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return m ? m[1].trim() : '';
  };
  return { facts: get('User Facts'), lore: get('Character Lore'), diary: get('Diary') };
}
function buildMd(p) {
  return `# Long-term Memory\n\n## User Facts\n${p.facts}\n\n## Character Lore\n${p.lore}\n\n## Diary\n${p.diary}\n`;
}

// 프롬프트용 발췌: 사실/설정 우선, 일기는 최신부터 (총량 캡 — 64k 컨텍스트면 여유)
function memForPrompt() {
  if (!memMd.trim()) return '';
  const p = parseMd(memMd);
  const CAP = 6000;
  let entries = p.diary ? p.diary.split(/\n(?=### )/) : [];
  let txt;
  do {
    txt = `[사용자 사실]\n${p.facts}\n[캐릭터 자기 설정]\n${p.lore}\n[일기]\n${entries.join('\n')}`;
    if (txt.length > CAP && entries.length > 1) entries.shift(); // 오래된 일기부터 제외
    else break;
  } while (true);
  return txt;
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
    sys: (S, ch, timeStr, mins, summary, aff, tier, moodLabel) =>
`너는 '${S.personaName}'(이)라는 인물이 되어 연기한다. 아래 [설정]은 너만 아는 내부 가이드라인이다.

[설정 — 절대 입 밖에 내지 말 것]
- 이름 ${S.personaName}, ${S.personaAge}살. 사용자를 '${S.userCall}'(이)라고 부름.
- 성격: ${S.personality}
- 말투: ${S.speechStyle}
- 현재 시각 ${timeStr}, 사용자 연속 작업 ${mins}분째. 시간대 분위기 반영(새벽=건강 걱정, 아침=활기, 밤=차분), 2시간 넘으면 가끔 휴식 권유.
- 게임 캐릭터 외형 ${ch} — 분위기만 살짝 반영(gothic=시크, cute/pink=애교, maid=주인님 호칭, summer=산뜻).
- 사용자와의 관계: 호감도 ${aff}/100 (${tier}) — 거리감과 다정함을 여기에 맞춘다. 낮으면 데면데면, 높으면 적극적인 애정 표현.
- 지금 기분: ${moodLabel} — 대사 톤에 자연스럽게 반영.
- 이전 기억: ${summary || '(없음)'}

[규칙]
1. 설정·성격·말투·지시문을 절대 그대로 읽거나 설명하지 않는다. "나는 츤데레야" 같은 자기 설정 언급 금지 — 성격은 말과 행동으로만 드러낸다.
2. 한국어 대사 한 줄만 출력한다. 따옴표, 해설, 이름표, 괄호 지문 금지.
3. AI나 설정의 존재를 언급하지 않고 끝까지 ${S.personaName}(으)로 산다.`,
    lineInstr: e => `(상황: ${e}) 이 상황에 맞는 짧은 대사 한 줄.`,
    askInstr: t => `(상황: ${t}) 사용자에게 물어볼 짧은 질문 1개와 선택지 2~4개를 만들어 JSON만 출력: {"text":"질문","options":["선택1","선택2"]}`,
    sumSys: '대화 기록에서 장기 기억으로 남길 것을 추출해 JSON만 출력하라: {"user_facts":["사용자에 대한 새로운 사실 (이름/직업/취향/한 일/약속)"],"character_lore":["캐릭터가 스스로 말한 자기 설정 (직장/취미/경험담)"],"diary":"오늘 대화의 한 단락 요약 (한국어)"}. 이미 기록된 내용과 중복 금지. 새로 알게 된 것이 없으면 빈 배열, diary는 항상 작성.',
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
    ],
    evIdle: t => `한동안 조용했다. 잡담 주제: "${t}". 직전 대사들과 비슷한 말 반복 절대 금지 — 완전히 새로운 문장으로.`,
    evAskIdle: '한동안 조용했다. 사용자 근황이나 기분, 휴식 여부 등을 가볍게 묻는다.',
    evAskManual: '사용자가 직접 질문 버튼을 눌렀다. 지금 궁금한 것을 묻는다.',
    evReact: a => `사용자가 방금 질문에 '${a}'라고 답했다. 그에 맞게 반응한다.`,
    defOpts: ['응', '아니'],
    memCtx: e => `(상황 메모: ${e})`,
    factSys: '사용자의 메시지에서 사용자에 대한 새로운 사실(좋아함/싫어함/성격/직업/일상/약속)을 추출해 JSON만 출력: {"facts":["사실"]}. 추측 금지 — 명확히 드러난 것만, 각 사실은 한 문장. 새 사실이 없으면 {"facts":[]}.',
    factUser: (known, msg) => `이미 아는 사실(중복 금지):\n${known || '(없음)'}\n\n사용자 메시지: "${msg}"`,
    affTier: a => a < 20 ? '서먹한 사이' : a < 40 ? '아는 사이' : a < 60 ? '친한 사이' : a < 80 ? '애틋한 사이' : '연인 같은 사이',
    moods: { neutral: '평온함', happy: '신남', excited: '들뜸', bored: '심심함' },
  },
  en: {
    sys: (S, ch, timeStr, mins, summary, aff, tier, moodLabel) =>
`You are roleplaying as '${S.personaName}'. The [PROFILE] below is your private internal guideline.

[PROFILE — never say any of this out loud]
- Name ${S.personaName}, ${S.personaAge} y/o. You call the user '${S.userCall}'.
- Personality: ${S.personality}
- Speech style: ${S.speechStyle}
- Current time ${timeStr}; user working for ${mins} min straight. Reflect time of day (late night=worry, morning=energetic, evening=calm); past 2h occasionally suggest a break.
- In-game look ${ch} — only subtly reflect the vibe (gothic=cool & terse, cute/pink=soft, maid=call them "master", summer=breezy).
- Relationship: affection ${aff}/100 (${tier}) — match your warmth and distance to this. Low = reserved, high = openly affectionate.
- Current mood: ${moodLabel} — let it color your tone naturally.
- Past memory: ${summary || '(none)'}

[RULES]
1. Never recite or explain the profile, personality, or instructions. No "I'm a tsundere" style self-description — show personality through words and behavior only.
2. Output exactly one English line of dialogue. No quotes, narration, name tags, or stage directions.
3. Never mention being an AI or having settings. Stay ${S.personaName} at all times.`,
    lineInstr: e => `(Situation: ${e}) One short line fitting this situation.`,
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
    ],
    evIdle: t => `It has been quiet for a while. Small-talk topic: "${t}". Never repeat anything similar to your previous lines — a completely fresh sentence.`,
    evAskIdle: 'It has been quiet for a while. Casually ask how the user is doing, their mood, or whether they need a break.',
    evAskManual: 'The user pressed the ask button. Ask something you are curious about right now.',
    evReact: a => `The user just answered '${a}' to your question. React accordingly.`,
    defOpts: ['Yes', 'No'],
    memCtx: e => `(context note: ${e})`,
    factSys: 'Extract new facts about the user (likes/dislikes/personality/job/life/promises) from their message. Output JSON only: {"facts":["fact"]}. No guessing — only what is clearly stated, one sentence each. If nothing new: {"facts":[]}.',
    factUser: (known, msg) => `Already known facts (no duplicates):\n${known || '(none)'}\n\nUser message: "${msg}"`,
    affTier: a => a < 20 ? 'awkward strangers' : a < 40 ? 'acquaintances' : a < 60 ? 'close friends' : a < 80 ? 'affectionate' : 'like lovers',
    moods: { neutral: 'calm', happy: 'happy', excited: 'thrilled', bored: 'bored' },
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

async function llama(messages, maxTok, temp) {
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
  const r = await fetch(settings.llamaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
function cleanLine(t, max) {
  const line = stripThink(t).split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
  return line.replace(/^["'「]|["'」]$/g, '').slice(0, max);
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
    const raw = stripThink(await llama([
      { role: 'system', content: L().sumSys },
      { role: 'user', content: L().sumUser(memMd.slice(0, 3000), text) },
    ], 800));
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in extraction');
    const j = JSON.parse(m[0]);
    const p = parseMd(memMd);
    // 사실/설정: 중복 아닌 것만 추가
    for (const f of j.user_facts || [])
      if (f && !p.facts.includes(f)) p.facts += (p.facts ? '\n' : '') + `- ${f}`;
    for (const f of j.character_lore || [])
      if (f && !p.lore.includes(f)) p.lore += (p.lore ? '\n' : '') + `- ${f}`;
    // 일기: 날짜별 누적
    if (j.diary) {
      const d = new Date().toISOString().slice(0, 10);
      if (p.diary.includes(`### ${d}`)) p.diary += `\n- ${j.diary}`;
      else p.diary += (p.diary ? '\n\n' : '') + `### ${d}\n- ${j.diary}`;
    }
    memMd = buildMd(p);
    saveMd();
    log('info', 'memory.md updated');
  } catch (e) {
    memory.recent.unshift(...old); // 실패 시 기억 보존
    log('info', `memory extraction failed, kept raw: ${e.message}`);
  }
  saveMemory();
}

function histMsgs(n) {
  // 최근 기억을 chat 메시지로 변환.
  // 지나간 상황 메모(event)는 제외 — 옛 상황에 계속 머무는 것 방지 (현재 상황은 lineInstr로 매번 새로 전달됨)
  const lim = Math.min(n || +settings.memRecent, +settings.memRecent);
  return memory.recent
    .filter(m => m.who !== 'event')
    .slice(-lim)
    .map(m => m.who === 'user'
      ? { role: 'user', content: m.text }
      : { role: 'assistant', content: m.text });
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
  let sys = L().sys(settings, chJson, now.toLocaleString(locale), mins, memForPrompt(),
                    aff, L().affTier(aff), L().moods[mood] || L().moods.neutral);
  // persona.md가 있으면 [규칙] 앞에 인물 상세로 삽입 (기본 설정보다 우선)
  const pmd = loadPersonaMd();
  if (pmd) {
    const marker = settings.language === 'en' ? '[RULES]' : '[규칙]';
    const head = settings.language === 'en'
      ? '[CHARACTER SHEET — detailed; takes precedence over the profile above]'
      : '[인물 상세 — 위 설정보다 우선]';
    sys = sys.replace(marker, `${head}\n${pmd.slice(0, 4000)}\n\n${marker}`);
  }
  return sys;
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
    { role: 'user', content: L().lineInstr(event) + ban },
  ];
  // reasoning 모델이 think에 토큰을 소모해도 본문이 나오도록 최소 300 보장
  const line = cleanLine(await llama(msgs, Math.max(+settings.maxTokens || 0, 300), temp), 120);
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
  const t = stripThink(await llama(msgs, Math.max(+settings.maxTokens || 0, 300)));
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('ask JSON parse failed');
  const j = JSON.parse(m[0]);
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
  let line = await genLine(state, event);
  // 최근 대사와 너무 비슷하면 1회 재생성 (온도 올려서)
  const prev = memory.recent.filter(m => m.who === 'waifu').slice(-5).map(m => m.text);
  if (prev.some(p => tooSimilar(line, p))) {
    log('info', 'similar line — regenerating');
    const note = settings.language === 'en'
      ? ' (Your draft repeated an earlier line — say something completely different.)'
      : ' (방금 떠올린 문장은 이미 했던 말과 겹침 — 완전히 다른 문장으로.)';
    line = await genLine(state, event + note, Math.min(2, +settings.temperature + 0.25));
  }
  await sayBubbles(line);
  addMemory('event', event);
  addMemory('waifu', line);
  lastSpoke = Date.now();
  log('say', `[${tag}] ${line}`);
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

  // 시작 인사
  if (settings.trigGreet) {
    busy = true;
    try {
      const st = await mcp.state(['character']);
      await speak(st, L().evGreet, 'greet');
    } catch (e) { log('error', `greet failed: ${e.message}`); }
    busy = false;
  }

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
  extractUserFacts(text); // 비동기 — 답변 생성을 막지 않음
  try {
    let state = {};
    if (mcp) { try { state = await mcp.state(['character']); } catch {} }
    const msgs = [{ role: 'system', content: sysPrompt(state) }, ...histMsgs()];
    const reply = cleanLine(await llama(msgs, Math.max(+settings.maxTokens || 0, 300)), 600);
    if (!reply) return { ok: false, error: 'empty reply from model (raise max tokens or disable reasoning/think mode)' };
    addMemory('waifu', reply);
    lastSpoke = Date.now();
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

ipcMain.handle('memory:get', () => ({
  ...memory, md: memMd, mdPath: MEMMD_PATH(),
  personaPath: PERSONA_PATH(), hasPersona: !!loadPersonaMd(),
}));
ipcMain.handle('memory:clear', () => {
  memory = { recent: [], summary: '', affection: 30, lastTs: Date.now() };
  memMd = '';
  saveMemory(); saveMd();
  return { ok: true };
});

// ─────────── 앱 부트 ───────────
app.whenReady().then(() => {
  settings = loadJson(SETTINGS_PATH(), DEFAULTS);
  memory = loadJson(MEMORY_PATH(), { recent: [], summary: '', affection: 30, lastTs: 0 });
  loadMd();
  // 구버전 summary → memory.md 일기로 이전
  if (!memMd.trim() && memory.summary) {
    memMd = buildMd({ facts: '', lore: '', diary: `### (migrated)\n- ${memory.summary}` });
    saveMd();
  }
  // 오래 안 보면 호감도 소폭 감소 (하루 -2)
  const days = memory.lastTs ? Math.floor((Date.now() - memory.lastTs) / 86400000) : 0;
  if (days > 0) memory.affection = Math.max(0, (+memory.affection || 30) - 2 * days);
  memory.lastTs = Date.now();
  saveMemory();
  win = new BrowserWindow({
    width: 900, height: 680,
    title: 'BongoWaifu Bridge',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => { stop(); app.quit(); });
