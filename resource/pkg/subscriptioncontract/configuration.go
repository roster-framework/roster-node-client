package subscriptioncontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// Command is passed unchanged to the selected library's configure operation.
// The library owns idempotency and returns the resulting registered stream.
type Command struct {
	Protocol          string          `json:"protocol"`
	ID                string          `json:"id"`
	ResourceID        string          `json:"resource_id"`
	ExtensionID       string          `json:"extension_id"`
	ExtensionRevision string          `json:"extension_revision"`
	ExpectedVersion   int             `json:"expected_version"`
	Configuration     json.RawMessage `json:"configuration"`
}

func (c Command) Validate() error {
	if c.Protocol != Protocol || !identifier.MatchString(c.ID) || !identifier.MatchString(c.ResourceID) || !identifier.MatchString(c.ExtensionID) || !revision.MatchString(c.ExtensionRevision) || c.ExpectedVersion < 1 || !object(c.Configuration, 64000) {
		return errors.New("invalid subscription configuration envelope")
	}
	return nil
}

// Match verifies only identity and revision, not provider-specific parameters.
func (c Command) Match(d Declaration) error {
	if c.Validate() != nil || d.Validate() != nil || c.ExtensionID != d.ID || c.ExtensionRevision != d.Revision {
		return errors.New("subscription extension contract mismatch")
	}
	return nil
}

// Digest normalizes JSON object ordering without converting numbers to float64.
// It identifies the envelope, not the meaning of provider-specific settings.
func (c Command) Digest() (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	var config any
	dec := json.NewDecoder(bytes.NewReader(c.Configuration))
	dec.UseNumber()
	if err := dec.Decode(&config); err != nil {
		return "", err
	}
	canonical, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	c.Configuration = canonical
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
