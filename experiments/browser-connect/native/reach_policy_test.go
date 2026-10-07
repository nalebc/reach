package main

import "testing"

func TestReachURL(t *testing.T) {
	origin := "https://mac.example.ts.net:8446"
	for _, route := range []string{"/api/device", "/api/files/content?root=0&path=hello.txt"} {
		u, err := reachURL(origin, route, false)
		if err != nil || u.String() != origin+route {
			t.Fatalf("valid route: %v %v", u, err)
		}
	}
	if u, err := reachURL(origin, "/ws/terminal", true); err != nil || u.Scheme != "wss" {
		t.Fatal(u, err)
	}
	for _, bad := range []string{"http://mac.example.ts.net", "https://example.com", "https://mac.example.ts.net.evil.test", "https://user:secret@mac.example.ts.net", origin + "/api", origin + "?token=secret", origin + "#secret"} {
		if _, err := reachURL(bad, "/api/device", false); err == nil {
			t.Errorf("accepted origin %q", bad)
		}
	}
	for _, route := range []string{"https://evil.test/api/device", "//evil.test/api/device", "/api/../anything", "/api/%2e%2e/anything", "/api/device#secret", "/ws/terminal", "/api/\\evil"} {
		if _, err := reachURL(origin, route, false); err == nil {
			t.Errorf("accepted route %q", route)
		}
	}
	if _, err := reachURL(origin, "/ws/screen", true); err == nil {
		t.Fatal("unexpected socket enabled")
	}
}
