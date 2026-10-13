package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/components"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/documentcomponent"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strings"
	"testing"
)

func TestDocumentInvokeUsesNativeHistoryReplayCASAndACKAcrossRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	token := strings.Repeat("s", 32)
	admin := strings.Repeat("a", 32)
	var registry *sqlite.Registry
	var docs *sqlite.ResourceCatalog
	var handler http.Handler
	open := func() {
		var err error
		registry, err = sqlite.NewRegistry(filepath.Join(dir, "catalog.db"))
		if err != nil {
			t.Fatal(err)
		}
		docs, err = sqlite.NewResources(filepath.Join(dir, "documents.db"))
		if err != nil {
			t.Fatal(err)
		}
		service := &application.Service{Registry: registry, Documents: docs, Now: func() string { return "2026-10-05T00:00:00Z" }}
		service.Components = components.Factory{"document": documentcomponent.Factory{Documents: service}}
		handler = (API{Service: service, Token: token, AdminToken: admin}).Handler()
	}
	open()
	defer func() { registry.Close(); docs.Close() }()
	request := func(method, path, credential string, input any, status int) *httptest.ResponseRecorder {
		t.Helper()
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
		if credential != "" {
			r.Header.Set("Authorization", "Bearer "+credential)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: status %d expected %d", method, path, w.Code, status)
		}
		if status != 200 && (strings.Contains(w.Body.String(), "content") || strings.Contains(w.Body.String(), "PRIVATE")) {
			t.Fatal("error exposed original or provider input")
		}
		return w
	}
	definition := resource.Definition{ID: "original", Name: "Original", Component: "document"}
	request("POST", "/v1/resources", token, definition, 401)
	registered := request("POST", "/v1/resources", admin, definition, 200)
	var metadata resource.Metadata
	if err := json.Unmarshal(registered.Body.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.Version != 1 || !reflect.DeepEqual(metadata.Operations, []string{"read", "publish"}) {
		t.Fatal("definition contract changed")
	}
	path := "/v1/resources/original/invoke"
	request("POST", path, "", resource.Operation{Name: "read"}, 401)
	request("POST", path, token, resource.Operation{Name: "read"}, 404)
	request("POST", "/v1/resources/unknown/invoke", token, resource.Operation{Name: "read"}, 404)
	v1 := 1
	args := map[string]any{"collection": "docs", "source_kind": "upload", "title": "First", "body": "content-first", "change_id": "first", "expected_version": 0}
	op := resource.Operation{Name: "publish", ExpectedVersion: &v1, Arguments: args}
	firstResponse := request("POST", path, token, op, 200)
	var first resource.Document
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil || first.ID != "original" || first.Version != 1 {
		t.Fatal("wrong original result", err)
	}
	if replay := request("POST", path, token, op, 200); replay.Body.String() != firstResponse.Body.String() {
		t.Fatal("generic replay changed native original")
	}
	native := request("GET", "/v1/resources/original/document?version=1", token, nil, 200)
	if native.Body.String() != firstResponse.Body.String() {
		t.Fatal("generic publish used another store")
	}
	changes, err := docs.PendingChanges(ctx, "core-a", 100)
	if err != nil || len(changes) != 1 {
		t.Fatal("original/journal not atomic", err)
	}
	if err = docs.ConfirmChange(ctx, "core-a", changes[0].ID); err != nil {
		t.Fatal(err)
	}
	args["body"] = "changed-content"
	request("POST", path, token, op, 409)
	args["change_id"] = "stale-new"
	request("POST", path, token, op, 409)
	args["expected_version"] = 1
	args["body"] = "content-second"
	args["change_id"] = "second"
	v2 := 2
	op.ExpectedVersion = &v2
	request("POST", path, token, op, 409) // Registered definition is still 1; original is independently 1.
	op.ExpectedVersion = &v1
	secondResponse := request("POST", path, token, op, 200)
	request("POST", path, token, resource.Operation{Name: "read", Arguments: map[string]any{"version": 1}}, 200)
	if latest := request("POST", path, token, resource.Operation{Name: "read"}, 200); latest.Body.String() != secondResponse.Body.String() {
		t.Fatal("latest generic read differs")
	}
	for _, invalid := range []resource.Operation{
		{Name: "read", Tool: "other"}, {Name: "read", Arguments: map[string]any{"id": "other"}},
		{Name: "publish", Arguments: map[string]any{"expected_version": 1}},
		{Name: "publish", Arguments: map[string]any{"id": "other", "credential_env": "PRIVATE"}},
		{Name: "read", Arguments: map[string]any{"version": -1}},
	} {
		request("POST", path, token, invalid, 422)
	}
	a, err := docs.PendingChanges(ctx, "core-a", 100)
	if err != nil || len(a) != 1 || a[0].Version != 2 {
		t.Fatal("ACK changed", err)
	}
	b, err := docs.PendingChanges(ctx, "core-b", 100)
	if err != nil || len(b) != 2 {
		t.Fatal("consumer isolation changed", err)
	}
	if err = docs.Close(); err != nil {
		t.Fatal(err)
	}
	if err = registry.Close(); err != nil {
		t.Fatal(err)
	}
	open()
	if old := request("POST", path, token, resource.Operation{Name: "read", Arguments: map[string]any{"version": 1}}, 200); old.Body.String() != firstResponse.Body.String() {
		t.Fatal("old original changed after restart")
	}
	if latest := request("POST", path, token, resource.Operation{Name: "read"}, 200); latest.Body.String() != secondResponse.Body.String() {
		t.Fatal("latest original changed after restart")
	}
	args["body"] = "content-first"
	args["title"] = "First"
	args["expected_version"] = 0
	args["change_id"] = "first"
	if replay := request("POST", path, token, op, 200); replay.Body.String() != firstResponse.Body.String() {
		t.Fatal("replay changed after restart")
	}
	afterA, err := docs.PendingChanges(ctx, "core-a", 100)
	if err != nil || !reflect.DeepEqual(afterA, a) {
		t.Fatal("ACK lost after restart", err)
	}
	afterB, err := docs.PendingChanges(ctx, "core-b", 100)
	if err != nil || !reflect.DeepEqual(afterB, b) {
		t.Fatal("journal lost after restart", err)
	}
	history, err := docs.History(ctx, "original", resource.HistoryQuery{Limit: 100})
	if err != nil || len(history.Items) != 2 {
		t.Fatal("immutable history changed", err)
	}
}
