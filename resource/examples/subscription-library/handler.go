package subscriptionlibrary

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/roster-framework/roster-node-client/resource/pkg/projectresource"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
)

const ServiceProtocol = "example-project-library/1"

// Handler is a native HTTP adapter. An author can instead expose the same
// Configure/Sync use cases through MCP without changing the library model.
func (l *Library) Handler(token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Roster-Service-Protocol", ServiceProtocol)
		reply := func(status int, value any) { w.WriteHeader(status); _ = json.NewEncoder(w).Encode(value) }
		credential := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(token) < 32 || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(token), []byte(credential)) != 1 {
			reply(401, map[string]string{"error": "unauthorized"})
			return
		}
		if r.Method != "POST" || r.URL.Path != "/invoke" || r.Header.Get("X-Roster-Service-Protocol") != ServiceProtocol {
			reply(400, map[string]string{"error": "invalid library request"})
			return
		}
		var op struct {
			ExpectedVersion *int            `json:"expected_version,omitempty"`
			Name            string          `json:"name"`
			Tool            string          `json:"tool,omitempty"`
			Arguments       json.RawMessage `json:"arguments,omitempty"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 300000))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&op) != nil || decoder.Decode(new(any)) != io.EOF || op.Tool != "" || op.ExpectedVersion != nil && *op.ExpectedVersion != 1 {
			reply(400, map[string]string{"error": "invalid library operation"})
			return
		}
		var value any
		var err error
		switch op.Name {
		case "options":
			// These values are author policy, not Core-discovered mandatory roles.
			value = map[string]any{"labels": []string{"design", "development", "qa"}}
		case "configure":
			var command subscriptioncontract.Command
			if json.Unmarshal(op.Arguments, &command) != nil {
				err = errors.New("invalid configuration")
			} else {
				value, err = l.Configure(r.Context(), command)
			}
		case "sync":
			var command struct {
				RequestID string                 `json:"request_id"`
				Items     []projectresource.Item `json:"items"`
			}
			if json.Unmarshal(op.Arguments, &command) != nil || len(command.Items) > 1000 {
				err = errors.New("invalid snapshot")
			} else {
				var changed bool
				changed, err = l.Sync(r.Context(), command.RequestID, command.Items)
				value = map[string]bool{"changed": changed}
			}
		default:
			reply(422, map[string]string{"error": "unsupported operation"})
			return
		}
		if err != nil {
			status := 400
			if errors.Is(err, ErrConflict) {
				status = 409
			}
			// Provider/native responses and credentials are not reflected.
			reply(status, map[string]string{"error": "library operation failed"})
			return
		}
		reply(200, value)
	})
}
