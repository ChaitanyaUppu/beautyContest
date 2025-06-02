const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const rooms = {};

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

app.use(express.static('public'));

io.on('connection', (socket) => {
    socket.on('createRoom', (playerName) => {
        const code = generateRoomCode();
        while (rooms[code]) {
            code = generateRoomCode();
        }
        rooms[code] = {
            players: [{ name: playerName, score: 0 }],
            creator: socket.id,
            submissions: {},
            gameStarted: false
        };
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = playerName;
        socket.isCreator = true;
        socket.emit('roomCreated', { code, players: rooms[code].players, isCreator: true });
        console.log(`Room ${code} created by ${playerName}`);
    });

    socket.on('joinRoom', ({ name, code }) => {
        if (!rooms[code]) {
            socket.emit('error', 'Room does not exist.');
            return;
        }
        if (rooms[code].players.find(p => p.name === name)) {
            socket.emit('error', 'Name already taken in this room.');
            return;
        }
        if (rooms[code].gameStarted) {
            socket.emit('error', 'Game has already started in this room.');
            return;
        }
        rooms[code].players.push({ name, score: 0 });
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = name;
        socket.isCreator = false;
        socket.emit('roomJoined', { code, players: rooms[code].players, isCreator: false });
        io.to(code).emit('updatePlayers', rooms[code].players);
        console.log(`Player ${name} joined room ${code}`);
    });

    socket.on('startGame', () => {
        const { roomCode } = socket;
        if (!roomCode || !rooms[roomCode] || !socket.isCreator) {
            socket.emit('error', 'Only the room creator can start the game.');
            return;
        }
        if (rooms[roomCode].players.filter(p => p.score > -10).length < 2) {
            socket.emit('error', 'At least 2 active players are required to start the game.');
            return;
        }
        rooms[roomCode].gameStarted = true;
        rooms[roomCode].submissions = {};
        io.to(roomCode).emit('gameStarted');
        console.log(`Room ${roomCode}: Game round started with ${rooms[roomCode].players.filter(p => p.score > -10).length} active players`);
        setTimeout(() => endRound(roomCode), 60000);
    });

    socket.on('submitNumber', (number) => {
        const { roomCode, playerName } = socket;
        if (!roomCode || !rooms[roomCode] || !rooms[roomCode].gameStarted) {
            console.log(`Player ${playerName}: Invalid submission attempt (room or game state)`);
            return;
        }
        const player = rooms[roomCode].players.find(p => p.name === playerName);
        if (!player || player.score <= -10) {
            console.log(`Player ${playerName}: Submission rejected (eliminated, score: ${player?.score})`);
            return;
        }
        rooms[roomCode].submissions[playerName] = number;
        console.log(`Player ${playerName} submitted ${number} in room ${roomCode}`);
    });

    function endRound(roomCode) {
        if (!rooms[roomCode] || !rooms[roomCode].gameStarted) {
            console.log(`Room ${roomCode}: Round ended prematurely (room or game state)`);
            return;
        }

        const { submissions, players } = rooms[roomCode];
        const activePlayers = players.filter(p => p.score > -10);
        const playerCount = activePlayers.length;
        const numbers = Object.values(submissions).filter(n => !isNaN(n) && n !== null);
        const target = numbers.length > 0 ? (numbers.reduce((a, b) => a + b, 0) / numbers.length) * 0.8 : 0;
        const roundedTarget = Math.round(target);

        let winner = null;
        let duplicates = [];

        console.log(`Room ${roomCode}: Submissions:`, submissions, `Target: ${target}, Rounded Target: ${roundedTarget}, Active players: ${playerCount}`);

        // Identify duplicates
        const numberCounts = {};
        Object.values(submissions).forEach(num => {
            if (num !== undefined && num !== null) {
                numberCounts[num] = (numberCounts[num] || 0) + 1;
                if (numberCounts[num] > 1) duplicates.push(num);
            }
        });
        console.log(`Room ${roomCode}: Duplicates:`, duplicates);

        // Scoring rules based on player count
        if (playerCount === 2) {
            let exactMatch = false;
            let zeroGuess = false;
            let zeroPlayer = null;
            let nonZeroPlayer = null;

            // Check for zero guess
            players.forEach(player => {
                const guess = submissions[player.name];
                if (guess === 0) {
                    zeroGuess = true;
                    zeroPlayer = player.name;
                } else if (guess !== undefined && guess !== null) {
                    nonZeroPlayer = player.name;
                }
            });

            players.forEach(player => {
                if (player.score <= -10) {
                    console.log(`Player ${player.name}: Already eliminated, score: ${player.score}`);
                    return;
                }

                const guess = submissions[player.name];
                if (guess === undefined || guess === null) {
                    player.score -= 1;
                    console.log(`Player ${player.name}: No submission, score: ${player.score}`);
                    return;
                }

                // Duplicate rule
                if (duplicates.includes(guess)) {
                    player.score -= 1;
                    console.log(`Player ${player.name}: Duplicate guess ${guess}, score: ${player.score}`);
                    return;
                }

                // Zero guess rule
                if (zeroGuess && guess === 0) {
                    player.score -= 1;
                    console.log(`Player ${player.name}: Guess 0, score: ${player.score}`);
                    if (nonZeroPlayer && !duplicates.includes(submissions[nonZeroPlayer])) {
                        winner = nonZeroPlayer;
                        console.log(`Player ${nonZeroPlayer}: Wins round (opponent guessed 0)`);
                    }
                    return;
                }

                // Exact match rule (rounded target)
                if (guess === roundedTarget) {
                    exactMatch = true;
                    winner = player.name;
                    players.forEach(p => {
                        if (p.name !== player.name && p.score > -10) {
                            p.score -= 2;
                            console.log(`Player ${p.name}: Exact match by ${player.name}, score: ${p.score}`);
                        }
                    });
                    console.log(`Player ${player.name}: Exact match (rounded target), score: ${player.score}`);
                    return;
                }

                // Closest to target (if not already set by zero guess or exact match)
                if (!isNaN(guess) && !winner) {
                    if (!winner || Math.abs(guess - target) < Math.abs(submissions[winner] - target)) {
                        winner = player.name;
                    }
                }
            });

            // Apply penalties for non-winners if no exact match or zero guess winner
            if (winner && !exactMatch && !zeroGuess) {
                players.forEach(player => {
                    if (player.name !== winner && !duplicates.includes(submissions[player.name]) && submissions[player.name] !== undefined && submissions[player.name] !== null && player.score > -10) {
                        player.score -= 1;
                        console.log(`Player ${player.name}: Not winner, score: ${player.score}`);
                    }
                });
            }
        } else if (playerCount === 3) {
            let exactMatch = false;
            players.forEach(player => {
                if (player.score <= -10) {
                    console.log(`Player ${player.name}: Already eliminated, score: ${player.score}`);
                    return;
                }

                const guess = submissions[player.name];
                if (guess === undefined || guess === null) {
                    player.score -= 1;
                    console.log(`Player ${player.name}: No submission, score: ${player.score}`);
                    return;
                }

                // Duplicate rule
                if (duplicates.includes(guess)) {
                    player.score -= 1;
                    console.log(`Player ${player.name}: Duplicate guess ${guess}, score: ${player.score}`);
                    return;
                }

                // Exact match rule (rounded target)
                if (guess === roundedTarget) {
                    exactMatch = true;
                    winner = player.name;
                    players.forEach(p => {
                        if (p.name !== player.name && p.score > -10) {
                            p.score -= 2;
                            console.log(`Player ${p.name}: Exact match by ${player.name}, score: ${p.score}`);
                        }
                    });
                    console.log(`Player ${player.name}: Exact match (rounded target), score: ${player.score}`);
                    return;
                }

                // Closest to target
                if (!isNaN(guess)) {
                    if (!winner || Math.abs(guess - target) < Math.abs(submissions[winner] - target)) {
                        winner = player.name;
                    }
                }
            });

            // Apply penalties for non-winners if no exact match
            if (winner && !exactMatch) {
                players.forEach(player => {
                    if (player.name !== winner && !duplicates.includes(submissions[player.name]) && submissions[player.name] !== undefined && submissions[player.name] !== null && player.score > -10) {
                        player.score -= 1;
                        console.log(`Player ${player.name}: Not winner, score: ${player.score}`);
                    }
                });
            }
        } else if (playerCount >= 4) {
            players.forEach(player => {
                if (player.score <= -10) {
                    console.log(`Player ${player.name}: Already eliminated, score: ${player.score}`);
                    return;
                }

                const guess = submissions[player.name];
                if (guess === undefined || guess === null) {
                    player.score -= 1;
                    console.log(`Player ${player.name}: No submission, score: ${player.score}`);
                    return;
                }

                // Duplicate rule
                if (duplicates.includes(guess)) {
                    player.score -= 1;
                    console.log(`Player ${player.name}: Duplicate guess ${guess}, score: ${player.score}`);
                    return;
                }

                // Closest to target
                if (!isNaN(guess)) {
                    if (!winner || Math.abs(guess - target) < Math.abs(submissions[winner] - target)) {
                        winner = player.name;
                    }
                }
            });

            // Apply penalties for non-winners
            if (winner) {
                players.forEach(player => {
                    if (player.name !== winner && !duplicates.includes(submissions[player.name]) && submissions[player.name] !== undefined && submissions[player.name] !== null && player.score > -10) {
                        player.score -= 1;
                        console.log(`Player ${player.name}: Not winner, score: ${player.score}`);
                    }
                });
            }
        }

        // Broadcast scores before disconnecting eliminated players
        io.to(roomCode).emit('roundResult', { target, roundedTarget, winner, scores: players });
        console.log(`Room ${roomCode}: Round result - Target: ${target}, Rounded Target: ${roundedTarget}, Winner: ${winner}, Scores:`, players.map(p => ({ name: p.name, score: p.score })));

        // Disconnect players with score <= -10
        const sockets = io.sockets.adapter.rooms.get(roomCode) || new Set();
        players.forEach(player => {
            if (player.score <= -10) {
                const playerSocket = Array.from(io.sockets.sockets.values()).find(s => s.playerName === player.name && s.roomCode === roomCode);
                if (playerSocket) {
                    playerSocket.emit('error', 'You have been eliminated (score <= -10).');
                    playerSocket.disconnect(true);
                    console.log(`Player ${player.name} disconnected due to elimination (score: ${player.score})`);
                }
            }
        });

        // Update players list after eliminations
        rooms[roomCode].players = rooms[roomCode].players.filter(p => p.score > -10);
        io.to(roomCode).emit('updatePlayers', rooms[roomCode].players);

        // Check for game end (one active player)
        const activePlayersAfterRound = rooms[roomCode].players.filter(p => p.score > -10);
        console.log(`Room ${roomCode}: Active players after round:`, activePlayersAfterRound.map(p => p.name));
        if (activePlayersAfterRound.length <= 1) {
            const gameWinner = activePlayersAfterRound.length === 1 ? activePlayersAfterRound[0].name : 'No one';
            io.to(roomCode).emit('gameEnded', { winner: gameWinner });
            sockets.forEach(socketId => {
                const socket = io.sockets.sockets.get(socketId);
                if (socket) {
                    socket.emit('error', 'Game ended. Please create a new room to play again.');
                    socket.disconnect(true);
                }
            });
            delete rooms[roomCode];
            console.log(`Room ${roomCode}: Game ended, winner: ${gameWinner}, room deleted`);
            return;
        }

        // Reset game state, wait for creator to start next round
        rooms[roomCode].gameStarted = false;
        rooms[roomCode].submissions = {};
        console.log(`Room ${roomCode}: Waiting for creator to start next round`);
    }

    socket.on('leaveRoom', () => {
        const { roomCode, playerName } = socket;
        if (roomCode && rooms[roomCode]) {
            rooms[roomCode].players = rooms[roomCode].players.filter(p => p.name !== playerName);
            socket.leave(roomCode);
            if (rooms[roomCode].players.length === 0) {
                delete rooms[roomCode];
                console.log(`Room ${roomCode}: Deleted (empty)`);
            } else {
                if (rooms[roomCode].creator === socket.id) {
                    rooms[roomCode].creator = rooms[roomCode].players[0]?.name || null;
                }
                io.to(roomCode).emit('updatePlayers', rooms[roomCode].players);
                if (rooms[roomCode].gameStarted && rooms[roomCode].players.filter(p => p.score > -10).length < 2) {
                    const sockets = io.sockets.adapter.rooms.get(roomCode) || new Set();
                    io.to(roomCode).emit('gameEnded', { winner: 'No one (not enough players)' });
                    sockets.forEach(socketId => {
                        const socket = io.sockets.sockets.get(socketId);
                        if (socket) {
                            socket.emit('error', 'Game ended due to insufficient players. Please create a new room.');
                            socket.disconnect(true);
                        }
                    });
                    delete rooms[roomCode];
                    console.log(`Room ${roomCode}: Game ended (not enough players), room deleted`);
                }
            }
        }
    });

    socket.on('disconnect', () => {
        const { roomCode, playerName } = socket;
        if (roomCode && rooms[roomCode]) {
            rooms[roomCode].players = rooms[roomCode].players.filter(p => p.name !== playerName);
            socket.leave(roomCode);
            if (rooms[roomCode].players.length === 0) {
                delete rooms[roomCode];
                console.log(`Room ${roomCode}: Deleted (empty)`);
            } else {
                if (rooms[roomCode].creator === socket.id) {
                    rooms[roomCode].creator = rooms[roomCode].players[0]?.name || null;
                }
                io.to(roomCode).emit('updatePlayers', rooms[roomCode].players);
                if (rooms[roomCode].gameStarted && rooms[roomCode].players.filter(p => p.score > -10).length < 2) {
                    const sockets = io.sockets.adapter.rooms.get(roomCode) || new Set();
                    io.to(roomCode).emit('gameEnded', { winner: 'No one (not enough players)' });
                    sockets.forEach(socketId => {
                        const socket = io.sockets.sockets.get(socketId);
                        if (socket) {
                            socket.emit('error', 'Game ended due to insufficient players. Please create a new room.');
                            socket.disconnect(true);
                        }
                    });
                    delete rooms[roomCode];
                    console.log(`Room ${roomCode}: Game ended (not enough players), room deleted`);
                }
            }
        }
    });
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
});