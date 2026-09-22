# pi-hanja-guard

Pi coding agent 확장. 일부 모델이 파일에 한자/가나를 슬쩍 섞어 넣는 문제를 잡는다. 턴이 끝나기 전에 감지하고, 모델에게 되돌려 고치게 한다.

## 동작

1. `edit` / `write` / `ast_grep_replace(apply:true)` / `bash`(`>` `>>` `tee` `sed -i` `cp` `mv`) 로 **성공적으로 수정된 파일**을 현재 run 의 dirty 집합으로 추적한다.
2. run 종료 경계(`agent_before_settle`)에서 dirty 파일을 스캔한다. CJK 통합한자 + 확장 A/B–F + 호환 한자 + 라디컬 + `〇`/`々` + 가나 + 반각 가나.
3. 감지되면 `파일:행:열 + 문자 + 컨텍스트` 목록을 세션에 커밋하고 continuation 을 요청한다. 치환은 모델이 한다 — 의미 판단이 필요하므로 확장은 결정적 감지만 담당한다.
4. 루프 보호: 같은 시그니처 2회 연속이면 stall, run 당 continuation 총 4회 상한. stall 된 파일은 muted 로 옮겨 조용해지고, 해당 파일이 다시 수정되면 자동 re-track 된다.

오탐 방지로 정당한 ja/zh 콘텐츠는 기본 스킵한다: `**/locales/{ja,zh}*/**`, `**/locale/{ja,zh}*/**`, `**/i18n/{ja,zh}*/**`, `**/*.{ja,zh}.*`, `**/vendor/**`, `**/node_modules/**`.

## 설치

```bash
pi install git:github.com/heavyrisem/pi-hanja-guard
```

프로젝트 로컬만:

```bash
pi install git:github.com/heavyrisem/pi-hanja-guard -l
```

갱신: `pi update git:github.com/heavyrisem/pi-hanja-guard` (전체는 `pi update --extensions`)

## 요구 사항

- pi >= 0.87.0
- Node >= 22.19.0
- 외부 의존성 없음

## 명령어

| 명령 | 설명 |
|---|---|
| `/hanja <path>...` | 지정 파일 수동 검사 |
| `/hanja` | pending 파일 검사 |
| `/hanja --unmute` | muted 파일 해제 |

## 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PI_HANJA_SKIP` | (없음) | 쉼표로 구분한 추가 스킵 glob |
| `PI_HANJA_DEBUG` | (없음) | `1` 이면 상태 머신 로그를 stderr 로 출력 |

임계값(파일당 최대 hit, 최대 파일 크기, 라운드 상한)은 소스의 `CFG` 상수에 있다.

## 알려진 한계

`/reload` 시 모듈이 재로딩되어 in-memory 상태(dirty / muted / 카운터)가 초기화된다. 그 턴의 수정 파일은 다음 턴에 다시 수정되면 재추적된다.

## 비활성화

settings.json 에서 소스별로 끌 수 있다:

```json
{ "source": "git:github.com/<user>/pi-hanja-guard", "extensions": ["-hanja-guard.ts"] }
```

## 라이선스

MIT

## 개발

```bash
npm install
npm run typecheck
npm run pi:dev            # 이 확장만 로드해서 실행
npm run pi:install-local  # 현재 프로젝트에 로컬 설치
```

npm 에 safe-chain(minimum package age) 이 걸려 있으면 최신 `@earendil-works/*` 버전이 숨겨져 설치가 실패한다. 그때는 `npm install --safe-chain-skip-minimum-package-age`.
