package bootstrap

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestStartersMatchV1ElectronDefinitions prevents drift between this
// package's declarative starter set and the V1 Electron launcher's
// DEFAULT_PROWLARR_INDEXERS (docs/v2-server-package/architecture.md §8:
// "duplicate only the declarative data temporarily and add a parity test
// that prevents drift"). When a starter changes, change BOTH files in the
// same commit. The durable fix — one shared declarative file — lands with
// the renderer-removal gate (P8).
func TestStartersMatchV1ElectronDefinitions(t *testing.T) {
	jsPath := filepath.Join("..", "..", "..", "electron-app", "electron", "runtime", "runtime-manager.js")
	source, err := os.ReadFile(jsPath)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skipf("electron-app checkout not present next to torrent-streamer: %v", err)
		}
		t.Fatal(err)
	}

	block, ok := extractArray(string(source), "DEFAULT_PROWLARR_INDEXERS")
	if !ok {
		t.Fatalf("could not locate DEFAULT_PROWLARR_INDEXERS in %s", jsPath)
	}

	// Minimal normalization of the JS object literals into JSON so the
	// entries can be compared structurally against the Go definitions.
	normalized := normalizeJSObjectLiterals(block)
	var jsStarters []struct {
		Definition     *string        `json:"definition"`
		Implementation *string        `json:"implementation"`
		Name           string         `json:"name"`
		Priority       int            `json:"priority"`
		MinimumSeeders int            `json:"minimumSeeders"`
		PreferMagnet   *bool          `json:"preferMagnet"`
		Fields         map[string]any `json:"fields"`
	}
	if err := json.Unmarshal([]byte(normalized), &jsStarters); err != nil {
		t.Fatalf("normalized JS starters are not valid JSON: %v\nquoted:\n%q", err, normalized)
	}

	if len(jsStarters) != len(DefaultStarters()) {
		t.Fatalf("starter count drift: JS = %d, Go = %d", len(jsStarters), len(DefaultStarters()))
	}

	for i, js := range jsStarters {
		goStarter := DefaultStarters()[i]
		if js.Name != goStarter.Name {
			t.Errorf("starter %d name: JS %q, Go %q", i, js.Name, goStarter.Name)
		}
		if js.Priority != goStarter.Priority {
			t.Errorf("starter %s priority: JS %d, Go %d", js.Name, js.Priority, goStarter.Priority)
		}
		if js.MinimumSeeders != goStarter.MinimumSeeders {
			t.Errorf("starter %s minimumSeeders: JS %d, Go %d", js.Name, js.MinimumSeeders, goStarter.MinimumSeeders)
		}
		if (js.Definition == nil) != (goStarter.Definition == "") ||
			(js.Definition != nil && *js.Definition != goStarter.Definition) {
			t.Errorf("starter %s definition: JS %v, Go %q", js.Name, js.Definition, goStarter.Definition)
		}
		if (js.Implementation == nil) != (goStarter.Implementation == "") ||
			(js.Implementation != nil && *js.Implementation != goStarter.Implementation) {
			t.Errorf("starter %s implementation: JS %v, Go %q", js.Name, js.Implementation, goStarter.Implementation)
		}
		jsPrefer := true
		if js.PreferMagnet != nil {
			jsPrefer = *js.PreferMagnet
		}
		if jsPrefer != preferMagnet(goStarter) {
			t.Errorf("starter %s preferMagnet: JS %v, Go %v", js.Name, jsPrefer, preferMagnet(goStarter))
		}
		if len(js.Fields) != len(goStarter.Fields) {
			t.Errorf("starter %s field count: JS %d, Go %d", js.Name, len(js.Fields), len(goStarter.Fields))
		}
		for key, want := range js.Fields {
			got, ok := goStarter.Fields[key]
			if !ok {
				t.Errorf("starter %s missing Go field %q", js.Name, key)
				continue
			}
			if !scalarEqual(got, want) {
				t.Errorf("starter %s field %q: JS %v (%T), Go %v (%T)", js.Name, key, want, want, got, got)
			}
		}
	}
}

// extractArray returns the text of the array literal assigned to const NAME.
func extractArray(source, name string) (string, bool) {
	marker := "const " + name + " = ["
	start := strings.Index(source, marker)
	if start < 0 {
		return "", false
	}
	start += len(marker) - 1 // include the '['
	depth := 0
	for i := start; i < len(source); i++ {
		switch source[i] {
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return source[start : i+1], true
			}
		}
	}
	return "", false
}

// normalizeJSObjectLiterals converts an array of JS object literals into
// strict JSON: unquoted and single-quoted keys become quoted, trailing
// commas are dropped. The literal shape of DEFAULT_PROWLARR_INDEXERS is
// simple enough that this remains a controlled, reviewable transformation.
func normalizeJSObjectLiterals(block string) string {
	var out strings.Builder
	out.Grow(len(block))
	inString := false
	var stringQuote byte
	for i := 0; i < len(block); i++ {
		ch := block[i]
		if inString {
			out.WriteByte(ch)
			if ch == '\\' && i+1 < len(block) {
				i++
				out.WriteByte(block[i])
				continue
			}
			if ch == stringQuote {
				inString = false
			}
			continue
		}
		switch ch {
		case '\'', '"':
			inString = true
			stringQuote = ch
			out.WriteByte('"')
		default:
			out.WriteByte(ch)
		}
	}
	normalized := out.String()
	// Quote unquoted keys, then drop trailing commas before } or ] so the
	// block is strict JSON.
	normalized = quoteObjectKeys(normalized)
	return stripTrailingCommas(normalized)
}

func stripTrailingCommas(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	inString := false
	var stringQuote byte
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if inString {
			out.WriteByte(ch)
			if ch == '\\' && i+1 < len(s) {
				i++
				out.WriteByte(s[i])
				continue
			}
			if ch == stringQuote {
				inString = false
			}
			continue
		}
		if ch == '"' {
			inString = true
			stringQuote = ch
			out.WriteByte(ch)
			continue
		}
		if ch == ',' {
			j := i + 1
			for j < len(s) && (s[j] == ' ' || s[j] == '\n' || s[j] == '\t' || s[j] == '\r') {
				j++
			}
			if j < len(s) && (s[j] == '}' || s[j] == ']') {
				continue // drop the trailing comma
			}
		}
		out.WriteByte(ch)
	}
	return out.String()
}

func quoteObjectKeys(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	for i := 0; i < len(s); i++ {
		out.WriteByte(s[i])
		if s[i] != '{' && s[i] != ',' {
			continue
		}
		// Skip whitespace, then try to read an identifier key.
		j := i + 1
		for j < len(s) && (s[j] == ' ' || s[j] == '\n' || s[j] == '\t' || s[j] == '\r') {
			j++
		}
		k := j
		for k < len(s) && (s[k] == '_' || s[k] == '-' ||
			(s[k] >= 'a' && s[k] <= 'z') || (s[k] >= 'A' && s[k] <= 'Z') ||
			(s[k] >= '0' && s[k] <= '9')) {
			k++
		}
		if k > j && k < len(s) && s[k] == ':' {
			key := s[j:k]
			// Numeric keys ("filter-id": 2 style keys are quoted in JS
			// already when they contain dashes; bare identifiers here).
			if key[0] == '"' {
				continue
			}
			out.WriteString(`"`)
			out.WriteString(key)
			out.WriteString(`"`)
			i = k - 1
		}
	}
	return out.String()
}

func scalarEqual(a, b any) bool {
	// JSON numbers decode as float64; the Go declarative set uses int.
	if af, ok := numeric(a); ok {
		if bf, ok := numeric(b); ok {
			return af == bf
		}
		return false
	}
	ab, aIsBool := a.(bool)
	bb, bIsBool := b.(bool)
	if aIsBool && bIsBool {
		return ab == bb
	}
	return a == b
}

func numeric(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	default:
		return 0, false
	}
}
