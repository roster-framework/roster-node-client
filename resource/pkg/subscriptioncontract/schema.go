package subscriptioncontract

// CommandSchema is transport-neutral JSON Schema. Explicit object configuration
// prevents Go []byte/RawMessage inference from advertising an array in MCP.
func CommandSchema() map[string]any {
	properties := map[string]any{}
	for _, name := range []string{"protocol", "id", "resource_id", "extension_id", "extension_revision"} {
		properties[name] = map[string]any{"type": "string"}
	}
	properties["protocol"] = map[string]any{"type": "string", "const": Protocol}
	properties["expected_version"] = map[string]any{"type": "integer", "minimum": 1}
	properties["configuration"] = map[string]any{"type": "object"}
	return map[string]any{"type": "object", "additionalProperties": false, "properties": properties, "required": []string{"protocol", "id", "resource_id", "extension_id", "extension_revision", "expected_version", "configuration"}}
}
