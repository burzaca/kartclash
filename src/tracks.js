// tracks.js — authored track layouts (data only). The schema of every entry is documented in
// docs/INTERFACES.md. Existing entries are load-bearing (players' best laps, CI pacing gates):
// APPEND new tracks, never edit one that shipped.
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
  {
    id: 'bolt-bayou', name: 'BOLT BAYOU', width: 16, widthVar: 0.15,
    laps: 3, seed: 88888888,
    ctrl: [
      { x: -165, z: -130 }, { x: -70, z: -120 }, { x: 35, z: -110 }, { x: 95, z: -90 },
      { x: 140, z: -35 }, { x: 170, z: 25 }, { x: 130, z: 75 }, { x: 50, z: 110 },
      { x: -60, z: 130 }, { x: -140, z: 120 }, { x: -165, z: 40 }, { x: -150, z: -40 },
    ],
    itemNodes: [0.07, 0.38, 0.65],
    boostPads: [{ t: 0.25, w: 0.35 }, { t: 0.5, w: 0.45 }, { t: 0.85, w: 0.5 }],
    ag: [{ t: 0.55, t2: 0.7, amp: 2.6 }],
    elev: { amp: 2.4, waves: 4, phase: 0.8 },
    theme: { grass: 0x2f7a3a, road: 0x53565e, curb: 0x1c86d1, wall: 0xe8e1d5, trees: 0x8b9e4a },
  },
  {
    id: 'crater-crest', name: 'CRATER CREST', width: 13, widthVar: 0.08,
    laps: 3, seed: 12345678,
    ctrl: [
      { x: -165, z: -150 }, { x: -60, z: -140 }, { x: 30, z: -130 }, { x: 90, z: -110 },
      { x: 130, z: -50 }, { x: 175, z: 0 }, { x: 110, z: 45 }, { x: 40, z: 70 },
      { x: -35, z: 88 }, { x: -110, z: 100 }, { x: -150, z: 110 },
    ],
    itemNodes: [0.12, 0.65],
    boostPads: [{ t: 0.2, w: 0.4 }, { t: 0.55, w: 0.45 }],
    ag: [],
    elev: { amp: 2.8, waves: 3, phase: 1.2 },
    theme: { grass: 0x8a7f5a, road: 0x4a4e58, curb: 0xf2a51c, wall: 0xd8cfc0, trees: 0x6f8a3d },
  },
];
