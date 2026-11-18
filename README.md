# 🧩 Puzzlewise

A jigsaw puzzle web app that recreates the experience of laying a physical puzzle on a table.

Pieces merge with each other when matching edges align — no snapping to a fixed grid. Just like a real puzzle.

## Development

The node version is pinned in `.nvmrc` — the same file CI reads. `fnm` picks it
up on `cd`; with `nvm`, run `nvm use` first. The npm bundled with the node major
is what writes `package-lock.json`, so a different major there produces a
lockfile CI might reject.

```bash
npm install
npm run dev
```

## Architecture

See [docs/DESIGN.md](docs/DESIGN.md) for full design documentation.

## License

MIT
