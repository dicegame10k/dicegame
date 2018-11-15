angular.module('diceGameApp', [])
  .controller('DiceGameController', ['$scope', '$interval', '$timeout',
  	function ($scope, $interval, $timeout) {
  		var socket = io();
		$scope.isLoggedIn = false;
  		$scope.userName = '';
  		$scope.wowClass = '';
  		$scope.wowClasses = ["death-knight", "demon-hunter", "druid", "hunter", "mage", "monk", "paladin", "rogue", "shaman", "warlock", "warrior"];
  		$scope.currRoll;
  		$scope.lobby = [];
  		$scope.players = [];
  		$scope.graveyard = [];
  		$scope.chatMessages = [];
  		$scope.leaderboard = [];
  		$scope.chatMsg = '';
  		$scope.gameInProgress = false;
  		$scope.currentlyRollingPlayer = null;
  		$scope.showDiceGame = true;
  		$scope.showLeaderboard = false;

		$scope.toggleDiceGame = function() {
			$scope.showDiceGame = true;
			$scope.showLeaderboard = false;
		};

		$scope.toggleLeaderboard = function() {
			$scope.showDiceGame = false;
			$scope.showLeaderboard = true;
		};

		$scope.addNavItemHoverClass = function($event) {
			$event.target.classList.add($scope.wowClass);
		}

		$scope.removeNavItemHoverClass = function($event) {
			$event.target.classList.remove($scope.wowClass);
		}

  		$scope.requestReset = function() {
  			socket.emit("requestReset");
  		};

		socket.on('resetGame', function(gameState) {
			_updateGameState(gameState);
		});

		// Chat
		socket.on('chatMessageSent', function(msg) {
			$timeout(() => { $scope.chatMessages.push(msg) });
		});

		$scope.chat = function() {
			if ($scope.chatMsg == '')
				return;

			if ($scope.handleAdminCommand())
				return;

			socket.emit('chatMessageSent', $scope.chatMsg);
			$scope.chatMsg = '';
		};

		//TODO: whisper capabilities
		$scope.handleAdminCommand = function() {
			// map of admin commands to the scope functions that will be called
			var adminCommands = {
				'/roll': $scope.roll,
				'/stuck': $scope.requestReset,
				'/lightup': $scope.lightUp,
				'/force_roll': $scope.forceRoll,
				'/kick': $scope.kick
			}

			// only look at the first word of chat
			var firstWord = $scope.chatMsg.toLowerCase().split(' ')[0];
			if (typeof adminCommands[firstWord] === "function") {
				try {
					adminCommands[firstWord]($scope.chatMsg);
				} catch (e) {
					console.log("Admin command didn't work", e);
				}

				$scope.chatMsg = '';
				return true;
			}

			return false;
		};

		$scope.kick = function(chatMsg) {
			var playerToKick = chatMsg.split(' ')[1];
			if (!playerToKick)
				return;

			socket.emit("kickPlayer", playerToKick);
		};

		socket.on('playerKicked', function(playerWhoWasKicked, gameState) {
			$timeout(() => {
				// log out if you were the one kicked
				if ($scope.userName == playerWhoWasKicked)
					$scope.isLoggedIn = false;

				_updateGameState(gameState);
			});
		});

		//Login
		$scope.login = function() {
			if ($scope.userName == '') {
				alert("Enter a username");
				return;
			}

			if ($scope.wowClass == '') {
				alert("Choose a class");
				return;
			}

			if ($scope.userName.length > 8) {
				alert('Username is too long');
				return;
			}

			// make the first letter uppercase and all other letters lowercase
			$scope.userName = $scope.userName.charAt(0).toUpperCase() + $scope.userName.slice(1).toLowerCase();

			//profanity check
			if ($scope.userName.indexOf('Nig') != -1) {
				alert("C'mon now Mike");
				return;
			}

			socket.emit("login", $scope.userName, $scope.wowClass);

			socket.on('loginFailed', function(reason) { alert(reason); });
			socket.on('loginSuccessful', function(gameState) {
				$timeout(() => {
					_updateGameState(gameState);
					$scope.isLoggedIn = true;
				});
			});
		};

		$scope.chooseClass = function($event) {
			var prevSelectedElem = document.getElementsByClassName('wow-class-icon-selected')[0];
			if (prevSelectedElem)
				prevSelectedElem.classList.remove('wow-class-icon-selected');

			$scope.wowClass = $event.target.id;
			$event.target.classList.add("wow-class-icon-selected");
		};

		socket.on('playerJoined', function(gameState) {
			_updateGameState(gameState);
		});

		socket.on('playerLeft', function(gameState) {
			_updateGameState(gameState);
		});

		// DiceGame
		$scope.lightUp = function() {
			socket.emit("lightUp", $scope.userName);
		}

		socket.on("gameStarted", function(gameState) {
			_updateGameState(gameState);
		});

  		$scope.roll = function() {
  			if ($scope.currentlyRollingPlayer !== $scope.userName) {
  				$scope.chatMessages.push("It is not your turn to roll");
  				return;
  			}

			$scope.currentlyRollingPlayer = "this_is_only_to_hide_the_button_i_love_hacky_workarounds_like_this";
  			socket.emit("roll");
  		};

  		$scope.forceRoll = function() {
  			socket.emit("forceRoll");
  		};

  		socket.on('userRolled', function(gameState) {
			var i = 1;
			var prevRoll = $scope.currRoll;
			$interval(function() {
				if (i == 20) {
					_updateGameState(gameState);
				} else {
					// if it's not the last call, fake a roll to build suspense
					$scope.currRoll = Math.floor(Math.random() * prevRoll) + 1;
				}

				i += 1;
			}, 50, 20);
  		});

		function _updateGameState(gameState) {
			$timeout(() => {
				$scope.gameInProgress = gameState.gameInProgress;
				$scope.currRoll = gameState.currRoll;
				$scope.currentlyRollingPlayer = gameState.currentlyRollingPlayer;
				$scope.lobby = gameState.lobby;
				$scope.players = gameState.dgPlayers;
				$scope.graveyard = gameState.graveyard;
				setTimeout(() => {
					var playerCards = document.getElementsByClassName('player-in-game');
					if (playerCards.length == 0)
						return;

					// highlight the currently rolling player
					for (var i = 0; i < playerCards.length; i += 1) {
						var playerCard = playerCards[i];
						if (playerCard.id == $scope.currentlyRollingPlayer)
							playerCard.classList.add("player-rolling");
						else
							playerCard.classList.remove("player-rolling");
					}

					// calculate offset of the roll number and button
					var currRollElem = document.getElementById('currRoll');
					currRollElem.style = calculateOffsetStyle(currRollElem);
					var rollButtonElem = document.getElementById('rollButton');
					rollButtonElem.style = calculateOffsetStyle(rollButtonElem, currRollElem.offsetHeight / 2);
					var fireGifElem = document.getElementById('fire');
					fireGifElem.style = calculateOffsetStyle(fireGifElem);

					// position the players around the fire
					var offsetStyle = calculateOffsetStyle(playerCards[0]);
					for (var i = 0; i < playerCards.length; i++) {
						var offsetAngle = 360 / playerCards.length;
						var rotateAngle = offsetAngle * i;
						playerCards[i].style = offsetStyle + "transform : rotate(" + rotateAngle + "deg) translate(0, -200px) rotate(-" + rotateAngle + "deg)";
					}
				}, 20);
			});
		}

		function calculateOffsetStyle(element, additionalOffsetTop) {
			var offsetLeft = document.body.offsetWidth / 2 - element.offsetWidth / 2;
			var offsetTop = document.body.offsetHeight / 2 - element.offsetHeight / 2;
			if (typeof additionalOffsetTop == "number")
				offsetTop += additionalOffsetTop;

			var offsetStyle = "left: " + offsetLeft + "px; top: " + offsetTop + "px; ";
			return offsetStyle;
		}

		// Leaderboard
		socket.on("leaderboardUpdated", function(leaderboard) {
			$timeout(() => {
				leaderboard.sort(lbSort);
				$scope.leaderboard = leaderboard;
				// highlight the current user on the leaderboard
				setTimeout(() => {
					var leaderboardPlayers = document.getElementById('leaderboardBody').children;
					for (var i = 0; i < leaderboardPlayers.length; i += 1) {
						var player = leaderboardPlayers[i];
						for (var j = 0; j < $scope.wowClasses.length; j += 1)
							player.classList.remove($scope.wowClasses[j]);
					}

					var leaderboardPlayer = document.getElementById($scope.userName + "-leaderboard");
					if (!leaderboardPlayer)
						return;

					leaderboardPlayer.classList.add($scope.wowClass);
				}, 50);
			});

			function lbSort(a, b) {
				return a.wins > b.wins ? -1 : 1;
			}
		});

  }]);
