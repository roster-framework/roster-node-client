// roster-project-resource prepares a Resource publish command from a full snapshot.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"github.com/roster-framework/roster-node-client/resource/pkg/projectresource"
)

func decodeFile(path string, target any) error {
	file, e := os.Open(path)
	if e != nil {
		return e
	}
	defer file.Close()
	raw, e := io.ReadAll(io.LimitReader(file, 2*1024*1024+1))
	if e != nil {
		return e
	}
	if len(raw) > 2*1024*1024 {
		return fmt.Errorf("input exceeds limit")
	}
	return json.Unmarshal(raw, target)
}
func run(args []string) error {
	if len(args) != 3 {
		return fmt.Errorf("usage: roster-project-resource VIEW_JSON FULL_SNAPSHOT_JSON HEAD_JSON")
	}
	var view projectresource.View
	var items []projectresource.Item
	var head projectresource.Head
	for i, target := range []any{&view, &items, &head} {
		if e := decodeFile(args[i], target); e != nil {
			return fmt.Errorf("invalid input %d", i+1)
		}
	}
	publication, e := view.Prepare(items, head)
	if e != nil {
		return e
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Changed     bool                         `json:"changed"`
		Publication *projectresource.Publication `json:"publication,omitempty"`
	}{publication != nil, publication})
}
func main() {
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
