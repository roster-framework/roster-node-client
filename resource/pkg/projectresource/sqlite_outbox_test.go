package projectresource

import (
	"context"
	"database/sql"
	_ "modernc.org/sqlite"
	"path/filepath"
	"testing"
)

func TestOutboxReopensOriginalCommandAndDoesNotClearReplacement(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "outbox.db")
	db, e := sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	box, e := NewSQLiteOutbox(ctx, db)
	if e != nil {
		t.Fatal(e)
	}
	p, _ := viewFixture().Prepare([]Item{itemFixture()}, Head{})
	if e = box.Save(ctx, p.ID, *p); e != nil {
		t.Fatal(e)
	}
	db.Close()
	db, e = sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	box, e = NewSQLiteOutbox(ctx, db)
	if e != nil {
		t.Fatal(e)
	}
	restored, e := box.Load(ctx, p.ID)
	if e != nil || restored == nil || *restored != *p {
		t.Fatal("lost original command", e)
	}
	replacement := *p
	replacement.ChangeID = "new"
	if e = box.Save(ctx, p.ID, replacement); e == nil {
		t.Fatal("replaced unresolved command")
	}
	if e = box.Clear(ctx, p.ID, "wrong"); e != nil {
		t.Fatal(e)
	}
	restored, _ = box.Load(ctx, p.ID)
	if restored == nil {
		t.Fatal("cleared wrong command")
	}
	box.Clear(ctx, p.ID, p.ChangeID)
	if e = box.Save(ctx, p.ID, replacement); e != nil {
		t.Fatal(e)
	}
	box.Clear(ctx, p.ID, p.ChangeID)
	restored, _ = box.Load(ctx, p.ID)
	if restored == nil || restored.ChangeID != "new" {
		t.Fatal("late acknowledgement erased replacement")
	}
}
