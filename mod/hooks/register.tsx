import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandView, Phase, VoiceSession } from '../types'

// Where listener/ lives: beside the mod folder when loaded from the repo
// (CLAUDE_CODE_PLUGIN_DIRS=<repo>/mod), else $VOICE_WAKE_LISTENER_DIR, else the
// marketplace's clone: `claude plugin install` copies only mod/ into a versioned
// cache, while the marketplace keeps the whole repo at a stable path (and its
// updates keep the ignored .venv/ and models/).
const MARKETPLACE_LISTENER = '.claude/plugins/marketplaces/claude-voice/listener'
// Where install.py is for someone who installed from the marketplace (a clone: listener/install.py).
const INSTALL_HINT = `%USERPROFILE%/${MARKETPLACE_LISTENER}/install.py`
const BUSY_RETRY_MS = 30_000
const HEARTBEAT_MS = 5_000
const STALE_MS = 20_000 // a session not heard from this long counts as closed
const ACK_MS = 4_000 // a chosen session that has not taken voice this long: it goes to the mic's session
const PANE = 'voice-sessions'
// Voice prompts are sent with this mark; the system prompt asks Claude to end
// the reply to such a prompt with a SPEAK line, which the listener reads aloud.
const VOICE_MARK = '🎙'
const SPEAK = '🔊'
const SPEECH_RULE = `Voice replies: a user message that starts with ${VOICE_MARK} was dictated by voice, and one line of your reply to it is read aloud by an English text-to-speech voice when the reply is done. For such messages only, begin your final reply (the text after your last tool call) with one line: "${SPEAK} " followed by one short plain-English sentence (at most 50 words) giving the outcome or the answer, even when the rest of the reply is in another language. No markdown, code, file paths or URLs in that line. Never add it to messages without ${VOICE_MARK}.`

const phase = atom({ plugin: 'voice-wake', key: 'phase' } as const, 'off', { shape: 'phase-1' })
const sessions = atom({ plugin: 'voice-wake', key: 'sessions' } as const, [], { shape: 'sessions-4' })
const view = atom({ plugin: 'voice-wake', key: 'view' } as const, { said: '', err: '', elapsed: 0 }, { shape: 'view-2' })

// Everything the mod shows, per language. The listener's config.json "lang" picks
// it (the same key that picks the voice phrases); English until a listener is found.
type Lang = 'ru' | 'en'
const UI = {
  ru: {
    status: {
      off: '🎙 off',
      loading: '🎙 loading…',
      listening: '🎙 listening',
      recording: '🎙 ● запись',
      transcribing: '🎙 распознаю…',
      speaking: '🔊 говорю…',
      busy: '🎙 busy (другой сеанс)',
      restarting: '🎙 restarting…',
      error: '🎙 error',
      'not-installed': '🎙 not installed',
    } as Record<Phase, string>,
    dropped: (why: string) => `🎙 Не отправилось (${why}): текст в поле ввода, нажми Enter`,
    stopped: '🎙 Остановлено',
    notFilled: (why: string, text: string) => `🎙 не вставилось (${why}): ${text}`,
    notTaken: (name: string) => `🎙 сессия ${name} не приняла голос: текст здесь`,
    on: 'Голосовой ввод включён: скажи «Клод приём», сообщение и «приём» в конце.',
    off: 'Голосовой ввод выключен (во всех сеансах).',
    paneTitle: 'Голосовой ввод: сессии',
    cmdToggle: 'Голосовой ввод «Клод приём»: включить / выключить',
    cmdOn: 'Голосовой ввод: включить во всех сеансах',
    cmdOff: 'Голосовой ввод: выключить во всех сеансах (микрофон, речь)',
    cmdTo: 'Куда идёт голосовой ввод: без аргумента — список сессий, с номером — выбрать',
    cmdToHint: '[номер сессии]',
    self: 'эта',
    shown: 'на экране',
    mic: 'микрофон',
    voiceHere: ' ← голос сюда',
    noSessions: 'Нет сессий с модом.',
    noSuch: (n: number, count: number) => `Нет сессии №${n}: их ${count}.`,
    nowTo: (name: string) => `Голосовой ввод теперь идёт в: ${name}`,
    paneHead: 'Куда идёт голос',
    paneNote:
      'Голос идёт в сессию на экране Claude Desktop. Выбор здесь открывает сессию и держится, пока не переключишься на другую. Номер = /claude-voice-to n или «Клод, сессия n».',
    toSelf: '→ эта сессия',
    turnOff: 'Выключить',
    turnOffAll: 'Выключить везде',
    turnOn: 'Включить',
    listening: '🎙 Слушаю',
    sayWake: 'скажи «Клод, приём»',
    dictate: 'Диктовать',
    recording: '● Запись',
    sayEnd: 'закончи словом «приём»',
    done: 'Готово',
    transcribing: '🎙 Распознаю',
    textComes: 'текст появится в поле ввода',
    speaking: '🔊 Говорю',
    hush: 'Замолчать',
    loading: '🎙 Загружаю модели',
    loadingHint: 'Vosk и Whisper, первый запуск дольше',
    restarting: '🎙 Перезапускаю слушатель',
    micAt: '🎙 Микрофон у сессии',
    otherSession: 'другого сеанса Claude',
    voiceHereBtn: 'Голос сюда',
    crashed: '🎙 Слушатель упал',
    crashHint: 'подробности в listener/listen.log',
    restart: 'Перезапустить',
    install: '🎙 Нужна установка',
    isOff: '🎙 Голосовой ввод выключен',
  },
  en: {
    status: {
      off: '🎙 off',
      loading: '🎙 loading…',
      listening: '🎙 listening',
      recording: '🎙 ● recording',
      transcribing: '🎙 transcribing…',
      speaking: '🔊 speaking…',
      busy: '🎙 busy (another session)',
      restarting: '🎙 restarting…',
      error: '🎙 error',
      'not-installed': '🎙 not installed',
    } as Record<Phase, string>,
    dropped: (why: string) => `🎙 Not sent (${why}): the text is in the prompt box, press Enter`,
    stopped: '🎙 Stopped',
    notFilled: (why: string, text: string) => `🎙 could not insert (${why}): ${text}`,
    notTaken: (name: string) => `🎙 session ${name} did not take the voice input: it is here`,
    on: 'Voice input on: say "Claude, over", your message, and "over" at the end.',
    off: 'Voice input off (in every session).',
    paneTitle: 'Voice input: sessions',
    cmdToggle: 'Voice input ("Claude, over"): turn on / off',
    cmdOn: 'Voice input: turn on in every session',
    cmdOff: 'Voice input: turn off in every session (mic, speech)',
    cmdTo: 'Where voice input goes: no argument lists the sessions, a number picks one',
    cmdToHint: '[session number]',
    self: 'this',
    shown: 'on screen',
    mic: 'mic',
    voiceHere: ' ← voice goes here',
    noSessions: 'No sessions with the mod.',
    noSuch: (n: number, count: number) => `No session #${n}: there are ${count}.`,
    nowTo: (name: string) => `Voice input now goes to: ${name}`,
    paneHead: 'Where voice goes',
    paneNote:
      'Voice goes to the session on screen in Claude Desktop. A choice here opens that session and holds until you switch to another. Number = /claude-voice-to n or "Claude, session n".',
    toSelf: '→ this session',
    turnOff: 'Turn off',
    turnOffAll: 'Turn off everywhere',
    turnOn: 'Turn on',
    listening: '🎙 Listening',
    sayWake: 'say "Claude, over"',
    dictate: 'Dictate',
    recording: '● Recording',
    sayEnd: 'end with "over"',
    done: 'Done',
    transcribing: '🎙 Transcribing',
    textComes: 'the text will appear in the prompt box',
    speaking: '🔊 Speaking',
    hush: 'Hush',
    loading: '🎙 Loading models',
    loadingHint: 'Vosk and Whisper, the first start takes longer',
    restarting: '🎙 Restarting the listener',
    micAt: '🎙 The mic is with',
    otherSession: 'another Claude session',
    voiceHereBtn: 'Voice here',
    crashed: '🎙 The listener crashed',
    crashHint: 'details in listener/listen.log',
    restart: 'Restart',
    install: '🎙 Install needed',
    isOff: '🎙 Voice input off',
  },
}
let lang: Lang = 'en'
const t = () => UI[lang]

// A listener line. `cmd` comes from a voice command (no end word): «Клод, какая сессия»
// (which), «Клод, сессия три» (session, n), «Клод, сотри» (clear the prompt box).
type Line = { text?: string; submit?: boolean; status?: string; stop?: boolean; cmd?: 'which' | 'session' | 'clear'; n?: number }
// What each session writes about itself into listener/sessions/<id>.json.
type Entry = {
  id: string
  folder: string
  label: string
  seen: number
  project?: string
  branch?: string
  since?: number // when the session first wrote here: the list's order
  closed?: boolean
}

let child: AsyncGenerator<unknown, unknown> | undefined
let runningTurn: string | undefined // the main loop's turn in progress, for «Клод стоп»
let dir: string | undefined // the listener folder
let selfId = ''
let label = ''
let since = 0
let recTimer: { cancel: () => void } | undefined // ticks the recording's time on the band
let inboxSeen: number | undefined // seq of the last inbox message taken here

// Sessions find each other through files in listener/sessions/ (the mod API
// has no way to list sessions, and session.send would reach the other session
// as a peer's message, not as the person's prompt):
//   <id>.json   each session's heartbeat (folder, last prompt, time)
//   <id>.inbox  the last message routed to it: { seq, text, submit }
//   <id>.ack    the seq it took; none within ACK_MS and the sender delivers it itself
//   target      the id chosen in the pane; empty or stale = the shown session (below)
//   owner       the session whose listener holds the mic
//   focused     the session Claude Desktop shows; the listener writes it (and
//               drops `target` when another session is put on screen)
//   desktop-ids.json  { session id: Desktop's local_ id }, to open one in Desktop
// ponytail: $.fs cannot delete, so files of closed sessions stay (a few hundred bytes each).
const reg = () => `${dir}/sessions`

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function readTarget($: EngineInterface) {
  return (await $.fs.read(`${reg()}/target`).catch(() => '')).trim()
}

async function aliveEntries($: EngineInterface): Promise<Entry[]> {
  const now = await $.clock.now()
  const files = await $.fs.list(reg()).catch(() => [])
  const entries = await Promise.all(
    files.filter(f => f.name.endsWith('.json')).map(f => readJson<Entry>($, `${reg()}/${f.name}`)),
  )
  return entries.filter((e): e is Entry => !!e && !e.closed && now - e.seen < STALE_MS)
}

/** Where voice goes: the session chosen in the pane, else the one Claude Desktop
 * shows (the listener reads that from Desktop's log), else the mic's session.
 * A choice or a shown session without the mod running falls through. */
async function voiceTarget($: EngineInterface) {
  const [alive, chosen, focused, owner] = await Promise.all([
    aliveEntries($),
    readTarget($),
    $.fs.read(`${reg()}/focused`).then(t => t.trim(), () => ''),
    $.fs.read(`${reg()}/owner`).then(t => t.trim(), () => ''),
  ])
  const isAlive = (id: string) => !!id && alive.some(e => e.id === id)
  const shown = isAlive(focused) ? focused : ''
  const target = isAlive(chosen) ? chosen : shown || owner
  return { alive, target, owner, shown }
}

async function refreshSessions($: EngineInterface) {
  if (!dir) return
  const { alive, target, owner, shown } = await voiceTarget($)
  // This session first, then the others in the order they appeared: a new one
  // goes last, so the numbers already shown stay. The place is /claude-voice-to's number.
  const order = alive.sort(
    (a, b) =>
      Number(b.id === selfId) - Number(a.id === selfId) || (a.since ?? 0) - (b.since ?? 0) || a.id.localeCompare(b.id),
  )
  const names = order.map(where)
  const list: VoiceSession[] = order.map((e, i) => ({
    id: e.id,
    // Two sessions on the same branch: tell them apart by their id.
    name: names.indexOf(names[i]) === names.lastIndexOf(names[i]) ? names[i] : `${names[i]} (${e.id.slice(0, 4)})`,
    isSelf: e.id === selfId,
    isTarget: e.id === target,
    hasMic: e.id === owner,
    isShown: e.id === shown,
  }))
  await update($, sessions, () => list)
}

/** How a session is named everywhere: `project · branch`, the branch left out when unknown. */
const where = (s: { project?: string; folder: string; branch?: string }) =>
  [s.project || s.folder, (s.branch ?? '').replace(/^claude\//, '')].filter(Boolean).join(' · ')

/** The repository's name (a worktree's main checkout, not the worktree folder)
 * and the checked-out branch, read from .git/HEAD; '' where unknown. */
async function gitInfo($: EngineInterface, cwd: string) {
  const repo = await $.session.repo().catch(() => null)
  const project = (repo?.root ?? cwd).split(/[\\/]/).filter(Boolean).pop() ?? ''
  let head = await $.fs.read(`${cwd}/.git/HEAD`).catch(() => '')
  if (!head) {
    // A worktree's .git is a file: "gitdir: <its folder in the main .git>".
    const gitdir = (await $.fs.read(`${cwd}/.git`).catch(() => '')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (gitdir) {
      const abs = /^([a-zA-Z]:)?[\\/]/.test(gitdir) ? gitdir : `${cwd}/${gitdir}`
      head = await $.fs.read(`${abs}/HEAD`).catch(() => '')
    }
  }
  const branch = head.match(/^ref: refs\/heads\/(.+)$/m)?.[1]?.trim() ?? head.trim().slice(0, 7)
  return { project, branch }
}

async function heartbeat($: EngineInterface, closed = false) {
  if (!dir) return
  const cwd = await $.session.cwd()
  const folder = cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const entry: Entry = { id: selfId, folder, label, seen: await $.clock.now(), since, ...(await gitInfo($, cwd)) }
  await $.fs.write(`${reg()}/${selfId}.json`, JSON.stringify(closed ? { ...entry, closed } : entry))
  if (!closed) await refreshSessions($)
}

/** Send voice to session `id` and put it on screen in Claude Desktop. Choosing
 * the default (the shown session, else the mic's) clears the choice. */
async function select($: EngineInterface, id: string) {
  if (!dir) return
  const { shown, owner } = await voiceTarget($)
  await $.fs.write(`${reg()}/target`, id === (shown || owner) ? '' : id)
  if (id !== shown) await openInDesktop($, id)
  await refreshSessions($)
}

/** Open a session in Claude Desktop by its link; its Desktop id comes from the
 * listener's reading of Desktop's log. Unknown (no listener, an old log): nothing. */
async function openInDesktop($: EngineInterface, id: string) {
  const desktopId = (await readJson<Record<string, string>>($, `${reg()}/desktop-ids.json`))?.[id]
  if (!desktopId || !/^local_[\w-]+$/.test(desktopId)) return
  const proc = $.process.spawn({ argv: ['cmd', '/c', 'start', '', `claude://claude.ai/epitaxy/${desktopId}`] })
  // ponytail: a failed start (no claude:// handler) is only logged; the choice still holds.
  void (async () => {
    try {
      for await (const _ of proc);
    } catch (err) {
      $.ui.log(`voice-wake: could not open the session: ${String(err)}`)
    }
  })()
}

async function checkInbox($: EngineInterface) {
  if (!dir) return
  const msg = await readJson<Line & { seq: number }>($, `${reg()}/${selfId}.inbox`)
  const seq = msg?.seq ?? 0
  // A new session takes nothing that was waiting before it started.
  if (inboxSeen === undefined) inboxSeen = seq
  if (!msg || seq <= inboxSeen) return
  inboxSeen = seq
  // Too late: the sender has already put it in its own session.
  if ((await $.clock.now()) - seq > ACK_MS) return
  await $.fs.write(`${reg()}/${selfId}.ack`, String(seq))
  await deliver($, msg)
}

async function setPhase($: EngineInterface, p: Phase) {
  $.ui.status(t().status[p])
  recTimer?.cancel()
  recTimer = undefined
  if (p === 'recording') {
    // The band counts the recording's seconds.
    await update($, view, v => ({ ...v, elapsed: 0 }))
    recTimer = $.clock.every(1_000, () => void update($, view, v => ({ ...v, elapsed: v.elapsed + 1 })))
  }
  if (p === 'speaking' && dir) {
    // What is spoken: whichever session wrote it, it also left it in `said`.
    const said = (await $.fs.read(`${dir}/said`).catch(() => '')).trim()
    await update($, view, v => ({ ...v, said }))
  }
  await update($, phase, () => p)
}

async function listenerDir($: EngineInterface): Promise<string | undefined> {
  const fallback = await $.env.get('VOICE_WAKE_LISTENER_DIR')
  const home = await $.env.get('USERPROFILE')
  for (const d of [`${$.plugin.root}/../listener`, fallback, home && `${home}/${MARKETPLACE_LISTENER}`]) {
    if (!d) continue
    const st = await $.fs.stat(`${d}/.venv/Scripts/python.exe`).catch(() => undefined)
    if (st) return d
  }
  return undefined
}

async function isEnabled($: EngineInterface) {
  return (await $.store.get('enabled')) !== false
}

/** The reply's spoken line (the last SPEAK line, wherever it stands), as plain text, or undefined. */
function spokenLine(answer: string): string | undefined {
  const lines = answer.split('\n').filter(l => l.trim().startsWith(SPEAK))
  const last = lines.at(-1)?.trim().slice(SPEAK.length).replace(/[*_`#>]/g, '').trim()
  return last || undefined
}

/** A voice prompt the engine did not take (a Stop pressed while it waited, a
 * limit): put it back in the box so it is not lost, and say so. */
async function giveBack($: EngineInterface, text: string, why: string) {
  const box = await $.prompt.read()
  await $.prompt.fill({ text: [box.text.trim(), text].filter(Boolean).join(' '), mode: 'replace' })
  $.ui.toast(t().dropped(why))
  $.ui.log(`voice-wake: prompt dropped: ${why}`)
}

/** Have the mic's listener say `text` (and keep it on the band); a toast too, for when speech is off. */
async function sayAloud($: EngineInterface, text: string) {
  $.ui.toast(`🎙 ${text}`)
  if (!dir || !(await isEnabled($))) return
  await $.fs.write(`${dir}/said`, text)
  await $.fs.write(`${dir}/say`, text)
}

/** «Клод, какая сессия» and «Клод, сессия n»: the numbers are the sessions pane's. */
async function voiceCommand($: EngineInterface, line: Line) {
  await refreshSessions($)
  const list = await read($, sessions)
  const spoken = (s: VoiceSession) => s.name.replace(/ · /g, ', ')
  if (line.cmd === 'which') {
    const i = list.findIndex(s => s.isTarget)
    return sayAloud($, i < 0 ? 'Voice goes to this session.' : `Voice goes to session ${i + 1}, ${spoken(list[i])}.`)
  }
  const n = line.n ?? 0
  const chosen = list[n - 1]
  if (!chosen) return sayAloud($, `There is no session ${n}. There are ${list.length}.`)
  await select($, chosen.id)
  return sayAloud($, `Session ${n}, ${spoken(chosen)}.`)
}

async function deliver($: EngineInterface, line: Line) {
  if (line.cmd === 'clear') {
    await $.prompt.fill({ text: '', mode: 'replace' })
    return
  }
  if (line.stop) {
    if (!runningTurn) return
    await $.turn.abort({ turnId: runningTurn }).catch(() => undefined) // it may have just ended
    $.ui.toast(t().stopped)
    return
  }
  const spoken = line.text?.trim() ?? ''
  const box = await $.prompt.read()
  if (line.submit) {
    // Send what was dictated before (inserted, unsent) together with this phrase.
    const full = [box.text.trim(), spoken].filter(Boolean).join(' ')
    if (!full) return
    if (box.text) await $.prompt.fill({ text: '', mode: 'replace' })
    // Not awaited: a prompt sent while Claude works waits for the turn to end,
    // and the listener's next lines («Клод стоп») must not wait with it.
    void $.prompt.submit({ text: `${VOICE_MARK} ${full}`, asUser: true }).then(
      r => r.drop !== undefined && giveBack($, full, r.drop),
      err => giveBack($, full, String(err)),
    )
    return
  }
  if (!spoken) return
  const before = box.text.slice(0, box.cursor)
  const sep = before && !/\s$/.test(before) ? ' ' : ''
  const filled = await $.prompt.fill({ text: sep + spoken, mode: 'insert' })
  if (!filled.isFilled) $.ui.toast(t().notFilled(filled.refusal ?? 'unknown', spoken))
}

/** Deliver here, or to the session voice goes to (`voiceTarget`). */
async function route($: EngineInterface, line: Line) {
  const { alive, target } = await voiceTarget($)
  if (target && target !== selfId) {
    const entry = alive.find(e => e.id === target)
    if (entry) {
      const seq = await $.clock.now()
      await $.fs.write(`${reg()}/${target}.inbox`, JSON.stringify({ seq, ...line }))
      // No ack in time (the session hangs, an old mod there): deliver here instead.
      $.clock.after(ACK_MS, async () => {
        if (Number(await $.fs.read(`${reg()}/${target}.ack`).catch(() => '0')) >= seq) return
        $.ui.toast(t().notTaken(where(entry)))
        await deliver($, line)
      })
      return
    }
  }
  await deliver($, line)
}

async function run($: EngineInterface) {
  if (child || !(await isEnabled($))) return
  if (!dir) {
    await setPhase($, 'not-installed')
    $.ui.log(`voice-wake: no listener venv found; run python ${INSTALL_HINT}`)
    return
  }
  await setPhase($, 'loading')
  const proc = $.process.spawn({
    argv: [`${dir}/.venv/Scripts/python.exe`, '-u', `${dir}/listen.py`],
    cwd: dir,
    env: { PYTHONIOENCODING: 'utf-8' },
  })
  child = proc
  const startedAt = await $.clock.now()
  let buf = ''
  let busy = false
  let errTail = ''
  try {
    for await (const { stream, text } of proc) {
      if (stream === 'stderr') {
        errTail = (errTail + text).slice(-300)
        continue
      }
      buf += text
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        let line: Line
        try {
          line = JSON.parse(raw)
        } catch {
          continue
        }
        if (line.status === 'ready') {
          if (dir) await $.fs.write(`${reg()}/owner`, selfId)
          await setPhase($, 'listening')
        }
        if (line.status === 'recording') await setPhase($, 'recording')
        if (line.status === 'transcribing') await setPhase($, 'transcribing')
        if (line.status === 'speaking') await setPhase($, 'speaking')
        if (line.status === 'busy') busy = true
        if (line.cmd === 'which' || line.cmd === 'session') await voiceCommand($, line)
        if (line.text !== undefined || line.stop || line.cmd === 'clear') await route($, line)
      }
    }
  } catch (err) {
    $.ui.log(`voice-wake: listener failed: ${String(err)}`)
  }
  const stoppedByUs = child !== proc
  if (child === proc) child = undefined
  if (stoppedByUs || !(await isEnabled($))) return
  if (busy) {
    // Another session owns the mic; take over once it lets go.
    await setPhase($, 'busy')
    $.clock.after(BUSY_RETRY_MS, () => void run($))
  } else if ((await $.clock.now()) - startedAt > 60_000) {
    // It ran a while, then died (killed, a crash mid-session): start it again.
    // ponytail: a listener that dies every minute restarts forever; cap it if that happens.
    await setPhase($, 'restarting')
    $.clock.after(5_000, () => void run($))
  } else {
    // The band shows the last line of stderr: usually the cause (no mic, no model).
    const err = errTail.trim().split('\n').at(-1)?.trim() ?? ''
    await update($, view, v => ({ ...v, err }))
    await setPhase($, 'error')
    $.ui.log(`voice-wake: listener exited. ${errTail.trim()}`)
  }
}

async function setEnabled($: EngineInterface, enable: boolean) {
  await $.store.set('enabled', enable)
  if (enable) return run($)
  const proc = child
  child = undefined
  void proc?.return(undefined)
  await setPhase($, 'off')
}

async function send($: EngineInterface, cmd: 'dictate' | 'stop') {
  if (dir) await $.fs.write(`${dir}/cmd`, cmd)
}

/** /claude-voice, -on, -off: the setting is shared by every session. */
async function toggle($: EngineInterface, enable: boolean) {
  void setEnabled($, enable)
  return { text: enable ? t().on : t().off }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: t().paneTitle })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    dir = await listenerDir($)
    // The listener's own default is "ru" (no config.json, or no "lang" in it).
    if (dir) lang = (await readJson<{ lang?: string }>($, `${dir}/config.json`))?.lang === 'en' ? 'en' : 'ru'
    await $.command.register({ name: 'claude-voice', description: t().cmdToggle })
    await $.command.register({ name: 'claude-voice-on', description: t().cmdOn })
    await $.command.register({ name: 'claude-voice-off', description: t().cmdOff })
    await $.command.register({ name: 'claude-voice-to', description: t().cmdTo, argumentHint: t().cmdToHint })
    selfId = await $.session.id()
    if (dir) {
      const old = await readJson<Entry>($, `${reg()}/${selfId}.json`)
      label = old?.label ?? ''
      since = old?.since ?? (await $.clock.now()) // a reload keeps its place in the list
      await heartbeat($)
      await checkInbox($) // marks what waits there as seen
      $.clock.every(HEARTBEAT_MS, () => void heartbeat($))
      $.clock.every(1_000, () => void checkInbox($))
    }
    if (await isEnabled($)) void run($)
    else await setPhase($, 'off')
    return started
  })

  on('session.end', async ($, e, next) => {
    await heartbeat($, true).catch(() => undefined)
    return next(e)
  })

  // Ask for a short English line to speak on voice prompts. Always in the prompt
  // (not only on voice turns) so the system prompt stays cached.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, { id: 'voice-wake:speech', text: SPEECH_RULE, scope: 'session' as const }] }
  })

  // The main loop's reply ended: hand its spoken line to the listener (whichever
  // session's listener holds the mic speaks it).
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) runningTurn = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.turnId === runningTurn) runningTurn = undefined
    const r = await next(e)
    const say = e.reason === 'answer' && !e.agentId ? spokenLine(e.answer) : undefined
    if (say && dir && (await isEnabled($))) {
      // The listener takes `say`; `said` stays for the band while it speaks.
      await $.fs.write(`${dir}/said`, say)
      await $.fs.write(`${dir}/say`, say)
    }
    return r
  })

  // The last prompt names the session in the list.
  on('prompt.submit', async ($, e, next) => {
    label = e.text.replace(VOICE_MARK, '').replace(/\s+/g, ' ').trim().slice(0, 60) || label
    return next(e)
  })

  on('command.run', { command: 'claude-voice' }, async $ => toggle($, !(await isEnabled($))))
  on('command.run', { command: 'claude-voice-on' }, async $ => toggle($, true))
  on('command.run', { command: 'claude-voice-off' }, async $ => toggle($, false))

  on('command.run', { command: 'claude-voice-to' }, async ($, e) => {
    await refreshSessions($)
    const list = await read($, sessions)
    const n = Number.parseInt(e.args.trim(), 10)
    if (Number.isNaN(n)) {
      void openPane($)
      const tags = (s: VoiceSession) => [s.isSelf && t().self, s.isShown && t().shown, s.hasMic && t().mic].filter(Boolean).join(', ')
      return {
        text:
          list.map((s, i) => `${i + 1}. ${s.name}${tags(s) ? ` (${tags(s)})` : ''}${s.isTarget ? t().voiceHere : ''}`).join('\n') ||
          t().noSessions,
      }
    }
    const chosen = list[n - 1]
    if (!chosen) return { text: t().noSuch(n, list.length) }
    await select($, chosen.id)
    return { text: t().nowTo(chosen.name) }
  })

  // The sessions pane: this session first, then the others in the order they
  // appeared; the number is the one /claude-voice-to and «Клод, сессия n» take, and its hotkey.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, sessions)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold dimColor>
          {t().paneHead}
        </Text>
        <Box flexDirection="column">
          {list.map((s, i) => (
            <Button
              key={s.id}
              hotkey={i < 9 ? String(i + 1) : undefined}
              variant={s.isTarget ? 'primary' : undefined}
              onPress={() => void select($, s.id)}
            >
              {s.isTarget ? '✓ ' : '   '}
              {`${i + 1}. ${s.name} `}
              <Text dimColor>
                {[s.isSelf ? t().self : '', s.isShown ? t().shown : '', s.hasMic ? `🎙 ${t().mic}` : ''].filter(Boolean).join(' · ')}
              </Text>
            </Button>
          ))}
        </Box>
        {list.length === 0 && <Text dimColor>{t().noSessions}</Text>}
        <Text dimColor>{t().paneNote}</Text>
      </Box>
    )
  })

  // The band above the prompt: one frame for every state — what the listener
  // does, where voice goes (always), the main button, Turn off last and dim.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const p = await read($, phase)
    const list = await read($, sessions)
    const v = await read($, view)
    const target = list.find(s => s.isTarget)
    const toPane = () => void openPane($)
    const chip = (
      <Button key="target" dimColor onPress={toPane}>
        {!target || target.isSelf ? t().toSelf : `→ ${target.name}`}
      </Button>
    )
    const turnOff = <Button key="off" label={t().turnOff} dimColor onPress={() => void setEnabled($, false)} />
    const btn = (key: string, label: string, press: () => void) => (
      <Button key={key} label={label} variant="primary" onPress={press} />
    )
    const row = (o: { title: string; hint?: string; color?: string; dim?: boolean; parts?: (typeof chip)[] }) => (
      <Box gap={1} alignItems="center">
        <Text bold={!o.dim} dimColor={o.dim} color={o.color}>
          {o.title}
        </Text>
        {o.hint ? <Text dimColor>{o.hint}</Text> : null}
        {o.parts}
      </Box>
    )
    const mmss = `${Math.floor(v.elapsed / 60)}:${String(v.elapsed % 60).padStart(2, '0')}`
    switch (p) {
      case 'listening':
        return row({ title: t().listening, hint: t().sayWake, parts: [chip, btn('dictate', t().dictate, () => void send($, 'dictate')), turnOff] })
      case 'recording':
        return row({ title: `${t().recording} ${mmss}`, color: 'red', hint: t().sayEnd, parts: [chip, btn('done', t().done, () => void send($, 'stop'))] })
      case 'transcribing':
        return row({ title: t().transcribing, hint: t().textComes, parts: [chip] })
      case 'speaking':
        return row({ title: t().speaking, hint: v.said ? `«${v.said}»` : undefined, parts: [btn('hush', t().hush, () => void send($, 'stop'))] })
      case 'loading':
        return row({ title: t().loading, hint: t().loadingHint, parts: [turnOff] })
      case 'restarting':
        return row({ title: t().restarting, parts: [turnOff] })
      case 'busy': {
        const mic = list.find(s => s.hasMic)
        const here = target?.isSelf ? [chip] : [btn('here', t().voiceHereBtn, () => void select($, selfId))]
        return row({
          title: t().micAt,
          color: 'yellow',
          hint: mic ? mic.name : t().otherSession,
          parts: [...here, <Button key="off-all" label={t().turnOffAll} dimColor onPress={() => void setEnabled($, false)} />],
        })
      }
      case 'error':
        return row({ title: t().crashed, color: 'red', hint: v.err || t().crashHint, parts: [btn('restart', t().restart, () => void setEnabled($, true))] })
      case 'not-installed':
        return row({ title: t().install, hint: `python ${INSTALL_HINT}` })
      case 'off':
        return row({ title: t().isOff, dim: true, parts: [<Button key="on" label={t().turnOn} onPress={() => void setEnabled($, true)} />] })
    }
  })
}
