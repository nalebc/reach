// Layout tests drive only the enrollment state, never real credentials.
export function watchOwnerEnrollment(_peer, report, options) {
  const fixture = globalThis.__ownerSetup;
  fixture.starts++;
  fixture.options = options;
  fixture.report = report;
  if (fixture.deferInitial) fixture.initialReport = () => report(fixture.state);
  else report(fixture.state);
  return () => { fixture.stops++; fixture.report = null; };
}
