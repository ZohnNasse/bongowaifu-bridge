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
let seenAchv = new Set();
let lastSpoke = 0;
let sessionStart = 0;

// ─────────── 설정/메모리 영속화 ───────────
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'settings.json');
const MEMORY_PATH   = () => path.join(app.getPath('userData'), 'memory.json');

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
};

let settings = { ...DEFAULTS };
let memory = { recent: [], summary: '' };
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
    sys: (S, ch, timeStr, mins, summary) =>
`너는 '${S.personaName}'(이)라는 인물이 되어 연기한다. 아래 [설정]은 너만 아는 내부 가이드라인이다.

[설정 — 절대 입 밖에 내지 말 것]
- 이름 ${S.personaName}, ${S.personaAge}살. 사용자를 '${S.userCall}'(이)라고 부름.
- 성격: ${S.personality}
- 말투: ${S.speechStyle}
- 현재 시각 ${timeStr}, 사용자 연속 작업 ${mins}분째. 시간대 분위기 반영(새벽=건강 걱정, 아침=활기, 밤=차분), 2시간 넘으면 가끔 휴식 권유.
- 게임 캐릭터 외형 ${ch} — 분위기만 살짝 반영(gothic=시크, cute/pink=애교, maid=주인님 호칭, summer=산뜻).
- 이전 기억: ${summary || '(없음)'}

[규칙]
1. 설정·성격·말투·지시문을 절대 그대로 읽거나 설명하지 않는다. "나는 츤데레야" 같은 자기 설정 언급 금지 — 성격은 말과 행동으로만 드러낸다.
2. 한국어 대사 한 줄만 출력한다. 따옴표, 해설, 이름표, 괄호 지문 금지.
3. AI나 설정의 존재를 언급하지 않고 끝까지 ${S.personaName}(으)로 산다.`,
    lineInstr: e => `(상황: ${e}) 이 상황에 맞는 짧은 대사 한 줄.`,
    askInstr: t => `(상황: ${t}) 사용자에게 물어볼 짧은 질문 1개와 선택지 2~4개를 만들어 JSON만 출력: {"text":"질문","options":["선택1","선택2"]}`,
    sumSys: '다음 대화 기록을 기존 요약과 합쳐 한국어 6문장 이내로 요약하라. 사용자에 대한 사실(이름, 취향, 한 일, 약속)과 캐릭터가 스스로 말한 자기 설정(직장, 취미, 경험담 등)을 우선 보존 — 캐릭터 설정의 일관성에 필요하다. 요약문만 출력.',
    sumUser: (old, txt) => `기존 요약:\n${old || '(없음)'}\n\n새 기록:\n${txt}`,
    evGreet: '사용자가 막 자리에 앉아 브릿지를 켰다. 시간대에 맞는 인사를 건넨다.',
    evHot: l => `콤보 게이지가 레벨 ${l}로 올랐다. 신나게 반응한다.`,
    evHotMax: '콤보 게이지가 완전히 가득 찼다! 최고조 텐션으로 반응한다.',
    evAchv: n => `새 업적 '${n}' 달성. 축하하거나 장난친다.`,
    evIdle: '한동안 조용했다. 가벼운 잡담 한 마디.',
    evAskIdle: '한동안 조용했다. 사용자 근황이나 기분, 휴식 여부 등을 가볍게 묻는다.',
    evAskManual: '사용자가 직접 질문 버튼을 눌렀다. 지금 궁금한 것을 묻는다.',
    evReact: a => `사용자가 방금 질문에 '${a}'라고 답했다. 그에 맞게 반응한다.`,
    defOpts: ['응', '아니'],
    memCtx: e => `(상황 메모: ${e})`,
  },
  en: {
    sys: (S, ch, timeStr, mins, summary) =>
`You are roleplaying as '${S.personaName}'. The [PROFILE] below is your private internal guideline.

[PROFILE — never say any of this out loud]
- Name ${S.personaName}, ${S.personaAge} y/o. You call the user '${S.userCall}'.
- Personality: ${S.personality}
- Speech style: ${S.speechStyle}
- Current time ${timeStr}; user working for ${mins} min straight. Reflect time of day (late night=worry, morning=energetic, evening=calm); past 2h occasionally suggest a break.
- In-game look ${ch} — only subtly reflect the vibe (gothic=cool & terse, cute/pink=soft, maid=call them "master", summer=breezy).
- Past memory: ${summary || '(none)'}

[RULES]
1. Never recite or explain the profile, personality, or instructions. No "I'm a tsundere" style self-description — show personality through words and behavior only.
2. Output exactly one English line of dialogue. No quotes, narration, name tags, or stage directions.
3. Never mention being an AI or having settings. Stay ${S.personaName} at all times.`,
    lineInstr: e => `(Situation: ${e}) One short line fitting this situation.`,
    askInstr: t => `(Situation: ${t}) Create 1 short question for the user with 2-4 button options. Output JSON only: {"text":"question","options":["opt1","opt2"]}`,
    sumSys: 'Merge the following conversation log into the existing summary, max 6 English sentences. Prioritize facts about the user (name, preferences, things done, promises) AND facts the character stated about herself (job, hobbies, anecdotes) — needed for character consistency. Output the summary only.',
    sumUser: (old, txt) => `Existing summary:\n${old || '(none)'}\n\nNew log:\n${txt}`,
    evGreet: 'The user just sat down and started the bridge. Greet them appropriately for the time of day.',
    evHot: l => `The combo gauge just rose to level ${l}. React excitedly.`,
    evHotMax: 'The combo gauge is completely maxed out! React at peak excitement.',
    evAchv: n => `New achievement '${n}' unlocked. Congratulate or tease.`,
    evIdle: 'It has been quiet for a while. Drop a light bit of small talk.',
    evAskIdle: 'It has been quiet for a while. Casually ask how the user is doing, their mood, or whether they need a break.',
    evAskManual: 'The user pressed the ask button. Ask something you are curious about right now.',
    evReact: a => `The user just answered '${a}' to your question. React accordingly.`,
    defOpts: ['Yes', 'No'],
    memCtx: e => `(context note: ${e})`,
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

async function llama(messages, maxTok) {
  const body = {
    model: settings.llamaModel,
    temperature: +settings.temperature,
    max_tokens: Math.max(maxTok || 0, +settings.maxTokens || 0, TOK_FLOOR),
    messages,
    stream: false,
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
    memory.summary = stripThink(await llama([
      { role: 'system', content: L().sumSys },
      { role: 'user', content: L().sumUser(memory.summary, text) },
    ], 500));
    log('info', 'memory summarized');
  } catch {
    memory.recent.unshift(...old); // 실패 시 되돌림
  }
  saveMemory();
}

function histMsgs() {
  // 최근 기억을 chat 메시지로 변환 (event는 상황 메모로)
  return memory.recent.slice(-settings.memRecent).map(m => {
    if (m.who === 'user')  return { role: 'user', content: m.text };
    if (m.who === 'waifu') return { role: 'assistant', content: m.text };
    return { role: 'user', content: L().memCtx(m.text) };
  });
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
  return L().sys(settings, chJson, now.toLocaleString(locale), mins, memory.summary);
}

async function genLine(state, event) {
  const msgs = [
    { role: 'system', content: sysPrompt(state) },
    ...histMsgs(),
    { role: 'user', content: L().lineInstr(event) },
  ];
  // reasoning 모델이 think에 토큰을 소모해도 본문이 나오도록 최소 300 보장
  const line = cleanLine(await llama(msgs, Math.max(+settings.maxTokens || 0, 300)), 120);
  if (!line) throw new Error('empty reply from model (raise max tokens or disable reasoning/think mode)');
  return line;
}

async function genAsk(state, topic) {
  const msgs = [
    { role: 'system', content: sysPrompt(state) },
    ...histMsgs(),
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
async function speak(state, event, tag) {
  const line = await genLine(state, event);
  await mcp.say(line);
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
      return speak(state, L().evIdle, 'idle');     // 실패 시 일반 잡담으로 대체
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
  addMemory('user', `(button) ${answer}`);
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
      await speak(state, L().evHotMax, 'hotmax');
    } else if (settings.trigHot && hot > lastHotLevel && !hotFull) {
      await speak(state, L().evHot(hot), `hot${hot}`);
    }
    if (hotVal < 75) hotFull = false;                    // 75 미만으로 떨어지면 재무장
    lastHotLevel = hot;

    // 신규 업적
    if (settings.trigAchv) {
      for (const a of state?.achievements || []) {
        if (a.unlocked && !seenAchv.has(a.api_name)) {
          seenAchv.add(a.api_name);
          await speak(state, L().evAchv(a.display_name || a.api_name), 'achv');
        }
      }
    }

    // idle 잡담 / 질문
    if (settings.trigIdle && Date.now() - lastSpoke > settings.idleSec * 1000) {
      if (settings.trigAsk && Math.random() < +settings.askChance) {
        await doAsk(state, L().evAskIdle);
        lastSpoke = Date.now();
      } else {
        await speak(state, L().evIdle, 'idle');
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
  addMemory('user', text);
  try {
    let state = {};
    if (mcp) { try { state = await mcp.state(['character']); } catch {} }
    const msgs = [{ role: 'system', content: sysPrompt(state) }, ...histMsgs()];
    const reply = cleanLine(await llama(msgs, Math.max(+settings.maxTokens || 0, 300)), 200);
    if (!reply) return { ok: false, error: 'empty reply from model (raise max tokens or disable reasoning/think mode)' };
    addMemory('waifu', reply);
    lastSpoke = Date.now();
    if (mcp) { try { await mcp.say(reply); } catch {} }
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 수동 발화: 입력한 텍스트 그대로 말풍선
ipcMain.handle('say:manual', async (_, text) => {
  if (!mcp) return { ok: false, error: 'not connected' };
  try {
    await mcp.say(text);
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

ipcMain.handle('memory:get', () => memory);
ipcMain.handle('memory:clear', () => {
  memory = { recent: [], summary: '' };
  saveMemory();
  return { ok: true };
});

// ─────────── 앱 부트 ───────────
app.whenReady().then(() => {
  settings = loadJson(SETTINGS_PATH(), DEFAULTS);
  memory = loadJson(MEMORY_PATH(), { recent: [], summary: '' });
  win = new BrowserWindow({
    width: 900, height: 680,
    title: 'BongoWaifu Bridge',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => { stop(); app.quit(); });
