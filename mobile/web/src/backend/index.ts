/**
 * On-device backend entry point. Importing the route modules registers every
 * /api/* handler; initBackend() wires the platform and migrates the DB.
 */
import { Platform, setPlatform } from "./platform";
import { migrate } from "./schema";
import "./routes/system";
import "./routes/market";
import "./routes/engine";
import "./routes/settings";
import "./routes/backtest";
import "./routes/deepdive";
import "./routes/insights";
import "./routes/trades";
import "./routes/options";

export { localAdapter, dispatch } from "./server";
export { runScheduledJob } from "./jobs";
export type { JobType, JobOutcome } from "./jobs";

export function initBackend(p: Platform): void {
  setPlatform(p);
  migrate();
}
