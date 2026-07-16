/** Identity token compiled only for the separate fixture runtime tree/package-excluded bridge. */
export const FIXTURE_RUNTIME_AUTHORITY = Object.freeze(Object.create(null)) as object;

export function assertFixtureRuntimeAuthority(authority: object): void {
  if (authority !== FIXTURE_RUNTIME_AUTHORITY) {
    throw new Error("fixture runtime authority is unavailable outside the package-excluded test bridge");
  }
}
