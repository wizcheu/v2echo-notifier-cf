import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const centralDir = process.env.V2ECHO_CENTRAL_PUSH_DIR
  ? path.resolve(process.env.V2ECHO_CENTRAL_PUSH_DIR)
  : "";
const eventsPath = centralDir ? path.join(centralDir, "src", "events.ts") : "";
const apnsPath = centralDir ? path.join(centralDir, "src", "apns.ts") : "";

export const hasCentralPush = Boolean(
  centralDir && existsSync(eventsPath) && existsSync(apnsPath),
);

type Validator = (wire: Record<string, unknown>, nowSeconds: number) => unknown;
type ApnsBuilder = (device: unknown, event: unknown) => string;

let loaded: Promise<{ validateEvent: Validator; apnsPayload: ApnsBuilder }> | null = null;
function load() {
  loaded ??= Promise.all([
    import(/* @vite-ignore */ pathToFileURL(eventsPath).href),
    import(/* @vite-ignore */ pathToFileURL(apnsPath).href),
  ]).then(([eventsMod, apnsMod]) => ({
    validateEvent: eventsMod.validateEvent as Validator,
    apnsPayload: apnsMod.apnsPayload as ApnsBuilder,
  }));
  return loaded;
}

export async function validateCentralEvent(wire: Record<string, unknown>, nowMs: number) {
  if (!hasCentralPush) return null;
  const { validateEvent } = await load();
  return validateEvent(wire, nowMs / 1000);
}

export async function buildCentralApnsPayload(
  device: unknown,
  wire: Record<string, unknown>,
  nowMs: number,
) {
  if (!hasCentralPush) return null;
  const { validateEvent, apnsPayload } = await load();
  return JSON.parse(apnsPayload(device, validateEvent(wire, nowMs / 1000))) as any;
}
