package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"github.com/roster-framework/roster-node-client/resource/pkg/projectresource"
	"strings"
	"testing"
)

func TestProjectViewUsesOriginalDurableDocumentJournal(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	registry, e := sqlite.NewRegistry(filepath.Join(dir, "catalog.db"))
	if e != nil {
		t.Fatal(e)
	}
	docs, e := sqlite.NewResources(filepath.Join(dir, "documents.db"))
	if e != nil {
		t.Fatal(e)
	}
	service := application.Service{Registry: registry, Documents: docs, Now: func() string { return "2026-10-09T00:00:00Z" }}
	if _, e = service.Register(ctx, resource.Definition{ID: "design-view", Name: "Design", Component: "document"}); e != nil {
		t.Fatal(e)
	}
	view := projectresource.View{ID: "design-view", Collection: "design", Name: "Design", Provider: "fixture", Project: "demo", Selector: projectresource.Selector{AllLabels: []string{"design"}}}
	item := projectresource.Item{ID: "1", Revision: "1", Title: "Page", Body: "Create page", State: "open", Labels: []string{"design"}}
	command, e := view.Prepare([]projectresource.Item{item}, projectresource.Head{})
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(API{Service: &service, Token: strings.Repeat("x", 32), AdminToken: strings.Repeat("y", 32)}.Handler())
	defer server.Close()
	client, e := projectresource.NewClient(server.URL, strings.Repeat("x", 32))
	if e != nil {
		t.Fatal(e)
	}
	if head, e := client.Head(ctx, view.ID); e != nil || head.Version != 0 {
		t.Fatal("initial native head", e)
	}
	published, e := client.Publish(ctx, *command)
	if e != nil || published.Version != 1 {
		t.Fatal("native SDK publication", e)
	}
	raw, _ := json.Marshal(command)
	var publish resource.Publish
	if e = json.Unmarshal(raw, &publish); e != nil {
		t.Fatal(e)
	}
	first, e := service.Publish(ctx, publish)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := service.Publish(ctx, publish)
	if e != nil || replay.Version != first.Version {
		t.Fatal("retry duplicated version", e)
	}
	changes, e := service.Changes(ctx, "test-consumer", 10)
	if e != nil || len(changes) != 1 || changes[0].Collection != "design" {
		t.Fatal("journal mismatch", e)
	}
	unchanged, e := view.Prepare([]projectresource.Item{item}, projectresource.Head{Version: first.Version, SourceVersion: first.SourceVersion})
	if e != nil || unchanged != nil {
		t.Fatal("poll repeated change", e)
	}
}
