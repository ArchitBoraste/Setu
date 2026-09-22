// The one shape every timestamp leaves this server in.
//
// Timestamps go out as text in MySQL's own DATETIME format, produced by the
// server's clock and never parsed by a device. The device stores the value and
// hands it back as a cursor, so what matters is that it round-trips through
// MySQL unchanged. %f prints microseconds, which for a DATETIME(3) column is
// always three digits followed by three zeros — exact, not rounded.
//
// Fixed width is the property the window arithmetic in pullRules.js rests on:
// for this format, lexicographic order IS chronological order, so a cursor can
// be compared as a string and never has to become a Date.
//
// It lives in its own module because both routers need it — the sync routes and
// the supervisor's conflict routes — and a router importing another router's
// internals to get at a format string is how two copies of it start to drift.
export const SERVER_TIME_FORMAT = "%Y-%m-%d %H:%i:%s.%f";
