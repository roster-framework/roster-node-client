package sqlite

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strings"
	"testing"
)

func TestHistoryPagesDoNotExposeOriginalsOrChangePublishAndAcknowledgements(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "documents.db")
	store, err := NewResources(path)
	if err != nil {
		t.Fatal(err)
	}
	p := resource.Publish{ID: "brief", Collection: "docs", SourceKind: "upload", SourceURI: "https://private.invalid/source", Title: "First", Body: "private-original", ChangeID: "one"}
	first, err := store.Publish(ctx, p, "2026-10-04T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	p.ExpectedVersion = 1
	p.ChangeID = "two"
	p.Title = "Second"
	p.Body = "private-second"
	if _, err = store.Publish(ctx, p, "2026-10-04T00:00:01Z"); err != nil {
		t.Fatal(err)
	}
	changes, _ := store.PendingChanges(ctx, "consumer", 50)
	store.ConfirmChange(ctx, "consumer", changes[0].ID)
	page, err := store.History(ctx, "brief", resource.HistoryQuery{Limit: 1})
	raw, _ := json.Marshal(page)
	if err != nil || len(page.Items) != 1 || page.NextAfter != 1 || page.Items[0].Title != "First" || strings.Contains(string(raw), "private") {
		t.Fatal("history/privacy", page, err)
	}
	if old, err := store.Get(ctx, "brief", 1); err != nil || old != first {
		t.Fatal("original changed", err)
	}
	pending, _ := store.PendingChanges(ctx, "consumer", 50)
	if len(pending) != 1 || pending[0] != changes[1] {
		t.Fatal("history changed ACK")
	}
	store.Close()
	store, err = NewResources(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tail, err := store.History(ctx, "brief", resource.HistoryQuery{Limit: 1, After: page.NextAfter})
	if err != nil || len(tail.Items) != 1 || tail.Items[0].Version != 2 || tail.NextAfter != 0 {
		t.Fatal("restart continuation", tail, err)
	}
	empty, err := store.History(ctx, "brief", resource.HistoryQuery{After: 2})
	if err != nil || len(empty.Items) != 0 || empty.Items == nil {
		t.Fatal("known exhausted resource", err)
	}
	if _, err = store.History(ctx, "missing", resource.HistoryQuery{}); !errors.Is(err, resource.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err = store.History(ctx, "brief", resource.HistoryQuery{After: resource.MaxHistoryVersion + 1}); !errors.Is(err, resource.ErrHistoryQuery) {
		t.Fatal(err)
	}
	if _, err = store.db.Exec(`UPDATE resource_versions SET body=json_set(body,'$.id','wrong') WHERE version=2`); err != nil {
		t.Fatal(err)
	}
	broken, err := store.History(ctx, "brief", resource.HistoryQuery{Limit: 1})
	if !errors.Is(err, resource.ErrHistoryRead) || len(broken.Items) != 0 {
		t.Fatal("corrupt lookahead returned partial page", err)
	}
	if _, err = store.History(ctx, "brief", resource.HistoryQuery{After: 2}); !errors.Is(err, resource.ErrHistoryRead) {
		t.Fatal("corrupt head became empty success", err)
	}
}
