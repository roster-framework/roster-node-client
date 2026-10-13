# Roster Runtime Node

Node 24 기반 독립 실행 서버입니다. 에이전트 생성·설정·실제 실행·로컬 checkpoint·세션 전달 저널을 소유합니다. 조직/IAM/업무 흐름은 외부 조정자의 책임입니다. 관리형 도구 검사와 로컬 CLI 실행은 OS 격리 보장이 아닙니다.

```powershell
npm ci
npm run build
$env:ROSTER_TOKEN = '<24자 이상의 서비스 토큰>'
$env:ROSTER_RUNTIME_ID = 'node-local'
node dist/main.js
```

기본 주소는 loopback 7331, 데이터 폴더는 `.roster`입니다. PORT와 ROSTER_DATA_DIR로 조정합니다. 여러 인스턴스는 서로 다른 ID·포트·데이터 폴더를 사용합니다. 원격 연결에는 TLS와 별도 자격 경계를 구성합니다. 키·데이터·로그인 파일을 저장소에 넣지 않습니다.

작성자 SDK는 `src/agent.ts`, 실행 예제는 [parameter-agent.ts](examples/parameter-agent.ts), 기본 CLI 프리셋은 [presets](presets/README.md)에 있습니다. Node/Python 모델 어댑터와 선택형 위임·협업 프리셋은 해당 환경/조정자 capability가 필요합니다. Runtime의 로컬 재개를 새 Go Core의 calls.resume 제공으로 해석하지 않습니다.

검증은 `npm run typecheck`, `npm test`를 사용합니다. 선택 Python 엔진은 별도 환경 준비가 필요합니다. 빌드/테스트 성공을 모든 provider·실제 모델·다중 호스트 수락으로 간주하지 않습니다.

상세 문서는 중앙 저장소에서 관리합니다: [설계](https://github.com/roster-framework/roster-docs/blob/main/roster-runtime-node/design.md) · [API](https://github.com/roster-framework/roster-docs/blob/main/roster-runtime-node/api.md) · [TODO](https://github.com/roster-framework/roster-docs/blob/main/roster-runtime-node/todo.md). 옛 Core 통합과 새 Core 제공 범위를 구분합니다.
