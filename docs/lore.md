# Lore and naming conventions

The setting is a navy that happens to operate in orbit. Tone is terse and professional: no parody, no jokes in the standard voice. Text only; none of this changes simulation behaviour.

## Service and chain of command

- **Fleet Command** issues orders. Briefings are written as orders from Fleet Command.
- The player is the **Commander** and holds the helm. The word "Commander" is load-bearing: `addressCommander` swaps it for the player's chosen name, so keep it exactly that spelling in spoken lines.
- Missions are **operations** or **exercises**. The mission list is the **Operations Board**; a finished mission shows **Objectives Met** or **Operation Failed**.

## Ship intelligence

- **ARGUS** is the Corvette's ship intelligence. It speaks on the bridge, reports, recommends and confirms. It never acts without an order (see the vessel AI notes).
- Other hulls keep their callsigns in `voice.json`: BASTION (Gunboat), SEXTANT (Minelayer), DRONE CORE, BEACON.
- Standard voice uses naval verbs: "aye", "unable", "standing by", "weapons free", "secured", "on station", "astern", "beam", "away". Missiles may be called "birds". Avoid slang and quips.
- Alternate personas are other flavours of the same fleet intelligence: **Marshal** (gruff chief), **Halcyon** (calm), **Quill** (dry). They override lines only; identifiers and placeholders such as `{callsign}`, `{range}` and `{t}` must stay intact.

## Vocabulary

| Plain | Naval |
| --- | --- |
| behind | astern |
| beside | on the beam |
| engine off | engine secured |
| full throttle | all ahead full |
| sandbox | open patrol |
| autopilot panel | helm |
| clock | ship time |
| target (selected) | track / designated contact |

## Vessel names

- Player hull: Corvette. Enemies and allies: Gunboat, Minelayer, Freighter, Raider, Wingman.
- Practice targets are **Target Drones**. Nav aids are **beacons**.
- Callsign strings and `SHIP_CLASS_NAMES` are identifiers used by tests and the HUD. Rename display text only, not those values.
