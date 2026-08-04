import { useCallback, useEffect, useState } from "react";
import socket from "./socket.js";
import { theme } from "./theme/index.js";
import { formatElapsed } from "./elapsed.js";
import "./Leaderboards.css";

// The two boards flanking the menu.
//
//   left    the playground: fastest time to clear a rack, one row per player
//   right   the rooms: the last few finished matches and their SERIES score —
//           games won, not the score of any single game
//
// Both come from the server on the same event, refreshed on a timer like the
// room list, so a run you just finished appears without a reload.

const REFRESH_MS = 8000;

function Panel({ title, children }) {
    return (
        <div className="board-panel">
            <div className="board-panel-title">{title}</div>
            {children}
        </div>
    );
}

function Empty({ children }) {
    return <div className="board-empty">{children}</div>;
}

export default function Leaderboards({ coinCount }) {
    const [soloRuns, setSoloRuns] = useState([]);
    const [matches, setMatches] = useState([]);

    const ask = useCallback(() => {
        if (!socket.connected) socket.connect();
        socket.emit("leaderboards", { coinCount });
    }, [coinCount]);

    useEffect(() => {
        const onBoards = (data) => {
            // A reply for a rack we have since moved off is not ours.
            if (data.coinCount && data.coinCount !== coinCount) return;
            setSoloRuns(data.soloRuns || []);
            setMatches(data.matches || []);
        };

        socket.on("leaderboards", onBoards);
        socket.on("connect", ask);
        ask();

        const poll = setInterval(() => {
            if (document.visibilityState === "visible") ask();
        }, REFRESH_MS);

        return () => {
            socket.off("leaderboards", onBoards);
            socket.off("connect", ask);
            clearInterval(poll);
        };
    }, [ask, coinCount]);

    return (
        <div className="boards">
            <Panel title={`PLAYGROUND · ${coinCount}`}>
                {soloRuns.length === 0 ? (
                    <Empty>NO RUNS YET</Empty>
                ) : (
                    <table className="board-table">
                        <thead>
                            <tr>
                                <th>USERNAME</th>
                                <th className="board-num">COINS</th>
                                <th className="board-num">TIME</th>
                            </tr>
                        </thead>
                        <tbody>
                            {soloRuns.map((run, i) => (
                                <tr key={`${run.username}-${run.at}`}>
                                    <td className="board-name">
                                        <span style={{ color: theme.ui.muted }}>{i + 1}</span>
                                        &nbsp;{run.username.toUpperCase()}
                                    </td>
                                    <td className="board-num">{run.coinCount}</td>
                                    <td className="board-num">{formatElapsed(run.ms)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Panel>

            <Panel title="LAST MATCHES">
                {matches.length === 0 ? (
                    <Empty>NO MATCHES YET</Empty>
                ) : (
                    <table className="board-table">
                        <tbody>
                            {matches.map((m) => (
                                <tr key={m.at}>
                                    <td className="board-name">{(m.players[0] || "?").toUpperCase()}</td>
                                    <td className="board-num">{m.wins[0]}</td>
                                    <td className="board-num board-dash">–</td>
                                    <td className="board-num">{m.wins[1]}</td>
                                    <td className="board-name board-right">
                                        {(m.players[1] || "?").toUpperCase()}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </Panel>
        </div>
    );
}
