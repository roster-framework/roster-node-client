package httpcomponent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strings"
	"testing"
)

func TestHTTPComponentPrivateCredentialProtocolAndFailureBoundaries(t *testing.T) {
	calls := 0
	status := 200
	protocol := "logs/1"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer private-component-token" || r.Header.Get("X-Roster-Service-Protocol") != "logs/1" {
			t.Error("missing private provider context")
		}
		w.Header().Set("X-Roster-Service-Protocol", protocol)
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"records": []string{"stored"}})
	}))
	defer server.Close()
	f := Factory{Credentials: func(name string) string {
		if name != "LOG_READ_TOKEN" {
			t.Fatal(name)
		}
		return "private-component-token"
	}}
	d := resource.Definition{ID: "logs", Component: "http", Endpoint: server.URL, CredentialEnv: "LOG_READ_TOKEN", Protocol: "logs/1", Audience: "service", Operations: []string{"query"}}
	if _, e := f.Invoke(context.Background(), d, resource.Operation{Name: "query"}); e != nil {
		t.Fatal(e)
	}
	if _, e := f.Invoke(context.Background(), d, resource.Operation{Name: "write"}); e == nil || calls != 1 {
		t.Fatal("undeclared operation reached provider", e)
	}
	status = 409
	if _, e := f.Invoke(context.Background(), d, resource.Operation{Name: "query"}); e != resource.ErrConflict {
		t.Fatal("provider CAS conflict hidden", e)
	}
	status = 200
	protocol = "wrong/1"
	if _, e := f.Invoke(context.Background(), d, resource.Operation{Name: "query"}); e == nil {
		t.Fatal("wrong contract accepted")
	}
	metadata := d.Metadata()
	raw, _ := json.Marshal(metadata)
	if strings.Contains(string(raw), "LOG_READ_TOKEN") || strings.Contains(string(raw), server.URL) {
		t.Fatal("provider configuration leaked")
	}
}
