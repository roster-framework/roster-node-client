package resource

import (
	"errors"
	"testing"
)

func TestHistoryInvariantsRejectUnsafePartialAndPrivateContractShapes(t *testing.T) {
	q, err := (HistoryQuery{}).Normalize()
	if err != nil || q.Limit != 20 {
		t.Fatal(q, err)
	}
	for _, bad := range []HistoryQuery{{Limit: -1}, {Limit: 101}, {After: -1}, {After: MaxHistoryVersion + 1}} {
		if _, err := bad.Normalize(); !errors.Is(err, ErrHistoryQuery) {
			t.Fatal("invalid query accepted")
		}
	}
	item := VersionSummary{Version: 2, Title: "Brief", Updated: "2026-10-04T00:00:00Z"}
	page := HistoryPage{ResourceID: "brief", Items: []VersionSummary{item}, NextAfter: 2}
	if page.Validate("brief", HistoryQuery{Limit: 1, After: 1}) != nil {
		t.Fatal("valid continuation")
	}
	for _, bad := range []HistoryPage{
		{ResourceID: "other", Items: []VersionSummary{item}},
		{ResourceID: "brief", Items: nil},
		{ResourceID: "brief", Items: []VersionSummary{item, item}},
		{ResourceID: "brief", Items: []VersionSummary{item}, NextAfter: 3},
		{ResourceID: "brief", Items: []VersionSummary{{Version: 2, Title: "", Updated: item.Updated}}},
		{ResourceID: "brief", Items: []VersionSummary{{Version: 2, Title: "Brief", Updated: "private-invalid"}}},
	} {
		if bad.Validate("brief", HistoryQuery{Limit: 1, After: 1}) == nil {
			t.Fatal("invalid history accepted")
		}
	}
	if page.Validate("brief", HistoryQuery{After: 2}) == nil {
		t.Fatal("backwards cursor")
	}
}
