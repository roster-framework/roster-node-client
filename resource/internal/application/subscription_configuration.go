package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
)

func (s *Service) ConfigureSubscription(ctx context.Context, command subscriptioncontract.Command) (subscriptioncontract.Receipt, error) {
	var receipt subscriptioncontract.Receipt
	if err := command.Validate(); err != nil {
		return receipt, err
	}
	definition, err := s.Registry.Definition(ctx, command.ResourceID)
	if err != nil {
		return receipt, err
	}
	if definition.Version != command.ExpectedVersion {
		return receipt, resource.ErrConflict
	}
	if definition.Audience == "service" {
		return receipt, resource.ErrUnsupported
	}
	var declaration *subscriptioncontract.Declaration
	for _, candidate := range definition.SubscriptionExtensions {
		if candidate.ID == command.ExtensionID {
			copy := candidate
			declaration = &copy
			break
		}
	}
	if declaration == nil {
		return receipt, resource.ErrNotFound
	}
	if command.ExtensionRevision != declaration.Revision {
		return receipt, resource.ErrConflict
	}
	if command.Match(*declaration) != nil {
		return receipt, resource.ErrUnsupported
	}
	raw, err := json.Marshal(command)
	if err != nil {
		return receipt, err
	}
	var arguments map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err = decoder.Decode(&arguments); err != nil {
		return receipt, err
	}
	result, err := s.Invoke(ctx, definition.ID, resource.Operation{ExpectedVersion: &definition.Version, Name: declaration.ConfigureOperation.Name, Tool: declaration.ConfigureOperation.Tool, Arguments: arguments})
	if err != nil {
		return receipt, err
	}
	raw, err = json.Marshal(result)
	if decoder, ok := s.Components.(SubscriptionConfigurationDecoder); ok {
		raw, err = decoder.DecodeSubscriptionConfiguration(definition, result)
	}
	if err != nil || len(raw) > 100000 {
		return receipt, errors.New("invalid subscription result")
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&receipt) != nil || receipt.ValidateFor(command, *declaration) != nil {
		return subscriptioncontract.Receipt{}, errors.New("invalid subscription result")
	}
	// Library owns stream registration and storage. Do not fabricate a document or
	// a permission when its returned handle has not actually been registered.
	stream, err := s.Registry.Definition(ctx, receipt.StreamResourceID)
	if err != nil || stream.Audience == "service" {
		return subscriptioncontract.Receipt{}, errors.New("subscription stream unavailable")
	}
	current, err := s.Registry.Definition(ctx, definition.ID)
	if err != nil || current.Version != definition.Version {
		return subscriptioncontract.Receipt{}, resource.ErrConflict
	}
	return receipt, nil
}
