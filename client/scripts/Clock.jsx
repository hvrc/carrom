import { useEffect, useState } from "react";
import { theme } from "./theme/index.js";
import { formatElapsed } from "./elapsed.js";

/**
 * The room's clock: time since its first deal, counting up. `startedAt` is the
 * server's stamp, so both players read the same clock however long after the
 * deal each of them loaded the page.
 */
export default function Clock({ startedAt }) {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!startedAt) return undefined;
        // Faster than once a second so the display never sits a fraction behind
        // the real elapsed time, which a 1000ms tick from mount would.
        const id = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(id);
    }, [startedAt]);

    if (!startedAt) return null;

    return (
        <span style={{ color: theme.ui.muted, fontVariantNumeric: "tabular-nums" }}>
            {formatElapsed(now - startedAt)}
        </span>
    );
}
