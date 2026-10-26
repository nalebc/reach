// Layout tests drive only the enrollment state, never real credentials.
export function watchOwnerEnrollment(_peer, report) {
  const fixture = globalThis.__ownerSetup;
  fixture.starts++;
  fixture.report = report;
  report(fixture.state);
  return () => { fixture.stops++; fixture.report = null; };
}
