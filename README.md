# CFB Live

A live college football screen for a laptop or iPad: the games you pick, each with score, clock, possession,
down and distance, a drawn field, last play and win probability, plus alerts in team colours.

Live at https://cfb-live.joel-studer13.workers.dev (Cloudflare Workers, auto-deploys from `main`).

## Alerts
- **Full screen, with horn:** touchdown, field goal, safety, turnover (interception, fumble, turnover on downs), final.
- **On the game card, no sound:** first down, change of possession (punt, missed kick), kickoff, entering the red zone.
- A game in the red zone gets a pulsing red frame and the last 20 yards shaded.

## Use
- **Games** opens the picker (all FBS games of the week). Picks are saved on each device.
- `?games=ID,ID` preselects games (ESPN event ids); `?demo=td,fg,int,downs,final,first,poss,rz` fires test alerts; `?nostart` skips the start screen.

## Data
ESPN public feeds, trimmed by the Worker (`src/index.js`):
- `/api/board`: scoreboard (`groups=80`) for the picker.
- `/api/game/:id`: game summary + core-API `situation` (down, distance, timeouts, possession).

Note: ESPN's `yardLine` counts from the **home** team's goal line (0) to the away team's (100).
Red zone is computed from possession and ball spot (ESPN's `isRedZone` lags after turnovers).
Turnovers come from drive results as well as play types, because `isTurnover` is not always set.
