# OpenCode Android Orchestrator

Reusable OpenCode orchestration for macOS Android projects.

## Status

This repository currently contains only the TypeScript/npm scaffold. The
installer lifecycle and the verified Android orchestration V3 templates have
not been migrated yet. The package metadata is configured for public
publication under the `@frankzhang2026` npm scope.

## Planned usage

```sh
npx @frankzhang2026/opencode-android-orchestrator@0.1.0 init .
opencode --agent scheduled-planner .
```

## Development

```sh
npm run typecheck
npm test
npm run pack:check
```
