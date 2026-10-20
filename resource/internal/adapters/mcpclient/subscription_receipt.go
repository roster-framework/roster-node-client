package mcpclient

import (
	"encoding/json"
	"errors"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
)

// Configuration tools must return the public receipt as structuredContent.
// Do not interpret arbitrary text, silently accept isError, or persist content
// blocks that may contain provider diagnostics instead of the receipt.
func (f Factory) DecodeSubscriptionConfiguration(_ resource.Definition, value any) (json.RawMessage, error) {
	result, ok := value.(*mcp.CallToolResult)
	if !ok || result == nil || result.IsError || result.StructuredContent == nil {
		return nil, errors.New("invalid MCP subscription receipt")
	}
	return json.Marshal(result.StructuredContent)
}
