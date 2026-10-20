# Optional subscription library

This is an independently run author example. It is **not** a default Resource component or a required project/label model. Core and Resource forward the declared contract; this library owns label semantics, durable configuration, stream registration and collection changes.

`go run ./examples/subscription-library/cmd --declaration` prints its public extension declaration. Register an HTTP resource named `example-project`, protocol `example-project-library/1`, endpoint `http://127.0.0.1:7355/invoke`, operations `configure`, `options`, `sync`, credential environment name `EXAMPLE_LIBRARY_TOKEN`, and that declaration. Registration belongs to the Resource server.

Start with `go run ./examples/subscription-library/cmd`. Configure these private environment variables in the author process:

- `EXAMPLE_LIBRARY_DATA_DIR`: durable private storage directory.
- `EXAMPLE_LIBRARY_TOKEN`: at least 32 characters; incoming library authentication.
- `ROSTER_RESOURCE_URL`: HTTPS or loopback Resource origin.
- `ROSTER_RESOURCE_ADMIN_TOKEN`: stream registration credential, never passed to agents.
- `ROSTER_RESOURCE_TOKEN`: native publication credential.

It listens on loopback port 7355. In Docker, place it in the same network namespace as Resource or supply a separate authenticated HTTPS adapter. Do not expose plain HTTP/credentials on a public interface. The default launcher does not automatically start this example.

1. Bind `example-project` in Core, inspect `resources extensions ID` and submit `resources configure-extension FILE` using the returned revision and opaque configuration `{"label":"development"}`.
2. The library commits original intent before registration and returns a registered document stream. An identical request ID/intent returns the same stream/time/digest; a different intent conflicts. On registration failure no usable receipt is issued; retry the original request.
3. Bind the returned stream explicitly in Core, grant the recipient `resource.read`, and configure the Resource subscription. A library receipt grants no permissions.
4. The author's collector calls native operation `sync` with `{"request_id":"the-original-request","items":[...]}`. Items follow `pkg/projectresource.Item`. Supply a **complete** snapshot, not one polling page. Only selected content is published. Unchanged/excluded changes do not publish again.
5. A durable publication outbox keeps the exact command before sending. Response loss/restart retries that command and retains the Resource document journal's original change identity.

The database is private and SQLite FULL synchronous. Run one collector process per database; publication serialization across multiple independently running collector processes is not implemented. Configuration request uniqueness also uses SQLite conflict handling. This example does not provide provider OAuth, a provider poller or a public SLA.

The integration test runs real authenticated HTTP adapters and SQLite registries/documents, injects registration outage and publication response loss, restarts the library, checks concurrent receipt replay/changed-intent conflict, body exclusion, unchanged suppression and exactly two original document events. It does not call a model.
