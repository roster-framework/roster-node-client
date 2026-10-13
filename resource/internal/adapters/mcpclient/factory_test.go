package mcpclient

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"net/http/httptest"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"sync/atomic"
	"testing"
)

func TestExistingMCPRegisteredWithoutProviderSpecificCode(t *testing.T) {
	var calls atomic.Int32
	server := mcp.NewServer(&mcp.Implementation{Name: "provider", Version: "test"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "lookup", Description: "lookup"}, func(_ context.Context, _ *mcp.CallToolRequest, in struct {
		Query string `json:"query"`
	}) (*mcp.CallToolResult, map[string]string, error) {
		calls.Add(1)
		return nil, map[string]string{"query": in.Query}, nil
	})
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer provider-test-credential" {
			w.WriteHeader(401)
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer provider.Close()
	factory := Factory{Credentials: func(name string) string {
		if name != "PROVIDER_TOKEN" {
			t.Fatalf("foreign env %s", name)
		}
		return "provider-test-credential"
	}}
	definition := resource.Definition{ID: "remote", Component: "mcp", Endpoint: provider.URL, CredentialEnv: "PROVIDER_TOKEN"}
	listed, err := factory.Invoke(context.Background(), definition, resource.Operation{Name: "tools.list"})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.(*mcp.ListToolsResult).Tools) != 1 {
		t.Fatal("tools missing")
	}
	result, err := factory.Invoke(context.Background(), definition, resource.Operation{Name: "tools.call", Tool: "lookup", Arguments: map[string]any{"query": "brief"}})
	if err != nil {
		t.Fatal(err)
	}
	if result.(*mcp.CallToolResult).IsError || calls.Load() != 1 {
		t.Fatal("proxy did not invoke exactly once")
	}
	factory.Credentials = func(string) string { return "" }
	if _, err = factory.Invoke(context.Background(), definition, resource.Operation{Name: "tools.call", Tool: "lookup"}); err == nil || calls.Load() != 1 {
		t.Fatal("missing credential executed provider")
	}
}
