// Closing a test's HTTP server. server.close() alone waits for every open
// connection, and a browser keeps some that never send a request (Chrome's
// and Safari's speculative sockets): Node counts those as active, so close
// waits until its own header timeout, a minute or more, while the browser
// that holds them is only closed by a later cleanup step. Stop accepting,
// cut every connection, and fail fast with a name if it still won't close.
export async function closeServer(server, { timeoutMs = 5000, label = "test HTTP server" } = {}) {
  if (!server) return;
  const closed = new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => (error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
  });
  server.closeAllConnections?.();
  let timer;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} did not close within ${timeoutMs / 1000} s`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
