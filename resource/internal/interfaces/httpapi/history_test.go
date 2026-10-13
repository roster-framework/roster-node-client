package httpapi

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strings"
	"testing"
)

func TestHistoryHTTPPrivateServiceAuthorityBoundsUnsupportedAndFixedFailure(t *testing.T) {
	registry, err := sqlite.NewRegistry(filepath.Join(t.TempDir(), "catalog.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close()
	docs, err := sqlite.NewResources(filepath.Join(t.TempDir(), "documents.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer docs.Close()
	service := &application.Service{Registry: registry, Documents: docs, Now: func() string { return "2026-10-04T00:00:00Z" }}
	service.Register(context.Background(), resource.Definition{ID: "brief", Name: "Brief", Component: "document"})
	service.Register(context.Background(), resource.Definition{ID: "provider", Name: "Provider", Component: "mcp", Endpoint: "https://example.invalid/mcp", CredentialEnv: "PRIVATE"})
	_, err = service.Publish(context.Background(), resource.Publish{ID: "brief", Collection: "docs", SourceKind: "upload", Title: "First", Body: "private-original", ChangeID: "first"})
	if err != nil {
		t.Fatal(err)
	}
	handler := (API{Service: service, Token: strings.Repeat("s", 32), AdminToken: strings.Repeat("a", 32)}).Handler()
	request := func(path, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request("/v1/resources/brief/history", ""); w.Code != 401 {
		t.Fatal("anonymous read", w.Code)
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?after=-1", "?after=9007199254740992", "?limit=1&limit=2", "?body=private"} {
		if w := request("/v1/resources/brief/history"+query, strings.Repeat("s", 32)); w.Code != 400 {
			t.Fatal(query, w.Code)
		}
	}
	w := request("/v1/resources/brief/history", strings.Repeat("s", 32))
	if w.Code != 200 || strings.Contains(w.Body.String(), "private") {
		t.Fatal("history privacy", w.Code)
	}
	if w := request("/v1/resources/provider/history", strings.Repeat("s", 32)); w.Code != 422 {
		t.Fatal("unsupported", w.Code)
	}
	docs.Close()
	w = request("/v1/resources/brief/history", strings.Repeat("s", 32))
	if w.Code != 503 || w.Body.String() != "{\"error\":\"Service Unavailable\"}\n" {
		t.Fatal("storage failure classification", w.Code)
	}
}
