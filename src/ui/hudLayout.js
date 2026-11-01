/* hudLayout.js — where every HUD element goes, in pixels, for a given viewport size. (PM-owned)
 *
 * Pure on purpose. The layout is the thing that made the HUD cramped: element positions were set
 * from percentages of the pane while their sizes came from a rem-based CSS scale, so the two
 * coordinate systems disagreed and chips landed on top of each other (the position badge sitting on
 * the lap counter, the minimap behind the item slot). With the rectangles in one pure function,
 * tests/test_hud_layout.js can prove no element ever overlaps or leaves the pane, at any size.
 *
 * One unit `u` scales everything: a HUD that reads at 1280x720 still reads at 640x360 per half.
 */
import { clamp } from '../foundation.js';

// A pane can be a whole window (1 player) or half of one (split screen).
// The old ceiling of 16 made the HUD unreadably small on a big solo screen; the fixed floor is
// only there so a phone-sized pane still shows something. Boxes are additionally capped by a
// fraction of the pane below, so a HUD never eats the track it is drawn over.
export function hudUnit(w, h) {
  return clamp(Math.min(w, h) / 26, 4, 60);
}

export function hudLayout(w, h) {
  const u = hudUnit(w, h);
  const m = u * 1.1;                    // outer margin

  // top-left: position + lap, one row. Wide enough for "6th" + "3/3", never near the centre.
  const topbar = { x: m, y: m, w: Math.min(u * 10.5, w * 0.28), h: u * 2.8 };

  // top-right: the item you are holding.
  const item = { x: w - m - u * 3.4, y: m, w: u * 3.4, h: u * 3.4 };

  // bottom-right: speed ring with the number inside it.
  const speed = { x: w - m - u * 4.0, y: h - m - u * 4.0, w: u * 4.0, h: u * 4.0 };

  // bottom-left: minimap. A 0.40 × pane-height map in a short split half covers half the view —
  // that was most of the "too cramped" complaint, so it is sized off `u` and capped hard.
  const mmW = Math.min(w * 0.16, u * 9);
  const mmH = Math.min(h * 0.28, mmW * 0.8);
  const minimap = { x: m, y: h - m - mmH, w: mmW, h: mmH };

  // left column under the top bar: this driver's times and gap. Three lines is all it needs.
  const standings = { x: m, y: m + topbar.h + u * 0.8, w: Math.min(u * 12.5, w * 0.28), h: u * 5.4 };

  // debug readout — hidden unless the page asks for it (?debug=1)
  const status = { x: m, y: h - m - u * 1.3, w: Math.max(0, w - m * 2), h: u * 1.1 };

  return { u, m, topbar, item, speed, minimap, standings, status };
}

// Rectangles the tests check: everything that could collide.
export function hudBoxes(layout) {
  return ['topbar', 'item', 'speed', 'minimap', 'standings'].map((k) => ({ name: k, ...layout[k] }));
}

export function overlaps(a, b, pad = 0) {
  return a.x < b.x + b.w - pad && b.x < a.x + a.w - pad &&
         a.y < b.y + b.h - pad && b.y < a.y + a.h - pad;
}

export function inside(r, w, h) {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= w + 0.01 && r.y + r.h <= h + 0.01;
}
