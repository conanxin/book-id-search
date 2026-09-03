# S27T-5E-R3B-R6-PRECLEAN — Old Isolated Project Evidence Preservation + Cleanup

**Pre-clean timestamp:** 2026-08-31 14:38 GMT+8
**Mode:** Evidence preservation + exact-project cleanup (NO source modifications)
**Evidence dir:** `progress/s27t5e-r3b-r6-preclean-20260831-143548/`

---

## STATUS

```
PASS_OLD_TEMP_EXACT_PROJECT_CLEANED
```

The exact isolated Compose project `s27t5e-r3b-r5-5450a6b5` was preserved
in full (container inspect, compose config, network inspect, logs, image
inspect, resource manifest) and then cleaned up using `docker compose down`
with the original `-f` and `-p` arguments. Production Web/API/Meili were
unchanged before/after. Image `book-id-search-web:1ab120c4...` was preserved
(only the project container was removed; the image itself is still in the
local docker image cache, shared with production). Old TEMP filesystem
`/home/ubuntu/s27t5e-r3b-r5-5450a6b5/` retained as required.

---

## OLD_TEMP_BEFORE

```
project:                s27t5e-r3b-r5-5450a6b5  (exact label confirmed)
containers:             1
                        s27t5e-r3b-r5-5450a6b5-web-1
                        CID  068c8b59dc2dec5f9a87261bc79fb22b98448574b7b62df1ca780dd9e43c408d
                        service=web
                        status=running (Up 2 days, restartcount=0)
                        image=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
                        imageID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
                        ports=127.0.0.1:60221->80/tcp
networks:               1
                        s27t5e-r3b-r5-5450a6b5_default
                        CID  d170eebf4ff8fb47424652e256c6a8802fbc32bbab6845d132e148904c66e8c3
                        driver=bridge, scope=local
port (host):            127.0.0.1:60221 (released after cleanup)
working_dir:            /home/ubuntu/s27t5e-r3b-r5-5450a6b5  (recovered from
                        com.docker.compose.project.working_dir label)
config_files:           /home/ubuntu/s27t5e-r3b-r5-5450a6b5/docker-compose.yml
                        (recovered from
                         com.docker.compose.project.config_files label)
candidate image:        book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
                        ImageID sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
OLD_TEMP_USES_PRODUCTION_IMAGE=true
```

---

## EVIDENCE_PRESERVED

```
inspect:
  container-068c8b59dc2dec5f9a87261bc79fb22b98448574b7b62df1ca780dd9e43c408d.inspect.json  (8.8 KB)
  network-d170eebf4ff8fb47424652e256c6a8802fbc32bbab6845d132e148904c66e8c3.inspect.json   (1.8 KB)
  candidate-image-book-id-search-web-1ab120c4.inspect.json                                (2.9 KB)

logs:
  old-temp-web.log  (1.3 KB; nginx 1.27.5 startup logs; one GET / HTTP 200 413 from Aug 29)

compose config:
  old-project-docker-compose.yml     (raw original)
  old-project-compose-config.yaml    (canonical, from `docker compose config`)

network inspect:
  network-d170eebf4ff8...inspect.json  (full)

resource manifest:
  resource-manifest-before.tsv
    TYPE     ID                                            NAME                            PROJECT_LABEL              SERVICE   IMAGE                                                      PORT
    container 068c8b59dc2dec5f9a87261bc79fb22b98448574b7b62df1ca780dd9e43c408d /s27t5e-r3b-r5-5450a6b5-web-1 s27t5e-r3b-r5-5450a6b5  web       book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af  80->60221/127.0.0.1
    network   d170eebf4ff8fb47424652e256c6a8802fbc32bbab6845d132e148904c66e8c3 s27t5e-r3b-r5-5450a6b5_default  s27t5e-r3b-r5-5450a6b5  (none)    (n/a)                                                       (n/a)
  (Both rows have project label = s27t5e-r3b-r5-5450a6b5, confirmed as the only cleanup target.)

production snapshots:
  production-before.tsv  (3 services; CIDs/StartedAt/Image/ImageID/Status/RCount)
  production-after.tsv   (identical to before)
```

---

## CLEANUP

```
exact command:
  cd /home/ubuntu/s27t5e-r3b-r5-5450a6b5
  sudo -n docker compose \
    -p s27t5e-r3b-r5-5450a6b5 \
    -f /home/ubuntu/s27t5e-r3b-r5-5450a6b5/docker-compose.yml \
    down

  (NO --rmi, NO --volumes, NO --remove-orphans;
   manifest confirmed only 1 container + 1 network in target project)

  Output:
    Container s27t5e-r3b-r5-5450a6b5-web-1 Stopping
    Container s27t5e-r3b-r5-5450a6b5-web-1 Stopped
    Container s27t5e-r3b-r5-5450a6b5-web-1 Removing
    Container s27t5e-r3b-r5-5450a6b5-web-1 Removed
    Network s27t5e-r3b-r5-5450a6b5_default Removing
    Network s27t5e-r3b-r5-5450a6b5_default Removed

container count after:    0  (project=    )
network count after:      0  (project=    )
port released:            yes (127.0.0.1:60221 no longer bound)
filesystem retained:      yes (/home/ubuntu/s27t5e-r3b-r5-5450a6b5/ untouched per task #21)
```

---

## IMAGE

```
image tag:               book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
image ID before:          sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
image ID after:           sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
removed=false:            yes (image preserved; only container removed; image
                                still in local cache and shared with production)
                          This is intentional and required (task #10 forbids
                          docker image rm / rmi / image prune / system prune).
```

---

## PRODUCTION

```
Web:
  before: f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da
          2026-08-07T23:04:36.143787072Z
          sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
          running  (Up 3 weeks)
  after:  f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da  ✓ unchanged
          2026-08-07T23:04:36.143787072Z  ✓ unchanged
          sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce  ✓ unchanged
          running

API:
  before: c408d8a0a44a0f6d7fdbe71cfbd7a0d18747448a70298edd750c85f4af940bd7
          2026-08-02T23:42:05.579239815Z
          sha256:ec9ed9c2505631c21845463f55361007fbc921aaa682b030d62402e6701149a1
          running  (Up 4 weeks)
  after:  c408d8a0a44a0f6d7fdbe71cfbd7a0d18747448a70298edd750c85f4af940bd7  ✓ unchanged
          2026-08-02T23:42:05.579239815Z  ✓ unchanged
          sha256:ec9ed9c2505631c21845463f55361007fbc921aaa682b030d62402e6701149a1  ✓ unchanged

Meili:
  before: ef247a985c28707e866e760c353119fd1b3702378d031963168444b80a5f9484
          2026-06-30T13:35:18.079914909Z
          sha256:c1a52f17c759c2cd6349eede3d5108b8dac07b97e10665b1d64a2d4961c2fd29
          running  (Up 2 months)
  after:  ef247a985c28707e866e760c353119fd1b3702378d031963168444b80a5f9484  ✓ unchanged
          2026-06-30T13:35:18.079914909Z  ✓ unchanged
          sha256:c1a52f17c759c2cd6349eede3d5108b8dac07b97e10665b1d64a2d4961c2fd29  ✓ unchanged

changed=false:            ✓ (production-before.tsv == production-after.tsv byte-for-byte)
```

---

## HOST

```
sudo SHA:                 686287d80efa1400561301a1c9fc1d35e03b74adde29bd94e5178a36e7b0a6c8
                          ✓ unchanged from before
bind mount:               none (findmnt -T /usr/bin/sudo → / on /dev/vda2 ext4)
                          ✓ unchanged from before
```

---

## REPO

```
HEAD:                     243347e4b2f7876f62a1c61b1cd71fb0a271a691
origin:                   243347e4b2f7876f62a1c61b1cd71fb0a271a691 (same)
source modified=false:    ✓ (no source files modified this turn)
commit=no:                ✓
push=no:                  ✓
tag=no:                   ✓

git status --short:       same as before-precheck (no new untracked files)
git diff --name-status:   only M scripts/test-deploy-web-release-candidate.sh
                          (PRE-R5B from Aug 28; same as previous turns)
```

---

## EVIDENCE

```
~/.openclaw/workspace/progress/s27t5e-r3b-r6-preclean-20260831-143548/
├── production-before.tsv                              (3 services snapshot)
├── production-after.tsv                               (3 services snapshot; identical to before)
├── container-068c8b59dc2d...068c8b59dc2d.inspect.json (8.8 KB)
├── network-d170eebf4ff8...d170eebf4ff8.inspect.json   (1.8 KB)
├── candidate-image-book-id-search-web-1ab120c4.inspect.json
├── old-project-docker-compose.yml                     (raw original)
├── old-project-compose-config.yaml                    (canonical from `docker compose config`)
├── old-temp-web.log                                   (1.3 KB; nginx startup logs)
├── resource-manifest-before.tsv                       (manifest of project resources)
└── compose-down.log                                   (docker compose down output)

Reports:
  reports/s27t5e-r3b-r6-preclean-final.md   (this report)
```

---

## NEXT

```
S27T-5E-R3B-R6
FINAL Fresh Real-Isolated Executor Integration
```

All cleanup gates PASS:
- ✓ exact project label confirmed via compose labels (NOT name/image/port heuristics)
- ✓ original working_dir recovered from `com.docker.compose.project.working_dir` label
- ✓ original compose config recovered from `com.docker.compose.project.config_files` label
- ✓ canonical compose config preserved
- ✓ container inspect JSON preserved
- ✓ network inspect JSON preserved
- ✓ logs preserved
- ✓ resource manifest saved
- ✓ candidate image identity matches (shared with production)
- ✓ production CIDs/StartedAt/ImageID unchanged before/after
- ✓ host sudo SHA + bind-mount unchanged
- ✓ main repo source unchanged
- ✓ zero containers/networks in target project after cleanup
- ✓ port 60221 released
- ✓ image preserved (NOT removed)
- ✓ filesystem retained per task #21 (only Docker resources cleaned)

Do not start R3B-R6 automatically.
Per task constraint #22: NO claim, deploy, compose up, commit, push, tag,
or R3B-R6 initiation this turn.

When R3B-R6 is started in a NEW session (after explicit user confirmation):
- Use a fresh isolated project label distinct from `s27t5e-r3b-r5-5450a6b5`
- Old TEMP filesystem `/home/ubuntu/s27t5e-r3b-r5-5450a6b5/` can be removed
  AFTER R3B-R6 PASSES (do NOT remove before; may still hold useful evidence).

---

## Permission/Constraint Audit (this turn)

| Constraint | Status |
|------------|--------|
| Modify no source files | ✓ no changes to scripts/* (git status unchanged) |
| No commit/push/tag | ✓ working tree only |
| Only project `s27t5e-r3b-r5-5450a6b5` cleaned (via exact compose labels) | ✓ |
| NO `docker image rm` / `docker rmi` / `image prune` / `system prune` | ✓ image preserved |
| NO `docker compose down` of any other project | ✓ only `-p s27t5e-r3b-r5-5450a6b5` |
| NO `--rmi` / `--volumes` / `--remove-orphans` flags | ✓ default `down` only |
| Preserve original compose context | ✓ working_dir + config_files recovered from labels |
| Production CIDs/StartedAt/ImageID unchanged | ✓ diff = empty |
| Host sudo SHA + bind-mount unchanged | ✓ |
| Main repo source unchanged | ✓ |
| Old TEMP filesystem retained | ✓ /home/ubuntu/s27t5e-r3b-r5-5450a6b5/ untouched |
| Do not start R3B-R6 | ✓ no new TEMP_REPO / no compose up / no claim / no deploy |

---

*End of preclean report. Total size: ~8 KB. No commit/push/tag performed. R3B-R6 NOT initiated.*
