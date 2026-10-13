package httpapi

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"github.com/roster-framework/roster-node-client/resource/internal/application"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strconv"
	"strings"
)

type API struct {
	Service    *application.Service
	Token      string
	AdminToken string
}
type endpoint func(http.ResponseWriter, *http.Request) (any, error)

func (a API) Handler() http.Handler {
	mux := http.NewServeMux()
	a.historyRoutes(mux)
	a.subscriptionConfigurationRoutes(mux)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		reply(w, 200, map[string]string{"status": "ok", "service": "resource-server", "protocol": "roster-resource/1"})
	})
	mux.HandleFunc("GET /v1/resources", a.route(false, func(_ http.ResponseWriter, r *http.Request) (any, error) { return a.Service.List(r.Context()) }))
	mux.HandleFunc("POST /v1/resources", a.route(true, func(w http.ResponseWriter, r *http.Request) (any, error) {
		in, err := decode[resource.Definition](w, r)
		if err != nil {
			return nil, err
		}
		return a.Service.Register(r.Context(), in)
	}))
	mux.HandleFunc("GET /v1/resources/{id}", a.route(false, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		return a.Service.Metadata(r.Context(), r.PathValue("id"))
	}))
	mux.HandleFunc("POST /v1/resources/{id}/publish", a.route(false, func(w http.ResponseWriter, r *http.Request) (any, error) {
		in, err := decode[resource.Publish](w, r)
		if err != nil {
			return nil, err
		}
		if in.ID != r.PathValue("id") {
			return nil, errors.New("resource identity mismatch")
		}
		return a.Service.Publish(r.Context(), in)
	}))
	mux.HandleFunc("GET /v1/resources/{id}/document", a.route(false, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		version := 0
		var err error
		if v := r.URL.Query().Get("version"); v != "" {
			version, err = strconv.Atoi(v)
			if err != nil {
				return nil, errors.New("invalid version")
			}
		}
		return a.Service.Document(r.Context(), r.PathValue("id"), version)
	}))
	mux.HandleFunc("POST /v1/resources/{id}/invoke", a.route(false, func(w http.ResponseWriter, r *http.Request) (any, error) {
		in, err := decode[resource.Operation](w, r)
		if err != nil {
			return nil, err
		}
		return a.Service.Invoke(r.Context(), r.PathValue("id"), in)
	}))
	mux.HandleFunc("GET /v1/changes", a.route(false, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		limit := 50
		var err error
		if v := r.URL.Query().Get("limit"); v != "" {
			limit, err = strconv.Atoi(v)
			if err != nil {
				return nil, errors.New("invalid limit")
			}
		}
		return a.Service.Changes(r.Context(), r.URL.Query().Get("consumer"), limit)
	}))
	mux.HandleFunc("POST /v1/changes/{id}/ack", a.route(false, func(w http.ResponseWriter, r *http.Request) (any, error) {
		in, err := decode[struct {
			Consumer string `json:"consumer"`
		}](w, r)
		if err != nil {
			return nil, err
		}
		return map[string]bool{"acknowledged": true}, a.Service.Ack(r.Context(), in.Consumer, r.PathValue("id"))
	}))
	return mux
}
func same(a, b string) bool {
	return len(a) >= 32 && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
func (a API) route(admin bool, handle endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || !same(a.AdminToken, token) && (admin || !same(a.Token, token)) {
			reply(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		result, err := handle(w, r)
		if err != nil {
			status := 400
			switch {
			case errors.Is(err, resource.ErrNotFound):
				status = 404
			case errors.Is(err, resource.ErrConflict):
				status = 409
			case errors.Is(err, resource.ErrUnsupported):
				status = 422
			case errors.Is(err, resource.ErrHistoryRead):
				status = 503
			}
			reply(w, status, map[string]string{"error": http.StatusText(status)})
			return
		}
		reply(w, 200, result)
	}
}
func decode[T any](w http.ResponseWriter, r *http.Request) (T, error) {
	var in T
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 300000))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&in); err != nil {
		return in, err
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		return in, errors.New("unexpected trailing data")
	}
	return in, nil
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
