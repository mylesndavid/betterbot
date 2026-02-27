import { refreshAccessToken } from './google-auth.js';

const BASE_URL = 'https://www.googleapis.com/calendar/v3';

/**
 * Get a valid access token (refreshes automatically if expired).
 */
export async function getAccessToken() {
  return refreshAccessToken();
}

/**
 * Fetch wrapper for Google Calendar API v3.
 */
async function gcalAPI(path, opts = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 10_000),
  });

  if (res.status === 204) return null; // DELETE returns no content

  const data = await res.json();
  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data.error) || res.statusText;
    throw new Error(`Google Calendar API error (${res.status}): ${msg}`);
  }
  return data;
}

/**
 * List the user's calendars.
 */
export async function listCalendars() {
  const data = await gcalAPI('/users/me/calendarList');
  return (data.items || []).map(cal => ({
    id: cal.id,
    summary: cal.summary,
    primary: cal.primary || false,
    accessRole: cal.accessRole,
  }));
}

/**
 * Get the user's primary calendar ID (falls back to 'primary').
 */
async function getPrimaryCalendarId() {
  try {
    const calendars = await listCalendars();
    const primary = calendars.find(c => c.primary);
    return primary ? primary.id : 'primary';
  } catch {
    return 'primary';
  }
}

/**
 * Format an event for display.
 */
function formatEvent(event) {
  const start = event.start?.dateTime || event.start?.date || '';
  const end = event.end?.dateTime || event.end?.date || '';

  // Format time for display
  let timeStr;
  if (event.start?.dateTime) {
    const s = new Date(start);
    const e = new Date(end);
    const fmt = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    timeStr = `${fmt(s)} – ${fmt(e)}`;
  } else {
    timeStr = 'All day';
  }

  const parts = [`${timeStr}: ${event.summary || '(No title)'}  [id: ${event.id}]`];
  if (event.location) parts.push(`  Location: ${event.location}`);
  if (event.description) parts.push(`  Notes: ${event.description.slice(0, 200)}`);
  if (event.attendees?.length) {
    const names = event.attendees.map(a => a.displayName || a.email).join(', ');
    parts.push(`  Attendees: ${names}`);
  }
  return parts.join('\n');
}

/**
 * Get events in a time range for a calendar.
 */
export async function getEvents(calendarId, timeMin, timeMax) {
  const params = new URLSearchParams({
    timeMin: new Date(timeMin).toISOString(),
    timeMax: new Date(timeMax).toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });

  const data = await gcalAPI(`/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  return data.items || [];
}

/**
 * Get upcoming events across all calendars within the next N hours.
 */
export async function getUpcoming(hours = 24) {
  const now = new Date();
  const until = new Date(now.getTime() + hours * 60 * 60 * 1000);

  const calendars = await listCalendars();
  const writable = calendars.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');

  const allEvents = [];
  const fetches = writable.map(async (cal) => {
    try {
      const events = await getEvents(cal.id, now, until);
      for (const e of events) {
        e._calendar = cal.summary;
        allEvents.push(e);
      }
    } catch { /* individual calendar failure is non-fatal */ }
  });

  await Promise.all(fetches);

  // Sort by start time
  allEvents.sort((a, b) => {
    const aTime = new Date(a.start?.dateTime || a.start?.date).getTime();
    const bTime = new Date(b.start?.dateTime || b.start?.date).getTime();
    return aTime - bTime;
  });

  return allEvents;
}

/**
 * Format a list of events for display.
 */
export function formatEvents(events) {
  if (events.length === 0) return 'No events found.';
  return events.map(e => {
    const prefix = e._calendar ? `[${e._calendar}] ` : '';
    return prefix + formatEvent(e);
  }).join('\n\n');
}

/**
 * Create an event on a calendar.
 */
export async function createEvent(calendarId, { summary, start, end, description, location, attendees }) {
  calendarId = calendarId || await getPrimaryCalendarId();

  const event = { summary };

  // Handle all-day vs timed events
  if (start && !start.includes('T') && !end) {
    // All-day event (just a date)
    event.start = { date: start };
    event.end = { date: start };
  } else {
    event.start = { dateTime: new Date(start).toISOString() };
    event.end = { dateTime: new Date(end || new Date(new Date(start).getTime() + 60 * 60 * 1000)).toISOString() };
  }

  if (description) event.description = description;
  if (location) event.location = location;
  if (attendees) {
    event.attendees = attendees.map(a => typeof a === 'string' ? { email: a } : a);
  }

  return gcalAPI(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: event,
  });
}

/**
 * Quick add — natural language event creation.
 * e.g., "Lunch with Bob tomorrow at noon"
 */
export async function quickAdd(calendarId, text) {
  calendarId = calendarId || await getPrimaryCalendarId();
  return gcalAPI(`/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?text=${encodeURIComponent(text)}`, {
    method: 'POST',
  });
}

/**
 * Update an existing event.
 */
export async function updateEvent(calendarId, eventId, changes) {
  calendarId = calendarId || await getPrimaryCalendarId();

  // Fetch current event first to merge changes
  const current = await gcalAPI(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);

  const updated = { ...current };
  if (changes.summary !== undefined) updated.summary = changes.summary;
  if (changes.description !== undefined) updated.description = changes.description;
  if (changes.location !== undefined) updated.location = changes.location;
  if (changes.start) updated.start = { dateTime: new Date(changes.start).toISOString() };
  if (changes.end) updated.end = { dateTime: new Date(changes.end).toISOString() };
  if (changes.attendees) {
    updated.attendees = changes.attendees.map(a => typeof a === 'string' ? { email: a } : a);
  }

  return gcalAPI(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PUT',
    body: updated,
  });
}

/**
 * Delete an event.
 */
export async function deleteEvent(calendarId, eventId) {
  calendarId = calendarId || await getPrimaryCalendarId();
  await gcalAPI(`/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
  return true;
}

/**
 * Find free/busy slots for a given date.
 */
export async function findFreeSlots(calendarId, date) {
  calendarId = calendarId || await getPrimaryCalendarId();

  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const data = await gcalAPI('/freeBusy', {
    method: 'POST',
    body: {
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      items: [{ id: calendarId }],
    },
  });

  const busy = data.calendars?.[calendarId]?.busy || [];
  return {
    busy: busy.map(b => ({
      start: new Date(b.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
      end: new Date(b.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
    })),
    date: dayStart.toISOString().split('T')[0],
  };
}
