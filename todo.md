x create room
x join room
x usernames
x turn changing
x two windows
x game state, striker positioning, aiming, striker moving
x coins moving, striker and coins stopping
x board size, border location
x pocket radius and locations
x coin mass, radius, color, positions
x striker mass, radius, position
x slingshot mechanism for striker
x striker position switching
x collisions between striker, coins, border
x pocket checking for coins
x coin deletion
x score incrementing or turn changing on coin pocket
x striker position reset on turn continuation
x pocket checking for striker
x debt incrementing, coin reseting to center, score decrementing, debt decrementing, turn changing on striker pocket
x queen pocketing, cover turn
x queen resetting to the center
x game reset after max points
x clean console logs
? prioritize resetting queen to center if striker pocketed after
? realistic dimensions
? slingshot double click bug
  animation for pocketing coins, striker
? no overlapping
x starting grid
? longer heartbeats in server?

x map out client server communication and game functions
? calculate physics on clients, send input via server  (went server-authoritative instead — input via client, physics on server)
x handling multiple coin pocket or coin and striker pocket, and turn continuation or change

? blue button text on mobile
? no slider on mobile

? player should be able to leave room, and same/new player should be able to join
x if both players leave, room should be deleted
? player should be able to refresh while in room
x fix slow speed on joiner window
? refresh and retry bug
  better physics
  refactor
  more ui
x assign more points for queen
? room scoreboard
? board, coin designs
  mobile controls
  sound, synth idea
? deploy
x multiple games at the same time
  talcom powder
? merge with carrom 1.0
  new game modes
? cutting the moon, circles
? slider to rotate starting grid

  display pocketed coins
x handle positioning of muliple coin reset to the center
? striker position reset animation
? coins stacked on frame
? coins animated moving to frame
x allow covering queen in the same turn
  4 players

? phaser, redis, postgresql, websockets, node

let's change up the striker placement and flicking rules a bit. 
there should be two words that are buttons called place and flick
by deafult when its a plyaers turn flick should be grey and place should be black which means its in place mode right now
clicking and dragging the striker or anywhere on the board (not outside the board anymore) should move it and place it on the striking area.
once player is satisfied with the striker placement, they can either click the flick button, or double click anywhere on the board, this will switch to flick mode, now clicking and dragging will show the slingshot line, and releasing will flick it.
when flicking there needs to be a undo or reset. this is tricky. on computer since there can be only one point of click clicking escape should reset the flick line and make the mode into place mode. on phone, since two points can be touched, since one point has clicked and is now dragging the flicker, the second finger of the user can tap anywhere on the board or on the place button so it cancels the flick. does that make sense? ask questions for more clarity.
the animation into the pocketing a coin or striker is very laggy right now. even if the coin or striker has not reached the pocket, the animation starts and the coin starts disappeaings pre emptively. i need the coin or striker to reach the pocket and then and only then once it has cross the boundary of the pocket, the animation starts. investigate why the animation is broken and how it can be fixed for both users playing the game.

the striker should not be flickable if it's overlapping a coin while being positioned. if it is placed in a place of overlap with a coin, then the striker should be greyed out and user is not allowed to flick.

the board has a border which has a thickness and space between itself, that's the physical actual wooden border that carrom boards have. in real life when a coin is pocketd players have a habit of keeping the coins they pocketed on that wooden ledge border
when a coin is pocketed, show the coin on the edge of the board for the user who pocketed it. start from left to right with a bit of space between each coin.

after the feature above is implemented do this one:
there are multiple moments when coins or strikers correctly "teleport" from one location to another. when a coin is pocketed, we now want the coin to go to the user's side's border. when a striker is pocketed, the striker goes to the opposite player, and if the player had a point it is lost and a coin is given up from their border ledge. there might be some other movements/teleports that i might be missing, find all of them. the change is that i want the teleport to happen with a simple animation. the coin or srtiker should move from place A to place B in a smooth automated mvoement rather than just a teleport.

when a user pockets their own striker and now has debt, and they have no coins pocketed previously, which means their score was zero, the score variable should go to -1 the one that is deiaplyed on the screen.

after a user pockets all of their coins, there should be a new number shown in bold next to their name signifying number of games won. this number should not show if zero games have been completed. sonly after the first game should we show game wins. so it should be like this PLAYER1 1 0 PLAYER2 0 0.

game is over when user pockets all coins with the queen covered. if a user pockets their last coin and the queen is still not covered, the last coin doe snot get pocketed ,it is returned to the center and the score does not increment.

do not give extra points for the queen, it should just be worth one point.

if a user 1 has covered the queen, but user 2 pockets all their coins, that's fine user 2 wins. 

the colors of the coins should not be set by default white to player 1 and black to player 2, instead the first person to pocket a coin gets that color set to that coin. same applies for the queen, if the first coin someone pockets is the queen, then they can cover with any coin and that coin color becomes their color.

lets try to avoid having the same perosn on the same browser join twice. there was a case where i created a new room and joined it, went back on the browser, then entered the same username and the same room name and joined again and now the room was filled with two of my instances. can you investigate and research better mechansisms for room joining? ask me questions if needed

if no username or room name is entered, join room and create room buttons should be greyed out an unclickable

why does https://carrom-2222.el.r.appspot.com/ still exist? can we get rid of it? since https://carrom-client-23xhui47pq-uc.a.run.app/ is now the default? also since i own hvrc.place can we set the url to be carrom.hvrc.place? subdomain mapping?

can we have a simple ROOMS label on top of the rooms?

instant replay in slow mo

better animation for teleporting
double click to toggle flick to place
name placement
post flick lag

.

skins
scoreboard
mini game
ruler
friction