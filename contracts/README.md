# Roster Contracts

`@roster/contracts`는 versioned TypeScript/Zod 값 계약·validators·언어 독립 JSON Schema와 Desk client입니다. 실행 서버·IAM·저장/큐·상태 전이 엔진을 구현하지 않습니다. 현재 package 버전은 package.json을 원문으로 사용하며 npm private입니다.

```sh
npm ci
npm test
npm pack
```

root export는 `src/index.ts`에서 생성한 dist 값/타입이며 `@roster/contracts/desk`는 별도 subpath입니다. `schemas/`는 다른 언어 소비자도 사용할 수 있습니다. 생성은 build/prepack 경로를 사용합니다. 소비자는 선택한 package/tarball 버전을 고정하고 schema 구조 외 원 request identity·수치·cursor·digest 의미 검증을 수행해야 합니다.

Runtime wire, 생성/중단/continuation과 옛 Core/Work/Desk 계약이 함께 있습니다. 타입 export가 있다고 새 Go Core가 해당 업무/IAM API를 제공하는 것은 아닙니다. 새 Core의 internal/contracts Go 도메인과 이 npm package를 동일한 것으로 취급하지 않습니다. private checkpoint·자격은 공개 계약 필드로 전달하지 않습니다.

상세 문서: [설계](https://github.com/roster-framework/roster-docs/blob/main/roster-contracts/design.md) · [공개 표면](https://github.com/roster-framework/roster-docs/blob/main/roster-contracts/api.md) · [TODO](https://github.com/roster-framework/roster-docs/blob/main/roster-contracts/todo.md). 소스 라이선스는 Apache-2.0이며 npm registry 출하는 아직 준비 중입니다.
