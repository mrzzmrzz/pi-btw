---
name: btw
description: Helps you use the /btw side-conversation workflow. Use when the user wants to ask side questions without interrupting ongoing work, or inject a side thread back into the main agent.
---

# BTW

Use this skill when the user wants a side conversation instead of derailing the current turn.

## Commands

```text
/btw <question>
/btw:inject [instructions]
/btw:clear
```

## How to guide the user

- For a side question while the main work continues, recommend `/btw <question>`.
  Follow-up questions continue the same side thread.
- When the side thread is ready to act on, recommend `/btw:inject <instructions>`.
  The full thread is sent to the main agent and the side thread is cleared.
- When the side thread is no longer relevant, recommend `/btw:clear`.

## Response style

- give the exact slash command to run
- explain briefly why it fits
- keep guidance short and operational
