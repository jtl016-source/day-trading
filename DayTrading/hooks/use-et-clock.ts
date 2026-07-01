import { useEffect, useState } from 'react';

// ── ET clock + market open/closed (port of useETClock from the mockup) ────────
// Uses Intl with timeZone 'America/New_York' — already proven to work in this app
// (index.tsx / chart-view.tsx), so no luxon/dayjs fallback is needed.
export interface ETClock {
  time: string;   // HH:MM:SS
  hm: string;     // HH:MM
  date: string;   // Wed, Jun 4
  open: boolean;  // RTH 09:30–16:00 ET, Mon–Fri
}

export function useETClock(): ETClock {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const tz = 'America/New_York';
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz }).format(now);
  const hm   = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(now);
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }).format(now);
  const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).formatToParts(now);

  const wd = parts.find(p => p.type === 'weekday')?.value;
  const h  = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10) % 24;
  const m  = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
  const mins = h * 60 + m;
  const weekday = !['Sat', 'Sun'].includes(wd ?? '');
  const open = weekday && mins >= 570 && mins < 1020; // 09:30–17:00 ET (RTH)

  return { time, hm, date, open };
}
