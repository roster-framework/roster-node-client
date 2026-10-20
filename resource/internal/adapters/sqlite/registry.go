package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

type Registry struct{ db *sql.DB }

func NewRegistry(path string) (*Registry, error) {
	db, err := open(path)
	if err != nil {
		return nil, err
	}
	if _, err = db.Exec("CREATE TABLE IF NOT EXISTS definitions(id TEXT PRIMARY KEY,body TEXT NOT NULL)"); err != nil {
		db.Close()
		return nil, err
	}
	return &Registry{db}, nil
}
func (r *Registry) Register(ctx context.Context, in resource.Definition) (resource.Definition, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return resource.Definition{}, err
	}
	defer tx.Rollback()
	var raw string
	var old resource.Definition
	err = tx.QueryRowContext(ctx, "SELECT body FROM definitions WHERE id=?", in.ID).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return old, err
	}
	if err == nil {
		if err = json.Unmarshal([]byte(raw), &old); err != nil {
			return old, err
		}
	}
	next, err := old.Next(in)
	if err != nil {
		return next, err
	}
	body, err := json.Marshal(next)
	if err != nil {
		return next, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO definitions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body", next.ID, string(body)); err != nil {
		return next, err
	}
	return next, tx.Commit()
}
func (r *Registry) Definition(ctx context.Context, id string) (resource.Definition, error) {
	var d resource.Definition
	var raw string
	err := r.db.QueryRowContext(ctx, "SELECT body FROM definitions WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return d, resource.ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &d)
	}
	return d, err
}
func (r *Registry) Definitions(ctx context.Context) ([]resource.Definition, error) {
	rows, err := r.db.QueryContext(ctx, "SELECT body FROM definitions ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []resource.Definition{}
	for rows.Next() {
		var raw string
		var d resource.Definition
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &d); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
func (r *Registry) Close() error { return r.db.Close() }
