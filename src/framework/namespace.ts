// Dry runs publish under homerun/dev so they can never overwrite retained live state. Dry-run
// is a property of the process, so every publisher asks here rather than deciding itself.
export function namespace(dryRun: boolean): string {
  return dryRun ? 'homerun/dev' : 'homerun';
}
