# Domain Docs

This repository uses a single-context domain-documentation layout.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- Relevant ADRs under `docs/adr/`.

If these files do not exist, proceed silently. Domain-modeling skills create them lazily when terminology or decisions are resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/adr/
└── app/
    ├── server/
    └── web/
```

## Use the glossary vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts in issues, proposals, tests, and code. Avoid synonyms that the glossary explicitly rejects.

If a needed concept is absent, reconsider whether it belongs or note the gap for domain modeling.

## Flag ADR conflicts

Explicitly surface output that conflicts with an existing ADR instead of silently overriding it.
