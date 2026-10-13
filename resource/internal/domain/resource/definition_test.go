package resource

import (
	"errors"
	"testing"
)

func TestDefinitionRejectsProviderLeakAndInvalidTransition(t *testing.T) {
	original := Definition{ID: "design", Name: "Design", Component: "mcp", Endpoint: "https://example.com/mcp", CredentialEnv: "DESIGN_MCP_TOKEN"}
	saved, err := (Definition{}).Next(original)
	if err != nil || saved.Version != 1 {
		t.Fatalf("register: %+v %v", saved, err)
	}
	for _, endpoint := range []string{"http://example.com/mcp", "https://user:secret@example.com/mcp", "file:///etc/passwd", "https://example.com/mcp?token=secret"} {
		bad := original
		bad.Endpoint = endpoint
		if _, err := (Definition{}).Next(bad); err == nil {
			t.Fatalf("accepted %s", endpoint)
		}
	}
	replacement := saved
	replacement.Component = "document"
	replacement.Endpoint = ""
	replacement.CredentialEnv = ""
	if _, err := saved.Next(replacement); !errors.Is(err, ErrConflict) {
		t.Fatalf("component swap: %v", err)
	}
	if _, err := saved.Next(original); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale: %v", err)
	}
}

func TestDocumentDoesNotChangeIdentityOrCollection(t *testing.T) {
	p := Publish{ID: "brief", Collection: "docs", SourceKind: "upload", Title: "Brief", Body: "one", ChangeID: "upload-1"}
	doc, err := (Document{}).Next(p, "2026-10-03T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	p.ExpectedVersion = 1
	p.ID = "another"
	if _, err := doc.Next(p, "2026-10-03T00:00:00Z"); !errors.Is(err, ErrConflict) {
		t.Fatalf("identity change: %v", err)
	}
}
