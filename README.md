# AQUAPIX

A top-down pixel-art water polo game. Original intellectual property — every
club, athlete, venue, competition and item of equipment is invented.

## Running it

```bash
npm install
npm run dev      # dev server on http://localhost:5178
npm run build    # production build into dist/
npm run preview  # serve the production build on http://localhost:4173
npm test         # headless simulation, economy and playability tests
```

## Stack

Vanilla ES modules + [Vite](https://vite.dev). No UI framework and no game
engine: the match is rendered by a purpose-built canvas pixel renderer
(`src/render2d/`), and the menus are plain DOM.

## Layout

```
src/
  core/        match state machine, deterministic RNG, 2D maths
  rules/       versioned rules profiles (World Aquatics 2026, arcade, …)
  gameplay/    athletes, ball, goalkeeper, contact, shots and passes
  ai/          seven-layer team AI and tactical systems
  data/        invented teams, athletes, attributes, display stats
  modes/       career modes, progression economy, simulated results
  render2d/    canvas pixel renderer
  ui/          screens, HUD, input (keyboard, gamepad, touch)
tests/         headless tests - the simulation has no DOM dependency
legacy/        retired Three.js renderer, kept for reference only
```

The simulation layer is deliberately DOM-free, which is what lets the whole game
be tested headlessly — and would later allow a dedicated match server.

## Saves

Progress is stored in the browser's `localStorage` under `aquapix.*`. Every read
and write is wrapped in `try`/`catch`, so private-browsing mode degrades to a
fresh session rather than breaking.

## Deployment

Static build, no backend and no secrets. `vercel.json` pins the Vite preset and
`dist` as the output directory. `vite.config.js` sets `base: './'` so the build
also works from a sub-path.
