package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"strings"
	"testing"
)

func TestLibrarySubscriptionDeclarationSurvivesRegistrationAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "catalog.db")
	registry, err := sqlite.NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("x", 32)
	api := (API{Service: &application.Service{Registry: registry}, Token: token, AdminToken: strings.Repeat("y", 32)}).Handler()
	body := `{"id":"source","name":"Source","component":"http","endpoint":"https://private-provider.example/","credential_env":"PRIVATE_PROVIDER_TOKEN","protocol":"custom/1","operations":["configure","options"],"subscription_extensions":[{"protocol":"roster-resource-subscription-extension/1","id":"custom","revision":"` + strings.Repeat("a", 64) + `","configuration_schema":{"properties":{"arbitrary_option":{"type":"string"}}},"configure_operation":{"name":"configure"},"options_operation":{"name":"options"},"events":["changed"]}],"version":0}`
	r := httptest.NewRequest("POST", "/v1/resources", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+strings.Repeat("y", 32))
	w := httptest.NewRecorder()
	api.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("registration", w.Code, w.Body.String())
	}
	registry.Close()
	registry, err = sqlite.NewRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close()
	api = (API{Service: &application.Service{Registry: registry}, Token: token, AdminToken: strings.Repeat("y", 32)}).Handler()
	r = httptest.NewRequest("GET", "/v1/resources/source", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w = httptest.NewRecorder()
	api.ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "arbitrary_option") || strings.Contains(w.Body.String(), "private-provider") || strings.Contains(w.Body.String(), "PRIVATE_PROVIDER_TOKEN") {
		t.Fatal("lost or leaked declaration", w.Code, w.Body.String())
	}
	var metadata map[string]json.RawMessage
	if json.Unmarshal(w.Body.Bytes(), &metadata) != nil || len(metadata["subscription_extensions"]) == 0 {
		t.Fatal("missing native metadata extension")
	}
}
