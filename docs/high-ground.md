# High ground in orbit

Design note for choosing how the game models positional advantage. Nothing here
is implemented yet; the game owner picks a formulation first.

Numbers use the game's world: planet radius 600 km, mu 3.5316e12 m^3/s^2.

## 1. What high ground means physically

There is no single "high ground" in orbit. It is a bundle of separate effects,
and some of them point in opposite directions.

**Higher means more energy, but slower.** Specific energy is -mu / 2a, so a
bigger orbit has more energy. Yet a higher circular orbit is slower and has a
longer period.

| Altitude | Circular speed | Period |
| --- | --- | --- |
| 80 km | 2279 m/s | 31 min |
| 100 km | 2246 m/s | 33 min |
| 200 km | 2101 m/s | 40 min |
| 300 km | 1981 m/s | 48 min |

**The lower ship laps the higher one.** At 80 km versus 100 km the speed
difference is about 33 m/s, so the low ship gains roughly 1.6 m/s of drift per
km of altitude gap. Both ships keep meeting each other's neighbourhood, but the
low ship chooses when to pass through it only if it can also change its orbit.

**Apoapsis dwell time.** On an eccentric orbit a ship is slowest at apoapsis
(Kepler's second law). An 80 x 300 km orbit moves at 2432 m/s at periapsis and
1838 m/s at apoapsis, so it spends most of its period high up. A ship that
parks its apoapsis over the fight stays there longer and sees the area for
longer.

**Delta-v to change orbit.** Moving up is cheap early and costs more as the gap
grows (Hohmann transfer from 80 km): to 100 km costs 33 m/s, to 150 km 109 m/s,
to 200 km 178 m/s, counting both burns. Position is a bank account paid in
delta-v. A ship with more fuel or more heat budget can afford to move.

**Counterintuitive burn effects.**
- Burning prograde raises the orbit on the opposite side, not where you burn,
  and the ship then slows down in the long run.
- To catch a ship ahead of you on the same orbit, you burn retrograde (drop
  lower, speed up), then burn prograde to rise back. Burning prograde toward it
  makes you fall behind.
- A burn at periapsis changes the apoapsis most. A burn at apoapsis changes the
  periapsis most. A cheap burn in the right place beats a big burn in the wrong
  one.

**Line of sight over the horizon.** The planet blocks sight lines. Ground range
to the horizon is sqrt(r^2 - R^2): 320 km from 80 km altitude, 529 km from
200 km. Two ships at 80 and 200 km can see each other out to about 850 km
along the surface. Higher sees farther and cannot be hidden from by a lower
ship hiding behind the planet.

**Sun angle.** A ship between the sun and its target is hard to see and lights
its target. A ship in the planet's shadow is cold and invisible to a
sun-reliant sensor but cannot charge (mines already stop charging in shadow,
see `docs/mine-design.md`). Orbit height changes how long you spend in shadow.

**Detection and sensor range.** A radar or infrared sensor sees a given range
regardless of altitude, but altitude decides whether the horizon or the sensor
limits you.

**Engagement timing.** The ship that controls the geometry decides when two
orbits meet, because only they can burn to arrive at the same place and time.
The other ship is a passenger on its orbit and mostly reacts.

**Escape and closing speed.** Relative speed at an encounter comes from two
parts: the speed difference of the two orbits and the angle between their
velocities. A higher ship coming down has more speed available as it falls.
A lower ship going up trades speed for height.

## 2. Why this matters in this game specifically

Current rules: KV is the only kill method, missile range is about 22 km,
mines launch a KV at 2.2 km, KV closing speed is capped at 50 m/s by braking,
KV delta-v is 80 m/s, player ships are limited by heat rather than fuel.

Consequences:
- Combat ranges (2 to 22 km) are tiny next to the horizon distances (hundreds
  of km). Line of sight over the horizon almost never decides a fight unless a
  sensor system with long range is added.
- The 50 m/s cap means a KV never hits harder from a bigger altitude drop. Any
  high-ground bonus has to act on something other than closing speed.
- Because ships are limited by heat, not fuel, "delta-v to change orbit" is not
  a scarce resource for the player. It is a time cost (burn duration plus heat)
  instead.
- A KV with 80 m/s delta-v can only chase a target whose relative velocity is
  well below that. Altitude difference sets the relative drift, so it directly
  limits who can escape: a target 20 km higher or lower drifts at about 33 m/s.

## 3. Candidate formulations

Each metric reads only existing orbit state from `elements()`: periapsis,
apoapsis, semi-major axis, energy, true anomaly, plus current radius.

### A. Energy advantage (escape-dive geometry)

Reward the ship with higher specific energy or higher current altitude with a
shot-quality or range bonus (for example +10% missile range or tighter KV
tracking per 10 km of altitude advantage).

- Metric: `dh = r_self - r_target` at the moment of launch, or
  `dE = energy_self - energy_target`.
- Pros: simple, one number, already in `Elements.energy`. Easy to show in the
  HUD. Matches popular intuition so players understand it.
- Cons: only a rule, not physics. It cannot stack with the 50 m/s cap, so the
  bonus would be a fudge on range or accuracy. Rewards parking high, which is
  the cheapest thing for a heat-limited ship to do, so everyone does it.

### B. Escape-denial (relative drift)

The ship that sets the relative speed controls whether a KV can catch its
target. Use the drift rate as the advantage and let KV delta-v decide.

- Metric: `drift = |v_circ(r_self) - v_circ(r_target)|` (about 1.6 m/s per km of
  altitude gap), plus the eccentricity term from periapsis/apoapsis. A KV
  launched into a target whose predicted relative speed exceeds its remaining
  delta-v minus the 50 m/s braking cap cannot close.
- Pros: falls out of the existing sim. No new rule: just displays and exploits
  what already happens. Naturally makes "lower and faster" attractive for
  chasing and "higher and slower" attractive for loitering, which is real. It
  also gives defenders a reason to change orbit after a KV launch.
- Cons: harder to read at a glance. Needs the orbit-difference visualization to
  be understandable. Small effect at close range, so tuning needs playtests.

### C. Apoapsis dwell and engagement timing

Reward the ship that spends more time near an area. Count time above a
reference radius (apoapsis dwell) and give the dwelling ship initiative:
for example an earlier sensor lock or a free first launch.

- Metric: `dwell = fraction of period with r > r_ref`, from the
  `Elements` eccentricity and semi-major axis; or just `apoapsis - periapsis`.
- Pros: teaches a real orbital idea (slow at the top). Rewards planning, which
  the orbit visualization supports.
- Cons: needs a notion of "the contested area" that the game does not have
  today. Easy to misread in a short mission.

### D. Cost to reach (delta-v budget)

Not a combat bonus: assign a delta-v and heat cost to moving up, and let the
advantage be whoever is already in the preferred band.

- Metric: Hohmann delta-v between current radius and target radius.
- Pros: aligns with the "limited by heat, not fuel" design by making orbit
  change cost heat.
- Cons: only matters if there is something worth reaching. Pairs with A or B.

## 4. Recommendation

Use **B (escape-denial by relative drift)** as the core, with **A as a small
visible bonus**.

Why: B needs no invented rule. The sim already makes KV kills depend on
relative speed, so altitude advantage appears naturally as who can shake or
catch a KV. It is also the most truthful to real orbital mechanics. A is added
because players need a clear number on screen; a small, capped bonus per 10 km
of altitude advantage (tunable in data) makes the idea readable without
overruling physics.

Skip C and the horizon effect until the game has sensors with ranges long
enough for the horizon to matter.

Suggested first step if approved: a pure helper that, given two `Elements` and
current radii, returns altitude difference, circular-speed drift and
energy difference, and a HUD line showing them for the targeted enemy. The orbit
visualization (two waves whose peaks and troughs are periapsis and apoapsis)
shows the same numbers visually.

## 5. Questions for the game owner

- Should high ground be a visible bonus (A), an emergent effect (B), or both?
- Should moving between bands cost heat (D)?
- Do you want long-range sensors added so the horizon matters later?

## 6. Decision

Eric chose B with a visible HUD indicator. No horizon or line-of-sight effects
for now, and moving between bands costs only the normal heat penalty.

Implemented: `web/src/ui/highGround.ts` (pure helper) with tuning in
`web/src/ui/highGround.json` (`evenBandM` 2 km, `kvDeltaV` 80 m/s). The target
panel shows `GROUND HIGH/LOW/EVEN`, the altitude difference, the drift rate and
the KV margin (positive: a KV can match the target; negative: the target
outruns it).
