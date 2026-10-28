# GitHub Release에서 npm 배포

`release.yml`은 GitHub Release의 **Publish release** 이벤트로 실행된다. `package.json` 버전이 `0.1.0`이면 태그는 `v0.1.0`, GitHub의 **Set as a pre-release**는 꺼져 있어야 한다. `-preview.1` 같은 prerelease 버전을 사용할 때만 이 옵션을 켠다. 태그만 push하거나 초안을 저장하면 배포하지 않는다.

인증 방식은 다른 nestarc 패키지와 동일한 **npm Trusted Publishing(GitHub OIDC)** 이다. `NPM_TOKEN`이나 `NODE_AUTH_TOKEN` secret을 추가하지 않는다. 배포 job만 `npm` GitHub Environment와 `id-token: write`를 사용하며, 빌드와 테스트 job은 저장소 읽기 권한만 가진다.

## 최초 연결

1. 이 구현과 lockfile을 `nestarc/inbox`의 `main`에 반영한다.
2. GitHub 저장소 **Settings → Environments → npm**을 준비한다. Deployment branches and tags는 Selected branches and tags로 설정하고 tag 패턴 `v*.*.*`를 허용한다. 팀 정책에 따라 reviewer를 추가할 수 있다.
3. npm에 `@nestarc/inbox`가 아직 없으면 권한 있는 관리자가 최초 버전을 등록한다. npm의 Trusted Publisher 설정은 이미 존재하는 패키지가 필요하다. 최초 등록에도 아래 검증한 tarball을 사용하고, `0.1.0`은 `--tag latest`, preview는 `--tag next`로 게시한다. 이 작업은 계정 로그인·2FA가 필요한 일회성 절차이며 워크플로우에 장기 토큰을 넣는 대체 경로는 없다.
4. npm 패키지 **Settings → Trusted Publisher → GitHub Actions**를 아래 값으로 연결한다. 현재 npm 설정에서 **Allow this trusted publisher to publish packages**를 활성화한다. stage만 허용된 설정으로는 이 워크플로우의 직접 publish가 성공하지 않는다.

| 항목                 | 값            |
| -------------------- | ------------- |
| Organization or user | `nestarc`     |
| Repository           | `inbox`       |
| Workflow filename    | `release.yml` |
| Environment          | `npm`         |

최신 npm CLI에서 동일한 설정을 만드는 명령은 다음과 같다. 패키지 쓰기 권한과 2FA가 있는 관리자 계정에서 실행한다.

```sh
npm trust github @nestarc/inbox \
  --file release.yml \
  --repo nestarc/inbox \
  --environment npm \
  --allow-publish
```

공식 [Trusted Publishers 안내](https://docs.npmjs.com/trusted-publishers/)와 [npm trust 명령](https://docs.npmjs.com/cli/v11/commands/npm-trust/)을 참고한다. 새 연결은 npm이 정한 활성화 기한 안에 첫 게시를 성공시켜야 한다. 워크플로우는 GitHub hosted runner, Node 24, npm 11.5.1 이상을 사용하고 npm 버전이 부족하면 실패한다. 로컬 검증이나 dry-run으로 원격 OIDC 연결까지 확인할 수는 없다.

최초 수동 등록 이후에는 버전을 올려 첫 OIDC 배포를 확인한다. 이미 게시된 동일 버전은 무결성 확인 후 건너뛰므로 Trusted Publisher의 실제 인증을 검증하지 않는다.

## 릴리즈 절차

1. 버전과 변경 기록을 갱신하고 `package.json`과 `package-lock.json`을 함께 커밋한다. 해당 커밋을 `main`에 병합한다.
2. 필요하면 Actions의 **Release → Run workflow**로 검증한다. 이 경로는 전체 검증과 `npm publish --dry-run`까지만 실행하며 게시 권한을 요청하지 않는다.
3. `main`에 포함된 커밋에 `v<package.json 버전>` 태그로 GitHub Release를 게시한다. 버전에 `-preview.1`, `-rc.1` 같은 prerelease 식별자가 있으면 GitHub prerelease 체크도 켠다.
4. Release 실행에서 `publish` job 성공과 npm 버전·integrity 확인 결과를 확인한다.

| 버전 예           | GitHub prerelease | npm dist-tag |
| ----------------- | ----------------- | ------------ |
| `0.1.0-preview.1` | 켬                | `next`       |
| `0.1.0-rc.1`      | 켬                | `next`       |
| `0.1.0`           | 끔                | `latest`     |

현재 `publishConfig.tag`는 `latest`이며, 배포 명령은 버전에 따라 `latest` 또는 `next`를 명시해 기본 설정을 덮어쓴다. 태그·버전·prerelease 표시가 불일치하거나 태그 커밋이 `main` 이력에 없으면 테스트와 게시 전에 거절한다. 빌드 메타데이터가 있는 버전(`1.0.0+build`)은 받지 않는다.

## 검증과 배포물

CI와 Release는 `release-validation.yml`을 공유한다. Node 22에서 한 번 빌드한 후 `package.tgz`와 `metadata.json`을 보관한다. metadata는 저장소·commit·ref·버전, 파일 목록, SHA-256과 npm SHA-512 integrity를 기록한다. SQL 설치/upgrade 파일, JavaScript 및 타입 진입점이 필요하며 환경 파일·의존성 디렉터리·생성 client·private workspace 패키지와 archive link는 거절한다.

Node 22/24 × PostgreSQL 16/18의 네 job이 같은 tarball을 내려받아 실제 DB 통합/복구 테스트와 독립 consumer 설치를 실행한다. Node 24/PostgreSQL 16에서는 tarball 내부 예제 8종을 실제 임시 브로커와 함께 검사한다. 각 consumer는 복사본을 읽기 전용으로 사용하며 실행 전후 원본·복사본·metadata 변경을 검사한다.

네 조합이 모두 성공해야 배포 job이 실행된다. 배포 job에서는 의존성 설치·빌드·재패킹을 하지 않고 해당 tarball을 `--ignore-scripts --provenance`로 게시한다. 게시 후 레지스트리의 integrity가 검증한 tarball과 같은지 확인한다.

npm은 게시 요청을 받은 뒤 설치 가능 상태가 되기 전에 패키지를 검사한다. 공식 [게시 시점 검사 안내](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)에 따르면 보통 약 5분, 혼잡하거나 추가 검토가 필요하면 15분 이상 걸릴 수 있다. 게시 성공 직후의 404만으로 실패나 미게시를 판단하지 않는다. 워크플로우는 30초 간격으로 진행 상황을 출력하며 최대 20분 동안 공개 여부와 integrity를 확인하고, 배포 job에는 총 30분을 허용한다. 내용 불일치와 404 이외의 조회 오류는 즉시 실패한다.

확인 시간이 초과되어도 같은 버전을 다시 게시하거나 전체 publish job을 바로 재실행하지 않는다. npm의 검사 상태·알림을 확인하고, 원래 검증한 `package.tgz`와 `metadata.json`을 보존한 채 확인 명령만 다시 실행한다. 검사에 더 오래 걸리거나 수동 검토가 필요한 경우 이 제한 안에 공개되지 않을 수 있다.

```sh
node scripts/release-artifact.mjs verify-published "$INBOX_RELEASE_TARBALL" "$INBOX_RELEASE_METADATA"
```

같은 버전이 이미 존재하면 bytes가 같은 경우만 게시를 건너뛴다. 다른 bytes이거나 레지스트리 조회가 404 이외의 오류이면 실패한다. 기존 버전을 덮어쓰지 말고 원인을 확인한 다음 새 버전을 사용한다. 같은 버전의 재실행은 기존 dist-tag를 이동시키지 않는다.

## 로컬 재현

Node 22.14 이상과 Docker가 필요하다. 임시 디렉터리는 저장소 밖에 둔다.

```sh
npm ci
npm run format:check
npm run test:release
npm run build
npm run typecheck
npm test
npm run test:integration

INBOX_CANDIDATE_DIR=$(mktemp -d)
node scripts/release-artifact.mjs pack "$INBOX_CANDIDATE_DIR"
export INBOX_RELEASE_TARBALL="$INBOX_CANDIDATE_DIR/package.tgz"
export INBOX_RELEASE_METADATA="$INBOX_CANDIDATE_DIR/metadata.json"
npm run test:package
npm run test:examples
node scripts/release-artifact.mjs verify "$INBOX_RELEASE_TARBALL" "$INBOX_RELEASE_METADATA"
npm publish "$INBOX_RELEASE_TARBALL" --ignore-scripts --access public --tag latest --dry-run
```

`INBOX_RELEASE_TARBALL`과 `INBOX_RELEASE_METADATA`는 둘 다 절대 경로로 지정한다. 두 변수를 생략한 일반 `test:package` / `test:examples` 실행은 기존처럼 로컬에서 빌드와 pack을 수행한다.
