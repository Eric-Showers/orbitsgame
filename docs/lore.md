# Lore and naming conventions

The setting is a navy that happens to operate in orbit. Reports, alarms and orders are terse and professional; personality comes out in quips, which are kept to quiet moments. Text only; none of this changes simulation behaviour.

## Service and chain of command

- **Fleet Command** issues orders. Briefings are written as orders from Fleet Command.
- The player is the **Commander** and holds the helm. The word "Commander" is load-bearing: `addressCommander` swaps it for the player's chosen name, so keep it exactly that spelling in spoken lines.
- Missions are **operations** or **exercises**. The mission list is the **Operations Board**; a finished mission shows **Objectives Met** or **Operation Failed**.

## Ship intelligence

- **ARGUS** is the Corvette's ship intelligence. It speaks on the bridge, reports, recommends and confirms. It never acts without an order (see the vessel AI notes).
- Each voice persona is a different ship intelligence with its own callsign (`callsign` in `personas.json`); the player's hull uses the chosen persona's callsign for `{callsign}`. Persona ids (`argus`, `halcyon`, `marshal`, `quill`) are stable identifiers saved in settings; names and callsigns are display text.
- The AI works the player's name in on routine lines (about every third) and keeps the default title "Commander" rare. Use "Commander" only as a form of address (", Commander." or "Commander, ..."), never as a noun ("the Commander is ready"), because the default-title pass strips it.
- Other hulls keep their callsigns in `voice.json`: BASTION (Gunboat), SEXTANT (Minelayer), DRONE CORE, BEACON.
- Naval verbs suit reports and alarms: "aye", "unable", "standing by", "weapons free", "secured", "on station", "astern", "beam", "away". Missiles may be called "birds".

### The four ship intelligences

Each blends two familiar sci-fi archetypes into one original character. The sources are for writers only; never name them in game text.

| Persona id | Callsign | Character                                                                                  | Writers' blend               |
| ---------- | -------- | ------------------------------------------------------------------------------------------ | ---------------------------- |
| `argus`    | ARGUS    | Default. Logic first, loyalty always: precise, dryly curious about organics, quietly fond. | Spock + Cortana              |
| `halcyon`  | VALIANT  | Bold, blunt, impatient with nonsense; a rousing speech for every occasion.                 | Leela + Captain Kirk         |
| `marshal`  | BRASS    | Self-declared tactical genius calling the fight as play-by-play; loud, sports metaphors.   | Zapp Brannigan + John Madden |
| `quill`    | RIVET    | Logic engine with a salvage habit and contempt for organics; lazy, greedy, secretly loyal. | Bender + Spock               |

### Dialogue categories

Every line in `voice.json` has a `category`, and each category is paced on its own (`categories` and `lull` in `voice.json`):

- **alarm**: danger now (ground intercept, inbound missile, mines, drive heat limit, hull damage). Spoken at once.
- **event**: something just happened (missile away, splash, a launch, a contact making a significant burn, the AI coming online).
- **status**: readings (orbit now X by Y, drive heat, target range). Held until a lull: no burn, no autopilot maneuver, no alarm and no event for `quietSeconds`; or at once when the commander raises time warp after changing orbit. Only what changed since the last report is said.
- **objective**: what to do next for the active mission objective, read off the live situation ("lower our orbit to catch up", "raise our orbit to stay behind it", "climb into the lane before laying mines"). Lines are `obj.*`; distances are in `objective` in `voice.json`. Shares the lull slot with quips and wins it, but the same objective line is never said twice running; banter fills the gap until the situation changes.
- **quip**: banter. Lull only, after status has been said, at most one per `categories.quip.minGap` (30 s). Situational pools (`quip.hunting`, `quip.victory`, `quip.damaged`, `quip.warp`) are mixed with `quip.idle`; a pool is used up before any line repeats.
- **helm**: the autopilot conversation (`ap.*`), next-step guidance (`guide.*`) and mission coaching.

Engine and heading changes are not called out (no "prograde, aye" or "ignition"); the HUD shows them.

## Vocabulary

| Plain             | Naval                      |
| ----------------- | -------------------------- |
| behind            | astern                     |
| beside            | on the beam                |
| engine off        | engine secured             |
| full throttle     | all ahead full             |
| sandbox           | open patrol                |
| autopilot panel   | helm                       |
| clock             | ship time                  |
| target (selected) | track / designated contact |

## Vessel names

- Player hull: Corvette. Enemies and allies: Gunboat, Minelayer, Freighter, Raider, Wingman.
- Practice targets are **Target Drones**. Nav aids are **beacons**.
- Callsign strings and `SHIP_CLASS_NAMES` are identifiers used by tests and the HUD. Rename display text only, not those values.

## Adversary pilots

Enemy ships that fly themselves carry a named pilot: Kestrel, Shrike, Hunter, Fang, Talon and Reaper. Each is a callsign, not a rank. Briefings describe them by behaviour (reactive, patient, pursuing) and never by hit points or tier numbers.
