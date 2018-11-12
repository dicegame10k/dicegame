var express = require('express');
var path = require('path');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || 8080;

// Routing
app.use(express.static(path.join(__dirname, 'public')));

var currRoll = 100;
var lobby = [];
var dgPlayers = [];
var graveyard = [];
var userNames = [];
var gameInProgress = false;
var currentlyRollingPlayer = null;

io.on('connection', function(socket) {

	socket.on('disconnect', function() {
		if (!socket.username) {
			console.log("A not-logged-in user disconnected");
			return;
		}

		console.log(socket.username + ' disconnected');
		removePlayer(socket.username);

		// tell everyone this user disconnected
		io.emit('playerLeft', getGameState());
		io.emit('chatMessageSent', socket.username + " left the game");

		// reset the game if nobody else is playing, so it doesn't get stuck in progress with nobody playing
		if (gameInProgress && dgPlayers.length == 0) {
			console.log("Resetting game in progress, nobody is playing it");
			resetGame();
			io.emit("chatMessageSent", "Resetting game in progress, nobody is playing it");
			io.emit('resetGame', getGameState());
		}
	});

	socket.on('requestReset', function() {
		resetGame();
		io.emit('resetGame', getGameState());
		io.emit('chatMessageSent', socket.username + ' reset the game');
		console.log(socket.username + ' reset the game');
	});

	// Chat
	socket.on('chatMessageSent', function(msg) {
		var playerSendingMsg = socket.username;
		// make sure Mike knows he's a failkid
		var mikeNames = ["dantodan", "flagos", "mike", "mykerow", "myke"];
		if (mikeNames.indexOf(playerSendingMsg.toLowerCase()) != -1)
			playerSendingMsg += " (bottom DPS)";

		// make sure lil z knows he's a baller
		var lilzNames = ["tyenne", "lilz", "littlez", "little z", "lil z", "zacht", "zach t"];
		if (lilzNames.indexOf(playerSendingMsg.toLowerCase()) != -1)
			playerSendingMsg += " (top DPS)";

		console.log(playerSendingMsg + ': ' + msg);
    	io.emit('chatMessageSent', playerSendingMsg + ': ' + msg);
	});

	// User
	socket.on('login', function(userName, wowClass) {
		if (userNames.indexOf(userName) != -1) {
			console.log('User name ' + userName +' already taken');
			socket.emit('loginFailed', 'User name already taken');
			return;
		}

		socket.username = userName;
		socket.wowClass = wowClass;
		userNames.push(userName);
		var user = { userName: userName, wowClass: wowClass };
		lobby.push(user);

		var gameState = getGameState();
		socket.emit('loginSuccessful', gameState);
		socket.broadcast.emit('playerJoined', gameState);
		io.emit('chatMessageSent', socket.username + " entered the lobby");
		console.log("User created: " + userName + " - " + wowClass);
	});

	// DiceGame
	socket.on('lightUp', function() {
		console.log(socket.username + " is trying to light up");
		if (gameInProgress) {
			console.log("Not lighting up, a game is already in progress");
			return;
		}

		// Move players from lobby, diceGame, and graveyard into the game
		startGame(socket.username);
		io.emit('gameStarted', getGameState());
		io.emit('chatMessageSent', "DiceGame started by " + socket.username);
	});

	socket.on('roll', function() {
		if (socket.username != currentlyRollingPlayer) {
			console.log(socket.username + " tried to roll out of turn");
			return;
		}

		currRoll = Math.floor(Math.random() * currRoll) + 1;
		var rollMsg = socket.username + " rolled " + currRoll;
		if (currRoll == 1)
			rollMsg += " (RIP)";

		console.log(rollMsg);
		// don't send the chat message immediately
		setTimeout(() => { io.emit('chatMessageSent', rollMsg); }, 1000);

		// calculate the next player to roll
		for (var i = 0; i < dgPlayers.length; i += 1) {
			var player = dgPlayers[i];
			if (player.userName == socket.username) {
				var nextPlayerIndex = (i + 1) % dgPlayers.length;
				currentlyRollingPlayer = dgPlayers[nextPlayerIndex].userName;

				// move to graveyard if rolled a 1
				if (currRoll == 1) {
					dgPlayers.splice(i, 1);
					graveyard.push(player);
					currRoll = 100;
					// check win condition
					if (dgPlayers.length == 1) {
						var winMsg = dgPlayers[0].userName + " wins!";
						setTimeout(() => { io.emit('chatMessageSent', winMsg); }, 1000);
						setTimeout(() => { resetGame(); io.emit('resetGame', getGameState()); }, 5000);
						currentlyRollingPlayer = null;
					} else if (dgPlayers.length == 0) {
						// player was playing alone, so he loses
						setTimeout(() => { io.emit('chatMessageSent', socket.username + " loses. You were playing alone, what did you expect?"); }, 1000);
						setTimeout(() => { resetGame(); io.emit('resetGame', getGameState()); }, 5000);
						currentlyRollingPlayer = null;
					}
				}
			}
		}

		io.emit('userRolled', getGameState());
	});
});

function startGame(startingUser) {
	currRoll = 100;
	gameInProgress = true;
	dgPlayers = dgPlayers.concat(lobby).concat(graveyard);
	lobby = [];
	graveyard = [];
	currentlyRollingPlayer = startingUser;
	// put starting user at front of dgPlayers
	for (var i = 0; i < dgPlayers.length; i += 1) {
		var player = dgPlayers[i];
		if (player.userName == startingUser) {
			// remove player from where he was and insert at front
			dgPlayers.splice(i, 1);
			dgPlayers.splice(0, 0, player);
		}
	}
}

function resetGame() {
	currRoll = 100;
	// bring everyone back into the lobby
	lobby = lobby.concat(dgPlayers).concat(graveyard);
	dgPlayers = [];
	graveyard = [];
	gameInProgress = false;
	currentlyRollingPlayer = null;
}

function getGameState() {
	return {
		gameInProgress: gameInProgress,
		currentlyRollingPlayer: currentlyRollingPlayer,
		currRoll: currRoll,
		lobby: lobby,
		dgPlayers: dgPlayers,
		graveyard: graveyard
	};
}

function removePlayer(userName) {
	for (var i = 0; i < userNames.length; i += 1) {
		if (userNames[i] == userName) {
			userNames.splice(i, 1);
			i -= 1;
		}
	}

	// if the player was rolling, calculate the next player to roll
	if (userName == currentlyRollingPlayer) {
		for (var i = 0; i < dgPlayers.length; i += 1) {
			if (dgPlayers[i].userName == userName) {
				var nextPlayerIndex = (i + 1) % dgPlayers.length;
				currentlyRollingPlayer = dgPlayers[nextPlayerIndex].userName;
			}
		}
	}

	removeFromArr(lobby);
	removeFromArr(dgPlayers);
	removeFromArr(graveyard);
	function removeFromArr(arr) {
		for (var i = 0; i < arr.length; i += 1) {
			if (arr[i].userName == userName) {
				arr.splice(i, 1);
				i -= 1;
			}
		}
	}
}

http.listen(port, function() {
	console.log('Server started on port ' + port);
});
