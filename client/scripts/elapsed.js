// Elapsed time, formatted so the unit grows with the number rather than padding
// it out — a fresh room reads "7", not "0:00:00:07".
//
//   0 … 59        seconds
//   1:00 … 59:59  minutes
//   1:00:00 …     hours, up to 23:59:59
//   1:00:00:00 …  days
//
// Pure, and unit-tested in client/test/clock.test.js.
export function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const s = total % 60;
    const m = Math.floor(total / 60) % 60;
    const h = Math.floor(total / 3600) % 24;
    const d = Math.floor(total / 86400);
    const pad = (n) => String(n).padStart(2, "0");

    if (total < 60) return String(s);
    if (total < 3600) return `${m}:${pad(s)}`;
    if (total < 86400) return `${h}:${pad(m)}:${pad(s)}`;
    return `${d}:${pad(h)}:${pad(m)}:${pad(s)}`;
}

export default formatElapsed;
