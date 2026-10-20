package httpapi

import (
	"net/http"
	"github.com/roster-framework/roster-node-client/resource/internal/domain/resource"
	"strconv"
)

func (a API) historyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/resources/{id}/history", a.route(false, func(_ http.ResponseWriter, r *http.Request) (any, error) {
		q := resource.HistoryQuery{}
		values := r.URL.Query()
		for name, list := range values {
			if len(list) != 1 || list[0] == "" || name != "limit" && name != "after" {
				return nil, resource.ErrHistoryQuery
			}
			for _, c := range list[0] {
				if c < '0' || c > '9' {
					return nil, resource.ErrHistoryQuery
				}
			}
			v, err := strconv.Atoi(list[0])
			if err != nil {
				return nil, resource.ErrHistoryQuery
			}
			if name == "limit" {
				if v == 0 {
					return nil, resource.ErrHistoryQuery
				}
				q.Limit = v
			} else {
				q.After = v
			}
		}
		return a.Service.History(r.Context(), r.PathValue("id"), q)
	}))
}
