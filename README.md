## Timey

## To build and run locally:

```sh
npm ci
npm run dev
```

Use npm and `package-lock.json`; `.nvmrc` pins the local Node runtime.
Run `npm run hooks:install` once per checkout to enable the staged Fallow audit.
Run `npm run verify` for isolated checks and evidence under `.issues/evidence/`.
Existing typecheck failures remain visible; see [verification](docs/agents/verification.md).

Invoke `$factory` in Codex to evaluate the local queue and recommend actions.
Launches are separate: `$factory launch ACTION_ID`. Evaluating the queue never
launches workers or starts another iteration. See [operating rules](docs/agents/operating.md).
Use `$factory integrate ACTION_ID` to explicitly finalize a completed worker's
code under its saved merge policy; this is separate from queue evaluation.

The [authentication foundation setup](AUTH_SETUP.md) documents separate auth/domain
ownership, migrations and the disposable PostgreSQL/HTTP proof. Existing application
callers still use Keycloak pending the coordinated auth/admin cutover.

## Issues

The repo currently tracks issues localling using skills from the local-issues-skills project.

## Data structures

Beat - contains notes and timing
MidiService

- Outputs midi pulses and midi notes
  BeatRecorder - creates a performance and performanceFeedback
- beat
- tempoService_midiPulse
- midiService_midiNote
