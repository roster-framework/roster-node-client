package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

type ResourceCatalog struct{ db *sql.DB }

func NewResources(path string) (*ResourceCatalog, error) {
	db, err := open(path)
	if err != nil {
		return nil, err
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS resource_versions(id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE TABLE IF NOT EXISTS resource_heads(id TEXT PRIMARY KEY,version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS resource_changes(id TEXT PRIMARY KEY,request TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resource_acks(consumer TEXT NOT NULL,change_id TEXT NOT NULL,PRIMARY KEY(consumer,change_id));`)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &ResourceCatalog{db}, nil
}

func (r *ResourceCatalog) Publish(ctx context.Context, p resource.Publish, at string) (resource.Document, error) {
	if err := p.Validate(); err != nil {
		return resource.Document{}, err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return resource.Document{}, err
	}
	defer tx.Rollback()
	key := resource.ChangeKey(p.ID, p.ChangeID)
	request, _ := json.Marshal(p)
	var oldRequest, changeJSON string
	err = tx.QueryRowContext(ctx, "SELECT request,body FROM resource_changes WHERE id=?", key).Scan(&oldRequest, &changeJSON)
	if err == nil {
		if string(request) != oldRequest {
			return resource.Document{}, resource.ErrConflict
		}
		var change resource.Change
		if err = json.Unmarshal([]byte(changeJSON), &change); err != nil {
			return resource.Document{}, err
		}
		var raw string
		var doc resource.Document
		err = tx.QueryRowContext(ctx, "SELECT body FROM resource_versions WHERE id=? AND version=?", p.ID, change.Version).Scan(&raw)
		if err == nil {
			err = json.Unmarshal([]byte(raw), &doc)
		}
		return doc, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return resource.Document{}, err
	}
	var raw string
	var previous resource.Document
	err = tx.QueryRowContext(ctx, "SELECT v.body FROM resource_heads h JOIN resource_versions v ON h.id=v.id AND h.version=v.version WHERE h.id=?", p.ID).Scan(&raw)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &previous)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return resource.Document{}, err
	}
	if previous.Version != p.ExpectedVersion || previous.Version > 0 && (previous.Collection != p.Collection) {
		return resource.Document{}, resource.ErrConflict
	}
	doc, err := previous.Next(p, at)
	if err != nil {
		return doc, err
	}
	body, _ := json.Marshal(doc)
	if _, err = tx.ExecContext(ctx, "INSERT INTO resource_versions VALUES(?,?,?)", doc.ID, doc.Version, string(body)); err != nil {
		return doc, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO resource_heads VALUES(?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version", doc.ID, doc.Version); err != nil {
		return doc, err
	}
	change, _ := json.Marshal(doc.Changed(p.ChangeID))
	if _, err = tx.ExecContext(ctx, "INSERT INTO resource_changes(id,request,body) VALUES(?,?,?)", key, string(request), string(change)); err != nil {
		return doc, err
	}
	return doc, tx.Commit()
}

func (r *ResourceCatalog) Get(ctx context.Context, id string, version int) (resource.Document, error) {
	var raw string
	var doc resource.Document
	query := "SELECT body FROM resource_versions WHERE id=? AND version=?"
	args := []any{id, version}
	if version == 0 {
		query = "SELECT v.body FROM resource_heads h JOIN resource_versions v ON h.id=v.id AND h.version=v.version WHERE h.id=?"
		args = []any{id}
	}
	err := r.db.QueryRowContext(ctx, query, args...).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return doc, resource.ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &doc)
	}
	return doc, err
}

func (r *ResourceCatalog) List(ctx context.Context) ([]resource.Document, error) {
	rows, err := r.db.QueryContext(ctx, "SELECT v.body FROM resource_heads h JOIN resource_versions v ON h.id=v.id AND h.version=v.version ORDER BY h.rowid DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []resource.Document{}
	for rows.Next() {
		var raw string
		var doc resource.Document
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &doc); err != nil {
			return nil, err
		}
		result = append(result, doc)
	}
	return result, rows.Err()
}

func (r *ResourceCatalog) PendingChanges(ctx context.Context, consumer string, limit int) ([]resource.Change, error) {
	rows, err := r.db.QueryContext(ctx, "SELECT body FROM resource_changes c WHERE NOT EXISTS(SELECT 1 FROM resource_acks a WHERE a.consumer=? AND a.change_id=c.id) ORDER BY c.rowid LIMIT ?", consumer, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []resource.Change{}
	for rows.Next() {
		var raw string
		var change resource.Change
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &change); err != nil {
			return nil, err
		}
		result = append(result, change)
	}
	return result, rows.Err()
}

func (r *ResourceCatalog) ConfirmChange(ctx context.Context, consumer, id string) error {
	_, err := r.db.ExecContext(ctx, "INSERT OR IGNORE INTO resource_acks(consumer,change_id) SELECT ?,id FROM resource_changes WHERE id=?", consumer, id)
	return err
}
func (r *ResourceCatalog) Close() error { return r.db.Close() }
