# Setting up Reading Block (one time, ~5 minutes)

This guide gets the extension running in Chrome and connected to your iCloud
Calendar. You only do this once. Follow it top to bottom.

There are two halves:
- **Part A** loads the extension into Chrome.
- **Part B** gives it permission to use your iCloud Calendar.

Unlike the Google version, there's no developer console and no project to
create. iCloud uses an **app-specific password** — a one-time code you generate
on Apple's site and paste into the extension's Settings.

---

## Part A: Load the extension into Chrome

1. Download this project to your computer (if you cloned or unzipped it, just
   remember where the folder is).
2. Open Chrome. In the address bar type `chrome://extensions` and press Enter.
3. Top-right of that page, turn **Developer mode** ON.
4. Click **Load unpacked** (top-left).
5. In the file picker, select **this project's folder** (the one containing
   `manifest.json`), then click Select.
6. A card titled **Reading Block** appears.

If the icon is hidden, click the puzzle-piece icon in Chrome's toolbar and pin
"Reading Block".

---

## Part B: Connect your iCloud Calendar

iCloud won't accept your normal Apple ID password from a third-party app. Instead
you create an **app-specific password**: a one-off code that only this extension
uses, and that you can revoke any time without changing your real password.

### B1. Create an app-specific password
1. Go to **https://appleid.apple.com** and sign in.
2. Open **Sign-In & Security** → **App-Specific Passwords**.
3. Click **+** (or **Generate an app-specific password**), name it
   `Reading Block`, and confirm.
4. Apple shows a password like `abcd-efgh-ijkl-mnop`. **Copy it now** — Apple
   won't show it again. (If you lose it, just generate a new one.)

> Two-factor authentication must be on for your Apple ID (it is for almost
> everyone). App-specific passwords aren't available without it.

### B2. Paste it into the extension
1. Right-click the Reading Block toolbar icon → **Settings** (or open the card on
   `chrome://extensions` → **Extension options**).
2. In the **Connect iCloud** card, enter:
   - **Apple ID:** the email you sign in to iCloud with (e.g. `you@icloud.com`).
   - **App-specific password:** the code from B1. (Use **Show** to check it.)
3. Click **Test connection**. Within a second or two you should see
   **"Connected. Reading blocks will be booked on your iCloud calendar."**
4. Click **Save settings** at the bottom.

That's it — your credentials live only in this browser.

---

## Part C: First use

1. Open five articles and **left-click the Reading Block icon once** on each. A
   small "Saved" confirmation appears in the corner each time.
2. On the fifth save, the extension finds the next free slot in your chosen
   window and books a 30-minute reading block on your iCloud calendar, with the
   five links in the event notes. The corner toast confirms when and gives you
   an **Undo**.
3. When the block ends, a small checklist pops up asking what you finished;
   anything left rolls into your next session.

---

## Choosing which calendar it books on

By default the extension books on your **primary** iCloud calendar. While you're
trying it out, you may prefer a throwaway calendar so nothing lands on your real
schedule:

1. In Apple Calendar (Mac) or iCloud.com, create a new calendar, e.g. `Reading`.
2. In the extension's Settings → **Calendar** card, set **Calendar ID** to that
   calendar's **name** (`Reading`) instead of `primary`, and Save.

---

## If something goes wrong
- **"iCloud rejected your Apple ID or app-specific password":** double-check the
  Apple ID email, and make sure you used the **app-specific** password (with the
  dashes), not your normal Apple ID password. Generate a fresh one if unsure.
- **Test connection hangs or errors on discovery:** confirm you're online and
  that two-factor authentication is enabled on your Apple ID (required for
  app-specific passwords).
- **"No writable iCloud event calendar was found":** the account has no standard
  calendar to write to. Create one in Apple Calendar and try again.
- **"No calendar named … was found":** the **Calendar ID** in Settings doesn't
  match any calendar name on the account. Set it back to `primary`, or fix the
  name.
- **"No free slot found":** your chosen window had no meeting-free block on a free
  day in the lookahead period. Widen the window or days in Settings.
- **Nothing happens on the 5th save:** open `chrome://extensions`, click "service
  worker" under the Reading Block card to see logs.
