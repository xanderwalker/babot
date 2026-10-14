#!/usr/bin/env node

/**
 * Fetch Max Verstappen's 2026 Singapore qualifying pole lap for BaBot studies.
 *
 * The fixture intentionally contains only raw OpenF1 car/location samples on
 * their irregular source timestamps. It does not resample, interpolate, or
 * derive acceleration/G-force.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = "https://api.openf1.org/v1";
const DOCS_URL = "https://openf1.org/docs/";
const OFFICIAL_RESULTS_URL =
  "https://www.formula1.com/en/results/2026/races/1296/singapore/qualifying";
const SESSION_KEY = 11384;
const DRIVER_NUMBER = 3;
const LAP_NUMBER = 11;
const LAP_START_UTC = "2026-10-10T14:19:02.216Z";
const LAP_DURATION_MS = 91_373;
const LAP_DURATION_SECONDS = LAP_DURATION_MS / 1_000;
const LAP_END_UTC = new Date(
  Date.parse(LAP_START_UTC) + LAP_DURATION_MS,
).toISOString();
const REQUEST_INTERVAL_MS = 425;

const CAR_FIELDS = Object.freeze([
  "tMs",
  "speedKph",
  "rpm",
  "throttlePct",
  "brakeOn",
  "gear",
  "drs",
]);
const LOCATION_FIELDS = Object.freeze(["tMs", "x", "y", "z"]);

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputPath = path.join(
  repositoryRoot,
  "data",
  "openf1-singapore-2026-verstappen-pole.json",
);

let lastRequestAt = 0;

const sourceUrls = {
  docs: DOCS_URL,
  officialQualifyingResults: OFFICIAL_RESULTS_URL,
  officialOnboard: "https://www.formula1.com/en/video/onboard-max-verstappens-2026-pirelli-pole-position-award-lap-at-the-singapore-grand-prix.1878677458343183007",
  meeting: apiUrl("meetings", [["meeting_key", 1296]]),
  session: apiUrl("sessions", [["session_key", SESSION_KEY]]),
  driver: apiUrl("drivers", [
    ["session_key", SESSION_KEY],
    ["driver_number", DRIVER_NUMBER],
  ]),
  lap: apiUrl("laps", [
    ["session_key", SESSION_KEY],
    ["driver_number", DRIVER_NUMBER],
    ["lap_number", LAP_NUMBER],
  ]),
  sessionResult: apiUrl("session_result", [
    ["session_key", SESSION_KEY],
    ["driver_number", DRIVER_NUMBER],
  ]),
  carData: apiUrl("car_data", [
    ["session_key", SESSION_KEY],
    ["driver_number", DRIVER_NUMBER],
    // In a query string the delimiter supplies the equals in OpenF1's >= syntax.
    ["date>", LAP_START_UTC],
    ["date<", LAP_END_UTC],
  ]),
  location: apiUrl("location", [
    ["session_key", SESSION_KEY],
    ["driver_number", DRIVER_NUMBER],
    ["date>", LAP_START_UTC],
    ["date<", LAP_END_UTC],
  ]),
};

const [meeting] = await fetchJson(sourceUrls.meeting);
const [session] = await fetchJson(sourceUrls.session);
const [driver] = await fetchJson(sourceUrls.driver);
const [lap] = await fetchJson(sourceUrls.lap);
const [sessionResult] = await fetchJson(sourceUrls.sessionResult);
const rawCarSamples = await fetchJson(sourceUrls.carData);
const rawLocationSamples = await fetchJson(sourceUrls.location);

assert(Number(meeting?.meeting_key) === 1296, "meeting metadata mismatch");
assert(meeting?.meeting_name === "Singapore Grand Prix", "expected the Singapore Grand Prix");
assert(Number(session?.session_key) === SESSION_KEY, "session metadata mismatch");
assert(session?.session_name === "Qualifying", "expected a Qualifying session");
assert(session?.country_name === "Singapore", "expected the Singapore session");
assert(Number(driver?.driver_number) === DRIVER_NUMBER, "driver metadata mismatch");
assert(driver?.name_acronym === "VER", "expected Max Verstappen");
assert(Number(lap?.lap_number) === LAP_NUMBER, "lap metadata mismatch");
assert(Number(sessionResult?.position) === 1, "expected Max Verstappen to be classified on pole");
assert(Array.isArray(sessionResult?.duration), "expected qualifying duration splits");
assert(
  Math.abs(Number(sessionResult.duration.at(-1)) - LAP_DURATION_SECONDS) < 1e-9,
  "pole result duration does not match the selected lap",
);
assert(
  Date.parse(lap?.date_start) === Date.parse(LAP_START_UTC),
  `expected lap start ${LAP_START_UTC}, received ${lap?.date_start}`,
);
assert(
  Math.abs(Number(lap?.lap_duration) - LAP_DURATION_SECONDS) < 1e-9,
  `expected ${LAP_DURATION_SECONDS}s lap, received ${lap?.lap_duration}`,
);

const carSourceRows = rowsInsideLap(rawCarSamples, "car_data");
const locationSourceRows = rowsInsideLap(rawLocationSamples, "location");

const carSamples = carSourceRows.map((sample) => [
  relativeMilliseconds(sample.date),
  finiteNumber(sample.speed, "speed"),
  finiteNumber(sample.rpm, "rpm"),
  finiteNumber(sample.throttle, "throttle"),
  Number(sample.brake) > 0 ? 1 : 0,
  finiteNumber(sample.n_gear, "n_gear"),
  nullableFiniteNumber(sample.drs, "drs"),
]);

const locationSamples = locationSourceRows.map((sample) => [
  relativeMilliseconds(sample.date),
  finiteNumber(sample.x, "x"),
  finiteNumber(sample.y, "y"),
  finiteNumber(sample.z, "z"),
]);

validateSamples(carSamples, CAR_FIELDS.length, "car");
validateSamples(locationSamples, LOCATION_FIELDS.length, "location");
assert(carSamples.length >= 200, `expected at least 200 car samples, received ${carSamples.length}`);
assert(
  locationSamples.length >= 200,
  `expected at least 200 location samples, received ${locationSamples.length}`,
);

const generatedAtUtc = nowIso();
const fixture = {
  meta: {
    datasetId: "openf1-singapore-2026-verstappen-pole",
    season: 2026,
    meetingKey: Number(session.meeting_key),
    meetingName: meeting.meeting_name,
    meetingOfficialName: meeting.meeting_official_name,
    location: meeting.location,
    country: session.country_name,
    circuit: session.circuit_short_name,
    sessionKey: SESSION_KEY,
    sessionName: session.session_name,
    driverNumber: DRIVER_NUMBER,
    driverName: driver.full_name,
    driverAcronym: driver.name_acronym,
    team: driver.team_name,
    teamColour: driver.team_colour,
    lapNumber: LAP_NUMBER,
    sectorDurationSeconds: [lap.duration_sector_1, lap.duration_sector_2, lap.duration_sector_3],
    qualifyingPosition: Number(sessionResult.position),
    poleVerified: true,
    lapStartUtc: LAP_START_UTC,
    lapEndUtc: LAP_END_UTC,
    lapDurationMs: LAP_DURATION_MS,
    lapDurationSeconds: LAP_DURATION_SECONDS,
    carSampleCount: carSamples.length,
    locationSampleCount: locationSamples.length,
    carFirstTMs: carSamples[0][0],
    carLastTMs: carSamples.at(-1)[0],
    locationFirstTMs: locationSamples[0][0],
    locationLastTMs: locationSamples.at(-1)[0],
  },
  provenance: {
    source: "OpenF1 API",
    generatedAtUtc,
    sourceUrls,
    window: {
      startUtc: LAP_START_UTC,
      endUtc: LAP_END_UTC,
      startInclusive: true,
      endInclusive: true,
    },
    timestampBasis: "Raw OpenF1 sample date minus lapStartUtc, expressed as integer milliseconds",
    sourceCadence: "irregular",
    resampled: false,
    interpolated: false,
    syntheticEndpoints: false,
    derivedG: false,
  },
  fields: {
    carSamples: CAR_FIELDS,
    locationSamples: LOCATION_FIELDS,
  },
  carSamples,
  locationSamples,
};

await writeJsonAtomic(outputPath, fixture);
console.log(
  `[done] ${outputPath}\n` +
    `[done] car ${carSamples.length} (${carSamples[0][0]}..${carSamples.at(-1)[0]} ms)\n` +
    `[done] location ${locationSamples.length} (${locationSamples[0][0]}..${locationSamples.at(-1)[0]} ms)\n` +
    `[done] exact lap window 0..${LAP_DURATION_MS} ms; no derived G`,
);

function rowsInsideLap(rows, label) {
  assert(Array.isArray(rows), `${label} response is not an array`);
  const startMs = Date.parse(LAP_START_UTC);
  const endMs = Date.parse(LAP_END_UTC);
  const filtered = rows
    .filter((sample) => {
      const timestamp = Date.parse(sample?.date);
      return Number.isFinite(timestamp) && timestamp >= startMs && timestamp <= endMs;
    })
    .sort((left, right) => Date.parse(left.date) - Date.parse(right.date));
  assert(filtered.length > 0, `${label} has no samples inside the lap window`);
  return filtered;
}

function relativeMilliseconds(date) {
  const value = Date.parse(date) - Date.parse(LAP_START_UTC);
  assert(
    Number.isInteger(value) && value >= 0 && value <= LAP_DURATION_MS,
    `sample timestamp ${date} is outside the exact lap window`,
  );
  return value;
}

function validateSamples(samples, tupleLength, label) {
  assert(samples.length > 0, `${label} samples are empty`);
  assert(
    samples.every(
      (sample) =>
        sample.length === tupleLength &&
        Number.isInteger(sample[0]) &&
        sample[0] >= 0 &&
        sample[0] <= LAP_DURATION_MS,
    ),
    `${label} contains malformed or out-of-window tuples`,
  );
  assert(
    samples.every((sample, index) => index === 0 || sample[0] >= samples[index - 1][0]),
    `${label} timestamps are not monotonic`,
  );
}

function apiUrl(endpoint, parameters) {
  const url = new URL(`${API_ROOT}/${endpoint}`);
  for (const [key, value] of parameters) {
    url.searchParams.append(key, String(value));
  }
  return url.toString();
}

async function fetchJson(url) {
  const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await delay(wait);
  lastRequestAt = Date.now();
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "lapform-singapore-babot-generator/1.0",
    },
  });
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} for ${url}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response.json();
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function finiteNumber(value, label) {
  const number = Number(value);
  assert(Number.isFinite(number), `${label} is missing from a source sample`);
  return number;
}

function nullableFiniteNumber(value, label) {
  if (value === null || value === undefined) return null;
  return finiteNumber(value, label);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
