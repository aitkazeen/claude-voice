# voice-wake: specification

[Русская версия](SPEC.ru.md)

Voice input for Claude Code Desktop: "Claude, over" → message → "over", and the text
goes to Claude as the user's prompt. Claude's reply starts with a `🔊 …` line that a
voice reads. Fully offline, on Windows. Phrases in English or Russian (`"lang"`).

Source: https://github.com/aitkazeen/claude-voice (MIT). This spec is for another
project that wants to (A) use voice input in its Claude sessions or (B) reuse the
listener, or techniques from it, in its own code.

---

## 1. What it does

Phrases for `"lang": "en"`; the Russian ones are in [README.ru.md](../README.ru.md).

| Say | Result |
| --- | --- |
| "Claude, over" … "text, over" | the text (with whatever was in the box) is **sent** to Claude |
| "Claude, text" … "text, over" | the text is only **inserted** into the prompt box |
| "Claude, stop" | stops Claude's turn (like Esc), cuts speech off, drops a recording in progress |
| "Claude, session three" / "Claude, switch to session three" | voice now goes to session 3 (1–9) |
| "Claude, which session" | says aloud where voice goes |
| "Claude, repeat" | repeats the last spoken line |
| "Claude, clear" | empties the prompt box |
| … "cancel" (during a recording) | the recording is dropped |

Pauses inside a message are fine: the recording ends only on "over" (or the Done
button, or after 5 min, when the text is only inserted). Voice prompts are sent with a
`🎙` prefix; for those Claude starts its reply with `🔊 <one English sentence, up to 50
words>`, read by Kokoro (`bf_emma`).

---

## 2. Architecture

```
 mic
  │
 listener/listen.py  (Python, one per machine; holds port 127.0.0.1:47821 as a lock)
  │  Vosk: waits for a phrase (a grammar of ~25 phrases) ─► recording ─► Vosk marks pauses
  │  at every pause faster-whisper reads the tail: ends with "over"? ─► end
  │  faster-whisper (GPU/CPU) transcribes it all ─► clean() ─► one stdout JSON line
  │  follow_desktop thread: reads Claude Desktop's log ─► which session is on screen
  │  Kokoro TTS: reads the file listener/say
  ▼ stdout (JSON lines)                     ▲ files cmd / say
 mod/hooks/register.tsx  (a Claude Code mod; loaded in EVERY Desktop session)
  │  the session whose listener holds the mic gets the lines and routes them:
  │  ├─ target = this session ─► $.prompt.submit / $.prompt.fill
  │  └─ target = another      ─► listener/sessions/<id>.inbox ─► that session takes it
  ▼
 Claude (prompt "🎙 …" as from the user) ─► reply "🔊 …" ─► listener/say ─► voice
```

Two processes, linked only by the listener's stdout and files in `listener/`. The mod
spawns the listener as a child process (`$.process.spawn`) in every session; only the
first one wins (the port lock), the others get `busy` and retry every 30 s.

---

## 3. The listener (`listener/listen.py`)

### Pipeline
1. **Waiting for a phrase.** Vosk (`vosk-model-small-en-us-0.15` or
   `vosk-model-small-ru-0.22`, per `"lang"`) with a grammar of only the wake and
   command phrases (+`[unk]`): cheap, few false triggers. "Claude, stop" fires on 3
   identical partial results in a row, without a pause; everything else on a final
   result (after a pause). `preroll_sec` (1 s) of audio before the trigger goes into
   the recording.
2. **Recording until "over".** A second Vosk recognizer (free decoding) only marks
   pauses, with no loudness threshold. At every pause whisper transcribes the speech
   since the previous pause (+0.3 s overlap) and checks whether it ends with `end_word`
   or `cancel_word`. Vosk's own guess of the end word is not trusted: with a one-phrase
   grammar it hears it everywhere.
3. **Transcription.** faster-whisper `small`: `beam_size=5`, `vad_filter=True`,
   `condition_on_previous_text=False`, `initial_prompt` a list of frequent terms (it
   does **not** contain the end word: on silence whisper sometimes echoes the prompt,
   and an echoed end word would send). On NVIDIA `cuda/float16` (DLLs from the pip
   packages `nvidia-cublas-cu12`, `nvidia-cudnn-cu12`, added with
   `os.add_dll_directory`), else `cpu/int8`. The GPU is checked by transcribing 1 s of
   silence: a missing DLL only shows on the first transcription.
4. **Cleanup (`clean`).** Strips "Claude" and its misspellings at the start, the end
   word at the start and at the end, `submit_word` at the end. `word_re` takes "е" for
   "ё" and for "и" (whisper writes «прием», «преем»). The first letter is capitalized.
5. **Output.** A JSON line on stdout, a beep, a Windows toast.

### stdout protocol (one JSON line = one event)
| Line | Means |
| --- | --- |
| `{"status": "ready"}` | listening for a phrase; the mod writes itself into `sessions/owner` |
| `{"status": "recording"}` / `"transcribing"` / `"speaking"` | phase, for the UI |
| `{"status": "busy"}` | another process has the mic; the listener exits with code 3 |
| `{"text": "…", "submit": true\|false}` | a transcribed message |
| `{"stop": true}` | "Claude, stop" |
| `{"cmd": "which"}`, `{"cmd": "session", "n": 3}`, `{"cmd": "clear"}` | voice commands |

Logs go to stderr and `listener/listen.log` (rewritten on start).

### Channel files from the mod to the listener
- `listener/cmd`: `dictate` (start recording without a phrase) or `stop` (end the
  recording / hush). The listener reads and deletes it.
- `listener/say`: text to speak (read and deleted); `listener/said`: the same, for the
  UI to show.

### Process life
- Lock: `bind(127.0.0.1:47821)` without `listen`; the OS frees it when the process dies.
- `exit_with_parent`: exits when the parent **or the grandparent** dies (on Windows
  `venv\Scripts\python.exe` is a launcher; the real interpreter is its child).
- Modes: `--selftest` (text rules, phrase recognition, Desktop log parsing), `--wav
  file.wav`, `--levels` (mic level), `--say "text"`.

### Which session is on screen (`follow_desktop`)
The mod API doesn't tell, so a listener thread reads
`%LOCALAPPDATA%\Claude\Logs\main.log` every 0.5 s (`main1.log` too at start; on the
10 MB rotation it reads the old file's tail). Lines:
- `Mapping internal session local_<X> to CLI session <uuid>`: Desktop id ↔ CLI
  session id (the mod knows the latter from `$.session.id()`);
- `LocalSessions.setFocusedSession: sessionId=local_<X>` (`=null` is ignored).

It writes `sessions/focused` (the uuid, or `''` if the mapping is unknown) and
`sessions/desktop-ids.json` (`{uuid: "local_X"}`). When another session is brought on
screen, it clears `sessions/target`, so voice follows the screen again. The log format
is internal: if it changes, voice falls back to the mic's session.

---

## 4. The mod (`mod/hooks/register.tsx`)

A Claude Code mod (the `claude-code` API, `on(event, handler)` hooks), installed with
`/plugin install voice-wake --marketplace aitkazeen/claude-voice` or loaded from a clone
through `CLAUDE_CODE_PLUGIN_DIRS`. Key points:

- **session.start**: registers `/claude-voice`, `/claude-voice-on`, `/claude-voice-off`,
  `/claude-voice-to [n]`; finds `listener/` (next to the mod, `$VOICE_WAKE_LISTENER_DIR`,
  or the marketplace clone `%USERPROFILE%\.claude\plugins\marketplaces\claude-voice`);
  starts the listener; writes a heartbeat every 5 s and checks its inbox every 1 s.
- **Delivery to this session**: `submit` → `$.prompt.submit({ text: "🎙 " + text,
  asUser: true })` (not awaited: a prompt sent during Claude's turn is queued, and
  "Claude, stop" must not wait with it). If the engine drops the prompt (`r.drop`, e.g.
  Stop was pressed), the text goes back into the box with a toast. Without `submit` →
  `$.prompt.fill(mode: insert)`.
- **Stop**: `$.turn.abort({ turnId })` of the current turn.
- **Speech**: a `prompt.compose` hook adds the `SPEECH_RULE` to the system prompt
  (always, so the prompt cache holds); `turn.complete` takes the reply's last `🔊 …`
  line, strips markdown and writes it to `listener/say`.
- **UI**: a band above the prompt (`AbovePrompt`): phase, recording timer, where voice
  goes, buttons (Dictate / Done / Hush / Turn on / Turn off / Voice here); a Sessions
  pane (`Pane`) with the list and hotkeys 1–9; the status line. Labels are in Russian
  for now.
- On/off lives in `$.store` (shared by every session).

### Routing between sessions
The registry is files in `listener/sessions/` (mods have no API to list sessions, and
`session.send` would arrive as a peer's message, not as the user's prompt):

| File | Written by | Contents |
| --- | --- | --- |
| `<id>.json` | every session, every 5 s | `{id, folder, project, branch, label, seen, since, closed?}` |
| `owner` | the session whose listener holds the mic | its id |
| `target` | the pane / "Claude, session n" / `/claude-voice-to n` | an id, or empty |
| `focused`, `desktop-ids.json` | the listener (see above) | the session on screen; Desktop ids |
| `<id>.inbox` | the mic's session | `{seq, text, submit, …}`: the last message |
| `<id>.ack` | the receiver | the `seq` it took |

- A live session: heartbeat younger than 20 s, not `closed`.
- **Voice target** = `target` (if live) → else `focused` (if live) → else `owner`.
- **Inbox/ack**: the sender writes the inbox (`seq` = time) and checks the ack after
  4 s; no ack → it delivers locally with a warning (voice is never lost). The receiver
  takes a message only if it is younger than 4 s (else the sender has delivered it) and
  never what was waiting before it started. The last taken `seq` is kept in the mod's
  memory (`$.state` is unreliable for this).
- **Session list**: named `project · branch` (project: the repository root, for a
  worktree the main checkout's; branch: from `.git/HEAD`, for a worktree through the
  `.git` file → `gitdir:`), without a `claude/` prefix; equal names get the start of
  the id. Order: this session is #1, the others by when they appeared (new ones go
  last, numbers don't jump).
- **Choosing a session** writes `target` (empty if the default session is chosen) and
  opens it in Desktop: `cmd /c start "" claude://claude.ai/epitaxy/local_<X>`.

---

## 5. Using it in another project (option A)

The mod is global, not tied to a project: installed once, it works in every Claude
Desktop session, in any folder.

1. In Claude Code: `/plugin install voice-wake --marketplace aitkazeen/claude-voice`.
2. In a terminal:
   `python %USERPROFILE%\.claude\plugins\marketplaces\claude-voice\listener\install.py --lang en`
   (venv, models ~1.2 GB; with NVIDIA also CUDA ~2 GB). Needs Windows, Python 3.10+.
   Restart Desktop.
3. Open a session in your project's folder: the 🎙 band appears above the prompt.
4. For your own vocabulary, `listener/config.json` in the marketplace clone, e.g.:
   ```json
   { "lang": "en", "whisper_prompt": "Claude. Resume, vacancy, cover letter, interview, LinkedIn." }
   ```

What Claude should know in that project: messages prefixed with `🎙` were dictated by
voice and may contain recognition errors (similar-sounding words, no punctuation); read
them by meaning. The mod itself asks for the `🔊` line through the system prompt;
nothing to do.

---

## 6. Reusing the listener in your own app (option B)

The listener doesn't depend on Claude: it is a process that writes JSON lines to stdout.
A minimal integration:

```python
import json, os, subprocess
p = subprocess.Popen([r"listener\.venv\Scripts\python.exe", "-u", r"listener\listen.py"],
                     stdout=subprocess.PIPE, text=True, encoding="utf-8",
                     env={**os.environ, "PYTHONIOENCODING": "utf-8"})
for line in p.stdout:
    ev = json.loads(line)
    if "text" in ev:
        handle_dictation(ev["text"], send=ev["submit"])   # your action
    elif ev.get("stop"):
        cancel_current_action()
```

- Speak a reply: write the text to `listener/say`.
- Start recording with a button: write `dictate` to `listener/cmd`; end it with `stop`.
- Phrases (wake, end word, commands), the language (`"lang"`: `en` / `ru`; whisper's
  `"language"`: `ru` / `en` / `auto`) are all in `config.json` (the key table is in the
  README). Every phrase word must be in the Vosk vocabulary.
- One process per machine (the port lock); a second one gets `busy` and exits.

Techniques worth reusing even without the listener:
- end a phrase on a marker word at a pause, checked by the big model, not on silence:
  you can think aloud with pauses;
- a small model with a narrow grammar for the wake phrase, a big one for the text;
- keep control words out of whisper's prompt (echo on silence);
- accept spelling variants (`ё/е`, `и/е`) when comparing words;
- for delivery between processes, an acknowledgement and a fallback path, or messages
  get lost silently.

---

## 7. Limitations

- Windows only (`winsound`, toast notifications, `kernel32`, `%LOCALAPPDATA%` paths).
- The listener lives while Claude Desktop is open with at least one session with the mod.
- Latency: ~0.5 s of pause after "over" + transcription (on a GPU ~0.4 s for 8 s of
  speech, on a CPU ~1.7 s; the first model load on a GPU takes up to 40 s, later ~8 s).
- "Over" with a pause mid-message ends it; a message that starts with "over" loses that
  word.
- Reading Desktop's log relies on an undocumented format; if it changes, "the session on
  screen" turns itself off (the mic's session remains).
- About 1 GB of RAM (and ~1 GB of VRAM on a GPU) while the listener runs.
- Privacy: everything is offline; the transcribed text goes into `listener/listen.log`,
  the first 60 characters of a session's last prompt into `listener/sessions/*.json`.
  The channel files (`*.inbox`, `cmd`, `say`) are open to any program of the user.

## 8. Checks

- `claude plugin test mod`: the mod's tests (routing, inbox/ack, UI, commands).
- `listener\.venv\Scripts\python listener\listen.py --selftest`: text rules, phrase
  recognition (both languages), Desktop log parsing, rotation.
- `listener\.venv\Scripts\python listener\listen.py --wav file.wav`: the whole pipeline
  on a recording; it prints the same lines as the mic run, commands included.
