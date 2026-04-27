# RubikSolver

A browser-based 3×3 Rubik's Cube solver. Upload a flat-net image of a scrambled cube and get a step-by-step solution.

**Live demo:** https://jeffhuber.github.io/rubiks-solver/

100% client-side: no server, no upload — image processing and solving both run in your browser.

## What it does

1. **Get a cube state in** — three ways: click **Upload net image**, drop a net image anywhere on the page, or paste one with ⌘V. **Random scramble** generates a programmatic state for testing. **Share** copies a URL that reproduces the exact current state.
2. The CV pipeline crops the cross, samples each sticker, and snaps every color via per-image calibration: it finds the globally optimal 6-way assignment of the center stickers to the WCA palette, then classifies every other sticker against those calibrated centers (handles palette drift like Ruwix's yellow-shifted orange).
3. The detected state appears in an editable cube net — click any sticker to fix a wrong color before solving. Any of the 24 rotational orientations is accepted; the centers themselves define which face is which.
4. Click **Solve** for an instant Kociemba solution (typically 20–22 moves; cubes 1–4 moves from solved get the optimal short answer), or **Solve (tightest)** to spend up to ~9 seconds searching for a shorter one (typically 20 moves — God's Number). A lifetime counter tracks how many moves you've saved across all tight solves.
5. Step through the solution one move at a time, or hit **▶ Play** for auto-advance with slow/normal/fast speeds. The 2D net updates the highlighted face and the 3D cube animates the matching face rotation. Drag the 3D cube to orbit it.

## How it works

- **Solver:** [`cubejs`](https://www.npmjs.com/package/cubejs) — a JS port of Kociemba's two-phase algorithm. Returns the first solution it finds (typically 20-22 moves) in milliseconds after a one-time ~3-second pruning-table init. Before the default solve, the wrapper probes `cube.solve(k)` for k=1..4 to catch cubes that are 1–4 moves from solved (cubejs's default `solve()` would otherwise return a 9–12 move sandwich for those). The optional **Solve (tightest)** button iteratively re-runs cubejs with progressively tighter `maxDepth` bounds (down to 20, God's Number) for up to ~9s, recovering whatever shortest solution is found before the budget runs out.
- **Worker isolation:** the solver runs in a dedicated Web Worker ([src/solver.worker.ts](src/solver.worker.ts)) with a Promise-based main-thread proxy ([src/solver.ts](src/solver.ts)). cubejs's `solve()` calls can take seconds-to-minutes on tight depths and can't be preempted, so the worker is hard-`terminate()`-ed if it blows past the deadline; the latest progress result is recovered via the onProgress channel. Re-init costs ~3s once, hidden by the next idle window.
- **Cube model** ([src/cube.ts](src/cube.ts)): the cube state is a 54-character facelet string in `URFDLB` face order. The `PLACEMENTS` table maps each sticker index to its `(row, col)` on the unfolded cross — used by both the renderer and the parser, so the two are guaranteed to agree. The parallel `PLACEMENTS_3D` ([src/cubies.ts](src/cubies.ts)) maps each sticker to its cubie position and outward face direction in 3D world coordinates.
- **2D Renderer** ([src/CubeNet.tsx](src/CubeNet.tsx), [src/render.ts](src/render.ts)): SVG component for the UI, plus a pure RGBA-buffer renderer used as a deterministic test fixture for the parser.
- **3D Renderer** ([src/Cube3D.tsx](src/Cube3D.tsx)): react-three-fiber scene with 26 cubie meshes (skipping the unseen core). When the displayed state changes, the component diffs old vs. new across all 18 possible single moves; if it finds a match, it animates the matching face's 9 cubies as a rotating group; otherwise it snaps (used for paste / scramble / reset).
- **Parser** ([src/parser.ts](src/parser.ts)): finds the cross's bounding box by detecting non-background pixels at the image corners, samples a small patch at each sticker's geometric center, converts to CIE Lab, and assigns each sticker to its nearest reference color. By default the reference palette is calibrated from the six center stickers in the same image, which makes the parser robust to palette differences (e.g. a Ruwix screenshot vs. our own renderer).
- **Validation** ([src/cube.ts](src/cube.ts), [src/solver-core.ts](src/solver-core.ts)): basic checks at edit time (9 stickers per color, 6 distinct centers) plus an unreachable-state check at solve time. The solver canonicalizes the input via letter substitution and runs a `Cube.fromString(...).asString()` round-trip — cubejs silently rewrites parity-violating cubies (a single flipped edge, twisted corner, permuted centers, etc.), so any drift between input and round-trip means the cube isn't reachable from a real solved state. We throw `UnsolvableCubeError` and show a friendly message instead of returning a partial-solve animation. Already-solved inputs short-circuit to zero moves before invoking cubejs.

The parser round-trips 50 random scrambles at 100% sticker accuracy against the in-app renderer; see [src/parser.test.ts](src/parser.test.ts).

## Run locally

```sh
npm install
npm run dev      # http://localhost:5173/rubiks-solver/
npm test         # vitest, ~7s
npm run build    # production bundle
```

## Project structure

```
src/
├── App.tsx            # top-level UI, state, upload + solve flow
├── CubeNet.tsx        # SVG renderer for the unfolded cross
├── Cube3D.tsx         # react-three-fiber 3D cube + animated face turns
├── cube.ts            # state types, layout, validation, canonicalization
├── cubies.ts          # 3D placement table (sticker -> cubie + face direction)
├── render.ts          # RGBA-buffer renderer (test fixture)
├── parser.ts          # image -> cube state
├── solver.ts          # main-thread Promise proxy + sync utility re-exports
├── solver-core.ts     # synchronous cubejs wrapper (fast + tight, used by tests + worker)
├── solver.worker.ts   # Web Worker that runs the solver off the main thread
├── moves.ts           # move parsing + face-highlight helpers
├── share.ts           # URL hash encoding
├── imageLoader.ts     # File -> ImageBuffer via canvas
└── *.test.ts(x)       # vitest specs
patches/
└── cubejs+1.3.2.patch # one-line fix so cubejs works under Vite ESM
```

## Known limitations

- **The parser is tuned for synthetic flat-net images** (in-app renderer or similar tools like [Ruwix Cube Solver](https://ruwix.com/online-puzzle-simulators/)). Real-cube photos would need perspective correction, lighting normalization, and a 6-face capture flow — see roadmap below.
- **Tightest mode is best-effort, not formally guaranteed.** It iteratively re-runs cubejs with tighter `maxDepth` bounds within a ~9-second hard deadline. Most cubes reach a 20-move solution; some don't fit the budget and fall back to whatever progress was made (often 21 moves). True God's-Number guarantee would require min2phase or Korf's optimal solver — see roadmap.
- **Bundle is ~312 KB gzipped main + 20 KB worker chunk** (~332 KB combined), dominated by three.js + react-three-fiber. Could be code-split so the 3D pane loads on demand, but for a cube-solver app the 3D view is most of the point.

## Roadmap

- [x] 3D cube preview with animated solution playback (Three.js)
- [x] **Tighter solutions, Tier 1** (v0.4) — `Solve (tightest)` button. Iterates Kociemba with `maxDepth = baseline−1, baseline−2, …, 20` until either the budget runs out or no shorter solution exists at that depth. Web Worker keeps the UI responsive; hard 9s timeout prevents pathological cubes from hanging.
- [ ] **Tighter solutions, Tier 2** — Swap `cubejs` for a [min2phase](https://github.com/cs0x7f/min2phase) port (Chen Shuang). Heavier pruning tables and symmetry reduction; almost always 20 moves in milliseconds. ~80 KB gzipped bundle delta.
- [ ] **Tighter solutions, Tier 3** — Korf-style optimal IDA* (max of three pruning tables: corners + two halves of edges). Formally guaranteed ≤20 moves. Pattern databases are tens of MB — likely a server-side path rather than a fully-client solver.
- [ ] Real-camera capture flow (six face captures, center-anchored color calibration)
- [ ] iOS native version (Swift / SwiftUI / VisionKit)

## Releases

- **v0.4.4** — Touch and accessibility polish. Toolbar buttons and move chips now have explicit text colors so they remain readable on Safari/iPadOS in system dark mode (was rendering white-on-light-grey). Touch targets bumped to ≥44 px tall (WCAG). Added a visible orange `:focus-visible` ring for keyboard users. `aria-live="polite"` on the solver status pill, tightening progress, and result banners; `role="alert"` on error banners — screen readers now announce solver state changes and outcomes.
- **v0.4.3** — Solving an "obviously easy" cube (1–4 moves from solved) now returns the optimal short solution. Previously cubejs's default `solve()` produced 9–12 move algorithms for these — its phase1+phase2 iterative deepening doesn't reliably surface short solutions even when one exists. Fix probes `cube.solve(k)` for k=1..4 before falling through to the default; total overhead on a fully scrambled cube is <1 ms.
- **v0.4.2** — Fixes a race condition where changing the cube state (Reset, Random scramble, sticker edit, paste, drop) while a tight solve was running could surface stale moves computed for the *old* state, applied to the new one — produced visually correct-looking but actually-scrambling "solutions". State changes during a solve now terminate the worker and a stale-result check on the main thread guards the rare case where a result arrives anyway.
- **v0.4.1** — Solving an already-solved cube now returns 0 moves with an "Already solved" banner. Previously cubejs's iterative-deepening pruning would emit a 14-move "neutral" sequence (e.g. `R L U2 R L F2 R2 U2 R2 F2 R2 U2 F2 L2`) instead of the empty solution.
- **v0.4.0** — `Solve (tightest)` button: iterative-deepening Kociemba aiming at God's Number (20 moves) within a ~9-second hard deadline. Solver moved into a Web Worker so the UI stays responsive while it churns. Lifetime "moves saved" counter tracked in localStorage.
- **v0.3.0** — Interactive 3D cube alongside the 2D net, with mouse orbit controls and animated face rotations during step-through. Detect unreachable cube states (parity violations, permuted centers) and surface a clear error instead of returning a partial solve.
- **v0.2.0** — Paste / drag-and-drop image upload, share-via-URL hash, auto-play step-through with speed control, accept any rotational orientation, smart calibration via globally optimal 6-way assignment.
- **v0.1.0** — Initial MVP: Vite + React + TS, Kociemba solver, flat-net image parser, editable cube net, step-through solution viewer.

## Tech stack

Vite · React 19 · TypeScript · Vitest · cubejs (Kociemba) · three.js + react-three-fiber + drei · GitHub Pages

## License

MIT — see [LICENSE](LICENSE).
