package subscriptioncontract

import (
	"errors"
	"slices"
	"time"
)

// Receipt points to a resource registered by the library. It never grants Core
// access or assigns an organization, role or subscriber to the returned stream.
type Receipt struct {
	Protocol          string   `json:"protocol"`
	RequestID         string   `json:"request_id"`
	ResourceID        string   `json:"resource_id"`
	ExtensionID       string   `json:"extension_id"`
	ExtensionRevision string   `json:"extension_revision"`
	RequestDigest     string   `json:"request_digest"`
	StreamResourceID  string   `json:"stream_resource_id"`
	Events            []string `json:"events"`
	AcceptedAt        string   `json:"accepted_at"`
	Replayed          bool     `json:"replayed,omitempty"`
}

func (r Receipt) ValidateFor(c Command, d Declaration) error {
	digest, err := c.Digest()
	_, dateErr := time.Parse(time.RFC3339Nano, r.AcceptedAt)
	if err != nil || c.Match(d) != nil || r.Protocol != Protocol || r.RequestID != c.ID || r.ResourceID != c.ResourceID || r.ExtensionID != c.ExtensionID || r.ExtensionRevision != c.ExtensionRevision || r.RequestDigest != digest || !identifier.MatchString(r.StreamResourceID) || dateErr != nil || len(r.Events) == 0 || len(r.Events) > 100 {
		return errors.New("invalid subscription configuration receipt")
	}
	seen := map[string]bool{}
	for _, event := range r.Events {
		if !slices.Contains(d.Events, event) || seen[event] {
			return errors.New("undeclared subscription stream event")
		}
		seen[event] = true
	}
	return nil
}
