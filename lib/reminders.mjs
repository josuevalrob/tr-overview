/**
 * Results-day reminders: a calendar event with alerts, one upcoming per stock.
 *
 *   const rem = createReminders(dataDir)
 *   await rem.add({ key, name, date, time, what, note, alerts, calendar })   the event made
 *   rem.list()                                                              every reminder, by date
 *   await rem.remove(key)                                                   its upcoming reminder gone
 *
 * macOS: straight into the Calendar app (osascript; values passed as arguments, never pasted into
 * the script). Elsewhere: an .ics file in data/reminders/ to open or import.
 * Adding again for a stock with an upcoming reminder moves it (an estimated date that got confirmed).
 * Kept in data/reminders.json - the calendar remembered there is the default for the next one.
 * Times are local to this machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const MAC = process.platform === 'darwin';
const DEFAULT_ALERTS = [-1440, 0];                  // minutes from the start: the day before, and at it

const ADD = `on run argv
  set {calName, evTitle, y, m, d, hh, mm, dur, evLoc, evNotes, alertList} to argv
  set dt to current date
  set day of dt to 1
  set year of dt to (y as integer)
  set month of dt to (m as integer)
  set day of dt to (d as integer)
  set time of dt to ((hh as integer) * hours + (mm as integer) * minutes)
  tell application "Calendar"
    if calName is "" then set calName to name of first calendar whose writable is true
    set ev to make new event at end of events of calendar calName with properties {summary:evTitle, start date:dt, end date:dt + (dur as integer) * minutes, location:evLoc, description:evNotes}
    set AppleScript's text item delimiters to ","
    if alertList is not "" then
      repeat with a in text items of alertList
        make new display alarm at end of display alarms of ev with properties {trigger interval:(a as integer)}
      end repeat
    end if
    return (uid of ev) & linefeed & calName
  end tell
end run`;

const REMOVE = `on run argv
  set {calName, evUid} to argv
  tell application "Calendar"
    set evs to (every event of calendar calName whose uid is evUid)
    set n to count of evs
    repeat with ev in evs
      delete ev
    end repeat
    return n
  end tell
end run`;

const osa = (script, args) => new Promise((ok, fail) =>
  execFile('osascript', ['-e', script, ...args.map(String)], { timeout: 60000 }, (err, out, errOut) =>
    err ? fail(new Error(`Calendar: ${(errOut || err.message).trim()}`)) : ok(out.trim())));

const pad = n => String(n).padStart(2, '0');
const icsText = s => String(s ?? '').replace(/[\\;,]/g, c => `\\${c}`).replace(/\n/g, '\\n');

function ics(r, uid) {
  const [y, m, d] = r.date.split('-'), [hh, mm] = r.time.split(':');
  const start = new Date(+y, +m - 1, +d, +hh, +mm), end = new Date(start.getTime() + 30 * 60000);
  const local = t => `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}T${pad(t.getHours())}${pad(t.getMinutes())}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//tr-overview//reminders//EN', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${stamp}`, `DTSTART:${local(start)}`, `DTEND:${local(end)}`,
    `SUMMARY:${icsText(r.title)}`, ...(r.link ? [`LOCATION:${icsText(r.link)}`] : []), `DESCRIPTION:${icsText(r.notes)}`,
    ...r.alerts.flatMap(a => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(r.title)}`,
      `TRIGGER${a < 0 ? '' : ';RELATED=START'}:${a < 0 ? '-' : ''}PT${Math.abs(a)}M`, 'END:VALARM']),
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

export function createReminders(dataDir) {
  const FILE = path.join(dataDir, 'reminders.json'), DIR = path.join(dataDir, 'reminders');
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { calendar: null, reminders: [] }; } };
  const write = s => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n'); };
  const today = () => { const t = new Date(); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };

  async function drop(r) {                          // the event itself, wherever it was made
    if (r.uid && r.calendar && MAC) await osa(REMOVE, [r.calendar, r.uid]).catch(() => null);
    if (r.file) fs.rmSync(r.file, { force: true });
  }

  return {
    list: () => read().reminders.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),

    async add({ key, name, date, time = '08:00', what = 'results', note = '', link = '', alerts = DEFAULT_ALERTS, calendar }) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('date as YYYY-MM-DD');
      if (!/^\d{1,2}:\d{2}$/.test(String(time))) throw new Error('time as HH:MM');
      if (date < today()) throw new Error(`${date} is past`);
      if (!Array.isArray(alerts) || alerts.some(a => !Number.isInteger(a))) throw new Error('alerts: whole minutes from the start, e.g. [-1440, 0]');
      const s = read(), cal = calendar || s.calendar || '';
      const r = { key, name, date, time: time.padStart(5, '0'), what, title: `${name}: ${what}`, link, alerts,
        notes: [note, link, `${key} · added by tr-overview`].filter(Boolean).join('\n') };
      for (const old of s.reminders.filter(x => x.key === key && x.date >= today())) await drop(old);
      s.reminders = s.reminders.filter(x => !(x.key === key && x.date >= today()));
      const [y, m, d] = date.split('-'), [hh, mm] = r.time.split(':');
      if (MAC) {
        const [uid, used] = (await osa(ADD, [cal, r.title, y, m, d, hh, mm, 30, link, r.notes, alerts.join(',')])).split('\n');
        Object.assign(r, { uid, calendar: used });
        s.calendar = used;
      } else {
        const uid = `${key}-${date}@tr-overview`, file = path.join(DIR, `${key}-${date}.ics`);
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(file, ics(r, uid));
        Object.assign(r, { uid, file });
      }
      const kept = { key, name, date, time: r.time, what, alerts, uid: r.uid, ...(r.calendar ? { calendar: r.calendar } : { file: r.file }), added: today() };
      s.reminders.push(kept);
      write(s);
      return kept;
    },

    async remove(key) {
      const s = read(), gone = s.reminders.filter(x => x.key === key && x.date >= today());
      for (const r of gone) await drop(r);
      s.reminders = s.reminders.filter(x => !gone.includes(x));
      write(s);
      return gone;
    },
  };
}
