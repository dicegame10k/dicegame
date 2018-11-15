var express = require('express');
var path = require('path');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || 8080;

// dynamoDB setup for leaderboard
var AWS = require("aws-sdk");
AWS.config.update({
  region: "us-west-2",
  endpoint: "http://localhost:8000"
});
var dynamodb = new AWS.DynamoDB();
var docClient = new AWS.DynamoDB.DocumentClient();
var leaderboardTableName = "Leaderboard";

// Routing
app.use(express.static(path.join(__dirname, 'public')));

http.listen(port, function() {
	console.log('Server started on port ' + port);
});

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

	socket.on('kickPlayer', function(playerToKick) {
		if (!playerToKick)
			return;

		console.log(socket.username + " is kicking " + playerToKick);
		if (userNames.indexOf(playerToKick) == -1) {
			console.log("Cannot kick " + playerToKick + ", player does not exist");
			socket.emit('chatMessageSent', "Cannot kick " + playerToKick + ", player does not exist");
			return;
		}

		removePlayer(playerToKick);
		io.emit('chatMessageSent', playerToKick + " kicked out of the game by " + socket.username);
		io.emit('playerKicked', playerToKick, getGameState());
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
		// send the leaderboard to the new user only
		getLeaderboard((leaderboard) => {
			socket.emit('leaderboardUpdated', leaderboard);
		});
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

		roll(socket.username);
	});

	socket.on('forceRoll', function() {
		// just forcibly roll as the player who is supposed to be rolling
		roll(currentlyRollingPlayer);
	});

	function roll(playerRolling) {
		if (!gameInProgress)
			return;

		currRoll = Math.floor(Math.random() * currRoll) + 1;
		var rollMsg = playerRolling + " rolled " + currRoll;
		if (currRoll == 1)
			rollMsg += " (RIP)";

		console.log(rollMsg);
		// don't send the chat message immediately
		setTimeout(() => { io.emit('chatMessageSent', rollMsg); }, 1000);

		// calculate the next player to roll
		for (var i = 0; i < dgPlayers.length; i += 1) {
			var player = dgPlayers[i];
			if (player.userName == playerRolling) {
				var nextPlayerIndex = (i + 1) % dgPlayers.length;
				currentlyRollingPlayer = dgPlayers[nextPlayerIndex].userName;

				// move to graveyard if rolled a 1
				if (currRoll == 1) {
					dgPlayers.splice(i, 1);
					graveyard.push(player);
					currRoll = 100;
					// check win condition
					if (dgPlayers.length == 1) {
						setTimeout(() => { updateLeaderboard(dgPlayers[0].userName); }, 1000);
						setTimeout(() => { resetGame(); io.emit('resetGame', getGameState()); }, 5000);
						currentlyRollingPlayer = null;
					} else if (dgPlayers.length == 0) {
						// player was playing alone, so he loses
						setTimeout(() => { io.emit('chatMessageSent', playerRolling + " loses. You were playing alone, what did you expect?"); }, 1000);
						setTimeout(() => { resetGame(); io.emit('resetGame', getGameState()); }, 5000);
						currentlyRollingPlayer = null;
					}
				}
			}
		}

		io.emit('userRolled', getGameState());
	};
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

	// reset the game if nobody else is playing, so it doesn't get stuck in progress with nobody playing
	if (gameInProgress && dgPlayers.length == 0) {
		console.log("Resetting game in progress, nobody is playing it");
		resetGame();
		io.emit("chatMessageSent", "Resetting game in progress, nobody is playing it");
		io.emit('resetGame', getGameState());
	}

	function removeFromArr(arr) {
		for (var i = 0; i < arr.length; i += 1) {
			if (arr[i].userName == userName) {
				arr.splice(i, 1);
				i -= 1;
			}
		}
	}
}

// Leaderboard
function updateLeaderboard(winningPlayer) {
	// write down the win message here (without total wins) so we can still send out a chat message in case any DB operation fails
	var winMsg = winningPlayer + " wins!";
	var winningPlayerParams = {
	    TableName: leaderboardTableName,
	    Key: {
	        "username": winningPlayer
	    }
	};

	// first check if this user already has a record. If so, increment number of wins, otherwise create a new record with 1 win
	docClient.get(winningPlayerParams, function(err, data) {
	    if (err) {
	        console.log("Error retrieving winning user record", data);
	        io.emit('chatMessageSent', winMsg);
	        return;
	    }

	    var userRecord = data["Item"];
	    if (userRecord) {
	        // user exists, increment wins by 1
	        var incrementWinsParams = {
	            TableName: leaderboardTableName,
	            Key: {
	                "username": winningPlayerParams["Key"]["username"]
	            },
	            UpdateExpression: "set wins = wins + :val",
	            ExpressionAttributeValues: {
	                ":val": 1
	            },
	            ReturnValues:"UPDATED_NEW"
	        }

	        docClient.update(incrementWinsParams, function(err, data) {
	            if (err) {
	                console.log("Error updating winning user record", data);
	                io.emit('chatMessageSent', winMsg);
	                return;
	            }

				var winningPlayerTotalWins = data["Attributes"]["wins"];
	            winMsg = winningPlayer + " wins! (" + winningPlayerTotalWins + " total)";
	            io.emit('chatMessageSent', winMsg);
	            // broadcast the new leaderboard
	            getLeaderboard((leaderboard) => {
					io.emit("leaderboardUpdated", leaderboard);
	            });
	        });
	    } else {
	        // user does not exist, create new record with one win
	        var newUserParams = {
	            TableName: leaderboardTableName,
	            Item: {
	                "username": winningPlayer,
	                "wins": 1
	            }
	        };

	        docClient.put(newUserParams, function(err, data) {
	            if (err) {
	                console.log("Error creating wining user record", data);
	                io.emit('chatMessageSent', winMsg);
	                return;
	            }

				winMsg = winningPlayer + " wins! (1 total)";
	            io.emit('chatMessageSent', winMsg);
	            // broadcast the new leaderboard
	            getLeaderboard((leaderboard) => {
					io.emit("leaderboardUpdated", leaderboard);
	            });
	        });
	    }
	});
}

var scanTableParams = {
    TableName: leaderboardTableName
};

// asynchronously reads the leaderboard and calls callback with the leaderboard data
function getLeaderboard(callback) {
    docClient.scan(scanTableParams, function(err, data) {
    	if (err) {
    		console.log("Error scanning table while trying to broadcast new leaderboard", data);
    		return;
    	}

        callback(data["Items"]);
    });
}

//TODO: env variables/table setup in aws
//TODO: aws credentials
