# Roster Resource Go

Provider-neutral 독립 리소스 서버입니다. 등록 정의·provider 연결과 document 원본/버전/변경 저널을 소유합니다. 조직/IAM/업무 흐름은 외부 조정자의 책임입니다. document/mcp/http/webhook 어댑터와 선택형 subscription library 계약을 제공합니다.

ROSTER_RESOURCE_TOKEN과 ROSTER_RESOURCE_ADMIN_TOKEN에 서로 다른 32자 이상 자격을 설정한 뒤 실행합니다.

```sh
go run ./cmd/roster-resource-server
```

기본 주소는 loopback 7340입니다. 원격 listener에는 ROSTER_TLS_CERT/ROSTER_TLS_KEY가 필요합니다. provider URL·자격은 서버 내부 설정에 보관하고 공개 metadata나 에이전트에 전달하지 않습니다.

`node scripts/resource.mjs`의 register/publish/invoke/history/configure-subscription 명령은 같은 native API를 사용합니다. 요청 예시는 [독립 subscription library](examples/subscription-library/README.md)를 참고합니다. 이 예제와 `pkg/projectresource`는 선택 라이브러리이며 실제 provider poller·Core 권한·후속 업무 완료를 자동 구현하지 않습니다.

Go 검증은 Linux Docker의 `go test ./...`, `go vet ./...`와 기존 Node CLI tests를 사용합니다. 원본 문서와 provider 연결 데이터는 테스트용 데이터와 분리합니다.

상세 문서: [설계](https://github.com/roster-framework/roster-docs/blob/main/roster-resource-go/design.md) · [API](https://github.com/roster-framework/roster-docs/blob/main/roster-resource-go/api.md) · [TODO](https://github.com/roster-framework/roster-docs/blob/main/roster-resource-go/todo.md). 옛 Core IAM 통합을 새 작은 Core의 기능으로 가정하지 않습니다.
