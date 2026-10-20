package resource

import (
	"errors"
	"strings"
	"time"
)

const MaxHistoryVersion = 9007199254740991

var ErrHistoryQuery = errors.New("invalid resource history query")
var ErrHistoryRead = errors.New("Resource history unavailable")

type HistoryQuery struct {
	Limit int
	After int
}

func (q HistoryQuery) Normalize() (HistoryQuery, error) {
	if q.Limit == 0 {
		q.Limit = 20
	}
	if q.Limit < 1 || q.Limit > 100 || q.After < 0 || q.After > MaxHistoryVersion {
		return q, ErrHistoryQuery
	}
	return q, nil
}

type VersionSummary struct {
	Version int    `json:"version"`
	Title   string `json:"title"`
	Updated string `json:"updated"`
}

func (v VersionSummary) Validate() error {
	if v.Version < 1 || v.Version > MaxHistoryVersion || strings.TrimSpace(v.Title) == "" || len(v.Title) > 200 {
		return ErrHistoryRead
	}
	if _, err := time.Parse(time.RFC3339Nano, v.Updated); err != nil {
		return ErrHistoryRead
	}
	return nil
}

type HistoryPage struct {
	ResourceID string           `json:"resource_id"`
	Items      []VersionSummary `json:"items"`
	NextAfter  int              `json:"next_after,omitempty"`
}

func (p HistoryPage) Validate(id string, q HistoryQuery) error {
	q, err := q.Normalize()
	if err != nil {
		return err
	}
	if !identifier.MatchString(id) || p.ResourceID != id || p.Items == nil || len(p.Items) > q.Limit {
		return ErrHistoryRead
	}
	last := q.After
	for _, v := range p.Items {
		if v.Validate() != nil || v.Version <= last {
			return ErrHistoryRead
		}
		last = v.Version
	}
	if p.NextAfter != 0 && (len(p.Items) != q.Limit || p.NextAfter != last) {
		return ErrHistoryRead
	}
	return nil
}
