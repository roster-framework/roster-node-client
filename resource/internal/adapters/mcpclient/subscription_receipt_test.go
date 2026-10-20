package mcpclient

import (
	"context"
	"encoding/json"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"net/http/httptest"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
	"strings"
	"testing"
)

func TestConfigurationReceiptFromActualMCPTransport(t *testing.T) {
	d := subscriptioncontract.Declaration{Protocol: subscriptioncontract.Protocol, ID: "slack-extension", Revision: strings.Repeat("a", 64), ConfigurationSchema: json.RawMessage(`{}`), ConfigureOperation: subscriptioncontract.Operation{Name: "tools.call", Tool: "custom_configure"}, Events: []string{"resource.updated"}}
	c := subscriptioncontract.Command{Protocol: d.Protocol, ID: "request", ResourceID: "slack", ExtensionID: d.ID, ExtensionRevision: d.Revision, ExpectedVersion: 1, Configuration: json.RawMessage(`{"channels":["design"],"cursor":9007199254740993}`)}
	digest, _ := c.Digest()
	want := subscriptioncontract.Receipt{Protocol: d.Protocol, RequestID: c.ID, ResourceID: c.ResourceID, ExtensionID: d.ID, ExtensionRevision: d.Revision, RequestDigest: digest, StreamResourceID: "selected-stream", Events: d.Events, AcceptedAt: "2026-10-09T00:00:00Z"}
	server := mcp.NewServer(&mcp.Implementation{Name: "custom-slack", Version: "1"}, nil)
	server.AddTool(&mcp.Tool{Name: "custom_configure", Description: "author configuration", InputSchema: subscriptioncontract.CommandSchema()}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var in subscriptioncontract.Command
		if json.Unmarshal(req.Params.Arguments, &in) != nil || in.Match(d) != nil || !strings.Contains(string(in.Configuration), "9007199254740993") || in.ID != c.ID {
			t.Error("command changed")
		}
		return &mcp.CallToolResult{StructuredContent: want, Content: []mcp.Content{&mcp.TextContent{Text: "configured"}}}, nil
	})
	provider := httptest.NewServer(mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil))
	defer provider.Close()
	f := Factory{}
	definition := resource.Definition{ID: c.ResourceID, Component: "mcp", Endpoint: provider.URL}
	raw, _ := json.Marshal(c)
	var arguments map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&arguments); err != nil {
		t.Fatal(err)
	}
	result, err := f.Invoke(context.Background(), definition, resource.Operation{Name: "tools.call", Tool: "custom_configure", Arguments: arguments})
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := f.DecodeSubscriptionConfiguration(definition, result)
	if err != nil {
		t.Fatal(err)
	}
	var receipt subscriptioncontract.Receipt
	if json.Unmarshal(decoded, &receipt) != nil || receipt.ValidateFor(c, d) != nil {
		t.Fatal("MCP receipt not usable")
	}
	for _, bad := range []any{nil, &mcp.CallToolResult{IsError: true, StructuredContent: want}, &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "private error"}}}} {
		if _, err = f.DecodeSubscriptionConfiguration(definition, bad); err == nil {
			t.Fatal("non-receipt accepted")
		}
	}
}
