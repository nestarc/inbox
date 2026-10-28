# @nestarc/inbox MVP 검증 기록

## 0.2.0 후속 로컬 검증 — 2026년 10월 28일

0.1.0 이후 테스트 helper와 운영 복구 검증을 추가했다. SQL schema v2와 기존 처리 계약은 유지한다. 이 절은 실제 실행한 로컬 검증이며, 아래 과거 기록의 미확인 항목 중 이 결과가 다루는 범위를 갱신한다. **실제 서비스 2곳 도입과 피드백(M5)은 요청에 따라 이번 작업에서 제외했으며 완료하지 않았다.**

| 검사 | 결과와 조건 |
| --- | --- |
| 빌드·타입·단위 테스트 | Node 24.22.1, 단위 105개 통과. 새 helper 단위 20개 포함 |
| 테스트 helper DB 검증 | PostgreSQL 16, 실제 retry→완료·DEAD 관측·scope/중복 수신 3개 통과 |
| 독립 tarball 소비자 | 0.2.0을 별도 앱에 설치, strict TypeScript·CJS·ESM과 testing subpath, 실제 rollback→retry→완료 통과 |
| 릴리즈 검증 | 46개 통과, 새 testing export와 필수 배포 파일 검사 포함 |
| TCP disconnect·blackhole | PostgreSQL 16/18에서 transaction 롤백과 같은 Prisma client의 재연결 후 단일 업무/outbox 효과 확인 |
| pool 포화 | 두 연결을 약 2.5초 점유하여 claim·수신 실패를 확인하고 해제 후 재전달·처리 회복 |
| SIGTERM | 실제 자식 프로세스의 약 2.5초 정상 drain과 700ms 제한의 멈춘 handler 중단·후속 worker 복구 |
| PostgreSQL failover | 실제 physical standby의 WAL replay 확인 후 primary SIGKILL·승격, receipt 3건의 중복 방지와 미완료 claim 회복 |
| 디스크 공간 부족 | 16 MiB 업무 tablespace에서 실제 SQLSTATE `53100`, 업무/outbox 롤백, 공간 확보 후 retry 성공 |
| RabbitMQ 복구 | 실제 재시작 3회, 미ACK 재전달·영속 retry/TTL·retry 소진·DLQ 등 5개 시나리오 통과 |

네트워크·pool·SIGTERM 테스트는 [test/operations](../test/operations)에 있다. blackhole 시험은 driver `query_timeout=500ms`, `connectionTimeoutMillis=300ms`를 명시했다. 네트워크가 무기한 멈춰도 모든 기본 설정이 같은 시간 안에 복구한다는 보장은 아니다. PostgreSQL 18에서 이 다섯 테스트를 함께 실행한 시간은 약 10초였다.

[DB 운영 검증](db-operations.md)은 standby에 도착한 WAL을 기준으로 새 endpoint에 연결하는 절차를 검사한다. 비동기 복제에서 아직 전달되지 않은 commit의 무손실, 자동 장애 조치 시스템, WAL 볼륨 고갈을 보장하지 않는다. [브로커 복구](broker-recovery.md)는 RabbitMQ 단일 classic queue이며 Kafka rebalance·AWS SQS 운영 구성·브로커 클러스터 failover는 별도 배포 검증 대상이다.

`npm run test:operations`, `npm run test:operations:database`, `npm run test:broker-recovery`로 재현한다. DB와 브로커는 임의 이름·loopback 주소의 일회용 Docker fixture를 만들고 종료 시 제거한다. 일반 애플리케이션의 `DATABASE_URL`은 사용하지 않는다. CI와 Release의 별도 Node 24/PostgreSQL 16 job에서도 이 세 검증을 실행한다.

[디스크 기반 지속 부하 측정](benchmarks/2026-10-28-sustained-local.md)은 수신과 worker를 동시에 실행한 두 표본을 보존한다. 각 실행에서 120초 동안 19,199건을 수신했고 의도적 retry 385건을 거쳐 같은 수의 업무 효과와 완료 기록을 확인했다. 누락·중복 효과·예상 밖 오류는 0건이었다. 최대 backlog는 7,613/7,750건, 수신 종료 후 회복은 94.675/94.191초, 수신 p95는 20.615/21.736ms였다. 공유 pool 대기와 hot/cold tenant 지연을 기록했고 payload 24,199건 정리 뒤 fingerprint 보존·중복 검사 40/40을 확인했다. 각 표본은 약 214초이며 수시간·수일 soak test나 운영 처리량 보장은 아니다. 컨테이너와 전용 디스크 볼륨 정리를 확인했다.

## 0.1.0 최초 npm 게시 — 2026년 10월 28일

커밋 `15b01813f009bb012f88a081bdd4a7705befc90e`의 [CI 실행 40686580892](https://github.com/nestarc/inbox/actions/runs/40686580892)이 전체 성공했다. Node 22/24 × PostgreSQL 16/18 네 조합과 예제 8종이 검증한 동일 tarball을 대화형 2FA 인증으로 최초 게시했다. npm의 검사 대기 후 공개 레지스트리의 `@nestarc/inbox@0.1.0`과 `latest: 0.1.0`을 확인했고, 실제 내려받은 tarball의 SHA-512가 CI 산출물과 일치했다. 배포물은 87개 파일, 105,710바이트이며 SHA-256은 `9bd1b4292cb62a72fdff0d1b7fc4cf01a5f7a4967003022b28dd0f4d6f192c62`다.

[GitHub Release v0.1.0](https://github.com/nestarc/inbox/releases/tag/v0.1.0)은 같은 커밋을 가리킨다. npm Trusted Publisher는 `nestarc/inbox`, `release.yml`, environment `npm`, 직접 publish 허용으로 등록했다. 최초 수동 게시에는 GitHub OIDC provenance가 없다. 등록 성공과 실제 OIDC 게시 성공은 별개이며, 동일 버전의 무결성 확인·게시 건너뛰기로는 OIDC 인증을 검증할 수 없다. 새 연결은 [npm의 활성화 기한](https://docs.npmjs.com/trusted-publishers/)인 2일 안에 첫 게시를 성공시켜야 하며, 다음 새 버전으로 검증해야 한다.

게시 직후 HTTP 202 성공 응답 뒤 공개 조회가 잠시 404를 반환하는 상황을 관찰했다. 이후 배포 도구의 확인 대기를 16초에서 최대 20분으로 보완하고, 가상 시간으로 지연 공개·시간 초과·내용 불일치·조회 오류를 검사하는 테스트 5개를 추가했다. 릴리즈 테스트는 총 46개 통과했고 actionlint와 포맷 검사도 통과했다. 이 자동화 보완은 이미 게시한 0.1.0 tarball에 소급 반영하지 않는다.

아래 기록의 최초 게시·연결 미완료 표시는 각 검사 당시 상태를 보존한 이력이다.

## GitHub hosted CI 검증 — 2026년 10월 28일

커밋 `664b4fc`의 [CI 실행 40684612217](https://github.com/nestarc/inbox/actions/runs/40684612217)이 전체 성공했다. GitHub hosted Linux runner에서 Node 22/24 × PostgreSQL 16/18 네 조합의 단위·통합/복구·동일 tarball 소비자 검증을 통과했고, Node 24/PostgreSQL 16에서 브로커를 포함한 예제 8종도 통과했다. 빌드·타입·포맷·릴리즈 검증과 artifact 무결성 확인도 성공했다.

이 기록은 Preview.1 당시 커밋에 대한 실제 원격 결과다. 아래에서 hosted CI를 미확인으로 적은 문장은 이 실행 전 작성된 이력이며, npm 게시·OIDC 인증 성공과는 별개의 검증이다. 0.1.0은 이 런타임과 schema v2를 유지하고 버전 metadata와 문서를 갱신한 첫 공개 릴리즈다.

## README 온보딩과 성능 기록 검증 — 2026년 10월 28일

README의 Prisma model과 TypeScript 모듈 코드 블록을 수정 없이 추출해 별도 앱에서 검증했다. Node 24.22.1, NestJS 11.2.8, Prisma 7.10.1, TypeScript 5.9.3과 임시 PostgreSQL 16.15를 사용했다. `prisma-client` generator의 CommonJS client 생성과 strict TypeScript 컴파일을 통과했고, 실제 Nest application context에서 같은 ID를 두 번 수신해 `accepted` → `duplicate`, 동일 receipt, `COMPLETED`, 업무 projection 1건을 확인했다. 선택적 tenancy 패키지 없이 동작했고 앱·Prisma client·DB 연결을 순서대로 종료했다. 검증용 DB 컨테이너도 정리했다.

현재 Preview.1/schema v2로 benchmark를 세 번 연속 실행했다. 9개 시나리오 모두 업무 효과 수와 완료 상태 검증을 통과했고 수신·worker 오류는 0건이었다. 느렸던 세 번째 실행을 포함한 전체 범위와 원본 JSON은 [새 성능 기록](benchmarks/2026-10-28-preview1-local.md)에 보존했다. README의 수신 처리량과 p95는 이 기록을 반올림한 값이며 지속 처리량이나 SLA로 해석하지 않는다.

## 릴리즈 자동화 검증 — 2026년 10월 28일

GitHub Release 게시 시 npm OIDC로 배포하는 [워크플로우](../.github/workflows/release.yml)와 CI가 [공통 검증](../.github/workflows/release-validation.yml)을 사용하도록 구성했다. 관련 설정과 최초 연결 절차는 [배포 안내](releasing.md)에 있다.

| 검사                         | 결과                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| actionlint 1.7.12            | 워크플로우 3개 오류 없음. 선택적 ShellCheck는 미설치                                   |
| 릴리즈 회귀 테스트           | Node 22.23.4 / 24.22.1에서 각각 41개 통과                                              |
| Linux / GNU tar 1.34         | 초기 전체 38개, 추가 ref 검증을 포함한 artifact suite 21개 통과 및 실제 후보 검증 통과 |
| 빌드·타입·포맷·단위 테스트   | 통과, 단위 테스트 85개                                                                 |
| Node 24.22.1 / PostgreSQL 18 | 통합·프로세스 종료 복구 38개 통과                                                      |
| 동일 후보의 독립 소비자      | Node 22 / PostgreSQL 16 및 Node 24 / PostgreSQL 18 통과                                |
| 동일 후보의 예제 8종         | Node 24 / PostgreSQL 16 및 임시 브로커에서 모두 통과                                   |
| npm publish dry-run          | `next`·public 설정 통과, 실제 게시 없음                                                |

한 번 생성한 82개 파일·93,668바이트 tarball을 consumer와 예제에 전달했고, 실행 전후 metadata와 SHA-512 integrity 일치를 확인했다. 릴리즈 테스트는 태그/버전/이벤트/commit 불일치, main 이력 검사 실패, artifact 변조·금지 경로, 레지스트리 조회 오류와 기존 버전 충돌을 검사한다. Unicode·`+`·`@`가 있는 정상 브랜치명도 CI에서 허용한다.

GitHub의 `nestarc/inbox`에 `npm` Environment와 tag `v*.*.*` 배포 제한을 생성하고 API로 확인했다. npm 최초 등록·Trusted Publisher 연결·실제 OIDC publish는 아직 수행하지 않았다. GitHub hosted runner의 전체 matrix 성공과 npm provenance 발급을 로컬 검사 결과만으로 주장하지 않는다. 검증에 사용한 임시 DB·브로커 컨테이너는 정리했다.

## Preview.1 추가 검증 — 2026년 10월 28일

`0.1.0-preview.1`, schema v2를 Node 22.23.4, NestJS 11.2.8, Prisma 7.10.1에서 검증했다. 이번 실행 결과는 다음과 같다.

| 검사                                  | 결과                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| 빌드·TypeScript 검사·포맷 검사        | 통과                                                                               |
| 단위 테스트                           | 7개 파일, 85개 통과                                                                |
| PostgreSQL 16 통합·프로세스 종료 복구 | 4개 파일, 38개 통과                                                                |
| PostgreSQL 18 통합·프로세스 종료 복구 | 4개 파일, 38개 통과                                                                |
| 독립 tarball 소비자                   | CJS/ESM, public 타입, SQL export, replay, 선택적 tenancy 미설치 상태 모두 통과     |
| tarball 내부 예제 8종                 | outbox, webhook, tenancy, idempotency, RabbitMQ, Kafka, SQS 호환, BullMQ 모두 통과 |

추가한 [replay 테스트](../test/integration/replay.test.ts)는 동시 요청의 단일 receipt 생성, 원본 완료·중복 방지 보존, 별도 업무 효과 커밋, scope/version/상태·내용 충돌, payload 정리 후 요청 재시도, 용량 제한, v1→v2 migration과 스키마 제약을 검증한다. [tenancy 테스트](../test/integration/tenancy.test.ts)는 실제 `@nestarc/tenancy` 0.16.2 및 비소유자·비슈퍼유저·NOBYPASSRLS 역할로 tenant별 접근, 교차 tenant 쓰기 롤백, commit/rollback 후 pooled connection의 GUC 정리, global 기본 거절과 명시적 공유 경로를 검증한다. [handler context 테스트](../test/unit/handler-context.test.ts)는 next 생략·중복·오류 삼킴과 취소 이후 늦은 실행을 차단하는지 검사한다.

브로커 검증에는 RabbitMQ 4, Redpanda v26.2.6, Redis 7.4.2, ElasticMQ 1.7.1의 임시 Docker 컨테이너를 사용했다. 새 Kafka·SQS 호환·BullMQ 예제 각각에서 중복 전송 두 건이 업무 결과 한 건으로 수렴했고, 수신 전 일시 오류 재시도 한 번, handler 재시도 한 번, 잘못된 입력 격리를 확인했다. Kafka는 Redpanda의 Kafka protocol, SQS는 ElasticMQ 에뮬레이터에서 실행했으며 Apache Kafka의 모든 배포 조합이나 실제 AWS SQS 운영 환경까지 검증했다고 표현하지 않는다.

idempotency 예제는 실제 PostgreSQL response-cache 만료 이후에도 Inbox의 중복 방지와 내용 충돌 검사가 유지됨을 확인했다. 공통 JSON/hash·retry·취소 로직은 private source workspace로 분리했고 v1 fingerprint 고정값을 검증했다. 다른 저장소의 패키지를 이 workspace에 연결하거나 각 저장소의 lease SQL을 통합한 것은 아니다.

패키지 검증은 모든 archive 경로와 설치 결과를 재귀 검사한다. examples의 node_modules·dist·생성 Prisma client, test 디렉터리와 환경 파일을 제외했다. 기능 검증한 tarball은 약 90KB, 81개 파일이며 문서 변경에 따라 크기는 조금 달라질 수 있다. 새 스키마는 기존 업무 DB에 자동 적용되지 않으며, v1 사용자는 worker를 중지하고 명시적 upgrade SQL을 적용해야 한다.

아래 기록은 Preview.0 당시의 검증 이력이다. 실제 failover·장기 부하·외부 서비스 도입 등 운영 검증의 남은 항목은 여전히 유효하다.

## Preview.0 검증 이력

기준일: 2026년 10월 27일 · 대상: `0.1.0-preview.0`

수신 저장, 중복 제거, 같은 DB transaction의 업무 변경과 완료 처리, lease 복구, 운영 범위는 단위 테스트와 실제 PostgreSQL 통합 테스트로 검증한다. 아래 표는 [구현 로드맵](implementation-roadmap.md)의 AC01~AC25를 실행한 테스트에 연결한다. 테스트 통과는 표에 적힌 조건의 증거이며, 모든 운영 장애를 재현했다는 뜻은 아니다.

## 실행 환경과 재현 방법

NestJS 11.2.8과 Prisma 7.10.1을 사용하여 Node 22.23.4·24.11.1과 PostgreSQL 16·18의 네 조합에서 각각 실제 DB suite 25개를 통과했다. 단위 테스트 49개도 Node 22·24에서 통과했다. PostgreSQL 테스트는 Docker의 공식 이미지로 만든 임시 DB를 사용한다. 실행기는 기존 `DATABASE_URL`을 사용하지 않으며, 테스트는 fixture 표시와 loopback 주소를 검사한 뒤에만 테이블을 초기화한다. Docker나 DB를 사용할 수 없으면 실패하며 조용히 건너뛰지 않는다.

```sh
npm ci
npm run build
npm test
npm run test:integration
npm run typecheck
npm run test:package
npm run test:examples
```

`test:integration`은 테스트용 Prisma client를 생성한다. PostgreSQL 18은 `INBOX_TEST_POSTGRES_IMAGE=postgres:18-alpine npm run test:integration`으로 같은 suite를 실행할 수 있다. 실행 가능한 테스트 설정과 실제 확인한 호환성 조합은 구별한다.

## 테스트 종류

| 표의 이름  | 실제 파일과 검증 방식                                                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PG         | [postgres.test.ts](../test/integration/postgres.test.ts): 실제 PostgreSQL, 생성된 Prisma client, 독립 DB 연결의 경합                      |
| Crash      | [crash-recovery.test.ts](../test/failure/crash-recovery.test.ts): [자식 프로세스](../test/failure/crash-child.ts)를 실제 `SIGKILL`로 종료 |
| Worker     | [worker.test.ts](../test/unit/worker.test.ts): 저장소 대역과 제어된 시간·응답으로 worker의 분기와 수명 검증                               |
| Validation | [validation.test.ts](../test/unit/validation.test.ts): JSON 정규화, fingerprint, 입력 상한·metadata 계약                                  |
| Nest       | [module.test.ts](../test/unit/module.test.ts): Nest DI·모듈 생명주기와 범위를 전달하는 관리 API, DB는 대역                                |
| Package    | [test-package.mjs](../scripts/test-package.mjs): tarball을 별도 앱에 설치하고 실제 Prisma·DB로 public API 실행                            |
| Examples   | [smoke.cjs](../examples/scripts/smoke.cjs): 설치한 패키지와 실제 outbox·HTTP를 사용하는 예제                                              |

## 수용 기준별 증거

각 행의 따옴표 안 이름은 해당 파일의 테스트 이름이다. PG의 후속 이벤트 테이블은 원자성을 검증하기 위한 SQL fixture이며, 실제 `@nestarc/outbox` 조합은 AC20의 예제로 별도 확인한다.

| 기준                      | 실행한 테스트 또는 예제                                                                                                                                                                                                                           | 확인한 범위와 남은 조건                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| AC01 동시 중복 수신       | PG: `AC01 accepts 100 concurrent duplicates once and commits one set of effects`                                                                                                                                                                  | 같은 메시지 100회 동시 수신, 여러 claim 연결에서 수신 기록과 성공 업무 효과가 각각 하나                                            |
| AC02 identity 분리        | PG: `AC02 isolates tenant, global, source, and logical consumer identities`                                                                                                                                                                       | tenant·전역 scope·source·consumer가 다른 동일 message ID를 독립 처리                                                               |
| AC03 내용 충돌            | PG: `AC03 preserves a %s record on identity/content conflict`                                                                                                                                                                                     | PENDING·DEAD·COMPLETED 각각에서 fingerprint 충돌 시 원본 불변                                                                      |
| AC04 업무 실패 롤백       | PG: `AC04 rolls back generated Prisma model writes and follow-on events with handler failure`                                                                                                                                                     | 생성된 Prisma 모델 변경, 후속 이벤트 쓰기, 완료의 원자성 및 retry 일정 저장                                                        |
| AC05 수신 후 ACK 전 종료  | Crash: `AC05 survives SIGKILL after acceptance commit and before the transport ACK`                                                                                                                                                               | 실제 프로세스 종료 뒤 같은 identity 재수신이 duplicate로 수렴. 여기서 ACK 경계는 테스트 수신부의 제어 지점                         |
| AC06 claim 후 종료        | Crash: `AC06 recovers a committed claim after SIGKILL and real lease expiry`                                                                                                                                                                      | 실제 프로세스 종료와 실제 lease 만료 뒤 새 token·증가한 attempt로 복구                                                             |
| AC07 이전 worker 복귀     | PG: `AC07 rolls back all stale-worker writes after a competing claim acquires a newer token`                                                                                                                                                      | 열린 업무 transaction 중 별도 연결로 lease를 만료시켜 재확보한 뒤 이전 transaction 전체 롤백. 만료 시점은 SQL로 주입               |
| AC08 완료 CAS와 만료 경합 | PG: `AC08 protects a completed CAS with the row lock until commit even after lease expiry`                                                                                                                                                        | 실제 완료 갱신 후 COMMIT을 지연시키고 lease가 지나도 다른 연결의 claim이 이중 완료하지 못함                                        |
| AC09 커밋 결과 불확실     | PG: `AC09 reconciles a lost commit response without turning completed work into a retry`; Worker: `leaves a claim for lease recovery if commit state cannot be read`                                                                              | 실제 DB COMMIT 직후 호출자에게 오류를 주입한 경우와 조회 실패 대역을 검증. 실제 TCP 단절·DB failover는 미재현                      |
| AC10 최대 시도            | PG: `AC10 counts abandoned claims against the attempt budget and keeps other consumers untouched`; Worker: `reports DEAD for an exhausted attempt budget and caps retry delay`                                                                    | claim을 반복 포기해도 예산을 소비하고 DEAD로 전환. retry 지연 상한은 단위 테스트                                                   |
| AC11 requeue 경합         | PG: `AC11 and AC25 allow one requeue and reject stale heartbeats and failures after it`                                                                                                                                                           | 동시 requeue 중 하나만 성공, 누적 attempt·token 유지, 회차 예산 초기화                                                             |
| AC12 완료 재실행 금지     | PG: `AC12 rejects requeue of a completed record`                                                                                                                                                                                                  | requeue는 COMPLETED를 초기화하지 않음. Preview.1의 별도 replay는 새 receipt를 생성                                                 |
| AC13 등록과 schema 오류   | PG: `AC13 quarantines an unsupported owned schema while leaving foreign consumers pending`; Worker: `rejects ambiguous registrations or a missing owned handler before polling`                                                                   | 담당 consumer의 미지원 schema는 DEAD, 다른 consumer는 보존. 중복·누락 handler는 시작 전 거절                                       |
| AC14 tenant 관리 범위     | PG: `AC14 scopes reads, requeues, pagination, and stats to the selected tenant`; Nest: `captures the tenant scope in admin and validates requeue input`                                                                                           | 지정 범위 밖 조회·requeue 차단, 목록과 통계 분리. 앱 업무 테이블의 RLS 보장은 별도                                                 |
| AC15 완료 payload 정리    | PG: `AC15 and AC16 purge only completed payloads while preserving dedupe and every recoverable payload`                                                                                                                                           | payload를 지운 뒤에도 identity·fingerprint로 duplicate 판정                                                                        |
| AC16 복구 자료 보존       | PG: `AC15 and AC16 purge only completed payloads while preserving dedupe and every recoverable payload`                                                                                                                                           | PENDING·PROCESSING·RETRYABLE·DEAD payload는 정리 대상에서 제외                                                                     |
| AC17 관측 실패            | PG: `AC17 isolates failing observation hooks from committed results and excludes payload content`; Worker: `isolates throwing, rejecting, and hanging observers from committed processing`                                                        | 실패·거절·미완료 observer가 처리 결과를 바꾸지 않음. payload·tenant 값과 임의 오류 내용의 관측 경로 노출 제한                      |
| AC18 종료 drain           | Worker: `bounds shutdown drain and aborts hanging callbacks`, `does not execute records returned by a claim that raced shutdown`                                                                                                                  | 종료와 claim 경합, 제한 시간·abort는 저장소 대역으로 검증. 실제 프로세스의 SIGTERM drain은 별도 장시간 운영 검증 필요              |
| AC19 입력·용량 제한       | Validation: `rejects cycles, excessive nesting and oversized multibyte payloads`, `stops serialization at the byte budget before walking the remaining payload`; PG: `AC19 keeps duplicate receipts available when admission is full`             | JSON·길이·크기 제한과 설정된 backlog 상한 검증. DB 디스크 고갈은 미재현; admission 상한은 동시 수신 시 초과 가능한 근사치          |
| AC20 outbox 연계          | [outbox-to-inbox 예제](../examples/src/outbox-to-inbox/main.ts), Package의 public API transaction 테스트                                                                                                                                          | 실제 `@nestarc/outbox` 0.4.0으로 원 이벤트 → inbox → 업무 변경과 후속 outbox → 소비 결과를 확인하고 원 이벤트 재전달의 중복을 검사 |
| AC21 분리 배포와 pool     | PG: `AC21 and AC23 claim only available slots and leave unowned backlog visible`; Worker: `reserves capacity across overlapping claims and frees slots after a batch settles`                                                                     | consumer별 claim 범위와 동시성 예약을 검증. 실제 여러 배포의 DB connection pool 포화는 부하 시험으로 추가 확인 필요                |
| AC22 timeout과 정지       | PG: `AC22 closes timed-out transactions so an ignored deadline cannot write later`, `AC22 rolls back business writes when a SQL statement exceeds its timeout`; Worker: `serializes slow heartbeats and bounds their lifetime for a hung handler` | 실제 transaction·SQL 제한과 늦은 쓰기 거절, bounded heartbeat 검증. 네트워크를 강제로 멈춘 상태의 장기 pool 회복은 미재현          |
| AC23 담당 worker 부재     | PG: `AC21 and AC23 claim only available slots and leave unowned backlog visible`                                                                                                                                                                  | 미담당 consumer가 대기 상태로 남고 backlog 통계에 드러남. 외부 경보 시스템 연결과 실제 배포 제거 절차는 앱 운영 영역               |
| AC24 완료 갱신 후 종료    | Crash: `AC24 rolls back business, outbox, and completion when killed after completion CAS but before COMMIT`                                                                                                                                      | 실제 완료 CAS가 끝난 transaction의 COMMIT 직전에 프로세스를 종료하여 업무·후속 SQL·완료가 함께 롤백됨을 확인                       |
| AC25 오래된 후속 쓰기     | PG: `AC25 rejects heartbeat and failure after lease expiry before any new claim`, `AC11 and AC25 allow one requeue and reject stale heartbeats and failures after it`                                                                             | 만료 heartbeat의 소유권 부활과 requeue 이후 이전 token의 상태 덮어쓰기 거절                                                        |

추가로 PG의 `rejects an incompatible schema version without silently repairing it`는 런타임이 migration을 자동 수정하지 않고 시작을 거절하는지 확인한다. Worker의 `releases capacity when reconciliation reads stall and never starts a late failure write`와 `does not hold a concurrency slot for a stalled failure update`는 결과 재확인 경로가 멈춰도 실행 슬롯을 무기한 점유하지 않는지 대역으로 검증한다.

## 패키지와 예제 검증

Package 검증은 `npm pack` 결과를 임시 consumer 앱에 `--strict-peer-deps`로 설치한다. 이 앱은 별도로 Prisma client를 생성하고 strict TypeScript 검사, CommonJS import, 동적 ESM import, SQL export, 실제 중복 수신·업무 롤백·범위별 관리 API를 실행한다. 저장소 소스를 직접 import하는 테스트와 구별되는 배포물 검사다.

새 tarball에 포함된 examples를 임시 폴더에 추출하고 자체 의존성을 설치한 뒤, PostgreSQL 16과 RabbitMQ 4에서 세 예제를 실행했다. 실제 outbox 체인은 projection과 downstream 처리 기록이 각각 1개임을 확인했다. [webhook 예제](../examples/src/webhook-ingress/main.ts)는 잘못된 HMAC의 401, 정상 수신의 202, 중복 수신의 200을 확인했다. [RabbitMQ 예제](../examples/src/rabbitmq-ingress/main.ts)는 브로커 전달 2회가 업무 결과 1개로 수렴함을 확인했다. 브로커 자체의 장애·재시작과 retry/DLQ 전체 경로의 장애 주입은 추가 운영 검증 대상이다.

## 남은 검증

- 로컬 호환성 matrix는 통과했으며 GitHub Actions의 Linux matrix 실행은 아직 확인하지 않았다. 모든 Node 패치·Prisma minor 조합을 검사한 것은 아니다.
- 실제 TCP 분리·DB failover·디스크 고갈·지속적인 pool 포화·장시간 종료 drain을 재현하는 운영 장애 시험은 남아 있다.
- [소규모 로컬 benchmark](benchmarks/2026-10-27-local.md)는 새 테이블·완료 기록 1만 개·중복 90% 시나리오의 수신 지연과 worker 처리를 측정했다. 실제 디스크 I/O, 장시간 backlog, 지속적인 pool 포화와 여러 번 반복한 용량 시험은 남아 있다.
- Preview.0 당시에는 최초 schema 설치와 잘못된 version 거절까지만 확인했다. 이후 Preview.1에서 v1→v2 migration과 기존 receipt 보존 검증을 추가했으며, 결과는 이 문서의 Preview.1 기록에 있다.
- M5의 실제 서비스 2곳 도입과 운영 피드백은 진행하지 않았다. npm 배포와 외부 도입 완료도 이 기록에 포함하지 않는다.

핵심 보장은 handler의 모든 업무 쓰기가 전달받은 동일 DB transaction을 사용하고 완료 identity가 보존되는 조건에 한정된다. 외부 HTTP 호출·결제·이메일·다른 DB의 효과는 이 테스트로 원자성이나 exactly-once를 보장하지 않는다.
