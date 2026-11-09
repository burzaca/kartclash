// config.js — every tuning knob, item id, player spec and track layout in one place.
// PURE: no DOM, no THREE. Workers read knobs; nobody invents their own numbers.

export const GAME = {
  title: 'KART CLASH',
  subtitle: 'GOLD CUP — MUSHROOM CIRCUIT',
  // Shown on the title screen and in the corner of the game, so "I still see no menu" can be
  // answered with "what build number do you see?" instead of guesswork about cached files.
  build: '2026-11-09.2',
  fixedStep: 1 / 120,      // physics runs at a fixed 120 Hz step
  maxSteps: 8,             // clamp catch-up steps per frame
  laps: 3,
  countdown: [3, 2, 1, 'GO'],
  respawnStuckTime: 6.0,   // seconds off-track/stuck before a recover
  closeSplitDistance: 46,   // 2P: how far apart karts must be before camera zooms out
};

// ---------------------------------------------------------------- items
export const ITEM = {
  NONE: 0, MUSHROOM: 1, TRIPLE_MUSHROOM: 2, GREEN_SHELL: 3, TRIPLE_GREEN: 4,
  RED_SHELL: 5, TRIPLE_RED: 6, BANANA: 7, TRIPLE_BANANA: 8, CLOUD: 8.5 /* FAKE_ITEM */,
  LIGHTNING: 9, STAR: 10, FAKE_ITEM: 8.5,
};
export const ITEM_NAME = {
  [ITEM.NONE]: '', [ITEM.MUSHROOM]: 'MUSHROOM', [ITEM.TRIPLE_MUSHROOM]: 'x3 MUSHROOM',
  [ITEM.GREEN_SHELL]: 'GREEN SHELL', [ITEM.TRIPLE_GREEN]: 'x3 GREEN SHELL',
  [ITEM.RED_SHELL]: 'RED SHELL', [ITEM.TRIPLE_RED]: 'x3 RED SHELL',
  [ITEM.BANANA]: 'BANANA', [ITEM.TRIPLE_BANANA]: 'x3 BANANA',
  [ITEM.FAKE_ITEM]: 'FAKE ITEM', [ITEM.LIGHTNING]: 'LIGHTNING', [ITEM.STAR]: 'STAR',
};
export const ITEM_TRIPLE = {
  [ITEM.TRIPLE_MUSHROOM]: ITEM.MUSHROOM, [ITEM.TRIPLE_GREEN]: ITEM.GREEN_SHELL,
  [ITEM.TRIPLE_RED]: ITEM.RED_SHELL, [ITEM.TRIPLE_BANANA]: ITEM.BANANA,
};
// Plain-language effects, shown in the title-screen legend so a first-time player knows what a
// pickup does BEFORE they have to guess it mid-race.
export const ITEM_DESC = {
  [ITEM.MUSHROOM]: 'A burst of speed. Tap the use key and go.',
  [ITEM.GREEN_SHELL]: 'Rolls forward in a straight line and knocks out whoever touches it.',
  [ITEM.RED_SHELL]: 'Seeks out the racer just ahead of you and hits them.',
  [ITEM.BANANA]: 'Drops behind you. The next kart that runs over it spins out.',
  [ITEM.FAKE_ITEM]: 'Looks like a box but is a cloud: karts behind you think it is real.',
  [ITEM.LIGHTNING]: 'Every racer ahead of you shrinks and slows down.',
  [ITEM.STAR]: 'Speed, immunity to items, and you knock others just by touching them.',
};
export const ITEM_COUNT = {
  [ITEM.TRIPLE_MUSHROOM]: 3, [ITEM.TRIPLE_GREEN]: 3, [ITEM.TRIPLE_RED]: 3, [ITEM.TRIPLE_BANANA]: 3,
};

// Weighted item table by position (MK-style: back of the pack gets the strong stuff).
// Index 0 = 1st place. w = weight; 0 weight = impossible.
export const ITEM_TABLE = [
  [{ id: ITEM.MUSHROOM, w: 8 }, { id: ITEM.TRIPLE_MUSHROOM, w: 4 }, { id: ITEM.GREEN_SHELL, w: 30 }, { id: ITEM.TRIPLE_GREEN, w: 12 }, { id: ITEM.BANANA, w: 30 }, { id: ITEM.TRIPLE_BANANA, w: 10 }, { id: ITEM.FAKE_ITEM, w: 6 }, { id: ITEM.RED_SHELL, w: 0 }, { id: ITEM.TRIPLE_RED, w: 0 }, { id: ITEM.LIGHTNING, w: 0 }, { id: ITEM.STAR, w: 0 }],
  [{ id: ITEM.MUSHROOM, w: 10 }, { id: ITEM.TRIPLE_MUSHROOM, w: 5 }, { id: ITEM.GREEN_SHELL, w: 22 }, { id: ITEM.TRIPLE_GREEN, w: 18 }, { id: ITEM.BANANA, w: 22 }, { id: ITEM.TRIPLE_BANANA, w: 15 }, { id: ITEM.FAKE_ITEM, w: 5 }, { id: ITEM.RED_SHELL, w: 3 }, { id: ITEM.TRIPLE_RED, w: 2 }, { id: ITEM.LIGHTNING, w: 0 }, { id: ITEM.STAR, w: 0 }],
  [{ id: ITEM.MUSHROOM, w: 12 }, { id: ITEM.TRIPLE_MUSHROOM, w: 7 }, { id: ITEM.GREEN_SHELL, w: 15 }, { id: ITEM.TRIPLE_GREEN, w: 22 }, { id: ITEM.BANANA, w: 15 }, { id: ITEM.TRIPLE_BANANA, w: 18 }, { id: ITEM.FAKE_ITEM, w: 4 }, { id: ITEM.RED_SHELL, w: 8 }, { id: ITEM.TRIPLE_RED, w: 6 }, { id: ITEM.LIGHTNING, w: 2 }, { id: ITEM.STAR, w: 0 }],
  [{ id: ITEM.MUSHROOM, w: 12 }, { id: ITEM.TRIPLE_MUSHROOM, w: 9 }, { id: ITEM.GREEN_SHELL, w: 10 }, { id: ITEM.TRIPLE_GREEN, w: 22 }, { id: ITEM.BANANA, w: 10 }, { id: ITEM.TRIPLE_BANANA, w: 18 }, { id: ITEM.FAKE_ITEM, w: 4 }, { id: ITEM.RED_SHELL, w: 14 }, { id: ITEM.TRIPLE_RED, w: 10 }, { id: ITEM.LIGHTNING, w: 5 }, { id: ITEM.STAR, w: 1 }],
  [{ id: ITEM.MUSHROOM, w: 10 }, { id: ITEM.TRIPLE_MUSHROOM, w: 12 }, { id: ITEM.GREEN_SHELL, w: 6 }, { id: ITEM.TRIPLE_GREEN, w: 18 }, { id: ITEM.BANANA, w: 6 }, { id: ITEM.TRIPLE_BANANA, w: 14 }, { id: ITEM.FAKE_ITEM, w: 3 }, { id: ITEM.RED_SHELL, w: 20 }, { id: ITEM.TRIPLE_RED, w: 16 }, { id: ITEM.LIGHTNING, w: 8 }, { id: ITEM.STAR, w: 3 }],
  [{ id: ITEM.MUSHROOM, w: 8 }, { id: ITEM.TRIPLE_MUSHROOM, w: 14 }, { id: ITEM.GREEN_SHELL, w: 4 }, { id: ITEM.TRIPLE_GREEN, w: 14 }, { id: ITEM.BANANA, w: 4 }, { id: ITEM.TRIPLE_BANANA, w: 12 }, { id: ITEM.FAKE_ITEM, w: 3 }, { id: ITEM.RED_SHELL, w: 24 }, { id: ITEM.TRIPLE_RED, w: 22 }, { id: ITEM.LIGHTNING, w: 12 }, { id: ITEM.STAR, w: 5 }],
  [{ id: ITEM.MUSHROOM, w: 6 }, { id: ITEM.TRIPLE_MUSHROOM, w: 15 }, { id: ITEM.GREEN_SHELL, w: 3 }, { id: ITEM.TRIPLE_GREEN, w: 10 }, { id: ITEM.BANANA, w: 3 }, { id: ITEM.TRIPLE_BANANA, w: 10 }, { id: ITEM.FAKE_ITEM, w: 2 }, { id: ITEM.RED_SHELL, w: 25 }, { id: ITEM.TRIPLE_RED, w: 25 }, { id: ITEM.LIGHTNING, w: 15 }, { id: ITEM.STAR, w: 8 }],
];
export function tableForPlace(place, fieldSize) {
  const i = Math.min(ITEM_TABLE.length - 1, Math.max(0, Math.round((place - 1) / Math.max(1, fieldSize) * (ITEM_TABLE.length - 1))));
  return ITEM_TABLE[i];
}

export const ITEMS = {
  boxRespawn: 3.0,           // s until a taken item box returns
  boxRadius: 1.9,            // pickup radius
  pickGap: 0.8,              // s before the SAME kart may take another box (a 3-box cluster
                             // spaced ~11 m was being machine-gunned: 3 draws in half a second,
                             // each silently replacing the last — "the 2 adjacent ones disappeared")
  boxCount: 5,               // boxes across the road at each node
  itemGap: 0.55,             // s cooldown between uses
  shell: { speed: 42, redSpeedMul: 1.35, life: 7.0, radius: 1.1, bounce: 0.9, wallBounceLife: 1.5 },
  redHomingRadius: 60, redTurnRate: 2.6,
  banana: { life: 26, radius: 1.3, dropBack: 6.0 },
  cloud: { invisTime: 6.0 },
  lightning: { shrinkTime: 4.0, slowFactor: 0.55 },
  star: { time: 9.0, hitRadiusBonus: 0.6 },
  spinOutTime: 2.2,
  hitPush: 5.0,
};

// ---------------------------------------------------------------- kart physics
export const KART = {
  radius: 1.35,               // collision radius (also wall push-in margin)
  accel: 11.5,                // m/s^2 forward thrust
  brake: 20.0,
  reverseMax: 7.0,
  drag: 0.9,                  // passive slow-down when coasting (per second fraction)
  maxSpeed: 30.0,             // m/s at full throttle on road (~108 km/h displayed)
  steerRate: 2.05,            // rad/s at low speed
  steerFalloff: 0.42,         // how much steering authority drops with speed
  grip: 7.5,                  // velocity->heading convergence (higher = more planted)
  driftGrip: 2.4,             // grip while drifting (slide)
  driftTurnBoost: 1.55,       // steer multiplier while drifting
  hopGravity: 26.0,
  driftCharge: [1.0, 2.0, 3.4], // s of drifting to reach mini / super / ultra
  driftBoost: [1.18, 1.30, 1.45], // maxSpeed multipliers per tier
  driftBoostTime: [1.0, 1.7, 2.6],
  boostItemMul: 1.45, boostItemTime: 3.2,
  starMul: 1.35,
  padMul: 1.30, padTime: 2.4,
  offRoadMul: 0.52,           // maxSpeed multiplier off-road
  offRoadGrip: 3.0,
  wallBounce: 0.35,           // outward velocity retained
  wallSpeedLoss: 0.55,        // forward speed retained after a wall hit
  spinSpeedLoss: 0.35,
  airSteer: 0.35,             // steering authority while airborne
  bankMax: 0.30,              // visual body roll (rad) in a turn
  bumperRadius: 1.5,          // kart-kart push radius (matches the built model footprint)
  pushForce: 9.0,
};

// ---------------------------------------------------------------- AI
export const AI = {
  lookahead: 14,              // m ahead the AI steers to
  cornerSlowK: 0.62,          // how hard it slows for curvature (1 = never, 0 = always)
  errorRate: 0.7,             // how fast its aim error wanders
  skillBand: 0.055,           // per-driver speed skill spread (fraction)
  rubber: { leaderBand: 1.00, tailBand: 1.06 }, // speed scale by position (mild catch-up; was 0.90/1.12 — the leader was handicapped and a player still cleared the whole field, 2026-11-09)
  itemUseChance: 0.55, itemUseCooldown: 2.5,
  avoidRadius: 9.0,
};

// ---------------------------------------------------------------- camera / split screen
export const CAM = {
  // Chase rig. Tuned against tools/probe-camera.js, which measures how large the player's kart
  // actually renders: it must stay a clear fraction of its half-pane at full speed, so these
  // numbers are set by measurement, not taste. (An earlier version sat 11 m back and got further
  // back with speed; with the follow lag that put the camera ~19 m away and the kart read at 2%.)
  back: 9.2, up: 3.4, lead: 5.5,
  // Camera distance is a matter of taste, and the player asked for the view "forward a bit" —
  // so it is a control, not a guess. C cycles these in game; each one is measured by
  // tools/probe-camera.js (the kart must stay a readable size, the road ahead in view).
  presets: {
    close: { back: 8.0, up: 3.0, lead: 4.8 },
    normal: { back: 9.2, up: 3.4, lead: 5.5 },
    far: { back: 12.5, up: 4.6, lead: 7.5 },
  },
  presetOrder: ['close', 'normal', 'far'],
  followRate: 17.0,                        // look-target smoothing rate (position is rigid — see cameraRig)
  yawRate: 7.0,                            // how fast the chase heading catches up with the kart's heading
  camKeys: { KeyC: 0, KeyM: 1 },           // per-player camera cycling (P1 = C, P2 = M)
  fov: 64, fovBoost: 68, fovSpeed: 0.08,   // player asked: never fall far at speed; only a mild fov kick
  near: 0.5, far: 900,
  speedPull: 0.3, upPull: 0.3, boostPull: 0.6,   // keep framing near-constant at any speed
  split: 'horizontal',                       // 2P: stacked halves (classic MK on TV)
  shakeDecay: 4.0,
};

export const RENDER = {
  sunAzimuth: -0.9, sunElevation: 0.72, shadowMap: 2048, shadowSpan: 130,
  exposure: 1.05, fogNear: 180, fogFar: 700, fogColor: 0x9fd0f0,
  skyTop: 0x2b6fd6, skyMid: 0x86c4f2, skyBottom: 0xdff1ff, ground: 0x5f9a4a,
};

// ---------------------------------------------------------------- players
export const PLAYERS = [
  { id: 0, name: 'P1', human: true, color: 0xd8232a, trim: 0xf2c14e, skin: 0xf1c27d, helmet: 0x1b1b22, keys: 'wasd' },
  { id: 1, name: 'P2', human: true, color: 0x1c86d1, trim: 0x9be07a, skin: 0xe8b98c, helmet: 0x24304a, keys: 'arrows' },
];
export const AI_DRIVERS = [
  { name: 'BOLTS', color: 0x2fae5a, trim: 0xffffff, skin: 0xd9a06b, helmet: 0x123c1f },
  { name: 'NOVA', color: 0x8e44ad, trim: 0xffd166, skin: 0x8d5524, helmet: 0x2a1035 },
  { name: 'ZIP', color: 0xef7f26, trim: 0x202020, skin: 0xf1c27d, helmet: 0xffffff },
  { name: 'KILO', color: 0x2b2f36, trim: 0x62e0e0, skin: 0xc68642, helmet: 0x9a9a9a },
  { name: 'PIXL', color: 0xe84393, trim: 0x2d3436, skin: 0xffdbac, helmet: 0x55efc4 },
];

// ---------------------------------------------------------------- keyboard map
// e.code values (layout-independent physical keys). actions: up down left right drift use
export const KEYMAP = {
  wasd: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', drift: 'ShiftLeft', use: 'Space' },
  arrows: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', drift: 'Period', use: 'Slash' },
};
export const KEYMAP_LABEL = {
  wasd: { up: 'W', down: 'S', left: 'A', right: 'D', drift: 'LEFT SHIFT', use: 'SPACE' },
  arrows: { up: '↑', down: '↓', left: '←', right: '→', drift: '. (period)', use: '/ (slash)' },
};
export const GLOBAL_KEYS = { start: ['Enter'], restart: ['KeyR'], pause: ['KeyP', 'Escape'], split: ['KeyT'] };

// ---------------------------------------------------------------- tracks
// Control points are authored HERE (the PM owns the layout). Everything derived —
// width profile, elevation, surface, barriers, scenery — is built by the track module.
export const TRACKS = [
  {
    id: 'mushroom-circuit', name: 'MUSHROOM CIRCUIT', width: 15, widthVar: 0.10,
    laps: 3, seed: 20261101,
    ctrl: [
      { x: -150, z: -95 }, { x: -40, z: -105 }, { x: 70, z: -95 }, { x: 140, z: -55 },
      { x: 150, z: 10 }, { x: 105, z: 60 }, { x: 150, z: 105 }, { x: 90, z: 140 },
      { x: -30, z: 120 }, { x: -120, z: 135 }, { x: -160, z: 80 }, { x: -120, z: 20 },
      { x: -165, z: -30 },
    ],
    // features as fractions of the lap (0..1) — deterministic, authored, not random
    itemNodes: [0.055, 0.42, 0.74],
    boostPads: [{ t: 0.185, w: 0.5 }, { t: 0.60, w: 0.42 }, { t: 0.905, w: 0.5 }],
    ag: [{ t: 0.45, t2: 0.58, amp: 2.6 }],     // anti-gravity banked section (lap fractions)
    elev: { amp: 2.2, waves: 3, phase: 0.4 },   // gentle elevation, metres
    theme: { grass: 0x5f9a4a, road: 0x53565e, curb: 0xd8232a, wall: 0xe8e1d5, trees: 0x2f7a3a },
  },
  {
    id: 'shell-coast', name: 'SHELL COAST', width: 14, widthVar: 0.14,
    laps: 3, seed: 777001,
    ctrl: [
      { x: -120, z: -140 }, { x: 30, z: -130 }, { x: 130, z: -110 }, { x: 165, z: -30 },
      { x: 120, z: 40 }, { x: 40, z: 20 }, { x: -20, z: 70 }, { x: 60, z: 130 },
      { x: -40, z: 155 }, { x: -140, z: 110 }, { x: -165, z: 20 }, { x: -140, z: -60 },
    ],
    itemNodes: [0.08, 0.36, 0.90],
    boostPads: [{ t: 0.26, w: 0.5 }, { t: 0.55, w: 0.35 }, { t: 0.84, w: 0.5 }],
    ag: [{ t: 0.62, t2: 0.75, amp: 2.8 }],
    elev: { amp: 3.0, waves: 4, phase: 1.7 },
    theme: { grass: 0x7fae5c, road: 0x6b5a4a, curb: 0x1c86d1, wall: 0xf0e6d2, trees: 0x3d8a5f },
  },
];

// ---------------------------------------------------------------- scoring / hud
export const RACE = {
  aiField: 4,                  // AI opponents (2 humans + 4 AI = 6 racers)
  startGridGap: 5.0,           // metres between grid rows
  startLateral: 3.2,
  countdownGoTime: 0.35,       // perfect-start boost window after GO
  perfectBoost: 1.25, perfectBoostTime: 1.2,
  resultsGapCap: 99,
  minimapSize: 150,
};
