# @nestarc/inbox 구현 로드맵

기준일: 2026년 10월 27일 · 연결 문서: [패키지 기획](package-plan.md)

첫 릴리스는 수신 저장, DB worker, 영구 재시도, DEAD 재처리를 갖춘 `0.1.0 Preview`로 제안한다. 개발 순서는 코드 양보다 데이터 손실과 중복 커밋 가능성을 먼저 검증하도록 정한다. 아래 6~8주는 숙련 개발자 1명이 주로 투입되는 경우의 계획 가정이며, 확정 일정이 아니다. 기존 패키지 재구조화는 이 출시의 선행 조건으로 두지 않는다.

Preview.1 추가 범위는 [사용법](usage.md)의 완료 메시지 replay와 tenancy adapter, [예제](../examples/README.md)의 브로커·idempotency 연동을 따른다. 기존 AC12의 COMPLETED requeue 금지는 유지하며, 새 replay API는 원본을 보존한 별도 receipt를 생성한다.

0.2.0 후속 작업에서는 [테스트 helper](testing.md), 실제 네트워크·프로세스 종료 복구, [standby 승격과 디스크 고갈](db-operations.md), [RabbitMQ 재시작·retry·DLQ](broker-recovery.md) 검증과 디스크 기반 지속 부하 측정 도구를 추가했다. 아래 단계와 초기 착수 목록은 원래 계획이며, 최신 실행 결과는 [검증 기록](validation.md)을 따른다. **M5 실제 서비스 도입·피드백은 이번 작업에서 제외했으며 완료하지 않았다.**

## 단계별 산출물

| 단계 | 기간 가정 | 산출물 | 다음 단계 진입 기준 |
| --- | --- | --- | --- |
| M0 계약과 기술 실험 | 1주 | identity·fingerprint·상태 전이·ACK 계약, Prisma transaction 실험 | 오래된 worker의 업무 쓰기까지 롤백되는 PostgreSQL 재현 테스트 |
| M1 수신과 저장 | 1주 | SQL schema/migration, `accept`, unique·conflict, validation | 동일 메시지 동시 수신과 commit 응답 유실 검증 |
| M2 처리와 복구 | 1~2주 | claim, lease, heartbeat, handler transaction, retry, DEAD | 프로세스 강제 종료·lease 경합·최대 시도 테스트 통과 |
| M3 Nest와 운영 | 1주 | 모듈, DI, worker 역할, 종료 처리, scoped admin, retention | tenant 격리·requeue 경합·hook 실패·정리 경합 검증 |
| M4 조합과 출시 후보 | 1주 | outbox 연동, RabbitMQ/webhook 예제, npm tarball 검증 | 실제 설치된 패키지로 end-to-end 예제 실행 |
| M5 도입 피드백 | 1~2주 | 실제 서비스 2곳 도입 목표, 부하·운영 기록 | Preview 계약 수정과 v1.0 후보 범위 결정 |

M0에서 원자성 또는 timeout 계약을 구현하지 못하면 worker API를 확장하기 전에 저장소 설계를 고친다. CLI·dashboard·추가 브로커 adapter로 일정 차이를 메우지 않는다.

## 바로 착수할 작업

1. `docs/adr/`에 durable acceptance 모드, DB transaction 경계, identity와 재시도 소유권을 결정 기록으로 고정한다.
2. 최소 TypeScript·NestJS 패키지와 별도 PostgreSQL 통합 테스트 환경을 만든다.
3. inbox row 하나와 업무 counter를 사용해 완료 CAS 실패가 업무 쓰기도 롤백하는 실험을 작성한다.
4. worker A 정지 → lease 만료 → worker B 확보 → A 복귀 시나리오를 두 연결·두 프로세스로 재현한다.
5. 동일 transaction을 사용하는 outbox 기록까지 롤백되는지 검증한 뒤 API와 schema를 고정한다.

## 권장 저장소 구조

```text
src/
  index.ts
  inbox.module.ts
  inbox.service.ts
  inbox-admin.service.ts
  contracts/
  storage/prisma/
  worker/
  internal/
  sql/
test/
  unit/
  integration/
  failure/
  consumer/
examples/
  outbox-to-inbox/
  rabbitmq-ingress/
  webhook-ingress/
docs/
  package-plan.md
  implementation-roadmap.md
  adr/
```

저장소 interface는 내부 교체와 테스트를 위한 최소 경계로 둔다. 초기부터 임의 adapter를 지원하는 안정 API로 공개하지 않는다. Prisma client 생성과 연결 종료의 소유자는 사용자 앱이다. worker 종료가 끝난 뒤 앱이 client를 종료하는 순서를 예제에서 보여준다.

## 출시를 막는 필수 검증

아래는 출시 수용 기준이다. 현재 구현에서 각 기준을 어떤 테스트로 확인했는지와 남은 운영 검증은 [검증 기록](validation.md)에 연결했다. 데이터 경합과 복구는 실제 PostgreSQL로 확인하며 메모리 저장소만으로 대체하지 않는다.

| ID | 시나리오 | 통과 기준 |
| --- | --- | --- |
| AC01 | 같은 identity·payload를 100개 요청으로 동시 수신 | 레코드 1개, 성공한 업무 변경 1회, 나머지는 duplicate |
| AC02 | messageId는 같고 tenant·source·consumer가 다름 | 각 identity는 독립 처리, 다른 범위의 기록 노출 없음 |
| AC03 | 같은 identity로 다른 payload 수신 | conflict, 기존 payload·fingerprint·상태 불변 |
| AC04 | 업무 쓰기 뒤 handler 예외 | 업무 변경과 완료·outbox 모두 롤백, retry 일정 영구 저장 |
| AC05 | 수신 commit 직후 ACK 전 프로세스 종료 | 재전달이 duplicate가 되고 inbox가 계속 처리 |
| AC06 | claim 직후 프로세스 강제 종료 | lease 만료 뒤 재확보, 시도 예산 증가, 메시지 손실 없음 |
| AC07 | 이전 worker 정지 후 새 worker claim, 이전 worker 복귀 | 이전 token의 완료·갱신·실패 쓰기 거절, 이전 업무 transaction 롤백 |
| AC08 | 완료 CAS 직후 lease 만료와 reclaim 경합 | row lock과 상태 재검사로 업무 이중 커밋 없음 |
| AC09 | 커밋 응답 유실 또는 DB 연결 단절 | 완료를 실패로 덮어쓰지 않음, 재확인/lease 복구 후 수렴 |
| AC10 | 계속 실패하거나 crash하는 메시지 | 최초 실행 포함 설정 횟수까지만 시도하고 DEAD |
| AC11 | DEAD requeue 동시 요청과 오래된 expectedVersion | 한 회차만 생성, lifetime attempt·token 유지, 원 payload 불변 |
| AC12 | COMPLETED requeue 요청 | 명시적으로 거절, 업무 재실행 없음 |
| AC13 | 담당 handler 누락·미지원 schema·중복 consumer | 담당 등록 오류는 시작 실패, 담당 consumer의 처리 불가 schema는 사유와 함께 DEAD |
| AC14 | 다른 tenant의 ID로 조회·requeue | tenant 범위 바깥 읽기·쓰기 거절 |
| AC15 | 성공 payload 정리와 오래된 메시지 재전달 | identity·fingerprint가 남아 재처리되지 않음 |
| AC16 | pending·processing·retryable·dead에 정리 작업 실행 | 자동 삭제로 재처리 자료가 사라지지 않음 |
| AC17 | metrics·log·hook 예외 | 이미 커밋된 성공에 영향 없음, payload·비밀 header 미노출 |
| AC18 | 신규 claim 중단과 종료 drain | 제한 시간 내 진행 작업만 마무리, 나머지는 재확보 가능 |
| AC19 | payload 상한·비정상 JSON·identity 길이 초과·DB 용량 제한 | 조용한 절단·성공 ACK 없이 typed error 반환 |
| AC20 | inbox → 업무 쓰기 → outbox → downstream 중복 수신 | 소비자별 성공한 DB 효과 1회, 발행 재시도가 별도로 동작 |
| AC21 | ingress와 worker의 분리 배포·DB pool 포화 | 담당 consumer만 claim, 타 consumer를 DEAD로 만들지 않음, 가용 slot 이상 선점하지 않음 |
| AC22 | transaction timeout·SQL timeout·오래 멈춘 handler | 원자성 유지, 늦은 쓰기 실패, 무한 heartbeat로 영구 선점하지 않음 |
| AC23 | consumer를 담당하는 worker가 배포에서 사라짐 | backlog를 조용히 완료·폐기하지 않음, 지연 경보와 복구 절차로 탐지 |
| AC24 | 완료 CAS 성공 후 commit 전 프로세스 종료 | 업무 변경·outbox·완료가 함께 롤백되고 이후 재확보 가능 |
| AC25 | lease 만료 후 heartbeat와 DEAD requeue 후 이전 worker의 실패 쓰기 | 상태·token·시간 조건으로 소유권 부활과 새 PENDING 덮어쓰기 거절 |

fingerprint unit test에는 JSON key 순서, 배열 순서, 숫자·문자열 구분, 중첩 값, 가변 trace metadata 제외, 알고리즘 버전 변경을 포함한다. 업무 중복 unique constraint와 순서 역전은 앱의 책임임을 예제에서 보여준다.

## 호환성과 패키징 검증

첫 CI 후보는 Node 22·24, NestJS 11, Prisma 7, PostgreSQL 16·18이다. 실제로 통과한 조합만 지원 문서에 올린다. dependency의 최신 버전 번호와 API는 구현 착수 시 registry·해당 major 문서를 다시 확인해 고정한다.

- `npm pack` 결과를 빈 consumer 앱에 설치해 import, 타입, 런타임을 확인한다.
- outbox와 동일한 Prisma transaction을 공유하는 예제를 실제 DB에서 실행한다.
- 배포 SQL 자산이 tarball에 포함되고 fresh install과 upgrade가 동작하는지 확인한다.
- 런타임 schema 검사에서 잘못된 migration version을 감지한다.
- 앱의 Prisma migration과 inbox SQL 테이블 소유권이 충돌하지 않는 절차를 제공한다.
- queue SDK와 다른 Nestarc 패키지가 필수 runtime dependency로 들어오지 않는지 확인한다.

문서에는 ACK 시점, retry 책임, handler 제한, DEAD 복구, 데이터 보존, 지원 버전, DB 복원 시 중복 제거 상태도 과거로 돌아간다는 운영 조건을 포함한다. 예제에 설치되지 않은 기능이나 보장하지 않는 exactly-once 문구를 쓰지 않는다.

## 성능과 운영 검증

성능 수치를 출시 전에 만들어 약속하지 않는다. 재현 가능한 benchmark에서 DB 사양·버전·동시성·payload 크기·연결 수·행 수를 함께 기록한다. 빈 테이블뿐 아니라 완료 기록이 쌓인 상태와 중복 수신이 많은 상태도 측정한다.

측정 항목은 accept p50/p95/p99, 초당 수신 수, claim 지연, 가장 오래된 대기 시간, 처리 지연, SQL 수, pool 대기, retry 증가 시 backlog 회복 시간이다. 완료 기록의 증가량과 인덱스 크기를 측정해 retention 지침을 만든다.

첫 운영 설정은 제한된 동시성과 bounded batch를 사용한다. DB pool에는 heartbeat·상태 전환을 수행할 여유를 남긴다. 특정 tenant의 작업 집중이 다른 tenant를 얼마나 지연시키는지 기록하고, 공정성 스케줄러 도입은 실제 필요가 확인된 뒤 결정한다.

## 구현 전에 확정할 세부 결정

| 결정 | 현재 제안 | 확정 방법 |
| --- | --- | --- |
| lease·heartbeat·transaction 제한 | 짧은 DB 처리용 bounded timeout, heartbeat에 최대 수명 적용 | M0·M2 장애 실험 |
| retry 기본값 | 총 8회, 1초 기반, 5분 상한, full jitter | 실패 유형과 backlog 회복 측정 |
| payload와 metadata 상한 | payload 256 KiB, 명시적 JSON·header 허용 목록 | 실제 이벤트 예제와 DB 부하 확인 |
| fingerprint 규칙 | 의미 envelope의 정규화 JSON, 알고리즘 버전 저장 | golden vector와 upgrade 테스트 |
| 저장 schema와 인덱스 | 복합 unique, due·lease expiry 부분 인덱스 | 경쟁 실행과 쿼리 계획 확인 |
| consumer 배포 계약 | ingress와 worker가 호환되는 event/schema 정의 공유 | handler 제거·이전 schema backlog 테스트 |
| tenant transaction 연결 | 신뢰 가능한 scope 전달, 동일 tx에 앱의 접근 정책 적용 | 격리 테스트와 선택적 tenancy 조합 |

기능이 늘어나도 `accept()`의 커밋 경계, 같은 DB transaction의 완료 보장, retry 단일 소유권은 유지한다. 이 계약을 바꾸는 기능은 별도 설계 결정으로 검토한다.
