# Store implementation sketch

Approved implementation starting at 1d1c08b. Architecture grounding and candidates live in the parent evidence directory.

## Usage and shape

A project owns a ProjectStores instance. Display readers use its validated local snapshot; every mutation and execution admission awaits authoritative reads and commits. Existing Markdown report paths and flow JSON become projections for remote providers. Local files remain a real provider. Canonical writes cannot be inferred from a background filesystem mirror.

Private roles use three behavioral contracts.

```js
// Coordination, shared by all record providers.
await records.get(key); // null or {key, revision, value}
await records.list(prefix); // [{key, revision, value}]
await records.commit({ operationId, expected: [{ key, revision: null }], writes: [{ key, value }] }); // {operationId, records}; repeat ID same input is stable.
// Every changed/checked key is version-bound. null revision means absent.
// All writes plus durable input-bound operation receipt commit atomically.

await issues.read(issueId); // null or {id, revision, report, location}
await issues.list({ location });
await issues.commit({ issueId, expectedRevision, operationId, report, location });
await issues.history(issueId);

await artifacts.put({ body, mediaType }); // ArtifactRef: {storeId,key,sha256,bytes,mediaType}
await artifacts.get(ref); // verified Buffer; stream/open can be added within this contract.
await artifacts.inspect(ref); // verified metadata or null
await artifacts.remove(ref); // explicit deletion only
```

Provider constructors take {id,root,projectId,...ordinaryConfig}, resolved connection options, and the shared Artifact store where bounded records need external payloads. No provider exposes secrets in errors. Opaque revisions cross domain interfaces. An operation ID reused with different content rejects. File/Git, Postgres, DynamoDB record/issue providers use the same tests. Artifact providers support files/Git, Postgres, S3. Large JSON records and logs are immutable artifact payloads with small authoritative heads, never one oversized Dynamo item.

ProjectStores owns the project catalog and display-number counter, per-issue home epochs, nonexpiring exact-owner claims, graph/attempt records, stop command receipts, and checked migrations. Issue lifecycle state stays with reports; full flow history stays with coordination; bytes stay with artifacts. Stale snapshots cannot authorize mutation. Remote writes become confirmed or pending, never false success. Immutable proof manifests map original path+digest to verified bytes without modifying hashed summaries.

## Synthesis decision

Candidate B is the base: validated synchronous display snapshots plus an asynchronous authoritative coordinator. Candidate A contributes mandatory awaitable provider writes and ownership-before-attempt admission. Full async migration of every pure read loses because it spreads transport concerns across more than130 queue read sites; migrate writer call chains instead. Both agree on bounded coordination records, complete journals before display truncation, exact-owner nonexpiring claims, and sealed migration cutovers.

Cross-family arena judge skipped because no model from another family is available in this environment. Parent read both complete candidate designs and compared authority correctness, caller locality, real provider coverage, history portability and recovery. Cached view freshness is accepted only for reads; every writer enters the authoritative module. No product checkpoint is required after the latest explicit user authorization.

## Provider schema proposal

Use one dedicated Postgres database and factory schema with versioned issue, coordination, operation and artifact tables. Dynamo uses configured string PK/SK tables with project/role-scoped record keys, conditional transactions and permanent operation receipts. No ownership TTL. Git uses dedicated metadata paths and isolated index/private refs. Source HEAD, index and files remain outside metadata updates.

## Delivery checklist

- [x] Ground current reads, execution, claims, logs, evidence and lineage.
- [x] Compare structurally distinct read models and select concrete interfaces.
- [x] Implement provider contracts and real fixture provisioning.
- [x] Wire canonical mutations, validated snapshots, defaults, capture and destination UI.
- [x] Wire ownership, journals, progress, stop, archive, migrations and source checkpoints.
- [x] Run shared provider, composition, browser and issue193 migration checks.
- [x] Pass the strict step audit with zero new or worsened findings.

User-authorized test issue193 is already merged. Test checked data migration and immutable readback. Preserve its report, attempts, merge receipt and evidence; do not rerun delivery or accept/close it.

## Verification observations

The isolated live issue193 migration passed thirteen checks across files, Git,
Postgres, DynamoDB and S3. Every current direct evidence reference transferred;
651 available files and557 historical missing references were retained with their
provenance. Production report/flow bytes, merge revision, source HEAD and indexes
were unchanged, and temporary cloud/database namespaces were removed. A separate
browser smoke rendered the exact merged issue and opened a verified proof file.

Concurrency review found and fixed lost-response replay, newer staged-flow
retention, ownership gaps in manual Git actions, retired uncertain attempts,
transient connection resets, rejected writes blocking migrations, and migration
resume on another runner. Classic worker, strategy, lifecycle and work-chat
execution now use the same ownership and full-log protocol. Peer continuation
uses verified committed source and an immutable history file; native processes
and transport bindings remain runner-local. Dirty source is explicitly local-only.

The aggregate Factory suite passes 1,256 tests with four opt-in live tests skipped.
The remote contracts pass separately against Postgres, DynamoDB, and S3. After
the final source-checkpoint extraction and stable strategy-hash fix, the executor
suite passes 88 tests and the strategy suite passes 67 tests. The real issue193
migration passes all thirteen checks again with cleanup verified.

The strict new-findings audit passes without policy changes or suppressions.
The user confirmed this machine is the only Factory runner and
authorized the permanent `timey-factory-issues` DynamoDB table in `eu-central-1`.
That table is active with on-demand capacity and string `PK`/`SK` keys. Existing
files/Git defaults stay selected when the named remote stores are configured.

Live activation exposed an HTTPS failure when publishing a valid source bundle.
The exact retained commit succeeds with a buffered request. The Git provider
retries that HTTP400 failure with the same commit, authentication, and branch
lease; it changes no repository or global Git settings. Real HTTP regressions
cover rejected chunked uploads and a lost acknowledgement with a newer peer tip.
Coordination migration also excludes Issue records and raw Artifact bodies when
all three roles share one physical Git namespace.
Local server pause, restart, and restart cancellation remain independent of store
bootstrap and availability. Shared issue actions retain authoritative admission.
