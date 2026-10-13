package resource

import (
	"errors"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
)

func (d Definition) validateSubscriptionExtensions() error {
	if len(d.SubscriptionExtensions) > 20 {
		return errors.New("too many subscription extensions")
	}
	seen := map[string]bool{}
	available := map[string]bool{}
	for _, operation := range d.Metadata().Operations {
		available[operation] = true
	}
	for _, extension := range d.SubscriptionExtensions {
		if extension.Validate() != nil || seen[extension.ID] {
			return errors.New("invalid resource subscription extension")
		}
		seen[extension.ID] = true
		for _, operation := range []*subscriptioncontract.Operation{&extension.ConfigureOperation, extension.OptionsOperation} {
			if operation != nil && !available[operation.Name] {
				return errors.New("subscription operation is not declared by component")
			}
		}
	}
	return nil
}
