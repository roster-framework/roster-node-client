package projectresource

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNativeClientPreservesPublicationAndDoesNotFollowRedirects(t *testing.T) {
	calls := 0
	redirect := false
	var received Publication
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("x", 32) {
			t.Error("missing credential")
		}
		if redirect {
			w.Header().Set("Location", "/private")
			w.WriteHeader(307)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "GET" {
			w.WriteHeader(404)
			return
		}
		if e := json.NewDecoder(r.Body).Decode(&received); e != nil {
			t.Error(e)
		}
		json.NewEncoder(w).Encode(documentReceipt{received.ID, received.ExpectedVersion + 1, received.SourceVersion})
	}))
	defer server.Close()
	client, e := NewClient(server.URL, strings.Repeat("x", 32))
	if e != nil {
		t.Fatal(e)
	}
	head, e := client.Head(context.Background(), "design-view")
	if e != nil || head.Version != 0 {
		t.Fatal("initial head failed", e)
	}
	p, _ := viewFixture().Prepare([]Item{itemFixture()}, head)
	next, e := client.Publish(context.Background(), *p)
	if e != nil || next.Version != 1 || received.Body != p.Body {
		t.Fatal("publication failed", e)
	}
	redirect = true
	if _, e = client.Publish(context.Background(), *p); e == nil || calls != 3 {
		t.Fatal("redirect followed", e)
	}
	for _, origin := range []string{"http://remote.example", "https://user:secret@example.com", "https://example.com/path"} {
		if _, e := NewClient(origin, strings.Repeat("x", 32)); e == nil {
			t.Fatal("unsafe origin accepted")
		}
	}
}
