package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"strings"
	"testing"
)

func TestAPIRegistrationAuthorityAndRedactedCatalog(t *testing.T) {
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
	api := (API{Service: &application.Service{Registry: registry, Documents: docs}, Token: strings.Repeat("s", 32), AdminToken: strings.Repeat("a", 32)}).Handler()
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		api.ServeHTTP(w, r)
		return w
	}
	definition := `{"id":"figma","name":"Figma","component":"mcp","endpoint":"https://example.com/mcp","credential_env":"PROVIDER_SECRET","version":0}`
	if w := request("POST", "/v1/resources", strings.Repeat("s", 32), definition); w.Code != 401 {
		t.Fatalf("service registered provider %d", w.Code)
	}
	if w := request("POST", "/v1/resources", strings.Repeat("a", 32), definition); w.Code != 200 {
		t.Fatalf("admin registration %d %s", w.Code, w.Body.String())
	}
	if w := request("GET", "/v1/resources", "", ""); w.Code != 401 {
		t.Fatalf("anonymous catalog %d", w.Code)
	}
	w := request("GET", "/v1/resources", strings.Repeat("s", 32), "")
	if strings.Contains(w.Body.String(), "example.com") || strings.Contains(w.Body.String(), "PROVIDER_SECRET") {
		t.Fatal("provider configuration leaked")
	}
	var list []map[string]any
	if err = json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list) != 1 {
		t.Fatalf("metadata %s %v", w.Body.String(), err)
	}
	if w = request("POST", "/v1/resources/unknown/publish", strings.Repeat("s", 32), `{"id":"unknown"}`); w.Code != 404 {
		t.Fatalf("unregistered resource publish %d", w.Code)
	}
	defs, err := registry.Definitions(context.Background())
	if err != nil || len(defs) != 1 {
		t.Fatal("unauthorized registration persisted")
	}
	if w = request("POST", "/v1/resources", strings.Repeat("a", 32), definition+` {}`); w.Code != 400 {
		t.Fatal("trailing JSON accepted")
	}
	_ = http.StatusOK
}
