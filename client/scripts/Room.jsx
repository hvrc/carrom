import { useEffect, useState, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import socket from "./socket.js";
import Manager from "./Manager.js";
import Board from "./Board.jsx";

// information table

function GameInfoTable({ roomName, creator, joiner, manager }) {
    const creatorData = manager.getPlayerData("creator");
    const joinerData = manager.getPlayerData("joiner");
    const joinerWaiting = !joiner;

    const players = [
        {
            name: creator?.username || "Waiting...",
            ...creatorData,
        },
        {
            name: joiner?.username || "Waiting for joiner...",
            ...joinerData,
        },
    ];

    return (
        <div>
            <div>Room Name: {roomName}</div> <br />
            <table
                border="1"
                cellPadding="6"
                style={{ borderCollapse: "collapse", minWidth: 400 }}
            >
                <thead>
                    <tr>
                        <th>Player</th>
                        <th>Role</th>
                        <th>Color</th>
                        <th>Score</th>
                        <th>Debt</th>
                        <th>Is Turn</th>
                        <th>Is Cover Turn</th>
                        <th>Has Pocketed Queen</th>
                        <th>Has Covered Queen</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>{players[0].name}</td>
                        <td>{players[0].role}</td>
                        <td>{players[0].color}</td>
                        <td>{players[0].score}</td>
                        <td>{players[0].debt}</td>
                        <td>{players[0].isTurn ? "Yes" : "No"}</td>
                        <td>{players[0].isCoverTurn ? "Yes" : "No"}</td>
                        <td>{players[0].hasPocketedQueen ? "Yes" : "No"}</td>
                        <td>{players[0].hasCoveredQueen ? "Yes" : "No"}</td>
                    </tr>
                    <tr>
                        <td>
                            {joinerWaiting ? (
                                <span>Waiting for joiner...</span>
                            ) : (
                                players[1].name
                            )}
                        </td>
                        <td>{players[1].role}</td>
                        <td>{players[1].color}</td>
                        <td>{players[1].score}</td>
                        <td>{players[1].debt}</td>
                        <td>{players[1].isTurn ? "Yes" : "No"}</td>
                        <td>{players[1].isCoverTurn ? "Yes" : "No"}</td>
                        <td>{players[1].hasPocketedQueen ? "Yes" : "No"}</td>
                        <td>{players[1].hasCoveredQueen ? "Yes" : "No"}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    );
}

export default function Room() {

    // i dont know why these room functions are here or how to categorize them
    // are they required for the game info table?
    // force table re render
    // what does use params, use navigate, use state 0 mean ?
    // is table refresh required?

    // the room name is taken from the URL parameters
    // useNavigate is used to navigate to a different page?
    // use state null creates a piece of state called room data, initialized to null,
    // and a function set room date to update that state

    const { roomName } = useParams();
    const navigate = useNavigate();
    const [roomData, setRoomData] = useState(null);
    const [tableRefresh, setTableRefresh] = useState(0);
    const managerRef = useRef(null);
    
    // if room data or room name change,
    // if room's creator, and joiner have been set and
    // either the current game manager reference has not been set or 
    // if the current game manager reference's room name is not 
    // the same as the room name constant set above
    // set the current game manager reference to a new game manager instance

    useEffect(() => {
        if (
            roomData?.creator &&
            roomData?.joiner &&
            (!managerRef.current || managerRef.current.roomName !== roomName)
        ) {
            managerRef.current = new Manager(roomName, roomData);
        }
    }, [roomData, roomName]);

    // the variables in the use effect are room name and navigate
    // does that mean that these things are executed,
    // when room name changes or when the navigate function is called?

    useEffect(() => {

        // if socket is not connected, connect to it
        // get client id, room name, username, player role from session storage and local storage
        // if client id has not been set, clear local storage and navigate to the home page
        
        if (!socket.connected) { socket.connect(); }
        const clientId = sessionStorage.getItem("clientId");
        const storedRoomName = localStorage.getItem("roomName");
        const username = localStorage.getItem("username");
        const playerRole = localStorage.getItem("playerRole");

        if (!clientId) {
            localStorage.clear();
            navigate("/");
            return;
        }

        // update manager when room data changes

        // const handleRoomUpdate = (data) => {
        //     if (data.roomName === roomName && managerRef.current) {
        //         // update debts in manager if present
        //         if (data.debts) {
        //             managerRef.current.playerData[0].debt = data.debts.creator;
        //             managerRef.current.playerData[1].debt = data.debts.joiner;
        //         }

        //         // update roomData to reflect new debts
        //         setRoomData(prev => ({
        //             ...prev,
        //             creator: {
        //                 ...prev.creator,
        //                 debt: data.debts ? data.debts.creator : prev.creator.debt
        //             },
        //             joiner: prev.joiner ? {
        //                 ...prev.joiner,
        //                 debt: data.debts ? data.debts.joiner : prev.joiner.debt
        //             } : null
        //         }));
        //     }
        // };

        // if the room name stored in local storage is the same as the room name that is ?,
        // and if username and player role are set,
        // emit a rejoinRoom event with room name, username, client id and player role
        // else check if room can be accessed, sending room name and client id
        
        if (storedRoomName === roomName && username && playerRole) {
            socket.emit("rejoinRoom", {
                roomName,
                username,
                clientId,
                playerRole,
            });
        } else {
            socket.emit("checkRoomAccess", { roomName, clientId });
        }

        // listen for an event where the server grants access to the rooma for the client,
        // ask server for the room data
        socket.on("accessGranted", () => {
            socket.emit("requestRoomData", { roomName });
        });

        // where does this room update usually event come from?
        // listen for a room update event from the server,
        // if the room name in the data sent by the server is the same as the room name,
        // set the room data state to the data sent by the server
        // if room manager has been set,
        // update the debts in the manager with the debts from the data sent by the server
        // update the scores in the manager with the scores from the data sent by the server
        // if the manager has not been set, initialize it with the room name and data sent by the server
        
        socket.on("roomUpdate", (data) => {
            if (data.roomName === roomName) {
                setRoomData(data);

                if (managerRef.current) {
                    if (data.debts) {
                        managerRef.current.playerData[0].debt = data.debts.creator;
                        managerRef.current.playerData[1].debt = data.debts.joiner;
                    }
                    if (
                        data.creator &&
                        typeof data.creator.score !== "undefined"
                    ) {
                        managerRef.current.playerData[0].score = data.creator.score;
                    }
                    if (
                        data.joiner &&
                        typeof data.joiner.score !== "undefined"
                    ) {
                        managerRef.current.playerData[1].score = data.joiner.score;
                    }
                } else {
                    managerRef.current = new Manager(roomName, data);
                }
            }
        });

        // listen for room closed event from server,
        // clear local storage and navigate to home page

        socket.on("roomClosed", (msg) => {
            console.warn("[net] roomClosed:", msg);
            localStorage.clear();
            navigate("/");
        });
        
        // listen for error event from server,
        // clear local storage and navigate to home page

        socket.on("error", (msg) => {
            // Only leave on a genuine room/session failure. Transient gameplay
            // errors (e.g. "Not your turn", "Game has not started") must NOT
            // eject the player.
            const fatal = /room does not exist|room is full|invalid session|invalid client/i.test(String(msg));
            if (fatal) {
                console.warn("[net] fatal error — leaving room:", msg);
                localStorage.clear();
                navigate("/");
            } else {
                console.warn("[net] transient error (ignored):", msg);
            }
        });
        
        // cleanup function to remove event listeners
        // socket off means the socket will stop listening for this event

        return () => {
            socket.off("accessGranted");
            socket.off("roomClosed");
            socket.off("error");
        };

    }, [roomName, navigate]);

    // whats the difference between
    // handleDebtScoreUpdate, handleScoreUpdate,
    // handleDebtUpdate, handleDebtPaid?

    // if room name or socket changes,
    // listen for a debt score update event from the server incl data,
    // if room name in the data is the same as the room name,
    // and if manager reference has been set,
    // set a variable to the current manager reference,

    // for each item in a list that contains strings "creator" and "joiner"
    // get the player data object for that role from the manager
    // if the player data exists,
    // set the player's debt and score in the manager to the value from the event data

    // force re render
    // forces a react state update for roomData,
    // by creating a new object with the same properties as the curr state
    // useful when you want to refrtesh the ui,
    // after making changes to objects or references inside room data

    // listen for debt score updates from the server,
    // return a function that stops the client socket from listening to debt score update events

    useEffect(() => {

        if (!socket || !roomName) return;

        const handleDebtScoreUpdate = (data) => {
            if (data.roomName === roomName && managerRef.current) {
                const gm = managerRef.current;
                
                ["creator", "joiner"].forEach((role) => {
                    const p = gm.getPlayerData(role);
                    if (p) {
                        p.debt = data.debt[role];
                        p.score = data.score[role];
                    }
                });

                setRoomData((rd) => ({ ...rd }));
            }
        };

        socket.on("debtScoreUpdate", handleDebtScoreUpdate);

        return () => {
            socket.off("debtScoreUpdate", handleDebtScoreUpdate);
        };

    }, [roomName, socket]);

    // if room name or socket changes,
    // create a function to handle score updates, that takes data as an argument,
    // if curr manager reference has been set, and the room name in the data is the same as the room name,
    // object destructure the scores from the data, data has a property called scores,
    // extract just that property into a variable called scores
    // update the game managers scores for both players, with the scores from the data
    
    // set room data is a array destructuring operation,
    // set room data updates the scores for both players in the room data state
    // and triggers a react re render so that the ui reflects the latest scores

    // listen for score updates from the server,
    // return a function that stops the client socket from listening to score update events 

    useEffect(() => {

        if (!socket || !roomName) return;

        const handleScoreUpdate = (data) => {
            if (!managerRef.current || data.roomName !== roomName) return;

            const { scores } = data;

            managerRef.current.updateScore("creator", scores.creator);
            managerRef.current.updateScore("joiner", scores.joiner);

            setRoomData((prev) => ({
                ...prev,
                creator: {
                    ...prev.creator,
                    score: scores.creator,
                },
                joiner: {
                    ...prev.joiner,
                    score: scores.joiner,
                },
            }));
        };

        socket.on("scoreUpdate", handleScoreUpdate);

        return () => {
            socket.off("scoreUpdate");
        };

    }, [roomName, socket]);

    // update the current game manager reference's debt,
    // with the debt from the data sent by the server,
    // also referencing the player role from the data

    // change the debt value for a specific player role from the room data state,
    // it keeps all other properties in room data the same, but for the player whose
    // role matches the player role in the data, it creates a new object,
    // with all their previous properties, but with the debt updated to the new value from data
    // this triggers a re render of the component, so that the ui reflects the latest debt values

    // listen for debt updates from the server,
    // return a function that stops the client socket from listening to debt update events 

    useEffect(() => {

        if (!socket || !roomName) return;

        const handleDebtUpdate = (data) => {
            if (data.roomName !== roomName || !managerRef.current) return;

            managerRef.current.updateDebt(data.playerRole, data.debt);

            setRoomData((prev) => ({
                ...prev,
                [data.playerRole]: {
                    ...prev[data.playerRole],
                    debt: data.debt,
                },
            }));
        };

        socket.on("debtUpdate", handleDebtUpdate);

        return () => {
            socket.off("debtUpdate");
        };

    }, [roomName, socket]);

    // update the current game manager reference's score and debt,
    // with the "new" score and debt from the data sent by the server,
    // why do we need this new score and debt?

    // create a new object for a specific player role in the room data state,
    // with all their previous properties, except the score & debt,
    // which is updated with the "new" value from data
    // this forces a react re render of the component

    useEffect(() => {

        if (!socket || !roomName) return;

        const handleDebtPaid = (data) => {
            if (data.roomName !== roomName || !managerRef.current) return;

            managerRef.current.updateScore(data.playerRole, data.newScore);
            managerRef.current.updateDebt(data.playerRole, data.newDebt);

            setRoomData((prev) => ({
                ...prev,
                [data.playerRole]: {
                    ...prev[data.playerRole],
                    score: data.newScore,
                    debt: data.newDebt,
                },
            }));
        };

        socket.on("debtPaid", handleDebtPaid);

        return () => {
            socket.off("debtPaid");
        };

    }, [roomName, socket]);

    // call the reset game method thorugh the current game manager,
    // sets room data to its initial state,
    // where both players have a score and debt of 0,
    // and the whose turn is set to "creator"
    // table refresh is incremented via array destructuring,
    // but table refresh is not used anywhere in the code,
    // is it really required?

    useEffect(() => {

        if (!socket || !roomName) return;

        const handleGameReset = (data) => {
            if (data.roomName !== roomName || !managerRef.current) return;

            managerRef.current.resetGame();

            setRoomData((prev) => ({
                ...prev,
                creator: {
                    ...prev.creator,
                    score: 0,
                    debt: 0,
                },
                joiner: {
                    ...prev.joiner,
                    score: 0,
                    debt: 0,
                },
                whoseTurn: "creator",
            }));

            setTableRefresh((prev) => prev + 1);
        };

        socket.on("gameReset", handleGameReset);

        return () => {
            socket.off("gameReset");
        };

    }, [roomName, socket]);

    // get client id from session storage,
    // if client id is not set, clear local storage and navigate to home page
    // emit a leave room even to the serer with room name and client id,
    // clear local storage and navigate to home page

    const handleLeaveRoom = () => {
        const clientId = sessionStorage.getItem("clientId");

        if (!clientId) {
            localStorage.clear();
            navigate("/");
            return;
        }

        socket.emit("leaveRoom", { roomName, clientId });
        localStorage.clear();
        navigate("/");
    };

    // if room data is not set, return a loading message

    if (!roomData) {
        return <div>Loading room...</div>;
    }

    // if manager reference has not been set,
    // create a new instance of a manager with room name and room data

    if (!managerRef.current) {
        managerRef.current = new Manager(roomName, roomData);
    }

    const manager = managerRef.current;
    // const currentUsername = localStorage.getItem("username");
    const playerRole = localStorage.getItem("playerRole");
    const isMyTurn = roomData.whoseTurn === playerRole; 
    
    // return the main component structure,
    // which includes the Board component,
    // board needs to know whose turn it is because it controls player actions,
    // like placing and flicking the striker,
    // socket enables it to commuicate with the server,
    // ...
    
    return (
        <div style={{ 
            display: 'flex', 
            flexDirection: 'column', 
            alignItems: 'center', 
            justifyContent: 'center', 
            minHeight: '100vh',
            padding: '20px'
        }}>
            
            <Board
                isMyTurn={isMyTurn}
                socket={socket}
                roomName={roomName}
                playerRole={playerRole}
                manager={manager}
                onLeaveRoom={handleLeaveRoom}
                creatorUsername={roomData?.creator?.username || ""}
                joinerUsername={roomData?.joiner?.username || ""}
            />
            {/* <GameInfoTable
                key={tableRefresh}
                roomName={roomName}
                creator={roomData.creator}
                joiner={roomData.joiner}
                manager={manager}
                roomData={roomData}
            /> */}
        </div>
    );
}
