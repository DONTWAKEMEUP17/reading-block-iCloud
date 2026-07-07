// Tests for the CalDAV messenger (the iCloud calendar integration).
// These focus on the parts that carry real risk: parsing iCloud's XML and
// iCalendar responses (done by hand, since a service worker has no DOMParser),
// and one end-to-end booking with fetch mocked out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { _internals } from "../src/lib/caldav.js";

const {
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
} = _internals;

// --- iCalendar timestamp / duration parsing ---------------------------------

test("parseICalDate reads a UTC timestamp as an absolute instant", () => {
  const d = parseICalDate("20260705T140000Z");
  assert.equal(d.toISOString(), "2026-07-05T14:00:00.000Z");
});

test("parseICalDate reads an all-day date", () => {
  const d = parseICalDate("20260705");
  // Local midnight of that day; assert on the calendar parts, not the instant.
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 6); // July (0-based)
  assert.equal(d.getDate(), 5);
});

test("parseICalDuration handles PT30M, PT1H30M and P1D", () => {
  assert.equal(parseICalDuration("PT30M"), 30 * 60_000);
  assert.equal(parseICalDuration("PT1H30M"), 90 * 60_000);
  assert.equal(parseICalDuration("P1D"), 24 * 60 * 60_000);
});

// --- Busy-time derivation from calendar-query results ------------------------

// Wrap raw .ics text in a multistatus <calendar-data> so parseBusyFromCalendarData
// sees it the way iCloud returns it.
function multistatusWith(...icsBodies) {
  const responses = icsBodies
    .map(
      (ics) =>
        `<response><href>/x.ics</href><propstat><prop>` +
        `<C:calendar-data>${ics}</C:calendar-data>` +
        `</prop></propstat></response>`
    )
    .join("");
  return `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</multistatus>`;
}

test("parseBusyFromCalendarData reads DTSTART/DTEND into busy intervals", () => {
  const xml = multistatusWith(
    "BEGIN:VEVENT\nDTSTART:20260706T140000Z\nDTEND:20260706T150000Z\nEND:VEVENT"
  );
  const busy = parseBusyFromCalendarData(xml);
  assert.equal(busy.length, 1);
  assert.equal(busy[0].start.toISOString(), "2026-07-06T14:00:00.000Z");
  assert.equal(busy[0].end.toISOString(), "2026-07-06T15:00:00.000Z");
});

test("parseBusyFromCalendarData derives end from DURATION when DTEND is absent", () => {
  const xml = multistatusWith("BEGIN:VEVENT\nDTSTART:20260706T140000Z\nDURATION:PT45M\nEND:VEVENT");
  const busy = parseBusyFromCalendarData(xml);
  assert.equal(busy[0].end.toISOString(), "2026-07-06T14:45:00.000Z");
});

test("parseBusyFromCalendarData skips all-day, transparent, and cancelled events", () => {
  const xml = multistatusWith(
    "BEGIN:VEVENT\nDTSTART;VALUE=DATE:20260706\nDTEND;VALUE=DATE:20260707\nEND:VEVENT",
    "BEGIN:VEVENT\nDTSTART:20260706T140000Z\nDTEND:20260706T150000Z\nTRANSP:TRANSPARENT\nEND:VEVENT",
    "BEGIN:VEVENT\nDTSTART:20260706T160000Z\nDTEND:20260706T170000Z\nSTATUS:CANCELLED\nEND:VEVENT"
  );
  assert.equal(parseBusyFromCalendarData(xml).length, 0);
});

test("parseBusyFromCalendarData splits multiple expanded instances in one resource", () => {
  // A recurring event, expanded server-side, arrives as several VEVENTs in one
  // <calendar-data> payload.
  const recurring =
    "BEGIN:VCALENDAR\n" +
    "BEGIN:VEVENT\nDTSTART:20260706T140000Z\nDTEND:20260706T143000Z\nEND:VEVENT\n" +
    "BEGIN:VEVENT\nDTSTART:20260707T140000Z\nDTEND:20260707T143000Z\nEND:VEVENT\n" +
    "END:VCALENDAR";
  assert.equal(splitVEvents(recurring).length, 2);
  assert.equal(parseBusyFromCalendarData(multistatusWith(recurring)).length, 2);
});

// --- XML multistatus parsing -------------------------------------------------

test("firstHrefIn + propBlock pull the principal href out of a PROPFIND reply", () => {
  const xml = `<?xml version="1.0"?>
    <multistatus xmlns="DAV:">
      <response>
        <href>/</href>
        <propstat><prop>
          <current-user-principal><href>/123456/principal/</href></current-user-principal>
        </prop></propstat>
      </response>
    </multistatus>`;
  assert.equal(firstHrefIn(propBlock(xml, "current-user-principal")), "/123456/principal/");
});

test("firstHrefIn handles an href with attributes (iCloud's <href xmlns=...>)", () => {
  // Regression: iCloud writes <href xmlns="DAV:">…</href>. A parser that stops at
  // the first space folds the attribute text into the value and corrupts the URL.
  const xml = `<current-user-principal><href xmlns="DAV:">/21088998733/principal/</href></current-user-principal>`;
  assert.equal(firstHrefIn(propBlock(xml, "current-user-principal")), "/21088998733/principal/");
});

test("tagBlock ignores attributes on the opening tag", () => {
  const xml = `<displayname xmlns="DAV:" lang="en">Work</displayname>`;
  assert.equal(propBlock(xml, "displayname"), "Work");
});

test("responseBlocks splits a multistatus into one block per resource", () => {
  const xml = `<multistatus xmlns="DAV:">
    <response><href>/a/</href></response>
    <response><href>/b/</href></response>
  </multistatus>`;
  const blocks = responseBlocks(xml);
  assert.equal(blocks.length, 2);
  assert.equal(firstHrefIn(blocks[1]), "/b/");
});

// --- Calendar selection ------------------------------------------------------

const CALENDAR_LIST = `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/123456/calendars/</href>
    <propstat><prop><resourcetype><collection/></resourcetype></prop></propstat>
  </response>
  <response>
    <href>/123456/calendars/reminders/</href>
    <propstat><prop>
      <displayname>Reminders</displayname>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    </prop></propstat>
  </response>
  <response>
    <href>/123456/calendars/work/</href>
    <propstat><prop>
      <displayname>Work</displayname>
      <resourcetype><collection/><C:calendar/></resourcetype>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    </prop></propstat>
  </response>
</multistatus>`;

test("chooseCalendar('primary') skips the home + reminders, takes the first VEVENT calendar", () => {
  const url = chooseCalendar(CALENDAR_LIST, "https://p42-caldav.icloud.com/123456/calendars/", "primary");
  assert.equal(url, "https://p42-caldav.icloud.com/123456/calendars/work/");
});

test("chooseCalendar matches a named calendar case-insensitively", () => {
  const url = chooseCalendar(CALENDAR_LIST, "https://p42-caldav.icloud.com/123456/calendars/", "work");
  assert.equal(url, "https://p42-caldav.icloud.com/123456/calendars/work/");
});

test("chooseCalendar returns null when no calendar matches the requested name", () => {
  assert.equal(chooseCalendar(CALENDAR_LIST, "https://p42-caldav.icloud.com/", "Nonexistent"), null);
});

// --- calendar-data (blocked-day detection) ----------------------------------

test("calendarDataBlocks + icalProp read SUMMARY/DTSTART out of a REPORT reply", () => {
  const xml = `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <response>
      <href>/123456/calendars/work/abc.ics</href>
      <propstat><prop>
        <C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:abc
SUMMARY:Reading Block
DTSTART:20260706T140000Z
DTEND:20260706T143000Z
END:VEVENT
END:VCALENDAR</C:calendar-data>
      </prop></propstat>
    </response>
  </multistatus>`;
  const blocks = calendarDataBlocks(xml);
  assert.equal(blocks.length, 1);
  assert.equal(icalProp(blocks[0], "SUMMARY"), "Reading Block");
  assert.equal(icalProp(blocks[0], "DTSTART"), "20260706T140000Z");
});

test("icalProp strips parameters before the colon (e.g. DTSTART;TZID=...)", () => {
  const ics = "BEGIN:VEVENT\r\nDTSTART;TZID=America/New_York:20260706T100000\r\nEND:VEVENT";
  assert.equal(icalProp(ics, "DTSTART"), "20260706T100000");
});

// --- iCalendar building ------------------------------------------------------

test("escapeICalText escapes commas, semicolons, backslashes and newlines", () => {
  assert.equal(escapeICalText("a, b; c\\d\ne"), "a\\, b\\; c\\\\d\\ne");
});

test("foldLine + unfold round-trips a long line", () => {
  const long = "DESCRIPTION:" + "x".repeat(200);
  const folded = foldLine(long);
  assert.ok(folded.includes("\r\n "), "long line should be folded onto continuation lines");
  // Unfolding the folded content should return the original single line.
  assert.deepEqual(unfold(folded), [long]);
});

test("buildVEvent produces a well-formed, escaped VEVENT with an alarm", () => {
  const ics = buildVEvent({
    uid: "test-uid",
    start: new Date("2026-07-06T14:00:00Z"),
    end: new Date("2026-07-06T14:30:00Z"),
    summary: "Reading Block",
    description: "1. Title; with, chars\n   https://example.com",
  });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.includes("UID:test-uid\r\n"));
  assert.ok(ics.includes("DTSTART:20260706T140000Z\r\n"));
  assert.ok(ics.includes("DTEND:20260706T143000Z\r\n"));
  assert.ok(ics.includes("SUMMARY:Reading Block\r\n"));
  assert.ok(ics.includes("TRIGGER:-PT10M\r\n"), "should include the 10-minute-before alarm");
  // The description's reserved characters must be escaped in the output.
  assert.ok(/DESCRIPTION:1\. Title\\; with\\, chars\\n/.test(ics));
});

// --- End-to-end booking with fetch mocked -----------------------------------

test("scheduleReadingBlock walks discovery, reads free/busy, and PUTs the event", async () => {
  // A tiny fake iCloud: route each CalDAV call by method + body, and record the
  // PUT so we can assert on the event that gets created.
  const calls = [];
  let putBody = null;
  let putUrl = null;

  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const body = opts.body || "";
    calls.push(`${method} ${url}`);

    const ok = (text) => ({ ok: true, status: 200, url, text: async () => text });

    if (method === "PROPFIND" && body.includes("current-user-principal")) {
      return ok(`<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop>
        <current-user-principal><href>/123456/principal/</href></current-user-principal>
      </prop></propstat></response></multistatus>`);
    }
    if (method === "PROPFIND" && body.includes("calendar-home-set")) {
      return ok(`<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <response><href>/123456/principal/</href><propstat><prop>
          <C:calendar-home-set><href>https://p42-caldav.icloud.com/123456/calendars/</href></C:calendar-home-set>
        </prop></propstat></response></multistatus>`);
    }
    if (method === "PROPFIND") {
      return ok(CALENDAR_LIST);
    }
    if (method === "REPORT" && body.includes("expand")) {
      // The busy-time query (calendar-query with <expand>): one busy event.
      return ok(
        `<multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><response>` +
          `<href>/x.ics</href><propstat><prop><C:calendar-data>` +
          `BEGIN:VEVENT\nDTSTART:20260706T140000Z\nDTEND:20260706T150000Z\nEND:VEVENT` +
          `</C:calendar-data></prop></propstat></response></multistatus>`
      );
    }
    if (method === "REPORT" && body.includes("calendar-query")) {
      return ok(`<multistatus xmlns="DAV:"></multistatus>`); // no existing reading blocks
    }
    if (method === "PUT") {
      putUrl = url;
      putBody = body;
      return { ok: true, status: 201, url, text: async () => "" };
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };

  try {
    const { scheduleReadingBlock } = await import("../src/lib/caldav.js");
    const settings = {
      appleId: "user@icloud.com",
      appPassword: "abcd-efgh-ijkl-mnop",
      calendarId: "primary",
      eventTitle: "Reading Block",
      days: [0, 1, 2, 3, 4, 5, 6], // any day, so the test is timezone-robust
      windowStart: "00:00",
      windowEnd: "23:59",
      blockMinutes: 30,
      minLeadMinutes: 0,
      lookaheadDays: 14,
    };
    const batch = [{ title: "Hello", url: "https://example.com" }];

    const { event, slot } = await scheduleReadingBlock(batch, settings, {
      now: new Date("2026-07-06T09:00:00Z"),
    });

    // The event was PUT into the discovered Work calendar on the pNN- host.
    assert.match(putUrl, /^https:\/\/p42-caldav\.icloud\.com\/123456\/calendars\/work\/.+\.ics$/);
    assert.equal(event.id, putUrl, "event.id should be the CalDAV URL for later deletion");
    // Unfold first: iCal folds long lines across CRLF+space, so the URL in the
    // DESCRIPTION is only contiguous once continuation lines are rejoined.
    const unfolded = _internals.unfold(putBody).join("\n");
    assert.ok(unfolded.includes("SUMMARY:Reading Block"));
    assert.ok(unfolded.includes("https://example.com"));
    assert.ok(slot.start instanceof Date && slot.end instanceof Date);

    // It really did the full discovery handshake before booking.
    assert.ok(calls.some((c) => c.startsWith("PROPFIND")));
    assert.ok(calls.some((c) => c.startsWith("REPORT")));
    assert.ok(calls.some((c) => c.startsWith("PUT")));
  } finally {
    delete globalThis.fetch;
  }
});
