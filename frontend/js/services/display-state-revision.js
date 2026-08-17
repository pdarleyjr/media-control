export function mergeDisplayRecord(current, incoming) {
  if (!current) return { ...(incoming || {}) };
  if (!incoming) return { ...current };
  const currentRevision = Number(current.state_revision) || 0;
  const incomingRevision = Number(incoming.state_revision) || 0;
  if (Object.prototype.hasOwnProperty.call(incoming, 'state_revision')
      && incomingRevision < currentRevision) return { ...current };
  return { ...current, ...incoming };
}

export function mergeDisplayList(current, incoming) {
  const currentMap = current instanceof Map ? current : new Map();
  return new Map((Array.isArray(incoming) ? incoming : []).map((display) => [
    display.id,
    mergeDisplayRecord(currentMap.get(display.id), display),
  ]));
}
