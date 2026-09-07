# Bundled Superpowers-derived resources

- Upstream: https://github.com/obra/superpowers
- Upstream version: v6.2.0
- Upstream copyright: Copyright (c) 2025 Jesse Vincent
- License: MIT; see `LICENSE` in this directory.

This directory contains a curated, Orchestrator-specific derivative of five
upstream workflow skills. Names are prefixed with `android-orchestrator-` to
avoid collisions with independently installed skills.

Intentional changes:

- removed the `using-superpowers` bootstrap dependency;
- removed brainstorming's visual companion, localhost server, browser launch,
  remote branding, and telemetry resources;
- replaced Superpowers plan execution handoffs with the sealed Android
  Orchestrator contract/Coder/Reviewer workflow;
- moved optional supporting documents under `references/` and scripts under
  `scripts/`;
- rewrote cross-skill references to the bundled namespaced skill IDs.
