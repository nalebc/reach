package main

import (
	"errors"
	"net/url"
	"regexp"
	"strings"
)

var reachHost = regexp.MustCompile(`^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$`)

func reachURL(origin, route string, socket bool) (*url.URL, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.User != nil || !reachHost.MatchString(u.Hostname()) || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("Use this computer's private HTTPS Tailscale origin")
	}
	r, err := url.Parse(route)
	if err != nil || r.IsAbs() || r.Host != "" || r.User != nil || r.Fragment != "" || strings.Contains(r.Path, "..") || strings.Contains(r.Path, "\\") {
		return nil, errors.New("Invalid Reach route")
	}
	if socket {
		if route != "/ws/terminal" {
			return nil, errors.New("Only the terminal WebSocket is enabled in this prototype")
		}
		u.Scheme = "wss"
	} else if !strings.HasPrefix(r.Path, "/api/") {
		return nil, errors.New("Only Reach API requests are enabled")
	}
	u.Path, u.RawPath, u.RawQuery = r.Path, r.RawPath, r.RawQuery
	return u, nil
}
