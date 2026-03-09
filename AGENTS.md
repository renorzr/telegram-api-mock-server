# AGENTS Guide

## Purpose
- This file guides coding agents working in this repository.
- Follow these instructions before making edits, running commands, or proposing architecture changes.

## Repository Snapshot (Current)
- This repository now contains a TypeScript plugin scaffold for OpenClaw.
- Main files:
  - `index.ts` plugin entrypoint
  - `src/` plugin/runtime/mock HTTP implementation
  - `tests/` unit tests
  - `telegram-mock-channel-design.md` product/design source
- Package manager metadata exists (`package.json`, `tsconfig.json`).

## Rules Files Check
- `.cursor/rules/`: not found.
- `.cursorrules`: not found.
- `.github/copilot-instructions.md`: not found.
- If any of these files appear later, read and obey them before changing code.

## Working Principles For Agents
- Prefer minimal, reviewable diffs.
- Preserve existing behavior unless the task explicitly requests behavior changes.
- Do not invent infrastructure that is not justified by the design doc.
- Keep interface names and API paths aligned with `telegram-mock-channel-design.md`.
- Explicitly call out assumptions when implementation details are missing.

## Source Of Truth
- Primary spec: `telegram-mock-channel-design.md`.
- If code and doc diverge, prefer code for runtime truth and flag the divergence.
- Do not silently "fix" spec/code mismatch; document what changed and why.

## Build, Lint, Test Commands

### JavaScript / TypeScript (Current)
- Install deps: `npm install`.
- Build: `npm run build`.
- Typecheck: `npm run typecheck`.
- Test all (compiled tests): `npm test`.
- Test all (source tests): `npm run test:src`.
- Single test file: `node --test dist/tests/state-store.test.js`.
- Single test name: `node --test --test-name-pattern "seq is isolated by account" dist/tests/state-store.test.js`.

### Notes
- A dedicated lint script is not configured yet.
- Prefer `npm run typecheck` as the baseline static validation step.

## Validation Policy
- Run lint + tests for changed scope whenever possible.
- For non-trivial changes, run full test suite before finishing.
- If no tests exist, add focused tests alongside the change when feasible.
- If execution is impossible (missing toolchain/deps), state exactly what could not run.

## Implementation Guidance From Design Doc
- Keep account state isolated by `account`.
- Preserve per-account monotonic `seq` behavior.
- Outbound delivery semantics are `at-least-once`.
- Support inbound `message` and `callback_query` for MVP.
- Support outbound `sendMessage`, `editMessageText`, `answerCallbackQuery` for MVP.
- Keep HTTP response envelope shape consistent:
  - success: `{ "ok": true, ... }`
  - error: `{ "ok": false, "error": { "code", "message" } }`

## Code Style Guidelines

### Formatting
- Use project formatter defaults once configured.
- Keep lines readable; prefer clarity over dense expressions.
- Avoid unrelated formatting-only changes in functional PRs.

### Imports
- Use absolute or configured alias imports consistently.
- Group imports in this order: standard library, third-party, internal.
- Remove unused imports.
- Avoid deep relative traversal when a stable alias exists.

### Types And Interfaces
- Prefer explicit public types for API boundaries.
- Avoid `any`/untyped values unless unavoidable; narrow unknown inputs.
- Model wire payloads with dedicated request/response types.
- Represent outbound event variants with discriminated unions where possible.

### Naming Conventions
- Use descriptive names reflecting Telegram/mock domain terminology.
- Keep external API fields compatible with spec naming (`chat_id`, `message_id`).
- Use `camelCase` for internal variables/functions unless language conventions differ.
- Use `PascalCase` for types/classes and `UPPER_SNAKE_CASE` for constants.

### Error Handling
- Return structured errors with stable codes.
- Validate input at boundaries; fail early with actionable messages.
- Do not swallow errors; wrap with context for observability.
- Separate user-facing error messages from internal debug details.

### Concurrency And State
- Guard per-account state mutations in concurrent contexts.
- Preserve event ordering guarantees within a single account.
- Keep reset/drain operations deterministic and race-safe.

### API And Compatibility
- Do not change endpoint paths or payload contracts without explicit request.
- Additive changes are preferred over breaking changes.
- If a breaking change is required, document migration impact clearly.

### Testing Expectations
- Add unit tests for seq generation, account isolation, and error mapping.
- Add integration tests for inbound -> handler -> outbound flow.
- Include at least one single-test invocation in PR notes when relevant.

### Logging And Observability
- Log key lifecycle events at info level; avoid noisy per-field dumps.
- Never log secrets (tokens, API keys, auth headers).
- Include account and seq identifiers in debug context where helpful.

## Change Management
- Keep commits scoped to one logical change.
- Update docs when behavior, config, or API changes.
- When introducing new commands, document them in this file.

## If The Repo Grows
- Revisit this file after adding real build/test infrastructure.
- Replace inferred command sections with exact project commands.
- Add framework-specific conventions (for example Jest vs Vitest specifics).

## Agent Handoff Checklist
- Read this file and `telegram-mock-channel-design.md` first.
- Detect toolchain and run the matching command set.
- Run at least one focused single-test command when tests exist.
- Report what was validated and what was not run.
- Keep implementation aligned with MVP scope unless asked otherwise.
