// Reach experiment adapter. All network traffic uses Tailscale's userspace
// dialer. No browser fetch fallback, TLS bypass, redirects, or token in URLs.
package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/gorilla/websocket"
	_ "golang.org/x/crypto/x509roots/fallback"
)

const reachLimit = 2 * 1024 * 1024

type reachWS struct {
	conn *websocket.Conn
	mu   sync.Mutex
}

var reachSockets = struct {
	sync.Mutex
	next    int
	entries map[int]*reachWS
}{entries: make(map[int]*reachWS)}

func (i *jsIPN) reachRequest(_ js.Value, args []js.Value) any {
	if len(args) != 5 {
		return js.Null()
	}
	origin, route, method, token, body := args[0].String(), args[1].String(), args[2].String(), args[3].String(), args[4].String()
	browserOrigin := js.Global().Get("location").Get("origin").String()
	return makePromise(func() (any, error) {
		u, err := reachURL(origin, route, false)
		if err != nil {
			return nil, err
		}
		if method != "GET" && method != "POST" && method != "DELETE" {
			return nil, errors.New("Unsupported method")
		}
		if len(body) > 65536 || len(token) > 512 {
			return nil, errors.New("Request is too large")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		tr := &http.Transport{DialContext: i.dialer.UserDial, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, DisableKeepAlives: true}
		defer tr.CloseIdleConnections()
		client := &http.Client{Transport: tr, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
		req, err := http.NewRequestWithContext(ctx, method, u.String(), strings.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Origin", browserOrigin)
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			return nil, errors.New("Redirect refused")
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, reachLimit+1))
		if err != nil {
			return nil, err
		}
		if len(data) > reachLimit {
			return nil, errors.New("Prototype file limit is 2 MiB")
		}
		return map[string]any{"status": res.StatusCode, "body": base64.StdEncoding.EncodeToString(data)}, nil
	})
}

func (i *jsIPN) reachSocketOpen(_ js.Value, args []js.Value) any {
	if len(args) != 2 {
		return js.Null()
	}
	origin, callback := args[0].String(), args[1]
	browserOrigin := js.Global().Get("location").Get("origin").String()
	return makePromise(func() (any, error) {
		u, err := reachURL(origin, "/ws/terminal", true)
		if err != nil {
			return nil, err
		}
		reachSockets.Lock()
		if len(reachSockets.entries) >= 4 {
			reachSockets.Unlock()
			return nil, errors.New("Close an existing terminal connection first")
		}
		reachSockets.next++
		id := reachSockets.next
		// Reserve a slot during the handshake as well.
		reachSockets.entries[id] = nil
		reachSockets.Unlock()
		dialer := websocket.Dialer{NetDialContext: i.dialer.UserDial, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, HandshakeTimeout: 15 * time.Second}
		conn, res, err := dialer.Dial(u.String(), http.Header{"Origin": []string{browserOrigin}})
		if res != nil && res.Body != nil {
			res.Body.Close()
		}
		if err != nil {
			reachSockets.Lock()
			delete(reachSockets.entries, id)
			reachSockets.Unlock()
			return nil, err
		}
		conn.SetReadLimit(reachLimit)
		s := &reachWS{conn: conn}
		reachSockets.Lock()
		reachSockets.entries[id] = s
		reachSockets.Unlock()
		go func() {
			defer func() { conn.Close(); reachSockets.Lock(); delete(reachSockets.entries, id); reachSockets.Unlock() }()
			for {
				kind, data, err := conn.ReadMessage()
				if err != nil {
					code := 1006
					var closeErr *websocket.CloseError
					if errors.As(err, &closeErr) {
						code = closeErr.Code
					}
					callback.Invoke(map[string]any{"type": "close", "code": code})
					return
				}
				if kind == websocket.TextMessage {
					callback.Invoke(map[string]any{"type": "message", "data": string(data)})
				}
			}
		}()
		return id, nil
	})
}
func (i *jsIPN) reachSocketSend(_ js.Value, args []js.Value) any {
	if len(args) != 2 {
		return false
	}
	id, data := args[0].Int(), args[1].String()
	if len(data) > 65536 {
		return false
	}
	reachSockets.Lock()
	s := reachSockets.entries[id]
	reachSockets.Unlock()
	if s == nil {
		return false
	}
	return makePromise(func() (any, error) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		err := s.conn.WriteMessage(websocket.TextMessage, []byte(data))
		return err == nil, err
	})
}
func (i *jsIPN) reachSocketClose(_ js.Value, args []js.Value) any {
	if len(args) != 1 {
		return false
	}
	reachSockets.Lock()
	s := reachSockets.entries[args[0].Int()]
	reachSockets.Unlock()
	if s != nil {
		s.conn.Close()
	}
	return true
}
