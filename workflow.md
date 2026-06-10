# Workflow Log

Development log for BongoWaifu Bridge. Newest entries at the bottom.

## 2026-06-10 — Initial build

**Goal**: Auto-responding companion driven by a local LLM (llama-server at `127.0.0.1:8001`), based on the BongoWaifu MCP setup docs (https://bongowaifu-workshop.pages.dev/mcp-setup/).

- Started as a single Python script (`bongowaifu_auto.py`): minimal MCP streamable-HTTP client (initialize → capture `Mcp-Session-Id` → `tools/call`), polling `get_game_state`, generating lines via the OpenAI-compatible `/v1/chat/completions` endpoint, speaking via `say`. Triggers: startup greeting, `hot_level` tier-up, new achievements, idle chatter.
- Rebuilt as an Electron app (`main.js` / `preload.js` / `index.html`):
  - Chat UI: direct conversation (replies also spoken as bubbles), speak-as-is input (Ctrl+Enter), manual `ask_and_wait` trigger button.
  - Settings UI: persona (name, age, how she calls the user, personality, speech style), connection (BongoWaifu port, llama URL, model, temperature, max tokens), per-trigger toggles + intervals + ask chance, memory size.
  - Memory: recent N lines included in the prompt as chat history; when exceeding 1.5x the limit, older lines are summarized by the local model into a long-term summary. Persisted to `settings.json` / `memory.json` in the Electron userData folder.
  - Context-aware prompts: time of day, continuous work duration (break suggestions past 2h), in-game character skin/outfit reflected in tone.

**Known unknowns**: the `ask_and_wait` argument names are not documented — implemented as `{text, options}`; if the tool call errors, adjust the `ask()` wrapper in `main.js` (try `{question, choices}` etc.).

## 2026-06-10 — Repo setup

- Added `.gitignore` (node_modules, dist, logs) and README.
- Published to GitHub as a public repo.

## 2026-06-10 — Language option (ko/en)

- Added `language` setting (`ko` | `en`) — selectable from the header dropdown; saved with settings.
- `main.js`: introduced the `STR` table holding all LLM-facing strings (system prompt, event descriptions, ask/summary instructions) in both languages; `L()` resolves by current setting. The companion now speaks the selected language.
- `index.html`: full UI i18n via `data-i18n` attributes and the `I18N` dictionary; language switch applies to the UI immediately (speech language applies after Save).
- README rewritten bilingual, English first (most players are non-Korean; intended for Steam Workshop sharing).
- Added this `workflow.md` to track work going forward.

## 2026-06-10 — Start button states

- Start/Stop button now has three visual states: stopped (pink "Start"), connecting (gray "Connecting...", disabled — prevents accidental double-click stopping the bridge), running (red "Stop"). Status text follows the same states.

## 2026-06-10 — Chat UX: typing indicator & empty-reply fix

- Chat now shows an animated "thinking…" bubble while the reply is generated; send/speak/ask buttons are locked during generation.
- Fixed empty replies: added `cleanLine()` in `main.js` — strips `<think>…</think>` blocks (reasoning models), takes the first non-empty line instead of the raw first line (which was blank when output started with a newline). Empty result now returns an explicit error suggesting to raise max tokens or disable reasoning mode.
- Fixed "ask JSON parse failed": question generation was truncated at the global max_tokens (120), cutting the JSON mid-output. `llama()` now accepts a per-call token override and ask generation guarantees at least 300 tokens; `<think>` blocks are stripped before JSON extraction.
- All generation calls now guarantee a token floor for reasoning models that spend tokens on `<think>`: lines/chat 300, summarization 500 (summary also think-stripped). The user's max tokens setting still applies when higher.
- Still-empty replies: llama.cpp separates thinking into `message.reasoning_content`, so `content` stays empty if generation is cut mid-think. Now: `chat_template_kwargs: {enable_thinking: false}` sent with every request (disables Qwen3-style thinking at the source; ignored by non-supporting models), global token floor raised to 512 inside `llama()`, and an on-screen debug log (finish_reason / content / reasoning_content size) whenever a reply comes back empty.
- Fixed `invalid_button_count` from `ask_and_wait`: the game requires 2–4 buttons but the model sometimes produced 0–1 options. Options are now trimmed, deduped, capped at 4, and padded with default Yes/No when fewer than 2 remain.
- `invalid_button_count` persisted even with 2 padded options → the argument names were guessed (`{text, options}`) and likely wrong, so the game saw 0 buttons. The bridge now reads the real `ask_and_wait` input schema from `tools/list` on connect, auto-picks the text/array parameter names (text|question|message|prompt / options|buttons|choices|answers), and logs the discovered schema to the chat window.
- Intermittent ask failures (LLM doesn't always emit valid JSON): question generation now retries once, and falls back to plain idle chatter if both attempts fail — the trigger never silently dies.

## 2026-06-10 — Settings save feedback

- Save button now shows an inline "✓ Settings saved" (green, fades out after 2.5s) right next to it — previously the confirmation only appeared in the chat tab where it wasn't visible.

## 2026-06-10 — System prompt restructure (persona leaking)

- Small local models were reciting the persona settings verbatim instead of acting them out. The system prompt (both languages) is now structured as [PROFILE] (marked "never say out loud") + [RULES] (no self-description of settings, one line of dialogue only, stay in character) so settings act as guidelines rather than content to repeat.

## 2026-06-10 — Gauge-max event & self-consistent memory

- New trigger: when the `hot` gauge (0–100) reaches ≥99, a dedicated max-excitement line fires once (re-arms after the gauge drops below 80). Tier-up lines are suppressed while maxed.
- Max event didn't fire in testing: gauge decays ~0.556/s so a momentary 100 can dip below 99 between 2s polls. Threshold lowered to 97, re-arm at <75, and a `gauge debug` log (raw gauges JSON) prints when ≥90 to verify the actual field names.
- She kept saying "bridge" after connecting — the greet event text mentioned "started the bridge", and the model echoed it (event memos also persist in memory, reinforcing it). Greet text reworded to remove meta words, with an explicit "don't mention any system/app/connection" note.

## 2026-06-10 — Affection & mood system

- **Affection** (0–100, persisted in memory.json, starts at 30): chat +1, answering a button question +2, dismissing one -1, achievement +1, gauge max +2; decays -2 per day away. Tier labels (awkward strangers → like lovers) injected into the system prompt to control warmth/distance.
- **Mood** (session-scoped: calm/happy/thrilled/bored): gauge tier-up → happy, gauge max → thrilled, achievement → happy, long silence → bored, user interaction resets to calm. Injected into the prompt to color tone.
- Affection (♥ n/100) is visible in Settings → memory view.
- Affection now also shows permanently in the header (♥ n, pink), refreshed every 10s.

## 2026-06-10 — Memory loss bug

- If the summarization model returned an empty string, the old lines had already been spliced out of recent memory and were lost forever. Empty summaries now throw, restoring the spliced lines, with an on-screen log. Memory is never destroyed by a failed summarize.

## 2026-06-10 — memory.md: Honcho-style structured long-term memory

- Long-term memory moved from a single summary string to a human-readable/editable `memory.md` (userData folder) with three sections: **User Facts** (extracted insights about the user), **Character Lore** (facts she invented about herself), **Diary** (dated one-paragraph conversation summaries).
- On overflow, the model extracts JSON `{user_facts, character_lore, diary}` from old lines; facts/lore are deduped and appended, diary accumulates by date. Extraction failure restores the raw lines — never lossy.
- Prompt injection is capped at ~6k chars: facts+lore always included, oldest diary entries dropped first (64k-context local models handle this comfortably).
- Old `memory.summary` is auto-migrated into the diary. The memory view in Settings shows the md path + full content; users can hand-edit the file.

## 2026-06-10 — persona.md character sheet

- Added `persona.md` support: a user-authored character sheet (basics, physical traits, personality-as-behavior, likes/dislikes, backstory, speech habits, example lines, never-do list) in the userData folder. When present, it's injected into the system prompt as [CHARACTER SHEET] (capped 4k chars), taking precedence over the basic settings fields; read on every line so edits apply immediately.
- `persona.md.example` template ships in the repo (bilingual annotations). Settings memory view shows the persona path and whether one is active. Distinct from memory.md's Character Lore: persona.md = authored identity, Lore = emergent self-made facts.

## 2026-06-10 — Multi-bubble speech

- Long replies are now split at sentence boundaries into multiple speech bubbles (~110 chars each), sent sequentially with reading-time delays (2s + 35ms/char). Bubble count scales with reply length (safety cap 8). Applies to chat replies (cap raised to 600 chars), manual speak, and auto lines.

## 2026-06-10 — Proactive user-fact learning

- Every user chat message and button answer now runs a background fact-extraction pass (`extractUserFacts`): the model pulls clearly-stated facts (likes/dislikes/personality/job/life/promises, no guessing) and appends deduped entries to memory.md → User Facts immediately — no longer waiting for memory overflow. Fire-and-forget, never blocks the reply; failures are silent. A "user facts +N" log appears when something is learned.

## 2026-06-10 — Idle chatter variety

- Idle lines were repetitive (same instruction every time). Now each idle event picks a random topic from a 10-item pool (time-of-day monologue, own daily life, a known user fact, current obsession, wondering about the user, silly thought, hungry/sleepy complaint, reflection on today, light teasing, season/weather) with an explicit no-repeat instruction. Also added `presence_penalty: 0.6` / `frequency_penalty: 0.3` to all generation requests.

## 2026-06-10 — TTS

- All speech (auto lines, chat replies, manual speak) can now be voiced. Settings → Voice (TTS): enable toggle, server URL, voice name, rate.
- Fallback chain: if a TTS server URL is set, the renderer POSTs `{text, voice}` and plays the returned audio (works with GPT-SoVITS-style endpoints); on failure or empty URL it falls back to the OS built-in voice (Web Speech API, voice matched by name substring then by UI language). Sequential playback queue prevents overlap.
- Summary prompt now also preserves facts the character invented about herself (job, hobbies, anecdotes), not just facts about the user — keeps her self-made lore consistent across sessions.
