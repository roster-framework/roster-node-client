package mcpclient

import (
	"context"
	"errors"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"time"
)

type Factory struct {
	Credentials func(string) string
	Transport   http.RoundTripper
}
type authorized struct {
	base  http.RoundTripper
	token string
}

func (a authorized) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	if a.token != "" {
		clone.Header.Set("Authorization", "Bearer "+a.token)
	}
	return a.base.RoundTrip(clone)
}
func (f Factory) Invoke(ctx context.Context, d resource.Definition, op resource.Operation) (any, error) {
	if d.Component != "mcp" {
		return nil, resource.ErrUnsupported
	}
	if err := resource.ValidateEndpoint(d.Endpoint); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	token := ""
	if d.CredentialEnv != "" {
		if f.Credentials == nil {
			return nil, errors.New("resource credential unavailable")
		}
		token = f.Credentials(d.CredentialEnv)
		if token == "" {
			return nil, errors.New("resource credential unavailable")
		}
	}
	base := f.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	client := &http.Client{Transport: authorized{base, token}, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("resource redirect refused") }}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "roster-resource-server", Version: "0.1.0"}, nil).Connect(ctx, &mcp.StreamableClientTransport{Endpoint: d.Endpoint, HTTPClient: client, DisableStandaloneSSE: true, MaxRetries: -1}, nil)
	if err != nil {
		return nil, errors.New("resource MCP connection failed")
	}
	defer session.Close()
	switch op.Name {
	case "tools.list":
		result, err := session.ListTools(ctx, &mcp.ListToolsParams{})
		if err != nil {
			return nil, errors.New("resource tools query failed")
		}
		return result, nil
	case "tools.call":
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: op.Tool, Arguments: op.Arguments})
		if err != nil {
			return nil, errors.New("resource tool invocation failed")
		}
		return result, nil
	default:
		return nil, resource.ErrUnsupported
	}
}
