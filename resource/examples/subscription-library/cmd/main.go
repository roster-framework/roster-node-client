// This optional author process is not started by the default Resource server.
package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
	library "github.com/roster-framework/roster-node-client/resource/examples/subscription-library"
	"github.com/roster-framework/roster-node-client/resource/pkg/projectresource"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--declaration" {
		_ = json.NewEncoder(os.Stdout).Encode(library.Declaration())
		return
	}
	if len(os.Args) != 1 {
		log.Fatal("unsupported example arguments")
	}
	directory := os.Getenv("EXAMPLE_LIBRARY_DATA_DIR")
	if directory == "" || os.Getenv("EXAMPLE_LIBRARY_TOKEN") == "" {
		log.Fatal("example private configuration required")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		log.Fatal("cannot create example storage")
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, "subscriptions.db"))
	if err != nil {
		log.Fatal("cannot open example storage")
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err = db.Exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"); err != nil {
		log.Fatal("cannot initialize durable storage")
	}
	registrar, err := library.NewNativeRegistrar(os.Getenv("ROSTER_RESOURCE_URL"), os.Getenv("ROSTER_RESOURCE_ADMIN_TOKEN"))
	if err != nil {
		log.Fatal("invalid example registration configuration")
	}
	publisher, err := projectresource.NewClient(os.Getenv("ROSTER_RESOURCE_URL"), os.Getenv("ROSTER_RESOURCE_TOKEN"))
	if err != nil {
		log.Fatal("invalid example publication configuration")
	}
	instance, err := library.New(db, registrar, publisher)
	if err != nil {
		log.Fatal("cannot initialize example library")
	}
	server := &http.Server{Addr: "127.0.0.1:7355", Handler: instance.Handler(os.Getenv("EXAMPLE_LIBRARY_TOKEN")), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	log.Print("Optional subscription library listening on loopback")
	if err = server.ListenAndServe(); err != nil {
		log.Fatal("example server stopped")
	}
}
