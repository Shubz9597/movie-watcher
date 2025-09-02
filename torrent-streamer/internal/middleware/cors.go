package middleware

import "net/http"

func EnableCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS, POST")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
	w.Header().Set("Access-Control-Expose-Headers",
		"Content-Length, Content-Range, Content-Type, X-File-Index, X-File-Name, X-Buffer-Target-Bytes, X-Buffered-Ahead-Probe",
	)
}
