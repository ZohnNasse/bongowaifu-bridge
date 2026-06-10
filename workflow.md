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
