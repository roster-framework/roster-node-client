package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/components"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/documentcomponent"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/httpcomponent"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/mcpclient"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/sqlite"
	"github.com/roster-framework/roster-node-client/resource/internal/adapters/webhook"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/interfaces/httpapi"
	"syscall"
	"time"
)

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
func main() {
	if err := run(); err != nil {
		slog.Error("resource server stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	token, admin := os.Getenv("ROSTER_RESOURCE_TOKEN"), os.Getenv("ROSTER_RESOURCE_ADMIN_TOKEN")
	if len(token) < 32 || len(admin) < 32 || token == admin {
		return errors.New("separate resource service and admin credentials of at least 32 characters are required")
	}
	listen := env("ROSTER_LISTEN", "127.0.0.1")
	// A remote deployment terminates TLS in this service, rather than accepting plain external HTTP.
	cert, key := os.Getenv("ROSTER_TLS_CERT"), os.Getenv("ROSTER_TLS_KEY")
	if listen != "127.0.0.1" && listen != "localhost" && (cert == "" || key == "") {
		return errors.New("external resource listener requires TLS")
	}
	data := env("ROSTER_DATA_DIR", ".roster")
	registry, err := sqlite.NewRegistry(filepath.Join(data, "catalog.db"))
	if err != nil {
		return err
	}
	defer registry.Close()
	docs, err := sqlite.NewResources(filepath.Join(data, "documents.db"))
	if err != nil {
		return err
	}
	defer docs.Close()
	service := &application.Service{Registry: registry, Documents: docs}
	service.Components = components.Factory{"document": documentcomponent.Factory{Documents: service}, "mcp": mcpclient.Factory{Credentials: os.Getenv}, "http": httpcomponent.Factory{Credentials: os.Getenv}, "webhook": webhook.Factory{Credentials: os.Getenv}}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &http.Server{Addr: net.JoinHostPort(listen, env("PORT", "7340")), Handler: (httpapi.API{Service: service, Token: token, AdminToken: admin}).Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, BaseContext: func(net.Listener) context.Context { return ctx }}
	done := make(chan error, 1)
	go func() {
		slog.Info("resource server ready", "address", server.Addr)
		if cert != "" && key != "" {
			done <- server.ListenAndServeTLS(cert, key)
		} else {
			done <- server.ListenAndServe()
		}
	}()
	select {
	case err = <-done:
	case <-ctx.Done():
	}
	cancel()
	shutdown, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if e := server.Shutdown(shutdown); e != nil {
		return e
	}
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
