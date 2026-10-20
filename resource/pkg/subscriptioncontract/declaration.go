// Package subscriptioncontract defines resource-library extension wire contracts.
// It does not interpret a provider's configuration or implement event selection.
package subscriptioncontract

import (
	"encoding/json"
	"errors"
	"regexp"
)

const Protocol = "roster-resource-subscription-extension/1"

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)
var revision = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Operation references an existing native operation or MCP tool. No endpoint or
// credential is disclosed. Options and configuration execute in the library.
type Operation struct {
	Name string `json:"name"`
	Tool string `json:"tool,omitempty"`
}

func (o Operation) Validate() error {
	if !identifier.MatchString(o.Name) || len(o.Tool) > 200 || o.Name == "tools.call" && o.Tool == "" || o.Name != "tools.call" && o.Tool != "" {
		return errors.New("invalid subscription operation reference")
	}
	return nil
}

type Declaration struct {
	Protocol            string          `json:"protocol"`
	ID                  string          `json:"id"`
	Revision            string          `json:"revision"`
	ConfigurationSchema json.RawMessage `json:"configuration_schema"`
	OptionsOperation    *Operation      `json:"options_operation,omitempty"`
	ConfigureOperation  Operation       `json:"configure_operation"`
	Events              []string        `json:"events"`
}

// JSON schemas and configurations are bounded opaque objects. Semantic schema
// validation, defaults and selectable values belong to the resource library.
func object(raw json.RawMessage, limit int) bool {
	var value map[string]json.RawMessage
	return len(raw) <= limit && json.Unmarshal(raw, &value) == nil && value != nil
}

func (d Declaration) Validate() error {
	if d.Protocol != Protocol || !identifier.MatchString(d.ID) || !revision.MatchString(d.Revision) || !object(d.ConfigurationSchema, 32000) || d.ConfigureOperation.Validate() != nil || len(d.Events) == 0 || len(d.Events) > 100 {
		return errors.New("invalid subscription extension declaration")
	}
	if d.OptionsOperation != nil && d.OptionsOperation.Validate() != nil {
		return errors.New("invalid subscription options operation")
	}
	seen := map[string]bool{}
	for _, event := range d.Events {
		if !identifier.MatchString(event) || seen[event] {
			return errors.New("invalid subscription event declaration")
		}
		seen[event] = true
	}
	return nil
}
