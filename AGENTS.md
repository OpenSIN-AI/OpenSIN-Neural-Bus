# AGENTS.md

This repository is part of the OpenSIN-AI ecosystem.

## Development Guidelines
- Use `opencode` CLI for all LLM interactions
- Follow the Global Brain PCPM integration
- All changes must be committed via pull requests
- Run tests before pushing

## Quick Start
```bash
git clone https://github.com/OpenSIN-AI/$(basename "$PWD")
cd $(basename "$PWD")
bun install
bun start
```

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Boundary Guidance for Agents

When modifying this repo:

- Prefer event bus, durable delivery, and envelope contract work.
- Keep claims scoped to the bus layer.
- Do not redefine control-plane, memory, docs, or runtime canon from here.
