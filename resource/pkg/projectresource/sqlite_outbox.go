package projectresource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

// SQLiteOutbox stores exact commands in a caller-owned private SQLite database.
type SQLiteOutbox struct{ db *sql.DB }

func NewSQLiteOutbox(ctx context.Context, db *sql.DB) (*SQLiteOutbox, error) {
	if db == nil {
		return nil, errors.New("outbox database required")
	}
	_, e := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS project_resource_outbox(view_id TEXT PRIMARY KEY,change_id TEXT NOT NULL,command TEXT NOT NULL)`)
	if e != nil {
		return nil, e
	}
	return &SQLiteOutbox{db}, nil
}
func (s *SQLiteOutbox) Load(ctx context.Context, id string) (*Publication, error) {
	var raw string
	e := s.db.QueryRowContext(ctx, `SELECT command FROM project_resource_outbox WHERE view_id=?`, id).Scan(&raw)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var p Publication
	if json.Unmarshal([]byte(raw), &p) != nil || p.ID != id {
		return nil, errors.New("invalid pending publication")
	}
	return &p, nil
}
func (s *SQLiteOutbox) Save(ctx context.Context, id string, p Publication) error {
	if p.ID != id || p.ChangeID == "" {
		return errors.New("pending publication identity differs")
	}
	raw, e := json.Marshal(p)
	if e != nil {
		return e
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if _, e = tx.ExecContext(ctx, `INSERT INTO project_resource_outbox(view_id,change_id,command) VALUES(?,?,?) ON CONFLICT(view_id) DO NOTHING`, id, p.ChangeID, string(raw)); e != nil {
		return e
	}
	var original string
	if e = tx.QueryRowContext(ctx, `SELECT command FROM project_resource_outbox WHERE view_id=?`, id).Scan(&original); e != nil {
		return e
	}
	if original != string(raw) {
		return errors.New("another publication is still pending")
	}
	return tx.Commit()
}
func (s *SQLiteOutbox) Clear(ctx context.Context, id, changeID string) error {
	_, e := s.db.ExecContext(ctx, `DELETE FROM project_resource_outbox WHERE view_id=? AND change_id=?`, id, changeID)
	return e
}
