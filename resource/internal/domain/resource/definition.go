package resource

import (
	"errors"
	"net"
	"net/url"
	"regexp"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
	"strings"
)

var ErrNotFound = errors.New("resource not found")
var ErrConflict = errors.New("resource version conflict")
var ErrUnsupported = errors.New("resource operation unsupported")
var credentialName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,99}$`)

// Definition is provider configuration owned exclusively by this service.
type Definition struct {
	ID                     string                             `json:"id"`
	Name                   string                             `json:"name"`
	Component              string                             `json:"component"`
	Endpoint               string                             `json:"endpoint,omitempty"`
	CredentialEnv          string                             `json:"credential_env,omitempty"`
	SigningKeyEnv          string                             `json:"signing_key_env,omitempty"`
	Version                int                                `json:"version"`
	Audience               string                             `json:"audience,omitempty"`
	Operations             []string                           `json:"operations,omitempty"`
	Protocol               string                             `json:"protocol,omitempty"`
	SubscriptionExtensions []subscriptioncontract.Declaration `json:"subscription_extensions,omitempty"`
}

func (d Definition) Next(in Definition) (Definition, error) {
	if !identifier.MatchString(in.ID) || strings.TrimSpace(in.Name) == "" || len(in.Name) > 200 || in.Version < 0 {
		return Definition{}, errors.New("invalid resource definition")
	}
	if in.Audience != "" && in.Audience != "agent" && in.Audience != "service" {
		return Definition{}, errors.New("invalid resource audience")
	}
	if in.Component != "http" && (len(in.Operations) > 0 || in.Protocol != "") {
		return Definition{}, errors.New("component does not accept HTTP capabilities")
	}
	if in.Component != "webhook" && in.SigningKeyEnv != "" {
		return Definition{}, errors.New("component does not accept a signing key")
	}
	switch in.Component {
	case "webhook":
		if in.Audience != "service" || !credentialName.MatchString(in.SigningKeyEnv) ||
			in.CredentialEnv != "" && !credentialName.MatchString(in.CredentialEnv) {
			return Definition{}, errors.New("webhook requires service audience and a signing key environment name")
		}
		if err := ValidateEndpoint(in.Endpoint); err != nil {
			return Definition{}, err
		}
	case "document":
		if in.Endpoint != "" || in.CredentialEnv != "" {
			return Definition{}, errors.New("document storage is owned by its component")
		}
	case "http":
		if len(in.Operations) == 0 || len(in.Operations) > 100 || len(in.Protocol) > 100 || !regexp.MustCompile(`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`).MatchString(in.Protocol) {
			return Definition{}, errors.New("HTTP component requires operations and protocol")
		}
		for _, op := range in.Operations {
			if !identifier.MatchString(op) {
				return Definition{}, ErrUnsupported
			}
		}
		fallthrough
	case "mcp":
		if err := ValidateEndpoint(in.Endpoint); err != nil {
			return Definition{}, err
		}
		if in.CredentialEnv != "" && !credentialName.MatchString(in.CredentialEnv) {
			return Definition{}, errors.New("credential must name an environment variable")
		}
	default:
		return Definition{}, ErrUnsupported
	}
	if d.Version != in.Version || d.Version > 0 && (d.ID != in.ID || d.Component != in.Component || d.Audience != in.Audience) {
		return Definition{}, ErrConflict
	}
	if err := in.validateSubscriptionExtensions(); err != nil {
		return Definition{}, err
	}
	in.Version++
	return in, nil
}

func ValidateEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || len(endpoint) > 2000 {
		return errors.New("invalid resource endpoint")
	}
	ip := net.ParseIP(u.Hostname())
	local := u.Hostname() == "localhost" || ip != nil && ip.IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return errors.New("remote resources require HTTPS")
	}
	return nil
}

type Metadata struct {
	ID                     string                             `json:"id"`
	Name                   string                             `json:"name"`
	Component              string                             `json:"component"`
	Version                int                                `json:"version"`
	Operations             []string                           `json:"operations"`
	Audience               string                             `json:"audience,omitempty"`
	SubscriptionExtensions []subscriptioncontract.Declaration `json:"subscription_extensions,omitempty"`
}

func (d Definition) Metadata() Metadata {
	operations := []string{"read", "publish"}
	if d.Component == "mcp" {
		operations = []string{"tools.list", "tools.call"}
	}
	if d.Component == "http" {
		operations = append([]string{}, d.Operations...)
	}
	if d.Component == "webhook" {
		operations = []string{"notification.send"}
	}
	return Metadata{ID: d.ID, Name: d.Name, Component: d.Component, Version: d.Version, Operations: operations, Audience: d.Audience, SubscriptionExtensions: d.SubscriptionExtensions}
}

type Operation struct {
	ExpectedVersion *int           `json:"expected_version,omitempty"`
	Name            string         `json:"name"`
	Tool            string         `json:"tool,omitempty"`
	Arguments       map[string]any `json:"arguments,omitempty"`
}

func (o Operation) Validate() error {
	if o.ExpectedVersion != nil && *o.ExpectedVersion < 1 {
		return ErrUnsupported
	}
	if !identifier.MatchString(o.Name) || len(o.Tool) > 200 || o.Name == "tools.call" && strings.TrimSpace(o.Tool) == "" || o.Name == "tools.list" && (o.Tool != "" || len(o.Arguments) > 0) {
		return ErrUnsupported
	}
	return nil
}

func ValidConsumer(id string) bool { return identifier.MatchString(id) }
