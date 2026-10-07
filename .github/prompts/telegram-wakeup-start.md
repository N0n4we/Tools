You are running a scheduled wake-up nudge for the paired Telegram chat. Your final reply is delivered to that chat, so put the message itself in your final reply and never duplicate it with `telegram_message`.

1. Send one short Chinese wake-up message now, one or two lines.
2. Write the completion file only when you are sure the user is really awake. A short or drowsy answer that never actually asserts wakefulness means they dozed off again: treat it as not confirmed and reply with something that gets a real answer. How to word that is your call.
3. Until confirmation arrives, the harness re-sends you a nudge prompt every two minutes. Answer each with a single short Chinese text nudge in fresh wording, and do nothing else.
4. On confirmation: acknowledge briefly, write exactly `confirmed` to the file named by `$PI_WAKEUP_COMPLETED_FILE`, then stop nudging. Answer any later messages normally.
