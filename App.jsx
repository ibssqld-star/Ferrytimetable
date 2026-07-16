import { useState, useEffect, useCallback } from 'react';
import { Anchor, MapPin, Clock, RefreshCw, ExternalLink, Navigation, AlertTriangle } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ---- Terminal locations ----
const TERMINALS = {
  russell: { key: 'russell', name: 'Russell Island', full: 'Russell Island ferry terminal', lat: -27.645961, lon: 153.38233 },
  redland: { key: 'redland', name: 'Redland Bay', full: 'Redland Bay Marina', lat: -27.6180125, lon: 153.3115356 },
};

const userIcon = L.divIcon({
  className: '',
  html: '<div class="map-pin map-pin-user"><span></span></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});
const terminalIcon = L.divIcon({
  className: '',
  html: '<div class="map-pin map-pin-terminal"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

// Fits the map view to whichever marker(s) are present whenever they change.
function MapBoundsUpdater({ points }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 14);
    } else {
      map.fitBounds(points, { padding: [32, 32], maxZoom: 15 });
    }
  }, [map, points]);
  return null;
}

const AVG_SPEED_KMH = 32; // conservative local-road estimate
const BOARD_BUFFER_MIN = 20; // SeaLink recommends arriving 20 min before departure
const CROSSING_MIN = 30; // approx one-way passenger ferry crossing time (published guides put it ~20-33 min depending on direction)
const PREFS_KEY = 'ferry-tracker:prefs';

// ---- Helpers ----
function toRad(d) { return (d * Math.PI) / 180; }

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtTime(d) {
  return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function fmtMinsUntil(mins) {
  const m = Math.max(0, mins);
  if (m < 1) return 'due now';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function toDatetimeLocalValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseTimeOnDate(timeStr, baseDate) {
  if (!timeStr) return null;
  const m = timeStr.trim().match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM|am|pm)/);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = m[2] ? parseInt(m[2], 10) : 0;
  if (/pm/i.test(m[3]) && hh !== 12) hh += 12;
  if (/am/i.test(m[3]) && hh === 12) hh = 0;
  const d = new Date(baseDate);
  d.setHours(hh, mm, 0, 0);
  return d;
}

// Honest fallback pattern: published sources put the service at ~2-4 sailings/hr,
// roughly 4:30am-10:30pm. This is a labelled approximation, not scraped fact.
function approxSchedule(baseDate) {
  const times = [];
  let t = new Date(baseDate);
  t.setHours(4, 30, 0, 0);
  const end = new Date(baseDate);
  end.setHours(22, 30, 0, 0);
  while (t <= end) {
    times.push(new Date(t));
    t = new Date(t.getTime() + 30 * 60000);
  }
  return times;
}

function storageGet(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // storage unavailable (e.g. private browsing) — fail silently
  }
}

export default function FerryTracker() {
  const [now, setNow] = useState(new Date());
  const [geoStatus, setGeoStatus] = useState('locating'); // locating|granted|denied|unsupported
  const [coords, setCoords] = useState(null);
  const [manualMin, setManualMin] = useState(null);
  const [direction, setDirection] = useState(null); // manual override, else null = auto
  const [autoDirection, setAutoDirection] = useState('toRedland');
  const [live, setLive] = useState({ status: 'idle', departures: [], note: '', checkedAt: null });
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [route, setRoute] = useState({ status: 'idle', coords: [], distanceKm: null, durationMin: null });
  const [customTime, setCustomTime] = useState(null); // null = live "now"; otherwise a chosen planning Date
  const [timeMode, setTimeMode] = useState('leave'); // 'leave' = customTime is a departure reference, 'arrive' = customTime is a desired arrival deadline
  const [showTimePicker, setShowTimePicker] = useState(false);

  const effectiveDirection = direction || autoDirection;
  const effectiveNow = customTime || now;

  // Clock tick
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // Load saved prefs (localStorage — persists per browser, same as any normal web app)
  useEffect(() => {
    const prefs = storageGet(PREFS_KEY);
    if (prefs) {
      if (prefs.direction) setDirection(prefs.direction);
      if (prefs.manualMin != null) setManualMin(prefs.manualMin);
    }
    setPrefsLoaded(true);
  }, []);

  // Save prefs on change
  useEffect(() => {
    if (!prefsLoaded) return;
    storageSet(PREFS_KEY, { direction, manualMin });
  }, [direction, manualMin, prefsLoaded]);

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setGeoStatus('unsupported');
      return;
    }
    setGeoStatus('locating');
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude });
          setGeoStatus('granted');
        },
        () => setGeoStatus('denied'),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 120000 }
      );
    } catch (e) {
      setGeoStatus('denied');
    }
  }, []);

  useEffect(() => {
    locate();
  }, [locate]);

  useEffect(() => {
    if (!coords) return;
    const dRussell = distanceKm(coords.lat, coords.lon, TERMINALS.russell.lat, TERMINALS.russell.lon);
    const dRedland = distanceKm(coords.lat, coords.lon, TERMINALS.redland.lat, TERMINALS.redland.lon);
    setAutoDirection(dRedland < dRussell ? 'toRussell' : 'toRedland');
  }, [coords]);

  const origin = effectiveDirection === 'toRussell' ? TERMINALS.redland : TERMINALS.russell;
  const dest = effectiveDirection === 'toRussell' ? TERMINALS.russell : TERMINALS.redland;

  let distKm = null;
  if (coords) distKm = distanceKm(coords.lat, coords.lon, origin.lat, origin.lon);

  const hasRoute = route.status === 'success' && route.coords.length > 0;
  // Prefer the real driving route's time/distance; fall back to the straight-line estimate.
  const driveMin = hasRoute
    ? route.durationMin
    : distKm != null
    ? Math.max(1, Math.round((distKm / AVG_SPEED_KMH) * 60))
    : manualMin;
  const displayDistKm = hasRoute ? route.distanceKm : distKm;

  // Free public routing (OSRM demo server, no API key) for an actual road route,
  // instead of a straight line between the two points.
  const fetchRoute = useCallback(async (userCoords, terminal) => {
    setRoute((prev) => ({ ...prev, status: 'loading' }));
    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${userCoords.lon},${userCoords.lat};${terminal.lon},${terminal.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('routing unavailable');
      const data = await res.json();
      const r = data.routes && data.routes[0];
      if (!r) throw new Error('no route found');
      const latlngs = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      setRoute({
        status: 'success',
        coords: latlngs,
        distanceKm: r.distance / 1000,
        durationMin: Math.max(1, Math.round(r.duration / 60)),
      });
    } catch (e) {
      setRoute({ status: 'error', coords: [], distanceKm: null, durationMin: null });
    }
  }, []);

  useEffect(() => {
    if (coords) {
      fetchRoute(coords, origin);
    } else {
      setRoute({ status: 'idle', coords: [], distanceKm: null, durationMin: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coords, effectiveDirection]);

  // Calls a same-origin serverless endpoint (see api/next-ferry.js) instead of
  // Claude's built-in API proxy, which only exists inside Claude.ai artifacts.
  // With no ANTHROPIC_API_KEY configured server-side, that endpoint just
  // returns no departures, and this falls back to the approximate schedule below.
  const fetchLive = useCallback(async (dir, referenceTime) => {
    setLive((prev) => ({ ...prev, status: 'loading' }));
    try {
      const originT = dir === 'toRussell' ? TERMINALS.redland : TERMINALS.russell;
      const destT = dir === 'toRussell' ? TERMINALS.russell : TERMINALS.redland;
      const res = await fetch('/api/next-ferry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originName: originT.full,
          destName: destT.full,
          nowISO: (referenceTime || new Date()).toISOString(),
        }),
      });
      if (!res.ok) throw new Error('live endpoint unavailable');
      const parsed = await res.json();
      if (parsed.departures && parsed.departures.length) {
        setLive({ status: 'success', departures: parsed.departures, note: parsed.note || '', checkedAt: new Date() });
      } else {
        setLive({ status: 'error', departures: [], note: parsed.note || '', checkedAt: new Date() });
      }
    } catch (e) {
      setLive((prev) => ({ ...prev, status: 'error', checkedAt: new Date() }));
    }
  }, []);

  useEffect(() => {
    fetchLive(effectiveDirection, customTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveDirection, customTime]);

  const usingFallback = live.status !== 'success';
  let displayDepartures = [];
  if (!usingFallback) {
    displayDepartures = live.departures
      .map((s) => {
        const d = parseTimeOnDate(s, effectiveNow);
        if (d && d < effectiveNow) d.setDate(d.getDate() + 1);
        return d;
      })
      .filter(Boolean)
      .sort((a, b) => a - b);
  }
  if (displayDepartures.length === 0) {
    let sched = approxSchedule(effectiveNow).filter((d) => d > effectiveNow);
    if (sched.length < 4) {
      const tomorrow = new Date(effectiveNow);
      tomorrow.setDate(tomorrow.getDate() + 1);
      sched = sched.concat(approxSchedule(tomorrow));
    }
    displayDepartures = sched.slice(0, 4);
  }

  // In "arrive by" mode, customTime is a deadline: find the latest departure
  // that (departure + crossing estimate) still lands at or before it.
  let arriveByDeparture = null;
  let arriveByArrival = null;
  let arriveByEarliestArrival = null; // fallback suggestion when nothing fits
  if (timeMode === 'arrive' && customTime) {
    const daySchedule = approxSchedule(new Date(customTime));
    const reachable = daySchedule.filter((d) => d >= now);
    const valid = reachable.filter((d) => d.getTime() + CROSSING_MIN * 60000 <= customTime.getTime());
    if (valid.length) {
      arriveByDeparture = valid[valid.length - 1];
      arriveByArrival = new Date(arriveByDeparture.getTime() + CROSSING_MIN * 60000);
    } else if (reachable.length) {
      arriveByEarliestArrival = new Date(reachable[0].getTime() + CROSSING_MIN * 60000);
    }
  }

  const inArriveMode = timeMode === 'arrive' && !!customTime;
  const nextDep = inArriveMode ? arriveByDeparture : displayDepartures[0] || null;
  const countdownRef = inArriveMode ? now : effectiveNow;
  const minsUntilNext = nextDep ? Math.round((nextDep - countdownRef) / 60000) : null;
  const leaveBy =
    nextDep && driveMin != null ? new Date(nextDep.getTime() - (driveMin + BOARD_BUFFER_MIN) * 60000) : null;
  const leaveByPast = leaveBy && leaveBy <= now;

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Manrope:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; }
        .app { min-height:100vh; background:radial-gradient(ellipse at top, #123B41 0%, #0B2B30 55%, #071D21 100%); font-family:'Manrope',system-ui,sans-serif; color:#F5EEDC; display:flex; justify-content:center; padding:20px 14px 40px; }
        .wrap { width:100%; max-width:440px; }
        .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
        .brand { display:flex; align-items:center; gap:7px; font-weight:800; font-size:15px; }
        .brand svg { color:#6FE3A6; }
        .header-right { display:flex; align-items:center; gap:8px; }
        .date { font-size:11.5px; color:#9DBFB9; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; }
        .locate-btn { background:rgba(245,238,220,0.08); border:1px solid rgba(245,238,220,0.14); color:#F5EEDC; padding:6px; border-radius:8px; cursor:pointer; display:flex; }
        .locate-btn:focus-visible { outline:2px solid #6FE3A6; outline-offset:2px; }
        .direction-toggle { display:flex; gap:6px; margin-bottom:14px; background:rgba(245,238,220,0.06); padding:4px; border-radius:12px; }
        .time-row { display:flex; align-items:center; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
        .time-mode-tabs { display:flex; gap:6px; margin-bottom:8px; }
        .mode-tab { border:none; background:rgba(245,238,220,0.06); color:#9DBFB9; font-family:inherit; font-size:11px; font-weight:700; padding:6px 12px; border-radius:99px; cursor:pointer; }
        .mode-tab.active { background:rgba(111,227,166,0.16); color:#6FE3A6; }
        .mode-tab:focus-visible { outline:2px solid #6FE3A6; outline-offset:2px; }
        .plan-time-chip { display:flex; align-items:center; gap:5px; background:rgba(245,238,220,0.07); border:1px solid rgba(245,238,220,0.14); color:#9DBFB9; font-family:inherit; font-size:11.5px; font-weight:700; padding:6px 10px; border-radius:99px; cursor:pointer; }
        .plan-time-chip.active { background:rgba(240,130,74,0.14); border-color:rgba(240,130,74,0.4); color:#F0824A; }
        .plan-time-chip:focus-visible { outline:2px solid #6FE3A6; outline-offset:2px; }
        .time-input { background:#0B2B30; border:1px solid rgba(245,238,220,0.2); color:#F5EEDC; font-family:inherit; font-size:12px; font-weight:600; padding:6px 8px; border-radius:8px; }
        .time-input:focus-visible { outline:2px solid #6FE3A6; outline-offset:2px; }
        .dir-btn { flex:1; border:none; background:transparent; color:#9DBFB9; font-family:inherit; font-size:12px; font-weight:700; padding:9px 4px; border-radius:9px; cursor:pointer; }
        .dir-btn .arrow { opacity:0.55; margin:0 2px; }
        .dir-btn.active { background:#123B41; color:#F5EEDC; box-shadow:0 1px 0 rgba(245,238,220,0.08) inset; }
        .dir-btn:focus-visible { outline:2px solid #6FE3A6; outline-offset:2px; }
        .hero { background:#123B41; border:1px solid rgba(245,238,220,0.1); border-radius:20px; padding:22px 20px 20px; margin-bottom:14px; text-align:center; }
        .hero-label { display:flex; align-items:center; justify-content:center; gap:8px; font-size:11px; font-weight:800; letter-spacing:0.14em; color:#9DBFB9; margin-bottom:12px; }
        .badge { font-size:9.5px; font-weight:800; letter-spacing:0.06em; padding:2px 7px; border-radius:99px; }
        .badge.live { background:rgba(111,227,166,0.18); color:#6FE3A6; }
        .badge.approx { background:rgba(240,130,74,0.16); color:#F0824A; }
        .badge.checking { background:rgba(157,191,185,0.15); color:#9DBFB9; }
        .board { font-family:'Space Mono',monospace; font-weight:700; font-size:clamp(40px,12vw,54px); letter-spacing:0.03em; background:#082024; border-radius:14px; padding:16px 10px; color:#6FE3A6; text-shadow:0 0 18px rgba(111,227,166,0.35); box-shadow:inset 0 2px 8px rgba(0,0,0,0.45); animation:boardIn .35s ease; }
        @keyframes boardIn { from{opacity:0; transform:translateY(4px);} to{opacity:1; transform:translateY(0);} }
        @media (prefers-reduced-motion:reduce) { .board{animation:none;} }
        .hero-sub { margin-top:12px; font-size:13px; color:#C9DFDA; font-weight:600; }
        .stats { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:14px; }
        .stat-card { background:#123B41; border:1px solid rgba(245,238,220,0.1); border-radius:16px; padding:14px; min-height:96px; display:flex; flex-direction:column; gap:6px; }
        .stat-card.urgent { border-color:rgba(240,130,74,0.5); background:rgba(240,130,74,0.08); }
        .stat-icon { color:#6FE3A6; }
        .stat-label { font-size:10.5px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#9DBFB9; }
        .stat-value { font-size:19px; font-weight:800; }
        .stat-value.big { font-size:22px; }
        .stat-value.dim { color:#9DBFB9; font-weight:600; font-size:13.5px; }
        .stat-unit { font-size:11.5px; font-weight:600; color:#9DBFB9; }
        .stat-hint { font-size:11px; color:#9DBFB9; }
        .quick-chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:2px; }
        .chip { background:rgba(245,238,220,0.08); border:1px solid rgba(245,238,220,0.14); color:#F5EEDC; font-family:inherit; font-size:10.5px; font-weight:700; padding:6px 8px; border-radius:99px; cursor:pointer; }
        .chip:focus-visible { outline:2px solid #6FE3A6; outline-offset:1px; }
        .link-btn { background:none; border:none; color:#6FE3A6; font-family:inherit; font-size:11px; font-weight:700; cursor:pointer; text-decoration:underline; padding:0; margin-left:4px; }
        .upcoming { margin-bottom:16px; }
        .section-label { font-size:10.5px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#9DBFB9; margin-bottom:8px; }
        .chip-row { display:flex; flex-wrap:wrap; gap:7px; }
        .time-chip { font-family:'Space Mono',monospace; font-size:12.5px; font-weight:700; background:rgba(245,238,220,0.07); border:1px solid rgba(245,238,220,0.12); padding:7px 11px; border-radius:10px; color:#C9DFDA; }
        .footer { border-top:1px solid rgba(245,238,220,0.1); padding-top:12px; }
        .notice { display:flex; align-items:flex-start; gap:6px; font-size:11.5px; color:#F0B58C; margin:0 0 10px; line-height:1.4; }
        .notice svg { flex-shrink:0; margin-top:1px; color:#F0824A; }
        .checked { font-size:10.5px; color:#6E8F8A; margin:0 0 10px; }
        .footer-row { margin-bottom:10px; }
        .refresh-btn { display:flex; align-items:center; gap:5px; background:rgba(245,238,220,0.07); border:1px solid rgba(245,238,220,0.14); color:#F5EEDC; font-family:inherit; font-size:11.5px; font-weight:700; padding:7px 11px; border-radius:10px; cursor:pointer; }
        .refresh-btn:disabled { opacity:0.6; cursor:default; }
        .refresh-btn .spin { animation:spin 1s linear infinite; }
        @keyframes spin { to{transform:rotate(360deg);} }
        @media (prefers-reduced-motion:reduce) { .refresh-btn .spin{animation:none;} }
        .refresh-btn:focus-visible { outline:2px solid #6FE3A6; outline-offset:2px; }
        .footer-links { display:flex; flex-direction:column; gap:6px; }
        .ext-link { display:flex; align-items:center; gap:4px; color:#9DBFB9; font-size:11.5px; font-weight:700; text-decoration:none; width:fit-content; }
        .ext-link:hover { color:#F5EEDC; }
        .ext-link:focus-visible { outline:2px solid #6FE3A6; outline-offset:2px; }
        .leaflet-container { background:#DDD6C4 !important; font-family:'Manrope',system-ui,sans-serif; }
        .map-card { background:#123B41; border:1px solid rgba(245,238,220,0.1); border-radius:16px; padding:12px; margin-bottom:14px; }
        .map-wrap { height:180px; border-radius:12px; overflow:hidden; }
        .map-pin { position:relative; }
        .map-pin-user { width:14px; height:14px; border-radius:50%; background:#6FE3A6; border:2px solid #0B2B30; box-shadow:0 0 0 4px rgba(111,227,166,0.28); }
        .map-pin-user span { position:absolute; inset:-6px; border-radius:50%; border:1.5px solid rgba(111,227,166,0.55); animation:pulseRing 2.2s ease-out infinite; }
        @keyframes pulseRing { 0%{transform:scale(0.6); opacity:0.9;} 100%{transform:scale(1.9); opacity:0;} }
        @media (prefers-reduced-motion:reduce) { .map-pin-user span { animation:none; } }
        .map-pin-terminal { width:12px; height:12px; border-radius:3px; background:#F0824A; border:2px solid #0B2B30; transform:rotate(45deg); }
        .map-legend { display:flex; align-items:center; gap:14px; margin-top:9px; flex-wrap:wrap; padding:0 2px; }
        .legend-item { display:flex; align-items:center; gap:5px; font-size:10.5px; font-weight:700; color:#9DBFB9; }
        .legend-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
        .legend-dot-user { background:#6FE3A6; }
        .legend-dot-terminal { background:#F0824A; border-radius:2px; transform:rotate(45deg); }
        .map-attribution { font-size:9px; color:#5C7C77; margin-left:auto; }
      `}</style>

      <div className="wrap">
        <div className="header">
          <div className="brand">
            <Anchor size={18} strokeWidth={2.25} />
            <span>Next Sailing</span>
          </div>
          <div className="header-right">
            <span className="date">
              {now.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
            <button
              className="locate-btn"
              onClick={() => {
                setDirection(null);
                setManualMin(null);
                locate();
              }}
              aria-label="Use my current location"
            >
              <Navigation size={14} />
            </button>
          </div>
        </div>

        <div className="direction-toggle" role="tablist" aria-label="Direction">
          <button
            role="tab"
            aria-selected={effectiveDirection === 'toRedland'}
            className={`dir-btn ${effectiveDirection === 'toRedland' ? 'active' : ''}`}
            onClick={() => setDirection('toRedland')}
          >
            Russell <span className="arrow">→</span> Redland Bay
          </button>
          <button
            role="tab"
            aria-selected={effectiveDirection === 'toRussell'}
            className={`dir-btn ${effectiveDirection === 'toRussell' ? 'active' : ''}`}
            onClick={() => setDirection('toRussell')}
          >
            Redland Bay <span className="arrow">→</span> Russell
          </button>
        </div>

        <div className="time-mode-tabs">
          <button
            className={`mode-tab ${timeMode === 'leave' ? 'active' : ''}`}
            onClick={() => setTimeMode('leave')}
          >
            Leave at…
          </button>
          <button
            className={`mode-tab ${timeMode === 'arrive' ? 'active' : ''}`}
            onClick={() => setTimeMode('arrive')}
          >
            Arrive by…
          </button>
        </div>

        <div className="time-row">
          <button
            className={`plan-time-chip ${customTime ? 'active' : ''}`}
            onClick={() => setShowTimePicker((v) => !v)}
          >
            <Clock size={12} />
            {customTime
              ? customTime.toLocaleString('en-AU', {
                  weekday: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })
              : timeMode === 'arrive'
              ? 'Pick an arrival time'
              : 'Planning for now'}
          </button>
          {customTime && (
            <button
              className="link-btn"
              onClick={() => {
                setCustomTime(null);
                setShowTimePicker(false);
              }}
            >
              reset
            </button>
          )}
          {showTimePicker && (
            <input
              type="datetime-local"
              className="time-input"
              autoFocus
              defaultValue={toDatetimeLocalValue(customTime || now)}
              onChange={(e) => {
                if (e.target.value) {
                  setCustomTime(new Date(e.target.value));
                  setShowTimePicker(false);
                }
              }}
              onBlur={() => setShowTimePicker(false)}
            />
          )}
        </div>

        <section className="hero" aria-live="polite">
          <div className="hero-label">
            <span>{inArriveMode ? 'CATCH THIS SAILING' : 'NEXT SAILING'}</span>
            {inArriveMode ? (
              <span className="badge approx">Estimate</span>
            ) : live.status === 'success' ? (
              <span className="badge live">Live</span>
            ) : live.status === 'loading' ? (
              <span className="badge checking">Checking…</span>
            ) : (
              <span className="badge approx">Approx.</span>
            )}
          </div>
          <div className="board" key={nextDep ? nextDep.toISOString() : 'none'}>
            {nextDep ? fmtTime(nextDep) : '—'}
          </div>
          <div className="hero-sub">
            {inArriveMode && !nextDep ? (
              arriveByEarliestArrival ? (
                <>No sailing today gets you there by then — earliest possible arrival is ~{fmtTime(arriveByEarliestArrival)}</>
              ) : (
                'No sailings left for that day'
              )
            ) : nextDep && inArriveMode ? (
              <>
                arrives ~{fmtTime(arriveByArrival)} · {origin.name} → {dest.name}
              </>
            ) : nextDep ? (
              <>
                in {fmtMinsUntil(minsUntilNext)} · {origin.name} → {dest.name}
              </>
            ) : (
              'Checking schedule…'
            )}
          </div>
        </section>

        <section className="stats">
          <div className="stat-card">
            <div className="stat-icon">
              <MapPin size={16} />
            </div>
            <div className="stat-label">Your distance</div>
            {geoStatus === 'granted' && displayDistKm != null ? (
              <div className="stat-value">
                {displayDistKm < 1 ? `${Math.round(displayDistKm * 1000)} m` : `${displayDistKm.toFixed(1)} km`}
                <div className="stat-unit">~{driveMin} min drive{!hasRoute ? ' (est.)' : ''}</div>
              </div>
            ) : geoStatus === 'locating' ? (
              <div className="stat-value dim">Locating…</div>
            ) : manualMin != null ? (
              <div className="stat-value">
                ~{manualMin} min
                <button className="link-btn" onClick={() => setManualMin(null)}>
                  change
                </button>
              </div>
            ) : (
              <div className="quick-chips">
                {[0, 5, 10, 20].map((m) => (
                  <button key={m} className="chip" onClick={() => setManualMin(m)}>
                    {m === 0 ? 'At terminal' : `~${m} min`}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className={`stat-card ${leaveByPast ? 'urgent' : ''}`}>
            <div className="stat-icon">
              <Clock size={16} />
            </div>
            <div className="stat-label">Leave by</div>
            <div className="stat-value big">{leaveBy ? (leaveByPast ? 'Now' : fmtTime(leaveBy)) : '—'}</div>
            {driveMin == null && <div className="stat-hint">Set your distance ←</div>}
          </div>
        </section>

        <section className="map-card">
          <div className="map-wrap">
            <MapContainer
              center={coords ? [coords.lat, coords.lon] : [origin.lat, origin.lon]}
              zoom={13}
              scrollWheelZoom={false}
              zoomControl={false}
              attributionControl={false}
              style={{ height: '100%', width: '100%' }}
            >
              <TileLayer url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png" />
              {hasRoute && (
                <Polyline positions={route.coords} pathOptions={{ color: '#E2703A', weight: 4, opacity: 0.9 }} />
              )}
              <Marker position={[origin.lat, origin.lon]} icon={terminalIcon} />
              {coords && <Marker position={[coords.lat, coords.lon]} icon={userIcon} />}
              <MapBoundsUpdater
                points={
                  hasRoute
                    ? route.coords
                    : coords
                    ? [[coords.lat, coords.lon], [origin.lat, origin.lon]]
                    : [[origin.lat, origin.lon]]
                }
              />
            </MapContainer>
          </div>
          <div className="map-legend">
            {coords && (
              <span className="legend-item">
                <span className="legend-dot legend-dot-user" /> You
              </span>
            )}
            <span className="legend-item">
              <span className="legend-dot legend-dot-terminal" /> {origin.name}
            </span>
            <span className="map-attribution">© OpenStreetMap, © CARTO</span>
          </div>
        </section>

        {!inArriveMode && (
          <section className="upcoming">
            <div className="section-label">Coming up</div>
            <div className="chip-row">
              {displayDepartures.slice(1, 4).map((d, i) => (
                <span key={i} className="time-chip">
                  {fmtTime(d)}
                </span>
              ))}
            </div>
          </section>
        )}

        <footer className="footer">
          {usingFallback && (
            <p className="notice">
              <AlertTriangle size={13} />
              Approximate schedule (~every 30 min, based on the published span of service) — live lookup
              didn't return times just now.
            </p>
          )}
          {!usingFallback && live.checkedAt && <p className="checked">Live · checked {fmtTime(live.checkedAt)}</p>}
          <div className="footer-row">
            <button
              className="refresh-btn"
              onClick={() => fetchLive(effectiveDirection, customTime)}
              disabled={live.status === 'loading'}
            >
              <RefreshCw size={13} className={live.status === 'loading' ? 'spin' : ''} />
              {live.status === 'loading' ? 'Checking…' : 'Refresh'}
            </button>
          </div>
          <div className="footer-links">
            <a
              className="ext-link"
              href="https://jp.translink.com.au/plan-your-journey/stops/russell-island-ferry-terminal"
              target="_blank"
              rel="noopener noreferrer"
            >
              Translink live times <ExternalLink size={12} />
            </a>
            <a
              className="ext-link"
              href="https://www.sealink.com.au/bay-islands/ferry-information/ferry-timetable/"
              target="_blank"
              rel="noopener noreferrer"
            >
              SeaLink timetable <ExternalLink size={12} />
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
}
