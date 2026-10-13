# Contributing / 기여하기

Roster Node Client hosts declared operations for the central Core. This repository contains the Node runtime, the resource server, and shared contracts; a Python client is planned. Each provider owns its execution, credentials, and business rules.

Roster Node Client는 중앙 Core가 호출할 수 있는 operation을 제공합니다. 이 저장소에는 Node 런타임, 리소스 서버, 공유 계약이 있고 Python client는 계획 중입니다. 각 공급자는 자신의 실행·자격·업무 규칙을 소유합니다.

## Design principles / 설계 원칙

- Declare Node and operation schemas explicitly. Do not make Core branch on agent, human, resource, or script types. Node와 operation 명세를 명시하고 Core에 agent·human·resource·script 종류 분기를 추가하지 않습니다.
- Report acceptance, progress, waiting, and confirmed completion with evidence. A disconnected caller cannot infer failure. 접수·진행·대기·확정 종료를 근거와 함께 보고하며 연결 단절만으로 실패를 추정하지 않습니다.
- Keep stable receipts for inspection and treat abort acknowledgements as intent, not terminal proof. 조회 가능한 안정 receipt를 유지하고 취소 ACK를 종료 증거로 취급하지 않습니다.
- Package manifests describe operations. The declarative importer does not execute package code or grant Core authority; the operator installs with `--ignore-scripts`, and provider loading has a separate trust decision. 패키지 manifest는 operation을 선언합니다. 선언 importer는 패키지 코드를 실행하거나 Core 권한을 부여하지 않습니다. 운영자는 `--ignore-scripts`로 설치하고 공급자 로딩은 별도 신뢰 판단을 거칩니다.

## Issues and pull requests / 이슈와 PR

Search existing issues first. Include the affected component, Node/operation contract, observed and expected behavior, and a minimal safe reproduction. Never include credentials, personal paths, or private payloads. 기존 이슈를 먼저 검색하고 관련 구성요소와 Node/operation 계약, 관측·기대 동작, 안전한 최소 재현 방법을 적어 주세요. 자격 정보·개인 경로·비공개 payload는 넣지 않습니다.

In a PR, explain the contract change and compatibility impact, provider-side error and cancellation behavior, and the Docker module checks you ran. Keep unrelated migrations separate. PR에는 계약 변경과 호환성 영향, 공급자 오류·취소 처리, 실행한 Docker 모듈 검증을 적고 무관한 이전 작업은 분리해 주세요.

Design, API, state diagrams, and open tasks live in [roster-docs](https://github.com/roster-framework/roster-docs). Usage and local setup are in this repository's [README](README.md). 설계·API·상태 다이어그램·TODO는 별도 문서 저장소에, 사용법과 로컬 실행은 이 저장소 README에 둡니다.
