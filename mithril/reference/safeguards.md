# Conditional runtime safeguards

Read matching sections only. Use existing scans/reviews; report unavailable checks, never imply coverage.

## Shared state, remote calls, and caches

Prefer immutable/local state; separate independent mutable ownership before synchronizing. Necessary sharing needs enforced ownership, one writer, or appropriate atomic coordination. Bound remote waits, support cancellation/safe retries. Avoid N+1/repeated scans; batch where supported. Measure before optimizing; bound caches/define invalidation.

Worktrees isolate files, not databases, ports, fixtures, or external writes. Identify resource ownership; isolate or sequence conflicting tests/agents and assign one authorized owner for each external mutation.

For retryable operations, define final state; verify repeated success AND retry after partial failure/crash. Prevent duplicate side effects; preserve recovery progress. Repetition alone isn't crash-safe idempotency.

## Persistence

Transactions cover business operations. Protect read-modify-write; always release resources. No network/user waits inside transactions. Bound/index queries; authorize scope before fetching, not afterward.

## Delivery

Preserve old/new API/schema/config compatibility. Use expand-contract, safe defaults or explicit startup failure, verified rollback.

## Operational paths

Make changed failures detectable/diagnosable: safe structured logs, cross-boundary correlation, relevant latency/error/queue signals. Include security events without sensitive payloads.
