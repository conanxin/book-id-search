# S32 Production PostgreSQL Readiness — R2 evidence and deployment direction

Date: 2026-09-19

Scope: documentation and readiness assessment only. No production commands, image builds, deployments, service reloads, cleanup, or M1-B work were executed by this documentation update.

## Decision

The requested inode/memory/effective-Compose follow-up is resolved for planning purposes. Proceed to a bounded deployment plan rather than repeating the host-wide audit.

```text
INODE_EVIDENCE=COLLECTED_NO_EXHAUSTION_OBSERVED
MEMORY_EVIDENCE=COLLECTED_HEADROOM_OBSERVED
COMPOSE_IMAGE_MOUNT_PORT_RECONCILIATION=MATCH
READY_FOR_DEPLOYMENT_PLAN=YES
READY_FOR_PRODUCTION_EXECUTION=NO
EXECUTION_CAPACITY_BUDGET=UNRESOLVED
PRODUCTION_DEPLOYMENT=NOT_STARTED
M1_B_STARTED=NO
```

READY_FOR_DEPLOYMENT_PLAN means sufficient information to design the change. It does not waive the existing capacity policy, prove a release image fits, authorize deployment, or certify uninspected configuration fields.

## Evidence provenance

1. Current evidence: the user's pasted terminal output from the targeted inode, memory, container-inspect, and ordered-Compose-render command. These are user-supplied host observations, not a new ChatGPT SSH run.
2. Earlier evidence: S32_PROD_PG_READINESS_R1 terminal attachment. Disk bytes, production checkout, health, and the existing PostgreSQL image below are carried forward explicitly from that observation; the current follow-up did not repeat those measurements.
3. Repository reads in this review: main remained `630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d`; API Dockerfile read at that commit; Web Dockerfile/nginx.conf read at its reported running source revision `99a3702c64e5ae389800348dc7310f23eaed4a66`.
4. Transcription correction: the supplied terminal says memory free=920 MiB and swap used=851 MiB, not the earlier draft's 930/852 MiB. The 5.1 GiB available-memory value and readiness decision are unchanged.

## Current host follow-up

### Inodes and memory

- `/`, `/data`, and `/var/lib/docker`: `/dev/vda2`, 6,619,136 inodes total, 1,414,454 used, 5,204,682 free, 22% used.
- Memory: 7.4 GiB total, 2.1 GiB used, 920 MiB free, 4.5 GiB buff/cache, 5.1 GiB available.
- Swap: 4.0 GiB total, 851 MiB used, 3.2 GiB free.

The snapshot does not show inode exhaustion or a current lack of available memory. Swap occupancy alone does not establish current swapping rate or sustained memory pressure. This is not a load test or a guarantee about future resource use.

### Image, mount, and published-port reconciliation

| Service | Running image, also present in rendered configuration | Published host port |
| --- | --- | --- |
| api | `book-id-search-api:3add9a60a20364fbd32b64a7d54197b75983d26e` | `127.0.0.1:3001 -> 3001/tcp` |
| web | `book-id-search-web:99a3702c64e5ae389800348dc7310f23eaed4a66` | `127.0.0.1:5173 -> 80/tcp` |
| meilisearch | `getmeili/meilisearch:v1.48.3` | `127.0.0.1:7700 -> 7700/tcp` |

API bind mounts agree in the two views:

- `/data/book-id-search/private-data -> /data/private`, read-only.
- `/opt/book-id-search/reports -> /app/reports`, read-write.
- `/opt/book-id-search/private-data/weread -> /app/private-data/weread`, read-only.

Meilisearch has `/data/book-id-search/meili_data -> /meili_data`, read-write, in both views. Web has no mounts in either view.

The render used the ordered chain recorded on the Web container:

1. `/opt/book-id-search/docker-compose.yml`
2. `/opt/book-id-search/docker-compose.override.yml`
3. `/opt/book-id-search-runtime/s31/3add9a60a20364fbd32b64a7d54197b75983d26e/api-production.override.yml`
4. `/opt/book-id-search-runtime/s32/99a3702c64e5ae389800348dc7310f23eaed4a66/web-production.override.yml`

The selected image/mount/port fields agree with the running containers. The rendered services declare the default network; this follow-up did not print live NetworkSettings, environment values, restart policy, limits, or command/entrypoint. Do not call this a complete all-field configuration equivalence check. No repeat broad audit is needed merely to inflate that claim.

## Remaining build/deployment distinction

The rendered API and Web configurations retain BOTH `image` and `build`. Both build contexts point to `/opt/book-id-search`; the previous host audit showed that checkout at `9a18b2aa...`, not at the merged M1-A source.

Therefore, blindly executing `docker compose up -d --build` can rebuild from the wrong source and retag existing image names. Do not use an unqualified whole-stack build/up as the deployment method.

Independent repository finding: the API Dockerfile at `630ae41...` starts from `node:22-alpine`, does not copy `pnpm-lock.yaml` before installation, and uses `pnpm install --frozen-lockfile=false`. M1-A's prior tests do not constitute evidence that a reproducible release image has been built from this Dockerfile. Release preparation must use the actual lockfile and verify the built image contains the intended source. This is release preparation, not a reason to reopen the already-tested domain/schema work.

## Disk policy: planning can proceed; execution budget is still open

Last observed, NOT freshly remeasured here:

```text
FREE_BYTES=21846708224
FREE_GIB=20.346332550048828
USED_PERCENT=79
20_GIB_POLICY_FLOOR_BYTES=21474836480
HEADROOM_ABOVE_POLICY_FLOOR_BYTES=371871744
HEADROOM_ABOVE_POLICY_FLOOR_MIB=354.64453125
21_GIB_PREFERRED_BYTES=22548578304
GAP_TO_PREFERRED_BYTES=701870080
```

The host had about 20.35 GiB actually free, not only 355 MiB free. The 355 MiB number is the extra space above the previously chosen 20 GiB reserve.

Neither 20 nor 21 GiB is a PostgreSQL official minimum. Keep the prior policy visible; do not change it silently and do not infer that disk expansion is mandatory. Off-host building avoids host build cache spikes but does not eliminate image-download/unpack and PostgreSQL data/WAL costs.

Before production execution, the plan must budget: new API image incremental storage including acquisition peak, PostgreSQL initialization/data/WAL, and bounded log/transient allowance. Compare this with a fresh free-space value. If the estimate does not fit the approved reserve, return the concrete shortfall for a capacity decision; do not start automatic cleanup or expansion.

## Bounded deployment direction (proposed, not executed)

### Prepare the release outside the production checkout

Build one immutable API image from the reviewed source plus any separately reviewed packaging-only correction. Use the lockfile, record source SHA and image digest, and verify the image's API starts. Prefer a CI/development-machine build rather than production-host dependency installation and image building. No registry publication or image acquisition was performed in this review.

### Add one final S32 override

Preserve the four existing Compose files and their order. A new final override should add PostgreSQL and select the new API image/configuration, rather than replacing the existing deployment model.

Suggested PG data directory: `/data/book-id-search/postgres_data`; this is a proposed path, not one already created. Use the already-acquired PostgreSQL 16 digest, persistent storage, and no host-published 5432 port. Retain the API's existing three mount mappings and loopback port. PostgreSQL and API must share an appropriate internal network; do not change Web/Meilisearch networking as a side effect.

### Apply only the intended services after approval

The planned change scope is PostgreSQL creation plus API replacement. Use an explicit Compose file chain and service-targeted operations with building disabled and linked-service startup disabled as appropriate; do not use `down`, whole-stack rebuild, or orphan cleanup.

S32 remains disabled until its schema and private API wiring are ready. Production enablement is a later explicit action within the approved deployment scope, not an effect of this document.

### Web proxy qualification

The source associated with the reported running Web image uses literal `proxy_pass http://api:3001/...` for both `/api/` and `/api/private/`. No Web rebuild is required to add the S32 private route. However, if replacement of API changes its container IP and the running Nginx configuration corresponds to this source, a graceful Nginx reload may be needed to refresh resolution. Do not promise that every Web process remains untouched while replacing API. A conditional configuration test/reload must be included in any subsequent approved execution scope; no reload was performed here.

## Immediate next deliverable

Prepare the release-image and final-override deployment artifacts with their concrete size budget. No more generic disk/Agent-cache audits, no schema redesign, and no M1-B expansion. This review creates documentation only; production execution still requires an explicit go decision.

## References

- Source baseline: https://github.com/conanxin/book-id-search/commit/630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d
- API Dockerfile: https://github.com/conanxin/book-id-search/blob/630ae41e40ed6e0dbcae5cd57ac5594ea1c83f4d/apps/api/Dockerfile
- Running-Web source Nginx configuration: https://github.com/conanxin/book-id-search/blob/99a3702c64e5ae389800348dc7310f23eaed4a66/apps/web/nginx.conf
- Docker Compose build/image semantics: https://docs.docker.com/reference/compose-file/build/
- Docker Compose targeted up options: https://docs.docker.com/reference/cli/docker/compose/up/
- Available-memory field: https://www.man7.org/linux/man-pages/man1/free.1.html
- Nginx DNS behavior: https://www.f5.com/fr_fr/company/blog/nginx/dns-service-discovery-nginx-plus
- Nginx graceful reload: https://nginx.org/en/docs/control.html
