// App choices are always explicit and belong to one invitation. No wildcard,
// inherited defaults, or agent-supplied process IDs enter the permission list.
export function validAppAccess(value) {
  return Array.isArray(value) && value.length <= 30 &&
    new Set(value.map((entry) => entry?.id)).size === value.length &&
    value.every((entry) => entry && Object.getPrototypeOf(entry) === Object.prototype &&
      Object.keys(entry).every((key) => ['id', 'mode', 'identity'].includes(key)) &&
      typeof entry.id === 'string' && entry.id.startsWith('/') && entry.id.endsWith('.app') &&
      entry.id.length <= 1024 && !/[\x00-\x1f\x7f]/.test(entry.id) &&
      !entry.id.split('/').some((part) => part === '..' || part === '.') &&
      ['view', 'control'].includes(entry.mode) &&
      (entry.identity === undefined || (typeof entry.identity === 'string' && /^[a-f0-9]{64}$/.test(entry.identity))));
}
