# pi-btw

A small [pi](https://github.com/earendil-works/pi-mono) extension that adds a `/btw` side conversation.

`/btw` opens a parallel side thread in a real pi sub-session with coding-tool access. It stays out of the main agent's context until you hand it back with `/btw:inject`.

This is a minimal fork of [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw), trimmed to three commands and a restrained, text-only overlay.

## What it does

- opens a side conversation without touching the main thread's context
- runs it as a real pi sub-session with `read` / `bash` / `edit` / `write` tool access
- keeps one continuous side thread that survives reloads and restarts
- streams responses and tool activity into a plain, bordered overlay
- injects the whole thread back into the main agent when you are ready

## Install

```bash
pi install git:github.com/mrzzmrzz/pi-btw
```

Then reload pi:

```text
/reload
```

Or from a local checkout:

```bash
pi install /absolute/path/to/pi-btw
```

## Usage

```text
/btw what file defines this route?
/btw how would you refactor this parser?
/btw:inject implement the plan we just discussed
/btw:clear
```

## Commands

### `/btw [question]`

- with a question: asks it in the side thread and opens the overlay
- without a question: just opens the overlay with the current thread
- the side thread inherits the current main-session context when it starts
- follow-up questions continue the same thread
- the thread is persisted as hidden session entries, invisible to the main agent

### `/btw:inject [instructions]`

- sends the full side thread to the main agent as a user message
- optional instructions are prepended
- if the main agent is busy, the message is queued as a follow-up
- clears the side thread after sending

### `/btw:clear`

- clears the side thread and closes the overlay

## Overlay

- `Enter` sends, `Esc` closes (the thread is kept; `/btw` reopens it)
- `Up`/`Down`/`PgUp`/`PgDn` scroll the transcript
- `/btw:inject` and `/btw:clear` also work from inside the overlay; any other
  slash input goes to the side conversation itself
- closing the overlay mid-stream aborts the in-flight question; completed
  exchanges are kept

## Behavior

- the side thread runs as a real in-memory pi sub-session that inherits the
  main thread's model and thinking level; if the main model changes, the
  sub-session is recreated with the thread reseeded
- exchanges are persisted as hidden custom entries, so the thread survives
  `/reload` and restarts while staying out of the main agent's LLM context
- the overlay is plain text on pi's theme colors: no icons, no badges

## Why

Sometimes you want to ask a clarifying question, think through next steps, or
explore an idea without derailing the main conversation - then inject the
result once it is ready.

## Development

- extension entrypoint: `extensions/btw.ts`
- included skill: `skills/btw/SKILL.md`
- run tests: `npm test`

To use it without installing:

```bash
pi -e /path/to/pi-btw
```

## Credits

Based on [pi-btw](https://github.com/dbachelder/pi-btw) by Dan Bachelder (MIT).

## License

MIT
