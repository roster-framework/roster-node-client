package httpapi

import (
	"errors"
	"net/http"
	"github.com/roster-framework/roster-node-client/resource/pkg/subscriptioncontract"
)

func (a API) subscriptionConfigurationRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/resources/{id}/subscription-configurations", a.route(false, func(w http.ResponseWriter, r *http.Request) (any, error) {
		in, err := decode[subscriptioncontract.Command](w, r)
		if err != nil {
			return nil, err
		}
		if in.ResourceID != r.PathValue("id") {
			return nil, errors.New("resource identity mismatch")
		}
		return a.Service.ConfigureSubscription(r.Context(), in)
	}))
}
