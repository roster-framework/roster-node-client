package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

func (r *ResourceCatalog) History(ctx context.Context, id string, q resource.HistoryQuery) (resource.HistoryPage, error) {
	q, err := q.Normalize()
	if err != nil {
		return resource.HistoryPage{}, err
	}
	page := resource.HistoryPage{ResourceID: id, Items: []resource.VersionSummary{}}
	// Verify existence and project metadata in the same read transaction. No original
	// bodies are decoded or exposed and publication/consumer ACKs remain unchanged.
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return resource.HistoryPage{}, resource.ErrHistoryRead
	}
	defer tx.Rollback()
	var head int
	var headID string
	var storedHead resource.VersionSummary
	err = tx.QueryRowContext(ctx, `SELECT h.version,json_extract(v.body,'$.id'),json_extract(v.body,'$.version'),json_extract(v.body,'$.title'),json_extract(v.body,'$.updated') FROM resource_heads h LEFT JOIN resource_versions v ON h.id=v.id AND h.version=v.version WHERE h.id=?`, id).Scan(&head, &headID, &storedHead.Version, &storedHead.Title, &storedHead.Updated)
	if errors.Is(err, sql.ErrNoRows) {
		return resource.HistoryPage{}, resource.ErrNotFound
	}
	if err != nil || head < 1 || head > resource.MaxHistoryVersion || headID != id || storedHead.Version != head || storedHead.Validate() != nil {
		return resource.HistoryPage{}, resource.ErrHistoryRead
	}
	rows, err := tx.QueryContext(ctx, `SELECT version,json_extract(body,'$.id'),json_extract(body,'$.version'),json_extract(body,'$.title'),json_extract(body,'$.updated') FROM resource_versions WHERE id=? AND version>? ORDER BY version LIMIT ?`, id, q.After, q.Limit+1)
	if err != nil {
		return resource.HistoryPage{}, resource.ErrHistoryRead
	}
	defer rows.Close()
	for rows.Next() {
		var v resource.VersionSummary
		var storedID string
		var storedVersion int
		if err = rows.Scan(&v.Version, &storedID, &storedVersion, &v.Title, &v.Updated); err != nil || storedID != id || storedVersion != v.Version || v.Version > head || v.Validate() != nil {
			return resource.HistoryPage{}, resource.ErrHistoryRead
		}
		if len(page.Items) == q.Limit {
			page.NextAfter = page.Items[len(page.Items)-1].Version
			break
		}
		page.Items = append(page.Items, v)
	}
	if rows.Err() != nil || page.Validate(id, q) != nil {
		return resource.HistoryPage{}, resource.ErrHistoryRead
	}
	return page, nil
}
