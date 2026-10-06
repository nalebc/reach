// This is a non-overridable deny, in addition to the native helper's signed
// process checks. A stored grant or a mistaken catalog flag cannot make the
// apps that administer this connection available to an invited agent.
export function protectedBrowserAppReason(app) {
  const identity = [app?.bundleId, app?.name, app?.id]
    .filter((value) => typeof value === 'string')
    .map((value) => value.normalize('NFKC').toLowerCase())
    .join('\n');
  if (['reach', 'tailscale'].some((name) => identity.includes(name)))
    return 'Reach and Tailscale are always protected. Agents cannot view, control, or request access to them.';
  return null;
}

export function protectBrowserApp(app) {
  const reason = protectedBrowserAppReason(app);
  return reason ? { ...app, protected: true, reason } : { ...app };
}
