'use strict';
async function stopOwnedResources(resources) {
  const entries = Object.entries(resources);
  const outcomes = await Promise.allSettled(entries.map(([, stop]) => Promise.resolve().then(stop)));
  const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [{ name: entries[index][0], error: outcome.reason }] : []);
  if (failures.length) throw new AggregateError(failures.map(failure => failure.error), `Could not stop: ${failures.map(failure => failure.name).join(', ')}.`);
}
module.exports = { stopOwnedResources };
