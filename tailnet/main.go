//go:build js

// Reach's browser tailnet client: a Tailscale node that lives inside the page,
// so a phone without the Tailscale app can sign in to Tailscale and reach its
// computer privately. Requests and WebSockets to tailnet addresses travel
// through it; the computer sees an ordinary tailnet device and identifies it
// with `tailscale whois`, exactly like the app.
//
// Adapted from tailscale.com/cmd/tsconnect (BSD-3-Clause).
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/gorilla/websocket"
	"tailscale.com/control/controlclient"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnauth"
	"tailscale.com/ipn/ipnlocal"
	"tailscale.com/net/netns"
	"tailscale.com/net/tlsdial"
	"tailscale.com/net/tsdial"
	"tailscale.com/tsd"
	"tailscale.com/types/logid"
	"tailscale.com/wgengine"
	"tailscale.com/wgengine/magicsock"
	"tailscale.com/wgengine/netstack"
)

func main() {
	js.Global().Set("reachTailnet", fn(func(args []js.Value) any {
		return newNode(args[0])
	}))
	select {}
}

// fn wraps a JS callback: a panic inside must never end the Go runtime,
// which would drop every connection at once.
func fn(f func(args []js.Value) any) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) (result any) {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("reach-tailnet: recovered: %v", r)
				result = nil
			}
		}()
		return f(args)
	})
}

func goSafe(f func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Printf("reach-tailnet: recovered: %v", r)
			}
		}()
		f()
	}()
}

// Keep Tailscale's own logs out of the console except for problems.
func logf(format string, args ...any) {
	if strings.Contains(format, "rror") || strings.Contains(format, "fail") {
		log.Printf(format, args...)
	}
}

type node struct {
	lb       *ipnlocal.LocalBackend
	dialer   *tsdial.Dialer
	sock     *magicsock.Conn
	hostname string
	// An invitation's one-time key: joins the tailnet without signing in.
	authKey string
	client  *http.Client
}

func newNode(cfg js.Value) map[string]any {
	netns.SetEnabled(false)
	sys := tsd.NewSystem()
	sys.Set(&jsStore{cfg.Get("stateStorage")})
	dialer := &tsdial.Dialer{Logf: logf}
	dialer.SetBus(sys.Bus.Get())
	eng, err := wgengine.NewUserspaceEngine(logf, wgengine.Config{
		Dialer:        dialer,
		SetSubsystem:  sys.Set,
		ControlKnobs:  sys.ControlKnobs(),
		HealthTracker: sys.HealthTracker.Get(),
		ExtraRootCAs:  sys.ExtraRootCAs,
		Metrics:       sys.UserMetricsRegistry(),
		EventBus:      sys.Bus.Get(),
	})
	if err != nil {
		panic(err)
	}
	sys.Set(eng)
	ns, err := netstack.Create(logf, sys.Tun.Get(), eng, sys.MagicSock.Get(), dialer, sys.DNSManager.Get(), sys.ProxyMapper())
	if err != nil {
		panic(err)
	}
	sys.Set(ns)
	ns.ProcessLocalIPs = true
	ns.ProcessSubnets = true
	dialer.UseNetstackForIP = func(netip.Addr) bool { return true }
	dialer.NetstackDialTCP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		c, err := ns.DialContextTCP(ctx, dst)
		if err != nil {
			return nil, err // never a typed nil
		}
		return c, nil
	}
	dialer.NetstackDialUDP = func(ctx context.Context, dst netip.AddrPort) (net.Conn, error) {
		c, err := ns.DialContextUDP(ctx, dst)
		if err != nil {
			return nil, err
		}
		return c, nil
	}
	sys.NetstackRouter.Set(true)
	sys.Tun.Get().Start()
	// A lasting device (not ephemeral): Reach approves a device once and binds
	// its access to this node, so it must survive the page being closed.
	// No log upload: logid is empty and nothing is sent to log.tailscale.com.
	lb, err := ipnlocal.NewLocalBackend(logf, logid.PublicID{}, sys, controlclient.LoginDefault)
	if err != nil {
		panic(err)
	}
	if err := ns.Start(lb); err != nil {
		panic(err)
	}
	n := &node{lb: lb, dialer: dialer, sock: sys.MagicSock.Get(), hostname: "reach-browser"}
	if h := cfg.Get("hostname"); h.Type() == js.TypeString && h.String() != "" {
		n.hostname = h.String()
	}
	if k := cfg.Get("authKey"); k.Type() == js.TypeString && strings.HasPrefix(k.String(), "tskey-auth-") {
		n.authKey = k.String()
	}
	n.client = &http.Client{
		Transport: &http.Transport{
			DialContext:         dialer.UserDial,
			TLSClientConfig:     tlsdial.Config(nil, nil),
			MaxIdleConnsPerHost: 6,
			IdleConnTimeout:     60 * time.Second,
			TLSHandshakeTimeout: 15 * time.Second,
		},
	}
	return map[string]any{
		"start": fn(func(a []js.Value) any { n.start(a[0]); return nil }),
		"login": fn(func([]js.Value) any { goSafe(func() { lb.StartLoginInteractive(context.Background()) }); return nil }),
		"logout": fn(func([]js.Value) any {
			goSafe(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				lb.Logout(ctx, ipnauth.Self)
			})
			return nil
		}),
		"status":    fn(func([]js.Value) any { return n.status() }),
		"wake":      fn(func([]js.Value) any { n.wake(); return nil }),
		"fetch":     fn(func(a []js.Value) any { return n.fetch(a[0]) }),
		"websocket": fn(func(a []js.Value) any { return n.websocket(a[0], a[1]) }),
	}
}

func (n *node) start(cb js.Value) {
	// Start can return before the first NeedsLogin notification. Trigger the
	// key login from either path, exactly once, after Start has initialized it.
	started := make(chan struct{})
	var loginOnce sync.Once
	report := func(kind string) {
		if cb.Get("error").Type() == js.TypeFunction {
			cb.Call("error", kind)
		}
	}
	loginWithKey := func() {
		if n.authKey == "" {
			return
		}
		loginOnce.Do(func() {
			goSafe(func() {
				<-started
				if n.lb.State() == ipn.NeedsLogin {
					if err := n.lb.StartLoginInteractive(context.Background()); err != nil {
						report("startup")
					}
				}
			})
		})
	}
	n.lb.SetNotifyCallback(func(no ipn.Notify) {
		defer func() { recover() }()
		if no.State != nil {
			cb.Call("state", no.State.String())
			if *no.State == ipn.NeedsLogin {
				loginWithKey()
			}
		}
		if no.ErrMessage != nil {
			// Only an explicit key error can label the network key rejected.
			// Never pass control-plane error text (which may contain secrets).
			message := strings.ToLower(*no.ErrMessage)
			kind := "network"
			if strings.Contains(message, "authkey") || strings.Contains(message, "auth key") {
				if strings.Contains(message, "invalid") || strings.Contains(message, "expired") || strings.Contains(message, "revoked") || strings.Contains(message, "not found") {
					kind = "key"
				}
			}
			report(kind)
		}
		if no.BrowseToURL != nil {
			cb.Call("authURL", *no.BrowseToURL)
		}
	})
	goSafe(func() {
		err := n.lb.Start(ipn.Options{
			UpdatePrefs: &ipn.Prefs{
				ControlURL:  ipn.DefaultControlURL,
				WantRunning: true,
				Hostname:    n.hostname,
			},
			AuthKey: n.authKey,
		})
		close(started)
		if err != nil {
			log.Printf("reach-tailnet: start: %v", err)
			report("startup")
			return
		}
		// Start alone waits for someone to sign in. A new node with a one-time
		// key signs in with it now, as tsnet does; one already registered
		// rejoins by itself and never reuses the (spent) key.
		if n.authKey != "" && n.lb.State() == ipn.NeedsLogin {
			loginWithKey()
		}
	})
}

// Who this browser is signed in as, and which computers it can see.
func (n *node) status() any {
	st := n.lb.Status()
	peers := []any{}
	for _, p := range st.Peer {
		peers = append(peers, map[string]any{
			"dnsName": strings.TrimSuffix(p.DNSName, "."),
			"online":  p.Online,
		})
	}
	self := map[string]any{"state": st.BackendState}
	if st.Self != nil {
		self["dnsName"] = strings.TrimSuffix(st.Self.DNSName, ".")
		if u, ok := st.User[st.Self.UserID]; ok {
			self["login"] = u.LoginName
		}
	}
	return map[string]any{"self": self, "peers": peers}
}

// After the page was frozen (a phone switching apps), the relay connection
// is usually dead: reconnect now instead of waiting for keepalives to notice.
func (n *node) wake() {
	goSafe(func() {
		n.sock.SetNetworkUp(false)
		n.sock.SetNetworkUp(true)
	})
}

func strings2(v js.Value) []string {
	out := make([]string, v.Length())
	for i := range out {
		out[i] = v.Index(i).String()
	}
	return out
}

func toJS(b []byte) js.Value {
	a := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(a, b)
	return a
}

func fromJS(v js.Value) []byte {
	b := make([]byte, v.Get("byteLength").Int())
	js.CopyBytesToGo(b, v)
	return b
}

func promise(f func() (any, error)) js.Value {
	// The executor runs synchronously inside the Promise constructor, so it
	// can be released right after.
	executor := fn(func(a []js.Value) any {
		resolve, reject := a[0], a[1]
		goSafe(func() {
			if v, err := f(); err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
			} else {
				resolve.Invoke(v)
			}
		})
		return nil
	})
	defer executor.Release()
	return js.Global().Get("Promise").New(executor)
}

var errRedirect = errors.New("redirect refused")

// fetch({url, method, headers: [k, v, ...], body?: Uint8Array, redirect})
// -> {response: Promise<head>, abort()}; head.read() streams the body.
func (n *node) fetch(req js.Value) any {
	ctx, cancel := context.WithCancel(context.Background())
	url, method := req.Get("url").String(), req.Get("method").String()
	headers := strings2(req.Get("headers"))
	var body []byte
	if b := req.Get("body"); b.Truthy() {
		body = fromJS(b)
	}
	follow := req.Get("redirect").String() == "follow"
	response := promise(func() (any, error) {
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		}
		r, err := http.NewRequestWithContext(ctx, method, url, reader)
		if err != nil {
			return nil, err
		}
		for i := 0; i+1 < len(headers); i += 2 {
			r.Header.Add(headers[i], headers[i+1])
		}
		client := *n.client
		client.CheckRedirect = func(*http.Request, []*http.Request) error {
			if follow {
				return nil
			}
			return errRedirect
		}
		res, err := client.Do(r)
		if err != nil {
			return nil, err
		}
		pairs := []any{}
		for k, vs := range res.Header {
			for _, v := range vs {
				pairs = append(pairs, strings.ToLower(k), v)
			}
		}
		var once sync.Once
		done := func() { once.Do(func() { res.Body.Close(); cancel() }) }
		return map[string]any{
			"status":     res.StatusCode,
			"statusText": strings.TrimSpace(strings.TrimPrefix(res.Status, fmt.Sprint(res.StatusCode))),
			"headers":    pairs,
			"read": fn(func([]js.Value) any {
				return promise(func() (any, error) {
					buf := make([]byte, 256<<10)
					k, err := io.ReadAtLeast(res.Body, buf, 1)
					if k > 0 {
						return toJS(buf[:k]), nil
					}
					done()
					if err == io.EOF || err == io.ErrUnexpectedEOF {
						return nil, nil
					}
					return nil, err
				})
			}),
			"cancel": fn(func([]js.Value) any { goSafe(done); return nil }),
		}, nil
	})
	return map[string]any{
		"response": response,
		"abort":    fn(func([]js.Value) any { cancel(); return nil }),
	}
}

type frame struct {
	kind int
	data []byte
}

// websocket(url, {protocols, open(protocol), message(data), close(code,
// reason, clean)}) -> {send(data), close(code, reason), buffered()}.
// send never blocks the page: frames queue and a writer drains them.
func (n *node) websocket(urlValue, cb js.Value) any {
	url := urlValue.String()
	var protocols []string
	if p := cb.Get("protocols"); p.Truthy() {
		protocols = strings2(p)
	}
	var (
		mu       sync.Mutex
		queue    []frame
		buffered int
		closing  *frame
		wake     = make(chan struct{}, 1)
		quit     = make(chan struct{})
		quitOnce sync.Once
	)
	signal := func() {
		select {
		case wake <- struct{}{}:
		default:
		}
	}
	finished := false
	var finishOnce sync.Once
	finish := func(code int, reason string, clean bool) {
		finishOnce.Do(func() {
			mu.Lock()
			finished = true
			mu.Unlock()
			quitOnce.Do(func() { close(quit) })
			cb.Call("close", code, reason, clean)
		})
	}
	goSafe(func() {
		d := websocket.Dialer{
			NetDialContext:   n.dialer.UserDial,
			TLSClientConfig:  tlsdial.Config(nil, nil),
			HandshakeTimeout: 20 * time.Second,
			Subprotocols:     protocols,
			ReadBufferSize:   256 << 10,
			WriteBufferSize:  64 << 10,
		}
		c, _, err := d.Dial(url, nil)
		if err != nil {
			finish(1006, "", false)
			return
		}
		mu.Lock()
		gone := finished
		mu.Unlock()
		if gone {
			c.Close()
			return
		}
		cb.Call("open", c.Subprotocol())
		goSafe(func() {
			defer c.Close()
			for {
				mu.Lock()
				if len(queue) == 0 && closing == nil {
					mu.Unlock()
					select {
					case <-wake:
						continue
					case <-quit:
						return
					}
				}
				if len(queue) == 0 {
					f := *closing
					mu.Unlock()
					c.WriteControl(websocket.CloseMessage, f.data, time.Now().Add(2*time.Second))
					// The server's reply ends the read loop; don't wait forever.
					select {
					case <-quit:
					case <-time.After(3 * time.Second):
						finish(websocket.CloseNormalClosure, "", true)
					}
					return
				}
				f := queue[0]
				queue = queue[1:]
				mu.Unlock()
				err := c.WriteMessage(f.kind, f.data)
				mu.Lock()
				buffered -= len(f.data)
				mu.Unlock()
				if err != nil {
					finish(1006, "", false)
					return
				}
			}
		})
		for {
			kind, data, err := c.ReadMessage()
			if err != nil {
				var ce *websocket.CloseError
				if errors.As(err, &ce) {
					code := ce.Code
					if code == websocket.CloseNoStatusReceived {
						code = 1005
					}
					finish(code, ce.Text, true)
				} else {
					finish(1006, "", false)
				}
				return
			}
			if kind == websocket.TextMessage {
				cb.Call("message", string(data))
			} else {
				cb.Call("message", toJS(data))
			}
		}
	})
	return map[string]any{
		"send": fn(func(a []js.Value) any {
			v := a[0]
			f := frame{kind: websocket.BinaryMessage}
			if v.Type() == js.TypeString {
				f = frame{websocket.TextMessage, []byte(v.String())}
			} else {
				f.data = fromJS(v)
			}
			mu.Lock()
			if closing == nil && !finished {
				queue = append(queue, f)
				buffered += len(f.data)
			}
			mu.Unlock()
			signal()
			return nil
		}),
		"close": fn(func(a []js.Value) any {
			code, reason := websocket.CloseNormalClosure, ""
			if len(a) > 0 && a[0].Type() == js.TypeNumber {
				code = a[0].Int()
			}
			if len(a) > 1 && a[1].Type() == js.TypeString {
				reason = a[1].String()
			}
			mu.Lock()
			if closing == nil {
				closing = &frame{websocket.CloseMessage, websocket.FormatCloseMessage(code, reason)}
			}
			mu.Unlock()
			signal()
			return nil
		}),
		"buffered": fn(func([]js.Value) any {
			mu.Lock()
			defer mu.Unlock()
			return buffered
		}),
	}
}

// Tailscale's node key and login live in the page's storage, hex encoded.
type jsStore struct{ s js.Value }

func (s *jsStore) ReadState(id ipn.StateKey) ([]byte, error) {
	if !s.s.Truthy() {
		return nil, ipn.ErrStateNotExist
	}
	v := s.s.Call("getState", string(id))
	if v.Type() != js.TypeString || v.String() == "" {
		return nil, ipn.ErrStateNotExist
	}
	return hex.DecodeString(v.String())
}

func (s *jsStore) WriteState(id ipn.StateKey, bs []byte) error {
	if s.s.Truthy() {
		s.s.Call("setState", string(id), hex.EncodeToString(bs))
	}
	return nil
}
