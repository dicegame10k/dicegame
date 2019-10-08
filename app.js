var express = require('express');
var path = require('path');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var port = process.env.PORT || 8080;

// dynamoDB setup for leaderboard
var AWS = require("aws-sdk");

// To start dynamoDB locally, go to the directory where it's unzipped and run:
// java -Djava.library.path=./DynamoDBLocal_lib -jar DynamoDBLocal.jar -sharedDb
var awsConfig = {
	region: "us-west-2",
	endpoint: "http://localhost:8000"
};

// When uploading new ZIP to elasticbeanstalk, replace accessKeyId and secretAccessKey with creds in ~/.aws/credentials
//var awsConfig = {
//	region: "us-west-2",
//	accessKeyId: "",
//	secretAccessKey: "",
//}

AWS.config.update(awsConfig);

var dynamodb = new AWS.DynamoDB();
var docClient = new AWS.DynamoDB.DocumentClient();
var leaderboardTableName = "Leaderboard";

// Routing
app.use(express.static(path.join(__dirname, 'public')));

http.listen(port, function() {
	console.log('Server started on port ' + port);
});

var currRoll = 100;
var dkpWon = 0;
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
					// give the player that rolled a 1 some dkp
					updateLeaderboard(playerRolling, dkpWon, false);
					dkpWon += 1;

					// check if game is over
					if (dgPlayers.length < 2) {
						if (dgPlayers.length == 0) // player was playing alone, so he loses
							setTimeout(() => { io.emit('chatMessageSent', playerRolling + " loses. You were playing alone, what did you expect?"); }, 1000);
						else if (dgPlayers.length == 1) { // win condition, give the winning player their dkp
							var winningPlayerUserName = dgPlayers[0].userName;
							setTimeout(() => { io.emit('chatMessageSent', winningPlayerUserName + " wins!"); }, 1400);
							updateLeaderboard(winningPlayerUserName, dkpWon, true);
						}

						setTimeout(() => { resetGame(); io.emit('resetGame', getGameState()); }, 5000);
						currentlyRollingPlayer = null;
					}
				}
			}
		}

		io.emit('userRolled', getGameState());
	};

	socket.on('clearLeaderboard', function() {
		clearLeaderboard();
	});

	socket.on('deletePlayerFromLeaderboard', function(playerToDelete) {
		deletePlayerFromLeaderboard(playerToDelete, () => {
			getLeaderboard((leaderboard) => { io.emit('leaderboardUpdated', leaderboard)});
		});
	});
});

function startGame(startingUser) {
	currRoll = 100;
	dkpWon = 0;
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
	dkpWon = 0;
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
function updateLeaderboard(playerUserName, dkpWon, isWinningPlayer) {
	// delay the chat message if this is the winning player, because the losing player's message should go out first
	var chatMsgDelay = isWinningPlayer ? 1500 : 1050;
	var playerParams = {
	    TableName: leaderboardTableName,
	    Key: {
	        "username": playerUserName
	    }
	};

	// first check if this user already has a record. If so, increment number of dkp, otherwise create a new record
	docClient.get(playerParams, function(err, data) {
	    if (err) {
	        console.log("Error retrieving user record for " + playerUserName, err);
	        setTimeout(() => { io.emit('chatMessageSent', "Error retrieving " + playerUserName + "'s leaderboard record. Failbeats dev"); }, chatMsgDelay);
	        return;
	    }

	    var userRecord = data["Item"];
	    if (userRecord) {
	        // user exists, increment dkp
	        var incrementdkpParams = {
	            TableName: leaderboardTableName,
	            Key: {
	                "username": playerParams["Key"]["username"]
	            },
	            UpdateExpression: "set dkp = dkp + :val",
	            ExpressionAttributeValues: {
	                ":val": dkpWon
	            },
	            ReturnValues:"UPDATED_NEW"
	        }

	        docClient.update(incrementdkpParams, function(err, data) {
	            if (err) {
	                console.log("Error updating user record for " + playerUserName, err);
	                setTimeout(() => { io.emit('chatMessageSent', "Error updating " + playerUserName + "'s leaderboard record. Failbeats dev"); }, chatMsgDelay);
	                return;
	            }

				var playerTotaldkp = data["Attributes"]["dkp"];
	            setTimeout(() => {
	            	io.emit('chatMessageSent', playerUserName + " won " + dkpWon + " DKP (" + playerTotaldkp + " total)");
	            	// broadcast the new leaderboard
	            	getLeaderboard((leaderboard) => {
						io.emit("leaderboardUpdated", leaderboard);
	            	});
	            }, chatMsgDelay);
	        });
	    } else {
	        // user does not exist, create new record
	        var newUserParams = {
	            TableName: leaderboardTableName,
	            Item: {
	                "username": playerUserName,
	                "dkp": dkpWon
	            }
	        };

	        docClient.put(newUserParams, function(err, data) {
	            if (err) {
	                console.log("Error creating user record for " + playerUserName, err);
	                setTimeout(() => { io.emit('chatMessageSent', "Error creating " + playerUserName + "'s leaderboard record. Failbeats dev"); }, chatMsgDelay);
	                return;
	            }

	            setTimeout(() => {
	            	io.emit('chatMessageSent', playerUserName + " won " + dkpWon + " DKP (" + dkpWon + " total)");
	            	// broadcast the new leaderboard
	            	getLeaderboard((leaderboard) => {
						io.emit("leaderboardUpdated", leaderboard);
	            	});
	            }, chatMsgDelay);
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
    		console.log("Error scanning table while trying to broadcast new leaderboard", err);
    		return;
    	}

        callback(data["Items"]);
    });
}

// CAUTION...
function clearLeaderboard() {
	console.log("WARNING: Clearing the leaderboard");
	getLeaderboard((leaderboard) => {
		var numRecordsDeleted = 0;
		for (var i = 0; i < leaderboard.length; i += 1) {
			var aUsername = leaderboard[i].username;
			deletePlayerFromLeaderboard(aUsername, () => {
				numRecordsDeleted += 1;
				if (numRecordsDeleted == leaderboard.length)
					getLeaderboard((leaderboard) => { io.emit('leaderboardUpdated', leaderboard)});
			});
		}
	});
}

function deletePlayerFromLeaderboard(playerToDelete, callback) {
	var deleteParams = {
		TableName: leaderboardTableName,
		Key: {
			"username": playerToDelete
		}
	};

	docClient.delete(deleteParams, function(err, data) {
		if (err) {
			console.log("Failed to delete player " + playerToDelete + " from leaderboard", err);
			return;
		}

		console.log("Successfully deleted " + playerToDelete + " from leaderboard");
		callback();
	});
}
