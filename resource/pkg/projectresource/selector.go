package projectresource

import "errors"

// Empty criteria mean no restriction. Label comparison is exact and case-sensitive.
type Selector struct {
	AllLabels     []string `json:"all_labels,omitempty"`
	AnyLabels     []string `json:"any_labels,omitempty"`
	ExcludeLabels []string `json:"exclude_labels,omitempty"`
	States        []string `json:"states,omitempty"`
}

func (s Selector) validate() error {
	for _, values := range [][]string{s.AllLabels, s.AnyLabels, s.ExcludeLabels, s.States} {
		if len(values) > 100 {
			return errors.New("selector exceeds limit")
		}
		seen := map[string]bool{}
		for _, v := range values {
			if v == "" || len(v) > 100 || seen[v] {
				return errors.New("invalid selector")
			}
			seen[v] = true
		}
	}
	return nil
}
func includes(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func (s Selector) matches(i Item) bool {
	for _, label := range s.AllLabels {
		if !includes(i.Labels, label) {
			return false
		}
	}
	if len(s.AnyLabels) > 0 {
		found := false
		for _, label := range s.AnyLabels {
			found = found || includes(i.Labels, label)
		}
		if !found {
			return false
		}
	}
	for _, label := range s.ExcludeLabels {
		if includes(i.Labels, label) {
			return false
		}
	}
	return len(s.States) == 0 || includes(s.States, i.State)
}
