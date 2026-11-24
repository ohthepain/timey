# Issue 203 approval latency

The current PostgreSQL coordination path completes live Git-backed approval in a
median of 5.943 seconds over five runs, with a range of 5.832 to 6.325 seconds.
Every response succeeded, a fresh authoritative read confirmed `backlog`, and each
disposable measurement issue was closed as No Longer Relevant. No work was launched.
The earlier 36.438-second observation used Git coordination, so these results do
not establish a paired speedup. Issue acceptance remains a separate human action.

## Measurement and remaining cost

The first live sample returned HTTP 200 in 7.574 seconds. Its retained Factory
activity attributed 4.614 seconds to the Git report write. PostgreSQL record
writes took milliseconds. A selected authoritative issue read took 0.638 seconds.
Five later unprofiled approvals measured only the awaited approval HTTP request;
creation, authoritative confirmation and cleanup were outside that interval.
The [raw runs](issue-203-approval/live.json) record zero errors, completed writes,
CPU availability and load. The live runtime was the existing lifecycle repair at
`692a5260`, with PostgreSQL coordination, Git Issue storage and S3 artifacts.
Concurrent issue 202 CI was remote. Local load was about three on ten available cores.

This repair delivers the relevant existing performance work from that runtime.
It retains exact-head Git publication, transactional read-set checks, bounded
native PostgreSQL payloads, operation-scoped immutable payload reuse and selected
snapshot fragments. It also retains the delayed-refresh corrections that prevent
an old snapshot from replacing a newly confirmed flow or ownership state.
No coordination migration or settings change is performed by this source change.

The paired [local cache comparison](issue-203-approval/snapshot.json) used the
actual 141 MB project display cache. Five alternating runs preserved every
unrelated issue and checked the selected update. The target's aggregate cache
installation had a median of 1414 ms, range 1165 to 2130 ms. The fragment candidate
had a median of 2.78 ms, range 2.49 to 930 ms. The slow first candidate run includes
one-time legacy conversion. Subsequent selected writes persist a 6352-byte index
and the selected issue fragment. These are local cache measurements, separate
from live approval latency. The remaining live limiter is remote Git publication.

## Reproduce and verify

The live harness deliberately creates and closes disposable issues. Run it only
against the local Factory installation whose issue store is intended for the test:

```sh
node scripts/approval-latency-benchmark.mjs --live --url http://127.0.0.1:4317 --runs 5 --profile files --output /tmp/approval.json
```

The harness retains each created identity before approval. An error preserves
that identity for manual reconciliation rather than retrying an uncertain write.
Closure records No Longer Relevant and does not assert implementation acceptance.

The cache benchmark never changes shared records:

```sh
node scripts/snapshot-refresh-benchmark.mjs --base fa06a7bf7fba7329917ab8fcba570a0d92f9f8f9 --project /path/to/project --issue ISSUE_ID --output /tmp/snapshot.json
```

Before implementation, the affected baseline passed 49 checks after rerunning the
HTTP fixture with local-port access. The final reused implementation passed 113
checks across approval admission, Git publication, record payloads, runtime,
atomic flow writes, fragment integrity and delayed refresh races. Strict step and
staged audits passed against the fetched target, with measured V8 coverage and
warnings enforced. The PR runs these cases before required broad verification.
The original dirty workspace and lifecycle-repair checkout were preserved.
