# voice-wake: hands-free voice input for Claude Code Desktop

[Русская версия](README.ru.md)

Say "Claude, over", speak your message, finish with "over", and the text lands in
Claude's prompt box, like talking on a radio. It works while a browser has focus and
while Claude is minimized to the tray: the mod writes straight into the prompt through
the mod API (`$.prompt.fill` / `$.prompt.submit`), with no simulated key presses.

Recognition is fully offline. English and Russian phrases are supported (`"lang"`, see
[Settings](#settings)).

Two parts:

- `listener/listen.py`: a background Python process. Vosk (a small model with a grammar
  of a few phrases) listens to the mic for "Claude over". Then it beeps, records the
  message until the word "over" (pauses of any length are fine), transcribes it with
  faster-whisper (the `small` model), beeps again, shows a Windows notification and
  prints one stdout line: `{"text": "...", "submit": true}`.
- `mod/`: a Claude Code mod. It starts the listener when a session starts, reads its
  lines and puts the text into the prompt. It adds the `/claude-voice…` commands and a
  status-line indicator.

## Install

You need Windows, Python 3.10+ and Claude Code Desktop.

**1. The mod**, in Claude Code:

```
/plugin install voice-wake --marketplace aitkazeen/claude-voice
```

Claude clones the repository into `%USERPROFILE%\.claude\plugins\marketplaces\claude-voice`
and installs the mod from it.

**2. The listener** (models and Python packages), once, in a terminal:

```bash
python %USERPROFILE%\.claude\plugins\marketplaces\claude-voice\listener\install.py --lang en
```

Restart Claude Desktop: the band above the prompt shows "🎙 Listening".
Plugin updates (`/plugin update`) keep the installed models: they live in folders git
ignores.

From your own clone (for development): `python listener/install.py --lang en`, then
[Loading the mod from a clone](#loading-the-mod-from-a-clone).

The script creates `listener/.venv`, installs `requirements.txt` and downloads into
`listener/models/` the Vosk model for your language (`vosk-model-small-en-us-0.15` or
`vosk-model-small-ru-0.22`, ~40 MB), faster-whisper `small` (~480 MB) and the Kokoro
voice (~340 MB). Every download is checked against a pinned SHA-256. It ends with a
self-test. `--lang` is saved as `"lang"` in `listener/config.json`; run it again with
the other language to switch.

GPU. If `nvidia-smi -L` finds an NVIDIA card, the script also installs the CUDA
libraries from `requirements-cuda.txt` and whisper runs on the GPU. Everyone else (AMD,
Intel, no GPU) skips them and whisper runs on the CPU: slower, but a smaller install.

| | Size | Whisper |
| --- | --- | --- |
| NVIDIA | ~3.2 GB | GPU |
| others | ~1.2 GB | CPU |

Choose by hand with `python listener/install.py --gpu` or `--cpu`. `--cpu` only skips
CUDA; to remove an installed one, delete `listener/.venv` and run `install.py --cpu`.

Try it without Claude:

```bash
listener\.venv\Scripts\python listener\listen.py
```

Say "Claude, over" (pause), "hello, over": after the second beep you get the line
`{"text": "Hello", "submit": true}`.

### Loading the mod from a clone

Only needed if you don't use `/plugin install`. The mod is in `mod/`. To load it in
every Claude Code Desktop session, add to `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\path\\to\\claude-voice\\mod" } }
```

and restart Claude Desktop. If `CLAUDE_CODE_PLUGIN_DIRS` is already set, append the path
after a `;`. The mod looks for the listener in `../listener` next to itself, then in the
folder named by the `VOICE_WAKE_LISTENER_DIR` environment variable (set it in the same
`env`), then in the marketplace clone
`%USERPROFILE%\.claude\plugins\marketplaces\claude-voice\listener`.

## Usage

| Say | What happens |
| --- | --- |
| "Claude, over" … "write a test for the parser, over" | the text, with whatever was already in the box, is **sent** |
| "Claude, text" … "buy milk, over" | the text is only **inserted** into the prompt box, not sent |
| "Claude, stop" | Claude **stops** at once, mid-work (like Esc); a spoken reply is cut off; during a recording the recording is dropped; no "over" needed |
| "Claude, which session" | says aloud which session voice goes to, with its number |
| "Claude, session three" or "Claude, switch to session three" | voice now goes to session 3 (numbers as in the Sessions pane, one to nine) |
| "Claude, repeat" | reads the last 🔊 reply line again |
| "Claude, clear" | empties the prompt box (in the session voice goes to) |
| … "cancel" during a recording | the recording is dropped, nothing is inserted (low beep) |

Commands without "over" fire after a short pause. "Claude, stop" fires at once, without
the pause.

After "Claude, over" pause briefly and wait for the beep. Then speak as long as you like,
with any pauses: the message stays open until you say "over". At every pause the
listener transcribes the last stretch of speech and checks whether it ends with "over".
So leave a short pause (~0.5 s) after "over".

Inside a recording, commands are just words of your message (only "Claude, stop" and
"cancel" work there), so you can dictate "Claude, session two" as text.

If the message has no "over" within 5 minutes (`max_sec`), the text is inserted, not
sent. If you say nothing for 8 s after the beep, the recording is cancelled (low beep).

For "over" to insert instead of send, set `"submit_on_end": false`. Then "…, send, over"
sends, and "Claude, over" … "send, over" sends what is already in the box.

Beeps: high, heard "Claude over"; higher, message taken; low, nothing heard.

### Spoken replies

For a voice prompt (sent with a 🎙 mark) Claude starts its reply with a line
`🔊 <one English sentence>`, spoken while you read the rest. The listener reads it with
the Kokoro voice `bf_emma` (offline, the model is in `listener/models/kokoro/`). While it
speaks, "Claude, over" is not listened for; the band's **Hush** button or
"Claude, stop" cuts it off. Voice and speed: `"voice"`, `"speed"` in `config.json`;
`"speak": false` turns speech off.

### The band above the prompt

The mod draws a band above the prompt box with the state and buttons, so you never have
to type commands. The band, toasts, the Sessions pane and the command descriptions follow
`"lang"` (English with `"lang": "en"`, and before the listener is installed).

Every state has the same frame: what the listener does, a hint, where voice goes
(`→ this session` or `→ project · branch`; click it to open the Sessions pane), the main
button, and a dim **Turn off** at the end.

| State | Band | Buttons |
| --- | --- | --- |
| listening | 🎙 **Listening** say "Claude, over" → where | **Dictate**: record at once, no wake phrase; **Turn off** |
| recording | ● **Recording 0:07** end with "over" → where | **Done**: finish and send, like "over" |
| transcribing | 🎙 **Transcribing** → where | — |
| speaking | 🔊 **Speaking** "the line being read" | **Hush** |
| loading | 🎙 **Loading models** (after a crash, "Restarting the listener") | **Turn off** |
| mic held by another session | 🎙 **The mic is with** project · branch | **Voice here**: send voice to this session; **Turn off everywhere** |
| crashed | 🎙 **The listener crashed** + the last error line | **Restart** |
| not installed | 🎙 **Install needed** + the install command | — |
| off | 🎙 Voice input off (dim) | **Turn on** |

Pressing Done with nothing said sends nothing. The buttons work while the Claude window
is open; from a browser or the tray, use your voice.

- `/claude-voice` toggles on / off; `/claude-voice-on` and `/claude-voice-off` only turn
  it on or only off (mic and speech). The setting is shared by every session.
- The status line repeats the state: `🎙 listening`, `🎙 off`, `🎙 busy` and so on.
- Listener log: `listener/listen.log` (what was heard at each pause).

### Which session voice goes to

By default, the session shown on screen in Claude Desktop. If that session has no mod
loaded (or Desktop's state can't be read), the session holding the mic. To choose
another:

- click "→ …" on the band to open the Sessions pane. This session is always first (#1),
  the others follow in the order they appeared, tagged this / on screen / 🎙 mic. The
  voice target has a ✓. A session's number is its hotkey in the pane (1–9). The chosen
  session opens in Desktop. The choice holds until you open another session on screen;
  then voice follows the screen again;
- or say "Claude, session two";
- or `/claude-voice-to` lists the sessions with numbers, `/claude-voice-to 2` picks the
  second.

Desktop doesn't let mods read session titles, so a session is named `project · branch`.
The project is the repository's name (for a worktree, the main checkout's, not the
worktree folder's); the branch comes from `.git/HEAD` without a `claude/` prefix. Two
sessions on one branch get the start of their id added. A new session goes to the end
of the list, so numbers don't jump. The choice is shared by every session. If the chosen
session closes, voice goes back to the session on screen.

Mods can't tell which session is on screen, so the listener reads Desktop's log
(`%LOCALAPPDATA%\Claude\Logs\main.log`, the `setFocusedSession` and
`Mapping internal session … to CLI session …` lines) and writes
`listener/sessions/focused` and `desktop-ids.json`. That is Desktop's internal format:
if an update changes it, voice simply falls back to the mic's session. Turn it off with
`"follow_desktop": false`; another log path: `"desktop_log"`. A session is opened with
the link `claude://claude.ai/epitaxy/local_<id>`.

How it works: every session writes a file about itself into `listener/sessions/` every
5 s. The session holding the mic drops the transcribed text into the chosen session's
"inbox", `listener/sessions/<id>.inbox`. The chosen session checks it once a second and
inserts or sends the text there, as if it was dictated straight into it. Having taken
it, it writes `<id>.ack`. With no ack within 4 s (the session hangs, or runs an old mod)
the text goes into the mic's session with a warning: voice is never lost. A session
silent for 20 s counts as closed.

Only one session holds the mic: the listener takes local port 47821 as a lock. A second
session sees `busy` and retries every 30 s, so it takes the mic over when the first
closes. Which session holds the mic only decides where the listener runs: text still
goes to the session on screen. An idle (AFK) mic doesn't move: it moves only when its
session closes.

## Settings

Create `listener/config.json` with only the keys you want to change:

```json
{ "lang": "en", "submit_on_end": false }
```

`"lang"` (`"ru"` by default, or `"en"`) picks every phrase below, the Vosk model and
whisper's language; any key set next to it overrides that one. Phrase words must be in
the Vosk model's vocabulary (the Russian one spells ё); a word it lacks is logged as
`Ignoring word missing in vocabulary`.

| Key | `en` | `ru` | What it is |
| --- | --- | --- | --- |
| `wake_phrase` | `"claude over"` | `"клод приём"` | starts a message that is sent |
| `text_phrase` | `"claude text"` | `"клод текст"` | starts a message that is only inserted |
| `stop_phrase` | `"claude stop"` | `"клод стоп"` | stops Claude, speech or a recording |
| `end_word` | `"over"` | `"приём"` | ends the message (and sends it) |
| `cancel_word` | `"cancel"` | `"отмена"` | before a pause during a recording: drop it |
| `submit_word` | `"send"` | `"отправь"` | with `submit_on_end: false`: "…, send, over" sends |
| `which_phrase` | `"claude which session"` | `"клод какая сессия"` | says where voice goes |
| `session_phrases` | `["claude session", "claude switch to session"]` | `["клод сессия", "клод перейди на сессию"]` | + a number word: pick a session |
| `numbers` | `one` … `nine` | `один` … `девять` | the number words |
| `repeat_phrase` | `"claude repeat"` | `"клод повтори"` | reads the last reply line again |
| `clear_phrase` | `"claude clear"` | `"клод сотри"` | empties the prompt box |
| `vosk_model` | `models/vosk-model-small-en-us-0.15` | `models/vosk-model-small-ru-0.22` | the Vosk model |
| `language` | `"en"` | `"ru"` | whisper's language; `"auto"` errs more on short phrases |
| `whisper_prompt` | terms | terms | words you say often: whisper spells them right |

| Key | Default | What it is |
| --- | --- | --- |
| `submit_on_end` | `true` | `false`: `end_word` only inserts, `submit_word` sends |
| `end_guard_sec` | `0.8` | `end_word` is ignored this long after the beep (tail of the wake phrase) |
| `start_timeout_sec` | `8` | cancel if you stay silent this long after the wake phrase |
| `max_sec` | `300` | recording limit without `end_word`: the text is inserted, not sent |
| `preroll_sec` | `1.0` | how much audio before the trigger is kept |
| `whisper_model` | `models/faster-whisper-small` | path to the whisper model |
| `whisper_device` | `"auto"` | `"auto"`: an NVIDIA GPU if CUDA is installed and works, else the CPU; `"cuda"`, `"cpu"` |
| `beam_size` | `5` | `1` is faster, `5` makes fewer mistakes |
| `beep`, `toast` | `true` | beeps and Windows notifications |
| `device` | `null` | mic index or name; `null`: the default mic |
| `speak`, `voice`, `speed` | `true`, `"bf_emma"`, `1.0` | spoken replies (Kokoro) |
| `follow_desktop`, `desktop_log` | `true`, `null` | voice follows the session on screen |

`listener\.venv\Scripts\python listener\listen.py --levels` shows the mic level, so you
can see whether it hears you at all.

Other modes: `--wav file.wav` runs a WAV file (16 kHz mono) instead of the mic,
`--selftest` checks the text rules, `--say "Hi"` speaks a line with the reply voice.

## Privacy and security

- All recognition and speech are offline, on your computer. Only `install.py` uses the
  network: it downloads models from alphacephei.com, Hugging Face and GitHub
  (kokoro-onnx).
- The mic is listened to the whole time the mod is on, but nothing is stored before the
  wake phrase. After it, the transcribed text goes into `listener/listen.log` (rewritten
  on every start), and the first 60 characters of each session's last prompt into
  `listener/sessions/*.json`. These files are not committed (`.gitignore`); delete them
  if you don't want them kept.
- The mod adds a rule about the `🔊` line to Claude's system prompt (the text is
  `SPEECH_RULE` in `mod/hooks/register.tsx`).
- The files `listener/sessions/*.inbox`, `listener/cmd`, `listener/say` are the channel
  between sessions: text from an `.inbox` is sent to Claude as your prompt. Any program
  running as your user can write there, so don't keep the repository in a folder shared
  with other users.
- The listener holds port 47821 on `127.0.0.1` only and accepts no connections.

## Limitations

- Claude Desktop must be running with at least one session open: the listener lives as
  long as the mod.
- Latency: about 0.5 s of pause after "over", plus transcribing the last stretch and the
  whole message with whisper small on the CPU: 1–3 s for a short message, more for a
  long one. The first start loads the models for a few seconds.
- False triggers are rarer than with a single word, but possible. "Over" in the middle of
  a message followed by a pause ends and sends it. A message that itself starts with
  "over" loses that word. If it triggers too often, turn it off with `/claude-voice-off`.
- If the text can't be inserted (a dialog is open), it is shown in a Claude toast.
- Windows only (winsound, Windows notifications, kernel32). About 1 GB of RAM while the
  listener runs.
- The band's hints name the default phrases of `"lang"`; with your own `wake_phrase` or
  `end_word` they still say "Claude, over" / "over".
