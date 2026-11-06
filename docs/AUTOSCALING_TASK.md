# Story: Tune autoscaling to handle production site traffic

**Type:** Story
**Priority:** High
**Tags:** infra, cloud-run, cloud-sql, autoscaling, performance, gcp

## November 6, 2026 production capacity review

The November 4 incident produced 53 frontend memory-termination errors. Production request logs peaked at 526 frontend requests in one second. The seven-day backend peak was 8,769 requests in one minute. This supersedes the earlier assumed database ceiling below.

**Frontend.** Regional k6 tests exercised the production image on zero-traffic pre-production tags. Each run ramped from 50 to 530 requests/s in ten seconds, held 530 for a minute, then returned to ten. It fetched HTML, JavaScript, CSS, runtime configuration, the poster, icon, logo, and a 64 KiB video range. The target was zero failed requests, zero unsent iterations, and p95 below two seconds.

| Memory / concurrency | Completed iterations | HTTP errors | Unsent | Overall p95 |
| --- | ---: | ---: | ---: | ---: |
| 256 MiB / 100 | 40,399 | 0 | 0 | 57 ms |
| 512 MiB / 100 | 40,399 | 0 | 0 | 1,020 ms |
| 512 MiB / 40 | 40,399 | 0 | 0 | 35 ms |

Select 512 MiB / 40, retaining one CPU, a zero warm floor, and ten instances per production revision. The extra memory addresses the observed termination, and lower concurrency limits how many asset responses share one instance. The control also passed the synthetic workload. An initial 512 MiB / 40 run had zero HTTP failures but missed 214 scheduled starts before the generator had enough workers. The repeat used preallocated workers against the same revision. Warmth differed between runs, so the percentile differences are descriptive. The replay does not establish the cause of the original memory growth.

[Control](https://console.cloud.google.com/cloud-build/builds;region=us-central1/8f6d4e31-d718-46f6-8eba-0117b2f1a17f?project=glass-marker-487618-i6) · [Memory only](https://console.cloud.google.com/cloud-build/builds;region=us-central1/02315b44-5678-4467-a99f-0ef11c3636ec?project=glass-marker-487618-i6) · [Selected configuration](https://console.cloud.google.com/cloud-build/builds;region=us-central1/94cf7ae1-aa17-46ff-be6d-46b975c63ace?project=glass-marker-487618-i6)

**Database.** PostgreSQL reported 400 total connections, three superuser reservations and zero ordinary reservations. The production app database peaked at 27 clients and the instance peaked at 28% CPU in the previous week. API PR 363 enforces the configured five connections per application instance and caps the migration job at two. At ten instances, one revision budgets 50 connections. Two overlapping revisions budget 100. Allowing two for one migration plus ten each for one cleanup and one trial-follow-up execution leaves 275 of 397 ordinary slots. Recalculate for additional consumers or concurrent job executions. A read replica, external pooler and larger SQL tier are unnecessary at the measured load.

**Network and cache.** The shared connector is configured for 200–1,000 Mbps. Its highest five-minute outbound and inbound rates were 21.6 and 21.2 Mbps respectively. The production Valkey node reached 15 connected clients, 1.16% memory utilization and zero rejected connections during the same week. Retain the existing sizes.

**Production pool guardrail.** The earlier five-connection example above describes the initial pre-production cap. The production guardrail explicitly selects ten, matching the previous application's actual pg default and the passing four-warm test. A single revision budgets 100. A service-wide ceiling of 20 instances budgets 200 across revisions. Allow 22 for the three scheduled/migration job executions described above. That leaves 175 ordinary PostgreSQL slots. The runtime's 15 s acquire timeout and 10 s idle timeout also apply. A sustained 60-client incident threshold serves as advance notice above the historical peak of 27.

**Backend experiments.** The November 4 spike predominantly fetched the public actor roster and actor avatars. The regional replay uses 45% roster reads, 50% avatar reads and 5% plan reads. It ramps to 150 requests/s over ten seconds and holds that rate for one minute. All candidates use the staging database and a maximum of ten instances. Keep the backend's 300-second service timeout because booking and audition clients explicitly allow 120 seconds. Ordinary API requests in the final replay use the standard 30-second client deadline.

| Warm / concurrency / pool | Benchmark result |
| --- | --- |
| 1 / 80 / 5 | Stopped after 59 failed requests and 481 unsent iterations; p95 3.95 s under a 12 s test deadline. |
| 2 / 12 / 5 | Stopped after 61 failed requests and 102 unsent iterations; p95 256 ms under the same deadline. |
| 2 / 40 / 8 | 11,649 scheduled iterations completed, zero failures and zero unsent. P95 7.34 s. |
| 3 / 32 / 8 | 11,649 completed, zero failures and zero unsent. P95 3.70 s. |
| 1 / 40 / 8, duplicate-read experiment | 11,503 completed, zero HTTP failures, 146 unsent, p95 14.68 s. Exclude this experimental image from production. |
| 2 / 160 / 12 | 11,649 completed, zero failures and zero unsent, p95 13.5 s. |
| 4 / 80 / 10 | 11,649 completed, zero failures and zero unsent, p95 582 ms. Slowest response 1.92 s. |
| 1 / 80 / 8, 15% CPU and 10% concurrency scale-out targets | 11,649 completed, 100 HTTP failures, zero unsent, p95 26.26 s. |

The passing four-warm configuration used the regular pool-fixed application image. A separate 480-read rehearsal included an authenticated customer, project wizard, casting and billing, a temporary analytics-only admin login, and three staging-only synthetic auditions. It completed all three phases. The local voice fallback exercises the application and audio storage paths without calling an external voice provider. The four-warm public burst is [recorded in Cloud Build](https://console.cloud.google.com/cloud-build/builds;region=us-central1/ca831f9c-0fc9-460f-9a32-18748927ca33?project=glass-marker-487618-i6). The production warm-floor decision is separate from enforcing the pool limit.

The third run used 1,500 preallocated virtual users and a 30-second deadline, as did every subsequent run. Cold-start delays are part of the result. The three-warm configuration separately passed 480 authenticated project, casting and billing reads at 2 → 10 → 2 requests/s, with phase p95 of 146 / 106 / 103 ms. A signed-in fixture overlapping the two-warm public burst exceeded its p95 target. The separate authenticated run does not establish simultaneous performance. The repository's staging smoke also verified customer session issuance, project and casting creation, billing access, restrictions, and fixture cleanup. Provider generation was disabled.

**Monitoring.** Seven enabled policies cover the revision ceiling, request p95, server errors per minute, Cloud Run CPU and memory, and database connections and CPU. The initial database alert of 60 connections detects growth above one fully scaled revision. Apply the monitoring script with a notification channel resource to connect delivery. [Production dashboard](https://console.cloud.google.com/monitoring/dashboards/builder/8c8ea4d3-2887-4f7e-980c-be473e70f5c4?project=glass-marker-487618-i6)

## Original user story

> As **the platform owner**, I want **the prod backend + frontend to scale up and down
> with real traffic without exhausting the database or dropping requests**, so that
> **the site stays fast under load spikes and cheap when idle.**

## Context
Both prod services run on **Cloud Run** (`bvo-backend-prod`, `bvo-frontend-prod`) in
`glass-marker-487618-i6` / `us-central1`. Current backend
(`backend-service.prod.yaml`): `minScale: 1`, `maxScale: 20`,
`containerConcurrency: 80`, `cpu: "1"`, `memory: 512Mi`, behind the
`bvo-vpc-connector`. These numbers were set for bring-up, **not** load-tested. The real
risk isn't Cloud Run capacity — it's **downstream**: each backend instance opens
Postgres (Cloud SQL) connections, so `maxScale × pool-size` can blow past the DB's
`max_connections` during a spike and cause cascading failures. This task derives the
right ceilings from an actual load test and adds the missing pooling/limits.

## Scope
1. **Establish capacity baseline** — load-test prod-like traffic (staging or a
   dedicated test env) to find per-instance throughput, p95 latency, memory headroom,
   and cold-start cost. Drive all numbers below from the results, not guesses.
2. **Cloud Run backend autoscaling**
   - Tune `minScale` (warm floor to avoid cold starts on live traffic) and `maxScale`
     (ceiling that the **DB** can survive, not just Cloud Run).
   - Tune `containerConcurrency` vs `cpu`/`memory` — concurrency too high starves CPU;
     too low over-scales instances and multiplies DB connections.
   - Enable **startup CPU boost** to cut cold-start latency.
   - Set a request **timeout** aligned with the Axios 30s client timeout.
3. **Cloud Run frontend autoscaling** — `bvo-frontend-prod` serves static + `server.js`;
   lighter, but still set a sane `minScale`/`maxScale` and concurrency.
4. **Database connection safety (critical)**
   - Add/confirm an app-side **connection pool** cap (TypeORM `extra.max`) so
     `maxScale × poolMax ≤ Cloud SQL max_connections` with headroom for migrations/jobs.
   - Evaluate **PgBouncer** (or Cloud SQL connection limits) if the ceiling is tight.
   - Confirm Cloud SQL tier can handle target concurrent connections; size up or add a
     **read replica** for read-heavy admin analytics if needed.
5. **Redis / Memorystore (Valkey)** — confirm the instance handles peak connections
   from all backend instances; tune client pool.
6. **VPC connector throughput** — confirm `bvo-vpc-connector` min/max instances /
   throughput won't bottleneck egress at peak scale.
7. **Guardrails & observability** — Cloud Monitoring dashboards + **alerts** on
   instance count near `maxScale`, request latency p95, 5xx rate, Cloud SQL
   connections/CPU, and Cloud Run CPU/memory utilization.

## Acceptance criteria
- [ ] A documented load test shows target RPS sustained at acceptable p95 latency with
      **0 dropped requests** and **no DB connection exhaustion**.
- [ ] `maxScale × per-instance DB pool max` provably stays under Cloud SQL
      `max_connections` (with headroom for migration jobs) — shown with numbers.
- [ ] `minScale`/`maxScale`/`concurrency`/CPU/memory in `backend-service.prod.yaml` and
      the frontend manifest are set from the load test and committed.
- [ ] Startup CPU boost enabled; cold-start p95 measured and acceptable.
- [ ] Monitoring dashboard + alerts live for scale ceiling, latency, 5xx, and Cloud SQL
      connections/CPU.
- [ ] A spike test (rapid ramp) scales up and back down cleanly with no errors.

## Subtasks
- [ ] Pick/stand up a load-testing tool (k6, Locust, or Vegeta) + representative
      scenario (auth, wizard, audition generate, billing, admin analytics).
- [ ] Run baseline load test; record per-instance throughput + resource ceilings.
- [ ] Add TypeORM pool `max` (and idle/acquire timeouts) to
      `PostgresqlConnection.ts`; document the math vs `maxScale`.
- [ ] Decide on PgBouncer / read replica / Cloud SQL tier bump; implement if needed.
- [ ] Update `backend-service.prod.yaml`: `minScale`, `maxScale`, `containerConcurrency`,
      `cpu`, `memory`, `startup-cpu-boost`, `timeout`.
- [ ] Update frontend prod manifest scaling settings.
- [ ] Verify Memorystore + VPC connector capacity; tune.
- [ ] Build Cloud Monitoring dashboard + alert policies.
- [ ] Re-run load + spike test; capture results in this doc.
- [ ] Update `trigger-setup.md` / infra notes with the chosen numbers and rationale.

## 2026-09-01 production incident — partial delivery

This story's central warning ("the DB is the real ceiling") went unimplemented and prod paid
for it. On **2026-09-01, 1:29–1:45 PM EST**, `bionicvo.ai` served GFE 500s
(`The request failed because the instance could not start successfully.`) with zero healthy
backend instances. ClickUp: https://app.clickup.com/t/86bbw3dac

Root cause was **not** capacity. `bin/www.ts` awaited `dataSource.initialize()` *before*
`bootstrap.listen()`, and swallowed the failure in a `catch` that only logged — so an
unreachable Postgres produced a process that never bound port 3000. Cloud Run read that as a
failed container start, killed the instance, and retried. The pool gap was the contributing
cause: with no `max`, node-postgres defaulted to 10 per instance and `maxScale: 20` could open
200 connections against the database.

**Delivered on `fix/prod-boot-resilience`:**
- [x] TypeORM pool `max` (via `DB_POOL_MAX`) + idle/connection timeouts and TCP keepalive in
      `PostgresqlConnection.ts`; migration job capped at 2 connections.
- [x] Startup CPU boost on all three backend environments; `cpu-throttling: false` on prod so
      background timers aren't starved.
- [x] Prod `maxScale` 20 → 10 and `memory` 512Mi → 1Gi, with the connection math written into
      the manifest.
- [x] Explicit HTTP `startupProbe` against the shallow `/api/v1/apiHealthCheck`, replacing the
      default single 240s TCP probe.
- Plus (outside this story's original scope) listen-before-dependencies boot ordering, a
  retrying background DB connect, `/api/v1/apiHealthCheck/ready`, and a 503 readiness guard.

**Still open — this bought resilience, not verified capacity:**
- [ ] The load test and every number that should be derived from it. `maxScale: 10` /
      `DB_POOL_MAX: 5` are reasoned from an **assumed** `max_connections: 100`, not a measured
      one. Confirm with `SHOW max_connections;` and re-derive.
- [ ] PgBouncer / Cloud SQL tier / read-replica decision.
- [ ] Cloud Monitoring dashboard and alerts — nothing paged during the outage; it was found by
      reading logs after the fact.
- [ ] Frontend manifest scaling; Memorystore and VPC connector capacity checks.

## Notes / gotchas
- **The DB is the real ceiling.** Cloud Run will happily scale to `maxScale` and open
  more connections than Postgres allows — set `maxScale` *and* the app pool cap
  together, never independently.
- **Migration Cloud Run Jobs** (`bvo-migrate-prod`) also consume connections — leave
  headroom below `max_connections` for them running concurrently with live traffic.
- A high `minScale` removes cold starts but costs money 24/7 — balance against traffic
  patterns (e.g. lower floor overnight isn't possible on Cloud Run, so pick a floor you
  can afford continuously).
- `containerConcurrency` interacts with everything: raising it reduces instance count
  (fewer DB connections) but needs more CPU/memory per instance — tune as a pair.
- Load-test against **staging or a throwaway env**, never prod's live DB.
