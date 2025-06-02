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
        let code = generateRoomCode();
        while (rooms[code]) code = generateRoomCode();

        rooms[code] = {
            players: [{ name: playerName, score: 0, eliminated: false }],
            creator: socket.id,
            submissions: {},
            gameStarted: false
        };

        socket.join(code);
        socket.roomCode = code;
        socket.playerName = playerName;
        socket.isCreator = true;
        socket.emit('roomCreated', { code, players: rooms[code].players, isCreator: true });
    });

    socket.on('joinRoom', ({ name, code }) => {
        if (!rooms[code]) return socket.emit('error', 'Room does not exist.');
        if (rooms[code].players.find(p => p.name === name)) return socket.emit('error', 'Name already taken.');
        if (rooms[code].gameStarted) return socket.emit('error', 'Game already started.');

        rooms[code].players.push({ name, score: 0, eliminated: false });
        socket.join(code);
        socket.roomCode = code;
        socket.playerName = name;
        socket.isCreator = false;
        socket.emit('roomJoined', { code, players: rooms[code].players, isCreator: false });
        io.to(code).emit('updatePlayers', rooms[code].players);
    });

    socket.on('startGame', () => {
        const { roomCode } = socket;
        if (!roomCode || !rooms[roomCode]) return;

        // Even eliminated creator can start the game
        const isCreator = socket.id === rooms[roomCode].creator;
        if (!isCreator) return socket.emit('error', 'Only the creator can start the game.');

        if (rooms[roomCode].players.filter(p => !p.eliminated).length < 2) {
            return socket.emit('error', 'At least 2 active players are required.');
        }

        rooms[roomCode].gameStarted = true;
        rooms[roomCode].submissions = {};
        io.to(roomCode).emit('gameStarted');
        setTimeout(() => endRound(roomCode), 60000);
    });

    socket.on('submitNumber', (number) => {
        const { roomCode, playerName } = socket;
        if (!rooms[roomCode] || !rooms[roomCode].gameStarted) return;

        const player = rooms[roomCode].players.find(p => p.name === playerName);
        const isCreator = socket.id === rooms[roomCode].creator;

        // ✅ Block input from eliminated players, except creator
        if (!player || (player.eliminated && !isCreator)) return;

        rooms[roomCode].submissions[playerName] = number;
    });

    function endRound(roomCode) {
        if (!rooms[roomCode] || !rooms[roomCode].gameStarted) return;

        const { submissions, players } = rooms[roomCode];
        const activePlayers = players.filter(p => !p.eliminated);
        const numbers = Object.values(submissions).filter(n => !isNaN(n));
        const target = numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length * 0.8 : 0;
        const roundedTarget = Math.round(target);

        let winner = null;
        let minDiff = Infinity;
        let duplicates = [];

        const numberCounts = {};
        Object.values(submissions).forEach(n => {
            if (n !== undefined) {
                numberCounts[n] = (numberCounts[n] || 0) + 1;
                if (numberCounts[n] > 1 && !duplicates.includes(n)) duplicates.push(n);
            }
        });

        players.forEach(p => {
            if (p.eliminated) return;
            const guess = submissions[p.name];
            if (guess !== undefined) {
                const diff = Math.abs(guess - target);
                if (diff < minDiff) {
                    minDiff = diff;
                    winner = p.name;
                } else if (diff === minDiff) {
                    winner = null; // Tie
                }
            }
        });

        let exactMatch = false;
        let zeroGuess = false;
        let zeroPlayer = null;
        let nonZeroPlayer = null;

        if (activePlayers.length === 2) {
            players.forEach(p => {
                const guess = submissions[p.name];
                if (guess === 0) {
                    zeroGuess = true;
                    zeroPlayer = p.name;
                } else if (guess !== undefined) {
                    nonZeroPlayer = p.name;
                }
            });
        }

        players.forEach(p => {
            if (p.eliminated) return;

            const guess = submissions[p.name];
            if (guess === undefined) {
                p.score -= 1;
                return;
            }

            if (duplicates.includes(guess)) {
                p.score -= 1;
                return;
            }

            if (activePlayers.length === 2 && guess === 0) {
                p.score -= 1;
                if (nonZeroPlayer && !duplicates.includes(submissions[nonZeroPlayer])) {
                    winner = nonZeroPlayer;
                }
                return;
            }

            if (guess === roundedTarget) {
                exactMatch = true;
                winner = p.name;
                players.forEach(other => {
                    if (other.name !== p.name && !other.eliminated) other.score -= 2;
                });
                return;
            }
        });

        if (winner && !exactMatch && !(activePlayers.length === 2 && zeroGuess)) {
            players.forEach(p => {
                const guess = submissions[p.name];
                if (p.name !== winner && !duplicates.includes(guess) && guess !== undefined && !p.eliminated) {
                    p.score -= 1;
                }
            });
        }

        players.forEach(p => {
            if (p.score <= -10) p.eliminated = true;
        });

        // ✅ Creator reassignment if eliminated
        const currentCreator = rooms[roomCode].creator;
        const creatorPlayer = players.find(p => io.sockets.sockets.get(currentCreator)?.playerName === p.name);

        if (creatorPlayer?.eliminated) {
            const remaining = players.filter(p => !p.eliminated);
            if (remaining.length > 0) {
                const newCreator = remaining.reduce((a, b) => (a.score > b.score ? a : b));
                const newSocket = [...io.sockets.sockets.values()].find(s => s.playerName === newCreator.name && s.roomCode === roomCode);
                if (newSocket) {
                    newSocket.isCreator = true;
                    rooms[roomCode].creator = newSocket.id;
                    io.to(roomCode).emit('creatorChanged', { newCreator: newCreator.name });
                }
            }
        }

        io.to(roomCode).emit('roundResult', { target, roundedTarget, winner, scores: players });
        io.to(roomCode).emit('updatePlayers', players);

        const remainingPlayers = players.filter(p => !p.eliminated);
        if (remainingPlayers.length <= 1) {
            const winnerName = remainingPlayers.length ? remainingPlayers[0].name : 'No one';
            io.to(roomCode).emit('gameEnded', { winner: winnerName });
            return;
        }

        rooms[roomCode].gameStarted = false;
        rooms[roomCode].submissions = {};
    }

    socket.on('leaveRoom', () => handleLeaveOrDisconnect(socket));
    socket.on('disconnect', () => handleLeaveOrDisconnect(socket));

    function handleLeaveOrDisconnect(socket) {
        const { roomCode, playerName } = socket;
        if (!roomCode || !rooms[roomCode]) return;

        rooms[roomCode].players = rooms[roomCode].players.filter(p => p.name !== playerName);
        socket.leave(roomCode);

        if (rooms[roomCode].players.length === 0) {
            delete rooms[roomCode];
        } else {
            if (rooms[roomCode].creator === socket.id) {
                const activePlayers = rooms[roomCode].players.filter(p => !p.eliminated);
                if (activePlayers.length > 0) {
                    const newCreator = activePlayers.reduce((a, b) => (a.score > b.score ? a : b));
                    const newSocket = [...io.sockets.sockets.values()].find(s => s.playerName === newCreator.name && s.roomCode === roomCode);
                    if (newSocket) {
                        newSocket.isCreator = true;
                        rooms[roomCode].creator = newSocket.id;
                        io.to(roomCode).emit('creatorChanged', { newCreator: newCreator.name });
                    }
                } else {
                    rooms[roomCode].creator = null;
                }
            }

            io.to(roomCode).emit('updatePlayers', rooms[roomCode].players);

            if (rooms[roomCode].gameStarted && rooms[roomCode].players.filter(p => !p.eliminated).length < 2) {
                io.to(roomCode).emit('gameEnded', { winner: 'No one (not enough players)' });
                delete rooms[roomCode];
            }
        }
    }
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));
