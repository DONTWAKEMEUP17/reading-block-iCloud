# Reading Block

**Save articles with one click. Every five saves, your browser books you a quiet
30-minute reading block on your iCloud Calendar so you actually read them.**

📺 [Watch the demo video (2 minutes)](https://www.youtube.com/watch?v=Q8g1hod552g)

> This is the **iCloud Calendar** version, adapted from the original
> [Reading Block](https://github.com/zarazhangrui/reading-block) by Zara Zhang.
> If you prefer Google Calendar, use the
> [original](https://github.com/zarazhangrui/reading-block); for Feishu/Lark
> Calendar, see the
> [Feishu/Lark version](https://github.com/zarazhangrui/reading-block-lark).

Reading Block is a Chrome extension for people who save a lot of "I'll read this
later" links and never get back to them. Instead of another list that grows
forever, it turns your saved reading into real appointments with yourself.

---

## Why use it

We all collect links. Long articles, essays, videos, threads. They pile up in
tabs and bookmarks and read-it-later apps, and "later" never comes, because
nothing ever puts that reading on your actual schedule.

Reading Block fixes the missing step: it books the time. Save five things, and it
finds a free slot on a day and time you choose (say, weekday afternoons) and puts
a 30-minute **Reading Block** on your calendar with those five links right in the
event. When the block ends, it asks what you finished, and quietly rolls anything
you didn't into your next session.

It's simple on purpose. No account to create, no app to open, no list to manage.

---

## What it does

- **One-click save.** Click the toolbar icon on any article to save it. A small
  "Saved" confirmation appears in the corner of the page, with an **Undo**.
- **Automatic scheduling.** Every five saves, it finds the next free slot inside
  your preferred days and hours and books a 30-minute reading block, with the
  five links in the event notes. At most one block per day.
- **A reading dashboard.** Right-click the icon to open a full page with your
  reading list (open, mark read, delete) and your settings.
- **End-of-block check-in.** When a block ends, a little checklist pops up. Tick
  what you finished; anything left over goes back into your list for next time.

Your reading list lives **locally in your browser**. There's no server and no
sign-up. The only thing it connects to is your own iCloud Calendar, to create
the blocks.

---

## Setup (about 5 minutes, no coding)

There are two halves: loading the extension into Chrome, and giving it permission
to use your iCloud Calendar. There's no developer console — iCloud connects with
an **app-specific password** you generate on Apple's site. **Full step-by-step
instructions are in [SETUP.md](SETUP.md)** and are written for non-technical
readers.

The short version:

1. **Load the extension.** In Chrome, go to `chrome://extensions`, turn on
   **Developer mode**, click **Load unpacked**, and select this project folder.
2. **Create an app-specific password.** At
   [appleid.apple.com](https://appleid.apple.com) → Sign-In & Security →
   App-Specific Passwords, generate one named `Reading Block` and copy it.
3. **Connect it.** Open the extension's **Settings**, paste your Apple ID and the
   app-specific password into the **Connect iCloud** card, and click **Test
   connection**.

[SETUP.md](SETUP.md) walks through every step.

---

## Using it

- **Save a page:** left-click the toolbar icon. (Watch for the corner toast.)
- **See your list or change settings:** right-click the toolbar icon → **Reading
  list** or **Settings**.
- **Adjust your reading window:** in Settings, pick the days, the time window
  (default weekday 2–6pm), the block length, and how many saves trigger a block.

---

## Privacy

- Your reading list never leaves your browser; it's stored locally.
- The extension only contacts iCloud Calendar, using your own Apple ID and an
  app-specific password stored locally in the browser, to create and manage
  reading blocks.
- There is no analytics, no server, and no third party involved.

---

## Credits

This is an iCloud Calendar adaptation of
[Reading Block](https://github.com/zarazhangrui/reading-block) by Zara Zhang,
used under the MIT License. The original books reading blocks on Google Calendar;
this version books them on iCloud via CalDAV (with an app-specific password
instead of Google OAuth). All credit for the original idea and design goes to the
upstream project.

## License

MIT. The original work is Copyright (c) 2026 Reading Block contributors; the
iCloud CalDAV adaptation is Copyright (c) 2026 Xiaoyu Zhong. See [LICENSE](LICENSE).
