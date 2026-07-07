// caldav.js
// ---------------------------------------------------------------------------
// The iCloud equivalent of calendar.js. It is the ONLY file that talks to
// Apple, and it exposes the exact same two functions the rest of the app calls:
//
//   scheduleReadingBlock(batchItems, settings) -> { event, slot }
//   deleteReadingEvent(eventId, settings)
//
// so service-worker.js doesn't know or care which calendar it's booking.
//
// The big difference from Google: iCloud has no JSON REST API. The only way in
// from a browser extension is CalDAV — an HTTP-plus-XML protocol layered on
// iCalendar (.ics) text. So instead of clean JSON we deal with:
//   * Basic auth using an Apple ID + an APP-SPECIFIC PASSWORD (created at
//     appleid.apple.com). There is no OAuth/consent popup like Google's.
//   * "PROPFIND" requests to discover WHERE the user's calendars live.
//   * a "free-busy-query" REPORT to learn when they're busy.
//   * a PUT of a hand-built VEVENT to create the block, and DELETE to remove it.
//
// Everything about WHICH slot to pick still lives in slots.js, untouched. This
// file is just a (chattier) messenger, exactly like calendar.js was.
//
// NOTE: an MV3 service worker has no DOMParser (there's no `document`), so the
// XML and .ics parsing below is done with small, targeted string helpers rather
// than a real parser. The responses we ask for are narrow and predictable, so
// this is deliberate — but it's also the most fragile part, and the first place
// to reach for a tiny library (e.g. ical.js) if edge cases show up.
// ---------------------------------------------------------------------------

import { findNextFreeSlot, localDateKey } from "./slots.js";

const CALDAV_ROOT = "https://caldav.icloud.com";

// Discovering the user's calendar home takes a few round-trips, so once we've
// resolved it we cache it in memory keyed by Apple ID (mirrors how calendar.js
// cached its token). Cleared automatically if the Apple ID changes.
let discovery = null;

// --- Auth -------------------------------------------------------------------

// Build the Basic-auth header from the Apple ID + app-specific password the
// user pasted into Settings. btoa exists in the service worker.
function authHeader(settings) {
  const user = settings.appleId;
  const pass = settings.appPassword;
  if (!user || !pass) {
    throw new Error(
      "iCloud isn't connected yet. In Settings, enter your Apple ID and an " +
        "app-specific password (create one at appleid.apple.com → Sign-In & " +
        "Security → App-Specific Passwords)."
    );
  }
  return "Basic " + btoa(`${user}:${pass}`);
}

// One wrapper around fetch for every CalDAV call. Attaches auth, sets the Depth
// header CalDAV needs, and surfaces a readable error on failure. Returns the raw
// body text plus the final URL (after any iCloud redirect to a pNN- host), which
// we need to resolve the relative hrefs iCloud hands back.
async function dav(url, { method = "GET", body, depth, contentType, headers } = {}, settings) {
  const init = () => ({
    method,
    headers: {
      Authorization: authHeader(settings),
      ...(depth != null ? { Depth: String(depth) } : {}),
      ...(contentType ? { "Content-Type": contentType } : {}),
      ...(headers || {}),
    },
    body,
  });

  let res = await fetch(url, init());

  // iCloud redirects caldav.icloud.com to a per-user pNN- host. fetch follows the
  // redirect automatically, but on the way it DROPS the request body (and, being
  // cross-origin, the Authorization header) — so the PROPFIND/REPORT arrives
  // empty and iCloud answers 400 with no body. When a redirect happened and the
  // result failed, re-issue the identical request straight at the final URL,
  // which is now same-origin so the body and auth survive intact.
  if (!res.ok && res.redirected && res.url && res.url !== url) {
    res = await fetch(res.url, init());
  }

  if (res.status === 401) {
    throw new Error(
      "iCloud rejected your Apple ID or app-specific password. Note that iCloud " +
        "needs an APP-SPECIFIC password, not your normal Apple ID password."
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    // iCloud is HTTP/2 (so res.statusText is always "") and often sends an empty
    // 400 body, which leaves nothing to show. Dump everything we CAN see —
    // whether a redirect happened, the URL we ended on, and the response headers
    // — so the real problem is visible in the service-worker console / Network tab.
    console.error("Reading Block CalDAV failed:", {
      method,
      requestedUrl: url,
      finalUrl: res.url,
      redirected: res.redirected,
      status: res.status,
      responseHeaders: Object.fromEntries(res.headers.entries()),
      body: detail,
    });
    throw new Error(
      `iCloud CalDAV error ${res.status} on ${method} ${new URL(url).pathname}` +
        (detail ? `: ${detail}` : " (empty response — see the service-worker console for details)")
    );
  }
  return { text: await res.text(), finalUrl: res.url || url };
}

// --- Discovery: find the calendar we should write to ------------------------
//
// CalDAV never tells you the calendar URL up front. You walk a little chain:
//   root ──PROPFIND current-user-principal──▶ principal URL
//   principal ──PROPFIND calendar-home-set──▶ the folder holding all calendars
//   home ──PROPFIND Depth:1──▶ list the calendars; pick the right one
//
// settings.calendarId picks which: "primary" = the first writable event
// calendar; anything else is matched against the calendar's display name.
async function resolveCalendarUrl(settings) {
  if (discovery && discovery.appleId === settings.appleId) return discovery.calendarUrl;

  // 1. current-user-principal — who am I, as a CalDAV URL?
  const principalRes = await dav(
    `${CALDAV_ROOT}/`,
    { method: "PROPFIND", depth: 0, contentType: "application/xml; charset=utf-8", body: PROPFIND_PRINCIPAL },
    settings
  );
  const principalHref = firstHrefIn(propBlock(principalRes.text, "current-user-principal"));
  if (!principalHref) throw new Error("iCloud didn't return a user principal (CalDAV discovery failed).");
  const principalUrl = absolute(principalHref, principalRes.finalUrl);

  // 2. calendar-home-set — the folder that holds all this user's calendars.
  const homeRes = await dav(
    principalUrl,
    { method: "PROPFIND", depth: 0, contentType: "application/xml; charset=utf-8", body: PROPFIND_HOME },
    settings
  );
  const homeHref = firstHrefIn(propBlock(homeRes.text, "calendar-home-set"));
  if (!homeHref) throw new Error("iCloud didn't return a calendar home (CalDAV discovery failed).");
  const homeUrl = absolute(homeHref, homeRes.finalUrl);

  // 3. List the calendars in the home, and choose one.
  const listRes = await dav(
    homeUrl,
    { method: "PROPFIND", depth: 1, contentType: "application/xml; charset=utf-8", body: PROPFIND_CALENDARS },
    settings
  );
  const calendarUrl = chooseCalendar(listRes.text, listRes.finalUrl, settings.calendarId);
  if (!calendarUrl) {
    throw new Error(
      settings.calendarId && settings.calendarId !== "primary"
        ? `No iCloud calendar named "${settings.calendarId}" was found.`
        : "No writable iCloud event calendar was found on this account."
    );
  }

  discovery = { appleId: settings.appleId, calendarUrl };
  return calendarUrl;
}

// From the Depth:1 listing, pick the calendar collection to use. We only accept
// collections that (a) are calendars and (b) support VEVENT — that filters out
// Reminders/Notes collections which live in the same home.
function chooseCalendar(xml, baseUrl, calendarId) {
  const wantName = calendarId && calendarId !== "primary" ? calendarId.toLowerCase() : null;

  for (const block of responseBlocks(xml)) {
    const href = firstHrefIn(block);
    if (!href) continue;
    // Skip the home collection itself and anything that isn't a calendar.
    if (!/<(?:\w+:)?calendar\b/i.test(block)) continue;
    // Must support VEVENT (not just tasks/reminders).
    const comps = tagBlock(block, "supported-calendar-component-set") || block;
    if (!/name=["']VEVENT["']/i.test(comps)) continue;

    const name = (tagText(block, "displayname") || "").trim();
    if (wantName) {
      if (name.toLowerCase() === wantName) return absolute(href, baseUrl);
    } else {
      return absolute(href, baseUrl); // "primary": first writable event calendar
    }
  }
  return null;
}

// --- The public API (same shape as calendar.js) -----------------------------

/**
 * Find a free slot from the user's preferences and book a reading block on their
 * iCloud calendar.
 * @param {Array}  batchItems  The saved items to read; each {url, title}.
 * @param {Object} settings    User preferences (from storage) incl. appleId /
 *                             appPassword / calendarId / eventTitle / windows.
 * @param {Object} [opts]
 * @param {Date}   [opts.now=new Date()]  Injectable clock, for tests.
 * @returns {Promise<{event:{id:string}, slot:{start:Date,end:Date}}>}
 *          event.id is the created event's CalDAV URL (used later for delete).
 * @throws if no free slot exists in the window, or iCloud errors.
 */
export async function scheduleReadingBlock(batchItems, settings, opts = {}) {
  const now = opts.now || new Date();
  const calendarUrl = await resolveCalendarUrl(settings);

  const timeMin = new Date(now);
  const timeMax = new Date(now);
  timeMax.setDate(timeMax.getDate() + settings.lookaheadDays + 1);

  // 1. Ask iCloud when we're busy across the lookahead window. iCloud doesn't
  //    reliably support the free-busy-query REPORT (it answers 400), so we use
  //    the universally-supported calendar-query instead: fetch the actual VEVENTs
  //    in the range — with server-side `expand` so recurring events come back as
  //    concrete timed instances — and derive busy intervals from them.
  const busyRes = await dav(
    calendarUrl,
    {
      method: "REPORT",
      depth: 1,
      contentType: "application/xml; charset=utf-8",
      body: busyEventsQueryBody(timeMin, timeMax),
    },
    settings
  );
  const busy = parseBusyFromCalendarData(busyRes.text);

  // 2. Find which days ALREADY have one of our reading blocks, so we never book
  //    two on the same day.
  const blockedDays = await getBlockedDays(calendarUrl, settings, timeMin, timeMax);

  // 3. Hand off to the tested brain to choose the slot.
  const slot = findNextFreeSlot(busy, settings, now, blockedDays);
  if (!slot) {
    throw new Error(
      `No free ${settings.blockMinutes}-minute slot found on a free day in your preferred window over the next ${settings.lookaheadDays} days.`
    );
  }

  // 4. Build the VEVENT and PUT it into the calendar collection. In CalDAV the
  //    event's identity IS its URL, which we choose (uid.ics). We return that
  //    URL as event.id so deleteReadingEvent can find it again.
  const uid = (crypto.randomUUID?.() || `rb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const eventUrl = joinUrl(calendarUrl, `${uid}.ics`);
  const title = settings.eventTitle || "Reading Block";
  const ics = buildVEvent({
    uid,
    start: slot.start,
    end: slot.end,
    summary: title,
    description: buildDescription(batchItems),
  });

  await dav(
    eventUrl,
    {
      method: "PUT",
      contentType: "text/calendar; charset=utf-8",
      // If-None-Match:* means "only create; never clobber an existing event".
      headers: { "If-None-Match": "*" },
      body: ics,
    },
    settings
  );

  return { event: { id: eventUrl }, slot };
}

// Delete a reading-block event (used when the user clicks Undo on a booking).
// eventId is the CalDAV URL we returned from scheduleReadingBlock.
export async function deleteReadingEvent(eventId, settings) {
  await dav(eventId, { method: "DELETE" }, settings);
}

// Verify the user's iCloud credentials by running the full discovery handshake
// (which is what authenticates and finds a usable calendar). Powers the "Test
// connection" button in Settings so a typo surfaces immediately, not five saves
// later. Clears the cached discovery first so a changed password is re-checked.
export async function verifyConnection(settings) {
  discovery = null;
  const calendarUrl = await resolveCalendarUrl(settings);
  return { calendarUrl };
}

// Ask iCloud which days in the window already hold one of OUR reading blocks
// (matched by event title). Returns a Set of local day keys to skip. Uses a
// calendar-query REPORT filtered to VEVENTs in the range, then reads each
// returned .ics for its SUMMARY/DTSTART. Our own blocks are single (non-
// recurring) events, so there's no recurrence to expand here.
async function getBlockedDays(calendarUrl, settings, timeMin, timeMax) {
  const title = settings.eventTitle || "Reading Block";
  const res = await dav(
    calendarUrl,
    {
      method: "REPORT",
      depth: 1,
      contentType: "application/xml; charset=utf-8",
      body: calendarQueryBody(timeMin, timeMax),
    },
    settings
  );

  const days = new Set();
  for (const ics of calendarDataBlocks(res.text)) {
    if (icalProp(ics, "SUMMARY") !== title) continue;
    const dt = icalProp(ics, "DTSTART");
    if (dt) days.add(localDateKey(parseICalDate(dt)));
  }
  return days;
}

// ===========================================================================
// Request bodies (XML). Kept as constants/builders so the calls above read
// cleanly. Namespaces: DAV: for WebDAV props, urn:...:caldav for calendar ones.
// ===========================================================================

const PROPFIND_PRINCIPAL =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<A:propfind xmlns:A="DAV:"><A:prop><A:current-user-principal/></A:prop></A:propfind>`;

const PROPFIND_HOME =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
  `<A:prop><C:calendar-home-set/></A:prop></A:propfind>`;

const PROPFIND_CALENDARS =
  `<?xml version="1.0" encoding="utf-8"?>` +
  `<A:propfind xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
  `<A:prop><A:displayname/><A:resourcetype/>` +
  `<C:supported-calendar-component-set/></A:prop></A:propfind>`;

// A calendar-query for every VEVENT overlapping the window, asking the server to
// `expand` recurring events into concrete timed instances so we don't have to
// interpret RRULEs ourselves. Used to compute busy time (iCloud rejects the
// dedicated free-busy-query REPORT).
function busyEventsQueryBody(start, end) {
  const s = fmtICalUTC(start);
  const e = fmtICalUTC(end);
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<C:calendar-query xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<A:prop><C:calendar-data><C:expand start="${s}" end="${e}"/></C:calendar-data></A:prop>` +
    `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">` +
    `<C:time-range start="${s}" end="${e}"/>` +
    `</C:comp-filter></C:comp-filter></C:filter>` +
    `</C:calendar-query>`
  );
}

function calendarQueryBody(start, end) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<C:calendar-query xmlns:A="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<A:prop><C:calendar-data/></A:prop>` +
    `<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">` +
    `<C:time-range start="${fmtICalUTC(start)}" end="${fmtICalUTC(end)}"/>` +
    `</C:comp-filter></C:comp-filter></C:filter>` +
    `</C:calendar-query>`
  );
}

// ===========================================================================
// iCalendar (.ics) building
// ===========================================================================

// Assemble a minimal VEVENT wrapped in a VCALENDAR, with a 10-minute-before
// alarm to match the Google version's reminder. Times are written in UTC (the
// trailing Z), which is unambiguous: iCloud will still show the block at the
// right local time because a UTC instant pins the exact moment.
function buildVEvent({ uid, start, end, summary, description }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Reading Block//iCloud//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${fmtICalUTC(new Date())}`,
    `DTSTART:${fmtICalUTC(start)}`,
    `DTEND:${fmtICalUTC(end)}`,
    `SUMMARY:${escapeICalText(summary)}`,
    `DESCRIPTION:${escapeICalText(description)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reading block",
    "TRIGGER:-PT10M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // iCalendar requires CRLF line endings and folding of long lines.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// Escape the reserved characters in an iCal text value: backslash, comma,
// semicolon, and newlines (which become a literal \n).
function escapeICalText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Fold lines longer than 75 octets by inserting CRLF + a leading space. We fold
// on characters (close enough for our mostly-ASCII content; a byte-accurate
// fold is the refinement to make if non-ASCII titles misbehave).
function foldLine(line) {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 74) {
    parts.push(" " + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  parts.push(" " + rest);
  return parts.join("\r\n");
}

// Format the saved items into a tidy, clickable description (same as Google's).
function buildDescription(items) {
  const lines = items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}`);
  return ["Your reading list for this session:", "", ...lines, "", "Booked by Reading Block"].join("\n");
}

// ===========================================================================
// Parsing helpers — the "no DOMParser" workarounds.
// ===========================================================================

// --- Deriving busy intervals from the events in the window -------------------
// The calendar-query returns one <calendar-data> per matching resource; with
// `expand`, a recurring event's resource holds several concrete VEVENT instances.
// So we split every VEVENT out and turn each into a {start, end} busy interval.
function parseBusyFromCalendarData(xml) {
  const busy = [];
  for (const cal of calendarDataBlocks(xml)) {
    for (const ve of splitVEvents(cal)) {
      // Skip events that don't actually occupy the calendar: transparent ones
      // (marked "free") and cancelled ones.
      if ((icalProp(ve, "TRANSP") || "").toUpperCase() === "TRANSPARENT") continue;
      if ((icalProp(ve, "STATUS") || "").toUpperCase() === "CANCELLED") continue;

      const startRaw = icalProp(ve, "DTSTART");
      if (!startRaw) continue;
      // All-day events (DATE only, no time) don't block specific hours; ignore
      // them so a reading block can still land on a day that has one.
      if (/^\d{8}$/.test(startRaw.trim())) continue;

      const start = parseICalDate(startRaw);
      let end;
      const endRaw = icalProp(ve, "DTEND");
      if (endRaw) {
        end = parseICalDate(endRaw);
      } else {
        const dur = icalProp(ve, "DURATION");
        end = dur ? new Date(start.getTime() + parseICalDuration(dur)) : null;
      }
      if (!end || end <= start) continue; // zero-length or unparseable → ignore
      busy.push({ start, end });
    }
  }
  return busy;
}

// Split an iCalendar string into its VEVENT bodies (the text between each
// BEGIN:VEVENT and END:VEVENT). One expanded resource can hold many.
function splitVEvents(ics) {
  const out = [];
  const parts = String(ics).split(/BEGIN:VEVENT/i);
  for (let i = 1; i < parts.length; i++) {
    const endIdx = parts[i].search(/END:VEVENT/i);
    out.push(endIdx >= 0 ? parts[i].slice(0, endIdx) : parts[i]);
  }
  return out;
}

// Parse an iCal timestamp. Handles UTC ("20260705T140000Z"), floating/local
// ("20260705T140000" — interpreted in local time), and all-day ("20260705").
function parseICalDate(value) {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return new Date(v); // last-ditch; shouldn't normally hit
  const [, y, mo, d, hh = "0", mm = "0", ss = "0", z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss));
  return new Date(+y, +mo - 1, +d, +hh, +mm, +ss);
}

// Parse an iCal/ISO-8601 duration like "PT30M", "PT1H30M", "P1D" into ms.
function parseICalDuration(value) {
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => (x == null ? 0 : Number(x)));
  return ((+d * 24 + +h) * 60 + +min) * 60_000 + +s * 1000;
}

// Read a single property line's value out of a VEVENT block, e.g.
// icalProp(ics, "DTSTART") from "DTSTART;TZID=...:20260705T140000". Returns the
// text after the colon (params before it stripped), for the first match.
function icalProp(icsText, name) {
  for (const line of unfold(icsText)) {
    // Property name is up to the first ";" or ":".
    const key = line.split(/[;:]/, 1)[0];
    if (key.toUpperCase() === name.toUpperCase()) {
      return line.slice(line.indexOf(":") + 1);
    }
  }
  return null;
}

// Unfold iCalendar content: join any line that begins with a space or tab onto
// the previous one (the reverse of foldLine), then return the array of lines.
function unfold(icsText) {
  const raw = String(icsText).split(/\r?\n/);
  const out = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// --- Parsing XML multistatus (PROPFIND / REPORT) -----------------------------
// All namespace-agnostic: tags are matched by local name, ignoring the prefix
// (A:, D:, C:, caldav:, …) that iCloud may use.

// Every <response>…</response> block in a multistatus document. The
// `(?:\s[^>]*)?>` after the name consumes the whole opening tag (including any
// attributes like xmlns="DAV:") before the content — matching bare tags,
// prefixed tags, and attributed tags alike.
function responseBlocks(xml) {
  return matchAll(xml, /<(?:\w+:)?response(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?response>/gi);
}

// The inner XML of the first <name>…</name> element (any namespace prefix, any
// attributes). Consuming the full opening tag matters: iCloud writes elements
// like <href xmlns="DAV:">…</href>, and stopping at the first space would fold
// the `xmlns="DAV:">` attribute text into the captured value.
function tagBlock(xml, name) {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i"));
  return m ? m[1] : null;
}

// Same as tagBlock but for a self-contained property whose content we want as
// text (used for the property wrapper before we dig for an href inside it).
function propBlock(xml, name) {
  return tagBlock(xml, name) || "";
}

// The trimmed text content of the first <name>…</name> element.
function tagText(xml, name) {
  const inner = tagBlock(xml, name);
  return inner == null ? null : inner.replace(/<[^>]*>/g, "").trim();
}

// The first <href>…</href> value inside a chunk of XML. As above, the opening
// tag (with any xmlns/attributes) is consumed before the captured content.
function firstHrefIn(xml) {
  const m = String(xml).match(/<(?:\w+:)?href(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?href>/i);
  return m ? m[1].trim() : null;
}

// Every <calendar-data>…</calendar-data> payload (the raw .ics text), with XML
// entities unescaped so the iCalendar parses cleanly.
function calendarDataBlocks(xml) {
  return matchAll(xml, /<(?:\w+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/gi, 1).map(
    unescapeXml
  );
}

function matchAll(text, regex, group = 0) {
  const out = [];
  let m;
  while ((m = regex.exec(text)) !== null) out.push(m[group]);
  return out;
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&");
}

// --- URL helpers ------------------------------------------------------------

// Resolve a possibly-relative href against the URL it came from (iCloud returns
// path-only hrefs like "/1234567890/calendars/home/" on the pNN- host).
function absolute(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

// Join a collection URL (which always ends in "/") with a child name.
function joinUrl(collectionUrl, child) {
  return collectionUrl.endsWith("/") ? collectionUrl + child : `${collectionUrl}/${child}`;
}

// Format a Date as an iCal UTC timestamp: 20260705T140000Z.
function fmtICalUTC(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// Test-only: expose the pure parsing/building helpers so they can be unit-tested
// in isolation (see test/caldav.test.js), the same way slots.js stays testable.
// Not used by the extension itself.
export const _internals = {
  parseBusyFromCalendarData,
  splitVEvents,
  parseICalDate,
  parseICalDuration,
  icalProp,
  calendarDataBlocks,
  responseBlocks,
  firstHrefIn,
  propBlock,
  chooseCalendar,
  buildVEvent,
  escapeICalText,
  foldLine,
  unfold,
};
