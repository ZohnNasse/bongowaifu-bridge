// 캐릭터 장기 기억을 태그·주체·가중치 항목으로 저장하고 관련 항목만 선택 주입하는 엔진
const fs = require('fs');

const TYPES = ['user_fact', 'char_lore', 'episode', 'feeling', 'relationship'];

let items = [];
let filePath = '';
let seq = 0;

function load(p) {
  filePath = p;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    items = Array.isArray(j.items) ? j.items : [];
    seq = +j.seq || items.length;
  } catch { items = []; seq = 0; }
}
function save() {
  try { fs.writeFileSync(filePath, JSON.stringify({ seq, items }, null, 2)); } catch {}
}

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');

// 항목 추가 (중복이면 무시). it = {type, subject, text, tags, weight, date}
function addItem(it) {
  const text = String(it && it.text || '').trim();
  if (!text) return false;
  if (items.some(x => x.type === it.type && norm(x.text) === norm(text))) return false;
  items.push({
    id: 'm_' + (++seq),
    type: TYPES.includes(it.type) ? it.type : 'user_fact',
    subject: it.subject || (it.type === 'user_fact' ? 'user' : 'self'),
    text,
    tags: Array.isArray(it.tags) ? it.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 6) : [],
    weight: Math.max(1, Math.min(5, +it.weight || 3)),
    date: it.date || new Date().toISOString().slice(0, 10),
    lastUsed: null,
  });
  return true;
}
function addItems(arr) {
  let n = 0;
  for (const it of arr || []) if (addItem(it)) n++;
  if (n) save();
  return n;
}

// 평문 memory.md → 항목 마이그레이션 (items 비어있을 때만 1회, 구버전 호환)
function migrateFromMd(md) {
  if (!md || !md.trim() || items.length) return 0;
  const sec = h => {
    const m = md.match(new RegExp(`## ${h}\\n([\\s\\S]*?)(?=\\n## |$)`));
    return m ? m[1] : '';
  };
  const bullets = t => t.split('\n').map(l => l.replace(/^[-*]\s*/, '').trim())
    .filter(b => b && !b.startsWith('### '));
  const map = [
    ['User Facts', 'user_fact', 'user'],
    ['Relationships', 'relationship', 'relationship'],
    ['Character Lore', 'char_lore', 'self'],
    ['Episodes', 'episode', 'self'],
    ['Feelings', 'feeling', 'self'],
  ];
  let n = 0;
  for (const [h, type, subj] of map)
    for (const b of bullets(sec(h)))
      if (addItem({ type, subject: subj, text: b, weight: type === 'relationship' ? 4 : 3 })) n++;
  if (n) save();
  return n;
}

// 타입별 항목 / 텍스트 (main이 "아는 사실·관계"를 엔진에서 가져오게)
function byType(type) { return items.filter(i => i.type === type); }
function textsByType(type) { return byType(type).map(i => i.text).join('\n'); }

// 현재 대화 텍스트와 관련된 항목을 점수순으로 골라 subject 접두사로 렌더
// opts = { budget, subjectLabel(subject)->string }
function selectForPrompt(queryText, opts = {}) {
  const budget = opts.budget || 2400;
  const label = opts.subjectLabel || (s => s);
  const q = norm(queryText);
  const today = Date.now();

  const scored = items.map(it => {
    let s = it.weight;
    const days = (today - new Date(it.date).getTime()) / 86400000;
    if (days <= 7) s += 1; else if (days <= 30) s += 0.5;        // 최근성
    if (it.type === 'relationship') s += 2;                       // 가족·친구는 우대
    let rel = 0;                                                  // 관련성: 태그/본문이 현재 화제에 등장
    for (const tag of it.tags) if (tag && q.includes(norm(tag))) rel += 2;
    if (q && overlap2(q, norm(it.text))) rel += 1;
    s += rel;
    return { it, s };
  }).sort((a, b) => b.s - a.s);

  const lines = [];
  let used = 0;
  for (const { it } of scored) {
    // 관계 항목은 본문에 이름이 있어 접두사 생략, 나머지는 주체를 명시 (주체 혼동 방지)
    const line = it.type === 'relationship' ? `- ${it.text}` : `- (${label(it.subject)}) ${it.text}`;
    if (used + line.length + 1 > budget) continue;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

// 간단 2-gram 겹침 (본문 일부가 현재 대화에 등장하는지)
function overlap2(a, b) {
  if (!a || !b) return false;
  if (b.length < 2) return a.includes(b);
  for (let i = 0; i < b.length - 1; i++) if (a.includes(b.slice(i, i + 2))) return true;
  return false;
}

function getItems() { return items; }
function clear() { items = []; seq = 0; save(); }

module.exports = { load, save, addItem, addItems, migrateFromMd, selectForPrompt, getItems, clear, byType, textsByType };
