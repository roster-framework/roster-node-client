package projectresource

import (
	"strings"
	"testing"
)

func viewFixture() View {
	return View{ID: "design-view", Collection: "design", Name: "Design backlog", Provider: "example", Project: "project", Selector: Selector{AllLabels: []string{"design"}, ExcludeLabels: []string{"blocked"}, States: []string{"open"}}}
}
func itemFixture() Item {
	return Item{ID: "1", Revision: "one", Title: "Design", Body: "Brief", Labels: []string{"design", "mobile"}, State: "open"}
}
func TestViewFiltersAndDoesNotExposeUnmatchedBodies(t *testing.T) {
	v := viewFixture()
	item := itemFixture()
	hidden := item
	hidden.ID = "private"
	hidden.Labels = []string{"backend"}
	hidden.Body = "DO_NOT_EXPOSE"
	p, e := v.Prepare([]Item{hidden, item}, Head{})
	if e != nil || p == nil || strings.Contains(p.Body, hidden.Body) {
		t.Fatal("filter failed", e)
	}
	if item.Labels[0] != "design" {
		t.Fatal("mutated source")
	}
	hidden.Revision = "changed"
	p2, e := v.Prepare([]Item{item, hidden}, Head{1, p.SourceVersion})
	if e != nil || p2 != nil {
		t.Fatal("unmatched changes emitted", e)
	}
	item.Revision = "two"
	p2, e = v.Prepare([]Item{item}, Head{1, p.SourceVersion})
	if e != nil || p2 == nil || p2.ExpectedVersion != 1 {
		t.Fatal("matched update missing", e)
	}
}
func TestLabelRemovalPublishesEmptySnapshotAndReentryIsANewChange(t *testing.T) {
	v := viewFixture()
	i := itemFixture()
	p, _ := v.Prepare([]Item{i}, Head{})
	i.Labels = []string{"other"}
	removed, e := v.Prepare([]Item{i}, Head{1, p.SourceVersion})
	if e != nil || removed == nil || !strings.Contains(removed.Body, `"items":[]`) {
		t.Fatal("removal missing", e)
	}
	back, e := v.Prepare([]Item{itemFixture()}, Head{2, removed.SourceVersion})
	if e != nil || back == nil || back.ChangeID == p.ChangeID {
		t.Fatal("reentry reused old receipt", e)
	}
}
func TestInvalidAndDuplicateInputFailClosed(t *testing.T) {
	v := viewFixture()
	i := itemFixture()
	if _, e := v.Prepare([]Item{i, i}, Head{}); e == nil {
		t.Fatal("duplicate accepted")
	}
	i.URL = "https://user:secret@example.com/x"
	if _, e := v.Prepare([]Item{i}, Head{}); e == nil {
		t.Fatal("credential URL accepted")
	}
	v.Selector.AnyLabels = []string{"a", "a"}
	if _, e := v.Prepare(nil, Head{}); e == nil {
		t.Fatal("invalid selector accepted")
	}
}
